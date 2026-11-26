import { expect, test } from 'claude-code/testing'

import { FILE_PREFIX, MAX_AGE_SECONDS, MAX_KEYS, bumpCount, deferReason, emptyCounts, parseStat, processId, pruneMetrics, renderFile, writeAtomic, writeMetrics } from './metrics'
import type { MetricsIo } from './metrics'

const NOW = 1_800_000_000
const STAT = '4242 (claude) S 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 987654 1000 1000'
const ID = processId('pod-a', STAT, () => 'x')

/** An io over a map of files; `commands` are recorded. */
function memoryIo(opts: { run?: 'ok' | 'fail' | 'throws'; dir?: boolean; files?: Record<string, { text: string; mtimeMs: number }> } = {}) {
  const files: Record<string, { text: string; mtimeMs: number }> = { ...(opts.files ?? {}) }
  const commands: string[][] = []
  const io: MetricsIo = {
    read: async (path) => {
      const f = files[path]
      if (!f) throw new Error('ENOENT')
      return f.text
    },
    write: async (path, text) => void (files[path] = { text, mtimeMs: NOW * 1000 }),
    exists: async () => opts.dir ?? true,
    list: async (dir) =>
      Object.entries(files)
        .filter(([path]) => path.startsWith(`${dir}/`))
        .map(([path, f]) => ({ name: path.slice(dir.length + 1), kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs })),
    run: async (argv) => {
      commands.push([...argv])
      if (opts.run === 'throws') throw new Error('no commands')
      if (opts.run === 'fail') return { exitCode: 1 }
      const [cmd, ...rest] = argv
      const paths = rest.filter((a) => a.startsWith('/'))
      if (cmd === 'chmod') {
        // nothing to do in memory
      } else if (cmd === 'mv') {
        files[paths[1]!] = { ...files[paths[0]!]!, mtimeMs: NOW * 1000 }
        delete files[paths[0]!]
      } else if (cmd === 'rm') for (const p of paths) delete files[p]
      return { exitCode: 0 }
    },
  }
  return { io, files, commands }
}

test('/proc/self/stat gives the pid and the start time, also when the command name holds spaces and brackets', () => {
  expect(parseStat(STAT)).toEqual({ pid: '4242', start: '987654' })
  expect(parseStat('77 (a b) c) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 555 1')).toEqual({ pid: '77', start: '555' })
  expect(parseStat('garbage')).toBeUndefined()
  expect(parseStat('')).toBeUndefined()
})

test('a process is named by host, pid and start time; a reused pid is another process; an unreadable stat is a random name', () => {
  expect(ID).toEqual({ host: 'pod-a', process: '4242-987654', file: 'jev_compaction_pod-a_4242-987654.prom' })
  expect(processId('pod-a', STAT.replace('987654', '987999'), () => 'x').file).not.toBe(ID.file)
  expect(processId('pod-b', STAT, () => 'x').file).not.toBe(ID.file)
  const a = processId('pod-a', undefined, () => 'abc123')
  const b = processId('pod-a', undefined, () => 'def456')
  expect(a.file).not.toBe(b.file)
  expect(a.file).not.toMatch(/unknown/)
  expect(processId('we ird/host\n', STAT, () => 'x').file).toMatch(/^jev_compaction_we_ird_host__4242-987654\.prom$/)
})

test('every usual series starts at 0, carries host and process, and the timestamp is last', () => {
  const lines = renderFile(ID, emptyCounts(), NOW).split('\n').filter((l) => l !== '' && !l.startsWith('#'))
  expect(lines).toContain('jev_compaction_requests_total{host="pod-a",process="4242-987654",status="200"} 0')
  expect(lines).toContain('jev_compaction_failures_total{host="pod-a",process="4242-987654",status="400",error_type="max_tokens_exceeded"} 0')
  expect(lines).toContain('jev_compaction_deferred_total{host="pod-a",process="4242-987654",reason="transcript_cut"} 0')
  expect(lines).toContain('jev_compaction_deferred_total{host="pod-a",process="4242-987654",reason="rotation_skipped"} 0')
  expect(lines.at(-1)).toBe(`jev_compaction_updated_timestamp_seconds{host="pod-a",process="4242-987654"} ${NOW}`)
  // a process starts with 16 series: the cardinality figure in the header of metrics.ts
  expect(lines.length).toBe(16)
})

test('every # TYPE line stands before its series and appears once', () => {
  const text = renderFile(ID, emptyCounts(), NOW)
  for (const name of ['jev_compaction_requests_total', 'jev_compaction_failures_total', 'jev_compaction_deferred_total', 'jev_compaction_updated_timestamp_seconds']) {
    expect(text.match(new RegExp(`# TYPE ${name} `, 'g'))?.length).toBe(1)
    expect(text.indexOf(`# TYPE ${name} `)).toBeLessThan(text.indexOf(`${name}{`))
  }
})

test('counters grow, an unusual label is made safe, and a table never holds more than MAX_KEYS keys', () => {
  const c = emptyCounts()
  bumpCount(c.requests, '418')
  bumpCount(c.failures, '418|odd "type"', 'other|none')
  const text = renderFile(ID, c, NOW)
  expect(text).toContain('status="418"} 1')
  expect(text).toContain('error_type="odd__type_"')
  for (let i = 0; i < 100; i++) bumpCount(c.requests, `5${String(i).padStart(2, '0')}`)
  expect(Object.keys(c.requests).length).toBeLessThanOrEqual(MAX_KEYS)
  // what did not fit counts under the fallback
  expect(c.requests.other).toBeGreaterThan(0)
  bumpCount(c.requests, '200')
  expect(c.requests['200']).toBe(1)
})

