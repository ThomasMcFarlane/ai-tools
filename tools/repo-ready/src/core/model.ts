import {
  LEVELS,
  LEVEL_LABELS,
  LEVEL_PASSES,
  LEVEL_WINDOW,
  NOT_ENOUGH_LABEL,
  PASS_SCORE,
  QTYPES,
  STALE_CLEAR_AFTER,
  type AreaState,
  type HeldLevel,
  type Level,
  type LevelTally,
  type LogEvent,
  type MapInput,
  type Model,
  type QType,
  type QuestionRecord,
  type SessionRecord,
  type Verdict,
} from './types.js';

const RANKS: Record<HeldLevel, number> = { none: 0, read: 1, maintain: 2, rebuild: 3 };
const QTYPE_ORDER: QType[] = LEVELS.flatMap((level) => QTYPES[level]);
const MAX_WEAKEST_TYPES = 3;
const MAX_RECURRING_GAPS = 5;

export function levelRank(level: HeldLevel): number {
  return RANKS[level];
}

interface Tracked {
  id: string;
  title: string;
  key: boolean;
  revision: number;
  retired: boolean;
  stale: boolean;
  staleFrom: Level | null;
  retestCount: number;
  lastTestedAt: string | null;
  questions: QuestionRecord[];
}

interface Standing {
  level: HeldLevel;
  untested: boolean;
  perLevel: Record<Level, LevelTally>;
}

function counts(question: QuestionRecord): boolean {
  return !question.voided && (question.status === 'graded' || question.status === 'skipped');
}

function standing(questions: QuestionRecord[]): Standing {
  const tally = (level: Level): LevelTally => {
    const valid = questions.filter((q) => counts(q) && q.level === level);
    const passedInWindow = valid.slice(-LEVEL_WINDOW).filter((q) => q.passed).length;
    return { valid: valid.length, passedInWindow, held: passedInWindow >= LEVEL_PASSES };
  };
  const perLevel = { read: tally('read'), maintain: tally('maintain'), rebuild: tally('rebuild') };
  let level: HeldLevel = 'none';
  for (const candidate of LEVELS) {
    if (!perLevel[candidate].held) break;
    level = candidate;
  }
  return { level, untested: perLevel.read.valid < 2, perLevel };
}

function track(
  areas: Map<string, Tracked>,
  id: string,
  from: { title: string; key: boolean; revision: number; retired: boolean },
): Tracked {
  const found = areas.get(id);
  if (found) return found;
  const created: Tracked = {
    id,
    ...from,
    stale: false,
    staleFrom: null,
    retestCount: 0,
    lastTestedAt: null,
    questions: [],
  };
  areas.set(id, created);
  return created;
}

function afterTest(tracked: Tracked, question: QuestionRecord, at: string): void {
  tracked.lastTestedAt = at;
  if (!tracked.stale || tracked.staleFrom === null) return;
  if (question.level === tracked.staleFrom) tracked.retestCount += 1;
  const regained = levelRank(standing(tracked.questions).level) >= levelRank(tracked.staleFrom);
  if (regained || tracked.retestCount >= STALE_CLEAR_AFTER) {
    tracked.stale = false;
    tracked.staleFrom = null;
  }
}

function raiseRevision(tracked: Tracked): void {
  const level = standing(tracked.questions).level;
  const floor = level === 'none' ? 1 : levelRank(level);
  for (const question of tracked.questions) {
    if (counts(question) && levelRank(question.level) >= floor) question.voided = true;
  }
  if (level !== 'none') {
    tracked.stale = true;
    tracked.staleFrom = level;
    tracked.retestCount = 0;
  } else if (tracked.stale) {
    tracked.retestCount = 0;
  }
}

