import type { GitFacts } from './deps.js';
import { matchesAny } from './glob.js';
import type { RepoState } from './identity.js';
import { MAX_AREAS, MIN_AREAS } from './types.js';
import type { Area, LogEvent, MapChange, MapInput, Principle, StoredMap } from './types.js';

export class MapError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`Invalid map: ${problems.join('; ')}`);
    this.name = 'MapError';
    this.problems = problems;
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
export const EVIDENCE = /^[^:\s]+:\d+(-\d+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

const PATH_RULE = 'paths are relative to the repository root and use /';

export function pathProblem(path: string): string | null {
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'is absolute';
  if (path.startsWith('./')) return 'starts with ./';
  if (path.includes('\\')) return 'contains a backslash';
  if (path.split('/').includes('..')) return 'contains a .. segment';
  return null;
}

export function evidencePath(evidence: string): string {
  return evidence.slice(0, evidence.lastIndexOf(':'));
}

export function evidenceProblem(evidence: string): string | null {
  if (!EVIDENCE.test(evidence)) {
    return `evidence "${evidence}" must look like path:line or path:line-line`;
  }
  const problem = pathProblem(evidencePath(evidence));
  return problem === null ? null : `evidence "${evidence}" ${problem}; ${PATH_RULE}`;
}

function validatePrinciple(
  raw: unknown,
  where: string,
  seen: Set<string>,
  problems: string[],
): Principle | null {
  if (!isRecord(raw)) {
    problems.push(`${where}: principle must be an object`);
    return null;
  }
  const before = problems.length;
  const id = typeof raw['id'] === 'string' ? raw['id'] : '';
  if (!SLUG.test(id)) {
    problems.push(
      `${where}: principle id "${id}" must be a slug (lower-case letters, digits, hyphens)`,
    );
  } else if (seen.has(id)) {
    problems.push(`${where}: duplicate principle id "${id}"`);
  }
  seen.add(id);
  const statement = text(raw['statement']);
  if (statement === null) problems.push(`${where}: principle "${id}" needs a statement`);
  const reason = text(raw['reason']);
  if (reason === null) problems.push(`${where}: principle "${id}" needs a reason`);
  const evidence = Array.isArray(raw['evidence']) ? (raw['evidence'] as unknown[]) : [];
  if (evidence.length === 0) {
    problems.push(`${where}: principle "${id}" needs at least one evidence string`);
  }
  for (const item of evidence) {
    const problem =
      typeof item === 'string'
        ? evidenceProblem(item)
        : `evidence ${JSON.stringify(item)} must look like path:line or path:line-line`;
    if (problem !== null) problems.push(`${where}: ${problem}`);
  }
  if (problems.length > before || statement === null || reason === null) return null;
  return { id, statement, reason, evidence: evidence as string[] };
}

function validateArea(
  raw: unknown,
  index: number,
  seen: Set<string>,
  problems: string[],
): Area | null {
  if (!isRecord(raw)) {
    problems.push(`area #${index + 1}: must be an object`);
    return null;
  }
  const before = problems.length;
  const id = typeof raw['id'] === 'string' ? raw['id'] : '';
  const where = SLUG.test(id) ? `area "${id}"` : `area #${index + 1}`;
  if (!SLUG.test(id)) {
    problems.push(
      `area #${index + 1}: id "${id}" must be a slug (lower-case letters, digits, hyphens)`,
    );
  } else if (seen.has(id)) {
    problems.push(`duplicate area id "${id}"`);
  }
  seen.add(id);
  const title = text(raw['title']);
  if (title === null) problems.push(`${where}: title must not be empty`);
  const summary = text(raw['summary']);
  if (summary === null) problems.push(`${where}: summary must not be empty`);
  if (typeof raw['key'] !== 'boolean') problems.push(`${where}: key must be true or false`);
  const paths = Array.isArray(raw['paths']) ? (raw['paths'] as unknown[]) : [];
  if (paths.length === 0 || !paths.every((p) => text(p) !== null)) {
    problems.push(`${where}: paths must list at least one non-empty glob`);
  }
  for (const path of paths) {
    const problem = typeof path === 'string' ? pathProblem(path) : null;
    if (problem !== null) {
      problems.push(`${where}: path ${JSON.stringify(path)} ${problem}; ${PATH_RULE}`);
    }
  }
  const revision = raw['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    problems.push(`${where}: revision must be a whole number of at least 1`);
  }
  const rawPrinciples = Array.isArray(raw['principles']) ? (raw['principles'] as unknown[]) : [];
  if (rawPrinciples.length === 0) problems.push(`${where}: needs at least one principle`);
  const principleIds = new Set<string>();
  const principles = rawPrinciples.map((p) => validatePrinciple(p, where, principleIds, problems));
  if (problems.length > before) return null;
  return {
    id,
    title: title as string,
    summary: summary as string,
    key: raw['key'] as boolean,
    paths: paths as string[],
    revision: revision as number,
    principles: principles as Principle[],
  };
}

export function validateMap(input: unknown): MapInput {
  if (!isRecord(input) || !Array.isArray(input['areas'])) {
    throw new MapError(['the map must be an object with an "areas" array']);
  }
  const raw = input['areas'] as unknown[];
  const problems: string[] = [];
  if (raw.length < MIN_AREAS || raw.length > MAX_AREAS) {
    problems.push(`the map needs ${MIN_AREAS} to ${MAX_AREAS} areas, found ${raw.length}`);
  }
  const seen = new Set<string>();
  const areas = raw.map((a, i) => validateArea(a, i, seen, problems));
  if (raw.length > 0 && !raw.some((a) => isRecord(a) && a['key'] === true)) {
    problems.push('the map needs at least one key area');
  }
  if (problems.length > 0) throw new MapError(problems);
  return { areas: areas as Area[] };
}

export type RevisionRecord = ReadonlyMap<string, number>;

export function revisionRecord(events: LogEvent[]): Map<string, number> {
  const record = new Map<string, number>();
  const note = (areaId: unknown, revision: unknown): void => {
    if (typeof areaId !== 'string' || typeof revision !== 'number') return;
    record.set(areaId, Math.max(record.get(areaId) ?? revision, revision));
  };
  for (const event of events as unknown[]) {
    if (typeof event !== 'object' || event === null) continue;
    const e = event as Record<string, unknown>;
    if (e['type'] === 'ask') note(e['areaId'], e['revision']);
    if (e['type'] === 'map_set' && Array.isArray(e['changes'])) {
      for (const change of e['changes'] as unknown[]) {
        const c = change as Record<string, unknown> | null;
        if (c?.['kind'] === 'revision_raised') note(c['areaId'], c['to']);
      }
    }
  }
  return record;
}

export function diffMaps(
  prev: MapInput | null,
  next: MapInput,
  record: RevisionRecord = new Map(),
): MapChange[] {
  const before = new Map((prev?.areas ?? []).map((a) => [a.id, a]));
  const changes: MapChange[] = [];
  for (const area of next.areas) {
    const old = before.get(area.id);
    if (old === undefined) {
      const recorded = record.get(area.id);
      changes.push(
        recorded !== undefined && area.revision > recorded
          ? { kind: 'revision_raised', areaId: area.id, from: recorded, to: area.revision }
          : { kind: 'added', areaId: area.id },
      );
      continue;
    }
    if (!old.key && area.key) changes.push({ kind: 'key_set', areaId: area.id });
    if (old.key && !area.key) changes.push({ kind: 'key_cleared', areaId: area.id });
    if (area.revision > old.revision) {
      changes.push({
        kind: 'revision_raised',
        areaId: area.id,
        from: old.revision,
        to: area.revision,
      });
    }
  }
  const kept = new Set(next.areas.map((a) => a.id));
  for (const area of prev?.areas ?? []) {
    if (!kept.has(area.id)) changes.push({ kind: 'removed', areaId: area.id });
  }
  return changes;
}

export interface UpdateContext {
  comparable: boolean;
  changedFiles: string[];
  trackedFiles: string[] | null;
  revisions?: RevisionRecord;
}

export function checkUpdate(
  prev: MapInput | null,
  next: MapInput,
  ctx: UpdateContext,
): { blocking: string[]; forceable: string[] } {
  const blocking: string[] = [];
  const forceable: string[] = [];
  const nextById = new Map(next.areas.map((a) => [a.id, a]));

  const tracked =
    ctx.trackedFiles !== null && ctx.trackedFiles.length > 0 ? ctx.trackedFiles : null;
  for (const area of next.areas) {
    if (tracked !== null && !tracked.some((f) => matchesAny(f, area.paths))) {
      forceable.push(
        `Area "${area.id}" has paths that match no tracked file (${area.paths.join(', ')}); ${PATH_RULE}, and a folder needs /**.`,
      );
    }
  }
  for (const area of next.areas) {
    const recorded = ctx.revisions?.get(area.id);
    const inPrev = prev?.areas.some((a) => a.id === area.id) ?? false;
    if (!inPrev && recorded !== undefined && area.revision < recorded) {
      blocking.push(
        `Area "${area.id}" would come back at revision ${area.revision}, below revision ${recorded} on record, which is never allowed.`,
      );
    }
  }
  if (prev === null) return { blocking, forceable };

  const changed = ctx.comparable ? ctx.changedFiles : [];
  const droppable = (area: Area): boolean =>
    changed.some((f) => matchesAny(f, area.paths)) ||
    (tracked !== null && !tracked.some((f) => matchesAny(f, area.paths)));
  const why =
    tracked === null
      ? 'there is no list of tracked files to show its files are gone'
      : ctx.comparable
        ? 'none of its files changed since the map was set'
        : 'the map commit cannot be compared and its paths still match tracked files';

  for (const old of prev.areas) {
    const now = nextById.get(old.id);
    if (now !== undefined && now.revision < old.revision) {
      blocking.push(
        `Area "${old.id}" would lower its revision from ${old.revision} to ${now.revision}, which is never allowed.`,
      );
    }
    if (now === undefined) {
      if (!droppable(old)) forceable.push(`Area "${old.id}" would be removed, but ${why}.`);
      continue;
    }
    if (old.key && !now.key && !droppable(old)) {
      forceable.push(`Area "${old.id}" would stop being a key area, but ${why}.`);
    }
    if (ctx.comparable && now.revision > old.revision) {
      const paths = [...old.paths, ...now.paths];
      if (!changed.some((f) => matchesAny(f, paths))) {
        forceable.push(
          `Area "${old.id}" would raise its revision from ${old.revision} to ${now.revision}, but none of its files changed since the map was set.`,
        );
      }
    }
  }
  return { blocking, forceable };
}

export interface MapChangesResult {
  comparable: boolean;
  reason: string | null;
  from: string | null;
  to: string | null;
  dirty: boolean;
  areas: { id: string; title: string; files: string[] }[];
  unmapped: string[];
}

export async function mapChanges(
  map: StoredMap,
  repo: RepoState,
  git: GitFacts,
): Promise<MapChangesResult> {
  const result: MapChangesResult = {
    comparable: false,
    reason: null,
    from: map.commit,
    to: repo.commit,
    dirty: repo.dirty,
    areas: [],
    unmapped: [],
  };
  const cannot = (reason: string): MapChangesResult => ({ ...result, reason });
  if (!repo.isGit)
    return cannot('This folder is not a git repository, so changes cannot be listed.');
  if (map.commit === null)
    return cannot('The map was set without a commit, so there is nothing to compare against.');
  if (repo.commit === null)
    return cannot('The repository has no commits yet, so there is nothing to compare.');
  if (map.commit === repo.commit) return { ...result, comparable: true };
  if (!(await git.hasCommit(repo.root, map.commit))) {
    return cannot(
      `The map commit ${map.commit} is no longer in this repository, so changes cannot be listed.`,
    );
  }
  const changed = await git.changedFiles(repo.root, map.commit, repo.commit);
  const areas = map.areas
    .map((a) => ({
      id: a.id,
      title: a.title,
      files: changed.filter((f) => matchesAny(f, a.paths)),
    }))
    .filter((a) => a.files.length > 0);
  const unmapped = changed.filter((f) => !map.areas.some((a) => matchesAny(f, a.paths)));
  return { ...result, comparable: true, areas, unmapped };
}
