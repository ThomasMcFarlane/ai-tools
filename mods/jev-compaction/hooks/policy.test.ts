import { describe, expect, test } from 'claude-code/testing'

import { keyFromFile, parseEnvFile, redact } from './key'
import { DEFAULTS, estimateAfter, failure, judge, resolveConfig, shouldTrigger, thresholdsFor } from './policy'
import type { Judgement } from './policy'

describe('thresholds', () => {
  test('a 1M window uses the absolute token defaults', () => {
    expect(thresholdsFor(DEFAULTS, 1_000_000)).toEqual({ trigger: 400_000, target: 256_000, hard: 500_000 })
  })
  test('a small window uses percentages', () => {
    expect(thresholdsFor(DEFAULTS, 200_000)).toEqual({ trigger: 120_000, target: 80_000, hard: 170_000 })
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
  test('after an attempt it waits for 25000 tokens of regrowth', () => {
    expect(shouldTrigger(420_000, t, 410_000, 25_000)).toBe(false)
    expect(shouldTrigger(434_999, t, 410_000, 25_000)).toBe(false)
    expect(shouldTrigger(435_000, t, 410_000, 25_000)).toBe(true)
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
  test('soft: applied when it frees the minimum even above the target', () => {
    expect(judge(base)).toEqual({ act: 'apply' })
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
    expect(failure('auto', 'x').act).toBe('next')
    expect(failure('manual', 'x').act).toBe('next')
  })
  test('tokens after scale with the characters kept', () => {
    expect(estimateAfter(400_000, 1000, 600)).toBe(240_000)
    expect(estimateAfter(400_000, 0, 0)).toBe(400_000)
  })
})

describe('key file', () => {
  test('parses KEY=value lines, comments, export and quotes', () => {
    const text = '# a comment\n\nexport TYPESAFE_API_KEY="k-two"\nAIS_SESSION_COMPACTION_JEV_API_KEY = k-one # trailing\nOTHER=x\nnot a line\n'
    expect(parseEnvFile(text)).toEqual({ TYPESAFE_API_KEY: 'k-two', AIS_SESSION_COMPACTION_JEV_API_KEY: 'k-one', OTHER: 'x' })
    expect(keyFromFile(text)).toBe('k-one')
  })
  test('falls back to TYPESAFE_API_KEY', () => {
    expect(keyFromFile('TYPESAFE_API_KEY=k-two\n')).toBe('k-two')
  })
  test('an empty value counts as missing, so the next variable is used', () => {
    expect(keyFromFile('AIS_SESSION_COMPACTION_JEV_API_KEY=\nTYPESAFE_API_KEY=k-two')).toBe('k-two')
    expect(keyFromFile('AIS_SESSION_COMPACTION_JEV_API_KEY=""\nTYPESAFE_API_KEY=')).toBeUndefined()
    expect(keyFromFile('# AIS_SESSION_COMPACTION_JEV_API_KEY=commented\n')).toBeUndefined()
  })
  test('redacts the key from a message', () => {
    expect(redact('bad key k-one in text', 'k-one')).toBe('bad key *** in text')
    expect(redact('plain', undefined)).toBe('plain')
  })
})
