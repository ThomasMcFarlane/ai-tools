import { expect, mock, test } from 'claude-code/testing'

import { onRotate } from './register'
import type { Message } from './types'

const TOOL = 'mcp__jev-compaction__handover'
const DIR = '/home/Storage/Projects/repositories/.data/acme/app/scratch/20261028-rotation'
const PR = 'https://github.com/acme/app/pull/42'
const HOUR = 3_600_000

// The transcript jsonl rows a backfill reads: two typed prompts, then rows that are not the person's.
const FIXTURE = [
  { type: 'user', timestamp: '2026-10-01T10:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: 'Always write British English.' } },
  { type: 'user', timestamp: '2026-10-01T11:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Build the importer.' }] } },
  { type: 'user', timestamp: '2026-10-01T11:01:00.000Z', isMeta: true, message: { role: 'user', content: 'meta row' } },
  { type: 'user', timestamp: '2026-10-01T11:02:00.000Z', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>x</task-notification>' } },
  { type: 'user', timestamp: '2026-10-01T11:03:00.000Z', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }] } },
  { type: 'user', timestamp: '2026-10-01T11:04:00.000Z', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } },
]
  .map((r) => JSON.stringify(r))
  .join('\n')

/** First message, 60 rows with a background shell, a PR link and tool pairs, then an unanswered question at the end. */
function conversation(): Message[] {
  const out: Message[] = [{ role: 'user', text: 'start', toolUses: [], handle: 'h0' }]
  out.push({ role: 'assistant', text: `Opened ${PR}.`, toolUses: [{ tool_use_id: 'bg', tool: 'Bash', input: { command: 'make watch', run_in_background: true }, text: 'Command running in background with ID: shell7' }], handle: 'a-bg' })
  out.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'bg', text: 'Command running in background with ID: shell7', isError: false }], handle: 'u-bg' })
  for (let i = 0; i < 30; i++) {
    out.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `c${i}`, tool: 'Read', input: { file_path: `/src/f${i}.ts` }, text: 'x'.repeat(100) }], handle: `a${i}` })
    out.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `c${i}`, text: 'x'.repeat(100), isError: false }], handle: `u${i}` })
  }
  out.push({ role: 'assistant', text: 'Done.\nShall I merge it?', toolUses: [], handle: 'q' })
  return out
}

const fields = (extra: Record<string, unknown> = {}) => ({
  tool: TOOL,
  goal: 'Ship the importer',
  openTasks: [{ title: 'Importer', state: 'in review', next: 'merge', row: '3.1' }],
  prs: [{ url: PR, state: 'open' }],
  agents: [{ id: 'agent-1', purpose: 'runs the e2e suite', onResult: 'report failures' }],
  pendingQuestions: ['Shall I merge it?'],
  decisions: ['Use streaming parsing'],
  paths: ['/work/src/importer.ts'],
  handoverDir: DIR,
  ...extra,
})

type Setup = { env?: Record<string, string>; agents?: { id: string; description: string; status: string; type: string }[]; dropWrites?: RegExp; now?: number; grepEnd?: { code: number | null; signal: string | null } }

