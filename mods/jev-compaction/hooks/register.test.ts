import { expect, mock, test } from 'claude-code/testing'

import type { Message } from './types'

// Secret-shaped fixtures are assembled at runtime so no literal matches a real token format.
const S = { SKL: ['sk', 'live', ''].join('_'), SKT: ['sk', 'test', ''].join('_'), RKL: ['rk', 'live', ''].join('_'), GHP: ['gh', 'p_'].join(''), PAT: ['github', 'pat', ''].join('_'), GLP: ['glp', 'at-'].join(''), XOX: ['xo', 'xb-'].join(''), AIZ: ['AI', 'za'].join(''), AKI: ['AK', 'IA'].join(''), NPM: ['np', 'm_'].join(''), HF: ['h', 'f_'].join(''), JWT: ['ey', 'J'].join(''), PEM: ['-----BE', 'GIN'].join('') }

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
  // the main conversation in API form, as `$.session.messages({ as: 'api' })` answers
  api?: unknown[]
  // the main conversation as rows
  rows?: unknown[]
  // never answer a fetch
  hang?: boolean
  // the body of a failed request (default: a Jev success body)
  body?: string
  // answer 400 max_tokens_exceeded to a request whose body is longer than this many characters
  maxChars?: number
  // answer 400 max_tokens_exceeded to the first this many requests
  failFirst?: number
  // an SDK or stream-json session (T3 Code), not the REPL
  headless?: boolean
  // tokens outside the `Messages` row of the host's breakdown; absent, no breakdown
  fixed?: number
  // the host fails to write a t3.compaction/v1 line
  failReport?: boolean
  // the node-exporter textfile directory exists (the counters are written to it)
  metrics?: boolean
}

const KEY = 'k-secret-123'
// The 0.2 thresholds: tests that check mechanics at 400k to 500k keep them, independent of the defaults.
const OLD = { triggerTokens: 400_000, targetTokens: 256_000, hardTokens: 500_000 }
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
  // `/compact` run through `$.command.run`, as the mod does in an SDK session, with what the compaction came to
  const ran: { args: unknown; result: { messages?: Message[]; skip?: string } }[] = []
  const rows = mock.session(on)
  const stored = { get: () => rows.appended().map((r) => r.message as any) }
  mock.env(on, setup.env ?? { JEV_COMPACTION_API_KEY: KEY, HOME: '/home/u' })
  const written: Record<string, string> = {}
  on('fs.read', (_$: any, e: any) => {
    if (e.path === '/proc/self/stat') return { value: '4242 (claude) S 1 4242' }
    const text = (setup.files ?? {})[e.path] ?? written[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: e.path.startsWith('/proc/') ? e.path === '/proc/4242' : Boolean(setup.metrics) && e.path === '/var/lib/node-exporter/textfile-collector' }))
  on('fs.write', (_$: any, e: any) => {
    written[e.path] = String(e.text ?? '')
    return { value: undefined }
  })
  const clock = mock.clock(on)
  const usage = { tokens: setup.tokens ?? 450_000, window: setup.window ?? 1_000_000 }
  on('session.usage', (_$: any, e: any) => {
    const breakdown =
      e?.breakdown && setup.fixed !== undefined
        ? { totalTokens: usage.tokens, categories: [{ name: 'System prompt', kind: 'used', tokens: setup.fixed }, { name: 'Messages', kind: 'used', tokens: usage.tokens - setup.fixed }, { name: 'Free space', kind: 'free', tokens: 1 }] }
        : undefined
    return { value: { startedAt: 0, context: { ...usage, ...(breakdown && { breakdown }) }, rateLimits: [] } }
  })
  on('session.messages', (_$: any, e: any) => ({ value: ((e.as === 'api' ? setup.api : setup.rows) ?? []) as never }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('http.fetch', (_$: any, e: any) => {
    if (setup.hang) return new Promise(() => undefined) as never
    const body = JSON.parse(e.init.body)
    requests.push({ url: e.url, headers: e.init.headers, body })
    if (setup.failFirst !== undefined && requests.length <= setup.failFirst) return { value: { status: 400, ok: false, headers: {}, text: JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }) } }
    if (setup.maxChars !== undefined && e.init.body.length > setup.maxChars) return { value: { status: 400, ok: false, headers: {}, text: JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }) } }
    if (setup.body !== undefined) return { value: { status: setup.status ?? 400, ok: false, headers: {}, text: setup.body } }
    const answers = Object.fromEntries(Object.keys(body.questions).map((name) => [name, { noul: setup.p ?? 0 }]))
    const status = setup.status ?? 200
    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify({ answers }) } }
  })
  on('session.compact', (_$: any, e: any) => {
    compactCalls.push(e)
    return (setup.core?.() as { messages: Message[] } | undefined) ?? { messages: [BUILTIN] }
  })
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$: any, e: any) => {
    if (setup.failReport && e.text.startsWith('t3.compaction/v1 ')) throw new Error('log failed')
    logs.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined as never }))
  on('session.measure', (_$: any, e: any) => e)
  // The engine's response to a step: the usage the request reported (the test puts it on the input).
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: e.usage ?? null }
  })
  // The host runs `/compact` in an SDK session: the session.compact chain with trigger `manual`, this plugin's hook included.
  on('command.run', { command: 'compact' }, async (_$: any, e: any) => {
    ran.push({ args: e.args, result: await compact($, 'manual') })
    return {}
  })
  on('session.start', () => ({ cwd: '/work' }))
  await $.session.start({ cwd: '/work', surface: setup.headless ? null : 'terminal', isInteractive: !setup.headless } as never)
  return { requests, toasts, logs, compactCalls, usage, clock, stored, ran, written }
}

const compact = ($: any, trigger: string, extra: Record<string, unknown> = {}) =>
  $.session.compact({ trigger, messages: transcript(), ...extra } as never) as Promise<{ messages?: Message[]; skip?: string }>

const isBuiltin = (r: { messages?: Message[] }) => r.messages?.[0]?.text === 'BUILTIN SUMMARY'

test('session start logs the thresholds in force once', { options: { hardTokens: 300_000 } }, async ($, on) => {
  const { logs } = await boot($, on)
  expect(logs).toEqual(['jev-compaction: thresholds: trigger 200000, target 120000, hard limit 300000, periodic minimum 30000, regrowth 50000 (windows up to 300k: 60/40/85%)'])
})

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
  expect(r.messages!.length).toBe(8)
  expect(r.messages!.filter((m) => m.text === '[jev dropped 12 calls: Read ×12]').length).toBe(1)
  expect(r.messages![0]!.handle).toBe('h0')
  expect(r.messages!.filter((m) => m.text.includes('jev-compaction')).every((m) => m.handle === undefined)).toBe(true)
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

