import { isIP } from 'node:net';
import { Resolver as DnsResolver } from 'node:dns/promises';
import * as dnsPromises from 'node:dns/promises';
import { normalizeAnswers } from './normalize.js';
import { queryNsReferral } from './referral.js';
import { resolveServer, type ResolvedServer } from './resolvers.js';
import {
  RECORD_TYPES,
  type DnsAnswer,
  type LookupResult,
  type RecordType,
  type Transport,
  type TransportPreference,
} from './types.js';

export interface LookupOptions {
  resolver?: string;
  transport?: TransportPreference;
  timeoutMs?: number;
  retries?: number;
  port?: number;
  signal?: AbortSignal;
}

export const DEFAULT_TIMEOUT_MS = 2000;
export const DEFAULT_RETRIES = 3;

const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'ETIMEOUT',
  'ETIMEDOUT',
  'ESERVFAIL',
  'EREFUSED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

const RECORD_TYPE_SET: ReadonlySet<string> = new Set(RECORD_TYPES);

interface DeadlineOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  onCancel: () => void;
  label: string;
}

function withDeadline<T>(task: () => Promise<T>, opts: DeadlineOptions): Promise<T> {
  let rejectDeadline: ((reason: Error) => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(
    () =>
      rejectDeadline?.(
        Object.assign(new Error(`${opts.label} timed out after ${opts.timeoutMs}ms`), {
          code: 'ETIMEOUT',
        }),
      ),
    opts.timeoutMs,
  );
  const onAbort = (): void => {
    rejectDeadline?.(new Error(`${opts.label} aborted`));
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const pending = task();
  void pending.catch(() => undefined);
  return Promise.race([pending, deadline]).finally(() => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    opts.onCancel();
  });
}

function combineSignals(primary: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  return primary ? AbortSignal.any([primary, timeout]) : timeout;
}

function sortAnswers(answers: DnsAnswer[]): DnsAnswer[] {
  return [...answers].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

function pickTransport(server: ResolvedServer, preference: TransportPreference): Transport {
  if (server.system || preference === 'system') {
    return 'system';
  }
  if (preference === 'doh' || preference === 'udp') {
    return preference;
  }
  return server.doh ? 'doh' : 'udp';
}

async function queryUdp(
  resolver: DnsResolver,
  domain: string,
  type: RecordType,
): Promise<DnsAnswer[]> {
  switch (type) {
    case 'A':
      return normalizeAnswers(type, await resolver.resolve4(domain, { ttl: true }));
    case 'AAAA':
      return normalizeAnswers(type, await resolver.resolve6(domain, { ttl: true }));
    case 'CNAME':
      return normalizeAnswers(type, await resolver.resolveCname(domain));
    case 'NS':
      return normalizeAnswers(type, await resolver.resolveNs(domain));
    case 'PTR':
      return normalizeAnswers(type, await resolver.resolvePtr(domain));
    case 'TXT':
      return normalizeAnswers(type, await resolver.resolveTxt(domain));
    case 'MX':
      return normalizeAnswers(type, await resolver.resolveMx(domain));
    case 'SRV':
      return normalizeAnswers(type, await resolver.resolveSrv(domain));
    case 'SOA':
      return normalizeAnswers(type, await resolver.resolveSoa(domain));
    case 'CAA':
      return normalizeAnswers(type, await resolver.resolveCaa(domain));
  }
}

async function querySystem(domain: string, type: RecordType): Promise<DnsAnswer[]> {
  switch (type) {
    case 'A':
      return normalizeAnswers(type, await dnsPromises.resolve4(domain, { ttl: true }));
    case 'AAAA':
      return normalizeAnswers(type, await dnsPromises.resolve6(domain, { ttl: true }));
    case 'CNAME':
      return normalizeAnswers(type, await dnsPromises.resolveCname(domain));
    case 'NS':
      return normalizeAnswers(type, await dnsPromises.resolveNs(domain));
    case 'PTR':
      return normalizeAnswers(type, await dnsPromises.resolvePtr(domain));
    case 'TXT':
      return normalizeAnswers(type, await dnsPromises.resolveTxt(domain));
    case 'MX':
      return normalizeAnswers(type, await dnsPromises.resolveMx(domain));
    case 'SRV':
      return normalizeAnswers(type, await dnsPromises.resolveSrv(domain));
    case 'SOA':
      return normalizeAnswers(type, await dnsPromises.resolveSoa(domain));
    case 'CAA':
      return normalizeAnswers(type, await dnsPromises.resolveCaa(domain));
  }
}

function isNoDataError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENODATA';
}

async function withNsReferral(
  direct: () => Promise<DnsAnswer[]>,
  domain: string,
  ip: string,
  timeoutMs: number,
): Promise<DnsAnswer[]> {
  try {
    return await direct();
  } catch (error) {
    if (!isNoDataError(error)) {
      throw error;
    }
    const referral = await queryNsReferral(ip, domain, { timeoutMs }).catch((referralError: unknown) => {
      if (isRetryableError(referralError)) {
        throw referralError;
      }
      return [];
    });
    if (referral.length === 0) {
      throw error;
    }
    return referral;
  }
}

function isRetryableError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE_CODES.has(code);
}

