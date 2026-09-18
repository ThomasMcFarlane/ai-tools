import { mkdir, readFile, rename, appendFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GhEvent, GhWatchSpec, GhWatcherState } from './types.js';

export const STATE_FILE = 'watchers.json';
export const EVENTS_FILE = 'events.jsonl';

export function stateDir(): string {
  const override = process.env.AI_TOOLS_GH_WATCHER_STATE_DIR;
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
  return join(base, 'ai-tools', 'gh-watcher');
}

function statePath(): string {
  return join(stateDir(), STATE_FILE);
}

export async function loadState(): Promise<GhWatcherState> {
  let raw: string;
  try {
    raw = await readFile(statePath(), 'utf8');
  } catch {
    return { watchers: [], lastFired: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GhWatcherState>;
    return {
      watchers: Array.isArray(parsed.watchers) ? parsed.watchers : [],
      lastFired: parsed.lastFired !== null && typeof parsed.lastFired === 'object' ? parsed.lastFired : {},
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[gh-watcher] corrupt state file at ${statePath()}: ${message}`);
    return { watchers: [], lastFired: {} };
  }
}

export async function saveState(state: GhWatcherState): Promise<void> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const file = statePath();
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, file);
}

export async function appendEvent(event: GhEvent): Promise<void> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, EVENTS_FILE), `${JSON.stringify(event)}\n`, 'utf8');
}

export async function readEvents(tail = 50): Promise<GhEvent[]> {
  let raw: string;
  try {
    raw = await readFile(join(stateDir(), EVENTS_FILE), 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const events: GhEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as GhEvent);
    } catch {
      continue;
    }
  }
  return events.slice(-tail);
}

export async function upsertWatcher(spec: GhWatchSpec): Promise<void> {
  const state = await loadState();
  const index = state.watchers.findIndex((watcher) => watcher.name === spec.name);
  if (index >= 0) {
    state.watchers[index] = spec;
  } else {
    state.watchers.push(spec);
  }
  await saveState(state);
}

export async function getWatcher(name: string): Promise<GhWatchSpec | undefined> {
  const state = await loadState();
  return state.watchers.find((watcher) => watcher.name === name);
}

export async function removeWatcher(name: string): Promise<boolean> {
  const state = await loadState();
  const index = state.watchers.findIndex((watcher) => watcher.name === name);
  if (index < 0) {
    return false;
  }
  state.watchers.splice(index, 1);
  await saveState(state);
  return true;
}

export async function listWatchers(): Promise<GhWatchSpec[]> {
  const state = await loadState();
  return state.watchers;
}
