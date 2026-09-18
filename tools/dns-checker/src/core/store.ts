import { mkdir, readFile, rename, appendFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WatchEvent, WatcherState } from './types.js';

export const STATE_FILE = 'watchers.json';
export const EVENTS_FILE = 'events.jsonl';

export function stateDir(): string {
  const override = process.env.AI_TOOLS_DNS_STATE_DIR;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const xdg = process.env.XDG_STATE_HOME;
  const base =
    xdg !== undefined && xdg.length > 0
      ? xdg
      : process.platform === 'win32'
        ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
        : join(homedir(), '.local', 'state');
  return join(base, 'ai-tools', 'dns-checker');
}

function statePath(): string {
  return join(stateDir(), STATE_FILE);
}

export async function loadState(): Promise<WatcherState> {
  let raw: string;
  try {
    raw = await readFile(statePath(), 'utf8');
  } catch {
    return { watchers: [], baselines: {}, matched: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WatcherState>;
    return {
      watchers: Array.isArray(parsed.watchers) ? parsed.watchers : [],
      baselines: parsed.baselines !== null && typeof parsed.baselines === 'object' ? parsed.baselines : {},
      matched: parsed.matched !== null && typeof parsed.matched === 'object' ? parsed.matched : {},
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[dns-checker] corrupt state file at ${statePath()}: ${message}`);
    return { watchers: [], baselines: {}, matched: {} };
  }
}

export async function saveState(state: WatcherState): Promise<void> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const file = statePath();
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, file);
}

export async function appendEvent(event: WatchEvent): Promise<void> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, EVENTS_FILE), `${JSON.stringify(event)}\n`, 'utf8');
}

export async function readEvents(tail = 50): Promise<WatchEvent[]> {
  let raw: string;
  try {
    raw = await readFile(join(stateDir(), EVENTS_FILE), 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const events: WatchEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as WatchEvent);
    } catch {
      continue;
    }
  }
  return events.slice(-tail);
}
