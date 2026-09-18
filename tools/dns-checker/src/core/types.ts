import type { HookConfig } from '@ai-tools/hooks';

export type { HookConfig, HookResult } from '@ai-tools/hooks';

export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'TXT' | 'SOA' | 'SRV' | 'CAA' | 'PTR';

export type Transport = 'udp' | 'doh' | 'system';

export type TransportPreference = Transport | 'auto';

export interface DnsAnswer {
  value: string;
  ttl: number;
}

export interface LookupResult {
  domain: string;
  type: RecordType;
  resolver: string;
  transport: Transport;
  answers: DnsAnswer[];
  checkedAt: string;
  error?: string;
}

export type MatchRule =
  | { kind: 'any-change' }
  | { kind: 'equals'; values: string[] }
  | { kind: 'includes'; values: string[] }
  | { kind: 'excludes'; values: string[] }
  | { kind: 'contains'; value: string }
  | { kind: 'regex'; pattern: string; flags?: string }
  | { kind: 'absent' };

export interface MatchOutcome {
  matched: boolean;
  reason: string;
}

export interface WatchSpec {
  name: string;
  domain: string;
  type: RecordType;
  rule: MatchRule;
  resolver?: string;
  transport?: TransportPreference;
  intervalSeconds: number;
  hook: HookConfig;
  createdAt: string;
  lastCheckedAt?: string;
  lastMatchAt?: string;
}

export interface WatchEvent {
  watch: string;
  domain: string;
  type: RecordType;
  matched: boolean;
  reason: string;
  values: string[];
  checkedAt: string;
  fired: boolean;
  error?: string;
}

export interface WatcherState {
  watchers: WatchSpec[];
  baselines: Record<string, string[]>;
  matched: Record<string, boolean>;
}

export const RECORD_TYPES: readonly RecordType[] = [
  'A',
  'AAAA',
  'CNAME',
  'MX',
  'NS',
  'TXT',
  'SOA',
  'SRV',
  'CAA',
  'PTR',
];
