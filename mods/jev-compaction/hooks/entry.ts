// Compression of a row as it enters the transcript (`session.append`): the stored form is the only one the model
// ever reads, so the rewrite costs no prompt-cache miss. Every step fails open to the text it was given.
import { hasNote } from './state'
import { SENTENCE_MIN_CHARS, chunkQuestion, chunkText, compressWords, dropSegments, joinChunks, pickDrops, planSentences, sentenceQuestion, sentencesNote } from './squeeze'

/** One Jev request about the text being written (`current`): the probability per question name. */
export type Judge = (current: string, questions: Record<string, { type: 'noul'; instructions: string }>) => Promise<Record<string, number>>

export type EntryOptions = {
  keepThreshold: number
  sentenceKeepThreshold: number
  maxSentenceDropRatio: number
  entryUser: boolean
  entryAssistant: boolean
  entryToolResults: boolean
  entryResultMinChars: number
  /** Regular expression source: a Bash command that matches, and is not a reader, has its output trimmed. */
  entryTrimCommands: string
}

/** Finds the input of the tool call a result answers. */
export type CommandOf = (toolUseId: string) => Promise<string | undefined>

export type Block = { type: string; [field: string]: unknown }
export type EntryRow = {
  door: string
  agentId?: string
  message: { type: string; isMeta?: true; content: Block[] }
  origin: { kind: string; tool?: string }
}

export const DEFAULT_TRIM_COMMANDS = String.raw`^(?:(?:npm|pnpm|yarn|bun)\s+(?:test|i|install|ci|add|run\s+(?:build|test|lint))|(?:python3?\s+-m\s+)?pytest(?!.*--collect-only)|pip3?\s+install|go\s+test(?!.*\s-list\b)|cargo\s+(?:build|test)|make(?:\s+-\S+)*(?:\s+(?:build|test|check|lint|install|all|ci))*\s*$|mvn(?:\s+-\S+)*\s+(?:test|verify|package|install|compile)|(?:\./)?gradlew?(?:\s+-\S+)*\s+(?:build|test|check|assemble)|tsc(?!.*--(?:showConfig|listFiles|listEmittedFiles))|(?:npx\s+)?eslint)(?![\w.:/-])`
// Readers and filters: their output is what was asked for, so it is never cut.
const READERS = /^(?:cat|sed|head|tail|git(?:\s+-\S+)*\s+(?:diff|show|log|grep|blame)|rg|grep|find|ls|less|more|nl|awk|jq|bat|cut|sort|uniq|tee)\b/
const FILTERS = /^(?:grep|rg|head|tail|awk|jq|sed|cut|sort|uniq|cat|tee|less)\b/
const HARMLESS = /^(?:cd|export|set)\b/
// Flags that turn a quiet command into a listing, dump or config print: its output is what was asked for.
const LISTING = /--co\b|--collect|--list|--print|--show|--json/

