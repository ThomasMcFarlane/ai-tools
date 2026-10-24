// Ported from fast-jev-compaction (MIT): batching, decisions and rebuilding, extended to message text.
import { collectToolCalls, estimateTokens, fitState, hasNote, isPinned } from './state'
import { SIGNAL_LINES, SIGNAL_MAX_CHARS, SENTENCE_MIN_CHARS, compressWords, dropSegments, pickDrops, planSentences, sentenceQuestion, sentencesNote, signalLines } from './squeeze'
import type { SentencePlan } from './squeeze'
import type {
  CompactResult,
  CompactStats,
  JevAsker,
  Message,
  Options,
  ApplyCounts,
  Protect,
  Question,
  RunOptions,
  Scores,
  TextAction,
  TextCandidate,
  ToolAction,
  ToolCall,
} from './types'

export const DEFAULT_OPTIONS: Options = {
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
}

/** A score this close to a threshold is asked again instead of reused. */
export const REASK_MARGIN = 0.15
export const ASSISTANT_TEXT_MIN = 400
export const ASSISTANT_HEAD = 600
export const ASSISTANT_TAIL = 300
export const USER_HEAD = 1200
export const USER_TAIL = 600
/** An abridge must save at least this much more than its note costs, so it never grows the text. */
const ABRIDGE_SLACK = 200
export const ASSISTANT_ABRIDGE_MIN = ASSISTANT_HEAD + ASSISTANT_TAIL + ABRIDGE_SLACK
export const USER_TEXT_MIN = USER_HEAD + USER_TAIL + ABRIDGE_SLACK
const REQUEST_OVERHEAD_TOKENS = 20
const MAX_PARALLEL_REQUESTS = 4

export function resolveOptions(options: Partial<Options> = {}): Options {
  const out = { ...DEFAULT_OPTIONS }
  for (const key of Object.keys(DEFAULT_OPTIONS) as (keyof Options)[]) {
    const value = options[key]
    if (key === 'goal') {
      if (typeof value === 'string') out.goal = value
    } else if (key === 'textCompression') {
      if (typeof value === 'boolean') out.textCompression = value
    } else if (typeof value === 'number' && Number.isFinite(value)) out[key as Exclude<keyof Options, 'goal' | 'textCompression'>] = Math.max(0, value)
  }
  out.maxSentenceDropRatio = Math.min(1, out.maxSentenceDropRatio)
  out.preserveRecentMessages = Math.floor(out.preserveRecentMessages)
  out.truncateHeadChars = Math.floor(out.truncateHeadChars)
  return out
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** FNV-1a over UTF-16 units, twice with different seeds: a short stable key, not a security hash. */
export function hash(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0
  }
  return a.toString(36) + b.toString(36)
}

export const callKey = (call: Pick<ToolCall, 'tool' | 'input'>) => `c:${call.tool}:${hash(stable(call.input))}`
export const resultKey = (call: Pick<ToolCall, 'tool' | 'input' | 'resultChars'>) => `r:${call.tool}:${hash(stable(call.input))}:${call.resultChars}`
export const textKey = (role: string, text: string) => `t:${role}:${hash(text)}`
export const sentenceKey = (text: string) => `s:${hash(text)}`
/** The text as the compaction will leave it before Jev's cuts: word compression is idempotent, so scores stay valid. */
const prepared = (text: string, options: Pick<Options, 'textCompression'>, role: 'user' | 'assistant' = 'assistant') =>
  options.textCompression ? compressWords(text, { user: role === 'user' }) : text

/** Unpinned, unprotected, not-yet-compacted messages whose text is long enough to be judged. */
export function collectTexts(messages: readonly Message[], preserve: number, protect?: Protect): TextCandidate[] {
  const out: TextCandidate[] = []
  messages.forEach((m, index) => {
    if (isPinned(index, messages.length, preserve) || protect?.indexes.has(index) || (m.role === 'user' && protect?.noUserText) || hasNote(m.text)) return
    if (m.text.length > (m.role === 'assistant' ? ASSISTANT_TEXT_MIN : USER_TEXT_MIN)) out.push({ index, role: m.role, chars: m.text.length })
  })
  return out
}

