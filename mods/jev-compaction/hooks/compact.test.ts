import { describe, expect, test } from 'claude-code/testing'

import { callKey, compact, hash, resultKey, textKey } from './compact'
import type { JevAsker, Message, Scores } from './types'

const long = (n: number, ch = 'x') => ch.repeat(n)

type Table = Record<string, number>

// Answers every question from a table of name patterns; unmatched names get `fallback`.
function fakeJev(table: Table, fallback = 1) {
  const asked: string[] = []
  let requests = 0
  const ask: JevAsker = async (_state, questions) => {
    requests++
    const out: Record<string, number> = {}
    for (const name of Object.keys(questions)) {
      asked.push(name)
      out[name] = table[name] ?? fallback
    }
    return out
  }
  return { ask, asked, requests: () => requests }
}

const user = (text: string, extra: Partial<Message> = {}): Message => ({ role: 'user', text, toolUses: [], handle: `h-${text.length}`, ...extra })
const assistant = (text: string, extra: Partial<Message> = {}): Message => ({ role: 'assistant', text, toolUses: [], handle: `h-${text.length}`, ...extra })

function call(id: string, resultText: string, input: Record<string, unknown> = { file_path: `/src/${id}.ts` }): Message[] {
  return [
    assistant('', { handle: `a-${id}`, toolUses: [{ tool_use_id: id, tool: 'Read', input, text: resultText }] }),
    user('', { handle: `u-${id}`, toolResults: [{ tool_use_id: id, text: resultText, isError: false }] }),
  ]
}

// Six messages that stay pinned at the end.
const tail = (): Message[] => ['a', 'b', 'c'].flatMap((t) => [assistant(`reply ${t}`), user(`prompt ${t}`)])

const pairsIntact = (messages: readonly Message[]) => {
  const uses = new Set(messages.flatMap((m) => m.toolUses.map((t) => t.tool_use_id)))
  const results = new Set(messages.flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id)))
  return uses.size === results.size && [...uses].every((id) => results.has(id))
}

describe('tool pruning', () => {
  test('keeps, truncates or drops a call by its two probabilities and never breaks a pair', async () => {
    const messages = [user('start'), ...call('k', long(2000)), ...call('r', long(2000, 'r')), ...call('d', long(2000, 'd')), ...tail()]
    // ids are t1 (keep), t2 (truncate), t3 (drop)
    const jev = fakeJev({ call_t1: 0.9, result_t1: 0.9, call_t2: 0.9, result_t2: 0.1, call_t3: 0.1, result_t3: 0.1 })
    const { messages: out, stats } = await compact(messages, jev.ask)
    expect(stats).toMatchObject({ toolsKept: 1, resultsTruncated: 1, callsDropped: 1, requests: 1 })
    expect(pairsIntact(out)).toBe(true)
    const results = out.flatMap((m) => m.toolResults ?? [])
    expect(results.map((r) => r.tool_use_id)).toEqual(['k', 'r'])
    expect(results[0]?.text).toBe(long(2000))
    expect(results[1]?.text).toContain('jev-compaction truncated 1700 chars')
    expect(results[1]?.text.startsWith(long(300, 'r'))).toBe(true)
    expect(out.flatMap((m) => m.toolUses).map((t) => t.tool_use_id)).toEqual(['k', 'r'])
    expect(out.length).toBe(messages.length - 2)
  })

  test('two noul questions are asked per candidate call', async () => {
    const jev = fakeJev({})
    await compact([user('start'), ...call('a', 'x'), ...tail()], jev.ask)
    expect(jev.asked).toEqual(['call_t1', 'result_t1'])
  })

  test('first message and the newest six are pinned and untouched', async () => {
    const messages = [user('start ' + long(5000)), ...call('old', long(2000)), ...call('n1', long(2000)), ...call('n2', long(2000)), assistant(long(900)), user(long(3000))]
    const jev = fakeJev({}, 0)
    const { messages: out } = await compact(messages, jev.ask)
    expect(out[0]).toBe(messages[0])
    expect(out.slice(-6)).toEqual(messages.slice(-6))
    expect(out.slice(-6).every((m, i) => m === messages[messages.length - 6 + i])).toBe(true)
    expect(jev.asked.some((n) => n === 'text_m0' || n === 'text_m' + (messages.length - 1))).toBe(false)
  })

  test('unchanged messages are the engine objects, rebuilt ones carry no handle', async () => {
    const messages = [user('start'), ...call('a', long(2000)), ...call('b', long(2000)), ...tail()]
    const { messages: out } = await compact(messages, fakeJev({ call_t1: 0.9, result_t1: 0.1 }).ask)
    expect(out[0]).toBe(messages[0])
    const rebuilt = out.filter((m) => !messages.includes(m))
    expect(rebuilt.length).toBe(2)
    expect(rebuilt.every((m) => m.handle === undefined)).toBe(true)
    expect(out.filter((m) => messages.includes(m)).length).toBe(messages.length - 2)
  })
})

