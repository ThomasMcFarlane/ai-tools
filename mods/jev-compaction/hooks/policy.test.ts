import { describe, expect, test } from 'claude-code/testing'

import { keyFromFile, parseEnvFile, redact } from './key'
import { DEFAULT_RATIO, DEFAULTS, calibrate, estimateAfter, rawFreed, failure, guardAfter, judge, resolveConfig, shouldTrigger, thresholdsFor } from './policy'
import type { Judgement } from './policy'

describe('thresholds', () => {
  test('a 1M window uses the absolute token defaults', () => {
    expect(thresholdsFor(DEFAULTS, 1_000_000)).toEqual({ trigger: 400_000, target: 256_000, hard: 500_000, softMinFreed: 30_000 })
  })
  test('a small window uses percentages', () => {
    expect(thresholdsFor(DEFAULTS, 200_000)).toEqual({ trigger: 120_000, target: 80_000, hard: 170_000, softMinFreed: 50_000 })
    expect(thresholdsFor(DEFAULTS, 300_000).trigger).toBe(180_000)
    expect(thresholdsFor(DEFAULTS, 300_001).trigger).toBe(400_000)
  })
  test('userConfig numbers override the defaults, junk is ignored', () => {
    const config = resolveConfig({ triggerTokens: 350_000, minFreedTokens: 'x', model: 'jev-x', keyFile: '' })
    expect(config.triggerTokens).toBe(350_000)
    expect(config.minFreedTokens).toBe(20_000)
    expect(config.model).toBe('jev-x')
    expect(config.keyFile).toBe('')
  })
})

describe('periodic trigger and regrowth guard', () => {
  const t = thresholdsFor(DEFAULTS, 1_000_000)
  test('fires at the trigger, not below', () => {
    expect(shouldTrigger(399_999, t, 0, 25_000)).toBe(false)
    expect(shouldTrigger(400_000, t, 0, 25_000)).toBe(true)
  })
  test('at or above the hard limit the guard never blocks an attempt', () => {
    expect(shouldTrigger(499_999, t, 480_000, 50_000)).toBe(false)
    expect(shouldTrigger(500_000, t, 480_000, 50_000)).toBe(true)
    expect(shouldTrigger(372_000, thresholdsFor({ ...DEFAULTS, triggerTokens: 200_000, hardTokens: 300_000 }, 1_000_000), 372_000, 50_000)).toBe(true)
  })
  test('after an attempt it waits for 50000 tokens of regrowth', () => {
    expect(shouldTrigger(420_000, t, 410_000, 50_000)).toBe(false)
    expect(shouldTrigger(459_999, t, 410_000, 50_000)).toBe(false)
    expect(shouldTrigger(460_000, t, 410_000, 50_000)).toBe(true)
  })
  test('apply, then back at 400k with low gains: one apply, then a wait for regrowth', () => {
    let guard = 0
    let applies = 0
    const attempts: number[] = []
    // [tokens at the turn end, tokens freed by Jev at that point]
    for (const [tokens, freed] of [[400_000, 150_000], [400_000, 10_000], [420_000, 10_000], [449_000, 10_000], [450_000, 10_000]] as const) {
      if (!shouldTrigger(tokens, t, guard, 50_000)) continue
      attempts.push(tokens)
      const verdict = judge({ trigger: 'plugin', isNow: false, tokensBefore: tokens, tokensAfter: tokens - freed, thresholds: t, minFreedTokens: 20_000 })
      if (verdict.act === 'apply') applies++
      guard = guardAfter(tokens, verdict.act === 'apply' ? tokens - freed : undefined)
    }
    expect(applies).toBe(1)
    expect(attempts).toEqual([400_000, 400_000, 450_000])
  })
})

