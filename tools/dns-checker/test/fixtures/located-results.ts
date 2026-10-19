import type { LookupResult } from '../../src/core/types.js';

function result(
  resolver: string,
  values: string[],
  location?: LookupResult['location'],
  error?: string,
): LookupResult {
  return {
    domain: 'example.com',
    type: 'A',
    resolver,
    transport: 'udp',
    answers: values.map((value) => ({ value, ttl: 300 })),
    checkedAt: '2026-01-01T00:00:00.000Z',
    ...(error ? { error } : {}),
    ...(location ? { location } : {}),
  };
}

export const LOCATED_RESULTS: LookupResult[] = [
  result('8.8.8.8', ['203.0.113.10'], {
    city: 'New York',
    country: 'United States',
    countryCode: 'US',
    lat: 40.71,
    lon: -74.0,
  }),
  result('1.1.1.1', ['203.0.113.10'], {
    city: 'Los Angeles',
    country: 'United States',
    countryCode: 'US',
    lat: 34.05,
    lon: -118.24,
  }),
  result('9.9.9.9', ['198.51.100.7'], {
    city: 'Berlin',
    country: 'Germany',
    countryCode: 'DE',
    lat: 52.52,
    lon: 13.4,
  }),
  result(
    '77.88.8.8',
    [],
    { city: 'Tokyo', country: 'Japan', countryCode: 'JP', lat: 35.68, lon: 139.69 },
    'timed out after 5000ms',
  ),
  result('cloudflare', ['203.0.113.10']),
];
