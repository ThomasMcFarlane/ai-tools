import type { SessionCompactTrigger } from 'claude-code'

import { DEFAULT_TRIM_COMMANDS } from './entry'

export type Config = {
  triggerTokens: number
  targetTokens: number
  hardTokens: number
  triggerPercent: number
  targetPercent: number
  hardPercent: number
  minFreedTokens: number
  softMinFreedTokens: number
  softMinFreedPercent: number
  regrowTokens: number
  prescoreMarginTokens: number
  prescoreBatches: number
  prescoreEveryTokens: number
  prescoreMinQuestions: number
  jevTimeoutMs: number
  jevTotalMs: number
  model: string
  keyFile: string
  goal: string
  keepThreshold: number
  abridgeThreshold: number
  preserveRecentMessages: number
  maxStateTokens: number
  maxRequestTokens: number
  truncateHeadChars: number
  textCompression: boolean
  sentenceKeepThreshold: number
  maxSentenceDropRatio: number
  compressOnEntry: boolean
  entryUser: boolean
  entryAssistant: boolean
  entryToolResults: boolean
  entryTimeoutMs: number
  entryResultMinChars: number
  entryTrimCommands: string
}

export const DEFAULTS: Config = {
  triggerTokens: 200_000,
  targetTokens: 120_000,
  hardTokens: 250_000,
  triggerPercent: 60,
  targetPercent: 40,
  hardPercent: 85,
  minFreedTokens: 20_000,
  softMinFreedTokens: 30_000,
  softMinFreedPercent: 25,
  regrowTokens: 50_000,
  prescoreMarginTokens: 100_000,
  prescoreBatches: 4,
  prescoreEveryTokens: 20_000,
  prescoreMinQuestions: 60,
  jevTimeoutMs: 8_000,
  jevTotalMs: 20_000,
  model: 'jev-latest',
  keyFile: '',
  goal: '',
  keepThreshold: 0.5,
  abridgeThreshold: 0.2,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  textCompression: true,
  sentenceKeepThreshold: 0.35,
  maxSentenceDropRatio: 0.7,
  compressOnEntry: true,
  entryUser: false,
  entryAssistant: false,
  entryToolResults: true,
  entryTimeoutMs: 3_000,
  entryResultMinChars: 12_000,
  entryTrimCommands: DEFAULT_TRIM_COMMANDS,
}

/** Windows above this use the absolute token thresholds, smaller ones percentages. */
export const LARGE_WINDOW = 300_000

export function resolveConfig(options: Readonly<Record<string, unknown>>): Config {
  const out: Record<string, string | number | boolean> = { ...DEFAULTS }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = options[key]
    if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') out[key] = value
    } else if (typeof fallback === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    } else if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out as Config
}

export type Thresholds = { trigger: number; target: number; hard: number; softMinFreed: number }

export function thresholdsFor(config: Config, window: number): Thresholds {
  if (window > LARGE_WINDOW) return { trigger: config.triggerTokens, target: config.targetTokens, hard: config.hardTokens, softMinFreed: config.softMinFreedTokens }
  const of = (percent: number) => Math.round((window * percent) / 100)
  return { trigger: of(config.triggerPercent), target: of(config.targetPercent), hard: of(config.hardPercent), softMinFreed: of(config.softMinFreedPercent) }
}

/** Soft compaction starts once the context passes the trigger, and again only after it regrew; at or above the hard limit always. */
export function shouldTrigger(tokens: number, t: Thresholds, guard: number, regrow: number): boolean {
  if (tokens < t.trigger) return false
  return tokens >= t.hard || guard <= 0 || tokens >= guard + regrow
}

/** Why the compaction was refused (the text of the deferral or fallback). */
export type Verdict = { act: 'apply' } | { act: 'skip'; reason: string } | { act: 'next'; reason: string }

export type Judgement = {
  trigger: SessionCompactTrigger
  /** `/jev-compact now`: manual-like; the built-in summary only at or above the hard limit. */
  isNow: boolean
  tokensBefore: number
  tokensAfter: number
  thresholds: Thresholds
  minFreedTokens: number
}

