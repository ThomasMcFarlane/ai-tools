import type { Command } from 'commander';
import type { Deps } from '../core/deps.js';
import { buildModel } from '../core/model.js';
import { sessionSummary } from '../core/stats.js';
import { readEvents } from '../core/store.js';
import { NotFoundError, type Mode, type SessionRecord } from '../core/types.js';
import { emit, openFromCommand, openSession, record, requireMap } from './context.js';
import { areasText, formatTable, summaryText, verdictText } from './output.js';

function parseMode(value: string): Mode {
  if (value === 'learn' || value === 'interview') return value;
  throw new Error(`--mode must be learn or interview, not "${value}"`);
}

async function startSession(deps: Deps, command: Command, modeText: string): Promise<void> {
  const mode = parseMode(modeText);
  const ctx = await openFromCommand(deps, command);
  const map = await requireMap(ctx);
  const previous = openSession(await readEvents(ctx.dir));
  if (previous !== null) await record(ctx, map, previous, { type: 'session_end', auto: true });
  const session: SessionRecord = {
    id: deps.newId('s'),
    mode,
    startedAt: deps.now().toISOString(),
    endedAt: null,
    auto: false,
    branch: ctx.repo.branch,
    commit: ctx.repo.commit,
    dirty: ctx.repo.dirty,
    questionIds: [],
  };
  await record(ctx, map, session, { type: 'session_start' });
  emit(ctx, { sessionId: session.id, mode, endedPrevious: previous?.id ?? null }, () =>
    [
      previous === null ? '' : `Ended the open session ${previous.id}.`,
      `Started ${mode} session ${session.id}.`,
    ]
      .filter((l) => l.length > 0)
      .join('\n'),
  );
}

async function endSession(deps: Deps, command: Command): Promise<void> {
  const ctx = await openFromCommand(deps, command);
  const open = openSession(await readEvents(ctx.dir));
  if (open === null) throw new NotFoundError('no open session to end');
  const map = await requireMap(ctx);
  await record(ctx, map, open, { type: 'session_end', auto: false });
  const model = buildModel(map, await readEvents(ctx.dir));
  const summary = sessionSummary(model, open.id);
  emit(ctx, { summary, areas: model.areas, verdict: model.verdict }, () => {
    const parts = [summaryText(summary), areasText(model.areas), verdictText(model.verdict)];
    return (open.mode === 'interview' ? parts : [parts[2], parts[0], parts[1]]).join('\n\n');
  });
}

async function listSessions(deps: Deps, command: Command): Promise<void> {
  const ctx = await openFromCommand(deps, command);
  const map = await requireMap(ctx);
  const model = buildModel(map, await readEvents(ctx.dir));
  if (model.sessions.length === 0) throw new NotFoundError('no sessions yet');
  const sessions = [...model.sessions]
    .reverse()
    .map((s) => ({ ...s, summary: sessionSummary(model, s.id) }));
  emit(ctx, sessions, () =>
    formatTable([
      ['SESSION', 'MODE', 'STARTED', 'ENDED', 'ASKED', 'PASSED'],
      ...sessions.map((s) => [
        s.id,
        s.mode,
        s.startedAt,
        s.endedAt === null ? 'open' : `${s.endedAt}${s.auto ? ' (auto)' : ''}`,
        String(s.summary.asked),
        String(s.summary.passed),
      ]),
    ]),
  );
}

async function teach(
  deps: Deps,
  command: Command,
  opts: { area?: string; principles?: string },
): Promise<void> {
  const ctx = await openFromCommand(deps, command);
  const map = await requireMap(ctx);
  const open = openSession(await readEvents(ctx.dir));
  if (open === null) throw new Error('teach needs an open session; start one with: session start');
  const area = map.areas.find((a) => a.id === opts.area);
  if (opts.area === undefined || area === undefined) {
    throw new Error(
      `unknown area "${opts.area ?? ''}"; known areas: ${map.areas.map((a) => a.id).join(', ')}`,
    );
  }
  const principleIds = (opts.principles ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const unknown = principleIds.filter((id) => !area.principles.some((p) => p.id === id));
  if (unknown.length > 0) {
    throw new Error(`unknown principles for area "${area.id}": ${unknown.join(', ')}`);
  }
  await record(ctx, map, open, { type: 'lesson', areaId: area.id, principleIds });
  emit(
    ctx,
    { sessionId: open.id, areaId: area.id, principleIds },
    () =>
      `Recorded a lesson on ${area.id}${principleIds.length > 0 ? ` (${principleIds.join(', ')})` : ''}.`,
  );
}

export function registerSessionCommands(p: Command, deps: Deps): void {
  const group = p.command('session').description('Start, end and list sessions');
  group
    .command('start')
    .description('Start a session, ending any open one')
    .option('--mode <mode>', 'learn or interview')
    .option('--json', 'print JSON')
    .action(async (opts: { mode?: string }, command: Command) =>
      startSession(deps, command, opts.mode ?? ''),
    );
  group
    .command('end')
    .description('End the open session and print its summary')
    .option('--json', 'print JSON')
    .action(async (_opts: unknown, command: Command) => endSession(deps, command));
  group
    .command('list')
    .description('List sessions, newest first')
    .option('--json', 'print JSON')
    .action(async (_opts: unknown, command: Command) => listSessions(deps, command));
  p.command('teach')
    .description('Record that a lesson was given in the open session')
    .option('--area <id>', 'area taught')
    .option('--principles <ids>', 'comma-separated principle ids')
    .option('--json', 'print JSON')
    .action(async (opts: { area?: string; principles?: string }, command: Command) =>
      teach(deps, command, opts),
    );
}
