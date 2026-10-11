import { describe, expect, test } from 'claude-code/testing'

import { keyFromFile, parseEnvFile, redact } from './key'
import { DEFAULTS, estimateAfter, failure, guardAfter, judge, resolveConfig, shouldTrigger, thresholdsFor } from './policy'
import type { Judgement } from './policy'

describe('thresholds', () => {
  test('a 1M window uses the absolute token defaults', () => {
    expect(thresholdsFor(DEFAULTS, 1_000_000)).toEqual({ trigger: 400_000, target: 256_000, hard: 500_000, softMinFreed: 100_000 })
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
    expect(judge({ ...base, tokensBefore: 420_000, tokensAfter: 330_000 }).act).toBe('skip')
    expect(judge({ ...base, tokensBefore: 420_000, tokensAfter: 320_000 }).act).toBe('apply')
  })
  test('manual: applied when it frees the minimum, else built-in summary', () => {
    expect(judge({ ...base, trigger: 'manual', tokensAfter: 399_999 }).act).toBe('apply')
    expect(judge({ ...base, trigger: 'manual', tokensAfter: 410_000 }).act).toBe('next')
  })
  test('now: manual-like but never the built-in summary', () => {
    expect(judge({ ...base, isNow: true, tokensAfter: 410_000 }).act).toBe('skip')
    expect(judge({ ...base, isNow: true, tokensBefore: 620_000, tokensAfter: 610_000 }).act).toBe('skip')
    expect(judge({ ...base, isNow: true }).act).toBe('apply')
  })
  test('failures defer a soft compaction and fall back for auto and manual', () => {
    expect(failure('plugin', 'x').act).toBe('skip')
    expect(failure('plugin', 'x', 400_000, 500_000).act).toBe('skip')
    expect(failure('plugin', 'x', 500_000, 500_000).act).toBe('next')
    expect(failure('auto', 'x').act).toBe('next')
    expect(failure('manual', 'x').act).toBe('next')
  })
  test('tokens after drop by the characters removed', () => {
    expect(estimateAfter(400_000, 350_000, 250_000)).toBe(371_429)
    expect(estimateAfter(400_000, 0, 0)).toBe(400_000)
    expect(estimateAfter(10_000, 900_000, 0)).toBe(0)
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
