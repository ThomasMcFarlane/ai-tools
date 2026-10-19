import { createSocket, type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNsQuery, parseNsResponse, queryNsReferral, referralAnswers } from '../src/index.js';

function encodeName(name: string): Buffer {
  const parts = name
    .split('.')
    .flatMap((label) => [Buffer.from([label.length]), Buffer.from(label)]);
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function nsRecord(owner: Buffer, target: string, ttl: number): Buffer {
  const rdata = encodeName(target);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(2, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([owner, head, rdata]);
}

function referralResponse(query: Buffer, targets: string[], rcode = 0): Buffer {
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8000 | rcode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(targets.length, 8);
  const question = query.subarray(12);
  const pointer = Buffer.from([0xc0, 12]);
  return Buffer.concat([
    header,
    question,
    ...targets.map((target) => nsRecord(pointer, target, 3600)),
  ]);
}

describe('buildNsQuery', () => {
  it('builds a non-recursive NS question', () => {
    const query = buildNsQuery('example.com.', 0x1234);
    expect(query.readUInt16BE(0)).toBe(0x1234);
    expect(query.readUInt16BE(2) & 0x0100).toBe(0);
    expect(query.readUInt16BE(4)).toBe(1);
    expect(
      query
        .subarray(12)
        .equals(Buffer.concat([encodeName('example.com'), Buffer.from([0, 2, 0, 1])])),
    ).toBe(true);
  });

  it('rejects empty labels', () => {
    expect(() => buildNsQuery('a..b', 1)).toThrow(/invalid DNS label/);
  });
});

describe('parseNsResponse', () => {
  it('reads the delegated NS set from the authority section', () => {
    const query = buildNsQuery('example.vc', 7);
    const response = parseNsResponse(
      referralResponse(query, ['ns1.example.net', 'ns2.example.net']),
    );
    expect(response.rcode).toBe(0);
    expect(response.answers).toEqual([]);
    expect(referralAnswers(response)).toEqual([
      { value: 'ns1.example.net', ttl: 3600 },
      { value: 'ns2.example.net', ttl: 3600 },
    ]);
  });

  it('rejects truncated packets', () => {
    expect(() => parseNsResponse(Buffer.alloc(4))).toThrow(/short DNS response/);
  });
});

describe('queryNsReferral', () => {
  let server: Socket | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function startServer(reply: (query: Buffer) => Buffer | undefined): Promise<number> {
    const socket = createSocket('udp4');
    server = socket;
    socket.on('message', (message, remote) => {
      const answer = reply(message);
      if (answer !== undefined) {
        socket.send(answer, remote.port, remote.address);
      }
    });
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    return socket.address().port;
  }

  it('returns the delegated NS set from a parent server referral', async () => {
    let recursionDesired: boolean | undefined;
    const port = await startServer((query) => {
      recursionDesired = (query.readUInt16BE(2) & 0x0100) !== 0;
      return referralResponse(query, ['ns1.example.net', 'ns2.example.net']);
    });
    const answers = await queryNsReferral('127.0.0.1', 'example.vc', { port, timeoutMs: 2000 });
    expect(answers.map((answer) => answer.value)).toEqual(['ns1.example.net', 'ns2.example.net']);
    expect(recursionDesired).toBe(false);
  });

  it('ignores replies with a mismatched id and times out', async () => {
    const port = await startServer((query) => {
      const response = referralResponse(query, ['ns1.example.net']);
      response.writeUInt16BE((query.readUInt16BE(0) + 1) & 0xffff, 0);
      return response;
    });
    await expect(
      queryNsReferral('127.0.0.1', 'example.vc', { port, timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: 'ETIMEOUT' });
  });

  it('rejects non-zero rcodes', async () => {
    const port = await startServer((query) => referralResponse(query, [], 5));
    await expect(
      queryNsReferral('127.0.0.1', 'example.vc', { port, timeoutMs: 2000 }),
    ).rejects.toMatchObject({ code: 'EREFUSED' });
  });
});
