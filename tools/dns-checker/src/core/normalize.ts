import type { DnsAnswer, RecordType } from './types.js';

function answer(value: string, ttl = 0): DnsAnswer {
  return { value, ttl };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function dohAnswers(items: unknown[]): DnsAnswer[] {
  const answers: DnsAnswer[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.data !== 'string') {
      continue;
    }
    answers.push(answer(item.data, finiteNumber(item.TTL) ?? 0));
  }
  return answers;
}

function caaAnswers(item: Record<string, unknown>): DnsAnswer[] {
  const critical = finiteNumber(item.critical) ?? 0;
  const answers: DnsAnswer[] = [];
  for (const tag of ['issue', 'issuewild', 'iodef'] as const) {
    const value = item[tag];
    if (typeof value === 'string') {
      answers.push(answer(`${critical} ${tag} "${value}"`));
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') {
          answers.push(answer(`${critical} ${tag} "${entry}"`));
        }
      }
    }
  }
  return answers;
}

function soaAnswer(raw: Record<string, unknown>): DnsAnswer[] {
  const parts = [raw.nsname, raw.hostmaster, raw.serial, raw.refresh, raw.retry, raw.expire, raw.minttl];
  if (!parts.every((part) => typeof part === 'string' || typeof part === 'number')) {
    return [];
  }
  return [answer(parts.map((part) => String(part)).join(' '))];
}

function arrayAnswers(type: RecordType, items: unknown[]): DnsAnswer[] {
  if (items.length === 0) {
    return [];
  }
  if (items.every((item) => typeof item === 'string')) {
    return (items as string[]).map((value) => answer(value));
  }
  if (items.every((item) => Array.isArray(item) && item.every((chunk) => typeof chunk === 'string'))) {
    return (items as string[][]).map((chunks) => answer(chunks.join('')));
  }
  const answers: DnsAnswer[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    if ((type === 'A' || type === 'AAAA') && typeof item.address === 'string') {
      answers.push(answer(item.address, finiteNumber(item.ttl) ?? 0));
      continue;
    }
    if (type === 'MX' && typeof item.exchange === 'string' && typeof item.priority === 'number') {
      answers.push(answer(`${item.priority} ${item.exchange}`));
      continue;
    }
    if (
      type === 'SRV' &&
      typeof item.target === 'string' &&
      typeof item.priority === 'number' &&
      typeof item.weight === 'number' &&
      typeof item.port === 'number'
    ) {
      answers.push(answer(`${item.priority} ${item.weight} ${item.port} ${item.target}`));
      continue;
    }
    if (type === 'CAA' && typeof item.critical === 'number') {
      answers.push(...caaAnswers(item));
    }
  }
  return answers;
}

export function normalizeAnswers(type: RecordType, raw: unknown): DnsAnswer[] {
  if (raw === null || raw === undefined) {
    return [];
  }
  if (isRecord(raw)) {
    if (Array.isArray(raw.Answer)) {
      return dohAnswers(raw.Answer);
    }
    if (type === 'SOA') {
      return soaAnswer(raw);
    }
    return [];
  }
  if (Array.isArray(raw)) {
    return arrayAnswers(type, raw);
  }
  return [];
}
