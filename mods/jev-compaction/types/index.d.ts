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

declare module 'claude-code' {
  interface PluginState {
    'jev-compaction': {
      // Jev keep probabilities by fingerprint of tool and input (or role and text hash)
      scores: Record<string, number>
      stats: JevCompactionStats
      // context tokens of the last attempt that did not reach the target; 0 when none
      guard: number
      // whether the session is interactive, kept so a hot reload knows
      interactive: boolean
    }
  }
}
