import { createSocket, type Socket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGroup } from '../src/core/compare.js';
import { mapLimit } from '../src/core/pool.js';
import { lookup } from '../src/core/resolver.js';
import { formatComparison, createPainter } from '../src/cli/output.js';
import { VERSION } from '../src/version.js';

type Behaviour = 'answer' | 'drop' | 'servfail';

function respond(query: Buffer, rcode: number): Buffer {
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8180 | rcode, 2);
  header.writeUInt16BE(rcode === 0 ? 1 : 0, 6);
  const question = query.subarray(12);
  if (rcode !== 0) {
    return Buffer.concat([header, question]);
  }
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(1, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(60, 6);
  answer.writeUInt16BE(4, 10);
  Buffer.from([192, 0, 2, 7]).copy(answer, 12);
  return Buffer.concat([header, question, answer]);
}

const sockets: Socket[] = [];

async function server(script: Behaviour[]): Promise<{ port: number; received: () => number }> {
  const socket = createSocket('udp4');
  sockets.push(socket);
  let received = 0;
  socket.on('message', (msg, rinfo) => {
    const step = script[received] ?? 'answer';
    received += 1;
    if (step === 'drop') {
      return;
    }
    socket.send(respond(msg, step === 'servfail' ? 2 : 0), rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { port: socket.address().port, received: () => received };
}

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
});

describe('lookup retries', () => {
  it('retries a dropped first packet and reports attempts', async () => {
    const srv = await server(['drop']);
    const result = await lookup('example.com', 'A', {
      resolver: '127.0.0.1',
      transport: 'udp',
      timeoutMs: 150,
      retries: 2,
      port: srv.port,
    });
    expect(result.error).toBeUndefined();
    expect(result.answers.map((a) => a.value)).toEqual(['192.0.2.7']);
    expect(result.attempts).toBe(2);
    expect(srv.received()).toBe(2);
  });

  it('retries after SERVFAIL', async () => {
    const srv = await server(['servfail', 'drop']);
    const result = await lookup('example.com', 'A', {
      resolver: '127.0.0.1',
      transport: 'udp',
      timeoutMs: 150,
      retries: 2,
      port: srv.port,
    });
    expect(result.error).toBeUndefined();
    expect(result.attempts).toBe(3);
  });

  it('gives up after the configured retries', async () => {
    const srv = await server(['drop', 'drop', 'drop', 'drop']);
    const result = await lookup('example.com', 'A', {
      resolver: '127.0.0.1',
      transport: 'udp',
      timeoutMs: 100,
      retries: 1,
      port: srv.port,
    });
    expect(result.error).toMatch(/timed out after 100ms/);
    expect(result.attempts).toBe(2);
    expect(srv.received()).toBe(2);
  });

  it('does not retry with retries 0', async () => {
    const srv = await server(['drop']);
    const result = await lookup('example.com', 'A', {
      resolver: '127.0.0.1',
      transport: 'udp',
      timeoutMs: 100,
      retries: 0,
      port: srv.port,
    });
    expect(result.error).toBeDefined();
    expect(result.attempts).toBe(1);
  });

  it('reports a single attempt on first-try success', async () => {
    const srv = await server([]);
    const result = await lookup('example.com', 'A', {
      resolver: '127.0.0.1',
      transport: 'udp',
      timeoutMs: 500,
      port: srv.port,
    });
    expect(result.attempts).toBe(1);
  });
});

describe('mapLimit', () => {
  it('runs tasks concurrently up to the limit and keeps order', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(3);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, async (n: number) => n)).toEqual([]);
  });
});

describe('attempts in output', () => {
  const base = {
    domain: 'example.com',
    type: 'A' as const,
    transport: 'udp' as const,
    answers: [{ value: '192.0.2.7', ttl: 60 }],
    checkedAt: new Date(0).toISOString(),
  };

  it('marks only resolvers that needed more than one attempt', () => {
    const text = formatComparison(
      buildGroup([
        { ...base, resolver: '192.0.2.1', attempts: 1 },
        { ...base, resolver: '192.0.2.2', attempts: 2 },
      ]),
      createPainter(false),
    );
    expect(text).toContain('192.0.2.2 (2 tries)');
    expect(text).not.toContain('192.0.2.1 (');
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
