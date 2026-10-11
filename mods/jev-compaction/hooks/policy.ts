import type { SessionCompactTrigger } from 'claude-code'

export type Config = {
  triggerTokens: number
  targetTokens: number
  hardTokens: number
  triggerPercent: number
  targetPercent: number
  hardPercent: number
  minFreedTokens: number
  regrowthTokens: number
  model: string
  keyFile: string
  goal: string
  keepThreshold: number
  abridgeThreshold: number
  preserveRecentMessages: number
  maxStateTokens: number
  maxRequestTokens: number
  truncateHeadChars: number
}

export const DEFAULTS: Config = {
  triggerTokens: 400_000,
  targetTokens: 256_000,
  hardTokens: 500_000,
  triggerPercent: 60,
  targetPercent: 40,
  hardPercent: 85,
  minFreedTokens: 20_000,
  regrowthTokens: 25_000,
  model: 'jev-latest',
  keyFile: '',
  goal: '',
  keepThreshold: 0.5,
  abridgeThreshold: 0.2,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
}

/** Windows above this use the absolute token thresholds, smaller ones percentages. */
export const LARGE_WINDOW = 300_000

export function resolveConfig(options: Readonly<Record<string, unknown>>): Config {
  const out: Record<string, string | number> = { ...DEFAULTS }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = options[key]
    if (typeof fallback === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    } else if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out as Config
}

export type Thresholds = { trigger: number; target: number; hard: number }

export function thresholdsFor(config: Config, window: number): Thresholds {
  if (window > LARGE_WINDOW) return { trigger: config.triggerTokens, target: config.targetTokens, hard: config.hardTokens }
  const of = (percent: number) => Math.round((window * percent) / 100)
  return { trigger: of(config.triggerPercent), target: of(config.targetPercent), hard: of(config.hardPercent) }
}

/** Soft compaction starts once the context passes the trigger, and again only after it regrew. */
export function shouldTrigger(tokens: number, t: Thresholds, guard: number, regrowth: number): boolean {
  if (tokens < t.trigger) return false
  return guard <= 0 || tokens >= guard + regrowth
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
    return j.tokensAfter < j.thresholds.hard
      ? { act: 'apply' }
      : { act: 'next', reason: `still ~${j.tokensAfter} tokens after pruning (hard limit ${j.thresholds.hard})` }
  }
  if (j.tokensAfter <= j.thresholds.target || enough) return { act: 'apply' }
  const reason = `frees only ~${freed} tokens, ~${j.tokensAfter} left (target ${j.thresholds.target})`
  return j.tokensBefore >= j.thresholds.hard ? { act: 'next', reason } : { act: 'skip', reason }
}

/** What a failure (Jev error, missing key, unfittable state) does at each level. */
export function failure(trigger: SessionCompactTrigger, reason: string): Verdict {
  return trigger === 'plugin' ? { act: 'skip', reason } : { act: 'next', reason }
}

export const estimateAfter = (tokensBefore: number, charsBefore: number, charsAfter: number) =>
  charsBefore <= 0 ? tokensBefore : Math.round((tokensBefore * charsAfter) / charsBefore)
