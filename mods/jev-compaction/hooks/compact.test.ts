import { describe, expect, test } from 'claude-code/testing'

import { applyDecisions, callKey, collectTexts, compact, hash, prescore, resultKey, signalLines, textKey } from './compact'
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
    expect(out.length).toBe(messages.length - 1)
    const note = out.find((m) => m.text.includes('dropped Read call'))
    expect(note?.text).toBe('[jev-compaction dropped Read call: {"file_path":"/src/d.ts"}; re-run if needed]')
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
    expect(rebuilt.length).toBe(1)
    expect(rebuilt[0]?.toolResults?.[0]?.tool_use_id).toBe('a')
    expect(rebuilt.every((m) => m.handle === undefined)).toBe(true)
    expect(out.filter((m) => messages.includes(m)).length).toBe(messages.length - 1)
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

describe('failure lines survive compaction', () => {
  const log = Array.from({ length: 600 }, (_, i) => `line ${i} ok`)
  log[300] = 'FAIL  tests/example.test.ts > adds > src/example.ts:88'
  const logText = log.join('\n')

  test('a truncated tool result keeps the FAIL line with one line of context, after the head and before the note', async () => {
    const messages = [user('start'), ...call('a', logText), ...tail()]
    const { messages: out } = await compact(messages, fakeJev({ call_t1: 0.9, result_t1: 0.1 }).ask)
    const text = out.flatMap((m) => m.toolResults ?? [])[0]!.text
    expect(text.startsWith(logText.slice(0, 300))).toBe(true)
    const fail = text.indexOf('FAIL  tests/example.test.ts > adds > src/example.ts:88')
    expect(fail).toBeGreaterThan(300)
    expect(text).toContain('line 299 ok\nFAIL  tests/example.test.ts > adds > src/example.ts:88\nline 301 ok')
    expect(text).toContain('line 301 ok')
    expect(text).not.toContain('line 302 ok')
    expect(fail).toBeLessThan(text.indexOf('[jev-compaction truncated'))
  })

  test('abridged assistant and user text keep failure lines in the omitted middle', async () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `row ${i} fine`).join('\n')
    const a = `${filler(100)}\nTypeError: cannot read x\n${filler(100)}`
    const u = `${filler(150)}\nexit code 2\n${filler(150)}`
    const messages = [user('start'), assistant(a), user('ok'), assistant('ok'), user(u), ...tail()]
    const { messages: out } = await compact(messages, fakeJev({ text_m1: 0.3, text_m4: 0.1 }).ask)
    expect(out[1]!.text).toContain('TypeError: cannot read x')
    expect(out[1]!.text.indexOf('TypeError')).toBeLessThan(out[1]!.text.indexOf('omitted by jev-compaction'))
    expect(out[4]!.text).toContain('exit code 2')
  })

  test('signal lines are capped at 1500 characters in original order', () => {
    const noisy = Array.from({ length: 400 }, (_, i) => `error number ${i}`).join('\n')
    const kept = signalLines(noisy)
    expect(kept.length).toBeLessThanOrEqual(1500)
    expect(kept.startsWith('error number 0\n')).toBe(true)
    expect(signalLines('all fine\nnothing here')).toBe('')
  })
})

