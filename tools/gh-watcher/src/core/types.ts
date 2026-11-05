import type { HookConfig } from '@ai-tools/hooks';

export type { HookConfig, HookEvent, HookResult } from '@ai-tools/hooks';

export type TargetKind = 'run' | 'pr' | 'branch' | 'commit';

export type WatchTarget =
  | { kind: 'run'; runId: number }
  | { kind: 'pr'; number: number }
  | { kind: 'branch'; branch: string }
  | { kind: 'commit'; sha: string };

export interface GhRunInfo {
  databaseId: number;
  workflowName: string;
  displayTitle: string;
  status: string;
  conclusion: string | null;
  url: string;
  headSha: string;
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  attempt?: number;
}

export interface GhStepInfo {
  name: string;
  number: number;
  status?: string;
  conclusion: string | null;
}

export interface GhJobInfo {
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
  steps?: GhStepInfo[];
}

export interface FailedStep {
  runId: number;
  workflowName: string;
  jobName: string;
  stepName: string;
  stepNumber: number;
}

export type CheckState = 'pending' | 'success' | 'failure' | 'none';

export interface CheckReport {
  repo: string;
  target: WatchTarget;
  targetKey: string;
  state: CheckState;
  runs: GhRunInfo[];
  failedSteps: FailedStep[];
  checkedAt: string;
}

export type Trigger = 'failure' | 'success';

export const PR_EVENT_KINDS = [
  'opened',
  'reopened',
  'closed',
  'merged',
  'draft',
  'ready',
  'comment',
  'review',
  'review_comment',
  'push',
  'review_decision',
] as const;

export type PrEventKind = (typeof PR_EVENT_KINDS)[number];

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface PrComment {
  id: string;
  author: string;
  createdAt: string;
  url: string;
}

export interface PrReview {
  id: string;
  author: string;
  state: string;
  submittedAt: string;
  url?: string;
}

export interface PrReviewComment {
  id: string;
  author: string;
  createdAt: string;
  path?: string;
  url: string;
}

export interface PrSnapshot {
  number: number;
  url: string;
  title: string;
  state: PrState;
  isDraft: boolean;
  headSha: string;
  headRef: string;
  reviewDecision: string | null;
  mergedAt?: string;
  closedAt?: string;
  comments: PrComment[];
  reviews: PrReview[];
  reviewComments: PrReviewComment[];
  /** PR `updatedAt`; lets the next snapshot skip the inline comments call when unchanged. */
  updatedAt?: string;
  checkedAt: string;
}

export interface PrSummary {
  number: number;
  url: string;
  state: PrState;
  isDraft: boolean;
  headSha: string;
  reviewDecision: string | null;
}

export interface PrEvent {
  kind: PrEventKind;
  at: string;
  author?: string;
  url?: string;
  path?: string;
  reviewState?: string;
  from?: string | null;
  to?: string | null;
  initial?: boolean;
}

/** What a persistent watch remembers about a pull request between checks. */
export interface PrLastState {
  number: number;
  state: PrState;
  isDraft: boolean;
  headSha: string;
  reviewDecision: string | null;
  updatedAt?: string;
  commentIds: string[];
  reviewIds: string[];
  reviewCommentIds: string[];
}

export interface GhWatchSpec {
  name: string;
  repo: string;
  target: WatchTarget;
  triggers: { failure: boolean; success: boolean };
  hook: HookConfig;
  intervalSeconds: number;
  createdAt: string;
  lastCheckedAt?: string;
  lastFiredAt?: string;
  lastState?: CheckState;
  lastRunsKey?: string;
  /** Pull request event kinds to fire on; absent for CI-only watches. */
  prEvents?: PrEventKind[];
  /** Pull request seen at the last check; null when the target had no pull request, absent before the first check. */
  lastPr?: PrLastState | null;
}

export interface GhEvent {
  watch: string;
  repo: string;
  targetKey: string;
  state: CheckState;
  failedSteps: FailedStep[];
  runsCount: number;
  checkedAt: string;
  fired: boolean;
  error?: string;
  prEvents?: PrEvent[];
}

export interface GhWatcherState {
  watchers: GhWatchSpec[];
  lastFired: Record<string, { state: CheckState; runsKey: string }>;
}

export function targetKey(target: WatchTarget): string {
  switch (target.kind) {
    case 'run':
      return `run:${target.runId}`;
    case 'pr':
      return `pr:${target.number}`;
    case 'branch':
      return `branch:${target.branch}`;
    case 'commit':
      return `commit:${target.sha}`;
  }
}
