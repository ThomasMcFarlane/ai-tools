export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface CdpEvent {
  method: string;
  params: unknown;
  sessionId?: string;
}

export class CdpError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Waiter {
  method: string;
  sessionId: string | undefined;
  predicate: (params: unknown) => boolean;
  resolve: (params: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ConnectOptions {
  factory?: WebSocketFactory;
  timeoutMs?: number;
  commandTimeoutMs?: number;
}

const OPEN = 1;

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly waiters = new Set<Waiter>();
  private closed = false;

  private constructor(
    private readonly socket: WebSocketLike,
    private readonly commandTimeoutMs: number,
  ) {
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('close', () => this.onClose());
    socket.addEventListener('error', () => this.onClose());
  }

  static async connect(url: string, opts: ConnectOptions = {}): Promise<CdpClient> {
    const factory = opts.factory ?? ((target: string) => new WebSocket(target) as WebSocketLike);
    const socket = factory(url);
    const timeoutMs = opts.timeoutMs ?? 10_000;
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(
        () => reject(new CdpError(`timed out connecting to ${url}`)),
        timeoutMs,
      );
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError(`cannot connect to ${url}`));
      });
    });
    return new CdpClient(socket, opts.commandTimeoutMs ?? 30_000);
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError('connection closed'));
    const id = this.nextId;
    this.nextId += 1;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.send(JSON.stringify(message));
    });
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitFor(
    method: string,
    opts: { sessionId?: string; predicate?: (params: unknown) => boolean; timeoutMs?: number } = {},
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        method,
        sessionId: opts.sessionId,
        predicate: opts.predicate ?? (() => true),
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new CdpError(`timed out waiting for ${method}`));
        }, opts.timeoutMs ?? 30_000),
      };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.socket.close();
    this.onClose();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      sessionId?: string;
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) {
        entry.reject(
          new CdpError(message.error.message ?? 'CDP error', message.error.code ?? null),
        );
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== 'string') return;
    const event: CdpEvent = { method: message.method, params: message.params };
    if (message.sessionId !== undefined) event.sessionId = message.sessionId;
    for (const listener of this.listeners) listener(event);
    for (const waiter of [...this.waiters]) {
      if (
        waiter.method === event.method &&
        waiter.sessionId === event.sessionId &&
        waiter.predicate(event.params)
      ) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(event.params);
      }
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new CdpError('connection closed');
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

export async function browserWebSocketUrl(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) throw new CdpError(`DevTools endpoint answered HTTP ${response.status}`);
  const body = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (typeof body.webSocketDebuggerUrl !== 'string') {
    throw new CdpError('DevTools endpoint gave no webSocketDebuggerUrl');
  }
  return body.webSocketDebuggerUrl;
}
