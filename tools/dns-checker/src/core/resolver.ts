import { Resolver as DnsResolver } from 'node:dns/promises';
import * as dnsPromises from 'node:dns/promises';
import { normalizeAnswers } from './normalize.js';
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
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 5000;

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
    () => rejectDeadline?.(new Error(`${opts.label} timed out after ${opts.timeoutMs}ms`)),
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

async function udpLookup(
  domain: string,
  type: RecordType,
  ip: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<DnsAnswer[]> {
  const resolver = new DnsResolver({ timeout: timeoutMs });
  resolver.setServers([ip]);
  return withDeadline(() => queryUdp(resolver, domain, type), {
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
  const base = { domain, type, resolver: server.name, transport, checkedAt };
  if (transport === 'system') {
    const answers = await withDeadline(() => querySystem(domain, type), {
      timeoutMs,
      signal: opts.signal,
      onCancel: () => undefined,
      label: 'system lookup',
    });
    return { ...base, answers: sortAnswers(answers) };
  }
  try {
    if (transport === 'doh') {
      const outcome = await dohLookup(server.doh as string, domain, type, timeoutMs, opts.signal);
      if (outcome.error !== undefined) {
        return { ...base, answers: [], error: outcome.error };
      }
      return { ...base, answers: sortAnswers(outcome.answers) };
    }
    const ip = server.ips?.[0];
    if (ip === undefined) {
      throw new Error(`resolver "${server.name}" has no IP address for UDP`);
    }
    const answers = await udpLookup(domain, type, ip, timeoutMs, opts.signal);
    return { ...base, answers: sortAnswers(answers) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, answers: [], error: message };
  }
}

export function answerValues(result: LookupResult): string[] {
  return result.answers.map((entry) => entry.value);
}