export function questionsFor(calls: readonly ToolCall[], texts: readonly TextCandidate[], messages: readonly Message[], options: Options): Question[] {
  const out: Question[] = []
  for (const call of calls) {
    if (call.pinned) continue
    const at = [options.keepThreshold]
    out.push({
      name: `call_${call.id}`,
      callId: call.id,
      key: callKey(call),
      thresholds: at,
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    })
    out.push({
      name: `result_${call.id}`,
      callId: call.id,
      key: resultKey(call),
      thresholds: at,
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    })
  }
  for (const t of texts) {
    const text = prepared(messages[t.index]?.text ?? '', options, t.role)
    out.push({
      name: `text_m${t.index}`,
      key: textKey(t.role, text),
      textIndex: t.index,
      thresholds: t.role === 'assistant' ? [options.keepThreshold, options.abridgeThreshold] : [options.keepThreshold],
      instructions:
        t.role === 'assistant'
          ? `The text of the assistant message at history index i=${t.index} (${t.chars} chars) should stay in the history verbatim: the assistant still needs its exact wording, and a shortened version or a one-line stub would not do`
          : `The text of the user message at history index i=${t.index} (${t.chars} chars) should stay in the history verbatim: a shortened version would lose instructions or details the assistant still needs`,
    })
  }
  return out
}

/** Sentence questions of one old assistant message that Jev did not stub: grouped per message, bounded by `planSentences`. */
export function sentenceQuestions(index: number, text: string, threshold: number): { plan: SentencePlan; questions: Question[] } {
  const plan = planSentences(text)
  const questions = plan.ask.map((a) => ({
    name: `sent_m${index}_s${a.segment}`,
    key: sentenceKey(a.text),
    thresholds: [threshold],
    textIndex: index,
    instructions: sentenceQuestion(`the assistant message at history index i=${index}`, a.text),
  }))
  return { plan, questions }
}

/** A remembered score is reused unless it lies within the margin of a threshold. */
export function reusable(score: number | undefined, thresholds: readonly number[], margin = REASK_MARGIN): score is number {
  return typeof score === 'number' && thresholds.every((t) => Math.abs(score - t) >= margin)
}

/** Splits the questions into batches that, with the (always complete) state, fit one request. */
export function batchQuestions(questions: readonly Question[], stateTokens: number, options: Pick<Options, 'maxRequestTokens'>): Question[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS
  const batches: Question[][] = []
  let current: Question[] = []
  let used = 0
  for (const q of questions) {
    const tokens = estimateTokens(JSON.stringify({ [q.name]: { type: 'noul', instructions: q.instructions } }))
    if (current.length > 0 && used + tokens > budget) {
      batches.push(current)
      current = []
      used = 0
    }
    if (current.length === 0 && tokens > budget) throw new Error(`state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`)
    current.push(q)
    used += tokens
  }
  if (current.length > 0) batches.push(current)
  return batches
}

export function decideTool(call: Pick<ToolCall, 'pinned'>, keepCall: number, keepResult: number, keep: number): ToolAction {
  if (call.pinned || keepResult >= keep) return 'keep'
  return keepCall >= keep ? 'drop_result' : 'drop_call'
}

/** Assistant text may be abridged or stubbed; user text is never stubbed, only abridged. */
export function decideText(role: 'user' | 'assistant', p: number, options: Pick<Options, 'keepThreshold' | 'abridgeThreshold'>, chars: number): TextAction {
  if (p >= options.keepThreshold) return 'keep'
  const canAbridge = chars > (role === 'user' ? USER_TEXT_MIN : ASSISTANT_ABRIDGE_MIN)
  if (role === 'user') return canAbridge ? 'abridge' : 'keep'
  if (p >= options.abridgeThreshold) return canAbridge ? 'abridge' : 'keep'
  return 'stub'
}

const MUTATING = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

/** Tools that change state: their calls are never dropped, only their results truncated. */
export const isMutating = (tool: string) => MUTATING.has(tool) || (tool.startsWith('mcp__') && /write|edit|create|delete|update/i.test(tool))