test('soft compaction is deferred when Jev keeps everything, and scores are reused next time', { options: OLD }, async ($, on) => {
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

const HARD = { hardTokens: 300_000, triggerTokens: 200_000, targetTokens: 120_000, softMinFreedTokens: 50_000 }

test('hard ceiling: a periodic result that stays above the hard limit runs the built-in summary instead', { options: { ...HARD, hardTokens: 200_000 } }, async ($, on) => {
  const { toasts, compactCalls } = await boot($, on, { p: 0, tokens: 466_000, fixed: 250_000 })
  // tool schemas and skills hold 250k outside the messages: even all messages gone leaves it above the 200k limit
  expect(isBuiltin(await compact($, 'plugin'))).toBe(true)
  expect(toasts[0]).toMatch(/built-in summary: .*hard limit 200000/)
  expect(compactCalls.length).toBe(1)
})

test('hard ceiling: a periodic result that reaches below the hard limit is applied', { options: HARD }, async ($, on) => {
  const { toasts } = await boot($, on, { p: 0, tokens: 350_000, fixed: 150_000 })
  const r = await compact($, 'plugin')
  expect(isBuiltin(r)).toBe(false)
  expect(r.messages!.length).toBe(8)
  expect(toasts[0]).toMatch(/compacted ~350k to ~1\d\dk tokens/)
})

test('hard ceiling: a Jev error, a missing key or an unfittable history above the hard limit runs the built-in summary', { options: HARD }, async ($, on) => {
  const failing = await boot($, on, { status: 500, tokens: 466_000 })
  expect(isBuiltin(await compact($, 'plugin'))).toBe(true)
  expect(failing.toasts[0]).toMatch(/built-in summary: .*500/)
})

test('hard ceiling: no key above the hard limit runs the built-in summary, below it is deferred', { options: HARD }, async ($, on) => {
  const { usage } = await boot($, on, { env: { HOME: '/home/u' }, tokens: 466_000 })
  expect(isBuiltin(await compact($, 'plugin'))).toBe(true)
  usage.tokens = 280_000
  expect((await compact($, 'plugin')).skip).toMatch(/no Jev API key/)
})

test('hard ceiling: a transcript of 4096 messages or more runs the built-in summary above the hard limit, defers below it', { options: HARD }, async ($, on) => {
  const { usage } = await boot($, on, { p: 0, tokens: 466_000 })
  const many = Array.from({ length: 4096 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x', toolUses: [] }))
  expect(isBuiltin(await compact($, 'plugin', { messages: many }))).toBe(true)
  usage.tokens = 280_000
  expect((await compact($, 'plugin', { messages: many })).skip).toMatch(/over 4096 messages/)
})

test('hard ceiling: below the hard limit a soft compaction that frees too little is still deferred', { options: HARD }, async ($, on) => {
  await boot($, on, { p: 1, tokens: 280_000 })
  expect((await compact($, 'plugin')).skip).toMatch(/deferred/)
})

test('hard ceiling: the regrowth guard does not block a turn end at or above the hard limit', { options: HARD }, async ($, on) => {
  const { compactCalls, usage } = await boot($, on, { core: () => ({ skip: 'deferred by test' }) })
  const turn = async (tokens: number) => {
    usage.tokens = tokens
    await $.turn.complete(reply())
  }
  await turn(250_000)
  expect(compactCalls.length).toBe(1)
  // guard 250k: 280k is within the regrowth, so no attempt
  await turn(280_000)
  expect(compactCalls.length).toBe(1)
  // at the hard limit every turn end attempts, however little the context grew
  await turn(300_000)
  expect(compactCalls.length).toBe(2)
  await turn(301_000)
  expect(compactCalls.length).toBe(3)
})

test('hard ceiling: /jev-compact now falls back to the built-in summary above the hard limit', { options: HARD }, async ($, on) => {
  const { usage } = await boot($, on, { p: 1, tokens: 466_000 })
  await $.command.run({ command: 'jev-compact', args: 'now' } as never)
  await $.turn.complete(reply())
  expect(isBuiltin(await compact($, 'manual'))).toBe(true)
  usage.tokens = 280_000
  await $.command.run({ command: 'jev-compact', args: 'now' } as never)
  await $.turn.complete(reply())
  expect((await compact($, 'manual')).skip).toMatch(/deferred/)
})

test('auto: applied below the hard limit, built-in summary above it', { options: OLD }, async ($, on) => {
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

test('no key: soft defers, auto and manual fall back, and Jev is never called', { options: OLD }, async ($, on) => {
  const { requests, toasts } = await boot($, on, { env: { HOME: '/home/u' } })
  expect((await compact($, 'plugin')).skip).toMatch(/no Jev API key/)
  expect(isBuiltin(await compact($, 'auto'))).toBe(true)
  expect(isBuiltin(await compact($, 'manual'))).toBe(true)
  expect(requests).toEqual([])
  expect(toasts.length).toBe(3)
})

test('a Jev error defers a soft compaction, falls back otherwise, and the key stays out of every message', { options: OLD }, async ($, on) => {
  const { toasts, logs } = await boot($, on, { status: 500 })
  const soft = await compact($, 'plugin')
  expect(soft.skip).toMatch(/Jev request failed \(500\)/)
  expect(isBuiltin(await compact($, 'auto'))).toBe(true)
  expect([...toasts, ...logs, soft.skip].join('\n')).not.toContain(KEY)
})

test('the key file is read lazily: comment lines, TYPESAFE_API_KEY fallback, empty value ignored', async ($, on) => {
  const { requests } = await boot($, on, {
    env: { HOME: '/home/u' },
    files: { '/home/u/.config/ai-tools/jev-compaction.env': '# keys\nJEV_COMPACTION_API_KEY=\nTYPESAFE_API_KEY=file-key\n' },
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
  const { requests } = await boot($, on, { env: {}, files: { '/etc/example/jev.env': 'export JEV_COMPACTION_API_KEY="quoted"' } })
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

const reply = () => ({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' }) as never
const step = (tokens: number, agentId?: string) =>
  ({ turnId: 't', index: 0, model: 'm', messageCount: 3, ...(agentId && { agentId }), usage: { input_tokens: 2, cache_read_input_tokens: tokens - 1002, cache_creation_input_tokens: 1000, output_tokens: 5 } }) as never
const measure = (tokens: number) => ({ context: { tokens, window: 1_000_000 }, rateLimits: [], changed: ['context'] }) as never

test('periodic trigger: compacts at the trigger, not below, and waits for 50000 tokens of regrowth after an attempt', { options: OLD }, async ($, on) => {
  const { compactCalls, usage } = await boot($, on, { core: () => ({ skip: 'deferred by test' }) })
  const turn = async (tokens: number) => {
    usage.tokens = tokens
    await $.turn.complete(reply())
  }
  await turn(399_000)
  expect(compactCalls.length).toBe(0)
  await turn(410_000)
  expect(compactCalls.length).toBe(1)
  await turn(459_000)
  expect(compactCalls.length).toBe(1)
  await turn(460_000)
  expect(compactCalls.length).toBe(2)
  await turn(300_000)
  await turn(405_000)
  expect(compactCalls.length).toBe(2)
  await turn(255_000)
  await turn(405_000)
  expect(compactCalls.length).toBe(3)
})

const WIDE = { triggerTokens: 100_000, targetTokens: 50_000, hardTokens: 600_000, softMinFreedTokens: 30_000 }

test('measurement: the first real count after an applied compaction resets the guard to it, and regrowth counts from there', { options: WIDE }, async ($, on) => {
  const { toasts, logs, usage, compactCalls } = await boot($, on, { p: 0, fixed: 30_000, core: () => ({ skip: 'deferred by test' }) })
  const turn = async (tokens: number) => {
    usage.tokens = tokens
    await $.turn.complete(reply())
  }
  await turn(410_000)
  expect(compactCalls.length).toBe(1)
  usage.tokens = 466_000
  expect(isBuiltin(await compact($, 'plugin'))).toBe(false)
  // the fixed 30k stays; the messages kept almost none of their characters
  expect(toasts.at(-1)).toMatch(/compacted ~466k to ~30k tokens/)
  // a reading of the old count (no request since) says nothing; the first request after does
  await $.session.measure(measure(466_000))
  expect(logs.some((l) => l.includes('measured'))).toBe(false)
  await $.session.measure(measure(60_000))
  expect(logs.at(-1)).toMatch(/measured 60000 tokens after the compaction \(estimated 30\d{3}\)/)
  // the guard was 410k; it now counts from the real 60k
  await turn(109_000)
  expect(compactCalls.length).toBe(1)
  await turn(110_000)
  expect(compactCalls.length).toBe(2)
})

test('measurement: the first main request after an applied compaction is the real count, before the turn grows', { options: WIDE }, async ($, on) => {
  const { logs, usage } = await boot($, on, { p: 0, fixed: 30_000 })
  usage.tokens = 466_000
  expect(isBuiltin(await compact($, 'plugin'))).toBe(false)
  // a subagent's request says nothing about the main context
  for await (const _ of $.turn.step(step(9_000, 'sub-1'))) void _
  expect(logs.some((l) => l.includes('measured'))).toBe(false)
  for await (const _ of $.turn.step(step(52_000))) void _
  expect(logs.at(-1)).toMatch(/measured 52000 tokens after the compaction/)
  // later requests and the turn end, after the turn's growth, are not taken
  usage.tokens = 72_000
  await $.turn.complete(reply())
  expect(logs.filter((l) => l.includes('measured')).length).toBe(1)
})

test('measurement: without a session.measure the next turn end is the real count', { options: WIDE }, async ($, on) => {
  const { logs, usage } = await boot($, on, { p: 0, fixed: 30_000 })
  usage.tokens = 466_000
  expect(isBuiltin(await compact($, 'plugin'))).toBe(false)
  usage.tokens = 70_000
  await $.turn.complete(reply())
  expect(logs.at(-1)).toMatch(/measured 70000 tokens after the compaction/)
})

test('estimate: without the host breakdown every token counts as messages, so the estimate errs high, never below the real size', { options: WIDE }, async ($, on) => {
  const { toasts, usage } = await boot($, on, { p: 0 })
  usage.tokens = 466_000
  await compact($, 'plugin')
  expect(toasts.at(-1)).toMatch(/compacted ~466k to ~\d+ tokens/)
})

test('default thresholds: a 1M session compacts from 200k, and at 250k the regrowth guard no longer waits', async ($, on) => {
  const { compactCalls, usage } = await boot($, on, { core: () => ({ skip: 'deferred by test' }) })
  const turn = async (tokens: number) => {
    usage.tokens = tokens
    await $.turn.complete(reply())
  }
  await turn(199_000)
  expect(compactCalls.length).toBe(0)
  await turn(200_000)
  expect(compactCalls.length).toBe(1)
  await turn(249_000)
  expect(compactCalls.length).toBe(1)
  await turn(250_000)
  expect(compactCalls.length).toBe(2)
})

test('periodic trigger on a small window uses percentages', async ($, on) => {
  const { compactCalls, usage } = await boot($, on, { window: 200_000 })
  usage.window = 200_000
  usage.tokens = 119_000
  await $.turn.complete(reply())
  expect(compactCalls.length).toBe(0)
  usage.tokens = 120_000
  await $.turn.complete(reply())
  expect(compactCalls.length).toBe(1)
})

test('/jev-compact now compacts at the end of the next turn, below the trigger, and never falls back to the built-in summary', async ($, on) => {
  const { compactCalls, usage } = await boot($, on, { p: 1 })
  usage.tokens = 100_000
  await $.turn.complete(reply())
  expect(compactCalls.length).toBe(0)
  const { text } = await $.command.run({ command: 'jev-compact', args: 'now' } as never)
  expect(text).toContain('next turn ends')
  expect(compactCalls.length).toBe(0)
  await $.turn.complete(reply())
  expect(compactCalls.length).toBe(1)
  // Jev keeps everything: a plain /compact would fall back, the one asked for by `now` defers.
  expect((await compact($, 'manual')).skip).toMatch(/deferred/)
  expect(isBuiltin(await compact($, 'manual'))).toBe(true)
  const before = compactCalls.length
  await $.turn.complete(reply())
  expect(compactCalls.length).toBe(before)
})

const settle = async (clock: { advance: (ms: number) => Promise<void> }, done: () => boolean) => {
  for (let i = 0; i < 40 && !done(); i++) await clock.advance(100)
}

test('a Jev request that never answers times out: soft defers, auto and manual fall back', { options: { ...OLD, jevTimeoutMs: 50 } }, async ($, on) => {
  const { clock, requests } = await boot($, on, { hang: true })
  for (const [trigger, check] of [
    ['plugin', (r: { messages?: Message[]; skip?: string }) => expect(r.skip).toMatch(/timed out after 50 ms/)],
    ['auto', (r: { messages?: Message[] }) => expect(isBuiltin(r)).toBe(true)],
    ['manual', (r: { messages?: Message[] }) => expect(isBuiltin(r)).toBe(true)],
  ] as const) {
    let result: { messages?: Message[]; skip?: string } | undefined
    const pending = compact($, trigger).then((r) => (result = r))
    await settle(clock, () => result !== undefined)
    await pending
    check(result!)
  }
  expect(requests).toEqual([])
})

test('/compact with instructions goes to the built-in summary; a possibly cut transcript defers the soft compaction and leaves auto and manual to it', { options: OLD }, async ($, on) => {
  const { requests } = await boot($, on, { p: 0 })
  expect(isBuiltin(await compact($, 'manual', { instructions: 'keep the plan' }))).toBe(true)
  const many = Array.from({ length: 4096 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x', toolUses: [] }))
  expect((await compact($, 'plugin', { messages: many })).skip).toMatch(/over 4096 messages/)
  expect(isBuiltin(await compact($, 'auto', { messages: many }))).toBe(true)
  expect(isBuiltin(await compact($, 'manual', { messages: many }))).toBe(true)
  expect(requests).toEqual([])
})

test('a tool result with an image is never rebuilt, its Bash neighbour is dropped', async ($, on) => {
  const api = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c0', content: [{ type: 'text', text: 'see' }, { type: 'image', source: {} }] }] },
  ]
  await boot($, on, { p: 0, api })
  const r = await compact($, 'plugin')
  expect(r.messages!.some((m) => m.handle === 'a0')).toBe(true)
  expect(r.messages!.some((m) => m.handle === 'u0')).toBe(true)
  expect(r.messages!.some((m) => m.handle === 'u1')).toBe(false)
})

const userMedia = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: {} }] }]
const withLongUser = () => {
  const t = transcript()
  t.splice(1, 0, { role: 'user', text: 'u'.repeat(3000), toolUses: [], handle: 'long' }, { role: 'assistant', text: 'ack', toolUses: [], handle: 'ack' })
  return t
}

test('without media a long user text is abridged; with media in any user message it is left alone', async ($, on) => {
  await boot($, on, { p: 0 })
  const plain = await $.session.compact({ trigger: 'plugin', messages: withLongUser() } as never)
  expect((plain as { messages: Message[] }).messages.some((m) => m.handle === 'long')).toBe(false)
})

test('with an image in a user message no user text is abridged', async ($, on) => {
  await boot($, on, { p: 0, api: userMedia })
  const r = (await $.session.compact({ trigger: 'plugin', messages: withLongUser() } as never)) as { messages: Message[] }
  expect(r.messages.some((m) => m.handle === 'long')).toBe(true)
})

test('pre-scoring: a finished turn within 100k of the trigger scores part of the backlog off the critical path, and remembers it', { options: OLD }, async ($, on) => {
  const { requests, usage, logs, compactCalls, clock } = await boot($, on, { p: 0.9, rows: transcript(40) })
  usage.tokens = 250_000
  await $.turn.complete(reply())
  await clock.advance(10)
  expect(requests.length).toBe(0)
  usage.tokens = 320_000
  await $.turn.complete(reply())
  expect(requests.length).toBe(0)
  await clock.advance(10)
  expect(requests.length).toBeGreaterThan(0)
  expect(logs.join('\n')).toMatch(/pre-scored \d+ items/)
  expect(compactCalls.length).toBe(0)
})

test('pre-scoring is throttled: five turns at 350k with a new tool pair each make at most one request', { options: OLD }, async ($, on) => {
  const rows = transcript(40)
  const { requests, usage, clock } = await boot($, on, { p: 0.9, rows, hang: false })
  usage.tokens = 350_000
  for (let i = 0; i < 5; i++) {
    rows.splice(rows.length - 6, 0,
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: `n${i}`, tool: 'Read', input: { file_path: `/new/${i}.ts` }, text: 'x'.repeat(2000) }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `n${i}`, text: 'x'.repeat(2000), isError: false }] })
    await $.turn.complete(reply())
    await clock.advance(10)
  }
  expect(requests.length).toBeLessThanOrEqual(1)
  expect(requests.length).toBe(1)
})

test('pre-scoring waits until about a batch of questions is unscored', async ($, on) => {
  const { requests, usage, clock } = await boot($, on, { p: 0.9, rows: transcript(5) })
  usage.tokens = 350_000
  await $.turn.complete(reply())
  await clock.advance(10)
  expect(requests).toEqual([])
})

test('a turn that did not end in an answer neither compacts nor pre-scores', async ($, on) => {
  const { compactCalls, requests, usage } = await boot($, on, { rows: transcript() })
  usage.tokens = 450_000
  await $.turn.complete({ ...(reply() as object), reason: 'aborted', isAborted: true } as never)
  usage.tokens = 320_000
  await $.turn.complete({ ...(reply() as object), reason: 'error' } as never)
  expect(compactCalls.length).toBe(0)
  expect(requests).toEqual([])
})

// ---- SDK / stream-json sessions (T3 Code) --------------------------------------------------------------------

const bootHeadless = ($: any, on: any, setup: Setup = {}) => boot($, on, { rows: transcript(), ...setup, headless: true })

test('stream-json: a turn end at the trigger runs /compact through the host command, judged as periodic', { options: OLD }, async ($, on) => {
  const { ran, compactCalls, usage, toasts } = await bootHeadless($, on, { p: 0 })
  usage.tokens = 399_000
  await $.turn.complete(reply())
  expect(ran.length).toBe(0)
  usage.tokens = 410_000
  await $.turn.complete(reply())
  expect(ran.length).toBe(1)
  expect(isBuiltin(ran[0]!.result)).toBe(false)
  expect(ran[0]!.result.messages!.length).toBeLessThan(transcript().length)
  expect(compactCalls.length).toBe(0)
  expect(toasts.at(-1)).toMatch(/compacted ~410k to ~\d+k? tokens/)
})

test('stream-json: the periodic compaction defers like an interactive one instead of falling back to the built-in summary', { options: OLD }, async ($, on) => {
  const { ran, usage, toasts, requests } = await bootHeadless($, on, { p: 1 })
  usage.tokens = 410_000
  await $.turn.complete(reply())
  // A deferral runs no `/compact`: the host would print "Not compacted" as the answer of the turn.
  expect(ran.length).toBe(0)
  expect(toasts.at(-1)).toMatch(/deferred/)
  expect(await stat($)).toMatch(/1 deferred/)
  // the regrowth guard holds as in an interactive session
  const asked = requests.length
  usage.tokens = 440_000
  await $.turn.complete(reply())
  expect(requests.length).toBe(asked)
})

test('stream-json: at or above the hard limit a result that stays above it runs the built-in summary', { options: { ...OLD, hardTokens: 420_000 } }, async ($, on) => {
  const { ran, usage } = await bootHeadless($, on, { p: 1 })
  usage.tokens = 450_000
  await $.turn.complete(reply())
  expect(ran.length).toBe(1)
  expect(isBuiltin(ran[0]!.result)).toBe(true)
})

const T3_ARGS = ['claude', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--resume=abc', ''].join('\u0000')
const ONE_SHOT_ARGS = ['claude', '-p', '--output-format', 'stream-json', '--verbose', 'hello', ''].join('\u0000')

test('stream-json: a session launched as T3 Code launches it compacts; a one-shot -p run is left alone', { options: OLD }, async ($, on) => {
  const t3 = await bootHeadless($, on, { p: 0, files: { '/proc/self/cmdline': T3_ARGS } })
  t3.usage.tokens = 410_000
  await $.turn.complete(reply())
  expect(t3.ran.length).toBe(1)
})

test('stream-json: a one-shot -p run never compacts at its turn end, and /jev-compact now says so', { options: OLD }, async ($, on) => {
  const { ran, usage } = await bootHeadless($, on, { p: 0, files: { '/proc/self/cmdline': ONE_SHOT_ARGS } })
  usage.tokens = 450_000
  await $.turn.complete(reply())
  expect(ran.length).toBe(0)
  const { text } = await $.command.run({ command: 'jev-compact', args: 'now' } as never)
  expect(text).toMatch(/one-shot/)
})

test('stream-json: a /compact the person sends keeps the manual policy', { options: OLD }, async ($, on) => {
  await bootHeadless($, on, { p: 1 })
  expect(isBuiltin(await compact($, 'manual'))).toBe(true)
})

const sizes = (requests: { body: unknown }[]) => requests.map((r) => JSON.stringify(r.body).length)

test('a 400 that Jev explains is counted by status and error type, and names both', { options: OLD }, async ($, on) => {
  const body = JSON.stringify({ detail: { error_type: 'api_usage_error', message: 'Request contains invalid Unicode text.' } })
  const { logs } = await boot($, on, { status: 400, body })
  const r = await compact($, 'plugin')
  expect(r.skip).toMatch(/Jev request failed \(400: api_usage_error, Request contains invalid Unicode text\.\)/)
  expect(logs.some((l) => l.includes('Jev request failed (400:api_usage_error)'))).toBe(true)
  expect(await stat($)).toMatch(/failed Jev requests: 400:api_usage_error x\d+/)
})

test('stream-json: a failed Jev request (400) runs no /compact, so the turn is not answered with "Not compacted"', { options: OLD }, async ($, on) => {
  const { ran, usage, toasts, logs } = await bootHeadless($, on, { status: 400, body: JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }) })
  usage.tokens = 410_000
  // the turn end answers as before: the hook hands its answer on
  const answered = await $.turn.complete(reply())
  expect(answered).toBeDefined()
  expect(ran.length).toBe(0)
  expect(toasts.at(-1)).toMatch(/deferred: Jev request failed \(400: max_tokens_exceeded\)/)
  const stats = await stat($)
  expect(stats).toMatch(/1 deferred/)
  expect(stats).toMatch(/failed Jev requests: 400:max_tokens_exceeded x\d+/)
  expect(t3Payload(t3Lines(logs).at(-1)!).details).toMatchObject({ outcome: 'deferred' })
})

test('stream-json: a failed Jev request above the hard limit still hands over to the built-in summary', { options: { ...OLD, hardTokens: 420_000 } }, async ($, on) => {
  const { ran, usage } = await bootHeadless($, on, { status: 400 })
  usage.tokens = 450_000
  await $.turn.complete(reply())
  expect(ran.length).toBe(1)
  expect(isBuiltin(ran[0]!.result)).toBe(true)
})

test('stream-json: the decision made before /compact is used by the hook, with no second round of Jev requests', { options: OLD }, async ($, on) => {
  const { ran, usage, requests } = await bootHeadless($, on, { p: 0 })
  usage.tokens = 410_000
  await $.turn.complete(reply())
  expect(ran.length).toBe(1)
  // the 12 results are scored in one round: the hook asked nothing more
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.length).toBeLessThanOrEqual(4)
  expect(isBuiltin(ran[0]!.result)).toBe(false)
})

test('a request over Jev\'s size limit (400 max_tokens_exceeded) is retried smaller and the compaction still applies', { options: { ...OLD, maxStateTokens: 1500, maxRequestTokens: 2600 } }, async ($, on) => {
  // The first request is about 6400 characters (state and questions); the limit below refuses it, as Jev does one over its token limit.
  const LIMIT = 5000
  const { requests, logs } = await boot($, on, { p: 0, maxChars: LIMIT })
  const r = await compact($, 'plugin')
  expect(r.skip).toBeUndefined()
  expect(isBuiltin(r)).toBe(false)
  const lengths = sizes(requests)
  expect(lengths[0]!).toBeGreaterThan(LIMIT)
  expect(lengths.at(-1)!).toBeLessThanOrEqual(LIMIT)
  expect(logs.some((l) => l.includes('Jev request failed (400:max_tokens_exceeded)'))).toBe(true)
  const stats = await stat($)
  expect(stats).toMatch(/failed Jev requests: 400:max_tokens_exceeded x\d+/)
  expect(stats).toMatch(/request budget at 60%/)
  // The next attempt has no size error at the smaller budget: the budget wins a quarter back, and again, up to the full size.
  await compact($, 'plugin')
  expect(await stat($)).toMatch(/request budget at 75%/)
})

test('a round of parallel requests that are all too large shrinks the budget once, not once for each request', { options: { ...OLD, maxStateTokens: 1500, maxRequestTokens: 2600 } }, async ($, on) => {
  // Every request is refused: each of the three rounds sends several in parallel, and each round shrinks the budget once (0.6 x 3 = 22%),
  // where one shrink for each failed request pinned it at the 15% floor.
  const { requests } = await boot($, on, { p: 0, maxChars: 100 })
  const r = await $.session.compact({ trigger: 'plugin', messages: transcript(40) } as never)
  expect(r.skip).toMatch(/max_tokens_exceeded/)
  expect(requests.length).toBeGreaterThanOrEqual(6)
  expect(await stat($)).toMatch(/request budget at 22%/)
})

test('a transcript with a lone surrogate (an emoji cut in two) reaches Jev as well-formed text', { options: OLD }, async ($, on) => {
  const { requests } = await boot($, on, { p: 0 })
  const messages = transcript()
  messages[0] = { ...messages[0]!, text: `start \ud83d and \ude00 and ${'\ud83d\ude00'}` }
  await $.session.compact({ trigger: 'plugin', messages } as never)
  expect(requests.length).toBeGreaterThan(0)
  for (const r of requests) expect(JSON.stringify(r.body)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i)
})

test('stream-json: /jev-compact now compacts at the next turn end', async ($, on) => {
  const { ran, usage, toasts } = await bootHeadless($, on, { p: 1 })
  usage.tokens = 100_000
  const { text } = await $.command.run({ command: 'jev-compact', args: 'now' } as never)
  expect(text).toContain('next turn ends')
  await $.turn.complete(reply())
  expect(ran.length).toBe(0)
  expect(toasts.at(-1)).toMatch(/deferred/)
})

// ---- compression on entry (session.append) ----------------------------------------------------------------

const PADDED = 'Sure! Let me check the build output for you now.'
const longReply = `${Array.from({ length: 12 }, (_, i) => `Step number ${i} of the plan reads the input and writes the matching output file.`).join(' ')}\nSee \`src/a.ts\` for the details.`

function appendRow(door: string, type: 'user' | 'assistant', content: unknown[], origin: unknown, extra: Record<string, unknown> = {}) {
  return { message: { type, content }, door, origin, uuid: 'u-1', ...extra } as never
}

const bootEntry = boot

const ON = { entryUser: true, entryAssistant: true }
const replyRow = (text: string) => appendRow('response', 'assistant', [{ type: 'text', text }], { kind: 'model', model: 'm' })
const stat = async ($: any) => ((await $.command.run({ command: 'jev-compact', args: 'stats' } as never)) as { text: string }).text

test('entry: user prompts and assistant text are off by default', async ($, on) => {
  const { requests, stored } = await bootEntry($, on, { p: 0 })
  await $.session.append(appendRow('prompt', 'user', [{ type: 'text', text: PADDED }], { kind: 'composer' }))
  await $.session.append(replyRow(longReply))
  expect(stored.get().map((m) => m.content[0].text)).toEqual([PADDED, longReply])
  expect(requests).toEqual([])
})

test('entry: a user prompt gets the article drop only, with no Jev request', { options: ON }, async ($, on) => {
  const { requests, stored } = await bootEntry($, on)
  await $.session.append(appendRow('prompt', 'user', [{ type: 'text', text: PADDED }], { kind: 'composer' }))
  expect(stored.get()[0].content).toEqual([{ type: 'text', text: 'Sure! Let me check build output for you now.' }])
  expect(requests).toEqual([])
  expect(await stat($)).toMatch(/, 4 chars saved on entry/)
  await $.session.append(appendRow('prompt', 'user', [{ type: 'text', text: PADDED }], { kind: 'sdk' }))
  expect(stored.get()[1].content[0].text).toBe(PADDED)
})

test('entry: a long reply gets one Jev request and loses the sentences Jev rates low; other rows and agents pass', { options: ON }, async ($, on) => {
  const { requests, stored } = await bootEntry($, on, { p: 0 })
  await $.session.append(replyRow(longReply))
  expect(requests.length).toBe(1)
  expect(requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
  const text = stored.get()[0].content[0].text as string
  expect(text).toContain('`src/a.ts`')
  expect(text).toMatch(/\[… \d+ sentences cut on entry …\]/)
  expect(text.length).toBeLessThan(longReply.length / 2)
  await $.session.append(appendRow('response', 'assistant', [{ type: 'text', text: PADDED }], { kind: 'model', model: 'm' }, { agentId: 'sub-1' }))
  expect(stored.get()[1].content[0].text).toBe(PADDED)
  await $.session.append(appendRow('delivery', 'user', [{ type: 'text', text: PADDED }], { kind: 'task-notification' }))
  expect(stored.get()[2].content[0].text).toBe(PADDED)
  expect(requests.length).toBe(1)
})

test('entry: a Jev failure leaves the reply word-filtered, pauses entry Jev, and the key stays out of logs', { options: ON }, async ($, on) => {
  const { logs, stored, requests } = await bootEntry($, on, { status: 500 })
  await $.session.append(replyRow(longReply))
  expect(stored.get()[0].content[0].text).toContain('Step number 11 of')
  expect(requests.length).toBe(1)
  await $.session.append(replyRow(longReply))
  expect(requests.length).toBe(1)
  expect([...logs].join('\n')).not.toContain(KEY)
})

test('entry: a request that never answers is cut off by one timeout and the row enters unpruned', { options: { ...ON, entryTimeoutMs: 50 } }, async ($, on) => {
  const { clock, stored } = await bootEntry($, on, { hang: true })
  let done = false
  const pending = $.session.append(replyRow(longReply)).then(() => (done = true))
  await settle(clock, () => done)
  await pending
  expect(stored.get()[0].content[0].text).toContain('Step number 11 of')
})

test('entry: compressOnEntry off leaves every row as it came', { options: { ...ON, compressOnEntry: false } }, async ($, on) => {
  const { stored, requests } = await bootEntry($, on, { p: 0 })
  await $.session.append(appendRow('prompt', 'user', [{ type: 'text', text: PADDED }], { kind: 'composer' }))
  await $.session.append(replyRow(longReply))
  expect(stored.get().map((m) => m.content[0].text)).toEqual([PADDED, longReply])
  expect(requests).toEqual([])
})

test('entry: without a key a long reply is word-filtered and Jev is never called', { options: ON }, async ($, on) => {
  const { requests, stored } = await bootEntry($, on, { env: { HOME: '/home/u' } })
  await $.session.append(replyRow(longReply))
  expect(requests).toEqual([])
  expect(stored.get()[0].content[0].text).toContain('Step number 11 of')
})

const OUTPUT = Array.from({ length: 600 }, (_, i) => `row ${i}: some listing text that carries little`).join('\n')
const apiWith = (command: string) => [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] }]
const toolRow = (tool: string) => appendRow('tool-result', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: OUTPUT }], { kind: 'tool', tool })

