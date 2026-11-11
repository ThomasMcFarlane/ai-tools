import type { Command } from 'commander';
import type { Deps } from '../core/deps.js';
import { buildModel } from '../core/model.js';
import { nextTargets, type NextResult } from '../core/next.js';
import { readEvents, resetRepo } from '../core/store.js';
import { LEVEL_LABELS, NotFoundError, type AreaState } from '../core/types.js';
import { emit, openFromCommand, openSession, requireMap } from './context.js';
import { formatTable, verdictText } from './output.js';

function wholeNumber(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${flag} must be a whole number of 1 or more, not "${value}"`);
  }
  return Number(value);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function nextText(result: NextResult): string {
  const lines: string[] = [];
  if (result.targets.length === 0) lines.push('No areas to ask about.');
  for (const t of result.targets) {
    lines.push(`${t.areaId} (${t.title}): ${t.level} / ${t.qtype}, ${t.reason}`);
    for (const prompt of t.recentPrompts) lines.push(`  recently asked: ${prompt}`);
  }
  const s = result.session;
  lines.push(
    s.id === null
      ? 'No open session.'
      : `Session ${s.id}: ${s.asked} of ${s.limit} questions asked${s.done ? ' (done)' : ''}.`,
  );
  return lines.join('\n');
}

async function next(
  deps: Deps,
  command: Command,
  opts: { area: string[]; count?: string },
): Promise<void> {
  const count = wholeNumber(opts.count, '--count', 3);
  const ctx = await openFromCommand(deps, command);
  const map = await requireMap(ctx);
  const events = await readEvents(ctx.dir);
  const model = buildModel(map, events);
  const unknown = opts.area.filter((id) => !model.areas.some((a) => a.id === id));
  if (unknown.length > 0) throw new Error(`unknown area "${unknown.join('", "')}"`);
  const result = nextTargets(map, model, {
    ...(opts.area.length > 0 ? { areas: opts.area } : {}),
    count,
    sessionId: openSession(events)?.id ?? null,
  });
  emit(ctx, result, () => nextText(result));
}

function areaMarks(a: AreaState): string {
  return [
    a.retired ? 'retired' : '',
    a.stale ? `stale${a.staleFrom === null ? '' : ` (was ${a.staleFrom})`}` : '',
    a.untested ? 'untested' : '',
  ]
    .filter((m) => m.length > 0)
    .join(', ');
}

async function levels(deps: Deps, command: Command): Promise<void> {
  const ctx = await openFromCommand(deps, command);
  const map = await requireMap(ctx);
  const model = buildModel(map, await readEvents(ctx.dir));
  emit(ctx, { areas: model.areas, verdict: model.verdict }, () =>
    [
      model.areas.length === 0
        ? 'No areas.'
        : formatTable([
            ['AREA', 'LEVEL', 'KEY', 'NOTES', 'LAST TESTED'],
            ...model.areas.map((a) => [
              a.id,
              `${a.level} (${LEVEL_LABELS[a.level]})`,
              a.key ? 'key' : '',
              areaMarks(a),
              a.lastTestedAt ?? 'never',
            ]),
          ]),
      '',
      verdictText(model.verdict),
    ].join('\n'),
  );
}

async function history(
  deps: Deps,
  command: Command,
  opts: { area?: string; session?: string; limit?: string },
): Promise<void> {
  const limit = opts.limit === undefined ? undefined : wholeNumber(opts.limit, '--limit', 1);
  const ctx = await openFromCommand(deps, command);
  const map = await requireMap(ctx);
  const model = buildModel(map, await readEvents(ctx.dir));
  if (opts.session !== undefined && !model.sessions.some((s) => s.id === opts.session)) {
    throw new Error(`unknown session "${opts.session}"`);
  }
  if (opts.area !== undefined && !model.areas.some((a) => a.id === opts.area)) {
    throw new Error(`unknown area "${opts.area}"`);
  }
  const retired = new Set(model.areas.filter((a) => a.retired).map((a) => a.id));
  const records = model.questions
    .filter(
      (q) =>
        (opts.area === undefined || q.areaId === opts.area) &&
        (opts.session === undefined || q.sessionId === opts.session),
    )
    .reverse()
    .slice(0, limit)
    .map((q) => ({ ...q, retired: retired.has(q.areaId) }));
  if (records.length === 0) throw new NotFoundError('no questions match');
  emit(ctx, records, () =>
    formatTable([
      ['QUESTION', 'SESSION', 'AREA', 'LEVEL', 'TYPE', 'STATUS', 'SCORE', 'TIME', 'ASKED'],
      ...records.map((q) => [
        q.id,
        q.sessionId,
        q.retired ? `${q.areaId} (retired)` : q.areaId,
        q.level,
        q.qtype,
        q.status,
        q.score === null ? '' : `${q.score}${q.passed ? ' passed' : ''}`,
        q.durationMs === null ? '' : `${Math.round(q.durationMs / 1000)}s`,
        q.askedAt,
      ]),
    ]),
  );
}

async function exportState(deps: Deps, command: Command): Promise<void> {
  const ctx = await openFromCommand(deps, command);
  const map = await requireMap(ctx);
  const events = await readEvents(ctx.dir);
  deps.print(JSON.stringify({ repo: ctx.repo, map, events }, null, 2));
}

async function reset(deps: Deps, command: Command, opts: { yes?: boolean }): Promise<void> {
  if (opts.yes !== true) {
    throw new Error("reset deletes this repository's map and history; pass --yes to confirm");
  }
  const ctx = await openFromCommand(deps, command);
  const removed = await resetRepo(ctx.dir);
  emit(ctx, { removed }, () =>
    removed ? `Removed ${ctx.dir}.` : `Nothing to remove at ${ctx.dir}.`,
  );
}

export function registerReadCommands(p: Command, deps: Deps): void {
  p.command('next')
    .description('Suggest the next areas, levels and question types to ask about')
    .option('--area <id>', 'limit to an area (repeatable)', collect, [])
    .option('--count <n>', 'how many targets (default 3)')
    .option('--json', 'print JSON')
    .action(async (opts: { area: string[]; count?: string }, command: Command) =>
      next(deps, command, opts),
    );
  p.command('levels')
    .description('Show each area level, stale and untested marks, and the verdict')
    .option('--json', 'print JSON')
    .action(async (_opts: unknown, command: Command) => levels(deps, command));
  p.command('history')
    .description('List recorded questions, newest first')
    .option('--area <id>', 'only this area')
    .option('--session <id>', 'only this session')
    .option('--limit <n>', 'show at most n questions')
    .option('--json', 'print JSON')
    .action(async (opts: { area?: string; session?: string; limit?: string }, command: Command) =>
      history(deps, command, opts),
    );
  p.command('export')
    .description('Print the repository, map and event log as JSON')
    .action(async (_opts: unknown, command: Command) => exportState(deps, command));
  p.command('reset')
    .description("Delete this repository's map and history")
    .option('--yes', 'confirm the deletion')
    .option('--json', 'print JSON')
    .action(async (opts: { yes?: boolean }, command: Command) => reset(deps, command, opts));
}
