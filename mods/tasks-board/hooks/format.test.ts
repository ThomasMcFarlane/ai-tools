import { expect, test } from 'claude-code/testing'

import { parseBoard, trackChanges } from './board'
import { bandLines, etaItems, etaPair, nudgeLines, parseEtaInput, staleness } from './format'

const NOW = Date.parse('2026-10-28T07:00:00Z') // 14:00 ICT, 07:00 GMT

test('etaPair gives ICT and UK times, BST in summer, and a date across midnight', () => {
  expect(etaPair('2026-10-28 14:30 ICT', NOW)).toMatchObject({ ict: '14:30 ICT', uk: '07:30 GMT', leftMs: 30 * 60_000 })
  expect(etaPair('2026-07-01 14:30 ICT', Date.parse('2026-07-01T07:00:00Z'))).toMatchObject({ ict: '14:30 ICT', uk: '08:30 BST' })
  expect(etaPair('2026-10-28 01:00 ICT', NOW)?.uk).toBe('27 Oct 18:00 GMT')
  expect(etaPair('2026-10-29 01:00 ICT', NOW)?.ict).toBe('29 Oct 01:00 ICT')
  expect(etaPair('2026-10-28 14:30 +07:00', NOW)?.ict).toBe('14:30 ICT')
  expect(etaPair('2026-10-28 14:30 XYZ', NOW)).toBeUndefined()
  expect(etaPair('soon', NOW)).toBeUndefined()
})

test('parseEtaInput reads relative, clock and ISO input as canonical ICT', () => {
  expect(parseEtaInput('+45m', NOW)).toBe('2026-10-28 14:45 ICT')
  expect(parseEtaInput('+2h', NOW)).toBe('2026-10-28 16:00 ICT')
  expect(parseEtaInput('14:30', NOW)).toBe('2026-10-28 14:30 ICT')
  expect(parseEtaInput('09:00', NOW)).toBe('2026-10-29 09:00 ICT')
  expect(parseEtaInput('2026-11-02T10:00:00Z', NOW)).toBe('2026-11-02 17:00 ICT')
  expect(parseEtaInput('2026-11-02 10:00', NOW)).toBe('2026-11-02 10:00 ICT')
  expect(parseEtaInput('tomorrow-ish', NOW)).toBeUndefined()
  expect(parseEtaInput('25:00', NOW)).toBeUndefined()
})

test('staleness: ETA passed, or an in_progress row unchanged for the limit; a change clears it', () => {
  const base = { status: 'in_progress', leftMs: 10 * 60_000, changedAt: NOW - 29 * 60_000, now: NOW, staleMs: 30 * 60_000 }
  expect(staleness(base)).toBeUndefined()
  expect(staleness({ ...base, changedAt: NOW - 31 * 60_000 })).toEqual({ kind: 'stale', ms: 31 * 60_000 })
  expect(staleness({ ...base, changedAt: NOW })).toBeUndefined()
  expect(staleness({ ...base, leftMs: -60_000 })).toEqual({ kind: 'passed', ms: 60_000 })
  expect(staleness({ ...base, status: 'in_review', changedAt: NOW - 99 * 60_000 })).toBeUndefined()
})

const BOARD = (eta: string, status = 'in_progress') =>
  `# Tasks\n\n## 3. Epic\n\n| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |\n|---|---|---|---|---|---|---|---|\n| 579 | Fix login | ${status} | a | | | ${eta} | n |\n| 580 | Other | in_progress | b | | | ${eta} | n |\n| 581 | Parked | parked | a | | | | n |\n`
const ctx = (over = {}) => ({ mine: ['579', '581'], tag: '', changes: undefined, now: NOW, mtimeMs: NOW - 5 * 60_000, staleMs: 30 * 60_000, ...over })

test('the band has one line per open session row and nothing otherwise', () => {
  const items = etaItems(parseBoard(BOARD('2026-10-28 14:12 ICT')), ctx())
  expect(items.map(i => i.ref)).toEqual(['3.579']) // 580 is another session's, 581 is parked
  expect(bandLines(items)).toEqual([{ text: '3.579 Fix login   14:12 ICT / 07:12 GMT   (12m left)', color: undefined }])
  expect(bandLines(etaItems(parseBoard(BOARD('2026-10-28 14:12 ICT', 'done')), ctx()))).toEqual([])
  expect(bandLines(etaItems(parseBoard(BOARD('2026-10-28 14:12 ICT')), ctx({ mine: [] })))).toEqual([])
})

test('the band marks a passed ETA red and a stale row yellow, and caps at 4 lines', () => {
  expect(bandLines(etaItems(parseBoard(BOARD('2026-10-28 13:59 ICT')), ctx()))[0]).toMatchObject({ color: 'red', text: expect.stringContaining('ETA passed 1m ago') })
  const old = trackChanges(undefined, parseBoard(BOARD('2026-10-28 15:00 ICT')), 0)
  const changed = { ...old, '579': [old['579']![0], NOW - 31 * 60_000] as [number, number] }
  expect(bandLines(etaItems(parseBoard(BOARD('2026-10-28 15:00 ICT')), ctx({ changes: changed })))[0]).toMatchObject({ color: 'yellow', text: expect.stringContaining('no update 31m') })
  const many = Array.from({ length: 6 }, (_, i) => `| ${600 + i} | T${i} | in_progress | a | | | 2026-10-28 15:00 ICT | n |`).join('\n')
  const lines = bandLines(etaItems(parseBoard(`## 3. Epic\n\n| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |\n|---|---|---|---|---|---|---|---|\n${many}\n`), ctx({ mine: ['600', '601', '602', '603', '604', '605'] })))
  expect(lines.length).toBe(4)
  expect(lines[3]!.text).toBe('+3 more')
})

test('the nudge fires once per row per 15 minutes, for a passed ETA or a missing one', () => {
  const last = new Map<string, number>()
  const passed = etaItems(parseBoard(BOARD('2026-10-28 13:35 ICT')), ctx())
  expect(nudgeLines(passed, NOW, last)).toEqual(['ETA for 3.579 passed 25m ago. Call the eta tool with a new estimate or update the status.'])
  expect(nudgeLines(passed, NOW + 5 * 60_000, last)).toEqual([])
  expect(nudgeLines(passed, NOW + 16 * 60_000, last).length).toBe(1)
  const fresh = etaItems(parseBoard(BOARD('2026-10-28 15:30 ICT')), ctx())
  expect(nudgeLines(fresh, NOW + 99 * 60_000, new Map())).toEqual([])
  const none = etaItems(parseBoard(BOARD('')), ctx())
  expect(nudgeLines(none, NOW, new Map())).toEqual(['3.579 is in_progress with no ETA. Call the eta tool with a new estimate or update the status.'])
})
