import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Command } from 'commander';
import type { Deps } from '../core/deps.js';
import { renderHtml } from '../core/charts/html.js';
import { renderText } from '../core/charts/text.js';
import { buildModel } from '../core/model.js';
import { nextTargets, type NextResult } from '../core/next.js';
import { CHART_KINDS, chartData, type ChartKind } from '../core/stats.js';
import { readEvents, resetRepo } from '../core/store.js';
import { NotFoundError } from '../core/types.js';
import { collect, emit, openFromCommand, openSession, requireMap } from './context.js';
import { areasText, formatTable, verdictText } from './output.js';

function wholeNumber(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${flag} must be a whole number of 1 or more, not "${value}"`);
  }
  return Number(value);
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

async function levels(deps: Deps, command: Command): Promise<void> {
  const ctx = await openFromCommand(deps, command);
  const map = await requireMap(ctx);
  const model = buildModel(map, await readEvents(ctx.dir));
  emit(ctx, { areas: model.areas, verdict: model.verdict }, () =>
    [areasText(model.areas, { lastTested: true }), '', verdictText(model.verdict)].join('\n'),
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

async function chart(
  deps: Deps,
  command: Command,
  kind: string,
  opts: { format?: string; json?: boolean },
): Promise<void> {
  if (!CHART_KINDS.includes(kind as ChartKind)) {
    throw new Error(`unknown chart "${kind}"; choose one of: ${CHART_KINDS.join(', ')}`);
  }
  const format = opts.json === true ? 'json' : (opts.format ?? 'text');
  if (!['text', 'json', 'html'].includes(format)) {
    throw new Error(`--format must be text, json or html, not "${format}"`);
  }
  const ctx = await openFromCommand(deps, command);
  const map = await requireMap(ctx);
  const events = await readEvents(ctx.dir);
  const data = chartData(kind as ChartKind, map, buildModel(map, events), events);
  if (format === 'json') deps.print(JSON.stringify(data, null, 2));
  else if (format === 'html') deps.print(renderHtml([data], ctx.repo.key));
  else deps.print(renderText(data));
}

function insideRoot(root: string, path: string): boolean {
  const rel = relative(resolve(root), path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function report(
  deps: Deps,
  command: Command,
  opts: { format?: string; out?: string },
): Promise<void> {
  const format = opts.format ?? 'text';
  if (format !== 'text' && format !== 'html') {
    throw new Error(`--format must be text or html, not "${format}"`);
  }
  const ctx = await openFromCommand(deps, command);
  const out = opts.out === undefined ? null : resolve(process.cwd(), opts.out);
  if (out !== null && insideRoot(ctx.repo.root, out)) {
    throw new Error(
      `the report must not be written into the studied repository (${ctx.repo.root}); choose a path outside it`,
    );
  }
  const map = await requireMap(ctx);
  const events = await readEvents(ctx.dir);
  const model = buildModel(map, events);
  const charts = CHART_KINDS.map((kind) => chartData(kind, map, model, events));
  const text = ctx.json
    ? JSON.stringify({ charts }, null, 2)
    : format === 'html'
      ? renderHtml(charts, ctx.repo.key)
      : charts.map((c) => renderText(c)).join('\n\n');
  if (out === null) {
    deps.print(text);
    return;
  }
  await deps.writeText(out, text);
  deps.print(out);
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
    .option('--json', 'accepted for consistency; the output is always JSON')
    .action(async (_opts: unknown, command: Command) => exportState(deps, command));
  p.command('chart')
    .description(`Show one chart of progress (${CHART_KINDS.join(', ')})`)
    .argument('<kind>', 'the chart to show')
    .option('--format <format>', 'text, json or html (default text)')
    .option('--json', 'same as --format json')
    .action(async (kind: string, opts: { format?: string; json?: boolean }, command: Command) =>
      chart(deps, command, kind, opts),
    );
  p.command('report')
    .description('Show all charts as text, or as one self-contained HTML page')
    .option('--format <format>', 'text or html (default text)')
    .option('--out <path>', 'write the report to a file outside the repository')
    .option('--json', 'print (or write) all charts as JSON')
    .action(async (opts: { format?: string; out?: string }, command: Command) =>
      report(deps, command, opts),
    );
  p.command('reset')
    .description("Delete this repository's map and history")
    .option('--yes', 'confirm the deletion')
    .option('--json', 'print JSON')
    .action(async (opts: { yes?: boolean }, command: Command) => reset(deps, command, opts));
}
