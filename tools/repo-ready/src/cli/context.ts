import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Command } from 'commander';
import type { Deps } from '../core/deps.js';
import { dirNameFor, readRepoState, type RepoState } from '../core/identity.js';
import { buildModel } from '../core/model.js';
import { appendEvent, readMap, repoDir } from '../core/store.js';
import { NotFoundError, type LogEvent, type SessionRecord, type StoredMap } from '../core/types.js';
import { printJson } from './output.js';

export interface Ctx {
  deps: Deps;
  repo: RepoState;
  dir: string;
  json: boolean;
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type EventBody = DistributiveOmit<
  LogEvent,
  'at' | 'sessionId' | 'mode' | 'branch' | 'commit' | 'dirty' | 'mapCommit'
>;

export function insideRoot(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function openRepo(
  deps: Deps,
  repoPath: string | undefined,
  json: boolean,
): Promise<Ctx> {
  const found = await readRepoState(resolve(repoPath ?? process.cwd()), deps.git);
  const stateRoot = resolve(deps.stateRoot());
  if (insideRoot(found.root, stateRoot)) {
    throw new Error(
      `the state folder ${stateRoot} is inside the studied repository (${found.root}); set AI_TOOLS_REPO_READY_STATE_DIR or XDG_STATE_HOME to a folder outside it`,
    );
  }
  let repo = found;
  for (const key of found.candidates) {
    const dirName = dirNameFor(key);
    if (await deps.fileExists(repoDir(stateRoot, dirName))) {
      repo = { ...found, key, dirName };
      break;
    }
  }
  return { deps, repo, dir: repoDir(stateRoot, repo.dirName), json };
}

export function openFromCommand(deps: Deps, command: Command): Promise<Ctx> {
  const opts = command.optsWithGlobals<{ repo?: string; json?: boolean }>();
  return openRepo(deps, opts.repo, opts.json === true);
}

export async function requireMap(ctx: Ctx): Promise<StoredMap> {
  const map = await readMap(ctx.dir);
  if (map === null) {
    throw new NotFoundError('no map yet; build one with: repo-ready map set --file <path>');
  }
  return map;
}

export function openSession(events: LogEvent[]): SessionRecord | null {
  const open = buildModel({ areas: [] }, events).sessions.filter((s) => s.endedAt === null);
  return open[open.length - 1] ?? null;
}

export async function record(
  ctx: Ctx,
  map: StoredMap | null,
  session: SessionRecord | null,
  body: EventBody,
): Promise<LogEvent> {
  const event = {
    at: ctx.deps.now().toISOString(),
    sessionId: session?.id ?? null,
    mode: session?.mode ?? null,
    branch: ctx.repo.branch,
    commit: ctx.repo.commit,
    dirty: ctx.repo.dirty,
    mapCommit: map?.commit ?? null,
    ...body,
  } as LogEvent;
  await appendEvent(ctx.dir, event);
  return event;
}

export function emit(ctx: Ctx, data: unknown, text: () => string): void {
  if (ctx.json) printJson(ctx.deps.print, data);
  else ctx.deps.print(text());
}

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