describe('safety of the rebuild', () => {
  const body = (n: number) => 'abcdefghij'.repeat(n / 10)

  test('a truncated result leaves the assistant message with its echo untouched', async () => {
    const messages = [user('start'), ...call('a', long(2000)), ...tail()]
    const { messages: out } = await compact(messages, fakeJev({ call_t1: 0.9, result_t1: 0.1 }).ask)
    expect(out[1]).toBe(messages[1])
    expect(out[2]).not.toBe(messages[2])
  })

  test('calls of mutating tools are never dropped, only their results truncated', async () => {
    const mk = (id: string, tool: string): Message[] => [
      assistant('', { toolUses: [{ tool_use_id: id, tool, input: { path: id }, text: long(2000) }] }),
      user('', { toolResults: [{ tool_use_id: id, text: long(2000), isError: false }] }),
    ]
    const messages = [user('start'), ...mk('e', 'Edit'), ...mk('w', 'mcp__files__write_file'), ...mk('b', 'Bash'), ...mk('m', 'mcp__files__read_file'), ...tail()]
    const { messages: out, stats } = await compact(messages, fakeJev({}, 0).ask)
    const uses = out.flatMap((m) => m.toolUses.map((t) => t.tool_use_id))
    expect(uses).toEqual(['e', 'w'])
    expect(stats).toMatchObject({ callsDropped: 2, resultsTruncated: 2 })
    expect(out.flatMap((m) => m.toolResults ?? []).map((r) => r.tool_use_id)).toEqual(['e', 'w'])
    expect(out.some((m) => m.text.includes('dropped Bash call: {"path":"b"}'))).toBe(true)
    expect(out.some((m) => m.text.includes('dropped mcp__files__read_file call'))).toBe(true)
    expect(out.some((m) => m.text.includes('dropped Edit call'))).toBe(false)
  })

  test('a message that holds non-text content is never rebuilt, and neither are its neighbours in the pair', async () => {
    const shot = assistant('', { toolUses: [{ tool_use_id: 'img', tool: 'Read', input: { f: 'shot.png' }, text: 'image' }, { tool_use_id: 'sh', tool: 'Bash', input: { command: 'ls' }, text: long(2000) }] })
    const both = user('', { handle: 'both', toolResults: [{ tool_use_id: 'img', text: 'image', isError: false }, { tool_use_id: 'sh', text: long(2000), isError: false }] })
    const messages = [user('start'), shot, both, ...call('x', long(2000)), ...tail()]
    const jev = fakeJev({}, 0)
    const { messages: out } = await compact(messages, jev.ask, {}, {}, { protect: { ids: new Set(['img']), indexes: new Set() } })
    expect(out[1]).toBe(shot)
    expect(out[2]).toBe(both)
    expect(jev.asked.sort()).toEqual(['call_t3', 'result_t3'])
    expect(out.flatMap((m) => m.toolResults ?? []).map((r) => r.tool_use_id)).toEqual(['img', 'sh'])
  })

  test('a user text message marked as holding media is not judged', async () => {
    const messages = [user('start'), assistant('ok'), user(body(3000)), ...tail()]
    const jev = fakeJev({}, 0)
    const { messages: out } = await compact(messages, jev.ask, {}, {}, { protect: { ids: new Set(), indexes: new Set([2]) } })
    expect(jev.asked).toEqual([])
    expect(out[2]).toBe(messages[2])
  })

  test('applying the same decisions twice changes nothing more', async () => {
    const messages = [user('start'), ...call('a', long(2000)), assistant(body(2000)), user('ok'), assistant(body(1500)), user(body(3000)), ...tail()]
    const tools = new Map<string, 'drop_result'>([['a', 'drop_result']])
    const texts = new Map<number, 'abridge' | 'stub'>([[3, 'abridge'], [5, 'stub'], [6, 'abridge']])
    const once = applyDecisions(messages, tools, texts, 300)
    const twice = applyDecisions(once, tools, texts, 300)
    expect(twice).toEqual(once)
    expect(twice.every((m, i) => m === once[i])).toBe(true)
    expect(once[3]?.text).toContain('jev-compaction')
  })

  test('already compacted items are not asked about again', async () => {
    const messages = [user('start'), ...call('a', long(2000)), assistant(body(2000)), user('ok'), ...tail()]
    const first = await compact(messages, fakeJev({ call_t1: 0.9, result_t1: 0.1, text_m3: 0.1 }).ask)
    const jev = fakeJev({}, 0)
    const second = await compact(first.messages, jev.ask)
    expect(jev.asked).toEqual([])
    expect(second.messages).toEqual(first.messages)
  })

  test('an abridge that cannot save space leaves the text and is not counted', async () => {
    const messages = [user('start'), assistant(body(1000)), user('ok'), ...tail()]
    const { messages: out, stats } = await compact(messages, fakeJev({ text_m1: 0.3 }).ask)
    expect(out[1]).toBe(messages[1])
    expect(stats).toMatchObject({ textsAbridged: 0, textsKept: 1 })
  })
})

