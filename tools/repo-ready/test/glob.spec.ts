import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesAny } from '../src/core/glob.js';

describe('glob', () => {
  it.each([
    ['src/a/**', 'src/a/x/y.ts', true],
    ['src/a/**', 'src/ab/x.ts', false],
    ['docs/*.md', 'docs/a.md', true],
    ['docs/*.md', 'docs/sub/a.md', false],
    ['**/store.ts', 'store.ts', true],
    ['**/store.ts', 'tools/x/src/store.ts', true],
    ['tools/', 'tools/x/y.ts', true],
    ['a?.ts', 'ab.ts', true],
    ['a?.ts', 'a/.ts', false],
  ])('%s vs %s', (glob, path, want) => expect(matchesAny(path, [glob])).toBe(want));

  it('matches nothing for an empty list and escapes regex characters', () => {
    expect(matchesAny('a.ts', [])).toBe(false);
    expect(globToRegExp('a.ts').test('abts')).toBe(false);
    expect(matchesAny('a+b(1).ts', ['a+b(1).ts'])).toBe(true);
  });
});