describe('message text', () => {
  const body = (n: number) => 'abcdefghij'.repeat(n / 10)

  test('assistant text is kept, abridged or stubbed by probability', async () => {
    const messages = [user('start'), assistant(body(1500)), user('ok'), assistant(body(1500) + '!'), user('ok'), assistant(body(1500) + '?'), user('ok'), ...tail()]
    const jev = fakeJev({ text_m1: 0.6, text_m3: 0.3, text_m5: 0.1 })
    const { messages: out, stats } = await compact(messages, jev.ask)
    expect(stats).toMatchObject({ textsKept: 1, textsAbridged: 1, textsStubbed: 1 })
    expect(out[1]).toBe(messages[1])
    const abridged = out[3]!.text
    expect(abridged.startsWith(body(1500).slice(0, 600))).toBe(true)
    expect(abridged.endsWith(('abcdefghij'.repeat(150) + '!').slice(-300))).toBe(true)
    expect(abridged).toContain('[… 601 chars omitted by jev-compaction …]'.replace('601', String(1501 - 900)))
    expect(out[5]!.text).toBe('[earlier assistant message omitted by jev-compaction: 1501 chars]')
    expect(out[5]!.role).toBe('assistant')
    expect(out.length).toBe(messages.length)
  })

  test('assistant text of 400 characters or less is not judged', async () => {
    const jev = fakeJev({}, 0)
    const messages = [user('start'), assistant(body(400)), user('ok'), ...tail()]
    const { messages: out } = await compact(messages, jev.ask)
    expect(jev.asked).toEqual([])
    expect(out).toEqual(messages)
  })

  test('user text is never stubbed and only abridged above 2000 characters', async () => {
    const jev = fakeJev({}, 0)
    const messages = [user('start'), assistant('ok'), user(body(2000)), assistant('ok'), user(body(3000)), ...tail()]
    const { messages: out, stats } = await compact(messages, jev.ask)
    expect(jev.asked).toEqual(['text_m4'])
    expect(out[2]).toBe(messages[2])
    expect(stats).toMatchObject({ textsAbridged: 1, textsStubbed: 0 })
    const text = out[4]!.text
    expect(text.startsWith(body(3000).slice(0, 1200))).toBe(true)
    expect(text.endsWith(body(3000).slice(-600))).toBe(true)
    expect(text).toContain('[… 1200 chars omitted by jev-compaction …]')
    expect(text).not.toContain('earlier assistant message')
  })

  test('user text Jev wants kept stays whole', async () => {
    const messages = [user('start'), assistant('ok'), user(body(3000)), ...tail()]
    const { messages: out } = await compact(messages, fakeJev({ text_m2: 0.7 }).ask)
    expect(out[2]).toBe(messages[2])
  })

  test('an assistant message with tool calls keeps its tool_use when the text is stubbed', async () => {
    const withCall = assistant(body(1000), { toolUses: [{ tool_use_id: 'x', tool: 'Bash', input: { command: 'ls' }, text: 'out' }] })
    const messages = [user('start'), withCall, user('', { toolResults: [{ tool_use_id: 'x', text: 'out', isError: false }] }), ...tail()]
    const { messages: out } = await compact(messages, fakeJev({ text_m1: 0.05, call_t1: 0.9, result_t1: 0.9 }).ask)
    expect(out[1]!.text).toContain('omitted by jev-compaction')
    expect(out[1]!.toolUses[0]).toBe(withCall.toolUses[0])
    expect(pairsIntact(out)).toBe(true)
  })

  test('a text whose message is no longer visible in the state is not judged', async () => {
    const messages = [user('start'), ...Array.from({ length: 40 }, (_, i) => [assistant(body(1000) + i), user('ok')]).flat(), ...tail()]
    const jev = fakeJev({}, 0)
    const { stats } = await compact(messages, jev.ask, { maxStateTokens: 1500, maxRequestTokens: 4000 })
    expect(stats.stateStage).not.toBe('full')
    expect(stats.textsStubbed).toBeLessThan(40)
  })
})

describe('score memory', () => {
  const messages = [user('start'), ...call('a', long(2000)), assistant(long(1000)), user('ok'), ...tail()]
  const input = { file_path: '/src/a.ts' }
  const memoryFor = (p: number): Scores => ({
    [callKey({ tool: 'Read', input })]: p,
    [resultKey({ tool: 'Read', input, resultChars: 2000 })]: p,
    [textKey('assistant', long(1000))]: p,
  })

  test('scores far from the thresholds are reused without a request', async () => {
    const jev = fakeJev({}, 0.5)
    const { stats, messages: out } = await compact(messages, jev.ask, {}, memoryFor(0.95))
    expect(jev.requests()).toBe(0)
    expect(stats).toMatchObject({ reused: 3, requests: 0, toolsKept: 1, textsKept: 1 })
    expect(out).toEqual(messages)
  })

  test('a score within 0.15 of a threshold is asked again, and the fresh score is returned', async () => {
    const jev = fakeJev({ call_t1: 0.9, result_t1: 0.9, text_m3: 0.9 })
    const { scores } = await compact(messages, jev.ask, {}, memoryFor(0.4))
    expect(jev.asked.sort()).toEqual(['call_t1', 'result_t1', 'text_m3'])
    expect(Object.values(scores)).toEqual([0.9, 0.9, 0.9])
  })

  test('a score near the abridge threshold is re-asked for assistant text only', async () => {
    const jev = fakeJev({ text_m3: 0.9 })
    await compact(messages, jev.ask, {}, { ...memoryFor(0.95), [textKey('assistant', long(1000))]: 0.3 })
    expect(jev.asked).toEqual(['text_m3'])
  })

  test('hash differs for different text', () => {
    expect(hash('a')).not.toBe(hash('b'))
    expect(callKey({ tool: 'Read', input: { a: 1, b: 2 } })).toBe(callKey({ tool: 'Read', input: { b: 2, a: 1 } }))
  })
})
