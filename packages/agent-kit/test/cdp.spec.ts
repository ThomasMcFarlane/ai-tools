import { describe, expect, it } from 'vitest';
import { CdpClient, CdpError, browserWebSocketUrl, type WebSocketLike } from '../src/index.js';

class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  private handlers = new Map<string, Array<(event: { data?: unknown }) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.emit('close', {});
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
  }
  emit(type: string, event: { data?: unknown }): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
  reply(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) });
  }
}

async function connect(socket: FakeSocket): Promise<CdpClient> {
  return CdpClient.connect('ws://fake', { factory: () => socket, commandTimeoutMs: 200 });
}

describe('CdpClient', () => {
  it('matches replies to commands by id and sends the session id', async () => {
    const socket = new FakeSocket();
    const client = await connect(socket);
    const promise = client.send('Runtime.evaluate', { expression: '1' }, 'S1');
    expect(socket.sent[0]).toMatchObject({ id: 1, method: 'Runtime.evaluate', sessionId: 'S1' });
    socket.reply({ id: 1, result: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('rejects on a protocol error', async () => {
    const socket = new FakeSocket();
    const client = await connect(socket);
    const promise = client.send('Bad.method');
    socket.reply({ id: 1, error: { code: -32601, message: 'not found' } });
    await expect(promise).rejects.toMatchObject({ name: 'CdpError', code: -32601 });
  });

  it('times out a silent command', async () => {
    const client = await connect(new FakeSocket());
    await expect(client.send('Slow.method')).rejects.toThrow(/timed out/);
  });

  it('delivers events to listeners and waiters', async () => {
    const socket = new FakeSocket();
    const client = await connect(socket);
    const seen: string[] = [];
    client.on((event) => seen.push(event.method));
    const waited = client.waitFor('Page.loadEventFired', { sessionId: 'S1' });
    socket.reply({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S2' });
    socket.reply({ method: 'Page.loadEventFired', params: { timestamp: 2 }, sessionId: 'S1' });
    await expect(waited).resolves.toEqual({ timestamp: 2 });
    expect(seen).toEqual(['Page.loadEventFired', 'Page.loadEventFired']);
  });

  it('rejects pending work when the socket closes', async () => {
    const socket = new FakeSocket();
    const client = await connect(socket);
    const promise = client.send('Any.method');
    socket.close();
    await expect(promise).rejects.toBeInstanceOf(CdpError);
    await expect(client.send('After.close')).rejects.toThrow(/closed/);
    expect(client.isClosed).toBe(true);
  });
});

describe('browserWebSocketUrl', () => {
  it('reads the debugger URL from /json/version', async () => {
    const fake = (async (url: string) => {
      expect(url).toBe('http://127.0.0.1:9333/json/version');
      return new Response(
        JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/x' }),
      );
    }) as unknown as typeof fetch;
    await expect(browserWebSocketUrl(9333, fake)).resolves.toBe(
      'ws://127.0.0.1:9333/devtools/browser/x',
    );
  });

  it('fails when the endpoint is missing the URL', async () => {
    const fake = (async () => new Response('{}')) as unknown as typeof fetch;
    await expect(browserWebSocketUrl(1, fake)).rejects.toThrow(/webSocketDebuggerUrl/);
  });
});