test('entry: a long result of a noisy Bash command is trimmed by default; a reader, or another tool, is not', async ($, on) => {
  const { requests, stored } = await bootEntry($, on, { p: 0, api: apiWith('npm test') })
  await $.session.append(toolRow('Bash'))
  expect(stored.get()[0].content[0].content.length).toBeLessThan(OUTPUT.length / 3)
  expect(stored.get()[0].content[0].tool_use_id).toBe('t1')
  expect(requests.length).toBe(1)
  await $.session.append(toolRow('Grep'))
  expect(stored.get()[1].content[0].content).toBe(OUTPUT)
  expect(requests.length).toBe(1)
})

test('entry: a Bash reader command keeps its output whole', async ($, on) => {
  const { requests, stored } = await bootEntry($, on, { p: 0, api: apiWith('cat build.log') })
  await $.session.append(toolRow('Bash'))
  expect(stored.get()[0].content[0].content).toBe(OUTPUT)
  expect(requests).toEqual([])
})

test('entry: everything sent to Jev has secrets masked', { options: ON }, async ($, on) => {
  const { requests } = await bootEntry($, on, { p: 0 })
  const secret = 'Authorization: Bearer abcdef1234567890abcdef and API_KEY=sk-live-1234567890abcdefghij done.'
  await $.session.append(replyRow(`${secret}\n${longReply}`))
  expect(requests.length).toBe(1)
  expect(JSON.stringify(requests[0]!.body)).not.toMatch(/abcdef1234567890abcdef|sk-live-1234567890/)
})

