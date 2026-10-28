import type { EngineInterface, Next, Register, SessionAppendInput, SessionCompactInput, SessionCompactResult, TurnCompleteInput } from 'claude-code'

import { compact, prescore } from './compact'
import { rewriteRow } from './entry'
import type { EntryRow, Judge } from './entry'
import { jevAsker } from './jev'
import { DEFAULT_KEY_FILE, keyFromFile, redact } from './key'
import { DEFAULT_RATIO, DEFAULTS, calibrate, estimateAfter, failure, guardAfter, judge, rawFreed, resolveConfig, shouldTrigger, thresholdsFor } from './policy'
import type { Config, Verdict } from './policy'
import { buildRotation, handoffFile, isRule, lastRotationOf, ledgerFromPrompt, ledgerFromRow, lineSplitter, parseHandover, promptsFile, REQUEST_MARKER, rotationDue, standingRules, unfinishedShells, verifyRotation } from './rotate'
import type { LedgerEntry, RotationInput } from './rotate'
import { goalFromMessages, truncate } from './state'
import type { CompactResult, Protect } from './types'

const SCORES = { plugin: 'jev-compaction', key: 'scores' } as const
const STATS = { plugin: 'jev-compaction', key: 'stats' } as const
const INTERACTIVE = { plugin: 'jev-compaction', key: 'interactive' } as const
const GUARD = { plugin: 'jev-compaction', key: 'guard' } as const
const RATIO = { plugin: 'jev-compaction', key: 'ratio' } as const
const LEDGER = { plugin: 'jev-compaction', key: 'ledger' } as const
const ROTATION = { plugin: 'jev-compaction', key: 'rotation' } as const
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
// An applied compaction whose real effect the next turn end measures: the host's tokens before it and the raw estimate.
let measuring: { before: number; raw: number } | undefined

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
  const { value: ratio = DEFAULT_RATIO } = await $.state.get(RATIO)
  const tokensBefore = tokens ?? Math.round(result.stats.charsBefore / 3.5)
  const tokensAfter = estimateAfter(tokensBefore, result.stats.charsBefore, result.stats.charsAfter, ratio)
  // Only a real token count before the compaction can calibrate the ratio.
  const raw = tokens === undefined ? undefined : rawFreed(result.stats.charsBefore, result.stats.charsAfter)
  return { result, tokensBefore, tokensAfter, raw, thresholds: thresholdsFor(config, window) }
}

async function onCompact($: EngineInterface, e: SessionCompactInput, next: Next<'session.compact'>) {
  // The rotation's own compaction, and no other: it applies or skips, and never falls through to the built-in summary.
  if (rotating && e.agentId === undefined && e.trigger !== 'precompute') {
    if (Array.isArray(e.messages)) return onRotate($, e, rotating.dry)
    notify($, 'rotation skipped: the compaction carried no transcript')
    return { skip: 'jev-compaction: rotation skipped, no transcript' }
  }
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
      measuring = done.raw === undefined ? undefined : { before: done.tokensBefore, raw: done.raw }
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
    if (await rotationTurn($, tokens)) return next(e)
    if (tokens !== undefined) {
      const t = thresholdsFor(config, window)
      let { value: guard = 0 } = await $.state.get(GUARD)
      // The first real count after an applied compaction: learn the ratio, and regrow from where it really left the context.
      if (measuring) {
        const { value: ratio = DEFAULT_RATIO } = await $.state.get(RATIO)
        await $.state.set(RATIO, calibrate(ratio, measuring.before, measuring.raw, tokens))
        measuring = undefined
        if (guard > tokens) {
          guard = tokens
          await $.state.set(GUARD, guard)
        }
      }
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
  if (word === 'rotate') {
    if (await isRotationOff($)) return { text: 'jev-compaction: rotation is off in this identity.' }
    interactive ??= (await $.state.get(INTERACTIVE)).value ?? false
    if (!interactive) return { text: 'jev-compaction: /jev-compact rotate is not available in a non-interactive (headless) session.' }
    const rest = args.trim().split(/\s+/).slice(1).join(' ')
    if (rest !== '' && rest.toLowerCase() !== 'dry') return { text: 'Usage: /jev-compact rotate [dry]' }
    return { text: `jev-compaction: ${await startRotation($, rest !== '', false)}` }
  }
  return { text: 'Usage: /jev-compact now | stats | rotate [dry]' }
}

// ---- Session rotation (hooks/rotate.ts holds the pure parts) ----

const HANDOVER_TOOL = 'mcp__jev-compaction__handover'
const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])
// A handover not given within this many main turns of the request is given up on; the next try waits 20 more turns.
const PHASE_TURNS = 2
const RETRY_TURNS = 20
// Jev is asked about this many of the older prompts the rule regex does not match, the newest.
const JEV_RULE_PROMPTS = 60
const RULE_CONTEXT =
  'A long coding session is being rotated: its old messages are replaced by a handover. `history` holds earlier prompts of the person, each by index `i`. Each question asks whether one prompt is a standing instruction (a rule about how to work, a preference, a prohibition) that is still in force, as opposed to a one-off task.'
