import { expect, mock, test } from 'claude-code/testing'

import type { Message } from './types'

type Setup = {
  env?: Record<string, string>
  files?: Record<string, string>
  tokens?: number
  window?: number
  // Jev's probability per question; one number for all
  p?: number
  status?: number
  // what the engine's own compaction answers
  core?: () => unknown
}

const KEY = 'k-secret-123'
const BUILTIN: Message = { role: 'user', text: 'BUILTIN SUMMARY', toolUses: [] }

// A transcript of `calls` tool calls with 30k-character results between a first message and a six-message tail.
function transcript(calls = 12): Message[] {
  const out: Message[] = [{ role: 'user', text: 'start', toolUses: [], handle: 'h0' }]
  for (let i = 0; i < calls; i++) {
    const text = String(i).repeat(30_000)
    out.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `c${i}`, tool: 'Read', input: { file_path: `/src/f${i}.ts` }, text }], handle: `a${i}` })
    out.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `c${i}`, text, isError: false }], handle: `u${i}` })
  }
  for (const t of ['a', 'b', 'c']) out.push({ role: 'assistant', text: `r ${t}`, toolUses: [] }, { role: 'user', text: `q ${t}`, toolUses: [] })
  return out
}

async function boot($: any, on: any, setup: Setup = {}) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const compactCalls: any[] = []
  mock.env(on, setup.env ?? { AIS_SESSION_COMPACTION_JEV_API_KEY: KEY, HOME: '/home/u' })
  on('fs.read', (_$: any, e: any) => {
    const text = (setup.files ?? {})[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: setup.tokens ?? 450_000, window: setup.window ?? 1_000_000 }, rateLimits: [] },
  }))
  on('http.fetch', (_$: any, e: any) => {
    const body = JSON.parse(e.init.body)
    requests.push({ url: e.url, headers: e.init.headers, body })
    const answers = Object.fromEntries(Object.keys(body.questions).map((name) => [name, { noul: setup.p ?? 0 }]))
    const status = setup.status ?? 200
    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify({ answers }) } }
  })
  on('session.compact', (_$: any, e: any) => {
    compactCalls.push(e)
    return (setup.core?.() as { messages: Message[] } | undefined) ?? { messages: [BUILTIN] }
  })
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined as never }))
  return { requests, toasts, logs, compactCalls }
}

const compact = ($: any, trigger: string, extra: Record<string, unknown> = {}) =>
  $.session.compact({ trigger, messages: transcript(), ...extra } as never) as Promise<{ messages?: Message[]; skip?: string }>

const isBuiltin = (r: { messages?: Message[] }) => r.messages?.[0]?.text === 'BUILTIN SUMMARY'

test('subagents and precompute pass straight to the built-in compaction without Jev', async ($, on) => {
  const { requests } = await boot($, on)
  expect(isBuiltin(await compact($, 'plugin', { agentId: 'sub-1' }))).toBe(true)
  expect(isBuiltin(await compact($, 'auto', { agentId: 'sub-1' }))).toBe(true)
  expect(isBuiltin(await compact($, 'precompute'))).toBe(true)
  expect(requests).toEqual([])
})

