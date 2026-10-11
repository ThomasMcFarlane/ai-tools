import type { EngineInterface, Next, Register, SessionCompactInput, SessionMeasureInput } from 'claude-code'

import { compact } from './compact'
import { jevAsker } from './jev'
import { DEFAULT_KEY_FILE, keyFromFile, redact } from './key'
import { DEFAULTS, estimateAfter, failure, judge, resolveConfig, shouldTrigger, thresholdsFor } from './policy'
import type { Config, Verdict } from './policy'
import type { CompactResult } from './types'

const SCORES = { plugin: 'jev-compaction', key: 'scores' } as const
const STATS = { plugin: 'jev-compaction', key: 'stats' } as const
const GUARD = { plugin: 'jev-compaction', key: 'guard' } as const
const MAX_SCORES = 3000
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

async function attempt($: EngineInterface, e: SessionCompactInput, key: string, tokens: number | undefined, window: number) {
  const { value: memory = {} } = await $.state.get(SCORES)
  const ask = jevAsker(async (url, init) => {
    const r = await $.http.fetch(url, init)
    return { status: r.status, ok: r.ok, text: r.text }
  }, key, config.model)
  const result = await compact(e.messages, ask, config, memory)
  await remember($, memory, result.scores)
  const tokensBefore = tokens ?? Math.round(result.stats.charsBefore / 3.5)
  const tokensAfter = estimateAfter(tokensBefore, result.stats.charsBefore, result.stats.charsAfter)
  return { result, tokensBefore, tokensAfter, thresholds: thresholdsFor(config, window) }
}

async function onCompact($: EngineInterface, e: SessionCompactInput, next: Next<'session.compact'>) {
  if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
  const now = e.trigger === 'plugin' && isNow
  let key: string | undefined
  let verdict: Verdict
  let done: Awaited<ReturnType<typeof attempt>> | undefined
  try {
    const { context } = await $.session.usage()
    key = await resolveKey($)
    if (!key) throw new Error('no Jev API key (environment or key file)')
    done = await attempt($, e, key, context.tokens, context.window)
    verdict = judge({ trigger: e.trigger, isNow: now, ...done, minFreedTokens: config.minFreedTokens })
  } catch (err) {
    const text = redact(message(err), key)
    if (/\((401|403)\)/.test(text)) cachedKey = undefined
    verdict = failure(e.trigger, text)
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

async function onMeasure($: EngineInterface, e: SessionMeasureInput, next: Next<'session.measure'>) {
  const { tokens, window } = e.context
  if (compacting || tokens === undefined || !e.changed.includes('context')) return next(e)
  compacting = true
  try {
    const t = thresholdsFor(config, window)
    const { value: guard = 0 } = await $.state.get(GUARD)
    if (tokens < t.trigger) {
      if (guard) await $.state.set(GUARD, 0)
    } else if (shouldTrigger(tokens, t, guard, config.regrowthTokens)) {
      lastApplied = undefined
      await $.session.compact()
      const after = lastApplied
      await $.state.set(GUARD, after === undefined ? tokens : after <= t.target ? 0 : after)
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
  if (word !== 'now') return { text: 'Usage: /jev-compact now | stats' }
  if (compacting) return { text: 'jev-compaction: a compaction is already running.' }
  // The host refuses $.session.compact() inside a command.run hook; a timer runs it as a later event.
  compacting = isNow = true
  $.clock.after(100, () => runNow($))
  return { text: 'jev-compaction: compacting now; the outcome follows.' }
}

async function runNow($: EngineInterface) {
  try {
    const r = await $.session.compact()
    if (r.skip) notify($, r.skip)
  } catch (err) {
    notify($, `compaction failed: ${message(err)}`)
  } finally {
    compacting = isNow = false
  }
}

export const register: Register = (on, options) => {
  config = resolveConfig(options)
  compacting = isNow = false
  cachedKey = undefined
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'jev-compact', description: 'Compact the conversation with Jev (now) or show totals (stats)', argumentHint: 'now | stats' })
    } catch (err) {
      $.ui.log(`jev-compaction: command not registered: ${message(err)}`)
    }
    return next(e)
  })
  on('session.measure', ($, e, next) => onMeasure($, e, next))
  on('session.compact', ($, e, next) => onCompact($, e, next))
  on('command.run', { command: 'jev-compact' }, ($, e) => onCommand($, e.args))
}
