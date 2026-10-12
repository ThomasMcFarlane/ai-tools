import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_TRIM_COMMANDS, rewriteRow, trimmable } from './entry'
import type { CommandOf, EntryOptions, EntryRow, Judge } from './entry'

const OPTIONS: EntryOptions = { keepThreshold: 0.5, sentenceKeepThreshold: 0.35, maxSentenceDropRatio: 0.7, entryUser: true, entryAssistant: true, entryToolResults: true, entryResultMinChars: 12_000, entryTrimCommands: DEFAULT_TRIM_COMMANDS }

const SENTENCES = Array.from({ length: 12 }, (_, i) => `Step number ${i} of the plan reads the input and writes the matching output file.`)
const LONG = `Sure! Let me explain.\n${SENTENCES.join(' ')}\nSee \`src/a.ts\` for the details.`

// Answers by question-name pattern; records what it was asked.
function judge(p: (name: string) => number) {
  const calls: { current: string; names: string[] }[] = []
  const fn: Judge = async (current, questions) => {
    calls.push({ current, names: Object.keys(questions) })
    return Object.fromEntries(Object.keys(questions).map((n) => [n, p(n)]))
  }
  return { fn, calls }
}

const row = (door: string, type: string, content: EntryRow['message']['content'], origin: EntryRow['origin'], extra: Partial<EntryRow> = {}): EntryRow => ({ door, message: { type, content }, origin, ...extra })
const text = (t: string) => [{ type: 'text', text: t }]

const asText = (out: Awaited<ReturnType<typeof rewriteRow>>, at = 0) => (out?.content[at] as unknown as { text: string }).text
const bash = (command: string): CommandOf => async () => command