export function abridgeText(text: string, head: number, tail: number): string {
  if (hasNote(text)) return text
  const omitted = text.length - head - tail
  if (omitted <= ABRIDGE_SLACK) return text
  const signals = signalLines(text.slice(head, text.length - tail))
  const out = `${text.slice(0, head)}\n${signals ? `${signals}\n` : ''}[… ${omitted} chars omitted by jev-compaction …]\n${text.slice(-tail)}`
  return out.length < text.length ? out : text
}

export { SIGNAL_LINES, SIGNAL_MAX_CHARS, signalLines }

export const stubText = (chars: number) => `[earlier assistant message omitted by jev-compaction: ${chars} chars]`

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120 || hasNote(text)) return text
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : ''
  const signals = signalLines(text.slice(headChars))
  const out = `${head}${signals ? `${signals}\n` : ''}[jev-compaction truncated ${text.length - headChars} chars of this tool result${isError ? ' (error)' : ''}; re-run the tool if needed]`
  return out.length < text.length ? out : text
}

/** What a compaction may do to text beyond Jev's keep, abridge and stub: word compression and sentence drops. */
export type Shrink = {
  words: boolean
  /** Messages that are pinned or protected. */
  skip: (index: number, role: 'user' | 'assistant') => boolean
  /** Sentence segments to drop per message index, with the segment count they were planned on. */
  drops: ReadonlyMap<number, { count: number; drop: ReadonlySet<number> }>
}

type Rewritten = { text: string; abridged: boolean; stubbed: boolean; sentences: number; wordChars: number }

function rewriteText(message: Message, action: TextAction | undefined, index: number, shrink?: Shrink): Rewritten {
  const noted = hasNote(message.text)
  const out: Rewritten = { text: message.text, abridged: false, stubbed: false, sentences: 0, wordChars: 0 }
  if (action === 'stub' && !noted) return { ...out, text: stubText(message.text.length), stubbed: true }
  let text = message.text
  if (shrink?.words && !shrink.skip(index, message.role)) {
    text = compressWords(text, { user: message.role === 'user' })
    out.wordChars = message.text.length - text.length
  }
  const plan = shrink?.drops.get(index)
  if (plan && !noted) {
    const segments = planSentences(text).segments
    if (segments.length === plan.count) {
      const dropped = dropSegments(segments, plan.drop, sentencesNote)
      text = dropped.text
      out.sentences = dropped.dropped
    }
  }
  if (action === 'abridge' && !noted) {
    const cut = message.role === 'user' ? abridgeText(text, USER_HEAD, USER_TAIL) : abridgeText(text, ASSISTANT_HEAD, ASSISTANT_TAIL)
    out.abridged = cut !== text
    text = cut
  }
  // Never leave an empty message behind: the original stays.
  if (text.trim() === '' && message.text.trim() !== '') return { ...out, text: message.text, abridged: false, sentences: 0, wordChars: 0 }
  return { ...out, text }
}

const HEAD_KEYS = ['file_path', 'pattern', 'path', 'url', 'query', 'prompt', 'description']
const HEAD_CHARS = 80

/** The human-readable start of a call's input: the command of Bash, else the most telling string field, else compact JSON. */
export function noteHead(tool: string, input: Record<string, unknown>): string {
  const field = (key: string) => (typeof input[key] === 'string' && input[key] !== '' ? (input[key] as string) : undefined)
  let raw = field(tool === 'Bash' ? 'command' : '') ?? HEAD_KEYS.map(field).find((x) => x !== undefined)
  if (raw === undefined) {
    try {
      raw = JSON.stringify(input) ?? ''
    } catch {
      raw = '[unserializable input]'
    }
  }
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > HEAD_CHARS ? `${flat.slice(0, HEAD_CHARS)}…` : flat
}

/** Dropped calls behind one note: the count per tool, and the note of a lone call. */
type Tally = { n: number; tools: Map<string, number>; single: string }

function tallyOf(calls: readonly { tool: string; input: Record<string, unknown> }[]): Tally {
  const tools = new Map<string, number>()
  for (const c of calls) tools.set(c.tool, (tools.get(c.tool) ?? 0) + 1)
  const first = calls[0]
  return { n: calls.length, tools, single: first ? `[jev dropped ${first.tool}: ${noteHead(first.tool, first.input)}]` : '' }
}

