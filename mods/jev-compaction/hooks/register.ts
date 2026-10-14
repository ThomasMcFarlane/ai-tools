import type { EngineInterface, Next, Register, SessionAppendInput, SessionCompactInput, TurnCompleteInput } from 'claude-code'

import { compact, prescore } from './compact'
import { rewriteRow } from './entry'
import type { EntryRow, Judge } from './entry'
import { jevAsker } from './jev'
import { DEFAULT_KEY_FILE, keyFromFile, redact } from './key'
import { DEFAULTS, estimateAfter, failure, guardAfter, judge, resolveConfig, shouldTrigger, thresholdsFor } from './policy'
import type { Config, Verdict } from './policy'
import { goalFromMessages, truncate } from './state'
import type { CompactResult, Protect } from './types'

const SCORES = { plugin: 'jev-compaction', key: 'scores' } as const
const STATS = { plugin: 'jev-compaction', key: 'stats' } as const
const INTERACTIVE = { plugin: 'jev-compaction', key: 'interactive' } as const
const GUARD = { plugin: 'jev-compaction', key: 'guard' } as const
// How long after `/jev-compact now` the next /compact still counts as that request.
const NOW_VALID_MS = 60_000
const MAX_SCORES = 3000
// `$.session.messages()` and so, it appears, a compaction's transcript are the newest 4096 only.
const TRANSCRIPT_CAP = 4096
const NO_STATS = { applied: 0, deferred: 0, fallbacks: 0, freedTokens: 0, requests: 0, sentencesDropped: 0, wordCharsSaved: 0, entryCharsSaved: 0 }

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function summary(r: CompactResult): string {
  const s = r.stats
  return `tools kept ${s.toolsKept}, truncated ${s.resultsTruncated}, dropped ${s.callsDropped}; texts kept ${s.textsKept}, abridged ${s.textsAbridged}, stubbed ${s.textsStubbed}; ${s.sentencesDropped} sentences dropped, ${s.wordCharsSaved} chars saved by word compression; ${s.requests} Jev request(s)${s.abandoned > 0 ? `; ${s.abandoned} items unscored` : ''}`
}

let config: Config = DEFAULTS
let compacting = false
// Kept in module memory once found; a missing key is looked for again next time.
let cachedKey: string | undefined
let isNow = false
let nowAt = 0
// Whether the session is interactive: undefined until known (a hot reload re-reads it from $.state).
let interactive: boolean | undefined
let prescoreAt = 0
let prescoring = false
// Set by `/jev-compact now`: $.session.compact() is refused inside a command, and from a timer the engine skips this
// plugin's compaction hook (the built-in summary would run), so the next turn.complete does it.
let nowPending = false
// Estimated tokens after the compaction this hook last applied; read by the trigger that asked for it.
let lastApplied: number | undefined

/** Environment `JEV_COMPACTION_API_KEY`, then `TYPESAFE_API_KEY`, then the key file. */
async function resolveKey($: EngineInterface): Promise<string | undefined> {
  if (cachedKey) return cachedKey
  const fromEnv = (await $.env.get('JEV_COMPACTION_API_KEY')) || (await $.env.get('TYPESAFE_API_KEY'))
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
  const { value } = await $.state.get(STATS)
  const next = { ...NO_STATS, ...value }
  for (const [name, by] of Object.entries(change)) next[name as keyof typeof NO_STATS] += by
  await $.state.set(STATS, next)
}

async function remember($: EngineInterface, memory: Record<string, number>, fresh: Record<string, number>) {
  const merged = { ...memory, ...fresh }
  const keys = Object.keys(merged)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SCORES))) delete merged[key]
  await $.state.set(SCORES, merged)
}

/**
 * Tool results of the main conversation that hold images or documents, and whether any user message does.
 * The Messages API form is normalised and cannot be matched to the rows reliably, so with media in a user
 * message no user text is abridged at all.
 */
async function protection($: EngineInterface): Promise<Protect> {
  const api = await $.session.messages({ as: 'api' })
  const ids = new Set<string>()
  let noUserText = false
  for (const m of api) {
    for (const block of m.content) {
      if (block.type === 'tool_result') {
        const inner = block['content']
        if (Array.isArray(inner) && inner.some((b) => (b as { type?: string } | null)?.type !== 'text')) ids.add(String(block['tool_use_id']))
      } else if ((block.type === 'image' || block.type === 'document') && m.role === 'user') noUserText = true
    }
  }
  return { ids, indexes: new Set(), noUserText }
}

