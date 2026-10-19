import { isIP } from 'node:net';

export interface ResolverLocation {
  city: string;
  country: string;
  countryCode: string;
  lat: number;
  lon: number;
}

export interface ResolverDef {
  name: string;
  label: string;
  ips: string[];
  doh?: string;
  location?: ResolverLocation;
}

export const GLOBAL_RESOLVERS: Record<string, ResolverDef> = {
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

function world(name: string, label: string, ip: string, location: ResolverLocation): ResolverDef {
  return { name, label, ips: [ip], location };
}

export const WORLD_RESOLVER_LIST: ResolverDef[] = [
  world('neustar-us', 'Neustar UltraDNS Public', '156.154.70.1', {
    city: 'Sterling',
    country: 'United States',
    countryCode: 'US',
    lat: 39.0062,
    lon: -77.4286,
  }),
  world('verisign-us', 'Verisign Public DNS', '64.6.64.6', {
    city: 'Reston',
    country: 'United States',
    countryCode: 'US',
    lat: 38.9586,
    lon: -77.357,
  }),
  world('dyn-us', 'Oracle Dyn', '216.146.35.35', {
    city: 'Manchester',
    country: 'United States',
    countryCode: 'US',
    lat: 42.9956,
    lon: -71.4548,
  }),
  world('hurricane-us', 'Hurricane Electric', '74.82.42.42', {
    city: 'Fremont',
    country: 'United States',
    countryCode: 'US',
    lat: 37.5485,
    lon: -121.9886,
  }),
  world('att-us', 'AT&T', '12.127.17.72', {
    city: 'Washington',
    country: 'United States',
    countryCode: 'US',
    lat: 38.9072,
    lon: -77.0369,
  }),
  world('verizon-us', 'Verizon', '151.197.0.38', {
    city: 'Philadelphia',
    country: 'United States',
    countryCode: 'US',
    lat: 39.9526,
    lon: -75.1652,
  }),
  world('cira-ca', 'CIRA Canadian Shield', '149.112.121.10', {
    city: 'Toronto',
    country: 'Canada',
    countryCode: 'CA',
    lat: 43.6532,
    lon: -79.3832,
  }),
  world('servnet-mx', 'Servnet Mexico', '201.150.35.124', {
    city: 'Mexico City',
    country: 'Mexico',
    countryCode: 'MX',
    lat: 19.4326,
    lon: -99.1332,
  }),
  world('uol-br', 'UOL', '200.221.11.100', {
    city: 'Sao Paulo',
    country: 'Brazil',
    countryCode: 'BR',
    lat: -23.5505,
    lon: -46.6333,
  }),
  world('telefonica-cl', 'Telefonica Empresas Chile', '186.103.167.190', {
    city: 'La Serena',
    country: 'Chile',
    countryCode: 'CL',
    lat: -29.9027,
    lon: -71.252,
  }),
  world('dnswatch-de', 'DNS.WATCH', '84.200.69.80', {
    city: 'Frankfurt',
    country: 'Germany',
    countryCode: 'DE',
    lat: 50.1109,
    lon: 8.6821,
  }),
  world('telekom-de', 'Deutsche Telekom', '194.25.0.60', {
    city: 'Bonn',
    country: 'Germany',
    countryCode: 'DE',
    lat: 50.7374,
    lon: 7.0982,
  }),
  world('freenom-nl', 'Freenom World', '80.80.80.80', {
    city: 'Amsterdam',
    country: 'Netherlands',
    countryCode: 'NL',
    lat: 52.3676,
    lon: 4.9041,
  }),
  world('nic-cz', 'CZ.NIC ODVR', '193.17.47.1', {
    city: 'Prague',
    country: 'Czechia',
    countryCode: 'CZ',
    lat: 50.0755,
    lon: 14.4378,
  }),
  world('ovh-fr', 'OVH', '94.23.205.212', {
    city: 'Douai',
    country: 'France',
    countryCode: 'FR',
    lat: 50.37,
    lon: 3.08,
  }),
  world('bt-gb', 'BT', '194.72.35.194', {
    city: 'Redditch',
    country: 'United Kingdom',
    countryCode: 'GB',
    lat: 52.3068,
    lon: -1.945,
  }),
  world('swissdc-ch', 'SwissDC', '194.29.10.6', {
    city: 'Zurich',
    country: 'Switzerland',
    countryCode: 'CH',
    lat: 47.3769,
    lon: 8.5417,
  }),
  world('netplanet-at', 'Netplanet', '89.185.121.250', {
    city: 'Hirtenberg',
    country: 'Austria',
    countryCode: 'AT',
    lat: 47.95,
    lon: 16.2,
  }),
  world('sistel-it', 'Sistel', '185.249.92.4', {
    city: 'Sanremo',
    country: 'Italy',
    countryCode: 'IT',
    lat: 43.816,
    lon: 7.776,
  }),
  world('iptp-ae', 'IPTP Networks', '185.65.175.161', {
    city: 'Dubai',
    country: 'United Arab Emirates',
    countryCode: 'AE',
    lat: 25.2048,
    lon: 55.2708,
  }),
  world('clubweb-il', 'Partner Communications', '212.199.114.11', {
    city: 'Mevaseret Zion',
    country: 'Israel',
    countryCode: 'IL',
    lat: 31.796,
    lon: 35.151,
  }),
  world('shecan-ir', 'Shecan', '178.22.122.100', {
    city: 'Tehran',
    country: 'Iran',
    countryCode: 'IR',
    lat: 35.6892,
    lon: 51.389,
  }),
  world('connect-pk', 'Connect Communications', '118.103.239.9', {
    city: 'Karachi',
    country: 'Pakistan',
    countryCode: 'PK',
    lat: 24.8607,
    lon: 67.0011,
  }),
  world('airtel-in', 'Bharti Airtel', '122.187.48.102', {
    city: 'Gurgaon',
    country: 'India',
    countryCode: 'IN',
    lat: 28.4595,
    lon: 77.0266,
  }),
  world('liquid-ke', 'Liquid Telecom', '196.201.228.22', {
    city: 'Nairobi',
    country: 'Kenya',
    countryCode: 'KE',
    lat: -1.2921,
    lon: 36.8219,
  }),
  world('level3-jp', 'Level3 (Lumen)', '8.0.41.16', {
    city: 'Tokyo',
    country: 'Japan',
    countryCode: 'JP',
    lat: 35.6762,
    lon: 139.6503,
  }),
  world('kt-kr', 'KT', '168.126.63.1', {
    city: 'Seoul',
    country: 'South Korea',
    countryCode: 'KR',
    lat: 37.5665,
    lon: 126.978,
  }),
  world('hgc-hk', 'HGC Global Communications', '210.0.128.250', {
    city: 'Hong Kong',
    country: 'Hong Kong',
    countryCode: 'HK',
    lat: 22.3193,
    lon: 114.1694,
  }),
  world('telkom-id', 'Telkom Indonesia', '118.98.44.10', {
    city: 'Jakarta',
    country: 'Indonesia',
    countryCode: 'ID',
    lat: -6.2088,
    lon: 106.8456,
  }),
  world('csloxinfo-th', 'CS LOXINFO', '203.146.237.237', {
    city: 'Bangkok',
    country: 'Thailand',
    countryCode: 'TH',
    lat: 13.7563,
    lon: 100.5018,
  }),
  world('philmech-ph', 'PhilMech', '122.53.148.218', {
    city: 'Calamba',
    country: 'Philippines',
    countryCode: 'PH',
    lat: 14.2117,
    lon: 121.1653,
  }),
  world('vnpt-vn', 'VNPT', '222.255.206.232', {
    city: 'Ho Chi Minh City',
    country: 'Vietnam',
    countryCode: 'VN',
    lat: 10.8231,
    lon: 106.6297,
  }),
  world('telstra-au', 'Telstra', '139.130.4.4', {
    city: 'Sydney',
    country: 'Australia',
    countryCode: 'AU',
    lat: -33.8688,
    lon: 151.2093,
  }),
];

export const WORLD_RESOLVERS: Record<string, ResolverDef> = Object.fromEntries(
  WORLD_RESOLVER_LIST.map((def) => [def.name, def]),
);

export const RESOLVERS: Record<string, ResolverDef> = { ...GLOBAL_RESOLVERS, ...WORLD_RESOLVERS };

export const WORLD_PRESET = 'world';

export function listResolverNames(): string[] {
  return Object.keys(RESOLVERS);
}

export function listGlobalResolverNames(): string[] {
  return Object.keys(GLOBAL_RESOLVERS);
}

export function listWorldResolverNames(): string[] {
  return Object.keys(WORLD_RESOLVERS);
}

export interface ResolvedServer {
  name: string;
  ips?: string[];
  doh?: string;
  system?: boolean;
  location?: ResolverLocation;
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
    const server: ResolvedServer = { name: def.name, ips: [...def.ips], doh: def.doh };
    if (def.location !== undefined) {
      server.location = { ...def.location };
    }
    return server;
  }
  if (isIP(trimmed) !== 0) {
    return { name: trimmed, ips: [trimmed] };
  }
  throw new Error(
    `unknown resolver "${input}": use "system", a registry name (${listResolverNames().join(', ')}), or a literal IP address`,
  );
}