const HANDOVER_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: 'What the session is working towards now.' },
    openTasks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, state: { type: 'string' }, next: { type: 'string', description: 'The next step.' }, row: { type: 'string', description: 'Its TASKS.md row, or "none".' } }, required: ['title', 'state', 'next', 'row'] } },
    prs: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, state: { type: 'string' } }, required: ['url', 'state'] } },
    agents: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, purpose: { type: 'string' }, onResult: { type: 'string', description: 'What to do with its result.' } }, required: ['id', 'purpose', 'onResult'] } },
    pendingQuestions: { type: 'array', items: { type: 'string' }, description: 'Questions to the person not answered yet.' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions made and still in force.' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Files and folders the work depends on.' },
    handoverDir: { type: 'string', description: 'A new folder under .data/<org>/<project>/scratch/ for HANDOFF.md and PROMPTS.md.' },
  },
  required: ['goal', 'openTasks', 'prs', 'agents', 'pendingQuestions', 'decisions', 'paths', 'handoverDir'],
}

const handoverPrompt = (dry: boolean) =>
  `${REQUEST_MARKER}${dry ? ' (dry run: nothing will be applied)' : ''}\n\njev-compaction is about to rotate this session: the messages between the first one and the newest will be replaced by a handover built from your answer, and what it does not hold is lost. Call the ${HANDOVER_TOOL} tool now, once, and do nothing else this turn. Fill every field from the whole conversation: goal; openTasks (title, state, next step and TASKS.md row of every open task); prs (URL and state of every pull request still relevant); agents (id, purpose and what to do with the result of every background agent still running or idle); pendingQuestions (every question to the person not answered yet); decisions (decisions made and still in force); paths (files and folders the work depends on); handoverDir (a new folder under .data/<org>/<project>/scratch/, such as .data/<org>/<project>/scratch/<YYYYMMDD>-rotation). Be specific.`

// True in the phoenix-court-group identity, where rotation does nothing at all: no ledger, no tool, no trigger.
let rotationOff: boolean | undefined
// Set while the compaction this mod asked for is a rotation.
let rotating: { dry: boolean } | undefined

