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

/** Normalised outcome of one check that is not a GitHub Actions workflow run. */
export type ExternalCheckStatus = 'pending' | 'success' | 'failure';

/**
 * A check on a commit that Actions workflow runs do not cover: a third-party check run (a GitHub
 * App other than github-actions) or a commit status (for example Terraform Cloud).
 */
export interface ExternalCheck {
  kind: 'check_run' | 'status';
  name: string;
  /** App slug for a check run; host of the target URL for a commit status (empty when unknown). */
  source: string;
  status: ExternalCheckStatus;
  /** Raw check run conclusion (null while running) or commit status state. */
  conclusion: string | null;
  url: string;
  updatedAt?: string;
}

/** A failed non-Actions check, for agents to act on. */
export interface FailedCheck {
  kind: 'check_run' | 'status';
  name: string;
  source: string;
  url: string;
}

export interface CheckReport {
  repo: string;
  target: WatchTarget;
  targetKey: string;
  state: CheckState;
  runs: GhRunInfo[];
  /** Non-Actions checks (third-party check runs and commit statuses) on the same commit. */
  checks: ExternalCheck[];
  failedSteps: FailedStep[];
  /** Failed non-Actions checks; empty unless the state is `failure`. */
  failedChecks: FailedCheck[];
  /** Set when the token could not read check runs or statuses; the state then covers Actions runs only. */
  checksUnavailable?: string;
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
  failedChecks?: FailedCheck[];
  runsCount: number;
  /** Number of non-Actions checks; absent in events recorded before 0.5.0. */
  checksCount?: number;
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