const tallyNote = (t: Tally) =>
  t.n === 1 ? t.single : `[jev dropped ${t.n} calls: ${[...t.tools].map(([tool, k]) => `${tool} ×${k}`).join(', ')}]`

/**
 * Rebuilds the conversation. A dropped call leaves a one-line note in its assistant message and
 * takes its result with it; a dropped result keeps a bounded head, the failure lines and a note;
 * text is abridged or stubbed. Only messages whose content changes are rebuilt (the assistant-side
 * echo of a result is left alone); the rest, and every unchanged tool block, are the same objects.
 */
export function applyDecisions(
  messages: readonly Message[],
  tools: ReadonlyMap<string, ToolAction>,
  texts: ReadonlyMap<number, TextAction>,
  headChars: number,
  counts?: ApplyCounts,
  shrink?: Shrink,
): Message[] {
  const out: Message[] = []
  // Rebuilt assistant messages that hold nothing but a drop note; runs of them collapse into the first.
  const noteOnly = new Map<Message, Tally>()
  messages.forEach((message, index) => {
    const dropped = (id: string) => tools.get(id) === 'drop_call'
    const rewritten = rewriteText(message, texts.get(index), index, shrink)
    let text = rewritten.text
    if (text !== message.text && text.length < message.text.length) {
      if (counts) {
        if (rewritten.stubbed) counts.stubbed++
        else if (rewritten.abridged) counts.abridged++
        counts.sentences = (counts.sentences ?? 0) + rewritten.sentences
        counts.wordChars = (counts.wordChars ?? 0) + rewritten.wordChars
      }
    } else text = message.text
    const gone = message.toolUses.filter((t) => dropped(t.tool_use_id))
    const tally = gone.length > 0 ? tallyOf(gone) : undefined
    if (tally) {
      text = [text, tallyNote(tally)].filter((x) => x !== '').join('\n')
      if (counts) counts.dropped += gone.length
    }
    const toolUses = message.toolUses.filter((t) => !dropped(t.tool_use_id))
    const toolResults = (message.toolResults ?? [])
      .filter((r) => !dropped(r.tool_use_id))
      .map((r) => {
        if (tools.get(r.tool_use_id) !== 'drop_result') return r
        const cut = truncatedResultText(r.text, r.isError, headChars)
        if (cut === r.text) return r
        if (counts) counts.truncated++
        return { tool_use_id: r.tool_use_id, text: cut, isError: r.isError }
      })
    const unchanged =
      text === message.text &&
      toolUses.length === message.toolUses.length &&
      toolResults.length === (message.toolResults ?? []).length &&
      toolResults.every((r, i) => r === message.toolResults?.[i])
    if (unchanged) {
      out.push(message)
      return
    }
    if (text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) return
    const rebuilt: Message = { role: message.role, text, toolUses }
    if (toolResults.length > 0) rebuilt.toolResults = toolResults
    if (tally && rebuilt.role === 'assistant' && toolUses.length === 0 && toolResults.length === 0 && text === tallyNote(tally)) {
      const prev = out[out.length - 1]
      const run = prev && noteOnly.get(prev)
      if (prev && run) {
        for (const [tool, k] of tally.tools) run.tools.set(tool, (run.tools.get(tool) ?? 0) + k)
        run.n += tally.n
        out[out.length - 1] = { ...prev, text: tallyNote(run) }
        noteOnly.set(out[out.length - 1], run)
        noteOnly.delete(prev)
        return
      }
      noteOnly.set(rebuilt, tally)
    }
    out.push(rebuilt)
  })
  return out
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length
    } catch {
      total += 20
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length
  return total
}

const totalChars = (messages: readonly Message[]) => messages.reduce((sum, m) => sum + messageChars(m), 0)

type Gathered = {
  calls: ToolCall[]
  texts: TextCandidate[]
  questions: Question[]
  scores: Map<string, number>
  fresh: Scores
  /** Sentence plans per message index; their questions are `sent_m<index>_s<segment>`. */
  plans: Map<number, SentencePlan>
  stateTokens: number
  stateStage: string
  requests: number
  abandoned: number
  failed: number
  reused: number
}

