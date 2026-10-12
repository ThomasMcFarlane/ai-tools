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
  triggerTokens: 400_000,
  targetTokens: 256_000,
  hardTokens: 500_000,
  triggerPercent: 60,
  targetPercent: 40,
  hardPercent: 85,
  minFreedTokens: 20_000,
  softMinFreedTokens: 100_000,
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

/** Soft compaction starts once the context passes the trigger, and again only after it regrew. */
export function shouldTrigger(tokens: number, t: Thresholds, guard: number, regrow: number): boolean {
  if (tokens < t.trigger) return false
  return guard <= 0 || tokens >= guard + regrow
}

/** Why the compaction was refused (the text of the deferral or fallback). */
export type Verdict = { act: 'apply' } | { act: 'skip'; reason: string } | { act: 'next'; reason: string }

export type Judgement = {
  trigger: SessionCompactTrigger
  /** `/jev-compact now`: manual-like, never the built-in summary. */
  isNow: boolean
  tokensBefore: number
  tokensAfter: number
  thresholds: Thresholds
  minFreedTokens: number
}

/** The policy levels: soft (`plugin`), hard (`auto`), manual, and manual-like `now`. */
export function judge(j: Judgement): Verdict {
  const freed = j.tokensBefore - j.tokensAfter
  const enough = freed >= j.minFreedTokens
  if (j.isNow || j.trigger === 'manual') {
    if (enough) return { act: 'apply' }
    const reason = `frees only ~${freed} tokens (minimum ${j.minFreedTokens})`
    return j.isNow ? { act: 'skip', reason } : { act: 'next', reason }
  }
  if (j.trigger === 'auto') {
    return j.tokensAfter < j.thresholds.hard && enough
      ? { act: 'apply' }
      : { act: 'next', reason: `~${j.tokensAfter} tokens after pruning, freeing ~${freed} (hard limit ${j.thresholds.hard}, minimum ${j.minFreedTokens})` }
  }
  // Soft: a rewrite breaks the prompt cache, so it must pay for itself.
  if (j.tokensAfter <= j.thresholds.target || freed >= j.thresholds.softMinFreed) return { act: 'apply' }
  const reason = `frees only ~${freed} tokens (minimum ${j.thresholds.softMinFreed}), ~${j.tokensAfter} left (target ${j.thresholds.target})`
  return j.tokensBefore >= j.thresholds.hard ? { act: 'next', reason } : { act: 'skip', reason }
}

/** What a failure (Jev error, missing key, unfittable state) does at each level. */
export function failure(trigger: SessionCompactTrigger, reason: string, tokensBefore?: number, hard?: number): Verdict {
  if (trigger !== 'plugin') return { act: 'next', reason }
  return tokensBefore !== undefined && hard !== undefined && tokensBefore >= hard ? { act: 'next', reason } : { act: 'skip', reason }
}

/** The guard after an attempt: where the context stood, or where an applied compaction left it. */
export const guardAfter = (tokens: number, appliedTokensAfter: number | undefined) => appliedTokensAfter ?? tokens

/**
 * Tokens after a compaction: the characters removed at 3.5 per token come off the measured total. The plain
 * ratio of characters would also shrink the system prompt and tool schemas, which no compaction touches.
 */
export const estimateAfter = (tokensBefore: number, charsBefore: number, charsAfter: number) =>
  Math.max(0, Math.round(tokensBefore - Math.min(tokensBefore, Math.max(0, charsBefore - charsAfter) / 3.5)))
