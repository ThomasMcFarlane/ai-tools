import { maskDeep } from './mask'
import { wellFormedDeep } from './unicode'
import type { JevAsker } from './types'

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone'
export const DEFAULT_MODEL = 'jev-latest'

export type HookFetchInit = { method?: string; headers?: Record<string, string>; body?: string }
export type HookFetchResponse = { status: number; ok: boolean; text: string }
/** The shape of `$.http.fetch`, so the library can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The `error_type` of Jev's error body, such as `max_tokens_exceeded`. */
    readonly errorType?: string,
  ) {
    super(message)
  }
}

/** The request is over Jev's input limit (about 32k tokens): a smaller state or batch is the only cure. */
export const isTooLarge = (error: unknown) => error instanceof JevError && error.errorType === 'max_tokens_exceeded'

const ERROR_TYPE = /^[a-z][a-z0-9_]{0,59}$/

/** What Jev's error body says, safe to log: the `error_type` and a short `message`, never the request. */
function errorDetail(text: string): { errorType?: string; message?: string } {
  try {
    const detail = (JSON.parse(text) as { detail?: unknown } | null)?.detail as { error_type?: unknown; message?: unknown } | undefined
    if (!detail || typeof detail !== 'object') return {}
    const errorType = typeof detail.error_type === 'string' && ERROR_TYPE.test(detail.error_type) ? detail.error_type : undefined
    const message = typeof detail.message === 'string' ? detail.message.replace(/\s+/g, ' ').slice(0, 120) : undefined
    return { errorType, message }
  } catch {
    return {}
  }
}

export function buildRequest(apiKey: string, model: string, state: object, questions: object) {
  return {
    url: SYSTEM_ONE_URL,
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, state: wellFormedDeep(maskDeep(state)), questions: wellFormedDeep(maskDeep(questions)) }),
  }
}

/** Validates a response body and returns the `noul` probability of every asked question. */
export function parseResponse(status: number, ok: boolean, text: string, names: readonly string[]): Record<string, number> {
  if (!ok) {
    const { errorType, message } = errorDetail(text)
    throw new JevError(`Jev request failed (${status}${errorType ? `: ${errorType}` : ''}${message ? `, ${message}` : ''})`, status, errorType)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new JevError('Jev returned malformed JSON')
  }
  const answers = (parsed as { answers?: Record<string, { noul?: unknown }> } | null)?.answers
  if (!answers || typeof answers !== 'object') throw new JevError('Jev response is missing answers')
  const out: Record<string, number> = {}
  for (const name of names) {
    const noul = answers[name]?.noul
    if (typeof noul !== 'number' || !Number.isFinite(noul)) throw new JevError(`Invalid Jev answer for ${name}`)
    out[name] = noul
  }
  return out
}

export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return async (state, questions) => {
    const request = buildRequest(apiKey, model, state, questions)
    const response = await fetchFn(request.url, { method: request.method, headers: request.headers, body: request.body })
    return parseResponse(response.status, response.ok, response.text, Object.keys(questions))
  }
}