describe('rewriting a row on entry', () => {
  test('a user prompt gets the article drop only: no Jev, no removal, no sentence deleted', async () => {
    const j = judge(() => 0)
    const prompt = `${LONG}\nPlease just do it.`
    const out = await rewriteRow(row('prompt', 'user', text(prompt), { kind: 'composer' }), j.fn, OPTIONS)
    expect(j.calls).toEqual([])
    const result = asText(out)
    for (let i = 0; i < 12; i++) expect(result).toContain(`Step number ${i} of`)
    expect(result.startsWith('Sure! Let me explain.')).toBe(true)
    expect(result).toContain('Please just do it.')
    expect(out?.saved).toBe(prompt.length - result.length)
  })

  test('prompts that are not the person typing (sdk included), meta rows and other doors are left alone', async () => {
    const t = text('Sure! Let me explain how the thing works for you in the end of the day.')
    for (const kind of ['task-notification', 'sdk']) expect(await rewriteRow(row('prompt', 'user', t, { kind }), undefined, OPTIONS)).toBeUndefined()
    expect(await rewriteRow(row('prompt', 'user', t, { kind: 'composer' }, { message: { type: 'user', isMeta: true, content: t } }), undefined, OPTIONS)).toBeUndefined()
    expect(await rewriteRow(row('command', 'user', t, { kind: 'composer' }), undefined, OPTIONS)).toBeUndefined()
    expect(await rewriteRow(row('prompt', 'user', t, { kind: 'composer' }, { agentId: 'sub' }), undefined, OPTIONS)).toBeUndefined()
    expect(await rewriteRow(row('prompt', 'user', t, { kind: 'composer' }), undefined, { ...OPTIONS, entryUser: false })).toBeUndefined()
  })

  test('assistant text: one Jev request, low sentences dropped, atomic lines kept, the entry note at the cut', async () => {
    const j = judge((n) => (['s2', 's5', 's8'].includes(n) ? 0.05 : 0.9))
    const out = await rewriteRow(row('response', 'assistant', text(LONG), { kind: 'model', model: 'm' } as never), j.fn, OPTIONS)
    expect(j.calls.length).toBe(1)
    const result = asText(out)
    for (const i of [0, 3, 6]) expect(result).not.toContain(`Step number ${i} of`)
    expect(result).toContain('Step number 1 of')
    expect(result).toContain('`src/a.ts`')
    expect(result.match(/\[… 1 sentence cut on entry …\]/g)?.length).toBe(3)
    expect(result).not.toContain('jev-compaction')
    expect(result.indexOf('[… 1')).toBeLessThan(result.indexOf('Step number 1 of'))
  })

  test('assistant text under 600 characters never asks Jev; a Jev failure leaves the word-filtered text', async () => {
    const j = judge(() => 0)
    const short = await rewriteRow(row('response', 'assistant', text('Run the build to see the output of the task.'), { kind: 'model' }), j.fn, OPTIONS)
    expect(j.calls).toEqual([])
    expect(asText(short)).toBe('Run build to see output of task.')
    const broken: Judge = async () => {
      throw new Error('timeout')
    }
    const out = await rewriteRow(row('response', 'assistant', text(LONG), { kind: 'model' }), broken, OPTIONS)
    expect(asText(out)).toContain('Step number 11 of')
  })

  test('a block that would become empty is kept as it was', async () => {
    for (const t of ['Hope this helps!', 'Great question!']) {
      expect(await rewriteRow(row('response', 'assistant', text(t), { kind: 'model' }), undefined, OPTIONS)).toBeUndefined()
      expect(await rewriteRow(row('prompt', 'user', text(t), { kind: 'composer' }), undefined, OPTIONS)).toBeUndefined()
    }
  })

  test('tool_use and thinking blocks are passed on untouched', async () => {
    const blocks = [{ type: 'thinking', thinking: 'Sure! Let me think', signature: 'x' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }, ...text('Run the build to see the output of the task.')]
    const out = await rewriteRow(row('response', 'assistant', blocks, { kind: 'model' }), undefined, OPTIONS)
    expect(out?.content[0]).toBe(blocks[0])
    expect(out?.content[1]).toBe(blocks[1])
  })

  const OUTPUT = Array.from({ length: 600 }, (_, i) => `row ${i}: some listing text that carries little`).join('\n').replace('row 300:', 'row 300: ERROR boom')
  const result = (content: unknown, tool = 'Bash') => row('tool-result', 'user', [{ type: 'tool_result', tool_use_id: 't1', content }], { kind: 'tool', tool })

  test('a long result of a noisy Bash command keeps head, tail, failure lines and the chunks Jev keeps', async () => {
    const j = judge((n) => (n === 'c10' ? 0.9 : 0.1))
    const out = await rewriteRow(result(OUTPUT), j.fn, OPTIONS, bash('npm test'))
    expect(j.calls.length).toBe(1)
    const r = out?.content[0] as unknown as { content: string; tool_use_id: string }
    expect(r.tool_use_id).toBe('t1')
    expect(r.content.startsWith('row 0:')).toBe(true)
    expect(r.content.endsWith('row 599: some listing text that carries little')).toBe(true)
    expect(r.content).toContain('ERROR boom')
    expect(r.content).toMatch(/\[… \d+ chars cut on entry …\]/)
    expect(r.content).not.toContain('jev-compaction')
    expect(r.content.length).toBeLessThan(OUTPUT.length / 3)
  })

  const GREP = Array.from({ length: 400 }, (_, i) => `src/mod${i}/file.ts:${i}:  const oldName = callOldName(${i})`).join('\n')

  test('only an allowlist of noisy commands is trimmed: readers, other tools and unknown commands never', async () => {
    const j = judge(() => 0.1)
    const yes = ['set -x; npm test', 'cd /x && npm test', 'export A=1 && npm test', 'npm test 2>&1', 'cd "$HOME" && make', 'make', 'make test', 'make -j4 all', 'mvn -q verify', 'gradle build', './gradlew test', 'tsc --noEmit', 'cd app && make test', 'FOO=1 make', 'make 2>&1', 'npm test', 'pnpm run build', 'yarn run lint', 'bun test', 'pytest -x tests/', 'go test ./...', 'cargo build --release', 'make all', 'gradle build', 'mvn -q test', 'tsc -p .', 'npx eslint .', 'cd app && npm install', 'CI=1 npm test']
    const no = ['export X=$(cat f) && npm test', 'npm test > out.txt && cat out.txt', 'npm run build -- --print-config', 'make test; env', 'npm test & cat secrets.txt', 'npm test |& grep FAIL', 'npm test 2>&1 |& tee log', 'source ./dump-env.sh && npm test', '. ./show.sh; npm test', 'npm test -- --listTests', 'pytest --co -q', 'cargo test -- --list', 'npm test >/dev/null; cat log', 'npm test\ncat f', 'npm test && \\\ncat f', 'npm test & wait', 'npm test <<EOF\nhello\nEOF', 'npm test -- --json', 'cd $(git rev-parse --show-toplevel) && npm test', 'cat big.log', 'sed -n 1,400p a.log', 'head -n 900 a.log', 'git diff', 'git show HEAD', 'git log -p', 'rg oldName', 'grep -rn oldName .', 'find . -name x', 'cat a.log && npm test', 'echo hi', 'curl https://example.com', 'ls -la']
    for (const c of yes) expect([c, trimmable('Bash', c, DEFAULT_TRIM_COMMANDS)]).toEqual([c, true])
    for (const c of no) expect([c, trimmable('Bash', c, DEFAULT_TRIM_COMMANDS)]).toEqual([c, false])
    for (const tool of ['Grep', 'Glob', 'Read', 'Agent', 'Task', 'NotebookRead', 'mcp__fs__read_file']) {
      expect(trimmable(tool, 'npm test', DEFAULT_TRIM_COMMANDS)).toBe(false)
      expect(await rewriteRow(result(GREP, tool), j.fn, OPTIONS, bash('npm test'))).toBeUndefined()
    }
    expect(await rewriteRow(result(GREP), j.fn, OPTIONS, bash('rg oldName'))).toBeUndefined()
    expect(await rewriteRow(result(GREP), j.fn, OPTIONS, undefined)).toBeUndefined()
    expect(await rewriteRow(result(GREP), j.fn, OPTIONS, async () => undefined)).toBeUndefined()
    expect(j.calls).toEqual([])
  })

  test('the allowlist is configurable', async () => {
    expect(trimmable('Bash', 'npm test', '^deploy\\b')).toBe(false)
    expect(trimmable('Bash', 'deploy --all', '^deploy\\b')).toBe(true)
    expect(trimmable('Bash', 'npm test', '(')).toBe(true)
    const j = judge(() => 0.1)
    expect(await rewriteRow(result(OUTPUT), j.fn, { ...OPTIONS, entryTrimCommands: '^deploy\\b' }, bash('deploy --all'))).toBeDefined()
  })

  test('a result under the minimum, with media, or with a Jev failure stays whole', async () => {
    const j = judge(() => 0)
    expect(await rewriteRow(result('short'), j.fn, OPTIONS, bash('npm test'))).toBeUndefined()
    expect(await rewriteRow(result([{ type: 'text', text: OUTPUT }, { type: 'image', source: {} }]), j.fn, OPTIONS, bash('npm test'))).toBeUndefined()
    const broken: Judge = async () => {
      throw new Error('down')
    }
    expect(await rewriteRow(result(OUTPUT), broken, OPTIONS, bash('npm test'))).toBeUndefined()
    expect(await rewriteRow(result(OUTPUT), undefined, OPTIONS, bash('npm test'))).toBeUndefined()
    expect(j.calls).toEqual([])
  })

  test('text blocks inside a result are trimmed one request at a time', async () => {
    let running = 0
    let overlap = false
    const j: Judge = async (_c, qs) => {
      if (++running > 1) overlap = true
      await Promise.resolve()
      running--
      return Object.fromEntries(Object.keys(qs).map((n) => [n, 0.1]))
    }
    const blocks = [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: OUTPUT }, { type: 'text', text: OUTPUT }] }]
    const out = await rewriteRow(row('tool-result', 'user', blocks, { kind: 'tool', tool: 'Bash' }), j, OPTIONS, bash('npm test'))
    const inner = (out?.content[0] as unknown as { content: { text: string }[] }).content
    expect(inner.every((b) => b.text.includes('cut on entry'))).toBe(true)
    expect(overlap).toBe(false)
  })

  test('commandOf is not asked for output under the size minimum', async () => {
    let calls = 0
    const out = await rewriteRow(result('ok'), judge(() => 0).fn, OPTIONS, async () => {
      calls++
      return 'npm test'
    })
    expect(out).toBeUndefined()
    expect(calls).toBe(0)
  })

  test('per-kind toggles', async () => {
    expect(await rewriteRow(row('response', 'assistant', text(LONG), { kind: 'model' }), undefined, { ...OPTIONS, entryAssistant: false })).toBeUndefined()
    expect(await rewriteRow(result(OUTPUT), judge(() => 0).fn, { ...OPTIONS, entryToolResults: false }, bash('npm test'))).toBeUndefined()
  })
})