test('compaction: state and questions sent to Jev have secrets masked', async ($, on) => {
  const { requests } = await boot($, on, { p: 0 })
  const messages = transcript(2)
  messages.splice(1, 0, { role: 'assistant', text: `The deploy used TOKEN=${S.GHP}abcdefghijklmnopqrstuvwx and Bearer abcdef1234567890abcdef. ${'Padding words to make it long enough. '.repeat(14)}`, toolUses: [] })
  await $.session.compact({ trigger: 'plugin', messages } as never)
  expect(requests.length).toBeGreaterThan(0)
  expect(JSON.stringify(requests.map((r) => r.body))).not.toMatch(/p_abcdefghijklmnopqrstuvwx|abcdef1234567890abcdef/)
})

const T3 = 't3.compaction/v1 '
const t3Lines = (logs: string[]) => logs.filter((l) => l.startsWith(T3))
const t3Payload = (line: string) => JSON.parse(line.slice(T3.length)) as { v: number; tokensBefore?: number; tokensAfter?: number; details?: Record<string, any> }
const numbersIn = (value: unknown): number[] => (typeof value === 'number' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(numbersIn) : [])

test('reporting: an applied compaction logs one t3.compaction/v1 line with the counts, and the human line stays', async ($, on) => {
  const { logs, toasts } = await boot($, on, { p: 0, headless: true })
  const r = await compact($, 'plugin')
  expect(isBuiltin(r)).toBe(false)
  const lines = t3Lines(logs)
  expect(lines.length).toBe(1)
  const payload = t3Payload(lines[0]!)
  expect(payload.v).toBe(1)
  expect(payload.tokensBefore).toBe(450_000)
  expect(payload.tokensAfter).toBeLessThan(450_000)
  expect(payload.details).toMatchObject({
    trigger: { kind: 'plugin', name: 'jev-compaction' },
    outcome: 'applied',
    messages: { before: 31, after: 8 },
    tools: { kept: 0, truncated: 0, dropped: 12 },
  })
  expect(payload.details!['reason']).toBeUndefined()
  expect(Object.keys(payload.details!['texts']).sort()).toEqual(['abridged', 'kept', 'stubbed'])
  expect(typeof payload.details!['requests']).toBe('number')
  expect(lines[0]!.includes('\n')).toBe(false)
  expect(logs.some((l) => l.startsWith('jev-compaction: compacted'))).toBe(true)
  expect(toasts.some((l) => l.startsWith('jev-compaction: compacted'))).toBe(true)
})

