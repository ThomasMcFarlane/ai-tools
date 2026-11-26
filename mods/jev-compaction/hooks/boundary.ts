/**
 * Where the newest compaction left the host's rows.
 *
 * `$.session.messages()` is the whole history: the rows from before a compaction stay, and the compaction's output is appended after
 * them. The list a later `/compact` is given starts at that output (Claude Code 2.1.325, measured: an output of 8 rows after 9 old
 * ones, 7 rows later, and the hook was given 15). So the list the next compaction will see is the output, then the rows after it.
 *
 * The output is found in the rows by its content, so the boundary survives a resume and a new process and needs no row count. A
 * descriptor (not the messages) is kept in `$.state`: the count, a key of the first message, and a hash of all of them. A message is
 * told by its role, text and the ids of its tool calls and results: a tool call has no text, so the text alone would match anywhere.
 */
import type { Message } from './types'

export type Boundary =
  | { known: true; count: number; first: string; hash: string }
  /** A compaction ran and its output is not known (the host answered no messages): the list the next one sees cannot be told. */
  | { known: false }

const HEAD_CHARS = 200

/** A 53-bit string hash (cyrb53): no collision worth a thought for the few hundred messages of one output. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

const ids = (m: Message) => [...m.toolUses.map((u) => u.tool_use_id), ...(m.toolResults ?? []).map((r) => r.tool_use_id)].join(',')
/** The first message of an output: cheap to compare, and enough to rule out almost every row. */
const messageKey = (m: Message) => `${m.role}|${m.text.length}|${m.text.slice(0, HEAD_CHARS)}|${ids(m)}`
const sequenceHash = (messages: readonly Message[]) => hash53(messages.map((m) => `${m.role}\u0001${m.text}\u0001${ids(m)}`).join('\u0002'))

/** The descriptor of a compaction's output, as it stands in the rows. */
export function describeOutput(output: readonly Message[]): Boundary {
  const first = output[0]
  if (!first) return { known: false }
  return { known: true, count: output.length, first: messageKey(first), hash: sequenceHash(output) }
}

/**
 * The rows from the newest place where the output stands, or undefined when it stands nowhere (the rows were cut, the host changed
 * the text, or the output is not known).
 */
export function findBoundary(rows: readonly Message[], boundary: Boundary): { from: number; messages: Message[] } | undefined {
  if (!boundary.known) return undefined
  for (let i = rows.length - boundary.count; i >= 0; i--) {
    if (messageKey(rows[i] as Message) !== boundary.first) continue
    if (sequenceHash(rows.slice(i, i + boundary.count)) === boundary.hash) return { from: i, messages: rows.slice(i) as Message[] }
  }
  return undefined
}

/** Every role, text and tool id of the two lists equal: the list the check judged is the list the command was given. */
export function sameList(a: readonly Message[], b: readonly Message[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i]!.role !== b[i]!.role || a[i]!.text !== b[i]!.text || ids(a[i]!) !== ids(b[i]!)) return false
  return true
}

/**
 * `result` with the engine's handles of `list` put back: a message that is the very object of `source[k]` becomes `list[k]`, so the
 * kept messages stay the engine's own (a message without a handle is read as built, and loses its row metadata).
 */
export function withHandles(result: readonly Message[], source: readonly Message[], list: readonly Message[]): Message[] {
  const at = new Map<Message, number>(source.map((m, k) => [m, k]))
  return result.map((m) => {
    const k = at.get(m)
    return k === undefined ? m : (list[k] ?? m)
  })
}
