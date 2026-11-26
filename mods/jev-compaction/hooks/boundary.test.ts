import { expect, test } from 'claude-code/testing'

import { describeOutput, findBoundary, sameList, withHandles } from './boundary'
import type { Message } from './types'

const msg = (role: 'user' | 'assistant', text: string, handle?: string): Message => ({ role, text, toolUses: [], ...(handle ? { handle } : {}) })
const output = [msg('user', 'start'), msg('assistant', '[jev dropped 12 calls: Read ×12]'), msg('user', 'q a')]
const before = [msg('user', 'old 1'), msg('assistant', 'old 2'), msg('user', 'old 3')]

test('the output of a compaction is found in the rows by its content, and the list is the output and what came after it', () => {
  const after = [msg('assistant', 'later 1'), msg('user', 'later 2')]
  const found = findBoundary([...before, ...output, ...after], describeOutput(output))
  expect(found?.from).toBe(3)
  expect(found?.messages.map((m) => m.text)).toEqual(['start', '[jev dropped 12 calls: Read ×12]', 'q a', 'later 1', 'later 2'])
})

test('the newest place where the output stands wins', () => {
  const found = findBoundary([...output, msg('user', 'between'), ...output, msg('user', 'end')], describeOutput(output))
  expect(found?.from).toBe(4)
})

test('rows that hold no such output, a changed text or a cut output give nothing', () => {
  const desc = describeOutput(output)
  expect(findBoundary(before, desc)).toBeUndefined()
  expect(findBoundary([...before, ...output.slice(0, 2)], desc)).toBeUndefined()
  expect(findBoundary([...before, output[0]!, msg('assistant', '[jev dropped 11 calls: Read ×11]'), output[2]!], desc)).toBeUndefined()
  expect(findBoundary([...before, ...output], { known: false })).toBeUndefined()
})

test('an output of one message is found, and an empty output is not known', () => {
  const one = [msg('user', 'only')]
  expect(findBoundary([...before, ...one], describeOutput(one))?.from).toBe(3)
  expect(describeOutput([])).toEqual({ known: false })
})

test('the descriptor keeps no message text beyond a short start', () => {
  const big = [msg('user', 'x'.repeat(100_000))]
  const d = describeOutput(big)
  expect(JSON.stringify(d).length).toBeLessThan(500)
  expect(findBoundary(big, d)?.from).toBe(0)
})

test('two lists are the same only when every role and text is the same', () => {
  expect(sameList(output, output.map((m) => ({ ...m, handle: 'h' })))).toBe(true)
  expect(sameList(output, output.slice(0, 2))).toBe(false)
  expect(sameList(output, [output[0]!, msg('assistant', 'other'), output[2]!])).toBe(false)
  expect(sameList(output, [output[0]!, msg('user', output[1]!.text), output[2]!])).toBe(false)
})

test('a result keeps the engine handles of the list: a message that is a row object becomes the list message at the same place', () => {
  const rows = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')]
  const list = rows.map((m, i) => ({ ...m, handle: `h${i}` }))
  const built = msg('assistant', 'new')
  const out = withHandles([rows[0]!, built, rows[2]!], rows, list)
  expect(out.map((m) => m.handle)).toEqual(['h0', undefined, 'h2'])
  expect(out[1]).toBe(built)
})

test('tool calls and results have no text: their ids tell one output from another that looks the same', () => {
  const pair = (id: string): Message[] => [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Read', input: {}, text: '' }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: '', isError: false }] },
  ]
  const rows = [...pair('a'), ...pair('b'), ...pair('c'), ...pair('d')]
  expect(findBoundary(rows, describeOutput(pair('b')))?.from).toBe(2)
  expect(findBoundary(rows, describeOutput(pair('z')))).toBeUndefined()
  expect(sameList(pair('a'), pair('b'))).toBe(false)
})