async function isRotationOff($: EngineInterface): Promise<boolean> {
  rotationOff ??= /(^|\/)phoenix-court-group\/*$/.test((await $.env.get('CLAUDE_CONFIG_DIR')) ?? '')
  return rotationOff
}

const readRotation = async ($: EngineInterface) => ({ turns: 0, highTurns: 0, ...(await $.state.get(ROTATION)).value })

/** The session's transcript jsonl: under the project folder named after the root, else whichever project holds it. */
async function transcriptPath($: EngineInterface): Promise<string | undefined> {
  const base = `${(await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`}`.replace(/\/+$/, '')
  const id = await $.session.id()
  const guess = `${base}/projects/${(await $.session.root()).replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`
  if (await $.fs.exists(guess)) return guess
  for (const d of await $.fs.list(`${base}/projects`)) {
    const path = `${base}/projects/${d.name}/${id}.jsonl`
    if (d.kind === 'dir' && (await $.fs.exists(path))) return path
  }
  return undefined
}

/**
 * The ledger with the prompts sent before it started, read from the transcript. grep streams the file and passes the
 * user rows alone; the transcript can be hundreds of megabytes, far over what `$.fs.read` takes.
 */
async function backfill($: EngineInterface, ledger: LedgerEntry[]): Promise<LedgerEntry[]> {
  const path = await transcriptPath($)
  if (!path) throw new Error('transcript not found')
  const before = ledger[0]?.at ?? Infinity
  const found: LedgerEntry[] = []
  const lines = lineSplitter((line) => {
    const entry = ledgerFromRow(line)
    if (entry && entry.at < before) found.push(entry)
  })
  // -a: a stray binary byte must not turn the output into "Binary file matches".
  const grep = $.process.spawn({ argv: ['grep', '-a', '-F', '"type":"user"', path] })
  for await (const chunk of grep) if (chunk.stream === 'stdout') lines.feed(chunk.text)
  lines.end()
  const { code, signal } = await grep.result
  // grep exits 1 when nothing matched; anything else, or a signal, means the read stopped short.
  if (signal !== null || (code !== 0 && code !== 1)) throw new Error(`grep ended with ${signal ?? `code ${code}`}`)
  return [...found, ...ledger]
}

/**
 * Phase 1: the ledger complete, the handover tool declared, and the prompt asking the model to call it. The host
 * refuses `$.prompt.submit` inside a command, so from `/jev-compact rotate` the prompt goes at the next turn end.
 */
async function startRotation($: EngineInterface, dry: boolean, ask: boolean): Promise<string> {
  const rot = await readRotation($)
  if (rot.phase) return 'a rotation is already waiting for its handover.'
  if (!rot.backfilled) {
    try {
      await $.state.set(LEDGER, await backfill($, (await $.state.get(LEDGER)).value ?? []))
    } catch (err) {
      // Without the older prompts the rotation would lose them: no rotation.
      notify($, `rotation not started: ledger backfill failed: ${message(err)}`)
      await $.state.set(ROTATION, { ...rot, retryAt: rot.turns + RETRY_TURNS })
      return `rotation not started: ledger backfill failed: ${message(err)}`
    }
  }
  await registerHandoverTool($)
  await $.state.set(ROTATION, { ...rot, backfilled: true, phase: { dry, turns: 0, asked: ask }, handover: undefined })
  if (ask) askForHandover($, dry)
  const when = ask ? 'asked for a handover' : 'will ask for a handover when your next turn ends'
  return dry ? `${when}; the dry run writes HANDOFF.preview.md and applies nothing.` : `${when}; the rotation runs when the handover turn ends.`
}

const registerHandoverTool = ($: EngineInterface) =>
  $.tool.register({ name: 'handover', description: 'Write the rotation handover (HANDOFF.md and PROMPTS.md). Call it only when jev-compaction asks for a handover.', inputSchema: HANDOVER_SCHEMA, isDeferred: false })

function askForHandover($: EngineInterface, dry: boolean) {
  void $.prompt.submit({ text: handoverPrompt(dry) }).catch((err: unknown) => $.ui.log(`jev-compaction: handover prompt not sent: ${message(err)}`))
}

/** The handover tool: checks the fields, writes PROMPTS.md (and HANDOFF.md unless a dry run) and keeps the handover. */
async function onHandover($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  if (await isRotationOff($)) return 'error: rotation is off in this identity'
  const h = parseHandover(input)
  if (typeof h === 'string') return `error: ${h}; call the tool again with every field`
  const rot = await readRotation($)
  if (!rot.phase) return 'error: no rotation is waiting for a handover; call this tool only when jev-compaction asks for one'
  const handoffPath = `${h.handoverDir}/HANDOFF.md`
  const promptsPath = `${h.handoverDir}/PROMPTS.md`
  await $.fs.write(promptsPath, promptsFile((await $.state.get(LEDGER)).value ?? []))
  if (!rot.phase?.dry) await $.fs.write(handoffPath, handoffFile(h))
  await $.state.set(ROTATION, { ...rot, handover: { ...h, handoffPath, promptsPath } })
  return rot.phase?.dry ? `Handover saved for a dry run; prompts in ${promptsPath}. Nothing will be applied.` : `Handover saved to ${handoffPath}, prompts to ${promptsPath}. The rotation runs when this turn ends.`
}

/** Jev's probability that each older prompt the regex missed is a standing rule; nothing when Jev cannot be asked. */
async function jevRules($: EngineInterface, older: readonly LedgerEntry[]): Promise<Record<number, number>> {
  const asked = older.map((p, i) => ({ p, i })).filter(({ p }) => !isRule(p.text)).slice(-JEV_RULE_PROMPTS)
  if (asked.length === 0) return {}
  const key = await resolveKey($)
  if (!key) return {}
  const questions = Object.fromEntries(asked.map(({ i }) => [`rule_${i}`, { type: 'noul' as const, instructions: `Is prompt ${i} a standing instruction of the person that is still in force?` }]))
  try {
    const answers = await asker($, key, config.jevTimeoutMs, Date.now(), config.jevTimeoutMs)({ context: RULE_CONTEXT, goal: '', history: asked.map(({ p, i }) => ({ i, role: 'user', text: truncate(p.text, 1000) })) }, questions)
    return Object.fromEntries(asked.map(({ i }) => [i, answers[`rule_${i}`] ?? 0]))
  } catch (err) {
    $.ui.log(`jev-compaction: rule scoring skipped: ${redact(message(err), key)}`)
    return {}
  }
}

/**
 * Whether a list may be the host's newest-4096 cut rather than the whole conversation. `$.session.messages()` is cut
 * at 4096 (then opened on a user message); the compaction's own list is built from every row since the last
 * compaction boundary with no cap in the host's code (Claude Code 2.1.29x), so a longer one is whole. A list just under
 * or at the cap cannot be told apart from a cut one: there the first message and the dropped rows are not known.
 */
export const mayBeCut = (length: number) => length >= TRANSCRIPT_CAP - 96 && length <= TRANSCRIPT_CAP

/** Phase 2: build, verify and apply (or, on a dry run, preview). Never the built-in summary. */
export async function onRotate($: EngineInterface, e: SessionCompactInput, dry: boolean): Promise<SessionCompactResult> {
  try {
    if (mayBeCut(e.messages.length)) throw new Error(`transcript at the ${TRANSCRIPT_CAP}-message cap (${e.messages.length} messages), its first message is not known`)
    const rot = await readRotation($)
    const h = rot.handover
    if (!h) throw new Error('no handover')
    const ledger = (await $.state.get(LEDGER)).value ?? []
    // Never rotated: every prompt counts as since the last rotation (the start time is only for the due timer).
    const since = rot.rotatedAt ?? lastRotationOf(e.messages) ?? 0
    const older = ledger.filter((p) => p.at < since)
    const agents = (await $.agent.list()).filter((a) => LIVE.has(a.status)).map((a) => ({ id: a.id, description: a.description, status: a.status }))
    const input: RotationInput = {
      messages: e.messages,
      handover: h,
      handoffPath: h.handoffPath,
      promptsPath: h.promptsPath,
      recent: ledger.filter((p) => p.at >= since),
      rules: standingRules(older, await jevRules($, older)),
      agents,
      shells: unfinishedShells(e.messages),
      when: await $.clock.now(),
      config,
    }
    const readPrompts = () => $.fs.read(h.promptsPath).then((t) => String(t), () => undefined)
    let built = buildRotation(input)
    let missing = verifyRotation(input, built, await readPrompts(), ledger)
    if (missing.length > 0) {
      // Once: append what can be appended, write PROMPTS.md again, and check again.
      await $.fs.write(h.promptsPath, promptsFile(ledger)).catch(() => undefined)
      built = buildRotation(input, missing.filter((m) => m.fixable).map((m) => m.item))
      missing = verifyRotation(input, built, await readPrompts(), ledger)
    }
    const kept = `keeps the first message, the handover and the newest ${e.messages.length - built.start} of ${e.messages.length} messages`
    const gate = missing.length > 0 ? `gate failed: ${missing.map((m) => m.item.slice(0, 200)).join('; ')}` : `gate passed; ${kept}`
    if (dry) {
      const path = `${h.handoverDir}/HANDOFF.preview.md`
      await $.fs.write(path, `${built.text}\n\n## Dry run\n\n${missing.length > 0 ? `Gate failed:\n\n${missing.map((m) => `- ${m.item}`).join('\n')}` : `Gate passed; ${kept}.`}\n`)
      notify($, `rotation dry run: preview at ${path}; ${missing.length > 0 ? 'gate failed' : 'gate passed'}; nothing applied`)
      return { skip: `jev-compaction: rotation dry run, preview at ${path}` }
    }
    if (missing.length > 0) {
      notify($, `rotation skipped: ${gate}`)
      return { skip: `jev-compaction: rotation skipped, ${gate}` }
    }
    notify($, `rotated: ${kept}; handover in ${h.handoffPath}`)
    return { messages: built.messages }
  } catch (err) {
    notify($, `rotation skipped: ${message(err)}`)
    return { skip: `jev-compaction: rotation skipped, ${message(err)}` }
  }
}

