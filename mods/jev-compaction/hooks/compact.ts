// Ported from fast-jev-compaction (MIT): batching, decisions and rebuilding, extended to message text.
import { collectToolCalls, estimateTokens, fitState, isPinned, MARKER } from './state'
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
    } else if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.max(0, value)
  }
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

/** Unpinned, unprotected, not-yet-compacted messages whose text is long enough to be judged. */
export function collectTexts(messages: readonly Message[], preserve: number, protect?: Protect): TextCandidate[] {
  const out: TextCandidate[] = []
  messages.forEach((m, index) => {
    if (isPinned(index, messages.length, preserve) || protect?.indexes.has(index) || m.text.includes(MARKER)) return
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
      key: callKey(call),
      thresholds: at,
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    })
    out.push({
      name: `result_${call.id}`,
      key: resultKey(call),
      thresholds: at,
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    })
  }
  for (const t of texts) {
    const text = messages[t.index]?.text ?? ''
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

/** A remembered score is reused unless it lies within the margin of a threshold. */
export function reusable(score: number | undefined, thresholds: readonly number[]): score is number {
  return typeof score === 'number' && thresholds.every((t) => Math.abs(score - t) >= REASK_MARGIN)
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
  if (text.includes(MARKER)) return text
  const omitted = text.length - head - tail
  if (omitted <= ABRIDGE_SLACK) return text
  const signals = signalLines(text.slice(head, text.length - tail))
  const out = `${text.slice(0, head)}\n${signals ? `${signals}\n` : ''}[… ${omitted} chars omitted by jev-compaction …]\n${text.slice(-tail)}`
  return out.length < text.length ? out : text
}

export const SIGNAL_LINES =
  /\b(error|errors|fail|failed|failure|failing|exception|traceback|panic|fatal|denied|refused|warning|warn|assert\w*|expected|received|not found|cannot|unable|segfault|exit code [1-9]|status [45]\d\d)\b/i
export const SIGNAL_MAX_CHARS = 1500

/** Lines of the dropped middle that look like failures, with one line of context either side, in order. */
export function signalLines(middle: string, maxChars = SIGNAL_MAX_CHARS): string {
  const lines = middle.split('\n')
  const keep = new Set<number>()
  lines.forEach((line, i) => {
    if (!SIGNAL_LINES.test(line)) return
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j)
  })
  const out: string[] = []
  let used = 0
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = lines[i] as string
    if (used + line.length + 1 > maxChars) break
    out.push(line)
    used += line.length + 1
  }
  return out.join('\n')
}

export const stubText = (chars: number) => `[earlier assistant message omitted by jev-compaction: ${chars} chars]`

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120 || text.includes(MARKER)) return text
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : ''
  const signals = signalLines(text.slice(headChars))
  const out = `${head}${signals ? `${signals}\n` : ''}[jev-compaction truncated ${text.length - headChars} chars of this tool result${isError ? ' (error)' : ''}; re-run the tool if needed]`
  return out.length < text.length ? out : text
}

function newText(message: Message, action: TextAction | undefined): string {
  if (message.text.includes(MARKER)) return message.text
  if (action === 'stub') return stubText(message.text.length)
  if (action === 'abridge') {
    return message.role === 'user'
      ? abridgeText(message.text, USER_HEAD, USER_TAIL)
      : abridgeText(message.text, ASSISTANT_HEAD, ASSISTANT_TAIL)
  }
  return message.text
}

const droppedNote = (tool: string, input: Record<string, unknown>) => {
  let head = ''
  try {
    head = (JSON.stringify(input) ?? '').slice(0, 80)
  } catch {
    head = '[unserializable input]'
  }
  return `[jev-compaction dropped ${tool} call: ${head}; re-run if needed]`
}

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
): Message[] {
  const out: Message[] = []
  messages.forEach((message, index) => {
    const dropped = (id: string) => tools.get(id) === 'drop_call'
    let text = newText(message, texts.get(index))
    if (text !== message.text && text.length < message.text.length) {
      if (texts.get(index) === 'stub') counts && counts.stubbed++
      else counts && counts.abridged++
    } else text = message.text
    const gone = message.toolUses.filter((t) => dropped(t.tool_use_id))
    if (gone.length > 0) {
      text = [text, ...gone.map((t) => droppedNote(t.tool, t.input))].filter((x) => x !== '').join('\n')
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

/**
 * Asks Jev, for every tool call and every long text outside the pinned first and newest messages,
 * whether it must stay, then rebuilds the transcript. Remembered scores (`memory`) are reused unless
 * near a threshold. Throws when Jev fails or the history cannot be fitted; the caller decides.
 */
export async function compact(
  messages: readonly Message[],
  ask: JevAsker,
  options: Partial<Options> = {},
  memory: Scores = {},
  run: RunOptions = {},
): Promise<CompactResult> {
  const opts = resolveOptions(options)
  const calls = collectToolCalls(messages, opts.preserveRecentMessages, run.protect)
  const texts = collectTexts(messages, opts.preserveRecentMessages, run.protect)
  const questions = questionsFor(calls, texts, messages, opts)
  const scores = new Map<string, number>()
  const fresh: Scores = {}
  const toAsk: Question[] = []
  for (const q of questions) {
    const remembered = memory[q.key]
    if (reusable(remembered, q.thresholds)) scores.set(q.name, remembered)
    else toAsk.push(q)
  }

  let stateTokens = 0
  let stateStage = ''
  let requests = 0
  let abandoned = 0
  if (toAsk.length > 0) {
    const fitted = fitState(messages, calls, opts)
    stateTokens = fitted.tokens
    stateStage = fitted.stage
    // A text the state no longer shows cannot be judged and stays as it is.
    const askable = toAsk.filter((q) => q.textIndex === undefined || fitted.visibleTexts.has(q.textIndex))
    const batches = batchQuestions(askable, fitted.tokens, opts)
    for (let at = 0; at < batches.length; at += MAX_PARALLEL_REQUESTS) {
      if (run.stop?.()) {
        abandoned = batches.slice(at).reduce((n, b) => n + b.length, 0)
        break
      }
      requests += Math.min(MAX_PARALLEL_REQUESTS, batches.length - at)
      const answered = await Promise.all(
        batches.slice(at, at + MAX_PARALLEL_REQUESTS).map((batch) =>
          ask(
            fitted.state,
            Object.fromEntries(batch.map((q) => [q.name, { type: 'noul' as const, instructions: q.instructions }])),
          ),
        ),
      )
      for (const [i, answers] of answered.entries()) {
        for (const q of batches[at + i] ?? []) {
          const p = answers[q.name]
          if (p === undefined) throw new Error(`Invalid Jev answer for ${q.name}`)
          scores.set(q.name, p)
          fresh[q.key] = p
        }
      }
    }
  }

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

  const counts: ApplyCounts = { truncated: 0, dropped: 0, abridged: 0, stubbed: 0 }
  const out = applyDecisions(messages, tools, textActions, opts.truncateHeadChars, counts)
  const candidates = calls.filter((c) => !c.pinned).length
  const stats = {
    toolsKept: candidates - counts.truncated - counts.dropped,
    resultsTruncated: counts.truncated,
    callsDropped: counts.dropped,
    textsKept: texts.length - counts.abridged - counts.stubbed,
    textsAbridged: counts.abridged,
    textsStubbed: counts.stubbed,
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
    reused: questions.length - toAsk.length,
    abandoned,
    ...stats,
  }
  return { messages: out, stats: result, scores: fresh }
}
