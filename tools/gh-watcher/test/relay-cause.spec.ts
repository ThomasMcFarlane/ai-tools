import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelaySession, RelayUnreachableError } from '../src/index.js';

const identity = (raw: unknown): unknown => raw;

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** A session whose deadline has passed after the first failure, so the error surfaces at once. */
function session(baseUrl: string, logs: string[], fetchFn?: typeof fetch): RelaySession {
  let now = 0;
  return new RelaySession({
    baseUrl,
    deadline: 1000,
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    log: (line) => logs.push(line),
    ...(fetchFn !== undefined ? { fetchFn } : {}),
  });
}

describe('the relay error names the real cause', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout: the relay answers after wait + 10 s', async () => {
    vi.useFakeTimers();
    // A relay that never answers in time: the request rejects when the client aborts it.
    const slow = ((_url: URL, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;
    const logs: string[] = [];
    const pending = session('http://relay.invalid', logs, slow)
      .get('api/status', {}, 25, identity)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(35_000);
    const error = await pending;
    expect(error).toBeInstanceOf(RelayUnreachableError);
    expect((error as Error).message).toBe('relay timed out after 35 s at http://relay.invalid');
    expect(logs[0]).toBe('gh-watcher: ERROR relay timed out after 35 s at http://relay.invalid');
    expect(`${logs.join('\n')}${(error as Error).message}`).not.toContain('unreachable');
  });

  it('HTTP status: a reachable relay answers 503', async () => {
    const { server, url } = await listen((_req, res) => {
      res.statusCode = 503;
      res.end('busy');
    });
    try {
      const logs: string[] = [];
      const error = await session(url, logs).get('api/status', {}, 0, identity).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RelayUnreachableError);
      expect((error as Error).message).toBe(`relay answered HTTP 503 at ${url}`);
      expect(logs[0]).toBe(`gh-watcher: ERROR relay answered HTTP 503 at ${url}`);
      expect(logs.join('\n')).not.toContain('unreachable');
    } finally {
      await close(server);
    }
  });

  it('connection error: the relay refuses the connection', async () => {
    const { server, url } = await listen((_req, res) => res.end());
    await close(server); // the port is now free, so a connection is refused
    const logs: string[] = [];
    const error = await session(url, logs).get('api/status', {}, 0, identity).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayUnreachableError);
    expect((error as Error).message).toBe(`relay connection failed at ${url}: ECONNREFUSED`);
    expect(logs[0]).toBe(`gh-watcher: ERROR relay connection failed at ${url}: ECONNREFUSED`);
  });

  it('connection error: the host name does not resolve', async () => {
    const logs: string[] = [];
    const error = await session('http://no-such-host.invalid', logs).get('api/status', {}, 0, identity).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^relay connection failed at http:\/\/no-such-host\.invalid: (ENOTFOUND|EAI_AGAIN)$/);
  });
});