/**
 * The policy levels: soft (`plugin`), hard (`auto`), manual, and manual-like `now`. The hard limit is a ceiling:
 * at or above it no level applies a result that ends at or above it, and none defers; the built-in summary runs.
 */
export function judge(j: Judgement): Verdict {
  const freed = j.tokensBefore - j.tokensAfter
  const enough = freed >= j.minFreedTokens
  const { hard } = j.thresholds
  const stuck = j.tokensBefore >= hard && j.tokensAfter >= hard
  if (j.isNow || j.trigger === 'manual') {
    if (enough && !stuck) return { act: 'apply' }
    const reason = stuck ? `~${j.tokensAfter} tokens after pruning, still at the hard limit ${hard}` : `frees only ~${freed} tokens (minimum ${j.minFreedTokens})`
    return j.isNow && !stuck ? { act: 'skip', reason } : { act: 'next', reason }
  }
  if (j.trigger === 'auto') {
    return j.tokensAfter < hard && enough
      ? { act: 'apply' }
      : { act: 'next', reason: `~${j.tokensAfter} tokens after pruning, freeing ~${freed} (hard limit ${hard}, minimum ${j.minFreedTokens})` }
  }
  // At or above the hard limit only the size after counts: the result must end below it.
  if (j.tokensBefore >= hard) {
    return j.tokensAfter < hard ? { act: 'apply' } : { act: 'next', reason: `~${j.tokensAfter} tokens after pruning, freeing ~${freed}, still at the hard limit ${hard}` }
  }
  // Soft: a rewrite breaks the prompt cache, so it must pay for itself.
  if (j.tokensAfter <= j.thresholds.target || freed >= j.thresholds.softMinFreed) return { act: 'apply' }
  return { act: 'skip', reason: `frees only ~${freed} tokens (minimum ${j.thresholds.softMinFreed}), ~${j.tokensAfter} left (target ${j.thresholds.target})` }
}

/** What a failure (Jev error, missing key, unfittable state) does at each level. */
export function failure(trigger: SessionCompactTrigger, reason: string, tokensBefore?: number, hard?: number): Verdict {
  if (trigger !== 'plugin') return { act: 'next', reason }
  return tokensBefore !== undefined && hard !== undefined && tokensBefore >= hard ? { act: 'next', reason } : { act: 'skip', reason }
}

/** The guard after an attempt: where the context stood, or where an applied compaction left it. */
export const guardAfter = (tokens: number, appliedTokensAfter: number | undefined) => appliedTokensAfter ?? tokens

const CHARS_PER_TOKEN = 3.5

/**
 * Real tokens freed per token of the character estimate. The characters miss part of what a rewrite removes (thinking
 * blocks and per-row overhead of the rebuilt rows), and code and JSON run below 3.5 characters a token: from 14 to 24 Oct
 * 2026 applied compactions estimated ~33k freed where the next request showed ~108k (median). A session starts at a
 * cautious 2 and then learns its own ratio from the host's real token count (`calibrate`).
 */
export const DEFAULT_RATIO = 2

/** Tokens a compaction frees by the characters it removes alone, before the ratio. */
export const rawFreed = (charsBefore: number, charsAfter: number) => Math.max(0, charsBefore - charsAfter) / CHARS_PER_TOKEN

/**
 * Tokens after a compaction: the characters removed, at 3.5 per token and times the ratio, come off the measured total.
 * The plain ratio of characters would also shrink the system prompt and tool schemas, which no compaction touches.
 */
export const estimateAfter = (tokensBefore: number, charsBefore: number, charsAfter: number, ratio = 1) =>
  Math.max(0, Math.round(tokensBefore - Math.min(tokensBefore, rawFreed(charsBefore, charsAfter) * ratio)))

/**
 * The ratio once the next request has measured an applied compaction: real tokens freed over the raw estimate,
 * averaged with the old ratio and held between 1 and 6. A small raw estimate, or a reading above 8 (a /clear in
 * between), says nothing and leaves the ratio as it was.
 */
export function calibrate(ratio: number, tokensBefore: number, raw: number, realAfter: number): number {
  if (raw < 5_000) return ratio
  const measured = (tokensBefore - realAfter) / raw
  if (measured > 8) return ratio
  return Math.min(6, Math.max(1, (ratio + Math.max(1, measured)) / 2))
}
