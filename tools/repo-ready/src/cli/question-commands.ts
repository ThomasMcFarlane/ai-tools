import type { Command } from 'commander';
import type { Deps } from '../core/deps.js';
import { buildModel } from '../core/model.js';
import { readEvents } from '../core/store.js';
import {
  LEVELS,
  PASS_SCORE,
  QTYPES,
  type Level,
  type LogEvent,
  type Model,
  type QType,
  type QuestionRecord,
  type SessionRecord,
  type StoredMap,
} from '../core/types.js';
import { emit, openFromCommand, openSession, record, requireMap, type Ctx } from './context.js';

interface Loaded {
  ctx: Ctx;
  map: StoredMap;
  events: LogEvent[];
  model: Model;
}

async function load(deps: Deps, command: Command): Promise<Loaded> {
  const ctx = await openFromCommand(deps, command);
  const map = await requireMap(ctx);
  const events = await readEvents(ctx.dir);
  return { ctx, map, events, model: buildModel(map, events) };
}

async function readFileText(
  deps: Deps,
  file: string | undefined,
  command: string,
): Promise<string> {
  if (file === undefined)
    throw new Error(`${command} needs --file <path>, or - for standard input`);
  try {
    return await deps.readText(file);
  } catch (error) {
    throw new Error(`cannot read ${file}: ${(error as Error).message}`);
  }
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function findQuestion(model: Model, id: string): QuestionRecord {
  const found = model.questions.find((q) => q.id === id);
  if (found === undefined) throw new Error(`unknown question "${id}"`);
  return found;
}

function sessionOf(model: Model, question: QuestionRecord): SessionRecord | null {
  return model.sessions.find((s) => s.id === question.sessionId) ?? null;
}

function requireOpen(question: QuestionRecord): void {
  switch (question.status) {
    case 'open':
      return;
    case 'skipped':
      throw new Error(`question ${question.id} was skipped`);
    default:
      throw new Error(`question ${question.id} is already answered`);
  }
}

function levelOfType(qtype: string): Level | undefined {
  return LEVELS.find((level) => (QTYPES[level] as string[]).includes(qtype));
}

interface AskOptions {
  area?: string;
  level?: string;
  type?: string;
  file?: string;
  evidence: string[];
  principles?: string;
  followUpOf?: string;
}

function checkFollowUp(
  model: Model,
  session: SessionRecord,
  areaId: string,
  level: Level,
  id: string,
): void {
  const parent = findQuestion(model, id);
  if (parent.sessionId !== session.id) {
    throw new Error(`follow-up parent ${id} belongs to another session`);
  }
  if (parent.areaId !== areaId) {
    throw new Error(`follow-up parent ${id} is in area "${parent.areaId}", not "${areaId}"`);
  }
  if (parent.answeredAt === null) throw new Error(`follow-up parent ${id} has no answer yet`);
  if (parent.followUpOf !== null) throw new Error(`follow-up parent ${id} is itself a follow-up`);
  if (model.questions.some((q) => q.followUpOf === id)) {
    throw new Error(`question ${id} already has a follow-up`);
  }
  const step = LEVELS.indexOf(level) - LEVELS.indexOf(parent.level);
  if (step !== 0 && step !== 1) {
    throw new Error(
      `a follow-up must be at level ${parent.level} or the one above it, not ${level}`,
    );
  }
}

async function ask(deps: Deps, command: Command, opts: AskOptions): Promise<void> {
  const { area: areaId, level: levelText, type } = opts;
  if (areaId === undefined) throw new Error('ask needs --area <id>');
  if (levelText === undefined) throw new Error('ask needs --level <level>');
  if (type === undefined) throw new Error('ask needs --type <type>');
  const { ctx, map, events, model } = await load(deps, command);
  const session = openSession(events);
  if (session === null) throw new Error('ask needs an open session; start one with: session start');
  const area = map.areas.find((a) => a.id === areaId);
  if (area === undefined) {
    throw new Error(
      `unknown area "${areaId}"; known areas: ${map.areas.map((a) => a.id).join(', ')}`,
    );
  }
  const level = LEVELS.find((l) => l === levelText);
  if (level === undefined)
    throw new Error(`unknown level "${levelText}"; use ${LEVELS.join(', ')}`);
  if (!(QTYPES[level] as string[]).includes(type)) {
    const owner = levelOfType(type);
    throw new Error(
      owner === undefined
        ? `unknown question type "${type}"`
        : `type "${type}" belongs to level ${owner}, not ${level}; ${level} types are: ${QTYPES[level].join(', ')}`,
    );
  }
  const prompt = await readFileText(deps, opts.file, 'ask');
  if (prompt.trim().length === 0) throw new Error('the prompt is empty');
  if (opts.evidence.length === 0) {
    throw new Error('ask needs at least one --evidence <path:line>');
  }
  const badEvidence = opts.evidence.filter((e) => !/^.+:\d+$/.test(e));
  if (badEvidence.length > 0) {
    throw new Error(`evidence must be in path:line form: ${badEvidence.join(', ')}`);
  }
  const principleIds = splitList(opts.principles);
  const unknown = principleIds.filter((id) => !area.principles.some((p) => p.id === id));
  if (unknown.length > 0) {
    throw new Error(`unknown principles for area "${area.id}": ${unknown.join(', ')}`);
  }
  if (opts.followUpOf !== undefined) checkFollowUp(model, session, area.id, level, opts.followUpOf);

  const questionId = deps.newId('q');
  const event = await record(ctx, map, session, {
    type: 'ask',
    questionId,
    areaId: area.id,
    revision: area.revision,
    level,
    qtype: type as QType,
    principleIds,
    prompt,
    evidence: opts.evidence,
    followUpOf: opts.followUpOf ?? null,
  });
  emit(ctx, { questionId, askedAt: event.at }, () => questionId);
}

async function hint(deps: Deps, command: Command, id: string): Promise<void> {
  const { ctx, map, model } = await load(deps, command);
  const question = findQuestion(model, id);
  requireOpen(question);
  if (question.mode !== 'learn') {
    throw new Error('hints are not given in interview mode');
  }
  await record(ctx, map, sessionOf(model, question), { type: 'hint', questionId: id });
  const hints = question.hints + 1;
  emit(ctx, { questionId: id, hints }, () => `Recorded hint ${hints} for ${id}.`);
}

async function answer(deps: Deps, command: Command, id: string, file?: string): Promise<void> {
  const { ctx, map, model } = await load(deps, command);
  const question = findQuestion(model, id);
  requireOpen(question);
  const text = await readFileText(deps, file, 'answer');
  const durationMs = Math.max(0, deps.now().getTime() - new Date(question.askedAt).getTime());
  await record(ctx, map, sessionOf(model, question), {
    type: 'answer',
    questionId: id,
    text,
    durationMs,
  });
  emit(
    ctx,
    { questionId: id, durationMs },
    () => `Recorded the answer to ${id} (${durationMs} ms).`,
  );
}

async function grade(
  deps: Deps,
  command: Command,
  id: string,
  opts: { score?: string; file?: string; gaps?: string },
): Promise<void> {
  if (opts.score === undefined || !/^[0-4]$/.test(opts.score)) {
    throw new Error('--score must be a whole number from 0 to 4');
  }
  const score = Number(opts.score);
  const { ctx, map, model } = await load(deps, command);
  const question = findQuestion(model, id);
  if (question.status === 'graded') throw new Error(`question ${id} is already graded`);
  if (question.status === 'skipped') throw new Error(`question ${id} was skipped`);
  if (question.status !== 'answered') throw new Error(`question ${id} is not answered yet`);
  const notes = opts.file === undefined ? '' : await readFileText(deps, opts.file, 'grade');
  const gaps = splitList(opts.gaps);
  await record(ctx, map, sessionOf(model, question), {
    type: 'grade',
    questionId: id,
    score,
    notes,
    gaps,
  });
  const passed = score >= PASS_SCORE && question.hints === 0;
  emit(ctx, { questionId: id, score, passed }, () =>
    passed
      ? `Graded ${id}: ${score}, passed.`
      : `Graded ${id}: ${score}, not passed${question.hints > 0 && score >= PASS_SCORE ? ' (hinted)' : ''}.`,
  );
}

async function skip(deps: Deps, command: Command, id: string): Promise<void> {
  const { ctx, map, model } = await load(deps, command);
  const question = findQuestion(model, id);
  requireOpen(question);
  await record(ctx, map, sessionOf(model, question), { type: 'skip', questionId: id });
  emit(ctx, { questionId: id }, () => `Skipped ${id}.`);
}

export function registerQuestionCommands(p: Command, deps: Deps): void {
  p.command('ask')
    .description('Record a question asked in the open session and print its id')
    .option('--area <id>', 'area the question is about')
    .option('--level <level>', 'read, maintain or rebuild')
    .option('--type <type>', 'question type for the level')
    .option('--file <path>', 'prompt text, or - for standard input')
    .option('--evidence <path:line>', 'evidence location (repeatable)', collect, [])
    .option('--principles <ids>', 'comma-separated principle ids')
    .option('--follow-up-of <id>', 'answered question this follows up')
    .option('--json', 'print JSON')
    .action(async (opts: AskOptions, command: Command) => ask(deps, command, opts));
  p.command('hint')
    .description('Record a hint given for an open question (learn mode only)')
    .argument('<id>', 'question id')
    .option('--json', 'print JSON')
    .action(async (id: string, _opts: unknown, command: Command) => hint(deps, command, id));
  p.command('answer')
    .description('Record the answer to an open question and its duration')
    .argument('<id>', 'question id')
    .option('--file <path>', 'answer text, or - for standard input')
    .option('--json', 'print JSON')
    .action(async (id: string, opts: { file?: string }, command: Command) =>
      answer(deps, command, id, opts.file),
    );
  p.command('grade')
    .description('Record the score for an answered question')
    .argument('<id>', 'question id')
    .option('--score <0-4>', 'whole number from 0 to 4')
    .option('--file <path>', 'grading notes, or - for standard input')
    .option('--gaps <tags>', 'comma-separated gap tags')
    .option('--json', 'print JSON')
    .action(
      async (
        id: string,
        opts: { score?: string; file?: string; gaps?: string },
        command: Command,
      ) => grade(deps, command, id, opts),
    );
  p.command('skip')
    .description('Record that an open question was skipped')
    .argument('<id>', 'question id')
    .option('--json', 'print JSON')
    .action(async (id: string, _opts: unknown, command: Command) => skip(deps, command, id));
}
