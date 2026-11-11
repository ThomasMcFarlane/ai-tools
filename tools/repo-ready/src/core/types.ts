export const PASS_SCORE = 3;
export const LEVEL_PASSES = 2;
export const LEVEL_WINDOW = 3;
export const STALE_CLEAR_AFTER = 3;
export const SESSION_QUESTIONS = 8;
export const SESSION_AREA_CAP = 3;
export const MIN_AREAS = 1;
export const MAX_AREAS = 10;
export const RECENT_PROMPTS = 5;
export const DIR_SLUG_MAX = 80;

export const LEVELS = ['read', 'maintain', 'rebuild'] as const;
export type Level = (typeof LEVELS)[number];
export type HeldLevel = Level | 'none';
export type QType = 'explain' | 'trace' | 'predict' | 'debug' | 'change' | 'rebuild';
export type Mode = 'learn' | 'interview';

export const LEVEL_LABELS: Record<HeldLevel, string> = {
  none: 'Not yet ready',
  read: 'Ready to be interviewed on it',
  maintain: 'Ready to work on it',
  rebuild: 'Ready to own it',
};
export const NOT_ENOUGH_LABEL = 'Not enough evidence yet';
export const QTYPES: Record<Level, QType[]> = {
  read: ['explain', 'trace'],
  maintain: ['predict', 'debug', 'change'],
  rebuild: ['rebuild'],
};

export class NotFoundError extends Error {}

export interface Principle {
  id: string;
  statement: string;
  reason: string;
  evidence: string[];
}
export interface Area {
  id: string;
  title: string;
  summary: string;
  key: boolean;
  paths: string[];
  revision: number;
  principles: Principle[];
}
export interface MapInput {
  areas: Area[];
}
export interface StoredMap extends MapInput {
  version: 1;
  repoKey: string;
  branch: string | null;
  commit: string | null;
  setAt: string;
}
export interface MapChange {
  kind: 'added' | 'removed' | 'key_set' | 'key_cleared' | 'revision_raised';
  areaId: string;
  from?: number;
  to?: number;
}

export interface EventBase {
  at: string;
  sessionId: string | null;
  mode: Mode | null;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  mapCommit: string | null;
}
export type LogEvent = EventBase &
  (
    | { type: 'session_start' }
    | { type: 'session_end'; auto: boolean }
    | { type: 'map_set'; changes: MapChange[]; forced: string | null }
    | { type: 'lesson'; areaId: string; principleIds: string[] }
    | {
        type: 'ask';
        questionId: string;
        areaId: string;
        revision: number;
        level: Level;
        qtype: QType;
        principleIds: string[];
        prompt: string;
        evidence: string[];
        followUpOf: string | null;
      }
    | { type: 'hint'; questionId: string }
    | { type: 'answer'; questionId: string; text: string; durationMs: number }
    | { type: 'grade'; questionId: string; score: number; notes: string; gaps: string[] }
    | { type: 'skip'; questionId: string }
  );

export interface QuestionRecord {
  id: string;
  sessionId: string;
  mode: Mode;
  areaId: string;
  revision: number;
  level: Level;
  qtype: QType;
  principleIds: string[];
  prompt: string;
  evidence: string[];
  followUpOf: string | null;
  askedAt: string;
  branch: string | null;
  commit: string | null;
  answer: string | null;
  answeredAt: string | null;
  durationMs: number | null;
  hints: number;
  score: number | null;
  notes: string;
  gaps: string[];
  status: 'open' | 'answered' | 'graded' | 'skipped';
  passed: boolean;
  voided: boolean;
}
export interface LevelTally {
  valid: number;
  passedInWindow: number;
  held: boolean;
}
export interface AreaState {
  id: string;
  title: string;
  key: boolean;
  revision: number;
  retired: boolean;
  level: HeldLevel;
  label: string;
  stale: boolean;
  staleFrom: Level | null;
  untested: boolean;
  lastTestedAt: string | null;
  perLevel: Record<Level, LevelTally>;
}
export interface Verdict {
  kind: 'level' | 'not_enough_evidence' | 'not_yet_ready';
  level: HeldLevel;
  label: string;
  untestedKeyAreas: string[];
  holdingBack: string[];
  weakestTypes: QType[];
  recurringGaps: string[];
}
export interface SessionRecord {
  id: string;
  mode: Mode;
  startedAt: string;
  endedAt: string | null;
  auto: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  questionIds: string[];
}
export interface Model {
  areas: AreaState[];
  questions: QuestionRecord[];
  sessions: SessionRecord[];
  verdict: Verdict;
}
