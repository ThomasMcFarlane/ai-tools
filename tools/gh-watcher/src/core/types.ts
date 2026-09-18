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
}

export interface GhStepInfo {
  name: string;
  number: number;
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
