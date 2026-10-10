import { describe, expect, test } from 'claude-code/testing'

import { clip, isPlanPath, MARKDOWN_MAX, planTitle } from './plan'

describe('plan helpers', () => {
  test('titles a plan by its first heading, else its file name', () => {
    expect(planTitle('intro\n# Add caching\n## Steps', '/c/plans/x.md')).toBe('Add caching')
    expect(planTitle('no heading', '/c/plans/quiet-fox.md')).toBe('quiet-fox')
  })
  test('recognises plan files', () => {
    expect(isPlanPath('/c/plans/a.md', '/c', '')).toBe(true)
    expect(isPlanPath('/c/plans/sub/a.md', '/c', '')).toBe(false)
    expect(isPlanPath('/c/plans/a.txt', '/c', '')).toBe(false)
    expect(isPlanPath('/repo/docs/plans/a.md', '/c', '')).toBe(false)
    expect(isPlanPath('/x/known.md', '/c', '/x/known.md')).toBe(true)
    expect(isPlanPath('', '/c', '')).toBe(false)
  })
  test('cuts at the Markdown cap', () => {
    expect(clip('a').isCut).toBe(false)
    expect(clip('a'.repeat(MARKDOWN_MAX + 1))).toMatchObject({ isCut: true })
  })
})