async function boot($: any, on: any, setup: Setup = {}) {
  const files: Record<string, string> = {}
  const toasts: string[] = []
  const submitted: string[] = []
  const registered: string[] = []
  const spawned: string[][] = []
  const compactCalls: any[] = []
  const messages = conversation()
  // The plugin's $.state, held here so the phase-2 handler called by the test (whose $ has no state) reads it too.
  for (const key of Object.keys(state)) delete state[key]
  on('state.get', (_$: any, e: any) => ({ value: { value: state[`${e.plugin}/${e.key}`], version: 0 } as never }))
  on('state.set', (_$: any, e: any) => {
    state[`${e.plugin}/${e.key}`] = JSON.parse(JSON.stringify(e.value))
    return { value: { isSet: true, version: 1 } as never }
  })
  mock.env(on, setup.env ?? { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/home/u/.claude/identities/swap' })
  const clock = mock.clock(on, { now: setup.now ?? Date.parse('2026-10-28T12:00:00.000Z') })
  const startedAt = clock.now()
  on('session.usage', () => ({ value: { startedAt, context: { tokens: 100_000, window: 1_000_000 }, rateLimits: [] } }))
  on('session.messages', () => ({ value: messages as never }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: '/work/app' }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path === '/home/u/.claude/identities/swap/projects/-work-app/sess-1.jsonl' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: any, e: any) => {
    if (files[e.path] === undefined) throw new Error('ENOENT')
    return { value: files[e.path] }
  })
  on('fs.write', (_$: any, e: any) => {
    if (!setup.dropWrites?.test(e.path)) files[e.path] = e.text
    return { value: undefined }
  })
  on('process.spawn', async function* (_$: any, e: any) {
    spawned.push(e.argv)
    // Pieces that cut rows in the middle, as a pipe does.
    for (let i = 0; i < FIXTURE.length; i += 97) yield { stream: 'stdout', text: FIXTURE.slice(i, i + 97) }
    return { value: setup.grepEnd ?? { code: 0, signal: null } }
  })
  on('agent.list', () => ({ value: (setup.agents ?? [{ id: 'agent-1', description: 'e2e suite', status: 'running', type: 'general-purpose' }]) as never }))
  on('tool.register', (_$: any, e: any) => {
    registered.push(e.name)
    return { value: { tool: `mcp__jev-compaction__${e.name}` } }
  })
  on('prompt.submit', (_$: any, e: any) => {
    if (e.origin?.kind === 'plugin') submitted.push(e.text)
    return { text: e.text }
  })
  on('session.compact', (_$: any, e: any) => {
    compactCalls.push(e)
    return { messages: [{ role: 'user', text: 'BUILTIN SUMMARY', toolUses: [] }] }
  })
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$: any, e: any) => {
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined as never }))
  on('session.start', () => ({ cwd: '/work' }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
  const agents = setup.agents ?? [{ id: 'agent-1', description: 'e2e suite', status: 'running', type: 'general-purpose' }]
  return { files, toasts, submitted, registered, spawned, compactCalls, messages, clock, agents, dropWrites: setup.dropWrites }
}

const user = (text: string): Message => ({ role: 'user', text, toolUses: [] })
const reply = () => ({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' }) as never
const say = ($: any, text: string, origin: Record<string, unknown> = { kind: 'composer' }, isMeta?: true) => $.prompt.submit({ text, origin, wait: false, ...(isMeta ? { isMeta } : {}) } as never)
const command = ($: any, args: string) => $.command.run({ command: 'jev-compact', args } as never) as Promise<{ text: string }>
// The rotation's compaction as the engine raises it with the transcript. The test kit raises the mod's own
// $.session.compact() with no transcript, so the phase-2 handler is called directly, over the state the mod wrote.
// The phase-2 handler, called as the engine would with the transcript (the test kit raises the mod's own
// $.session.compact() with none). The test's $ lacks the plugin's nouns, so it gets one over the same files and state.
const notes: string[] = []
const state: Record<string, unknown> = {}
type Booted = Awaited<ReturnType<typeof boot>>
const rotate = (b: Booted, messages: Message[], dry = false) => {
  notes.length = 0
  const $ = {
    state: { get: async (ref: { plugin: string; key: string }) => ({ value: state[`${ref.plugin}/${ref.key}`], version: 0 }) },
    agent: { list: async () => b.agents },
    clock: { now: async () => b.clock.now() },
    fs: {
      read: async (path: string) => {
        if (b.files[path] === undefined) throw new Error('ENOENT')
        return b.files[path]
      },
      write: async (path: string, text: string) => {
        if (!b.dropWrites?.test(path)) b.files[path] = text
      },
    },
    ui: { log: (text: string) => notes.push(text), toast: (text: string) => notes.push(text) },
  }
  return onRotate($ as never, { trigger: 'plugin', messages } as never, dry) as Promise<{ messages?: Message[]; skip?: string }>
}

test('the ledger keeps composer and bridge prompts only, never meta or other origins', async ($, on) => {
  const { files } = await boot($, on)
  await say($, 'Never push without asking.')
  await say($, 'from the phone', { kind: 'bridge' })
  await say($, 'a peer message', { kind: 'peer' })
  await say($, 'a plugin prompt', { kind: 'plugin', name: 'x' })
  await say($, 'hidden', { kind: 'composer' }, true)
  await command($, 'rotate dry')
  await $.turn.complete(reply())
  await $.tool.call(fields() as never)
  const prompts = files[`${DIR}/PROMPTS.md`]!
  expect(prompts).toContain('Never push without asking.')
  expect(prompts).toContain('from the phone')
  for (const not of ['a peer message', 'a plugin prompt', 'hidden', 'meta row', 'subagent prompt', '<task-notification>']) expect(prompts).not.toContain(not)
})

test('backfill streams the transcript through grep and adds the older typed prompts, oldest first', async ($, on) => {
  const { files, spawned } = await boot($, on)
  await say($, 'A prompt after install.')
  await command($, 'rotate dry')
  expect(spawned).toEqual([['grep', '-a', '-F', '"type":"user"', '/home/u/.claude/identities/swap/projects/-work-app/sess-1.jsonl']])
  await $.turn.complete(reply())
  await $.tool.call(fields() as never)
  const prompts = files[`${DIR}/PROMPTS.md`]!
  const order = ['Always write British English.', 'Build the importer.', 'A prompt after install.'].map((t) => prompts.indexOf(t))
  expect(order.every((at) => at >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  // A second rotation does not read the transcript again.
  await command($, 'rotate dry')
  expect(spawned.length).toBe(1)
})

test('the automatic trigger is off by default: 72 hours and 100 high turns rotate nothing', async ($, on) => {
  const { submitted, clock } = await boot($, on)
  await clock.advance(80 * HOUR)
  await $.turn.complete(reply())
  expect(submitted).toEqual([])
})

test('trigger: with rotate on, a session is rotated after 72 hours, not before', { options: { rotate: true } }, async ($, on) => {
  const { submitted, registered, clock } = await boot($, on)
  await $.turn.complete(reply())
  await clock.advance(71 * HOUR)
  await $.turn.complete(reply())
  expect(submitted).toEqual([])
  await clock.advance(1 * HOUR)
  await $.turn.complete(reply())
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('ROTATION HANDOVER REQUEST')
  expect(registered).toEqual(['handover'])
})

test('trigger: with rotate on, 3 turns at the high size rotate when rotateHighTurns is 3', { options: { rotate: true, rotateHighTurns: 3, rotateHighTokens: 50_000 } }, async ($, on) => {
  const { submitted } = await boot($, on)
  await $.turn.complete(reply())
  await $.turn.complete(reply())
  expect(submitted).toEqual([])
  await $.turn.complete(reply())
  expect(submitted.length).toBe(1)
})

test('dry run: writes HANDOFF.preview.md and PROMPTS.md, applies nothing, and the gate passes', async ($, on) => {
  const b = await boot($, on)
  const { files, compactCalls, messages, toasts } = b
  await say($, 'Remember to run the linter.')
  expect((await command($, 'rotate dry')).text).toContain('applies nothing')
  await $.turn.complete(reply())
  expect((await $.tool.call(fields() as never)).result).toContain('dry run')
  expect(files[`${DIR}/HANDOFF.md`]).toBeUndefined()
  const r = await rotate(b, messages, true)
  expect(r.messages).toBeUndefined()
  expect(r.skip).toContain('dry run')
  const preview = files[`${DIR}/HANDOFF.preview.md`]!
  expect(preview).toStartWith('ROTATION HANDOVER (')
  expect(preview).toContain('This is a dry-run preview: it is the handover')
  expect(preview).not.toContain('The full handover is in')
  expect(preview).toContain('Gate passed')
  expect(preview).toContain('Remember to run the linter.')
  // A backfilled rule from before install, and the unfinished background shell.
  expect(preview).toContain('Always write British English.')
  expect(preview).toContain('shell7')
  expect(compactCalls).toEqual([])
  expect(notes.join('\n')).toContain('nothing applied')
})

test('the turn end runs the rotation compaction once the handover is in, and never reaches the built-in summary', async ($, on) => {
  const { compactCalls, toasts, submitted } = await boot($, on)
  expect((await command($, 'rotate')).text).toContain('next turn ends')
  expect(submitted).toEqual([])
  await $.turn.complete(reply())
  expect(submitted.length).toBe(1)
  await $.tool.call(fields() as never)
  // The kit raises the compaction without a transcript: the rotation skips rather than fall through.
  await $.turn.complete(reply())
  expect(compactCalls).toEqual([])
  expect(toasts.join('\n')).toContain('rotation skipped')
  // The phase is over: a later plugin compaction is an ordinary one again.
  await $.turn.complete(reply())
  expect(submitted.length).toBe(1)
})

test('manual rotation: keeps the first message with its handle, one handover message and the newest messages, no orphan tool_result', async ($, on) => {
  const b = await boot($, on)
  const { files, messages, compactCalls } = b
  await say($, 'Remember to run the linter.')
  await command($, 'rotate')
  await $.turn.complete(reply())
  await $.tool.call(fields() as never)
  expect(files[`${DIR}/HANDOFF.md`]).toContain('Ship the importer')
  const out = (await rotate(b, messages)).messages!
  expect(compactCalls).toEqual([])
  expect(out[0]!.handle).toBe('h0')
  expect(out[1]!.handle).toBeUndefined()
  expect(out[1]!.text).toStartWith('ROTATION HANDOVER (')
  expect(out[1]!.text).toContain('Remember to run the linter.')
  expect(out.filter((m) => m.text.startsWith('ROTATION HANDOVER')).length).toBe(1)
  const seen = new Set<string>()
  for (const m of out) {
    for (const r of m.toolResults ?? []) expect(seen.has(r.tool_use_id)).toBe(true)
    for (const u of m.toolUses) seen.add(u.tool_use_id)
  }
  expect(out.at(-1)!.handle).toBe('q')
  expect(out.length).toBeLessThan(messages.length)
})

test('gate: missing agents, PRs and questions are appended once and the rotation applies', async ($, on) => {
  const b = await boot($, on, { agents: [{ id: 'agent-9', description: 'late agent', status: 'idle', type: 'Explore' }] })
  const { messages } = b
  await command($, 'rotate')
  await $.turn.complete(reply())
  await $.tool.call(fields({ prs: [], agents: [], pendingQuestions: [] }) as never)
  const text = (await rotate(b, messages)).messages![1]!.text
  expect(text).toContain('Added by the verification gate')
  for (const s of ['agent-9', PR, 'Shall I merge it?']) expect(text).toContain(s)
})

test('gate failure: PROMPTS.md that cannot be written skips the rotation and never runs the built-in summary', async ($, on) => {
  const b = await boot($, on, { dropWrites: /PROMPTS\.md$/ })
  const { messages, toasts, files, compactCalls } = b
  await command($, 'rotate')
  await $.turn.complete(reply())
  await $.tool.call(fields() as never)
  const result = await rotate(b, messages)
  expect(compactCalls).toEqual([])
  expect(result.skip).toMatch(/rotation skipped, gate failed/)
  expect(result.messages).toBeUndefined()
  expect(notes.join('\n')).toMatch(/rotation skipped/)
  expect(files[`${DIR}/HANDOFF.md`]).toBeDefined()
})

test('a handover tool call with a missing field or a folder outside .data scratch is refused', async ($, on) => {
  await boot($, on)
  await command($, 'rotate')
  await $.turn.complete(reply())
  expect((await $.tool.call(fields({ goal: '' }) as never)).result).toMatch(/^error: goal is required/)
  for (const dir of ['/tmp/x', '.data/acme/app/scratch/r', `${DIR}/../../../../x`, '/home/Storage/Projects/repositories/.data/acme/app/notes/r']) {
    expect((await $.tool.call(fields({ handoverDir: dir }) as never)).result).toMatch(/^error: handoverDir must be an absolute folder under/)
  }
})

test('phase timeout: no handover within 2 turns skips the rotation, compacts nothing, and waits 20 turns', { options: { rotate: true, rotateHighTurns: 1, rotateHighTokens: 1 } }, async ($, on) => {
  const { submitted, toasts, compactCalls } = await boot($, on)
  await $.turn.complete(reply())
  expect(submitted.length).toBe(1)
  await $.turn.complete(reply())
  await $.turn.complete(reply())
  expect(toasts.join('\n')).toContain('no handover within 2 turns')
  expect(compactCalls).toEqual([])
  for (let i = 0; i < 19; i++) await $.turn.complete(reply())
  expect(submitted.length).toBe(1)
  await $.turn.complete(reply())
  expect(submitted.length).toBe(2)
})

test('phoenix-court-group: rotation is a hard no-op', { options: { rotate: true, rotateHighTurns: 1, rotateHighTokens: 1 } }, async ($, on) => {
  const { submitted, spawned, registered, files } = await boot($, on, { env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/home/u/.claude/identities/phoenix-court-group' } })
  await say($, 'Never do that.')
  await $.turn.complete(reply())
  await $.turn.complete(reply())
  expect((await command($, 'rotate dry')).text).toContain('off in this identity')
  expect((await $.tool.call(fields() as never)).result).toContain('off in this identity')
  expect(submitted).toEqual([])
  expect(spawned).toEqual([])
  expect(registered).toEqual([])
  expect(Object.keys(files)).toEqual([])
})


test('a handover tool call with no rotation waiting, or before the handover was asked for, is refused and writes nothing', async ($, on) => {
  const { files } = await boot($, on)
  expect((await $.tool.call(fields() as never)).result).toMatch(/^error: no rotation is waiting/)
  // /jev-compact rotate asks at the next turn end: a call before that is a turn early.
  await command($, 'rotate dry')
  expect((await $.tool.call(fields() as never)).result).toMatch(/^error: no rotation is waiting/)
  expect(Object.keys(files)).toEqual([])
  await $.turn.complete(reply())
  expect((await $.tool.call(fields() as never)).result).toContain('dry run')
})

test('a first message holding only an orphan tool_result (left by a host compaction) does not block the rotation', async ($, on) => {
  const b = await boot($, on)
  const orphanFirst: Message = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'gone', text: 'old output', isError: false }], handle: 'h0' }
  const messages = [orphanFirst, ...b.messages.slice(1)]
  await command($, 'rotate')
  await $.turn.complete(reply())
  await $.tool.call(fields() as never)
  const out = (await rotate(b, messages)).messages!
  expect(out[0]!.handle).toBe('h0')
  expect(out[0]!.toolResults ?? []).toEqual([])
  expect(out[0]!.text).toContain('removed a tool result')
  expect(out[1]!.text).toStartWith('ROTATION HANDOVER (')
})

test('/jev-compact rotate takes nothing or dry (any case); anything else is a usage error and starts nothing', async ($, on) => {
  const { spawned } = await boot($, on)
  for (const args of ['rotate now', 'rotate dry run', 'rotate --force']) expect((await command($, args)).text).toBe('Usage: /jev-compact rotate [dry]')
  expect(spawned).toEqual([])
  expect((await $.tool.call(fields() as never)).result).toMatch(/^error: no rotation is waiting/)
  expect((await command($, 'rotate DRY')).text).toContain('applies nothing')
})

test('backfill: grep ending in an error or a signal stops the rotation; -a reads the file as text', async ($, on) => {
  const { spawned, toasts } = await boot($, on, { grepEnd: { code: 2, signal: null } })
  expect((await command($, 'rotate')).text).toContain('ledger backfill failed: grep ended with code 2')
  expect(spawned[0]!.slice(0, 3)).toEqual(['grep', '-a', '-F'])
  expect(toasts.join('\n')).toContain('rotation not started')
  expect((await $.tool.call(fields() as never)).result).toMatch(/^error: no rotation is waiting/)
})

test('a session that never rotated counts every ledger prompt as recent, also those from before its start', async ($, on) => {
  const b = await boot($, on)
  const { files, messages } = b
  await command($, 'rotate dry')
  await $.turn.complete(reply())
  await $.tool.call(fields() as never)
  await rotate(b, messages, true)
  const recent = files[`${DIR}/HANDOFF.preview.md`]!.split('## Prompts since the last rotation (verbatim)')[1]!
  // From 1 October, before this process started on 28 October, and no rule: only the recent list holds it.
  expect(recent).toContain('Build the importer.')
})

test('only the rotation\'s own compaction rotates: another plugin compaction with the handover in is an ordinary one', async ($, on) => {
  const { messages } = await boot($, on)
  await command($, 'rotate')
  await $.turn.complete(reply())
  await $.tool.call(fields() as never)
  const r = (await $.session.compact({ trigger: 'plugin', messages } as never)) as { messages?: Message[]; skip?: string }
  expect(r.skip ?? '').not.toMatch(/rotation/)
  expect((r.messages ?? []).some((m) => m.text.startsWith('ROTATION HANDOVER'))).toBe(false)
})

test('a session start while a rotation waits declares the handover tool again', async ($, on) => {
  const { registered } = await boot($, on)
  await command($, 'rotate')
  expect(registered).toEqual(['handover'])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
  expect(registered).toEqual(['handover', 'handover'])
})

test('a dropped typed prompt the ledger never saw fails the gate; one the ledger holds does not', async ($, on) => {
  const b = await boot($, on)
  const { messages, toasts } = b
  await say($, 'Never push without asking.')
  const withPrompts = [messages[0]!, user('Never push without asking.'), user('Please also fix the footer.'), ...messages.slice(1)]
  await command($, 'rotate')
  await $.turn.complete(reply())
  await $.tool.call(fields() as never)
  const r = await rotate(b, withPrompts)
  expect(r.skip).toMatch(/dropped prompt not in the ledger: Please also fix the footer\./)
  expect(r.skip).not.toContain('Never push without asking.')
  expect(notes.join('\n')).toContain('rotation skipped')
})

const long = (n: number): Message[] => [
  { role: 'user', text: 'start', toolUses: [], handle: 'h0' },
  ...Array.from({ length: n - 1 }, (_, i): Message => ({ role: 'assistant', text: `step ${i}`, toolUses: [], handle: `a${i}` })),
]

test('cap: a 4100-message transcript (longer than the host cap, so whole) rotates and keeps its first message', async ($, on) => {
  const b = await boot($, on)
  await command($, 'rotate')
  await $.turn.complete(reply())
  await $.tool.call(fields() as never)
  const out = (await rotate(b, long(4100))).messages!
  expect(out[0]!.handle).toBe('h0')
  expect(out[1]!.text).toStartWith('ROTATION HANDOVER (')
  expect(out.length).toBe(42)
})

test('cap: a transcript at the cap (it may be the host\'s cut) is skipped, never rotated', async ($, on) => {
  const b = await boot($, on)
  await command($, 'rotate')
  await $.turn.complete(reply())
  await $.tool.call(fields() as never)
  for (const n of [4096, 4010]) expect((await rotate(b, long(n))).skip).toMatch(/4096-message cap/)
  expect((await rotate(b, long(3990))).messages).toBeDefined()
})
