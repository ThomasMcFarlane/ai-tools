import { join } from 'node:path';
import type { Command } from 'commander';
import type { Deps } from '../core/deps.js';
import {
  checkUpdate,
  diffMaps,
  evidencePath,
  MapError,
  mapChanges,
  validateMap,
  type MapChangesResult,
} from '../core/map.js';
import { buildModel } from '../core/model.js';
import { sessionSummary } from '../core/stats.js';
import { readEvents, readMap, writeMap } from '../core/store.js';
import type { MapChange, MapInput, StoredMap } from '../core/types.js';
import { emit, openFromCommand, openSession, record, requireMap, type Ctx } from './context.js';
import { areasText, formatTable, verdictText, summaryText } from './output.js';

function problemsError(heading: string, problems: string[]): Error {
  return new Error([heading, ...problems.map((p) => `  - ${p}`)].join('\n'));
}

async function parseMapFile(deps: Deps, file: string): Promise<MapInput> {
  let raw: unknown;
  try {
    raw = JSON.parse(await deps.readText(file));
  } catch (error) {
    throw new Error(`cannot read a map from ${file}: ${(error as Error).message}`);
  }
  try {
    return validateMap(raw);
  } catch (error) {
    if (error instanceof MapError) throw problemsError('Invalid map:', error.problems);
    throw error;
  }
}

async function missingEvidence(ctx: Ctx, input: MapInput): Promise<string[]> {
  const missing = new Set<string>();
  for (const area of input.areas) {
    for (const principle of area.principles) {
      for (const item of principle.evidence) {
        const path = evidencePath(item);
        if (!(await ctx.deps.fileExists(join(ctx.repo.root, path)))) {
          missing.add(`area "${area.id}": evidence file ${path} does not exist`);
        }
      }
    }
  }
  return [...missing];
}

function changesText(changes: MapChange[]): string {
  if (changes.length === 0) return 'No changes to the areas.';
  return formatTable(
    changes.map((c) => [
      c.kind,
      c.areaId,
      c.from === undefined || c.to === undefined ? '' : `${c.from} -> ${c.to}`,
    ]),
  );
}

function mapSummary(map: StoredMap): {
  commit: string | null;
  branch: string | null;
  setAt: string;
  areas: number;
} {
  return { commit: map.commit, branch: map.branch, setAt: map.setAt, areas: map.areas.length };
}

async function setMap(
  deps: Deps,
  command: Command,
  opts: { file?: string; force?: boolean; reason?: string },
): Promise<void> {
  if (opts.file === undefined) throw new Error('map set needs --file <path>');
  const ctx = await openFromCommand(deps, command);
  if (opts.force === true && (opts.reason ?? '').trim().length === 0) {
    throw new Error('--force needs --reason <text> saying why the rule is being overridden');
  }
  const input = await parseMapFile(deps, opts.file);
  const missing = await missingEvidence(ctx, input);
  if (missing.length > 0) throw problemsError('Evidence points at missing files:', missing);

  const earlier = await readMap(ctx.dir);
  const changes = earlier === null ? null : await mapChanges(earlier, ctx.repo, deps.git);
  const check = checkUpdate(earlier, input, {
    comparable: changes?.comparable ?? false,
    changedFiles:
      changes === null ? [] : [...changes.areas.flatMap((a) => a.files), ...changes.unmapped],
    trackedFiles: ctx.repo.isGit ? await deps.git.trackedFiles(ctx.repo.root) : null,
  });
  if (check.blocking.length > 0) throw problemsError('Map update refused:', check.blocking);
  let forced: string | null = null;
  if (check.forceable.length > 0) {
    if (opts.force !== true) {
      throw problemsError(
        'Map update refused (use --force --reason <text> to override):',
        check.forceable,
      );
    }
    forced = opts.reason ?? null;
  }

  const stored: StoredMap = {
    version: 1,
    repoKey: ctx.repo.key,
    branch: ctx.repo.branch,
    commit: ctx.repo.commit,
    setAt: deps.now().toISOString(),
    areas: input.areas,
  };
  const diff = diffMaps(earlier, input);
  await writeMap(ctx.dir, stored, ctx.repo);
  const session = openSession(await readEvents(ctx.dir));
  await record(ctx, stored, session, { type: 'map_set', changes: diff, forced });
  emit(ctx, { changes: diff, forced, map: mapSummary(stored) }, () =>
    [changesText(diff), forced === null ? '' : `Forced: ${forced}`]
      .filter((l) => l.length > 0)
      .join('\n'),
  );
}