/**
 * Asks Jev what has no usable remembered score. A batch that fails or times out is dropped like an abandoned
 * one (its items stay as they are) and the scores of the others are kept; only a run in which every batch
 * failed throws, as nothing was learned. Sentence questions follow the text questions: they are asked about
 * the messages Jev did not stub, so a second phase runs once the text scores are known.
 */
async function gather(messages: readonly Message[], ask: JevAsker, opts: Options, memory: Scores, run: RunOptions): Promise<Gathered> {
  const calls = collectToolCalls(messages, opts.preserveRecentMessages, run.protect)
  const texts = collectTexts(messages, opts.preserveRecentMessages, run.protect)
  const questions = questionsFor(calls, texts, messages, opts)
  const scores = new Map<string, number>()
  const fresh: Scores = {}
  const plans = new Map<number, SentencePlan>()
  const g: Gathered = { calls, texts, questions, scores, fresh, plans, stateTokens: 0, stateStage: '', requests: 0, abandoned: 0, failed: 0, reused: 0 }
  const reuseMargin = run.reuseAll ? 0 : REASK_MARGIN
  const classify = (qs: readonly Question[]) => {
    const toAsk: Question[] = []
    for (const q of qs) {
      const remembered = memory[q.key]
      if (reusable(remembered, q.thresholds, reuseMargin)) {
        scores.set(q.name, remembered)
        g.reused++
      } else toAsk.push(q)
    }
    return toAsk
  }
  // Long assistant messages that are scored and not stubbed get sentence questions (once per message).
  const planned = new Set<number>()
  const sentenceBatch = (): Question[] => {
    const out: Question[] = []
    if (!opts.textCompression) return out
    for (const t of texts) {
      const p = scores.get(`text_m${t.index}`)
      if (t.role !== 'assistant' || planned.has(t.index) || p === undefined || decideText('assistant', p, opts, t.chars) === 'stub') continue
      planned.add(t.index)
      const text = prepared(messages[t.index]?.text ?? '', opts)
      if (text.length <= SENTENCE_MIN_CHARS || hasNote(text)) continue
      const { plan, questions: qs } = sentenceQuestions(t.index, text, opts.sentenceKeepThreshold)
      if (qs.length === 0) continue
      plans.set(t.index, plan)
      out.push(...qs)
    }
    questions.push(...out)
    return out
  }

  const toAsk = classify(questions)
  const sentences = classify(sentenceBatch())
  const pending = [...toAsk, ...sentences]
  if (pending.length === 0) return g
  if (pending.length < (run.minQuestions ?? 0)) return g
  const fitted = fitState(messages, calls, opts)
  g.stateTokens = fitted.tokens
  g.stateStage = fitted.stage
  let firstError: unknown
  let rounds = 0
  let batchesLeft = run.maxBatches ?? Infinity
  const askAll = async (list: readonly Question[]) => {
    // A text the state no longer shows cannot be judged and stays as it is.
    const askable = list.filter((q) => (q.textIndex === undefined || fitted.visibleTexts.has(q.textIndex)) && (q.callId === undefined || fitted.visibleCalls.has(q.callId)))
    const batches = batchQuestions(askable, fitted.tokens, opts).slice(0, batchesLeft)
    batchesLeft -= batches.length
    for (let at = 0; at < batches.length; at += MAX_PARALLEL_REQUESTS) {
      if (rounds > 0 && run.stop?.()) {
        g.abandoned += batches.slice(at).reduce((n, b) => n + b.length, 0)
        break
      }
      rounds++
      const round = batches.slice(at, at + MAX_PARALLEL_REQUESTS)
      g.requests += round.length
      const answered = await Promise.all(
        round.map((batch) =>
          ask(fitted.state, Object.fromEntries(batch.map((q) => [q.name, { type: 'noul' as const, instructions: q.instructions }]))).then(
            (answers) => ({ answers }),
            (error: unknown) => ({ error }),
          ),
        ),
      )
      for (const [i, result] of answered.entries()) {
        const batch = round[i] ?? []
        if ('error' in result) {
          firstError ??= result.error
          g.failed += batch.length
          continue
        }
        for (const q of batch) {
          const p = result.answers[q.name]
          if (p === undefined) {
            firstError ??= new Error(`Invalid Jev answer for ${q.name}`)
            g.failed++
            continue
          }
          scores.set(q.name, p)
          fresh[q.key] = p
        }
      }
    }
  }
  await askAll(pending)
  const later = classify(sentenceBatch())
  if (later.length > 0 && batchesLeft > 0) await askAll(later)
  if (firstError !== undefined && Object.keys(fresh).length === 0) throw firstError
  return g
}

