import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { MIN_WATCH_INTERVAL_MS, parseInterval } from '../defaults.js';
import { ShopperError } from '../types.js';

export const SERVICE_NAME = 'shopper-watch.service';
export const TIMER_NAME = 'shopper-watch.timer';
export const DEFAULT_EVERY = '15m';
export const ENABLE_COMMAND =
  'systemctl --user daemon-reload && systemctl --user enable --now shopper-watch.timer';

export interface ExecInfo {
  execPath: string;
  scriptPath: string;
  packaged: boolean;
}

export function execArgs(info: ExecInfo): string[] {
  if (info.packaged) return [resolve(info.execPath)];
  return [resolve(info.execPath), resolve(info.scriptPath)];
}

const SAFE_ARG = /^[A-Za-z0-9_@+=:,./-]+$/;

export function systemdQuote(arg: string): string {
  if (SAFE_ARG.test(arg)) return arg;
  const escaped = arg
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/\$/g, '$$$$');
  return `"${escaped}"`;
}

export function checkEvery(every: string): string {
  const ms = parseInterval(every);
  if (ms === null) throw new ShopperError(`--every '${every}' is not valid: use 15m, 6h or 1d`);
  if (ms < MIN_WATCH_INTERVAL_MS) throw new ShopperError('--every must be 15m or longer');
  return every.trim();
}

export interface UnitOptions {
  every: string;
  exec: string[];
}

export function renderService(opts: UnitOptions): string {
  for (const part of opts.exec) {
    if (!isAbsolute(part)) throw new ShopperError(`ExecStart needs absolute paths, got '${part}'`);
  }
  const start = [...opts.exec, 'watch', 'run-due', '--notify'].map(systemdQuote).join(' ');
  return [
    '[Unit]',
    'Description=Shopper price watches: run the watches that are due',
    '',
    '[Service]',
    'Type=oneshot',
    'Nice=19',
    'MemoryHigh=2G',
    'MemoryMax=3G',
    'EnvironmentFile=-%h/.config/ai-tools/shopper-watch.env',
    `ExecStart=${start}`,
    '',
  ].join('\n');
}

export function renderTimer(opts: Pick<UnitOptions, 'every'>): string {
  return [
    '[Unit]',
    `Description=Shopper price watches: check for due watches every ${opts.every}`,
    '',
    '[Timer]',
    'OnBootSec=5min',
    `OnUnitActiveSec=${opts.every}`,
    'Persistent=true',
    `Unit=${SERVICE_NAME}`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

export function unitDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const config = env.XDG_CONFIG_HOME;
  return join(
    config !== undefined && config !== '' ? config : join(home, '.config'),
    'systemd',
    'user',
  );
}

export interface UnitFiles {
  directory: string;
  service: { path: string; content: string };
  timer: { path: string; content: string };
}

export function renderUnits(opts: UnitOptions, directory: string): UnitFiles {
  return {
    directory,
    service: { path: join(directory, SERVICE_NAME), content: renderService(opts) },
    timer: { path: join(directory, TIMER_NAME), content: renderTimer(opts) },
  };
}

export function writeUnits(files: UnitFiles): void {
  mkdirSync(files.directory, { recursive: true });
  writeFileSync(files.service.path, files.service.content);
  writeFileSync(files.timer.path, files.timer.content);
}