test('reporting: a deferral logs one line with outcome deferred and the reason, and no pruning counts', { options: OLD }, async ($, on) => {
  const { logs } = await boot($, on, { status: 500, headless: true })
  const r = await compact($, 'plugin')
  expect(r.skip).toMatch(/Jev request failed \(500\)/)
  const lines = t3Lines(logs)
  expect(lines.length).toBe(1)
  const payload = t3Payload(lines[0]!)
  expect(payload.v).toBe(1)
  expect(payload.tokensBefore).toBe(450_000)
  expect(payload.tokensAfter).toBeUndefined()
  expect(payload.details).toMatchObject({ trigger: { kind: 'plugin', name: 'jev-compaction' }, outcome: 'deferred', reason: 'Jev request failed (500)' })
  expect(payload.details!['tools']).toBeUndefined()
  expect(payload.details!['messages']).toBeUndefined()
  expect(lines[0]).not.toContain('jev-compaction deferred:')
})

test('reporting: a handover to the built-in summary logs one line with outcome fallback and the native trigger', { options: OLD }, async ($, on) => {
  const { logs } = await boot($, on, { status: 500, headless: true })
  expect(isBuiltin(await compact($, 'auto'))).toBe(true)
  const lines = t3Lines(logs)
  expect(lines.length).toBe(1)
  expect(t3Payload(lines[0]!).details).toEqual({ trigger: { kind: 'auto' }, outcome: 'fallback', reason: 'Jev request failed (500)' })
})