test('soft compaction is applied when Jev frees enough, with the documented request and no handle on rebuilt messages', async ($, on) => {
  const { requests, toasts, logs } = await boot($, on, { p: 0 })
  const r = await compact($, 'plugin')
  expect(isBuiltin(r)).toBe(false)
  expect(r.messages!.length).toBeLessThan(10)
  expect(r.messages![0]!.handle).toBe('h0')
  expect(r.messages!.slice(-6).every((m) => m.handle === undefined)).toBe(true)
  expect(requests.length).toBeGreaterThan(0)
  const request = requests[0]!
  expect(request.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(request.headers).toEqual({ authorization: `Bearer ${KEY}`, 'content-type': 'application/json' })
  expect(Object.keys(request.body).sort()).toEqual(['model', 'questions', 'state'])
  expect(request.body.model).toBe('jev-latest')
  expect(request.body.questions['call_t1']).toEqual({ type: 'noul', instructions: expect.any(String) })
  expect(toasts[0]).toMatch(/compacted ~450k to ~\d+k? tokens/)
  expect([...toasts, ...logs].join('\n')).not.toContain(KEY)
})

test('soft compaction is deferred when Jev keeps everything, and scores are reused next time', async ($, on) => {
  const { requests, toasts } = await boot($, on, { p: 1 })
  const first = await compact($, 'plugin')
  expect(first.skip).toMatch(/deferred/)
  expect(toasts[0]).toMatch(/deferred/)
  const asked = requests.length
  expect(asked).toBeGreaterThan(0)
  const second = await compact($, 'plugin')
  expect(second.skip).toMatch(/deferred/)
  expect(requests.length).toBe(asked)
})

test('a score near the keep threshold is asked again', async ($, on) => {
  const { requests } = await boot($, on, { p: 0.55 })
  await compact($, 'plugin')
  const asked = requests.length
  await compact($, 'plugin')
  expect(requests.length).toBe(asked * 2)
})

test('soft compaction at the hard limit that frees too little falls back to the built-in summary', async ($, on) => {
  await boot($, on, { p: 1, tokens: 520_000 })
  expect(isBuiltin(await compact($, 'plugin'))).toBe(true)
})

test('auto: applied below the hard limit, built-in summary above it', async ($, on) => {
  await boot($, on, { p: 0, tokens: 600_000 })
  expect(isBuiltin(await compact($, 'auto'))).toBe(false)
})

test('auto: built-in summary when pruning cannot get under the hard limit', async ($, on) => {
  await boot($, on, { p: 1, tokens: 600_000 })
  expect(isBuiltin(await compact($, 'auto'))).toBe(true)
})

test('manual: applied when it frees enough, else built-in summary', async ($, on) => {
  await boot($, on, { p: 0 })
  expect(isBuiltin(await compact($, 'manual'))).toBe(false)
})

test('manual: built-in summary when Jev keeps everything', async ($, on) => {
  await boot($, on, { p: 1 })
  expect(isBuiltin(await compact($, 'manual'))).toBe(true)
})

test('no key: soft defers, auto and manual fall back, and Jev is never called', async ($, on) => {
  const { requests, toasts } = await boot($, on, { env: { HOME: '/home/u' } })
  expect((await compact($, 'plugin')).skip).toMatch(/no Jev API key/)
  expect(isBuiltin(await compact($, 'auto'))).toBe(true)
  expect(isBuiltin(await compact($, 'manual'))).toBe(true)
  expect(requests).toEqual([])
  expect(toasts.length).toBe(3)
})

test('a Jev error defers a soft compaction, falls back otherwise, and the key stays out of every message', async ($, on) => {
  const { toasts, logs } = await boot($, on, { status: 500 })
  const soft = await compact($, 'plugin')
  expect(soft.skip).toMatch(/Jev request failed \(500\)/)
  expect(isBuiltin(await compact($, 'auto'))).toBe(true)
  expect([...toasts, ...logs, soft.skip].join('\n')).not.toContain(KEY)
})

test('the key file is read lazily: comment lines, TYPESAFE_API_KEY fallback, empty value ignored', async ($, on) => {
  const { requests } = await boot($, on, {
    env: { HOME: '/home/u' },
    files: { '/home/u/.config/ai-tools/jev-compaction.env': '# keys\nAIS_SESSION_COMPACTION_JEV_API_KEY=\nTYPESAFE_API_KEY=file-key\n' },
    p: 0,
  })
  await compact($, 'plugin')
  expect(requests[0]!.headers['authorization']).toBe('Bearer file-key')
})

test('an environment key wins over the key file; TYPESAFE_API_KEY is the second environment name', async ($, on) => {
  const { requests } = await boot($, on, {
    env: { TYPESAFE_API_KEY: 'env-key', HOME: '/home/u' },
    files: { '/home/u/.config/ai-tools/jev-compaction.env': 'TYPESAFE_API_KEY=file-key' },
  })
  await compact($, 'plugin')
  expect(requests[0]!.headers['authorization']).toBe('Bearer env-key')
})

test('keyFile option names another file', { options: { keyFile: '/etc/example/jev.env' } }, async ($, on) => {
  const { requests } = await boot($, on, { env: {}, files: { '/etc/example/jev.env': 'export AIS_SESSION_COMPACTION_JEV_API_KEY="quoted"' } })
  await compact($, 'plugin')
  expect(requests[0]!.headers['authorization']).toBe('Bearer quoted')
})

test('/jev-compact stats reports the session totals', async ($, on) => {
  await boot($, on, { p: 0 })
  await compact($, 'plugin')
  const { text } = await $.command.run({ command: 'jev-compact', args: 'stats' } as never)
  expect(text).toMatch(/1 applied, 0 deferred, 0 built-in fallbacks; ~\d+ tokens freed; \d+ Jev requests/)
  expect((await $.command.run({ command: 'jev-compact', args: '' } as never)).text).toMatch(/Usage/)
})

test('periodic trigger: compacts at the trigger, not below, and waits for regrowth after an attempt', async ($, on) => {
  const { compactCalls } = await boot($, on, { core: () => ({ skip: 'deferred by test' }) })
  const measure = (tokens: number) =>
    $.session.measure({ context: { tokens, window: 1_000_000, percent: tokens / 10_000 }, rateLimits: [], changed: ['context'] })
  await measure(399_000)
  expect(compactCalls.length).toBe(0)
  await measure(410_000)
  expect(compactCalls.length).toBe(1)
  await measure(434_000)
  expect(compactCalls.length).toBe(1)
  await measure(435_000)
  expect(compactCalls.length).toBe(2)
  await measure(300_000)
  await measure(405_000)
  expect(compactCalls.length).toBe(3)
})

test('periodic trigger on a small window uses percentages', async ($, on) => {
  const { compactCalls } = await boot($, on, { window: 200_000 })
  const measure = (tokens: number) =>
    $.session.measure({ context: { tokens, window: 200_000, percent: tokens / 2000 }, rateLimits: [], changed: ['context'] })
  await measure(119_000)
  expect(compactCalls.length).toBe(0)
  await measure(120_000)
  expect(compactCalls.length).toBe(1)
})

test('/jev-compact now compacts from a later event and reports a deferral', async ($, on) => {
  const { compactCalls, toasts } = await boot($, on, { core: () => ({ skip: 'nothing to do' }) })
  const clock = mock.clock(on)
  const { text } = await $.command.run({ command: 'jev-compact', args: 'now' } as never)
  expect(text).toContain('compacting now')
  await clock.advance(200)
  expect(compactCalls.length).toBe(1)
  expect(toasts.join('\n')).toContain('nothing to do')
})