test('a file is written to a temp name that node-exporter ignores, then renamed over its name', async () => {
  const { io, files, commands } = memoryIo()
  expect(await writeAtomic(io, '/d/x.prom', 'text\n')).toBe('renamed')
  // readable by node-exporter (another user) before it appears under its name
  expect(commands).toEqual([
    ['chmod', '0644', '--', '/d/x.prom.tmp'],
    ['mv', '-f', '--', '/d/x.prom.tmp', '/d/x.prom'],
  ])
  expect(Object.keys(files)).toEqual(['/d/x.prom'])
  expect(files['/d/x.prom']!.text).toBe('text\n')
})

test('where mv fails or cannot run, the file is written in place and no reader of this mod sees a mix', async () => {
  for (const run of ['fail', 'throws'] as const) {
    const { io, files } = memoryIo({ run })
    expect(await writeAtomic(io, '/d/x.prom', 'text\n')).toBe('in place')
    expect(files['/d/x.prom']!.text).toBe('text\n')
  }
})

test('two processes write two files and never touch each other\'s lines', async () => {
  const { io, files } = memoryIo()
  const other = processId('pod-b', STAT, () => 'x')
  const a = emptyCounts()
  bumpCount(a.requests, '200')
  const b = emptyCounts()
  bumpCount(b.failures, '400|none', 'other|none')
  expect(await writeMetrics(io, '/d', ID, a, NOW)).toBe(true)
  expect(await writeMetrics(io, '/d', other, b, NOW)).toBe(true)
  expect(await writeMetrics(io, '/d', ID, a, NOW + 5)).toBe(true)
  expect(Object.keys(files).sort()).toEqual([`/d/${ID.file}`, `/d/${other.file}`].sort())
  expect(files[`/d/${ID.file}`]!.text).not.toContain('pod-b')
  expect(files[`/d/${other.file}`]!.text).toContain('status="400",error_type="none"} 1')
})

test('writeMetrics writes nothing when the directory is missing and never throws', async () => {
  const none = memoryIo({ dir: false })
  expect(await writeMetrics(none.io, '/nope', ID, emptyCounts(), NOW)).toBe(false)
  expect(none.files).toEqual({})
  const broken: MetricsIo = { ...memoryIo().io, write: async () => Promise.reject(new Error('disk')) }
  expect(await writeMetrics(broken, '/dir', ID, emptyCounts(), NOW)).toBe(false)
})

test('prune removes the files of this mod older than a day, also leftovers of a dead write; never the own file, young files or other tools', async () => {
  const old = (NOW - MAX_AGE_SECONDS - 60) * 1000
  const young = (NOW - MAX_AGE_SECONDS + 3600) * 1000
  const { io, files, commands } = memoryIo({
    files: {
      '/d/jev_compaction_pod-b_1-2.prom': { text: 'x', mtimeMs: old },
      '/d/jev_compaction_pod-b_3-4.prom.tmp': { text: 'x', mtimeMs: old },
      '/d/jev_compaction_pod-b_5-6.prom': { text: 'x', mtimeMs: young },
      '/d/node_other.prom': { text: 'x', mtimeMs: old },
      [`/d/${ID.file}`]: { text: 'x', mtimeMs: old },
      [`/d/${ID.file}.tmp`]: { text: 'x', mtimeMs: old },
    },
  })
  expect(await pruneMetrics(io, '/d', ID, NOW * 1000)).toBe(2)
  expect(Object.keys(files).sort()).toEqual(['/d/jev_compaction_pod-b_5-6.prom', '/d/node_other.prom', `/d/${ID.file}`, `/d/${ID.file}.tmp`].sort())
  expect(commands.every((c) => c[0] === 'rm' && c[1] === '-f' && c[2] === '--')).toBe(true)
})

test('prune does not depend on /proc: an old file goes even when nothing could tell whether its process lives', async () => {
  const old = (NOW - MAX_AGE_SECONDS - 60) * 1000
  const { io, files } = memoryIo({ files: { '/d/jev_compaction_pod-b_1-2.prom': { text: 'x', mtimeMs: old } } })
  const throwing: MetricsIo = { ...io, exists: async (p) => (p === '/d' ? true : Promise.reject(new Error('no /proc'))) }
  expect(await pruneMetrics(throwing, '/d', ID, NOW * 1000)).toBe(1)
  expect(files).toEqual({})
})

test('where rm is not possible an old file is emptied once, and an empty one is left alone', async () => {
  const old = (NOW - MAX_AGE_SECONDS - 60) * 1000
  const { io, files } = memoryIo({ run: 'throws', files: { '/d/jev_compaction_pod-b_1-2.prom': { text: 'x', mtimeMs: old }, '/d/jev_compaction_pod-b_3-4.prom': { text: '', mtimeMs: old } } })
  expect(await pruneMetrics(io, '/d', ID, NOW * 1000)).toBe(1)
  expect(files['/d/jev_compaction_pod-b_1-2.prom']!.text).toBe('')
  expect(files['/d/jev_compaction_pod-b_3-4.prom']!.mtimeMs).toBe(old)
})

test('prune never throws, and only looks at files with the prefix of this mod', async () => {
  const bad: MetricsIo = { ...memoryIo().io, list: async () => Promise.reject(new Error('EIO')) }
  expect(await pruneMetrics(bad, '/d', ID, NOW * 1000)).toBe(0)
  expect(FILE_PREFIX).toBe('jev_compaction_')
})

test('a deferral text becomes a bounded reason', () => {
  expect(deferReason('frees only ~100 tokens (minimum 1)')).toBe('frees_too_little')
  expect(deferReason('no Jev API key (environment or key file)')).toBe('no_key')
  expect(deferReason('Jev request failed (400)')).toBe('jev_error')
})