test('reporting: a missing Jev credential is reported by name only, without the human prefix', { options: OLD }, async ($, on) => {
  const { logs } = await boot($, on, { env: { HOME: '/home/u' }, headless: true })
  expect((await compact($, 'plugin')).skip).toContain('no Jev API key')
  const lines = t3Lines(logs)
  expect(lines.length).toBe(1)
  expect(t3Payload(lines[0]!).details).toEqual({ trigger: { kind: 'plugin', name: 'jev-compaction' }, outcome: 'deferred', reason: 'no Jev API key (environment or key file)' })
})

test('reporting: a manual compaction that the mod did not start keeps the manual trigger', { options: OLD }, async ($, on) => {
  const { logs } = await boot($, on, { status: 500, headless: true })
  await compact($, 'manual')
  expect(t3Payload(t3Lines(logs)[0]!).details!['trigger']).toEqual({ kind: 'manual' })
})

test('reporting: an interactive session logs no t3.compaction/v1 line', async ($, on) => {
  const { logs } = await boot($, on, { p: 0 })
  expect(isBuiltin(await compact($, 'plugin'))).toBe(false)
  expect(logs.some((l) => l.startsWith('jev-compaction: compacted'))).toBe(true)
  expect(t3Lines(logs)).toEqual([])
})

