import { isIP } from 'node:net';

export interface ResolverDef {
  name: string;
  label: string;
  ips: string[];
  doh?: string;
}

export const RESOLVERS: Record<string, ResolverDef> = {
  cloudflare: {
    name: 'cloudflare',
    label: 'Cloudflare',
    ips: ['1.1.1.1', '1.0.0.1'],
    doh: 'https://cloudflare-dns.com/dns-query',
  },
  google: {
    name: 'google',
    label: 'Google Public DNS',
    ips: ['8.8.8.8', '8.8.4.4'],
    doh: 'https://dns.google/resolve',
  },
  quad9: {
    name: 'quad9',
    label: 'Quad9',
    ips: ['9.9.9.9', '149.112.112.112'],
  },
  opendns: {
    name: 'opendns',
    label: 'OpenDNS',
    ips: ['208.67.222.222', '208.67.220.220'],
  },
  adguard: {
    name: 'adguard',
    label: 'AdGuard DNS',
    ips: ['94.140.14.14', '94.140.15.15'],
  },
  yandex: {
    name: 'yandex',
    label: 'Yandex DNS',
    ips: ['77.88.8.8', '77.88.8.1'],
  },
};

export function listResolverNames(): string[] {
  return Object.keys(RESOLVERS);
}

export interface ResolvedServer {
  name: string;
  ips?: string[];
  doh?: string;
  system?: boolean;
}

export function resolveServer(input: string): ResolvedServer {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('resolver must not be empty');
  }
  if (trimmed === 'system') {
    return { name: 'system', system: true };
  }
  const def = RESOLVERS[trimmed];
  if (def) {
    return { name: def.name, ips: [...def.ips], doh: def.doh };
  }
  if (isIP(trimmed) !== 0) {
    return { name: trimmed, ips: [trimmed] };
  }
  throw new Error(
    `unknown resolver "${input}": use "system", a registry name (${listResolverNames().join(', ')}), or a literal IP address`,
  );
}
