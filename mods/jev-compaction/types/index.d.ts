export type JevCompactionStats = {
  // compactions applied by the mod's pruning
  applied: number
  // soft compactions deferred (kept the conversation, scores remembered)
  deferred: number
  // compactions handed to the built-in summary
  fallbacks: number
  // estimated tokens freed by applied compactions
  freedTokens: number
  // Jev requests made
  requests: number
  // sentences dropped and characters saved by word compression during compactions
  sentencesDropped: number
  wordCharsSaved: number
  // characters saved by compressing rows as they entered the transcript
  entryCharsSaved: number
}

// One prompt the person sent (composer or Remote Control), verbatim.
export type JevCompactionLedgerEntry = { at: number; text: string }
export type JevCompactionHandover = {
  goal: string
  openTasks: { title: string; state: string; next: string; row: string }[]
  prs: { url: string; state: string }[]
  agents: { id: string; purpose: string; onResult: string }[]
  pendingQuestions: string[]
  decisions: string[]
  paths: string[]
  handoverDir: string
}
export type JevCompactionRotation = {
  // main turns that ended in an answer, and those at rotateHighTokens or more since the last rotation
  turns: number
  highTurns: number
  // when the session was last rotated
  rotatedAt?: number
  // what the due timer counts from while there was no rotation in this process: a resumed session's last rotation, else the start
  timerFrom?: number
  // no automatic rotation before `turns` reaches this (after a skipped one)
  retryAt?: number
  // the ledger holds the prompts from before install, read from the transcript
  backfilled?: boolean
  // a rotation waiting for the model's handover: dry run or not, main turns since the request, whether it was asked yet
  phase?: { dry: boolean; turns: number; asked: boolean }
  handover?: JevCompactionHandover & { handoffPath: string; promptsPath: string }
}

declare module 'claude-code' {
  interface PluginState {
    'jev-compaction': {
      // Jev keep probabilities by fingerprint of tool and input (or role and text hash)
      scores: Record<string, number>
      stats: JevCompactionStats
      // context tokens of the last attempt that did not reach the target; 0 when none
      guard: number
      // real tokens freed per token of the character estimate, learnt from the host's count after each applied compaction
      ratio: number
      // whether the session is interactive, kept so a hot reload knows
      interactive: boolean
      // every prompt of the person this session (since install, or backfilled from the transcript)
      ledger: JevCompactionLedgerEntry[]
      rotation: JevCompactionRotation
    }
  }
}