/**
 * One Jev request, abandoned with an error after `ms`: `$.http.fetch` has no timeout and cannot be cancelled, so
 * the request is only left behind. The timeout is a `$.clock.after` timer, not a `$.clock.sleep`: a clock wait counts
 * against the hook's 10 s budget, a `$` call in flight does not.
 */
async function fetchWithin($: EngineInterface, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } | undefined, ms: number) {
  let timer: { cancel: () => void } | undefined
  const late = new Promise<never>((_, reject) => {
    timer = $.clock.after(ms, () => reject(new Error(`Jev request timed out after ${ms} ms`)))
  })
  late.catch(() => undefined)
  try {
    return await Promise.race([$.http.fetch(url, init), late])
  } finally {
    timer?.cancel()
  }
}

function asker($: EngineInterface, key: string, timeoutMs: number, started: number, budgetMs: number) {
  return jevAsker(
    async (url, init) => {
      const left = Math.max(1000, budgetMs - (Date.now() - started))
      const r = await fetchWithin($, url, init, Math.min(timeoutMs, left))
      return { status: r.status, ok: r.ok, text: r.text }
    },
    key,
    config.model,
  )
}

async function attempt($: EngineInterface, e: SessionCompactInput, key: string, tokens: number | undefined, window: number) {
  const { value: memory = {} } = await $.state.get(SCORES)
  const protect = await protection($)
  const started = Date.now()
  const budgetMs = config.jevTotalMs
  const ask = asker($, key, config.jevTimeoutMs, started, budgetMs)
  // No round starts that could not finish inside the total time.
  const stop = () => Date.now() - started > budgetMs - config.jevTimeoutMs
  const result = await compact(e.messages, ask, config, memory, { protect, stop })
  await remember($, memory, result.scores)
  const tokensBefore = tokens ?? Math.round(result.stats.charsBefore / 3.5)
  const tokensAfter = estimateAfter(tokensBefore, result.stats.charsBefore, result.stats.charsAfter)
  return { result, tokensBefore, tokensAfter, thresholds: thresholdsFor(config, window) }
}

async function onCompact($: EngineInterface, e: SessionCompactInput, next: Next<'session.compact'>) {
  if (e.agentId !== undefined || e.trigger === 'precompute' || !Array.isArray(e.messages)) return next(e)
  const now = isNow && Date.now() - nowAt < NOW_VALID_MS && (e.trigger === 'plugin' || e.trigger === 'manual')
  isNow = false
  // The user asked for something specific: that is the built-in summary's job.
  if (e.instructions) return next(e)
  // The list may be cut. A soft compaction waits (the engine compacts at its own limit) unless the context is at or
  // above the hard limit; auto and manual, which must produce something, fall back.
  if (e.messages.length >= TRANSCRIPT_CAP) {
    if (e.trigger !== 'plugin' && !now) return next(e)
    const usage = await $.session.usage().then((u) => u.context, () => undefined)
    return usage?.tokens !== undefined && usage.tokens >= thresholdsFor(config, usage.window).hard ? next(e) : { skip: 'jev-compaction: transcript over 4096 messages' }
  }
  let key: string | undefined
  let verdict: Verdict
  let usage: { tokens?: number; window: number } | undefined
  let done: Awaited<ReturnType<typeof attempt>> | undefined
  try {
    usage = (await $.session.usage()).context
    key = await resolveKey($)
    if (!key) throw new Error('no Jev API key (environment or key file)')
    done = await attempt($, e, key, usage.tokens, usage.window)
    verdict = judge({ trigger: e.trigger, isNow: now, ...done, minFreedTokens: config.minFreedTokens })
  } catch (err) {
    const text = redact(message(err), key)
    if (/\((401|403)\)/.test(text)) cachedKey = undefined
    verdict = failure(now ? 'plugin' : e.trigger, text, usage?.tokens, usage && thresholdsFor(config, usage.window).hard)
  }
  const requests = done?.result.stats.requests ?? 0
  try {
    if (verdict.act === 'apply' && done) {
      const freed = done.tokensBefore - done.tokensAfter
      await bump($, { applied: 1, freedTokens: freed, requests, sentencesDropped: done.result.stats.sentencesDropped, wordCharsSaved: done.result.stats.wordCharsSaved })
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
  if ((e as { agentId?: string }).agentId !== undefined || e.reason !== 'answer') return next(e)
  interactive ??= (await $.state.get(INTERACTIVE)).value ?? false
  if (!interactive) return next(e)
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
      } else if (tokens >= t.trigger - config.prescoreMarginTokens && tokens < t.trigger && tokens >= prescoreAt + config.prescoreEveryTokens && !prescoring) {
        // Off the critical path: the turn is not held open while Jev answers.
        prescoreAt = tokens
        prescoring = true
        $.clock.after(0, () => {
          void prescoreSome($).finally(() => {
            prescoring = false
          })
        })
      }
    }
  } catch (err) {
    $.ui.log(`jev-compaction: periodic compaction skipped: ${message(err)}`)
  } finally {
    compacting = false
  }
  return next(e)
}