function replay(
  map: MapInput,
  events: LogEvent[],
): { areas: Map<string, Tracked>; questions: QuestionRecord[]; sessions: SessionRecord[] } {
  const areas = new Map<string, Tracked>();
  const questions = new Map<string, QuestionRecord>();
  const sessions = new Map<string, SessionRecord>();
  for (const area of map.areas) {
    track(areas, area.id, {
      title: area.title,
      key: area.key,
      revision: area.revision,
      retired: false,
    });
  }

  for (const event of events) {
    switch (event.type) {
      case 'session_start': {
        if (event.sessionId === null || sessions.has(event.sessionId)) break;
        sessions.set(event.sessionId, {
          id: event.sessionId,
          mode: event.mode ?? 'learn',
          startedAt: event.at,
          endedAt: null,
          auto: false,
          branch: event.branch,
          commit: event.commit,
          dirty: event.dirty,
          questionIds: [],
        });
        break;
      }
      case 'session_end': {
        const session = event.sessionId === null ? undefined : sessions.get(event.sessionId);
        if (session) {
          session.endedAt = event.at;
          session.auto = event.auto;
        }
        break;
      }
      case 'map_set': {
        for (const change of event.changes) {
          if (change.kind !== 'revision_raised') continue;
          const tracked = areas.get(change.areaId);
          if (tracked) raiseRevision(tracked);
        }
        break;
      }
      case 'ask': {
        if (questions.has(event.questionId)) break;
        const tracked = track(areas, event.areaId, {
          title: event.areaId,
          key: false,
          revision: event.revision,
          retired: true,
        });
        if (tracked.retired) tracked.revision = Math.max(tracked.revision, event.revision);
        const record: QuestionRecord = {
          id: event.questionId,
          sessionId: event.sessionId ?? '',
          mode: event.mode ?? 'learn',
          areaId: event.areaId,
          revision: event.revision,
          level: event.level,
          qtype: event.qtype,
          principleIds: event.principleIds,
          prompt: event.prompt,
          evidence: event.evidence,
          followUpOf: event.followUpOf,
          askedAt: event.at,
          branch: event.branch,
          commit: event.commit,
          answer: null,
          answeredAt: null,
          durationMs: null,
          hints: 0,
          score: null,
          notes: '',
          gaps: [],
          status: 'open',
          passed: false,
          voided: false,
        };
        questions.set(record.id, record);
        tracked.questions.push(record);
        if (event.sessionId !== null) sessions.get(event.sessionId)?.questionIds.push(record.id);
        break;
      }
      case 'hint': {
        const question = questions.get(event.questionId);
        if (question) question.hints += 1;
        break;
      }
      case 'answer': {
        const question = questions.get(event.questionId);
        if (!question || question.status !== 'open') break;
        question.status = 'answered';
        question.answer = event.text;
        question.answeredAt = event.at;
        question.durationMs = event.durationMs;
        break;
      }
      case 'grade': {
        const question = questions.get(event.questionId);
        if (!question || (question.status !== 'open' && question.status !== 'answered')) break;
        question.status = 'graded';
        question.score = event.score;
        question.notes = event.notes;
        question.gaps = event.gaps;
        question.passed = event.score >= PASS_SCORE && question.hints === 0;
        const tracked = areas.get(question.areaId);
        if (tracked) afterTest(tracked, question, event.at);
        break;
      }
      case 'skip': {
        const question = questions.get(event.questionId);
        if (!question || (question.status !== 'open' && question.status !== 'answered')) break;
        question.status = 'skipped';
        const tracked = areas.get(question.areaId);
        if (tracked) afterTest(tracked, question, event.at);
        break;
      }
      default:
        break;
    }
  }
  return { areas, questions: [...questions.values()], sessions: [...sessions.values()] };
}

function toAreaState(tracked: Tracked): AreaState {
  const { level, untested, perLevel } = standing(tracked.questions);
  return {
    id: tracked.id,
    title: tracked.title,
    key: tracked.key,
    revision: tracked.revision,
    retired: tracked.retired,
    level,
    label: LEVEL_LABELS[level],
    stale: tracked.stale,
    staleFrom: tracked.staleFrom,
    untested,
    lastTestedAt: tracked.lastTestedAt,
    perLevel,
  };
}

function weakestTypes(questions: QuestionRecord[]): QType[] {
  const rates = QTYPE_ORDER.flatMap((qtype) => {
    const asked = questions.filter((q) => q.qtype === qtype);
    if (asked.length === 0) return [];
    return [{ qtype, rate: asked.filter((q) => q.passed).length / asked.length }];
  });
  return rates
    .sort((a, b) => a.rate - b.rate)
    .slice(0, MAX_WEAKEST_TYPES)
    .map((entry) => entry.qtype);
}

function recurringGaps(questions: QuestionRecord[]): string[] {
  const seen = new Map<string, number>();
  for (const question of questions) {
    for (const gap of question.gaps) seen.set(gap, (seen.get(gap) ?? 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, MAX_RECURRING_GAPS)
    .map(([gap]) => gap);
}

function verdictFor(areas: AreaState[], questions: QuestionRecord[]): Verdict {
  const live = areas.filter((a) => !a.retired);
  const keyAreas = live.filter((a) => a.key);
  const lowest = keyAreas.reduce<HeldLevel>(
    (low, a) => (levelRank(a.level) < levelRank(low) ? a.level : low),
    'rebuild',
  );
  const m: HeldLevel = keyAreas.length === 0 ? 'none' : lowest;
  const liveIds = new Set(live.map((a) => a.id));
  const counted = questions.filter((q) => counts(q) && liveIds.has(q.areaId));
  const untestedKeyAreas =
    m === 'none' ? keyAreas.filter((a) => a.level === 'none' && a.untested) : [];
  const stats = { weakestTypes: weakestTypes(counted), recurringGaps: recurringGaps(counted) };
  const holdingBack = m === 'rebuild' ? [] : keyAreas.filter((a) => a.level === m).map((a) => a.id);

  if (untestedKeyAreas.length > 0) {
    return {
      kind: 'not_enough_evidence',
      level: m,
      label: NOT_ENOUGH_LABEL,
      untestedKeyAreas: untestedKeyAreas.map((a) => a.id),
      holdingBack,
      ...stats,
    };
  }
  return {
    kind: m === 'none' ? 'not_yet_ready' : 'level',
    level: m,
    label: LEVEL_LABELS[m],
    untestedKeyAreas: [],
    holdingBack,
    ...stats,
  };
}

export function buildModel(map: MapInput, events: LogEvent[]): Model {
  const replayed = replay(map, events);
  const areas = [...replayed.areas.values()].map(toAreaState);
  return {
    areas,
    questions: replayed.questions,
    sessions: replayed.sessions,
    verdict: verdictFor(areas, replayed.questions),
  };
}