describe('policy levels', () => {
  const base: Judgement = {
    trigger: 'plugin',
    isNow: false,
    tokensBefore: 420_000,
    tokensAfter: 300_000,
    thresholds: thresholdsFor(DEFAULTS, 1_000_000),
    minFreedTokens: 20_000,
  }
  test('soft: applied when it reaches the target', () => {
    expect(judge({ ...base, tokensAfter: 256_000, tokensBefore: 270_000 })).toEqual({ act: 'apply' })
  })
  test('soft: applied when it frees the soft minimum even above the target', () => {
    expect(judge({ ...base, tokensAfter: 320_000 })).toEqual({ act: 'apply' })
  })
  test('soft: deferred when it frees too little', () => {
    expect(judge({ ...base, tokensAfter: 410_000 }).act).toBe('skip')
  })
  test('soft: at the hard limit a small gain falls back to the built-in summary', () => {
    expect(judge({ ...base, tokensBefore: 520_000, tokensAfter: 510_000 }).act).toBe('next')
  })
  test('auto: applied below the hard limit, built-in summary otherwise', () => {
    expect(judge({ ...base, trigger: 'auto', tokensBefore: 520_000, tokensAfter: 499_999 }).act).toBe('apply')
    expect(judge({ ...base, trigger: 'auto', tokensBefore: 620_000, tokensAfter: 500_000 }).act).toBe('next')
  })
  test('auto: a compaction that frees nothing is not applied even under the hard limit', () => {
    const small = thresholdsFor(DEFAULTS, 200_000)
    expect(judge({ ...base, trigger: 'auto', thresholds: small, tokensBefore: 167_000, tokensAfter: 167_000 }).act).toBe('next')
  })
  test('soft: freeing less than the soft minimum above the target is deferred, enough is applied', () => {
    expect(judge({ ...base, tokensBefore: 420_000, tokensAfter: 390_001 }).act).toBe('skip')
    expect(judge({ ...base, tokensBefore: 420_000, tokensAfter: 390_000 }).act).toBe('apply')
  })
  test('manual: applied when it frees the minimum, else built-in summary', () => {
    expect(judge({ ...base, trigger: 'manual', tokensAfter: 399_999 }).act).toBe('apply')
    expect(judge({ ...base, trigger: 'manual', tokensAfter: 410_000 }).act).toBe('next')
  })
  test('now: manual-like, deferred below the hard limit, built-in summary above it', () => {
    expect(judge({ ...base, isNow: true, tokensAfter: 410_000 }).act).toBe('skip')
    expect(judge({ ...base, isNow: true, tokensBefore: 620_000, tokensAfter: 610_000 }).act).toBe('next')
    expect(judge({ ...base, isNow: true, tokensBefore: 620_000, tokensAfter: 450_000 }).act).toBe('apply')
    expect(judge({ ...base, isNow: true }).act).toBe('apply')
  })
  test('hard ceiling: a periodic result that ends at or above the hard limit falls back, below it is applied', () => {
    const live = { ...base, tokensBefore: 466_000, thresholds: thresholdsFor({ ...DEFAULTS, triggerTokens: 200_000, targetTokens: 120_000, hardTokens: 300_000, softMinFreedTokens: 50_000 }, 1_000_000) }
    // the live case: ~466k to ~372k frees 94k, more than the soft minimum, yet stays above the limit
    expect(judge({ ...live, tokensAfter: 372_000 }).act).toBe('next')
    expect(judge({ ...live, tokensAfter: 300_000 }).act).toBe('next')
    expect(judge({ ...live, tokensAfter: 299_999 })).toEqual({ act: 'apply' })
    expect(judge({ ...live, tokensAfter: 120_000 })).toEqual({ act: 'apply' })
  })
  test('hard ceiling: below the hard limit a small gain is still deferred', () => {
    expect(judge({ ...base, tokensBefore: 299_000, tokensAfter: 290_000, thresholds: thresholdsFor({ ...DEFAULTS, hardTokens: 300_000 }, 1_000_000) }).act).toBe('skip')
  })
  test('hard ceiling: manual applies only below the hard limit when it started at or above it', () => {
    expect(judge({ ...base, trigger: 'manual', tokensBefore: 620_000, tokensAfter: 550_000 }).act).toBe('next')
    expect(judge({ ...base, trigger: 'manual', tokensBefore: 620_000, tokensAfter: 450_000 }).act).toBe('apply')
  })
  test('failures defer a soft compaction and fall back for auto and manual', () => {
    expect(failure('plugin', 'x').act).toBe('skip')
    expect(failure('plugin', 'x', 400_000, 500_000).act).toBe('skip')
    expect(failure('plugin', 'x', 500_000, 500_000).act).toBe('next')
    expect(failure('plugin', 'x', 466_000, 300_000).act).toBe('next')
    expect(failure('auto', 'x').act).toBe('next')
    expect(failure('manual', 'x').act).toBe('next')
  })
  test('tokens after drop by the characters removed', () => {
    expect(estimateAfter(400_000, 350_000, 250_000)).toBe(371_429)
    expect(estimateAfter(400_000, 0, 0)).toBe(400_000)
    expect(estimateAfter(10_000, 900_000, 0)).toBe(0)
  })
  test('the ratio scales the tokens freed', () => {
    expect(Math.round(rawFreed(350_000, 250_000))).toBe(28_571)
    expect(estimateAfter(400_000, 350_000, 250_000, DEFAULT_RATIO)).toBe(342_857)
    expect(estimateAfter(400_000, 350_000, 250_000, 3)).toBe(314_286)
  })
  test('calibration: the live gap (~33k estimated, ~108k real) moves the ratio towards the real one, step by step', () => {
    // 302k before, raw estimate 33k: the next request showed 194k
    const once = calibrate(DEFAULT_RATIO, 302_000, 33_000, 194_000)
    expect(once).toBe((2 + 108_000 / 33_000) / 2)
    expect(calibrate(once, 302_000, 33_000, 194_000)).toBeGreaterThan(once)
    expect(estimateAfter(302_000, 33_000 * 3.5, 0, calibrate(once, 302_000, 33_000, 194_000))).toBeLessThan(210_000)
  })
  test('calibration: a low reading holds the ratio at 1 or more, a /clear or a tiny estimate is ignored, 6 is the ceiling', () => {
    expect(calibrate(1, 300_000, 30_000, 299_000)).toBe(1)
    expect(calibrate(2, 300_000, 30_000, 5_000)).toBe(2)
    expect(calibrate(2, 300_000, 4_000, 250_000)).toBe(2)
    expect(calibrate(6, 300_000, 30_000, 60_000)).toBe(6)
  })
})