/** Whether the output of this tool call may be trimmed on entry: only Bash running noisy build, test or install commands, plain or chained with cd/export. */
export function trimmable(tool: string, command: string | undefined, allow: string): boolean {
  if (tool !== 'Bash' || !command) return false
  if (/[(`]|\bxargs\b/.test(command) || LISTING.test(command)) return false
  let re: RegExp
  try {
    re = new RegExp(allow || DEFAULT_TRIM_COMMANDS)
  } catch {
    re = new RegExp(DEFAULT_TRIM_COMMANDS)
  }
  const parts = command.split(/&&|\|\||;|\n|(?<![>&|])&(?![&>])/).map((c) => c.trim().replace(/^(?:\w+=\S+\s+)+/, ''))
  let allowed = false
  for (const part of parts) {
    const [first = '', ...later] = part.split(/\|&?/).map((x) => x.trim())
    if (later.some((x) => FILTERS.test(x) || READERS.test(x)) || READERS.test(first)) return false
    const head = first.replace(/\s+\d*[<>]+&?\S*/g, '').trim()
    if (re.test(head)) allowed = true
    else if (!HARMLESS.test(head)) return false
  }
  return allowed
}
const USER_ORIGINS = new Set(['composer', 'bridge'])

const ask = (name: string, instructions: string) => ({ [name]: { type: 'noul' as const, instructions } })

/** Word compression, then Jev's pick of the sentences to drop (one request, only for long text). */
export async function pruneAssistant(text: string, judge: Judge | undefined, options: EntryOptions, user = false): Promise<string> {
  const compressed = compressWords(text, { user })
  if (!judge || compressed.length <= SENTENCE_MIN_CHARS || hasNote(compressed) || /cut on entry …\]/.test(compressed)) return compressed
  const plan = planSentences(compressed)
  if (plan.ask.length === 0) return compressed
  try {
    const questions = Object.assign({}, ...plan.ask.map((a) => ask(`s${a.segment}`, sentenceQuestion('the assistant message just written', a.text))))
    const answers = await judge(compressed, questions)
    const drop = pickDrops(
      plan,
      plan.ask.flatMap((a) => (typeof answers[`s${a.segment}`] === 'number' ? [{ segment: a.segment, p: answers[`s${a.segment}`] as number }] : [])),
      options.sentenceKeepThreshold,
      options.maxSentenceDropRatio,
    )
    if (drop.size === 0) return compressed
    const out = dropSegments(plan.segments, drop, (n) => sentencesNote(n, true)).text
    return out.trim() !== '' && out.length < compressed.length ? out : compressed
  } catch {
    return compressed
  }
}

/** Long tool output: the first and last chunks stay, the middle ones as Jev rates them; failure lines always stay. */
export async function trimResult(text: string, tool: string, judge: Judge | undefined, options: EntryOptions): Promise<string> {
  if (!judge || text.length <= options.entryResultMinChars || hasNote(text)) return text
  const chunks = chunkText(text)
  const questions: Record<string, { type: 'noul'; instructions: string }> = {}
  let at = 0
  chunks.forEach((c, i) => {
    if (!c.forced) Object.assign(questions, ask(`c${i}`, chunkQuestion(tool, at, at + c.text.length, text.length, c.text)))
    at += c.text.length
  })
  if (Object.keys(questions).length === 0) return text
  try {
    const answers = await judge(`[output of ${tool}: ${text.length} chars]`, questions)
    const out = joinChunks(
      chunks,
      chunks.map((_, i) => (answers[`c${i}`] ?? 1) >= options.keepThreshold),
      true,
    )
    return out.length < text.length ? out : text
  } catch {
    return text
  }
}

/** Rewrites a row's text blocks; undefined when nothing changed. */
export async function rewriteRow(row: EntryRow, judge: Judge | undefined, options: EntryOptions, commandOf?: CommandOf): Promise<{ content: Block[]; saved: number } | undefined> {
  if (row.agentId !== undefined) return undefined
  const { message, door, origin } = row
  let change: (text: string) => Promise<string>
  if (door === 'prompt' && message.type === 'user' && !message.isMeta && USER_ORIGINS.has(origin.kind) && options.entryUser) {
    change = async (t) => compressWords(t, { user: true })
  } else if (door === 'response' && message.type === 'assistant' && options.entryAssistant) {
    change = (t) => pruneAssistant(t, judge, options)
  } else if (door === 'tool-result' && options.entryToolResults && origin.tool === 'Bash' && commandOf) {
    change = (t) => trimResult(t, origin.tool ?? 'tool', judge, options)
  } else return undefined
  let saved = 0
  const text = async (t: string) => {
    const out = await change(t)
    if (out.length < t.length && out.trim() !== '') {
      saved += t.length - out.length
      return out
    }
    return t
  }
  const content: Block[] = []
  for (const block of message.content) {
    if (door === 'tool-result' && block.type === 'tool_result') {
      // Small output is never trimmed, so the lookup is not worth making.
      const inner0 = block['content']
      const size = typeof inner0 === 'string' ? inner0.length : Array.isArray(inner0) ? inner0.reduce((n: number, b: unknown) => n + String((b as Block | null)?.['text'] ?? '').length, 0) : 0
      if (size <= options.entryResultMinChars) {
        content.push(block)
        continue
      }
      const command = await commandOf?.(String(block['tool_use_id']))
      if (!trimmable(origin.tool ?? '', command, options.entryTrimCommands)) {
        content.push(block)
        continue
      }
      const inner = block['content']
      if (typeof inner === 'string') content.push({ ...block, content: await text(inner) })
      else if (Array.isArray(inner) && inner.every((b) => (b as Block | null)?.type === 'text')) {
        // One at a time: the Jev cost per row stays bounded and ordered.
        const parts: Block[] = []
        for (const b of inner as Block[]) parts.push({ ...b, text: await text(String(b['text'])) })
        content.push({ ...block, content: parts })
      } else content.push(block)
    } else if (door !== 'tool-result' && block.type === 'text' && typeof block['text'] === 'string') content.push({ ...block, text: await text(block['text']) })
    else content.push(block)
  }
  return saved > 0 ? { content, saved } : undefined
}
