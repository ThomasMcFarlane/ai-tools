// Ported from fast-jev-compaction (MIT), extended to judge message text.
import type { Message, Options, Protect, ToolCall } from './types'

/** The notes this mod leaves in cut text; an item that carries one is never judged or cut again. */
const NOTE =
  /\[jev-compaction truncated \d+ chars|\[… \d+ chars omitted by jev-compaction …\]|\[earlier assistant message omitted by jev-compaction:|\[jev-compaction dropped |\[… \d+ sentences? omitted by jev-compaction …\]/
export const hasNote = (text: string) => NOTE.test(text)

export const STATE_CONTEXT =
  'A coding assistant conversation is being compacted to free context. `history` is the conversation so far, oldest first (an entry like `[N messages left out]` stands for messages not shown); tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, the full output of that call, the full text of one message (named by its history index `i`), or one sentence of an assistant message still needs to stay in the history verbatim. Whatever is not kept is deleted or shortened permanently, but the assistant can always re-run a tool or re-read a file.'

type HistoryToolCall = { id: string; tool: string; input: string; result: string }
type HistoryEntry = {
  i: number
  role: 'user' | 'assistant'
  text: string
  tool_calls?: HistoryToolCall[] | string[]
}
export type JevState = { context: string; goal: string; history: HistoryEntry[] }
export type FittedState = {
  state: JevState
  tokens: number
  stage: string
  /** Messages whose text the state still shows, so a question about it can be judged. */
  visibleTexts: Set<number>
  /** Tool calls (`t1`, ...) the state still lists. */
  visibleCalls: Set<string>
}

const INPUT_CHARS = [1000, 200, 60] as const
const TEXT_HEAD = 400
const TEXT_TAIL = 150
const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g

/** Estimates tokens without a tokenizer: a word costs one token per six letters, a digit half, any other symbol nine tenths. */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0)
    if (first >= 48 && first <= 57) tokens += piece.length / 2
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) tokens += 1 + Math.floor((piece.length - 1) / 6)
    else tokens += 0.9
  }
  return Math.ceil(tokens)
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}

export function isPinned(index: number, total: number, preserveRecentMessages: number): boolean {
  return index === 0 || index >= total - preserveRecentMessages
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`; calls without a result are no
 * candidates. A call is pinned (never judged, never touched) when it sits in the first or newest
 * messages, in a message holding non-text content, or already carries a jev-compaction marker.
 */
export function collectToolCalls(messages: readonly Message[], preserve: number, protect?: Protect): ToolCall[] {
  const results = new Map<string, { index: number; chars: number; isError: boolean; marked: boolean }>()
  const guarded = new Set<number>(protect?.indexes)
  messages.forEach((message, index) => {
    for (const r of message.toolResults ?? []) {
      results.set(r.tool_use_id, { index, chars: r.text.length, isError: r.isError, marked: hasNote(r.text) })
      if (protect?.ids.has(r.tool_use_id)) guarded.add(index)
    }
  })
  const calls: ToolCall[] = []
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id)
      if (!found) continue
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.chars,
        isError: found.isError,
        pinned:
          isPinned(callIndex, messages.length, preserve) ||
          isPinned(found.index, messages.length, preserve) ||
          guarded.has(callIndex) ||
          guarded.has(found.index) ||
          found.marked,
      })
    }
  })
  return calls
}

function inputText(input: Record<string, unknown>, limit: number): string {
  let json = ''
  try {
    json = JSON.stringify(input)
  } catch {
    json = '[unserializable input]'
  }
  return truncate(json, limit)
}

const resultNote = (call: ToolCall) => `${call.isError ? 'error' : 'ok'}, ${call.resultChars} chars (omitted)`

function compactCall(call: ToolCall): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => `${key}=${(typeof value === 'string' ? value : inputText({ [key]: value }, 200)).replace(/\s+/g, ' ')}`)
    .join(' ')
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${call.isError ? 'error' : 'ok'} ${call.resultChars}ch`
}