/** Scores up to `maxBatches` unscored candidates and returns what Jev answered, to be remembered; changes nothing. */
export async function prescore(messages: readonly Message[], ask: JevAsker, options: Partial<Options>, memory: Scores, run: RunOptions): Promise<{ scores: Scores; requests: number; pending: number }> {
  const g = await gather(messages, ask, resolveOptions(options), memory, { ...run, reuseAll: true })
  return { scores: g.fresh, requests: g.requests, pending: g.questions.length - g.reused - Object.keys(g.fresh).length }
}

/**
 * Asks Jev, for every tool call and every long text outside the pinned first and newest messages,
 * whether it must stay, then rebuilds the transcript. Remembered scores (`memory`) are reused unless
 * near a threshold. Throws when nothing could be scored or the history cannot be fitted; the caller decides.
 */
export async function compact(
  messages: readonly Message[],
  ask: JevAsker,
  options: Partial<Options> = {},
  memory: Scores = {},
  run: RunOptions = {},
): Promise<CompactResult> {
  const opts = resolveOptions(options)
  const { calls, texts, scores, fresh, plans, stateTokens, stateStage, requests, abandoned, failed, reused } = await gather(messages, ask, opts, memory, run)

  const score = (name: string) => scores.get(name) ?? 1
  const tools = new Map<string, ToolAction>()
  for (const call of calls) {
    if (call.pinned) continue
    let action = decideTool(call, score(`call_${call.id}`), score(`result_${call.id}`), opts.keepThreshold)
    if (action === 'drop_call' && isMutating(call.tool)) action = 'drop_result'
    if (action !== 'keep') tools.set(call.tool_use_id, action)
  }
  const textActions = new Map<number, TextAction>()
  for (const t of texts) {
    const action = decideText(t.role, score(`text_m${t.index}`), opts, t.chars)
    if (action !== 'keep') textActions.set(t.index, action)
  }

  const drops = new Map<number, { count: number; drop: Set<number> }>()
  for (const [index, plan] of plans) {
    const scored = plan.ask.flatMap((a) => {
      const p = scores.get(`sent_m${index}_s${a.segment}`)
      return p === undefined ? [] : [{ segment: a.segment, p }]
    })
    const drop = pickDrops(plan, scored, opts.sentenceKeepThreshold, opts.maxSentenceDropRatio)
    if (drop.size > 0 && textActions.get(index) !== 'stub') drops.set(index, { count: plan.segments.length, drop })
  }
  const skip = (index: number, role: 'user' | 'assistant') =>
    isPinned(index, messages.length, opts.preserveRecentMessages) || run.protect?.indexes.has(index) === true || (role === 'user' && run.protect?.noUserText === true)
  const counts: ApplyCounts = { truncated: 0, dropped: 0, abridged: 0, stubbed: 0, sentences: 0, wordChars: 0 }
  const out = applyDecisions(messages, tools, textActions, opts.truncateHeadChars, counts, { words: opts.textCompression, skip, drops })
  const candidates = calls.filter((c) => !c.pinned).length
  const stats = {
    toolsKept: candidates - counts.truncated - counts.dropped,
    resultsTruncated: counts.truncated,
    callsDropped: counts.dropped,
    textsKept: texts.length - counts.abridged - counts.stubbed,
    textsAbridged: counts.abridged,
    textsStubbed: counts.stubbed,
    sentencesDropped: counts.sentences ?? 0,
    wordCharsSaved: counts.wordChars ?? 0,
  }
  const result: CompactStats = {
    messagesBefore: messages.length,
    messagesAfter: out.length,
    charsBefore: totalChars(messages),
    charsAfter: totalChars(out),
    calls: calls.length,
    pinned: calls.filter((c) => c.pinned).length,
    stateTokens,
    stateStage,
    requests,
    reused,
    abandoned: abandoned + failed,
    failed,
    ...stats,
  }
  return { messages: out, stats: result, scores: fresh }
}
