import type { JevAsker } from './skills'

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
  ) {
    super(message)
  }
}

export function buildRequest(apiKey: string, model: string, state: object, questions: object) {
  return {
    url: SYSTEM_ONE_URL,
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, state, questions }),
  }
}

/** Validates a response body and returns the `noul` probability of every asked question. */
export function parseResponse(status: number, ok: boolean, text: string, names: readonly string[]): Record<string, number> {
  if (!ok) throw new JevError(`Jev request failed (${status})`, status)
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
