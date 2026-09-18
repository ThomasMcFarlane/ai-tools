import { describe, expect, it } from 'vitest';
import { RESOLVERS, listResolverNames, resolveServer } from '../src/index.js';

describe('RESOLVERS', () => {
  it('contains exactly the six known resolvers', () => {
    expect(Object.keys(RESOLVERS).sort()).toEqual([
      'adguard',
      'cloudflare',
      'google',
      'opendns',
      'quad9',
      'yandex',
    ]);
  });

  it('exposes cloudflare with ips and DoH', () => {
    expect(RESOLVERS['cloudflare']).toEqual({
      name: 'cloudflare',
      label: 'Cloudflare',
      ips: ['1.1.1.1', '1.0.0.1'],
      doh: 'https://cloudflare-dns.com/dns-query',
    });
  });

  it('exposes google with ips and DoH', () => {
    expect(RESOLVERS['google']?.ips).toEqual(['8.8.8.8', '8.8.4.4']);
    expect(RESOLVERS['google']?.doh).toBe('https://dns.google/resolve');
  });

  it('leaves quad9, opendns, adguard and yandex on UDP only', () => {
    for (const name of ['quad9', 'opendns', 'adguard', 'yandex']) {
      expect(RESOLVERS[name]?.doh).toBeUndefined();
      expect(RESOLVERS[name]?.ips).toHaveLength(2);
    }
  });
});

describe('listResolverNames', () => {
  it('lists every registry entry', () => {
    expect(listResolverNames()).toEqual(Object.keys(RESOLVERS));
  });
});

describe('resolveServer', () => {
  it('accepts system', () => {
    expect(resolveServer('system')).toEqual({ name: 'system', system: true });
  });

  it('accepts registry names', () => {
    const server = resolveServer('cloudflare');
    expect(server.name).toBe('cloudflare');
    expect(server.ips).toEqual(['1.1.1.1', '1.0.0.1']);
    expect(server.doh).toBe('https://cloudflare-dns.com/dns-query');
  });

  it('accepts literal IPv4 addresses', () => {
    expect(resolveServer('192.0.2.10')).toEqual({ name: '192.0.2.10', ips: ['192.0.2.10'] });
  });

  it('accepts literal IPv6 addresses', () => {
    expect(resolveServer('2001:db8::1')).toEqual({ name: '2001:db8::1', ips: ['2001:db8::1'] });
  });

  it('rejects unknown names', () => {
    expect(() => resolveServer('not-a-resolver')).toThrow(/unknown resolver/);
  });

  it('rejects empty input', () => {
    expect(() => resolveServer('')).toThrow(/empty/);
    expect(() => resolveServer('   ')).toThrow(/empty/);
  });

  it('rejects malformed addresses', () => {
    expect(() => resolveServer('999.999.999.999')).toThrow(/unknown resolver/);
    expect(() => resolveServer('example.com')).toThrow(/unknown resolver/);
  });
});
