import {
  LEVELS,
  QTYPES,
  type AreaState,
  type Level,
  type LogEvent,
  type MapInput,
  type Mode,
  type Model,
  type QType,
  type QuestionRecord,
  type Verdict,
} from './types.js';

export interface SessionSummary {
  sessionId: string;
  mode: Mode;
  startedAt: string;
  endedAt: string | null;
  asked: number;
  graded: number;
  passed: number;
  passRate: number | null;
  medianMs: number | null;
  hints: number;
  skips: number;
  byArea: { areaId: string; level: Level; asked: number; passed: number }[];
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

export function sessionSummary(model: Model, sessionId: string): SessionSummary {
  const session = model.sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);
  const questions = model.questions.filter((q) => q.sessionId === sessionId);
  const skips = questions.filter((q) => q.status === 'skipped').length;
  const graded = questions.filter((q) => q.status === 'graded').length;
  const passed = questions.filter((q) => q.passed).length;
  const counted = graded + skips;
  const byArea = new Map<string, { areaId: string; level: Level; asked: number; passed: number }>();
  for (const q of questions) {
    const key = `${q.areaId}\u0000${q.level}`;
    const entry = byArea.get(key) ?? { areaId: q.areaId, level: q.level, asked: 0, passed: 0 };
    entry.asked += 1;
    if (q.passed) entry.passed += 1;
    byArea.set(key, entry);
  }
  const times = questions.flatMap((q: QuestionRecord) =>
    q.durationMs === null ? [] : [q.durationMs],
  );
  return {
    sessionId,
    mode: session.mode,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    asked: questions.length,
    graded,
    passed,
    passRate: counted === 0 ? null : passed / counted,
    medianMs: median(times),
    hints: questions.reduce((total, q) => total + q.hints, 0),
    skips,
    byArea: [...byArea.values()],
  };
}

export const CHART_KINDS = ['levels', 'accuracy', 'speed', 'types', 'timeline'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];
export type ChartData =
  | { kind: 'levels'; verdict: Verdict; areas: (AreaState & { summary: string })[] }
  | {
      kind: 'accuracy';
      sessions: {
        sessionId: string;
        startedAt: string;
        mode: Mode;
        counted: number;
        passed: number;
        passRate: number | null;
      }[];
      byArea: {
        areaId: string;
        title: string;
        points: { sessionId: string; passRate: number | null }[];
      }[];
    }
  | {
      kind: 'speed';
      sessions: {
        sessionId: string;
        startedAt: string;
        count: number;
        medianMs: number | null;
        meanMs: number | null;
      }[];
    }
  | {
      kind: 'types';
      types: {
        qtype: QType;
        level: Level;
        counted: number;
        passed: number;
        passRate: number | null;
        medianMs: number | null;
      }[];
    }
  | {
      kind: 'timeline';
      sessions: {
        sessionId: string;
        startedAt: string;
        endedAt: string | null;
        mode: Mode;
        branch: string | null;
        commit: string | null;
        dirty: boolean;
        asked: number;
        passed: number;
      }[];
      maps: { at: string; commit: string | null; raised: string[] }[];
    };

const isCounted = (q: QuestionRecord): boolean => q.status === 'graded' || q.status === 'skipped';
const rate = (passed: number, counted: number): number | null =>
  counted === 0 ? null : passed / counted;
const durations = (questions: QuestionRecord[]): number[] =>
  questions.flatMap((q) => (q.durationMs === null ? [] : [q.durationMs]));

export function chartData(
  kind: ChartKind,
  map: MapInput,
  model: Model,
  events: LogEvent[],
): ChartData {
  const live = model.areas.filter((a) => !a.retired);
  const inSession = (id: string): QuestionRecord[] =>
    model.questions.filter((q) => q.sessionId === id);
  switch (kind) {
    case 'levels': {
      const summaries = new Map(map.areas.map((a) => [a.id, a.summary]));
      return {
        kind,
        verdict: model.verdict,
        areas: [...live, ...model.areas.filter((a) => a.retired)].map((a) => ({
          ...a,
          summary: summaries.get(a.id) ?? '',
        })),
      };
    }
    case 'accuracy':
      return {
        kind,
        sessions: model.sessions.map((s) => {
          const questions = inSession(s.id);
          const counted = questions.filter(isCounted).length;
          const passed = questions.filter((q) => q.passed).length;
          return {
            sessionId: s.id,
            startedAt: s.startedAt,
            mode: s.mode,
            counted,
            passed,
            passRate: rate(passed, counted),
          };
        }),
        byArea: live.map((a) => ({
          areaId: a.id,
          title: a.title,
          points: model.sessions.map((s) => {
            const questions = inSession(s.id).filter((q) => q.areaId === a.id && isCounted(q));
            return {
              sessionId: s.id,
              passRate: rate(questions.filter((q) => q.passed).length, questions.length),
            };
          }),
        })),
      };
    case 'speed':
      return {
        kind,
        sessions: model.sessions.map((s) => {
          const times = durations(inSession(s.id));
          return {
            sessionId: s.id,
            startedAt: s.startedAt,
            count: times.length,
            medianMs: median(times),
            meanMs:
              times.length === 0
                ? null
                : Math.round(times.reduce((a, b) => a + b, 0) / times.length),
          };
        }),
      };
    case 'types': {
      const liveIds = new Set(live.map((a) => a.id));
      const eligible = model.questions.filter((q) => !q.voided && liveIds.has(q.areaId));
      return {
        kind,
        types: LEVELS.flatMap((level) =>
          QTYPES[level].map((qtype) => {
            const asked = eligible.filter((q) => q.qtype === qtype);
            const counted = asked.filter(isCounted);
            const passed = counted.filter((q) => q.passed).length;
            return {
              qtype,
              level,
              counted: counted.length,
              passed,
              passRate: rate(passed, counted.length),
              medianMs: median(durations(asked)),
            };
          }),
        ),
      };
    }
    case 'timeline':
      return {
        kind,
        sessions: model.sessions.map((s) => {
          const questions = inSession(s.id);
          return {
            sessionId: s.id,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            mode: s.mode,
            branch: s.branch,
            commit: s.commit,
            dirty: s.dirty,
            asked: questions.length,
            passed: questions.filter((q) => q.passed).length,
          };
        }),
        maps: events.flatMap((e) =>
          e.type === 'map_set'
            ? [
                {
                  at: e.at,
                  commit: e.commit,
                  raised: e.changes
                    .filter((c) => c.kind === 'revision_raised')
                    .map((c) => c.areaId),
                },
              ]
            : [],
        ),
      };
  }
}