// Scores part of the backlog ahead of time, so that the compaction at the trigger mostly reuses scores.
async function prescoreSome($: EngineInterface) {
  const key = await resolveKey($)
  if (!key) return
  if (compacting) return
  const messages = await $.session.messages()
  if (messages.length >= TRANSCRIPT_CAP) return
  const { value: memory = {} } = await $.state.get(SCORES)
  const started = Date.now()
  const ask = asker($, key, config.jevTimeoutMs, started, config.jevTotalMs)
  try {
    const { scores, requests } = await prescore(messages, ask, config, memory, { protect: await protection($), maxBatches: config.prescoreBatches, minQuestions: config.prescoreMinQuestions })
    if (Object.keys(scores).length > 0) {
      await remember($, memory, scores)
      await bump($, { requests })
      $.ui.log(`jev-compaction: pre-scored ${Object.keys(scores).length} items in ${requests} request(s)`)
    }
  } catch (err) {
    $.ui.log(`jev-compaction: pre-scoring skipped: ${redact(message(err), key)}`)
  }
}

const ENTRY_CONTEXT =
  'A coding assistant is writing its reply. `history` is the recent conversation, oldest first; the last entry is the text just written (or a note about a tool result just received). Each question asks whether one sentence or one chunk of it carries information the assistant or the user still needs later. What is not kept is deleted permanently.'

// After a failed or timed-out Jev request on entry, entry stops asking for this long.
const ENTRY_PAUSE_MS = 30 * 60_000
let entryPausedUntil = 0

/** One Jev request about the row being written: the recent conversation and the new text as the state. Key and messages are fetched lazily, inside the caller's one timeout. */
function judgeFor($: EngineInterface, role: 'user' | 'assistant', made: { requests: number }): Judge {
  return async (current, questions) => {
    const key = await resolveKey($)
    if (!key) throw new Error('no Jev API key')
    made.requests++
    let recent: { role: string; text: string }[] = []
    let goal = config.goal
    try {
      const all = await $.session.messages()
      recent = all.slice(-6).map((m) => ({ role: m.role, text: truncate(m.text, 500) }))
      goal ||= goalFromMessages(all)
    } catch {
      // the new text alone is a state too
    }
    const history = [...recent, { role, text: truncate(current, 6000) }].map((m, i) => ({ i, ...m }))
    try {
      return await asker($, key, config.entryTimeoutMs, Date.now(), config.entryTimeoutMs)({ context: ENTRY_CONTEXT, goal, history }, questions)
    } catch (err) {
      if (/\((401|403)\)/.test(message(err))) cachedKey = undefined
      throw err
    }
  }
}

/** The input command of the Bash call a result answers, from the stored conversation. */
async function commandOf($: EngineInterface, id: string): Promise<string | undefined> {
  const api = await $.session.messages({ as: 'api' })
  for (let i = api.length - 1; i >= 0; i--) {
    for (const block of api[i]?.content ?? []) {
      if (block.type === 'tool_use' && block['id'] === id) {
        const command = (block['input'] as { command?: unknown } | undefined)?.command
        return typeof command === 'string' ? command : undefined
      }
    }
  }
  return undefined
}