function mapText(map: StoredMap): string {
  const lines = [
    `Map for ${map.repoKey}`,
    `Set ${map.setAt} on ${map.branch ?? 'no branch'} at ${map.commit ?? 'no commit'}`,
    '',
    formatTable([
      ['AREA', 'KEY', 'REVISION', 'TITLE', 'PATHS'],
      ...map.areas.map((a) => [
        a.id,
        a.key ? 'key' : '',
        String(a.revision),
        a.title,
        a.paths.join(', '),
      ]),
    ]),
  ];
  for (const area of map.areas) {
    lines.push('', `${area.id}: ${area.summary}`);
    for (const p of area.principles) {
      lines.push(`  ${p.id}: ${p.statement}`, `    why: ${p.reason}`);
      lines.push(`    evidence: ${p.evidence.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function changesResultText(r: MapChangesResult): string {
  if (!r.comparable) return r.reason ?? 'Changes cannot be compared.';
  const lines = [
    `Changes from ${r.from ?? 'none'} to ${r.to ?? 'none'}${r.dirty ? ' (dirty)' : ''}`,
  ];
  if (r.areas.length === 0 && r.unmapped.length === 0) lines.push('No files changed.');
  for (const a of r.areas) {
    lines.push(`${a.id} (${a.title})`, ...a.files.map((f) => `  ${f}`));
  }
  if (r.unmapped.length > 0) lines.push('Unmapped', ...r.unmapped.map((f) => `  ${f}`));
  return lines.join('\n');
}

export function registerMapCommands(p: Command, deps: Deps): void {
  p.command('status')
    .description('Show the repository, the map, area levels and the verdict')
    .option('--json', 'print JSON')
    .action(async (_opts: unknown, command: Command) => statusCommand(deps, command));
  const group = p.command('map').description('Set, show and compare the area map');
  group
    .command('set')
    .description('Validate and store a map')
    .option('--file <path>', 'JSON map file, or - for standard input')
    .option('--force', 'override the rules that protect untouched areas')
    .option('--reason <text>', 'why --force is needed')
    .option('--json', 'print JSON')
    .action(async (opts: { file?: string; force?: boolean; reason?: string }, command: Command) =>
      setMap(deps, command, opts),
    );
  group
    .command('show')
    .description('Print the stored map')
    .option('--json', 'print JSON')
    .action(async (_opts: unknown, command: Command) => {
      const ctx = await openFromCommand(deps, command);
      const map = await requireMap(ctx);
      emit(ctx, map, () => mapText(map));
    });
  group
    .command('changes')
    .description('List files changed since the map was set, grouped by area')
    .option('--json', 'print JSON')
    .action(async (_opts: unknown, command: Command) => {
      const ctx = await openFromCommand(deps, command);
      const map = await requireMap(ctx);
      const result = await mapChanges(map, ctx.repo, deps.git);
      emit(ctx, result, () => changesResultText(result));
    });
}

async function statusCommand(deps: Deps, command: Command): Promise<void> {
  const ctx = await openFromCommand(deps, command);
  const { repo } = ctx;
  const repoPart = {
    root: repo.root,
    key: repo.key,
    branch: repo.branch,
    commit: repo.commit,
    dirty: repo.dirty,
    isGit: repo.isGit,
  };
  const repoText = formatTable([
    ['Repository', repo.root],
    ['Key', repo.key],
    ['Branch', repo.branch ?? 'none'],
    ['Commit', repo.commit ?? 'none'],
    ['Dirty', repo.dirty ? 'yes' : 'no'],
    ['State folder', ctx.dir],
  ]);
  const map = await readMap(ctx.dir);
  if (map === null) {
    emit(
      ctx,
      {
        repo: repoPart,
        stateDir: ctx.dir,
        map: null,
        areas: [],
        verdict: null,
        openSession: null,
        lastSession: null,
      },
      () => repoText,
    );
    await requireMap(ctx);
    return;
  }
  const events = await readEvents(ctx.dir);
  const model = buildModel(map, events);
  const open = openSession(events);
  const ended = model.sessions.filter((s) => s.endedAt !== null);
  const last = ended[ended.length - 1];
  const lastSession = last === undefined ? null : sessionSummary(model, last.id);
  const behind = map.commit !== repo.commit;
  const data = {
    repo: repoPart,
    stateDir: ctx.dir,
    map: { ...mapSummary(map), behind },
    areas: model.areas,
    verdict: model.verdict,
    openSession: open,
    lastSession,
  };
  emit(ctx, data, () =>
    [
      repoText,
      '',
      `Map set ${map.setAt} at ${map.commit ?? 'no commit'}, ${map.areas.length} areas${behind ? ' (behind the repository)' : ''}`,
      '',
      areasText(model.areas),
      '',
      verdictText(model.verdict),
      '',
      open === null
        ? 'No open session.'
        : `Open session: ${open.id} (${open.mode}) since ${open.startedAt}`,
      lastSession === null ? 'No ended session yet.' : summaryText(lastSession),
    ].join('\n'),
  );
}
