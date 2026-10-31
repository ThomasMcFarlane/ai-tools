export type TargetKind = 'pr' | 'branch' | 'commit' | 'run'

export type Target = { repo: string; kind: TargetKind; value: string }

export type Step = { name: string; number: number; status?: string; conclusion: string | null }
export type Job = { name: string; status: string; conclusion: string | null; url?: string; steps?: Step[] }
export type Run = {
  databaseId: number
  workflowName: string
  status: string
  conclusion: string | null
  url: string
  startedAt?: string
  updatedAt?: string
  createdAt?: string
  attempt?: number
  jobs?: Job[]
}
export type FollowLine = {
  repo: string
  targetKey: string
  state: string
  runs: Run[]
  failedSteps: { runId?: number; jobName: string; stepName: string; stepNumber: number }[]
  source: 'events' | 'poll'
  checkedAt: string
  isFinal: boolean
  timedOut?: boolean
}

export type Result = { conclusion: string; workflow: string; repo: string; target: string; duration: string; failed: string[]; url: string; text: string }

export type ActiveRun = {
  key: string
  runId: number
  attempt: number
  target: Target
  run: Run
  source: 'events' | 'poll'
  checkedAt: number
  seenAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'gh-runs': {
      // runs being followed, one per target and run
      targets: Target[]
      // runs shown in the band: no conclusion yet
      active: ActiveRun[]
      // `<run id>#<attempt>` of every run already given a chat item
      noticed: string[]
      // finished-run summaries by `<run id>.<attempt>`, read by the ci-result row
      results: Record<string, Result>
      // spinner frame, moved by the tick
      frame: number
      // run ids whose steps are shown; absent means collapsed
      expanded: string[]
    }
  }
}
