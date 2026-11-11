import { median } from './stats.js';
import { levelRank } from './model.js';
import {
  LEVELS,
  QTYPES,
  RECENT_PROMPTS,
  SESSION_AREA_CAP,
  SESSION_QUESTIONS,
  type AreaState,
  type Level,
  type MapInput,
  type Model,
  type QType,
  type QuestionRecord,
} from './types.js';

export interface NextTarget {
  areaId: string;
  title: string;
  level: Level;
  qtype: QType;
  reason: 'stale' | 'untested' | 'not_held' | 'keep_fresh';
  recentPrompts: string[];
}
export interface NextResult {
  targets: NextTarget[];
  session: { id: string | null; asked: number; limit: number; done: boolean };
}

const counts = (q: QuestionRecord): boolean =>
  !q.voided && (q.status === 'graded' || q.status === 'skipped');

function targetLevel(area: AreaState): Level {
  if (area.stale && area.staleFrom) return area.staleFrom;
  if (area.level === 'rebuild') return 'rebuild';
  return LEVELS[levelRank(area.level)] ?? 'rebuild';
}

function group(area: AreaState): number {
  if (area.stale) return area.key ? 0 : 1;
  return area.key ? 2 : 3;
}

function compareText(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function pickType(level: Level, questions: QuestionRecord[]): QType {
  const stats = QTYPES[level].map((qtype, order) => {
    const counted = questions.filter((q) => counts(q) && q.qtype === qtype);
    const rate =
      counted.length === 0 ? -1 : counted.filter((q) => q.passed).length / counted.length;
    const times = questions.flatMap((q) =>
      q.qtype === qtype && q.durationMs !== null ? [q.durationMs] : [],
    );
    return { qtype, order, rate, time: median(times) ?? 0 };
  });
  stats.sort((a, b) => a.rate - b.rate || b.time - a.time || a.order - b.order);
  return stats[0]?.qtype ?? QTYPES[level][0] ?? 'explain';
}

export function nextTargets(
  map: MapInput,
  model: Model,
  opts: { areas?: string[]; count: number; sessionId: string | null },
): NextResult {
  for (const id of opts.areas ?? []) {
    if (!model.areas.some((a) => a.id === id)) throw new Error(`unknown area ${id}`);
  }
  const inSession =
    opts.sessionId === null ? [] : model.questions.filter((q) => q.sessionId === opts.sessionId);
  const mapIndex = (id: string): number => map.areas.findIndex((a) => a.id === id);
  const capped = (id: string): boolean =>
    inSession.filter((q) => q.areaId === id).length >= SESSION_AREA_CAP;

  const eligible = model.areas
    .filter((a) => !a.retired && (opts.areas === undefined || opts.areas.includes(a.id)))
    .map((area) => ({ area, capped: capped(area.id) }));
  eligible.sort(
    (x, y) =>
      Number(x.capped) - Number(y.capped) ||
      group(x.area) - group(y.area) ||
      (x.area.stale ? 0 : levelRank(x.area.level) - levelRank(y.area.level)) ||
      compareText(x.area.lastTestedAt, y.area.lastTestedAt) ||
      mapIndex(x.area.id) - mapIndex(y.area.id),
  );

  const targets = eligible.slice(0, Math.max(0, opts.count)).map(({ area }): NextTarget => {
    const level = targetLevel(area);
    const questions = model.questions.filter((q) => q.areaId === area.id);
    const reason = area.stale
      ? 'stale'
      : area.level === 'rebuild'
        ? 'keep_fresh'
        : area.perLevel[level].valid < 2
          ? 'untested'
          : 'not_held';
    return {
      areaId: area.id,
      title: area.title,
      level,
      qtype: pickType(level, questions),
      reason,
      recentPrompts: questions
        .slice(-RECENT_PROMPTS)
        .reverse()
        .map((q) => q.prompt),
    };
  });

  return {
    targets,
    session: {
      id: opts.sessionId,
      asked: inSession.length,
      limit: SESSION_QUESTIONS,
      done: inSession.length >= SESSION_QUESTIONS,
    },
  };
}