// Rewrites the text of a row before it is stored: the stored form is what the model reads and what is cached, so the
// compression costs no cache miss. One timeout bounds the whole rewrite (key, messages, requests); any failure leaves
// the row as it came and pauses entry Jev for 30 minutes.
async function onAppend($: EngineInterface, e: SessionAppendInput, next: Next<'session.append'>) {
  let rewritten: Awaited<ReturnType<typeof rewriteRow>>
  const made = { requests: 0 }
  if (config.compressOnEntry && e.agentId === undefined) {
    let timer: { cancel: () => void } | undefined
    try {
      const judge = Date.now() < entryPausedUntil ? undefined : judgeFor($, e.message.type === 'assistant' ? 'assistant' : 'user', made)
      let failed = false
      const guarded: Judge | undefined = judge && (async (c, q) => judge(c, q).catch((err: unknown) => {
        if (!/^no Jev API key/.test(message(err))) failed = true
        throw err
      }))
      const late = new Promise<'late'>((resolve) => {
        timer = $.clock.after(config.entryTimeoutMs, () => resolve('late'))
      })
      const work = rewriteRow(e as unknown as EntryRow, guarded, config, (id) => commandOf($, id))
      work.catch(() => undefined)
      const done = await Promise.race([work, late])
      if (done === 'late') entryPausedUntil = Date.now() + ENTRY_PAUSE_MS
      else {
        rewritten = done
        if (failed) entryPausedUntil = Date.now() + ENTRY_PAUSE_MS
      }
    } catch (err) {
      entryPausedUntil = Date.now() + ENTRY_PAUSE_MS
      $.ui.log(`jev-compaction: entry compression skipped: ${redact(message(err), cachedKey)}`)
    } finally {
      timer?.cancel()
    }
  }
  const result = await next(rewritten ? { ...e, message: { ...e.message, content: rewritten.content } } : e)
  if (rewritten || made.requests > 0) await bump($, { entryCharsSaved: rewritten?.saved ?? 0, requests: made.requests }).catch(() => undefined)
  return result
}

async function onCommand($: EngineInterface, args: string) {
  const word = args.trim().split(/\s+/)[0] ?? ''
  if (word === 'stats') {
    const s = { ...NO_STATS, ...(await $.state.get(STATS)).value }
    return {
      text: `jev-compaction: ${s.applied} applied, ${s.deferred} deferred, ${s.fallbacks} built-in fallbacks; ~${s.freedTokens} tokens freed; ${s.requests} Jev requests; ${s.sentencesDropped} sentences dropped, ${s.wordCharsSaved} chars saved by word compression, ${s.entryCharsSaved} chars saved on entry`,
    }
  }
  if (word === 'now') {
    interactive ??= (await $.state.get(INTERACTIVE)).value ?? false
    if (!interactive) return { text: 'jev-compaction: /jev-compact now is not available in a non-interactive (headless) session.' }
    nowPending = true
    return { text: 'jev-compaction: will compact when your next turn ends (the host does not allow it from inside a command).' }
  }
  return { text: 'Usage: /jev-compact now | stats' }
}

export const register: Register = (on, options) => {
  config = resolveConfig(options)
  compacting = isNow = nowPending = false
  interactive = undefined
  prescoreAt = 0
  prescoring = false
  cachedKey = undefined
  entryPausedUntil = 0
  on('session.start', async ($, e, next) => {
    interactive = (e as { isInteractive?: boolean }).isInteractive !== false
    await $.state.set(INTERACTIVE, interactive)
    try {
      await $.command.register({ name: 'jev-compact', description: 'Compact the conversation with Jev (now) or show totals (stats)', argumentHint: 'now | stats' })
    } catch (err) {
      $.ui.log(`jev-compaction: command not registered: ${message(err)}`)
    }
    return next(e)
  })
  on('turn.complete', ($, e, next) => onTurnComplete($, e, next))
  on('session.append', ($, e, next) => onAppend($, e, next))
  on('session.compact', ($, e, next) => onCompact($, e, next))
  on('command.run', { command: 'jev-compact' }, ($, e) => onCommand($, e.args))
}