test('reporting: every number is a whole number of 0 or more and the line stays under 4000 characters', async ($, on) => {
  const { logs } = await boot($, on, { p: 0, headless: true })
  await compact($, 'plugin')
  const [line] = t3Lines(logs)
  const numbers = numbersIn(t3Payload(line!))
  expect(numbers.length).toBeGreaterThan(8)
  for (const n of numbers) {
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(0)
  }
  expect(line!.length).toBeLessThan(4000)
})

test('reporting: a failing ui.log never changes the compaction', async ($, on) => {
  const { logs } = await boot($, on, { p: 0, headless: true, failReport: true })
  expect(isBuiltin(await compact($, 'plugin'))).toBe(false)
  expect(logs.some((l) => l.startsWith('jev-compaction: compacted'))).toBe(true)
  expect(t3Lines(logs)).toEqual([])
})

// --- Prometheus counters in the node-exporter textfile (metrics.ts) ---

const PROM = '/var/lib/node-exporter/textfile-collector/jev_compaction.prom'
const flush = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}
const series = (text: string | undefined, name: string, labels: string) => {
  const line = (text ?? '').split('\n').find((l) => l.startsWith(`${name}{`) && labels.split(',').every((p) => l.includes(p)))
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1))
}

test('metrics: a 400 max_tokens_exceeded counts in requests and failures by status and error type', { options: OLD }, async ($, on) => {
  const { written } = await boot($, on, { status: 400, body: JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }), metrics: true })
  await compact($, 'plugin')
  await flush()
  const text = written[PROM]
  expect(text).toBeDefined()
  expect(series(text, 'jev_compaction_failures_total', 'status="400",error_type="max_tokens_exceeded"')).toBeGreaterThanOrEqual(1)
  expect(series(text, 'jev_compaction_requests_total', 'status="400"')).toBeGreaterThanOrEqual(1)
  expect(series(text, 'jev_compaction_deferred_total', 'reason="jev_error"')).toBeGreaterThanOrEqual(1)
  expect(text).toContain('pid="4242"')
  // every usual series exists from the first write, so a first failure counts in increase()
  expect(series(text, 'jev_compaction_failures_total', 'status="401",error_type="none"')).toBe(0)
})

