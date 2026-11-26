import { expect, test } from 'claude-code/testing'

import { KEEP_ENDED_SECONDS, bumpCount, deferReason, emptyCounts, mergeFile, renderSection, writeMetrics } from './metrics'

const NOW = 1_800_000_000

test('every usual series starts at 0 and the timestamp is last', () => {
  const lines = renderSection('7', emptyCounts(), NOW)
  expect(lines).toContain('jev_compaction_requests_total{pid="7",status="200"} 0')
  expect(lines).toContain('jev_compaction_failures_total{pid="7",status="400",error_type="max_tokens_exceeded"} 0')
  expect(lines).toContain('jev_compaction_deferred_total{pid="7",reason="frees_too_little"} 0')
  expect(lines.at(-1)).toBe(`jev_compaction_updated_timestamp_seconds{pid="7"} ${NOW}`)
})

test('counters grow and an unusual label is kept, made safe', () => {
  const c = emptyCounts()
  bumpCount(c.requests, '418')
  bumpCount(c.failures, '418|odd "type"')
  const text = renderSection('7', c, NOW).join('\n')
  expect(text).toContain('jev_compaction_requests_total{pid="7",status="418"} 1')
  expect(text).toContain('error_type="odd__type_"')
})

test('a process keeps the lines of the others and replaces its own', async () => {
  const other = renderSection('8', { ...emptyCounts(), requests: { '200': 5 } }, NOW - 10)
  const first = await mergeFile(`${other.join('\n')}\n`, '7', renderSection('7', emptyCounts(), NOW), NOW, async () => true)
  expect(first).toContain('jev_compaction_requests_total{pid="8",status="200"} 5')
  expect(first).toContain('jev_compaction_requests_total{pid="7",status="200"} 0')
  const c = emptyCounts()
  bumpCount(c.requests, '200')
  const second = await mergeFile(first, '7', renderSection('7', c, NOW + 1), NOW + 1, async () => true)
  expect(second.match(/jev_compaction_requests_total\{pid="7",status="200"\}/g)?.length).toBe(1)
  expect(second).toContain('jev_compaction_requests_total{pid="7",status="200"} 1')
  expect(second.match(/# TYPE jev_compaction_requests_total/g)?.length).toBe(1)
})

test('the lines of an ended process stay for an hour, then go; a live one stays', async () => {
  const old = renderSection('8', emptyCounts(), NOW - KEEP_ENDED_SECONDS - 1).join('\n')
  const recent = renderSection('9', emptyCounts(), NOW - 60).join('\n')
  const live = renderSection('10', emptyCounts(), NOW - KEEP_ENDED_SECONDS - 1).join('\n')
  const out = await mergeFile(`${old}\n${recent}\n${live}\n`, '7', renderSection('7', emptyCounts(), NOW), NOW, async (pid) => pid === '10')
  expect(out).not.toContain('pid="8"')
  expect(out).toContain('pid="9"')
  expect(out).toContain('pid="10"')
})

test('writeMetrics writes nothing when the directory is missing and never throws', async () => {
  const writes: string[] = []
  const fs = { read: async () => '', write: async (p: string) => void writes.push(p), exists: async () => false }
  expect(await writeMetrics(fs, '/nope', '7', emptyCounts(), NOW)).toBe(false)
  expect(writes).toEqual([])
  const broken = { read: async () => '', write: async () => Promise.reject(new Error('disk')), exists: async () => true }
  expect(await writeMetrics(broken, '/dir', '7', emptyCounts(), NOW)).toBe(false)
})

test('a deferral text becomes a bounded reason', () => {
  expect(deferReason('frees only ~100 tokens (minimum 1)')).toBe('frees_too_little')
  expect(deferReason('no Jev API key (environment or key file)')).toBe('no_key')
  expect(deferReason('Jev request failed (400)')).toBe('jev_error')
})
