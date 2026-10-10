import { describe, expect, test } from 'claude-code/testing'

import { clip, isPlanPath, MARKDOWN_MAX, mdMentions, planTitle } from './plan'

describe('plan helpers', () => {
  test('titles a plan by its first heading, else its file name', () => {
    expect(planTitle('intro\n# Add caching\n## Steps', '/c/plans/x.md')).toBe('Add caching')
    expect(planTitle('no heading', '/c/plans/quiet-fox.md')).toBe('quiet-fox')
  })
  test('recognises only the remembered plan file', () => {
    expect(isPlanPath('/x/known.md', '/x/known.md')).toBe(true)
    expect(isPlanPath('/c/plans/a.md', '')).toBe(false)
    expect(isPlanPath('', '')).toBe(false)
  })
  test('finds .md mentions in prose, backticks and links', () => {
    const t = 'See `docs/a.md`, [b](./b.md), file:///abs/c.md, ~/d.md and notes.txt. Also e.md.'
    expect(mdMentions(t)).toEqual(['docs/a.md', 'b.md', '/abs/c.md', '~/d.md', 'e.md'])
    expect(mdMentions('a.mdx x.markdown')).toEqual([])
  })
  test('cuts at the Markdown cap', () => {
    expect(clip('a').isCut).toBe(false)
    expect(clip('a'.repeat(MARKDOWN_MAX + 1))).toMatchObject({ isCut: true })
  })
})
