import type { EngineInterface, Next, Register, SessionCompactInput, TurnCompleteInput } from 'claude-code'

import { compact } from './compact'
import { jevAsker } from './jev'
import { DEFAULT_KEY_FILE, keyFromFile, redact } from './key'
import { DEFAULTS, estimateAfter, failure, guardAfter, judge, resolveConfig, shouldTrigger, thresholdsFor } from './policy'
import type { Config, Verdict } from './policy'
import type { CompactResult, Protect } from './types'

const SCORES = { plugin: 'jev-compaction', key: 'scores' } as const
const STATS = { plugin: 'jev-compaction', key: 'stats' } as const
const GUARD = { plugin: 'jev-compaction', key: 'guard' } as const
// How long after `/jev-compact now` the next /compact still counts as that request.
const NOW_VALID_MS = 60_000
const MAX_SCORES = 3000
// `$.session.messages()` and so, it appears, a compaction's transcript are the newest 4096 only.
const TRANSCRIPT_CAP = 4096
// Left of the hook's own time budget for everything but the Jev requests.
const BUDGET_RESERVE_MS = 1500
const NO_STATS = { applied: 0, deferred: 0, fallbacks: 0, freedTokens: 0, requests: 0 }

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function summary(r: CompactResult): string {
  const s = r.stats
  return `tools kept ${s.toolsKept}, truncated ${s.resultsTruncated}, dropped ${s.callsDropped}; texts kept ${s.textsKept}, abridged ${s.textsAbridged}, stubbed ${s.textsStubbed}; ${s.requests} Jev request(s)`
}

let config: Config = DEFAULTS
let compacting = false
// Kept in module memory once found; a missing key is looked for again next time.
let cachedKey: string | undefined
let isNow = false
let nowAt = 0
// Set by `/jev-compact now`: $.session.compact() is refused inside a command, and from a timer the engine skips this
// plugin's compaction hook (the built-in summary would run), so the next turn.complete does it.
let nowPending = false
// Estimated tokens after the compaction this hook last applied; read by the trigger that asked for it.
let lastApplied: number | undefined

/** Environment `AIS_SESSION_COMPACTION_JEV_API_KEY`, then `TYPESAFE_API_KEY`, then the key file. */
async function resolveKey($: EngineInterface): Promise<string | undefined> {
  if (cachedKey) return cachedKey
  const fromEnv = (await $.env.get('AIS_SESSION_COMPACTION_JEV_API_KEY')) || (await $.env.get('TYPESAFE_API_KEY'))
  if (fromEnv) return (cachedKey = fromEnv)
  let path = config.keyFile
  if (!path) {
    const home = await $.env.get('HOME')
    if (!home) return undefined
    path = `${home.replace(/\/+$/, '')}/${DEFAULT_KEY_FILE}`
  }
  try {
    return (cachedKey = keyFromFile(await $.fs.read(path)))
  } catch {
    return undefined
  }
}

function notify($: EngineInterface, text: string) {
  $.ui.log(`jev-compaction: ${text}`)
  $.ui.toast(`jev-compaction: ${text}`, { timeoutMs: 12_000 })
}

async function bump($: EngineInterface, change: Partial<typeof NO_STATS>) {
  const { value = NO_STATS } = await $.state.get(STATS)
  const next = { ...value }
  for (const [name, by] of Object.entries(change)) next[name as keyof typeof NO_STATS] += by
  await $.state.set(STATS, next)
}

async function remember($: EngineInterface, memory: Record<string, number>, fresh: Record<string, number>) {
  const merged = { ...memory, ...fresh }
  const keys = Object.keys(merged)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SCORES))) delete merged[key]
  await $.state.set(SCORES, merged)
}

/** The main conversation's tool results and user messages that hold images or documents. */
async function protection($: EngineInterface, messages: SessionCompactInput['messages']): Promise<Protect> {
  const api = await $.session.messages({ as: 'api' })
  const ids = new Set<string>()
  const withMedia = new Set<string>()
  for (const m of api) {
    let media = false
    for (const block of m.content) {
      if (block.type === 'tool_result') {
        const inner = block['content']
        if (Array.isArray(inner) && inner.some((b) => (b as { type?: string } | null)?.type !== 'text')) ids.add(String(block['tool_use_id']))
      } else if (block.type === 'image' || block.type === 'document') media = true
    }
    if (media && m.role === 'user') withMedia.add(m.content.map((b) => (b.type === 'text' ? String(b['text']) : '')).join(''))
  }
  const indexes = new Set<number>()
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.text !== '' && withMedia.has(m.text)) indexes.add(i)
  })
  return { ids, indexes }
}

/** One Jev request, abandoned with an error after `ms`: `$.http.fetch` has no timeout of its own. */
async function fetchWithin($: EngineInterface, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } | undefined, ms: number) {
  const stop = new AbortController()
  const timer = $.clock.sleep(ms, { signal: stop.signal }).then(() => {
    throw new Error(`Jev request timed out after ${ms} ms`)
  })
  timer.catch(() => undefined)
  try {
    return await Promise.race([$.http.fetch(url, init), timer])
  } finally {
    stop.abort()
  }
}

