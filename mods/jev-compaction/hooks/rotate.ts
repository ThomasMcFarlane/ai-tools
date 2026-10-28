// Session rotation: the conversation is replaced in place by its first message, one handover message and the newest
// messages, so the session id (and its agents, crons and tasks) survives. Pure functions; register.ts does the I/O.
import type { PromptSubmitInput } from 'claude-code'

import { messageChars } from './compact'
import type { Message } from './types'

export type LedgerEntry = { at: number; text: string }

export type Handover = {
  goal: string
  openTasks: { title: string; state: string; next: string; row: string }[]
  prs: { url: string; state: string }[]
  agents: { id: string; purpose: string; onResult: string }[]
  pendingQuestions: string[]
  decisions: string[]
  paths: string[]
  handoverDir: string
}

export type RotationConfig = { rotateAfterHours: number; rotateHighTurns: number; rotateKeepMessages: number; rotateBudgetTokens: number }

export const MARKER = 'ROTATION HANDOVER'
export const REQUEST_MARKER = 'ROTATION HANDOVER REQUEST'
export const ABRIDGE_OVER = 4000
const HEAD = 2000
const TAIL = 1500
const KEEP_FLOOR = 10
const QUESTION_WINDOW = 50
const RULE = /\b(always|never|don'?t|do not|from now on|must|remember|prefer|instead)\b/i
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g
const SHELL_ID = /\bID: ([A-Za-z0-9_-]+)/g
const FINISHED = /<status>(completed|failed|killed|stopped)<\/status>/

/** The text a prompt adds to the ledger: the person's own (composer or Remote Control bridge), never a meta prompt. */
export function ledgerFromPrompt(e: Pick<PromptSubmitInput, 'text' | 'isMeta' | 'origin'>): string | undefined {
  if (e.isMeta || (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge')) return undefined
  return e.text.trim() === '' ? undefined : e.text
}

/**
 * One transcript jsonl row as a ledger entry: a main-loop user row the person typed. Older rows carry no origin; the
 * transcript spells the composer `human`.
 */
export function ledgerFromRow(line: string): LedgerEntry | undefined {
  let row: { type?: string; isMeta?: boolean; isSidechain?: boolean; isCompactSummary?: boolean; toolUseResult?: unknown; origin?: { kind?: string } | null; timestamp?: string; message?: { content?: unknown } }
  try {
    row = JSON.parse(line)
  } catch {
    return undefined
  }
  if (row?.type !== 'user' || row.isMeta || row.isSidechain || row.isCompactSummary || row.toolUseResult !== undefined) return undefined
  const kind = row.origin?.kind
  if (kind !== undefined && kind !== 'human' && kind !== 'composer' && kind !== 'bridge') return undefined
  const content = row.message?.content
  let text: string
  if (typeof content === 'string') text = content
  else if (Array.isArray(content) && content.every((b) => b?.type === 'text' || b?.type === 'image')) text = content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n')
  else return undefined
  if (text.trim() === '' || /^<(local-command|command-name|command-message)/.test(text.trimStart())) return undefined
  const at = Date.parse(row.timestamp ?? '')
  return { at: Number.isFinite(at) ? at : 0, text }
}

/** Splits streamed text into whole lines: feed each piece, then `end()` for the last line. */
export function lineSplitter(onLine: (line: string) => void) {
  let rest = ''
  return {
    feed(text: string) {
      const parts = (rest + text).split('\n')
      rest = parts.pop() ?? ''
      for (const line of parts) onLine(line)
    },
    end() {
      if (rest) onLine(rest)
      rest = ''
    },
  }
}

/** Due after `rotateAfterHours` since the start or last rotation, or after `rotateHighTurns` turns at the high size. */
export const rotationDue = (now: number, since: number, highTurns: number, c: Pick<RotationConfig, 'rotateAfterHours' | 'rotateHighTurns'>) =>
  now - since >= c.rotateAfterHours * 3_600_000 || highTurns >= c.rotateHighTurns

export const isRule = (text: string) => RULE.test(text)

export const abridge = (text: string, promptsPath: string) =>
  text.length <= ABRIDGE_OVER ? text : `${text.slice(0, HEAD)}\n[… ${text.length - HEAD - TAIL} chars abridged; the full prompt is in ${promptsPath} …]\n${text.slice(-TAIL)}`

/** PROMPTS.md: every ledger prompt verbatim, oldest first. */
export const promptsFile = (ledger: readonly LedgerEntry[]) =>
  `# Prompts\n\nEvery prompt the person sent this session, verbatim, oldest first.\n\n${ledger.map((p) => `## ${new Date(p.at).toISOString()}\n\n${p.text}\n`).join('\n')}`

export function handoffFile(h: Handover): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- none')
  return [
    `# Handover\n\n## Goal\n\n${h.goal}`,
    `## Open tasks\n\n${list(h.openTasks.map((t) => `${t.title} (${t.state}); next: ${t.next}; TASKS.md: ${t.row}`))}`,
    `## Pull requests\n\n${list(h.prs.map((p) => `${p.url} (${p.state})`))}`,
    `## Agents\n\n${list(h.agents.map((a) => `${a.id}: ${a.purpose}; with the result: ${a.onResult}`))}`,
    `## Pending questions\n\n${list(h.pendingQuestions)}`,
    `## Decisions\n\n${list(h.decisions)}`,
    `## Paths\n\n${list(h.paths)}`,
  ].join('\n\n') + '\n'
}

/** Checks the handover tool's input; the reason when it is not usable. */
export function parseHandover(input: Record<string, unknown>): Handover | string {
  const str = (v: unknown) => typeof v === 'string' && v.trim() !== ''
  const arr = (v: unknown, keys: string[]) => Array.isArray(v) && v.every((x) => (keys.length === 0 ? str(x) : x && typeof x === 'object' && keys.every((k) => typeof (x as Record<string, unknown>)[k] === 'string')))
  if (!str(input['goal'])) return 'goal is required'
  if (!arr(input['openTasks'], ['title', 'state', 'next', 'row'])) return 'openTasks must be a list of { title, state, next, row }'
  if (!arr(input['prs'], ['url', 'state'])) return 'prs must be a list of { url, state }'
  if (!arr(input['agents'], ['id', 'purpose', 'onResult'])) return 'agents must be a list of { id, purpose, onResult }'
  for (const k of ['pendingQuestions', 'decisions', 'paths']) if (!arr(input[k], [])) return `${k} must be a list of strings`
  const dir = input['handoverDir']
  if (!str(dir) || !/(^|\/)\.data\/[^/]+\/[^/]+\/scratch\/./.test(dir as string)) return 'handoverDir must be under .data/<org>/<project>/scratch/'
  const h = input as unknown as Handover
  return { goal: h.goal, openTasks: h.openTasks, prs: h.prs, agents: h.agents, pendingQuestions: h.pendingQuestions, decisions: h.decisions, paths: h.paths, handoverDir: h.handoverDir.replace(/\/+$/, '') }
}

/** Ids of background shells and monitors the transcript started and no task notification reported finished. */
export function unfinishedShells(messages: readonly Message[]): string[] {
  const started: string[] = []
  for (const m of messages) {
    for (const u of m.toolUses) {
      if (!(u.tool === 'Monitor' || (u.tool === 'Bash' && u.input['run_in_background'] === true))) continue
      for (const [, id] of String(u.text ?? '').matchAll(SHELL_ID)) if (id && !started.includes(id)) started.push(id)
    }
    for (const r of m.toolResults ?? []) {
      if (!/running in background|Monitor/i.test(r.text)) continue
      for (const [, id] of r.text.matchAll(SHELL_ID)) if (id && !started.includes(id)) started.push(id)
    }
  }
  return started.filter((id) => !messages.some((m) => m.role === 'user' && m.text.includes(`<task-id>${id}</task-id>`) && FINISHED.test(m.text)))
}

/** The last line of each assistant message in the newest 50 that asks a question no later prompt of the person answered. */
export function unansweredQuestions(messages: readonly Message[]): string[] {
  const out: string[] = []
  const from = Math.max(1, messages.length - QUESTION_WINDOW)
  for (let i = from; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role !== 'assistant') continue
    const last = m.text.trim().split('\n').at(-1)?.trim() ?? ''
    if (!last.endsWith('?')) continue
    const answered = messages.slice(i + 1).some((n) => n.role === 'user' && n.text.trim() !== '' && !n.text.includes(REQUEST_MARKER) && !n.text.includes('<task-notification>'))
    if (!answered) out.push(last.slice(0, 300))
  }
  return out
}

/** Where the newest-messages tail starts: `keep` back, moved earlier so no tool_result loses its tool_use; never 0. */
export function tailStart(messages: readonly Message[], keep: number): number {
  let start = Math.max(1, messages.length - keep)
  const usedFrom = (i: number) => new Set(messages.slice(i).flatMap((m) => m.toolUses.map((u) => u.tool_use_id)))
  for (;;) {
    const used = usedFrom(start)
    const orphan = messages.slice(start).some((m) => (m.toolResults ?? []).some((r) => !used.has(r.tool_use_id)))
    if (!orphan || start <= 1) return start
    start--
  }
}

/** The newest messages to keep: `rotateKeepMessages`, fewer (down to 10) while their estimate is over the budget. */
export function chooseTail(messages: readonly Message[], c: Pick<RotationConfig, 'rotateKeepMessages' | 'rotateBudgetTokens'>): number {
  let keep = c.rotateKeepMessages
  let start = tailStart(messages, keep)
  const tokens = (s: number) => messages.slice(s).reduce((n, m) => n + messageChars(m), 0) / 3.5
  while (keep > KEEP_FLOOR && tokens(start) > c.rotateBudgetTokens) {
    keep = Math.max(KEEP_FLOOR, keep - 5)
    start = tailStart(messages, keep)
  }
  return start
}

export type RotationInput = {
  messages: readonly Message[]
  handover: Handover
  handoffPath: string
  promptsPath: string
  /** Prompts sent since the last rotation (all of them before the first). */
  recent: readonly LedgerEntry[]
  /** Standing rules from before the last rotation, verbatim. */
  rules: readonly string[]
  /** Agents still pending, running, waiting or idle. */
  agents: readonly { id: string; description: string; status: string }[]
  shells: readonly string[]
  when: number
  config: Pick<RotationConfig, 'rotateKeepMessages' | 'rotateBudgetTokens'>
}

export type Rotation = { messages: Message[]; text: string; start: number }

/** The rotated conversation: the first message, one built handover message, the newest messages. */
export function buildRotation(r: RotationInput, extra: readonly string[] = []): Rotation {
  const start = chooseTail(r.messages, r.config)
  const list = (items: readonly string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- none')
  const text = [
    `${MARKER} (${new Date(r.when).toISOString()})\n\nThis session was rotated in place: the messages between the first one and the newest ${r.messages.length - start} were replaced by this handover. The full handover is in ${r.handoffPath} and every prompt of the session, verbatim, in ${r.promptsPath}. The rules and prompts below are the person's own words and still apply.`,
    handoffFile(r.handover).replace(/^# Handover\n\n/, ''),
    `## Standing rules (verbatim)\n\n${list(r.rules)}`,
    `## Prompts since the last rotation (verbatim)\n\n${r.recent.length ? r.recent.map((p) => `### ${new Date(p.at).toISOString()}\n\n${abridge(p.text, r.promptsPath)}`).join('\n\n') : 'none'}`,
    `## Live agents\n\n${list(r.agents.map((a) => `${a.id} (${a.status}): ${a.description}`))}`,
    `## Unfinished background shells and monitors\n\n${list(r.shells)}`,
    ...(extra.length ? [`## Added by the verification gate\n\n${list(extra)}`] : []),
  ].join('\n\n')
  const first = r.messages[0]!
  return { messages: [first, { role: 'user', text, toolUses: [] }, ...r.messages.slice(start)], text, start }
}

export type Missing = { item: string; fixable: boolean }

/**
 * The deterministic gate: what the rotation would lose. `promptsText` is PROMPTS.md as read back, undefined when it
 * could not be read. Fixable items can be appended to the handover; the rest cannot.
 */
export function verifyRotation(r: RotationInput, built: Rotation, promptsText: string | undefined, ledger: readonly LedgerEntry[]): Missing[] {
  const missing: Missing[] = []
  const has = (s: string) => built.text.includes(s)
  for (const rule of r.rules) if (!has(rule)) missing.push({ item: rule, fixable: true })
  for (const p of r.recent) {
    if (has(p.text)) continue
    if (p.text.length > ABRIDGE_OVER && has(abridge(p.text, r.promptsPath)) && promptsText?.includes(p.text)) continue
    missing.push({ item: abridge(p.text, r.promptsPath), fixable: true })
  }
  if (promptsText === undefined) missing.push({ item: `${r.promptsPath} could not be read back`, fixable: false })
  else for (const p of ledger) if (!promptsText.includes(p.text)) missing.push({ item: `${r.promptsPath} lacks a prompt of ${new Date(p.at).toISOString()}`, fixable: false })
  for (const a of r.agents) if (!has(a.id)) missing.push({ item: `agent ${a.id} (${a.status}): ${a.description}`, fixable: true })
  for (const s of r.shells) if (!has(s)) missing.push({ item: `background shell ${s}`, fixable: true })
  const dropped = r.messages.slice(1, built.start)
  const urls = new Set(dropped.flatMap((m) => [m.text, ...m.toolUses.map((u) => JSON.stringify(u.input) + (u.text ?? '')), ...(m.toolResults ?? []).map((t) => t.text)].flatMap((t) => t.match(PR_URL) ?? [])))
  for (const url of urls) if (!has(url)) missing.push({ item: `pull request ${url}`, fixable: true })
  for (const q of unansweredQuestions(r.messages)) if (!r.handover.pendingQuestions.some((p) => p.includes(q)) && !has(q)) missing.push({ item: `pending question: ${q}`, fixable: true })
  if (r.handover.goal.trim() === '') missing.push({ item: 'goal is empty', fixable: false })
  if (built.messages[0] !== r.messages[0]) missing.push({ item: 'first message not kept', fixable: false })
  const seen = new Set<string>()
  for (const m of built.messages) {
    for (const t of m.toolResults ?? []) if (!seen.has(t.tool_use_id)) missing.push({ item: `orphan tool_result ${t.tool_use_id}`, fixable: false })
    for (const u of m.toolUses) seen.add(u.tool_use_id)
  }
  return missing
}

/** When the conversation was last rotated, from the handover message a rotation leaves second. */
export function lastRotationOf(messages: readonly Message[]): number | undefined {
  const match = messages[1]?.text.match(/^ROTATION HANDOVER \(([^)]+)\)/)
  const at = match ? Date.parse(match[1]!) : NaN
  return Number.isFinite(at) ? at : undefined
}

/** Rules among the prompts before the last rotation: the regex, or Jev's score of 0.3 or more where it was asked. */
export const standingRules = (older: readonly LedgerEntry[], jev: Readonly<Record<number, number>> = {}) =>
  older.filter((p, i) => isRule(p.text) || (jev[i] ?? 0) >= 0.3).map((p) => p.text)
