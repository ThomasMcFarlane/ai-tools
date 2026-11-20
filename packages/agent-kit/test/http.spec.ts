import { describe, expect, it } from 'vitest';
import { HttpError, fetchText } from '../src/index.js';

function sequence(responses: Array<Response | Error>): {
  fetchImpl: typeof fetch;
  calls: number[];
} {
  const calls: number[] = [];
  const fetchImpl = (async () => {
    calls.push(calls.length);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return (next as Response).clone();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => undefined;

describe('fetchText', () => {
  it('returns text, status and headers', async () => {
    const { fetchImpl } = sequence([
      new Response('hello', { status: 200, headers: { 'x-a': 'b' } }),
    ]);
    const out = await fetchText('https://example.com/', { fetchImpl, sleep: noSleep });
    expect(out).toMatchObject({ status: 200, text: 'hello', headers: { 'x-a': 'b' } });
  });

  it('retries 5xx and then succeeds', async () => {
    const { fetchImpl, calls } = sequence([
      new Response('no', { status: 503 }),
      new Response('ok', { status: 200 }),
    ]);
    const out = await fetchText('https://example.com/', { fetchImpl, sleep: noSleep });
    expect(out.text).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 404', async () => {
    const { fetchImpl, calls } = sequence([new Response('gone', { status: 404 })]);
    const out = await fetchText('https://example.com/', { fetchImpl, sleep: noSleep });
    expect(out.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it('returns the last 5xx response after the retries run out', async () => {
    const { fetchImpl, calls } = sequence([new Response('bad', { status: 502 })]);
    const out = await fetchText('https://example.com/', { fetchImpl, sleep: noSleep, retries: 1 });
    expect(out.status).toBe(502);
    expect(calls).toHaveLength(2);
  });

  it('throws HttpError after repeated network failures', async () => {
    const { fetchImpl, calls } = sequence([new Error('boom')]);
    await expect(
      fetchText('https://example.com/', { fetchImpl, sleep: noSleep, retries: 2 }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(3);
  });

  it('sends the user agent and custom headers', async () => {
    let seen: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return new Response('x');
    }) as unknown as typeof fetch;
    await fetchText('https://example.com/', {
      fetchImpl,
      userAgent: 'test-agent',
      headers: { 'accept-language': 'th' },
    });
    expect(seen['user-agent']).toBe('test-agent');
    expect(seen['accept-language']).toBe('th');
  });
});
