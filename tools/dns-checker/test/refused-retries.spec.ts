import { beforeEach, describe, expect, it, vi } from 'vitest';

const script: string[] = [];
const calls = { count: 0 };

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  class FakeResolver {
    setServers(): void {}
    cancel(): void {}
    async resolveNs(): Promise<string[]> {
      calls.count += 1;
      const step = script.shift();
      if (step !== undefined) {
        throw Object.assign(new Error(`queryNs ${step} example.com`), { code: step });
      }
      return ['ns1.example.net'];
    }
  }
  return { ...actual, Resolver: FakeResolver };
});

const { lookup } = await import('../src/core/resolver.js');

beforeEach(() => {
  script.length = 0;
  calls.count = 0;
});

describe('connection errors are retried', () => {
  it('retries ECONNREFUSED then succeeds', async () => {
    script.push('ECONNREFUSED');
    const result = await lookup('example.com', 'NS', {
      resolver: '127.0.0.1',
      transport: 'udp',
      timeoutMs: 500,
      retries: 2,
    });
    expect(result.error).toBeUndefined();
    expect(result.answers.map((a) => a.value)).toEqual(['ns1.example.net']);
    expect(result.attempts).toBe(2);
  });

  it('retries ECONNRESET then succeeds', async () => {
    script.push('ECONNRESET', 'ECONNREFUSED');
    const result = await lookup('example.com', 'NS', {
      resolver: '127.0.0.1',
      transport: 'udp',
      timeoutMs: 500,
      retries: 2,
    });
    expect(result.error).toBeUndefined();
    expect(result.attempts).toBe(3);
  });

  it('uses three retries by default', async () => {
    script.push('ECONNREFUSED', 'ECONNREFUSED', 'ECONNREFUSED');
    const result = await lookup('example.com', 'NS', {
      resolver: '127.0.0.1',
      transport: 'udp',
      timeoutMs: 500,
    });
    expect(result.error).toBeUndefined();
    expect(result.attempts).toBe(4);
  });

  it('gives up when refusals outlast the retries', async () => {
    script.push('ECONNREFUSED', 'ECONNREFUSED', 'ECONNREFUSED');
    const result = await lookup('example.com', 'NS', {
      resolver: '127.0.0.1',
      transport: 'udp',
      timeoutMs: 500,
      retries: 1,
    });
    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(result.attempts).toBe(2);
  });
});
