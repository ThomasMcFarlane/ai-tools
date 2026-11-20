import { spawn as nodeSpawn } from 'node:child_process';
import { formatSeen } from '../../cli/output.js';
import { formatMoney } from '../money.js';
import type { WatchEvent, WatchEventType } from './diff.js';

export const NOTIFY_TIMEOUT_MS = 60_000;

export interface SpawnRequest {
  command: string;
  input: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface SpawnResult {
  code: number | null;
  stderr: string;
}

export type SpawnFn = (request: SpawnRequest) => Promise<SpawnResult>;

export const shellSpawn: SpawnFn = (request) =>
  new Promise((resolve) => {
    const child = nodeSpawn('/bin/sh', ['-c', request.command], {
      env: request.env,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const finish = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stderr: `notify command timed out after ${request.timeoutMs} ms` });
    }, request.timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000);
    });
    child.on('error', (error) => finish({ code: null, stderr: error.message }));
    child.on('close', (code) => finish({ code, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.input);
  });

interface Label {
  singular: string;
  plural: string;
}

const LABELS: Record<WatchEventType, Label> = {
  new: { singular: 'new', plural: 'new' },
  price_drop: { singular: 'price drop', plural: 'price drops' },
  back_in_stock: { singular: 'back in stock', plural: 'back in stock' },
  threshold: { singular: 'at or under max price', plural: 'at or under max price' },
  scanner_failing: { singular: 'scanner failing', plural: 'scanner failing' },
};

const RECOVERED: Label = { singular: 'scanner recovered', plural: 'scanner recovered' };

const ORDER: Array<WatchEventType | 'recovered'> = [
  'new',
  'price_drop',
  'back_in_stock',
  'threshold',
  'scanner_failing',
  'recovered',
];

function groupOf(event: WatchEvent): WatchEventType | 'recovered' {
  return event.type === 'scanner_failing' && event.recovered === true ? 'recovered' : event.type;
}

export function summaryLine(watchId: string, events: WatchEvent[]): string {
  if (events.length === 0) return `shopper: ${watchId}: no changes`;
  const counts = new Map<WatchEventType | 'recovered', number>();
  for (const event of events) counts.set(groupOf(event), (counts.get(groupOf(event)) ?? 0) + 1);
  const parts: string[] = [];
  for (const group of ORDER) {
    const count = counts.get(group);
    if (count === undefined) continue;
    const label = group === 'recovered' ? RECOVERED : LABELS[group];
    parts.push(`${count} ${count === 1 ? label.singular : label.plural}`);
  }
  return `shopper: ${watchId}: ${parts.join(', ')}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function eventLine(event: WatchEvent): string {
  if (event.type === 'scanner_failing') {
    const label = event.recovered === true ? 'scanner recovered' : 'scanner failing';
    return [label, event.site, oneLine(event.note ?? event.title)].join(' | ');
  }
  const previous =
    event.type === 'back_in_stock'
      ? `was ${event.previousStock ?? 'unknown'}`
      : event.previousPrice === undefined || event.previousPrice === null
        ? 'no earlier price'
        : `was ${formatMoney(event.previousPrice)}`;
  return [
    LABELS[event.type].singular,
    formatMoney(event.price),
    previous,
    event.site,
    oneLine(event.title),
    event.url,
  ].join(' | ');
}

export interface MessageOptions {
  watchId: string;
  events: WatchEvent[];
  timeZones: string[];
  at: Date;
}

export function formatMessage(opts: MessageOptions): string {
  const lines = [summaryLine(opts.watchId, opts.events), ...opts.events.map(eventLine)];
  lines.push(`checked ${formatSeen(opts.at.toISOString(), opts.timeZones)}`);
  return lines.join('\n');
}

export function resolveNotifyCommand(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  configured: string | null,
): string | null {
  if (flag !== undefined && flag.trim() !== '') return flag;
  const fromEnv = env.SHOPPER_NOTIFY_CMD;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
  if (configured !== null && configured.trim() !== '') return configured;
  return null;
}

export interface NotifyRequest {
  watchId: string;
  events: WatchEvent[];
  message: string;
  command: string | null;
  quietUnchanged: boolean;
  env: NodeJS.ProcessEnv;
  spawn: SpawnFn;
  print: ((text: string) => void) | null;
  timeoutMs?: number;
}

export interface NotifyResult {
  method: 'command' | 'stdout' | 'none';
  sent: boolean;
  ok: boolean;
  state: 'fail' | 'ok';
  exitCode?: number | null;
  error?: string;
}

export async function notify(request: NotifyRequest): Promise<NotifyResult> {
  const state = request.events.length > 0 ? 'fail' : 'ok';
  if (request.events.length === 0 && request.quietUnchanged) {
    return { method: 'none', sent: false, ok: true, state };
  }
  if (request.command === null) {
    if (request.print === null) return { method: 'none', sent: false, ok: true, state };
    request.print(request.message);
    return { method: 'stdout', sent: true, ok: true, state };
  }
  const result = await request.spawn({
    command: request.command,
    input: `${request.message}\n`,
    env: {
      ...request.env,
      SHOPPER_WATCH_ID: request.watchId,
      SHOPPER_NOTIFY_STATE: state,
    },
    timeoutMs: request.timeoutMs ?? NOTIFY_TIMEOUT_MS,
  });
  if (result.code === 0) return { method: 'command', sent: true, ok: true, state, exitCode: 0 };
  return {
    method: 'command',
    sent: false,
    ok: false,
    state,
    exitCode: result.code,
    error:
      result.stderr.trim() === ''
        ? `notify command exited with ${result.code ?? 'no code'}`
        : result.stderr.trim(),
  };
}