function mergeCallRuns(history: readonly HistoryEntry[], pinned: (e: HistoryEntry) => boolean): HistoryEntry[] {
  const merged: HistoryEntry[] = []
  const foldable = (e: HistoryEntry) => !pinned(e) && e.text.length === 0 && typeof e.tool_calls?.[0] === 'string'
  for (const entry of history) {
    const previous = merged[merged.length - 1]
    if (previous && foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [...(previous.tool_calls as string[]), ...(entry.tool_calls as string[])]
      continue
    }
    merged.push({ ...entry })
  }
  return merged
}

function callsByMessage(calls: readonly ToolCall[]): Map<number, ToolCall[]> {
  const byMessage = new Map<number, ToolCall[]>()
  for (const call of calls) byMessage.set(call.callIndex, [...(byMessage.get(call.callIndex) ?? []), call])
  return byMessage
}

function historyEntries(messages: readonly Message[], calls: readonly ToolCall[], inputChars: number): HistoryEntry[] {
  const byMessage = callsByMessage(calls)
  const entries: HistoryEntry[] = []
  messages.forEach((message, i) => {
    const toolCalls = (byMessage.get(i) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, inputChars),
      result: resultNote(call),
    }))
    if (message.text.trim().length === 0 && toolCalls.length === 0) return
    const entry: HistoryEntry = { i, role: message.role, text: message.text }
    if (toolCalls.length > 0) entry.tool_calls = toolCalls
    entries.push(entry)
  })
  return entries
}

/** The last three user prompts, as the default `goal`. */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter((m) => m.role === 'user' && m.text.trim().length > 0 && (m.toolResults ?? []).length === 0)
    .slice(-3)
    .map((m) => truncate(m.text, 500))
    .join('\n')
}

function abridgeForState(text: string): string {
  if (text.length <= TEXT_HEAD + TEXT_TAIL + 40) return text
  return `${text.slice(0, TEXT_HEAD)}\n[… ${text.length - TEXT_HEAD - TEXT_TAIL} chars omitted …]\n${text.slice(-TEXT_TAIL)}`
}

/**
 * Builds the Jev state from the whole conversation and shrinks it in stages until it fits
 * `maxStateTokens`: tool inputs are truncated, then long texts abridged oldest-first, then old
 * messages collapse to a note, old tool calls shrink to one line, old call-free messages are left
 * out, and runs of call-only messages fold. Throws when even that is too big.
 */
