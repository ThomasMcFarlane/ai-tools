import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendEvent,
  readEvents,
  readMap,
  repoDir,
  resetRepo,
  stateDir,
  writeMap,
} from '../src/core/store.js';
import { askEvent, map, repo } from './helpers.js';

let dir: string;
let savedOverride: string | undefined;
let savedXdg: string | undefined;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'repo-ready-store-'));
  savedOverride = process.env['AI_TOOLS_REPO_READY_STATE_DIR'];
  savedXdg = process.env['XDG_STATE_HOME'];
});

afterEach(async () => {
  restore('AI_TOOLS_REPO_READY_STATE_DIR', savedOverride);
  restore('XDG_STATE_HOME', savedXdg);
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('store', () => {
  it('stateDir honours the override, then XDG_STATE_HOME', () => {
    process.env['AI_TOOLS_REPO_READY_STATE_DIR'] = '/x/override';
    expect(stateDir()).toBe('/x/override');
    delete process.env['AI_TOOLS_REPO_READY_STATE_DIR'];
    process.env['XDG_STATE_HOME'] = '/x/state';
    expect(stateDir()).toBe('/x/state/ai-tools/repo-ready');
  });

  it('repoDir nests the folder under repos/', () => {
    expect(repoDir('/x/root', 'name-1')).toBe(join('/x/root', 'repos', 'name-1'));
  });

  it('readMap returns null and readEvents returns [] for a new folder', async () => {
    expect(await readMap(dir)).toBeNull();
    expect(await readEvents(dir)).toEqual([]);
  });

  it('writeMap keeps the earlier map under maps/', async () => {
    await writeMap(dir, { ...map, setAt: '2026-01-01T00:00:00.000Z' }, repo);
    await writeMap(dir, { ...map, setAt: '2026-01-02T00:00:00.000Z' }, repo);
    expect((await readMap(dir))?.setAt).toBe('2026-01-02T00:00:00.000Z');
    expect(await readdir(join(dir, 'maps'))).toEqual(['2026-01-01T00-00-00.000Z.json']);
  });

  it('writeMap leaves the live map whole when a later write fails', async () => {
    const first = { ...map, setAt: '2026-01-01T00:00:00.000Z' };
    await writeMap(dir, first, repo);
    await mkdir(join(dir, 'map.json.tmp'));
    await expect(
      writeMap(dir, { ...map, setAt: '2026-01-02T00:00:00.000Z' }, repo),
    ).rejects.toThrow();
    expect(await readMap(dir)).toEqual(first);
  });

  it('writeMap writes repo.json once and leaves it alone afterwards', async () => {
    await writeMap(dir, { ...map, setAt: '2026-01-01T00:00:00.000Z' }, repo);
    await writeMap(dir, { ...map, setAt: '2026-01-02T00:00:00.000Z' }, repo);
    expect(JSON.parse(await readFile(join(dir, 'repo.json'), 'utf8'))).toEqual({
      key: repo.key,
      root: repo.root,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('events round-trip awkward text unchanged', async () => {
    const prompt = 'He said "why?"\n<script>alert(1)</script> 🙂 \\  ';
    await appendEvent(dir, askEvent({ prompt }));
    expect((await readEvents(dir))[0]).toMatchObject({ type: 'ask', prompt });
  });

  it('readEvents skips a damaged line and warns once', async () => {
    await appendEvent(dir, askEvent({}));
    await appendFile(join(dir, 'events.jsonl'), '{"type":"ask","prom');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readEvents(dir)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('events.jsonl');
  });

  it('readEvents treats blank lines as harmless', async () => {
    await appendEvent(dir, askEvent({}));
    await appendFile(join(dir, 'events.jsonl'), '\n\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readEvents(dir)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('resetRepo removes the folder and reports whether it existed', async () => {
    const target = join(dir, 'repos', 'one');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'map.json'), '{}');
    expect(await resetRepo(target)).toBe(true);
    expect(await readdir(join(dir, 'repos'))).toEqual([]);
    expect(await resetRepo(target)).toBe(false);
  });
});