describe('partial failures, pre-scoring and notes', () => {
  const body = (n: number) => 'abcdefghij'.repeat(n / 10)
  // Enough calls that the questions need several batches.
  const many = (n = 24) => [user('start'), ...Array.from({ length: n }, (_, i) => call(`k${i}`, long(2000, 'x'), { file_path: `/src/f${i}.ts` })).flat(), ...tail()]
  const small = { maxStateTokens: 4000, maxRequestTokens: 4500 }

  // Answers the first batch, fails the others.
  const flaky = (failFrom: number) => {
    let n = 0
    const ask: JevAsker = async (_s, questions) => {
      if (n++ >= failFrom) throw new Error('Jev request timed out after 8000 ms')
      return Object.fromEntries(Object.keys(questions).map((name) => [name, 0.05]))
    }
    return ask
  }

  test('a failed batch is left unscored while the answered ones count and their scores are returned', async () => {
    const messages = many()
    const { stats, scores, messages: out } = await compact(messages, flaky(1), small)
    expect(stats.requests).toBeGreaterThan(1)
    expect(stats.failed).toBeGreaterThan(0)
    expect(stats.abandoned).toBe(stats.failed)
    expect(Object.keys(scores).length).toBeGreaterThan(0)
    expect(stats.callsDropped).toBeGreaterThan(0)
    expect(stats.callsDropped).toBeLessThan(24)
    expect(pairsIntact(out)).toBe(true)
  })

  test('when every batch fails nothing was learned and compact throws', async () => {
    await expect(compact(many(), flaky(0), small)).rejects.toThrow(/timed out/)
  })

  test('the stop check abandons later rounds but never the first', async () => {
    const jev = fakeJev({}, 0.05)
    const { stats } = await compact(many(80), jev.ask, { ...small }, {}, { stop: () => true })
    expect(stats.requests).toBeGreaterThan(0)
    expect(stats.requests).toBeLessThanOrEqual(4)
    expect(stats.abandoned).toBeGreaterThan(0)
  })

  test('pre-scoring asks at most maxBatches, reuses every remembered score and changes nothing', async () => {
    const messages = many()
    const jev = fakeJev({}, 0.05)
    const first = await prescore(messages, jev.ask, small, {}, { maxBatches: 1 })
    expect(jev.requests()).toBe(1)
    expect(Object.keys(first.scores).length).toBeGreaterThan(0)
    expect(first.pending).toBeGreaterThan(0)
    const again = await prescore(messages, jev.ask, small, { ...first.scores }, { maxBatches: 1 })
    expect(Object.keys(again.scores).filter((k) => k in first.scores)).toEqual([])
    // a remembered score right at a threshold is not asked again by pre-scoring
    const keys = Object.keys(first.scores)
    const near = Object.fromEntries(keys.map((k) => [k, 0.5]))
    const before = jev.requests()
    await prescore(messages, jev.ask, small, { ...near, ...again.scores }, { maxBatches: 1 })
    expect(Object.keys((await prescore(messages, jev.ask, small, near, { maxBatches: 1 })).scores).filter((k) => keys.includes(k))).toEqual([])
    expect(jev.requests()).toBeGreaterThan(before)
  })

  test('only the mod notes pin an item: a path that contains the name does not', async () => {
    const path = '/home/u/.worktrees/jev-compaction/src/a.ts'
    const messages = [user('start'), assistant(`I edited ${path} ` + body(1000)), user('ok'), ...call('p', `${path}\n` + long(2000), { file_path: path }), ...tail()]
    expect(collectTexts(messages, 6).map((t) => t.index)).toEqual([1])
    const jev = fakeJev({}, 0.05)
    await compact(messages, jev.ask)
    expect(jev.asked.sort()).toEqual(['call_t1', 'result_t1', 'text_m1'])
  })

  test('with media in a user message no user text is judged', async () => {
    const messages = [user('start'), assistant('ok'), user(body(3000)), assistant(body(1500)), ...tail()]
    const jev = fakeJev({}, 0)
    const { messages: out } = await compact(messages, jev.ask, {}, {}, { protect: { ids: new Set(), indexes: new Set(), noUserText: true } })
    expect(jev.asked).toEqual(['text_m3'])
    expect(out[2]).toBe(messages[2])
  })
})

describe('a history too big for one state', () => {
  test('the oldest part is judged and the newest unpinned part stays, instead of failing', async () => {
    const messages = [user('start'), ...Array.from({ length: 120 }, (_, i) => call(`k${i}`, long(300, 'x'), { file_path: `/src/${'long/'.repeat(8)}f${i}.ts` })).flat(), ...tail()]
    const states: string[] = []
    const jev = fakeJev({}, 0.05)
    const ask: JevAsker = (state, q) => {
      states.push(JSON.stringify(state))
      return jev.ask(state, q)
    }
    const { stats, messages: out } = await compact(messages, ask, { maxStateTokens: 2500, maxRequestTokens: 3200 })
    expect(stats.stateStage).toBe('newest old messages left out')
    expect(states.at(-1)).toMatch(/\[\d+ messages left out\]/)
    expect(states.at(-1)).not.toContain('the whole conversation')
    expect(stats.callsDropped).toBeGreaterThan(0)
    expect(stats.callsDropped).toBeLessThan(120)
    expect(out.flatMap((m) => m.toolResults ?? []).map((r) => r.tool_use_id).slice(-3)).toEqual(['k119', 'k118', 'k117'].reverse())
    expect(pairsIntact(out)).toBe(true)
  })
})
