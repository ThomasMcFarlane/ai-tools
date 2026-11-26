import { describe, expect, test } from 'claude-code/testing'

import { JevError, buildRequest, isTooLarge, parseResponse } from './jev'
import { estimateTokens } from './state'

const fail = (status: number, text: string) => {
  try {
    parseResponse(status, false, text, ['q'])
  } catch (err) {
    return err as JevError
  }
  throw new Error('did not throw')
}

describe('Jev error bodies', () => {
  test('the error type of a 400 is in the message and on the error', () => {
    const err = fail(400, JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }))
    expect(err.message).toBe('Jev request failed (400: max_tokens_exceeded)')
    expect(err.status).toBe(400)
    expect(isTooLarge(err)).toBe(true)
  })
  test('a message is kept short and on one line', () => {
    const err = fail(400, JSON.stringify({ detail: { error_type: 'api_usage_error', message: `Unknown\nmodel: ${'x'.repeat(500)}` } }))
    expect(err.message.length).toBeLessThan(200)
    expect(err.message).not.toContain('\n')
    expect(isTooLarge(err)).toBe(false)
  })
  test('a body that is not JSON, or has a odd error type, leaves the plain message', () => {
    expect(fail(500, '<html>').message).toBe('Jev request failed (500)')
    expect(fail(400, JSON.stringify({ detail: { error_type: 'Bad Type!' } })).message).toBe('Jev request failed (400)')
    expect(fail(422, JSON.stringify({ detail: [{ type: 'missing' }] })).message).toBe('Jev request failed (422)')
  })
})

describe('request body', () => {
  test('a lone surrogate in the state or a question is replaced before the request leaves', () => {
    const { body } = buildRequest('k', 'jev-latest', { goal: 'a\ud83db' }, { q: { type: 'noul', instructions: 'x\ude00' } })
    expect(body).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i)
    expect(JSON.parse(body).state.goal).toBe('a�b')
  })
})

describe('token estimate', () => {
  test('a long hash or base64 run costs about 0.7 tokens a character, as Jev counts it', () => {
    const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    expect(estimateTokens(hex)).toBeGreaterThanOrEqual(20)
    expect(estimateTokens('Open the file src/index.ts and read it.')).toBeLessThan(20)
  })

  test('a long run of letters with a digit (base64, ids) is priced by its characters, not as a word', () => {
    const b64 = 'dGhpcyBpcyBhIHRlc3Qgc3RyaW5nIGZvciB0ZXN0aW5nIHB1cnBvc2VzIG9ubHk1'
    expect(estimateTokens(b64)).toBeGreaterThanOrEqual(Math.floor(b64.length * 0.6))
    expect(estimateTokens('internationalization and documentation of the configuration')).toBeLessThan(20)
  })
})