/** The rotation's part of a main turn end; true when it acted, so no periodic compaction runs at the same end. */
async function rotationTurn($: EngineInterface, tokens: number | undefined): Promise<boolean> {
  if (await isRotationOff($)) return false
  const rot = await readRotation($)
  rot.turns++
  if (tokens !== undefined && tokens >= config.rotateHighTokens) rot.highTurns++
  if (rot.phase) {
    if (!rot.phase.asked) {
      askForHandover($, rot.phase.dry)
      rot.phase.asked = true
    } else if (rot.handover) {
      const dry = rot.phase.dry
      rotating = { dry }
      let result: SessionCompactResult | undefined
      try {
        result = await $.session.compact()
      } catch (err) {
        $.ui.log(`jev-compaction: rotation failed: ${message(err)}`)
      } finally {
        rotating = undefined
      }
      const applied = result !== undefined && !result.skip
      if (applied) {
        Object.assign(rot, { rotatedAt: await $.clock.now(), highTurns: 0, retryAt: undefined })
        // Scores of the dropped rows are no use any more.
        await $.state.set(SCORES, {})
      } else if (!dry) rot.retryAt = rot.turns + RETRY_TURNS
      Object.assign(rot, { phase: undefined, handover: undefined })
    } else if (++rot.phase.turns >= PHASE_TURNS) {
      notify($, `rotation skipped: no handover within ${PHASE_TURNS} turns; next try in ${RETRY_TURNS} turns`)
      Object.assign(rot, { phase: undefined, retryAt: rot.turns + RETRY_TURNS })
    }
    await $.state.set(ROTATION, rot)
    return true
  }
  if (config.rotate && rot.rotatedAt === undefined && rot.timerFrom === undefined) {
    // Read once a process: the last rotation (a resumed session's handover message says when), else the start. A list
    // that may be cut holds no handover message second.
    const messages = await $.session.messages()
    rot.timerFrom = (mayBeCut(messages.length) ? undefined : lastRotationOf(messages)) ?? (await $.session.usage()).startedAt
  }
  await $.state.set(ROTATION, rot)
  if (!config.rotate || (rot.retryAt !== undefined && rot.turns < rot.retryAt)) return false
  if (!rotationDue(await $.clock.now(), rot.rotatedAt ?? rot.timerFrom ?? 0, rot.highTurns, config)) return false
  await startRotation($, false, true)
  return true
}

