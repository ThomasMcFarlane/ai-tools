import { describe, expect, it } from 'vitest';
import { isIP } from 'node:net';
import {
  GLOBAL_RESOLVERS,
  RESOLVERS,
  WORLD_RESOLVER_LIST,
  WORLD_RESOLVERS,
  listGlobalResolverNames,
  listResolverNames,
  listWorldResolverNames,
  resolveServer,
} from '../src/index.js';

describe('RESOLVERS', () => {
  it('keeps exactly the six global presets', () => {
    expect(Object.keys(GLOBAL_RESOLVERS).sort()).toEqual([
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

  it('splits global and world names', () => {
    expect(listGlobalResolverNames()).toEqual(Object.keys(GLOBAL_RESOLVERS));
    expect(listWorldResolverNames()).toEqual(Object.keys(WORLD_RESOLVERS));
    expect(listResolverNames()).toHaveLength(
      listGlobalResolverNames().length + listWorldResolverNames().length,
    );
  });
});

describe('world resolvers', () => {
  it('has a useful number of entries with unique names and unique IPs', () => {
    expect(WORLD_RESOLVER_LIST.length).toBeGreaterThanOrEqual(25);
    const names = WORLD_RESOLVER_LIST.map((def) => def.name);
    expect(new Set(names).size).toBe(names.length);
    const ips = WORLD_RESOLVER_LIST.flatMap((def) => def.ips);
    expect(new Set(ips).size).toBe(ips.length);
  });

  it('does not collide with global preset names', () => {
    for (const name of listWorldResolverNames()) {
      expect(GLOBAL_RESOLVERS[name]).toBeUndefined();
    }
  });

  it('gives every entry a name, label, valid IPv4 addresses and a complete location', () => {
    for (const def of WORLD_RESOLVER_LIST) {
      expect(def.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.ips.length).toBeGreaterThan(0);
      for (const ip of def.ips) {
        expect(isIP(ip)).toBe(4);
      }
      const location = def.location;
      expect(location).toBeDefined();
      expect(location?.city.length).toBeGreaterThan(0);
      expect(location?.country.length).toBeGreaterThan(0);
      expect(location?.countryCode).toMatch(/^[A-Z]{2}$/);
      expect(location?.lat).toBeGreaterThanOrEqual(-90);
      expect(location?.lat).toBeLessThanOrEqual(90);
      expect(location?.lon).toBeGreaterThanOrEqual(-180);
      expect(location?.lon).toBeLessThanOrEqual(180);
    }
  });

  it('leaves anycast global presets without a location', () => {
    for (const def of Object.values(GLOBAL_RESOLVERS)) {
      expect(def.location).toBeUndefined();
    }
  });

  it('carries the location through resolveServer', () => {
    const def = WORLD_RESOLVER_LIST[0];
    const server = resolveServer(def?.name ?? '');
    expect(server.location).toEqual(def?.location);
    expect(resolveServer('cloudflare').location).toBeUndefined();
    expect(resolveServer('192.0.2.10').location).toBeUndefined();
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
