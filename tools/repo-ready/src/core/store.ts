import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RepoState } from './identity.js';
import type { LogEvent, StoredMap } from './types.js';

const MAP_FILE = 'map.json';
const MAPS_DIR = 'maps';
const EVENTS_FILE = 'events.jsonl';
const REPO_FILE = 'repo.json';

export function stateDir(): string {
  const override = process.env.AI_TOOLS_REPO_READY_STATE_DIR;
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
  return join(base, 'ai-tools', 'repo-ready');
}

export function repoDir(stateRoot: string, dirName: string): string {
  return join(stateRoot, 'repos', dirName);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

export async function readMap(dir: string): Promise<StoredMap | null> {
  const raw = await readOptional(join(dir, MAP_FILE));
  return raw === null ? null : (JSON.parse(raw) as StoredMap);
}

export async function writeMap(dir: string, map: StoredMap, repo: RepoState): Promise<void> {
  await mkdir(join(dir, MAPS_DIR), { recursive: true });
  try {
    await writeFile(
      join(dir, REPO_FILE),
      `${JSON.stringify({ key: repo.key, root: repo.root, firstSeenAt: map.setAt }, null, 2)}\n`,
      { flag: 'wx' },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const earlier = await readMap(dir);
  if (earlier !== null) {
    await rename(
      join(dir, MAP_FILE),
      join(dir, MAPS_DIR, `${earlier.setAt.replaceAll(':', '-')}.json`),
    );
  }
  const temporary = join(dir, `${MAP_FILE}.tmp`);
  await writeFile(temporary, `${JSON.stringify(map, null, 2)}\n`);
  await rename(temporary, join(dir, MAP_FILE));
}

export async function appendEvent(dir: string, event: LogEvent): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, EVENTS_FILE), `${JSON.stringify(event)}\n`);
}

export async function readEvents(dir: string): Promise<LogEvent[]> {
  const file = join(dir, EVENTS_FILE);
  const raw = await readOptional(file);
  if (raw === null) {
    return [];
  }
  const events: LogEvent[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      events.push(JSON.parse(line) as LogEvent);
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    console.warn(`${file}: skipped ${skipped} damaged line${skipped === 1 ? '' : 's'}`);
  }
  return events;
}

export async function resetRepo(dir: string): Promise<boolean> {
  try {
    await stat(dir);
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
  await rm(dir, { recursive: true, force: true });
  return true;
}
