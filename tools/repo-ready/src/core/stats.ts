import type { Level, Mode, Model, QuestionRecord } from './types.js';

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