async function attempt($: EngineInterface, e: SessionCompactInput, key: string, tokens: number | undefined, window: number, budgetMs: number) {
  const { value: memory = {} } = await $.state.get(SCORES)
  const protect = await protection($, e.messages)
  const started = Date.now()
  const ask = jevAsker(
    async (url, init) => {
      const left = Math.max(1000, budgetMs - (Date.now() - started))
      const r = await fetchWithin($, url, init, Math.min(config.jevTimeoutMs, left))
      return { status: r.status, ok: r.ok, text: r.text }
    },
    key,
    config.model,
  )
  const result = await compact(e.messages, ask, config, memory, { protect, stop: () => Date.now() - started >= budgetMs })
  await remember($, memory, result.scores)
  const tokensBefore = tokens ?? Math.round(result.stats.charsBefore / 3.5)
  const tokensAfter = estimateAfter(tokensBefore, result.stats.charsBefore, result.stats.charsAfter)
  return { result, tokensBefore, tokensAfter, thresholds: thresholdsFor(config, window) }
}

async function onCompact($: EngineInterface, e: SessionCompactInput, next: Next<'session.compact'>) {
  if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
  // The user asked for something specific, or the list may be cut: leave it to the built-in summary.
  if (e.instructions || e.messages.length >= TRANSCRIPT_CAP) return next(e)
  const now = isNow && Date.now() - nowAt < NOW_VALID_MS && (e.trigger === 'plugin' || e.trigger === 'manual')
  isNow = false
  let key: string | undefined
  let verdict: Verdict
  let usage: { tokens?: number; window: number } | undefined
  let done: Awaited<ReturnType<typeof attempt>> | undefined
  try {
    usage = (await $.session.usage()).context
    key = await resolveKey($)
    if (!key) throw new Error('no Jev API key (environment or key file)')
    const budgetMs = Math.max(1000, Math.min(config.jevTotalMs, next.budget.remainingMs - BUDGET_RESERVE_MS))
    done = await attempt($, e, key, usage.tokens, usage.window, budgetMs)
    verdict = judge({ trigger: e.trigger, isNow: now, ...done, minFreedTokens: config.minFreedTokens })
  } catch (err) {
    const text = redact(message(err), key)
    if (/\((401|403)\)/.test(text)) cachedKey = undefined
    verdict = now ? { act: 'skip', reason: text } : failure(e.trigger, text, usage?.tokens, usage && thresholdsFor(config, usage.window).hard)
  }
  const requests = done?.result.stats.requests ?? 0
  try {
    if (verdict.act === 'apply' && done) {
      const freed = done.tokensBefore - done.tokensAfter
      await bump($, { applied: 1, freedTokens: freed, requests })
      lastApplied = done.tokensAfter
      notify($, `compacted ~${k(done.tokensBefore)} to ~${k(done.tokensAfter)} tokens (${summary(done.result)})`)
      return { messages: done.result.messages, tokensBefore: done.tokensBefore, tokensAfter: done.tokensAfter }
    }
    if (verdict.act === 'skip') {
      await bump($, { deferred: 1, requests })
      notify($, `deferred: ${verdict.reason}`)
      return { skip: `jev-compaction deferred: ${verdict.reason}` }
    }
    await bump($, { fallbacks: 1, requests })
    if (verdict.act === 'next') notify($, `built-in summary: ${verdict.reason}`)
  } catch (err) {
    $.ui.log(`jev-compaction: bookkeeping failed: ${message(err)}`)
    if (verdict.act === 'apply' && done) return { messages: done.result.messages }
  }
  return next(e)
}

// `session.measure` fires while the turn still runs, where `$.session.compact()` rejects; `turn.complete` is after it.
async function onTurnComplete($: EngineInterface, e: TurnCompleteInput, next: Next<'turn.complete'>) {
  if ((e as { agentId?: string }).agentId !== undefined) return next(e)
  if (compacting) return next(e)
  compacting = true
  try {
    const { tokens, window } = (await $.session.usage()).context
    if (tokens !== undefined) {
      const t = thresholdsFor(config, window)
      let { value: guard = 0 } = await $.state.get(GUARD)
      // The context fell below the target (a /clear or a compaction): the old attempt no longer says anything.
      if (guard > 0 && tokens < t.target) {
        guard = 0
        await $.state.set(GUARD, 0)
      }
      const force = nowPending
      nowPending = false
      if (force || shouldTrigger(tokens, t, guard, config.regrowTokens)) {
        if (force) {
          isNow = true
          nowAt = Date.now()
        }
        lastApplied = undefined
        await $.session.compact()
        await $.state.set(GUARD, guardAfter(tokens, lastApplied))
      }
    }
  } catch (err) {
    $.ui.log(`jev-compaction: periodic compaction skipped: ${message(err)}`)
  } finally {
    compacting = false
  }
  return next(e)
}

async function onCommand($: EngineInterface, args: string) {
  const word = args.trim().split(/\s+/)[0] ?? ''
  if (word === 'stats') {
    const { value: s = NO_STATS } = await $.state.get(STATS)
    return { text: `jev-compaction: ${s.applied} applied, ${s.deferred} deferred, ${s.fallbacks} built-in fallbacks; ~${s.freedTokens} tokens freed; ${s.requests} Jev requests` }
  }
  if (word === 'now') {
    nowPending = true
    return { text: 'jev-compaction: will compact when your next turn ends (the host does not allow it from inside a command).' }
  }
  return { text: 'Usage: /jev-compact now | stats' }
}

export const register: Register = (on, options) => {
  config = resolveConfig(options)
  compacting = isNow = nowPending = false
  cachedKey = undefined
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'jev-compact', description: 'Compact the conversation with Jev (now) or show totals (stats)', argumentHint: 'now | stats' })
    } catch (err) {
      $.ui.log(`jev-compaction: command not registered: ${message(err)}`)
    }
    return next(e)
  })
  on('turn.complete', ($, e, next) => onTurnComplete($, e, next))
  on('session.compact', ($, e, next) => onCompact($, e, next))
  on('command.run', { command: 'jev-compact' }, ($, e) => onCommand($, e.args))
}