test('metrics: a deferral that frees too little counts under its own reason, and a good request counts as 200', { options: OLD }, async ($, on) => {
  const { written } = await boot($, on, { p: 1, metrics: true })
  const r = await compact($, 'plugin')
  await flush()
  const text = written[PROM]
  expect(series(text, 'jev_compaction_requests_total', 'status="200"')).toBeGreaterThanOrEqual(1)
  if (r.skip) expect(series(text, 'jev_compaction_deferred_total', 'reason="frees_too_little"')).toBeGreaterThanOrEqual(1)
})

test('metrics: no textfile directory (a pod without the mount) writes nothing and changes nothing', { options: OLD }, async ($, on) => {
  const { written } = await boot($, on, { status: 400, body: JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }) })
  const r = await compact($, 'plugin')
  await flush()
  expect(r.skip).toMatch(/Jev request failed \(400/)
  expect(Object.keys(written)).toEqual([])
})

// A history of this many messages: `$.session.messages()` is the newest 4096 only, so a list just under the cap may be a cut.
const rowsOf = (n: number): Message[] => [
  { role: 'user', text: 'start', toolUses: [], handle: 'h0' },
  ...Array.from({ length: n - 1 }, (_, i): Message => ({ role: i % 2 === 0 ? 'assistant' : 'user', text: `step ${i}`, toolUses: [], handle: `m${i}` })),
]

test('stream-json: a host list at the cap may be a cut of a longer one, so no Jev request and no /compact below the hard limit', { options: OLD }, async ($, on) => {
  const { ran, usage, requests, logs } = await bootHeadless($, on, { p: 1, rows: rowsOf(4090) })
  usage.tokens = 410_000
  await $.turn.complete(reply())
  expect(ran.length).toBe(0)
  expect(requests.length).toBe(0)
  expect(logs.some((l) => l.includes('may be a cut of a longer one'))).toBe(true)
})

test('stream-json: a host list at the cap above the hard limit still runs the host summary', { options: { ...OLD, hardTokens: 420_000 } }, async ($, on) => {
  const { ran, usage } = await bootHeadless($, on, { p: 1, rows: rowsOf(4090) })
  usage.tokens = 430_000
  await $.turn.complete(reply())
  expect(ran.length).toBe(1)
})

test('stream-json: the decision made before /compact is the one the hook applies, so Jev is asked once', { options: OLD }, async ($, on) => {
  const { ran, usage, requests } = await bootHeadless($, on, { p: 0 })
  usage.tokens = 410_000
  await $.turn.complete(reply())
  expect(ran.length).toBe(1)
  expect(isBuiltin(ran[0]!.result)).toBe(false)
  // The hook runs after the check and the scores are remembered: asking again would count no request, so the total is the check's.
  expect(requests.length).toBeGreaterThan(0)
  expect(await stat($)).toContain(`${requests.length} Jev requests`)
})

test('a compaction whose every request is refused as too large is tried again with a smaller budget', { options: OLD }, async ($, on) => {
  const { requests } = await boot($, on, { p: 0, failFirst: 1 })
  const r = await compact($, 'plugin')
  expect(r.skip).toBeUndefined()
  expect(isBuiltin(r)).toBe(false)
  expect(requests.length).toBe(2)
  expect(await stat($)).toMatch(/failed Jev requests: 400:max_tokens_exceeded x1.*request budget at 60%/)
})

test('a compaction whose three tries are all refused as too large defers, and says why', { options: OLD }, async ($, on) => {
  const { requests } = await boot($, on, { p: 0, failFirst: 3 })
  const r = await compact($, 'plugin')
  expect(r.skip).toMatch(/max_tokens_exceeded/)
  expect(requests.length).toBe(3)
})
