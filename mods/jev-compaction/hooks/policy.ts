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
  rotate: boolean
  rotateAfterHours: number
  rotateHighTurns: number
  rotateHighTokens: number
  rotateKeepMessages: number
  rotateBudgetTokens: number
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
  // Off until a dry run (`/jev-compact rotate dry`) has been reviewed.
  rotate: false,
  rotateAfterHours: 72,
  rotateHighTurns: 100,
  rotateHighTokens: 250_000,
  rotateKeepMessages: 40,
  rotateBudgetTokens: 40_000,
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

/** Characters a token, for a history the host has not measured yet. */
export const CHARS_PER_TOKEN = 3.5

/** The scale a session starts with: the share of the messages' tokens kept is the share of their characters kept. */
export const DEFAULT_SCALE = 1

/**
 * Tokens after a compaction. The context is the fixed part (system prompt, tool schemas, skills: what the host's
 * breakdown counts outside `Messages`), which no compaction touches, plus the messages, which keep the share of their
 * characters the compaction kept, times the session's learnt `scale`. Proportional, so content that runs at 2 or at 4
 * characters a token cannot drive the estimate below the fixed part, as subtracting characters at a fixed rate did
 * (233k with ~400k characters of dense logs removed came out at ~6k; the next request measured 50k).
 */
export function estimateAfter(tokensBefore: number, fixedTokens: number, charsBefore: number, charsAfter: number, scale = DEFAULT_SCALE): number {
  const fixed = Math.min(tokensBefore, Math.max(0, fixedTokens))
  const kept = charsBefore > 0 ? Math.min(1, Math.max(0, charsAfter / charsBefore)) : 1
  return Math.round(fixed + (tokensBefore - fixed) * Math.min(1, kept * scale))
}

/** What an applied compaction's estimate rests on, kept until the host's next real count. */
export type Estimate = { fixed: number; messages: number; kept: number }

/**
 * The scale once the host has measured the context after an applied compaction (the first request after it): the
 * messages' real share over the share by characters, averaged with the old scale and held between 0.2 and 2. Below
 * 2000 estimated message tokens kept, or with a reading under the fixed part, nothing is learnt.
 */
export function calibrateScale(scale: number, e: Estimate, realAfter: number): number {
  const expected = e.messages * e.kept
  if (expected < 2_000 || realAfter <= e.fixed) return scale
  const measured = (realAfter - e.fixed) / expected
  if (!Number.isFinite(measured)) return scale
  return Math.min(2, Math.max(0.2, (scale + Math.min(2, Math.max(0.2, measured))) / 2))
}

/**
 * Whether a non-interactive launch reads its prompts as a stream (`--input-format stream-json`, as T3 Code and the
 * Agent SDK launch Claude Code): a long-lived session, unlike a one-shot `-p` run. `args` is the process's argv.
 */
export function readsStreamInput(args: readonly string[]): boolean {
  return args.some((a, i) => a === '--input-format=stream-json' || (a === '--input-format' && args[i + 1] === 'stream-json'))
}