describe('key file', () => {
  test('parses KEY=value lines, comments, export and quotes', () => {
    const text = '# a comment\n\nexport TYPESAFE_API_KEY="k-two"\nJEV_COMPACTION_API_KEY = k-one # trailing\nOTHER=x\nnot a line\n'
    expect(parseEnvFile(text)).toEqual({ TYPESAFE_API_KEY: 'k-two', JEV_COMPACTION_API_KEY: 'k-one', OTHER: 'x' })
    expect(keyFromFile(text)).toBe('k-one')
  })
  test('falls back to TYPESAFE_API_KEY', () => {
    expect(keyFromFile('TYPESAFE_API_KEY=k-two\n')).toBe('k-two')
  })
  test('an empty value counts as missing, so the next variable is used', () => {
    expect(keyFromFile('JEV_COMPACTION_API_KEY=\nTYPESAFE_API_KEY=k-two')).toBe('k-two')
    expect(keyFromFile('JEV_COMPACTION_API_KEY=""\nTYPESAFE_API_KEY=')).toBeUndefined()
    expect(keyFromFile('# JEV_COMPACTION_API_KEY=commented\n')).toBeUndefined()
  })
  test('redacts the key from a message', () => {
    expect(redact('bad key k-one in text', 'k-one')).toBe('bad key *** in text')
    expect(redact('plain', undefined)).toBe('plain')
  })
})
