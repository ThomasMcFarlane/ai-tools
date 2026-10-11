import { describe, expect, test } from 'claude-code/testing'

import { keyFromFile, redact } from './key'
import { DEFAULTS, buildState, estimateTokens, formatAddition, formatListing, parseListing, planBatches, resolveConfig, scoreSkills, selectPicks, skipPrompt } from './skills'
import type { Skill } from './skills'

const LISTING = `The following skills are available for use with the Skill tool:

- plugin-a:deploy: Deploy the app to a hosting target
- review: Review a pull request: style, bugs and tests
- anthropic-skills:pdf
`

describe('listing', () => {
  test('parses lines with and without a description, keeping colons inside names and descriptions', () => {
    expect(parseListing(LISTING)).toEqual([
      { name: 'plugin-a:deploy', description: 'Deploy the app to a hosting target' },
      { name: 'review', description: 'Review a pull request: style, bugs and tests' },
      { name: 'anthropic-skills:pdf', description: '' },
    ])
  })
  test('a shortlist keeps the engine header and always ends with the other-skills line', () => {
    const text = formatListing([{ name: 'review', description: 'Review a PR' }, { name: 'bare', description: '' }])
    expect(text).toContain('available for use with the Skill tool:\n\n- review: Review a PR\n- bare\n\nOther installed skills')
    expect(text).toMatch(/exact name/)
    expect(formatListing([])).toMatch(/^The following skills[^\n]*\n\nOther installed skills/)
  })
  test('an addition lists only the given skills', () => {
    expect(formatAddition([{ name: 'a', description: 'x' }])).toBe('Skills that fit this request, also available with the Skill tool:\n- a: x')
  })
})

test('prompts that get no shortlist: slash commands, short text, acknowledgements', () => {
  for (const t of ['/jev-skills why', 'fix it', 'ok', 'Continue.', 'thanks!', '']) expect(skipPrompt(t)).toBe(true)
  expect(skipPrompt('Please review the pull request for the billing module')).toBe(false)
})

test('config: defaults, clamping and ignoring wrong types', () => {
  expect(resolveConfig({})).toEqual(DEFAULTS)
  const c = resolveConfig({ maxPicks: 0.4, minScore: 7, enabled: 'no', maxBatches: 0, model: '', recentPrompts: -2 })
  expect(c).toMatchObject({ maxPicks: 1, minScore: 1, enabled: true, maxBatches: 1, model: 'jev-latest', recentPrompts: 0 })
})

const many = (n: number): Skill[] => Array.from({ length: n }, (_, i) => ({ name: `skill-${i}`, description: `Does thing number ${i} with some words about databases and queues` }))

describe('batching', () => {
  test('a small roster is one request', () => {
    const p = planBatches(many(20), buildState('hello there friend', []), 'x', 28_000, 3)
    expect(p.batches.length).toBe(1)
    expect(p.unscored).toBe(0)
  })
  test('a large roster splits so that every request stays under the ceiling', () => {
    const skills = many(600)
    const state = buildState('deploy the queue', ['earlier'])
    const p = planBatches(skills, state, 'deploy the queue', 8_000, 20)
    expect(p.batches.length).toBeGreaterThan(1)
    expect(p.unscored).toBe(0)
    for (const b of p.batches) {
      const body = JSON.stringify({ model: 'jev-latest', state, questions: Object.fromEntries(b.map((s, i) => [`s${i}`, { type: 'noul', instructions: s.description }])) })
      expect(estimateTokens(body)).toBeLessThan(8_000)
    }
  })
  test('over the request cap the best keyword matches are asked and the rest left unscored', () => {
    const skills = [...many(600), { name: 'zebra-grooming', description: 'Groom a zebra' }]
    const p = planBatches(skills, buildState('groom my zebra', []), 'groom my zebra', 8_000, 2)
    expect(p.batches.length).toBe(2)
    expect(p.batches[0]![0]!.name).toBe('zebra-grooming')
    expect(p.unscored).toBe(skills.length - p.batches.flat().length)
    expect(p.unscored).toBeGreaterThan(0)
  })
})

describe('scoring', () => {
  const skills = many(4)
  test('one request per batch; a failed batch leaves its skills unscored', async () => {
    let calls = 0
    const ask = async (_state: object, q: Record<string, unknown>) => {
      calls++
      if (calls === 2) throw new Error('boom')
      return Object.fromEntries(Object.keys(q).map((k) => [k, 0.5]))
    }
    const r = await scoreSkills(ask, many(400), 'a prompt about queues', [], { maxRequestTokens: 3_000, maxBatches: 3 })
    expect(r.requests).toBe(3)
    expect(r.scores.size).toBeGreaterThan(0)
    expect(r.unscored).toBeGreaterThan(0)
  })
  test('every batch failing throws', async () => {
    await expect(scoreSkills(async () => Promise.reject(new Error('down')), skills, 'a prompt about queues', [], DEFAULTS)).rejects.toThrow('down')
  })
  test('picks respect the minimum score and the maximum, best first', () => {
    const scores = new Map([['skill-0', 0.9], ['skill-1', 0.31], ['skill-2', 0.29], ['skill-3', 0.6]])
    expect(selectPicks(scores, skills, 0.3, 5).map((s) => s.name)).toEqual(['skill-0', 'skill-3', 'skill-1'])
    expect(selectPicks(scores, skills, 0.3, 2).map((s) => s.name)).toEqual(['skill-0', 'skill-3'])
    expect(selectPicks(new Map([['unknown', 1]]), skills, 0.3, 5)).toEqual([])
  })
})

test('key file and redaction', () => {
  expect(keyFromFile('# c\nJEV_COMPACTION_API_KEY=\nTYPESAFE_API_KEY="abc"\n')).toBe('abc')
  expect(redact('failed with abc', 'abc')).toBe('failed with ***')
})
