import { describe, expect, test } from 'claude-code/testing'

import { abridge, buildRotation, chooseTail, ledgerFromRow, lineSplitter, promptsFile, rotationDue, standingRules, tailStart, unfinishedShells, verifyRotation } from './rotate'
import type { Handover, RotationInput } from './rotate'
import type { Message } from './types'

const user = (text: string, extra: Partial<Message> = {}): Message => ({ role: 'user', text, toolUses: [], ...extra })
const call = (id: string, chars = 10): Message => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Read', input: {}, text: 'x'.repeat(chars) }] })
const result = (id: string, chars = 10): Message => user('', { toolResults: [{ tool_use_id: id, text: 'x'.repeat(chars), isError: false }] })

const HANDOVER: Handover = { goal: 'g', openTasks: [], prs: [], agents: [], pendingQuestions: [], decisions: [], paths: [], handoverDir: '/w/.data/o/p/scratch/r' }
const input = (messages: Message[], extra: Partial<RotationInput> = {}): RotationInput => ({
  messages,
  handover: HANDOVER,
  handoffPath: '/h/HANDOFF.md',
  promptsPath: '/h/PROMPTS.md',
  recent: [],
  rules: [],
  agents: [],
  shells: [],
  when: 0,
  config: { rotateKeepMessages: 40, rotateBudgetTokens: 40_000 },
  ...extra,
})

describe('trigger', () => {
  const c = { rotateAfterHours: 72, rotateHighTurns: 100 }
  test('72 hours or 100 high turns, whichever comes first', () => {
    expect(rotationDue(72 * 3_600_000 - 1, 0, 99, c)).toBe(false)
    expect(rotationDue(72 * 3_600_000, 0, 0, c)).toBe(true)
    expect(rotationDue(1, 0, 100, c)).toBe(true)
  })
})

describe('build', () => {
  test('the tail start moves back so no tool_result loses its tool_use, and never past the first message', () => {
    const m = [user('first'), call('a'), result('a'), call('b'), result('b')]
    expect(tailStart(m, 1)).toBe(3)
    expect(tailStart(m, 2)).toBe(3)
    expect(tailStart([user('first'), result('z')], 1)).toBe(1)
  })

  test('over the budget fewer messages are kept, never fewer than 10', () => {
    const m = [user('first'), ...Array.from({ length: 40 }, (_, i) => user(`${i} ${'y'.repeat(7000)}`))]
    const start = chooseTail(m, { rotateKeepMessages: 40, rotateBudgetTokens: 1000 })
    expect(m.length - start).toBe(10)
    expect(m.length - chooseTail(m, { rotateKeepMessages: 40, rotateBudgetTokens: 1_000_000 })).toBe(40)
  })

  test('first message, one handover message with the rules and prompts verbatim, then the tail', () => {
    const long = 'L'.repeat(5000)
    const m = [user('first', { handle: 'h0' }), ...Array.from({ length: 50 }, (_, i) => user(`m${i}`, { handle: `h${i + 1}` }))]
    const built = buildRotation(input(m, { rules: ['Never force-push.'], recent: [{ at: 0, text: 'Do the thing.' }, { at: 1, text: long }] }))
    expect(built.messages.length).toBe(42)
    expect(built.messages[0]).toBe(m[0])
    expect(built.messages[1]!.handle).toBeUndefined()
    expect(built.text).toContain('Never force-push.')
    expect(built.text).toContain('Do the thing.')
    expect(built.text).toContain(abridge(long, '/h/PROMPTS.md'))
    expect(built.text).not.toContain(long)
  })
})