/** The thresholds in force, logged at session start, so a session running on the defaults shows. */
const activeThresholds = (c: Config) =>
  `thresholds: trigger ${c.triggerTokens}, target ${c.targetTokens}, hard limit ${c.hardTokens}, periodic minimum ${c.softMinFreedTokens}, regrowth ${c.regrowTokens} (windows up to 300k: ${c.triggerPercent}/${c.targetPercent}/${c.hardPercent}%)`

export const register: Register = (on, options) => {
  config = resolveConfig(options)
  compacting = isNow = nowPending = false
  interactive = undefined
  prescoreAt = 0
  prescoring = false
  measuring = undefined
  cachedKey = undefined
  entryPausedUntil = 0
  rotationOff = undefined
  rotating = undefined
  on('session.start', async ($, e, next) => {
    interactive = (e as { isInteractive?: boolean }).isInteractive !== false
    await $.state.set(INTERACTIVE, interactive)
    $.ui.log(`jev-compaction: ${activeThresholds(config)}`)
    try {
      await $.command.register({ name: 'jev-compact', description: 'Compact the conversation with Jev (now), show totals (stats), or rotate the session (rotate [dry])', argumentHint: 'now | stats | rotate [dry]' })
    } catch (err) {
      $.ui.log(`jev-compaction: command not registered: ${message(err)}`)
    }
    // A reload or a resume drops the tool: declare it again while a rotation waits for its handover.
    try {
      if (!(await isRotationOff($)) && (await readRotation($)).phase) await registerHandoverTool($)
    } catch (err) {
      $.ui.log(`jev-compaction: handover tool not registered: ${message(err)}`)
    }
    return next(e)
  })
  on('turn.complete', ($, e, next) => onTurnComplete($, e, next))
  on('session.append', ($, e, next) => onAppend($, e, next))
  on('session.compact', ($, e, next) => onCompact($, e, next))
  on('command.run', { command: 'jev-compact' }, ($, e) => onCommand($, e.args))
  on('prompt.submit', async ($, e, next) => {
    const text = ledgerFromPrompt(e)
    if (text !== undefined) {
      try {
        if (!(await isRotationOff($))) {
          const { value = [] } = await $.state.get(LEDGER)
          // shortcut: the ledger grows for the session's life in $.state; cap it if a session's prompts reach megabytes.
          await $.state.set(LEDGER, [...value, { at: await $.clock.now(), text }])
        }
      } catch (err) {
        $.ui.log(`jev-compaction: prompt not recorded: ${message(err)}`)
      }
    }
    return next(e)
  })
  on('tool.call', { tool: HANDOVER_TOOL }, async ($, e) => {
    try {
      return { result: await onHandover($, e as unknown as Record<string, unknown>) }
    } catch (err) {
      return { result: `error: ${message(err)}` }
    }
  })
}