function serverAddress(ip: string, port: number | undefined): string {
  if (port === undefined) {
    return ip;
  }
  return isIP(ip) === 6 ? `[${ip}]:${port}` : `${ip}:${port}`;
}

interface AttemptCounter {
  attempts: number;
}

async function udpLookupWithRetries(
  domain: string,
  type: RecordType,
  ip: string,
  opts: { timeoutMs: number; retries: number; port?: number; signal?: AbortSignal },
  counter: AttemptCounter,
): Promise<DnsAnswer[]> {
  for (;;) {
    counter.attempts += 1;
    try {
      return await udpLookup(domain, type, ip, opts.timeoutMs, opts.signal, opts.port);
    } catch (error) {
      if (
        counter.attempts > opts.retries ||
        opts.signal?.aborted === true ||
        !isRetryableError(error)
      ) {
        throw error;
      }
    }
  }
}

async function udpLookup(
  domain: string,
  type: RecordType,
  ip: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  port: number | undefined,
): Promise<DnsAnswer[]> {
  const resolver = new DnsResolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([serverAddress(ip, port)]);
  const direct = (): Promise<DnsAnswer[]> => queryUdp(resolver, domain, type);
  const task = type === 'NS' ? () => withNsReferral(direct, domain, ip, timeoutMs) : direct;
  return withDeadline(task, {
    timeoutMs,
    signal,
    onCancel: () => resolver.cancel(),
    label: `UDP lookup via ${ip}`,
  });
}

interface DohPayload {
  Status?: number;
  Answer?: { data?: unknown; TTL?: number }[];
}

async function dohLookup(
  endpoint: string,
  domain: string,
  type: RecordType,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ answers: DnsAnswer[]; error?: string }> {
  const url = `${endpoint}?name=${encodeURIComponent(domain)}&type=${type}`;
  const combined = combineSignals(signal, AbortSignal.timeout(timeoutMs));
  const response = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    signal: combined,
  });
  if (!response.ok) {
    return { answers: [], error: `DoH HTTP ${response.status}` };
  }
  const payload = (await response.json()) as DohPayload;
  if (typeof payload.Status === 'number' && payload.Status !== 0) {
    return { answers: [], error: `DoH status ${payload.Status}` };
  }
  return { answers: normalizeAnswers(type, payload) };
}

export async function lookup(domain: string, type: RecordType, opts: LookupOptions = {}): Promise<LookupResult> {
  if (typeof domain !== 'string' || domain.trim().length === 0) {
    throw new Error('lookup requires a non-empty domain');
  }
  if (!RECORD_TYPE_SET.has(type)) {
    throw new Error(`unsupported record type: ${String(type)}`);
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, Math.floor(opts.retries ?? DEFAULT_RETRIES));
  const preference = opts.transport ?? 'auto';
  let server = resolveServer(opts.resolver ?? 'system');
  if (preference === 'system' && !server.system) {
    server = { name: 'system', system: true };
  }
  const transport = pickTransport(server, preference);
  if (transport === 'doh' && !server.doh) {
    throw new Error(`resolver "${server.name}" has no DoH endpoint`);
  }
  const checkedAt = new Date().toISOString();
  const base = {
    domain,
    type,
    resolver: server.name,
    transport,
    checkedAt,
    ...(server.location ? { location: server.location } : {}),
  };
  if (transport === 'system') {
    const answers = await withDeadline(() => querySystem(domain, type), {
      timeoutMs,
      signal: opts.signal,
      onCancel: () => undefined,
      label: 'system lookup',
    });
    return { ...base, answers: sortAnswers(answers), attempts: 1 };
  }
  const counter: AttemptCounter = { attempts: 0 };
  try {
    if (transport === 'doh') {
      counter.attempts = 1;
      const outcome = await dohLookup(server.doh as string, domain, type, timeoutMs, opts.signal);
      if (outcome.error !== undefined) {
        return { ...base, answers: [], error: outcome.error, attempts: 1 };
      }
      return { ...base, answers: sortAnswers(outcome.answers), attempts: 1 };
    }
    const ip = server.ips?.[0];
    if (ip === undefined) {
      throw new Error(`resolver "${server.name}" has no IP address for UDP`);
    }
    const answers = await udpLookupWithRetries(
      domain,
      type,
      ip,
      { timeoutMs, retries, port: opts.port, signal: opts.signal },
      counter,
    );
    return { ...base, answers: sortAnswers(answers), attempts: counter.attempts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, answers: [], error: message, attempts: Math.max(1, counter.attempts) };
  }
}

export function answerValues(result: LookupResult): string[] {
  return result.answers.map((entry) => entry.value);
}