describe('verification gate', () => {
  const m = [user('first'), user(`see https://github.com/o/r/pull/7`), ...Array.from({ length: 45 }, (_, i) => user(`m${i}`)), { role: 'assistant', text: 'Ready.\nDeploy now?', toolUses: [] } as Message]
  const ledger = [{ at: 0, text: 'old prompt' }]

  test('a complete rotation passes', () => {
    const r = input(m, { handover: { ...HANDOVER, pendingQuestions: ['Deploy now?'], prs: [{ url: 'https://github.com/o/r/pull/7', state: 'open' }] } })
    expect(verifyRotation(r, buildRotation(r), promptsFile(ledger), ledger)).toEqual([])
  })

  test('missing agents, shells, PR links, questions and prompts are found and can be appended', () => {
    const r = input(m, { agents: [{ id: 'ag1', description: 'd', status: 'running' }], shells: ['sh1'], recent: [{ at: 5, text: 'later prompt' }] })
    const built = buildRotation(r)
    const lost = { ...built, text: built.text.replace(/ag1|sh1|later prompt/g, '') }
    const missing = verifyRotation(r, lost, promptsFile(ledger), ledger)
    expect(missing.map((x) => x.item).join('\n')).toContain('https://github.com/o/r/pull/7')
    expect(missing.map((x) => x.item).join('\n')).toContain('Deploy now?')
    expect(missing.filter((x) => x.fixable).length).toBe(missing.length)
    expect(verifyRotation(r, buildRotation(r, missing.map((x) => x.item)), promptsFile(ledger), ledger)).toEqual([])
  })

  test('an unreadable or incomplete PROMPTS.md, an orphan tool_result and a lost first message cannot be fixed', () => {
    const r = input(m)
    const built = buildRotation(r)
    expect(verifyRotation(r, built, undefined, ledger).some((x) => !x.fixable)).toBe(true)
    expect(verifyRotation(r, built, '# Prompts', ledger).some((x) => !x.fixable && x.item.includes('lacks a prompt'))).toBe(true)
    const broken = { ...built, messages: [user('other'), result('zz')] }
    const items = verifyRotation(r, broken, promptsFile(ledger), ledger).map((x) => x.item)
    expect(items).toContain('first message not kept')
    expect(items).toContain('orphan tool_result zz')
  })
})

describe('transcript', () => {
  test('backfill rows: typed prompts only, split across pieces', () => {
    const rows = [
      JSON.stringify({ type: 'user', timestamp: '2026-10-01T00:00:00Z', origin: { kind: 'human' }, message: { content: 'one' } }),
      JSON.stringify({ type: 'user', timestamp: '2026-10-01T00:01:00Z', origin: { kind: 'peer' }, message: { content: 'peer' } }),
      JSON.stringify({ type: 'user', timestamp: '2026-10-01T00:02:00Z', message: { content: '<local-command-stdout>x</local-command-stdout>' } }),
      JSON.stringify({ type: 'user', timestamp: '2026-10-01T00:03:00Z', message: { content: [{ type: 'text', text: 'two' }] } }),
      '{"type":"user", broken',
    ].join('\n')
    const got: string[] = []
    const split = lineSplitter((line) => {
      const e = ledgerFromRow(line)
      if (e) got.push(e.text)
    })
    for (let i = 0; i < rows.length; i += 13) split.feed(rows.slice(i, i + 13))
    split.end()
    expect(got).toEqual(['one', 'two'])
  })

  test('a background shell a task notification reported finished is not unfinished', () => {
    const bg = (id: string): Message => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { run_in_background: true }, text: `Command running in background with ID: ${id}` }] })
    const m = [user('first'), bg('s1'), bg('s2'), user(`<task-notification><task-id>s1</task-id><status>completed</status></task-notification>`)]
    expect(unfinishedShells(m)).toEqual(['s2'])
  })

  test('standing rules: the regex, or a Jev score of 0.3 or more', () => {
    const older = [{ at: 0, text: 'Always use pnpm.' }, { at: 1, text: 'Fix the bug.' }, { at: 2, text: 'Write in British English.' }]
    expect(standingRules(older)).toEqual(['Always use pnpm.'])
    expect(standingRules(older, { 1: 0.1, 2: 0.3 })).toEqual(['Always use pnpm.', 'Write in British English.'])
  })
})
