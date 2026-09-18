import { describe, expect, it } from 'vitest';
import { normalizeAnswers } from '../src/index.js';

describe('normalizeAnswers', () => {
  it('normalises plain A strings', () => {
    expect(normalizeAnswers('A', ['192.0.2.1', '192.0.2.2'])).toEqual([
      { value: '192.0.2.1', ttl: 0 },
      { value: '192.0.2.2', ttl: 0 },
    ]);
  });

  it('normalises AAAA strings', () => {
    expect(normalizeAnswers('AAAA', ['2001:db8::1'])).toEqual([{ value: '2001:db8::1', ttl: 0 }]);
  });

  it('normalises A records with ttl', () => {
    expect(normalizeAnswers('A', [{ address: '192.0.2.1', ttl: 300 }])).toEqual([
      { value: '192.0.2.1', ttl: 300 },
    ]);
  });

  it('normalises AAAA records with ttl', () => {
    expect(normalizeAnswers('AAAA', [{ address: '2001:db8::1', ttl: 60 }])).toEqual([
      { value: '2001:db8::1', ttl: 60 },
    ]);
  });

  it('normalises CNAME, NS and PTR string arrays', () => {
    expect(normalizeAnswers('CNAME', ['www.example.com'])).toEqual([{ value: 'www.example.com', ttl: 0 }]);
    expect(normalizeAnswers('NS', ['ns1.example.com', 'ns2.example.com'])).toEqual([
      { value: 'ns1.example.com', ttl: 0 },
      { value: 'ns2.example.com', ttl: 0 },
    ]);
    expect(normalizeAnswers('PTR', ['host.example.com'])).toEqual([{ value: 'host.example.com', ttl: 0 }]);
  });

  it('joins TXT chunks', () => {
    expect(normalizeAnswers('TXT', [['v=spf1 ', 'include:example.com ~all']])).toEqual([
      { value: 'v=spf1 include:example.com ~all', ttl: 0 },
    ]);
  });

  it('formats MX records', () => {
    expect(
      normalizeAnswers('MX', [
        { priority: 10, exchange: 'mail.example.com' },
        { priority: 20, exchange: 'mail2.example.com' },
      ]),
    ).toEqual([
      { value: '10 mail.example.com', ttl: 0 },
      { value: '20 mail2.example.com', ttl: 0 },
    ]);
  });

  it('formats SRV records', () => {
    expect(
      normalizeAnswers('SRV', [{ priority: 10, weight: 20, port: 5060, target: 'sip.example.com' }]),
    ).toEqual([{ value: '10 20 5060 sip.example.com', ttl: 0 }]);
  });

  it('formats CAA records', () => {
    expect(normalizeAnswers('CAA', [{ critical: 0, issue: 'example.com' }])).toEqual([
      { value: '0 issue "example.com"', ttl: 0 },
    ]);
    expect(normalizeAnswers('CAA', [{ critical: 1, iodef: 'mailto:sec@example.com' }])).toEqual([
      { value: '1 iodef "mailto:sec@example.com"', ttl: 0 },
    ]);
  });

  it('formats CAA records with array values', () => {
    expect(normalizeAnswers('CAA', [{ critical: 0, issue: ['example.com', 'example.org'] }])).toEqual([
      { value: '0 issue "example.com"', ttl: 0 },
      { value: '0 issue "example.org"', ttl: 0 },
    ]);
  });

  it('formats SOA records space joined', () => {
    expect(
      normalizeAnswers('SOA', {
        nsname: 'ns1.example.com',
        hostmaster: 'hostmaster.example.com',
        serial: 2026010101,
        refresh: 7200,
        retry: 3600,
        expire: 1209600,
        minttl: 3600,
      }),
    ).toEqual([
      {
        value: 'ns1.example.com hostmaster.example.com 2026010101 7200 3600 1209600 3600',
        ttl: 0,
      },
    ]);
  });

  it('normalises DoH Answer arrays', () => {
    expect(
      normalizeAnswers('A', {
        Status: 0,
        Answer: [
          { name: 'example.com', type: 1, TTL: 3600, data: '192.0.2.1' },
          { name: 'example.com', type: 1, TTL: 1800, data: '192.0.2.2' },
        ],
      }),
    ).toEqual([
      { value: '192.0.2.1', ttl: 3600 },
      { value: '192.0.2.2', ttl: 1800 },
    ]);
  });

  it('defaults DoH TTL to zero when missing', () => {
    expect(normalizeAnswers('A', { Answer: [{ name: 'example.com', type: 1, data: '192.0.2.1' }] })).toEqual([
      { value: '192.0.2.1', ttl: 0 },
    ]);
  });

  it('returns empty for DoH without Answer', () => {
    expect(normalizeAnswers('A', { Status: 0 })).toEqual([]);
  });

  it('returns empty for unknown shapes', () => {
    expect(normalizeAnswers('A', null)).toEqual([]);
    expect(normalizeAnswers('A', undefined)).toEqual([]);
    expect(normalizeAnswers('A', 42)).toEqual([]);
    expect(normalizeAnswers('A', { unexpected: true })).toEqual([]);
    expect(normalizeAnswers('A', [])).toEqual([]);
    expect(normalizeAnswers('SOA', { broken: true })).toEqual([]);
  });
});