export function fitState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: Pick<Options, 'maxStateTokens' | 'preserveRecentMessages' | 'goal'>,
): FittedState {
  const goal = options.goal || goalFromMessages(messages)
  const stateOf = (history: HistoryEntry[]): JevState => ({ context: STATE_CONTEXT, goal, history })
  const entryTokens = (entry: HistoryEntry) => estimateTokens(JSON.stringify(entry)) + 1
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])))
  const collapsed = new Set<number>()
  const fitted = (history: HistoryEntry[], tokens: number, stage: string): FittedState => ({
    state: stateOf(history),
    tokens,
    stage,
    visibleTexts: new Set(history.filter((e) => e.text.length > 0 && !collapsed.has(e.i)).map((e) => e.i)),
    visibleCalls: new Set(
      history.flatMap((e) => (e.tool_calls ?? []).map((c) => (typeof c === 'string' ? (c.split(' ')[0] ?? '') : c.id))),
    ),
  })

  let history: HistoryEntry[] = []
  let perEntry: number[] = []
  let tokens = 0
  const rebuild = (inputChars: number) => {
    history = historyEntries(messages, calls, inputChars)
    perEntry = history.map(entryTokens)
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0)
  }
  const fits = () => tokens <= options.maxStateTokens
  const shrink = (index: number, change: (entry: HistoryEntry) => void) => {
    const entry = history[index]
    if (!entry) return
    change(entry)
    const now = entryTokens(entry)
    tokens += now - (perEntry[index] ?? 0)
    perEntry[index] = now
  }

  rebuild(INPUT_CHARS[0])
  if (fits()) return fitted(history, tokens, 'full')
  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit)
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`)
  }

  const pinned = (entry: HistoryEntry) => isPinned(entry.i, messages.length, options.preserveRecentMessages)
  const indices = history.map((_, index) => index)
  const order = [...indices.filter((i) => !pinned(history[i]!)), ...indices.filter((i) => pinned(history[i]!))]

  for (const index of order) {
    const entry = history[index]!
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue
    shrink(index, (e) => {
      e.text = abridgeForState(e.text)
    })
    if (fits()) return fitted(history, tokens, 'texts abridged')
  }

  for (const index of order) {
    const entry = history[index]!
    if (pinned(entry) || entry.text.length === 0) continue
    const original = messages[entry.i]?.text.length ?? entry.text.length
    collapsed.add(entry.i)
    shrink(index, (e) => {
      e.text = `[… ${original} chars omitted …]`
    })
    if (fits()) return fitted(history, tokens, 'old messages collapsed')
  }

  const byMessage = callsByMessage(calls)
  for (const index of order) {
    const entry = history[index]!
    const own = byMessage.get(entry.i)
    if (pinned(entry) || !own) continue
    shrink(index, (e) => {
      e.tool_calls = own.map(compactCall)
    })
    if (fits()) return fitted(history, tokens, 'old calls compacted')
  }

  const left = new Set<number>()
  for (const index of order) {
    const entry = history[index]!
    if (pinned(entry) || entry.tool_calls) continue
    left.add(index)
    tokens -= perEntry[index] ?? 0
    if (fits()) {
      return fitted(
        history.filter((_, i) => !left.has(i)),
        tokens,
        'old messages left out',
      )
    }
  }

  history = mergeCallRuns(
    history.filter((_, i) => !left.has(i)),
    pinned,
  )
  perEntry = history.map(entryTokens)
  tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0)
  if (fits()) return fitted(history, tokens, 'old calls merged')

  // Last resort: show the oldest part and the pinned ends only; what is not shown cannot be judged and stays.
  // Folded runs lose their newest call lines one at a time. A placeholder entry says that messages are missing.
  const PLACEHOLDER_TOKENS = 20
  let leftOut = 0
  let firstAt = Infinity
  while (tokens + PLACEHOLDER_TOKENS > options.maxStateTokens) {
    let last = -1
    for (let i = history.length - 1; i >= 0; i--) {
      if (!pinned(history[i]!)) {
        last = i
        break
      }
    }
    if (last < 0) break
    const entry = history[last]!
    const lines = entry.tool_calls
    if (lines && lines.length > 1) {
      const line = (lines as string[]).pop() as string
      tokens -= estimateTokens(line) + 1
      leftOut++
    } else {
      tokens -= perEntry[last] ?? 0
      history.splice(last, 1)
      perEntry.splice(last, 1)
      firstAt = Math.min(firstAt, last)
      leftOut++
    }
  }
  if (tokens + PLACEHOLDER_TOKENS <= options.maxStateTokens) {
    const at = Number.isFinite(firstAt) ? firstAt : history.findIndex((e) => !pinned(e))
    const note: HistoryEntry = { i: history[Math.max(0, at)]?.i ?? 0, role: 'assistant', text: `[${leftOut} messages left out]` }
    history.splice(Math.max(0, at), 0, note)
    tokens += entryTokens(note)
    const result = fitted(history, tokens, 'newest old messages left out')
    result.visibleTexts.delete(note.i)
    for (const e of history) if (e !== note && e.text.length > 0 && !collapsed.has(e.i)) result.visibleTexts.add(e.i)
    return result
  }

  throw new Error(`history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`)
}
