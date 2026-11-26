import { describe, expect, test } from 'claude-code/testing'

import { head, tail, wellFormed, wellFormedDeep } from './unicode'

const EMOJI = '\u{1F600}'

describe('lone surrogates', () => {
  test('a lone high or low surrogate becomes U+FFFD and a pair stays', () => {
    expect(wellFormed('a\ud83db')).toBe('a�b')
    expect(wellFormed('a\ude00b')).toBe('a�b')
    expect(wellFormed(`a${EMOJI}b`)).toBe(`a${EMOJI}b`)
    expect(wellFormed('plain')).toBe('plain')
  })
  test('every string of a nested value is cleaned, keys included', () => {
    expect(wellFormedDeep({ 'k\ud83d': ['x\ude00', { y: 'ok' }], n: 1 })).toEqual({ 'k�': ['x�', { y: 'ok' }], n: 1 })
  })
  test('the result encodes to JSON with no \\ud escape of a lone surrogate', () => {
    expect(JSON.stringify(wellFormed('a\ud83db'))).not.toContain('\\ud83d')
  })
})

describe('cutting text', () => {
  test('head never ends inside a surrogate pair', () => {
    const text = `ab${EMOJI}cd`
    expect(head(text, 3)).toBe('ab')
    expect(head(text, 4)).toBe(`ab${EMOJI}`)
    expect(head(text, 100)).toBe(text)
    expect(head(text, 0)).toBe('')
  })
  test('tail never starts inside a surrogate pair', () => {
    const text = `ab${EMOJI}cd`
    expect(tail(text, 3)).toBe('cd')
    expect(tail(text, 4)).toBe(`${EMOJI}cd`)
    expect(tail(text, 100)).toBe(text)
    expect(tail(text, 0)).toBe('')
  })
  test('a cut of emoji text is well formed at every length', () => {
    const text = EMOJI.repeat(20)
    for (let n = 0; n <= 41; n++) {
      expect(wellFormed(head(text, n))).toBe(head(text, n))
      expect(wellFormed(tail(text, n))).toBe(tail(text, n))
    }
  })
})
