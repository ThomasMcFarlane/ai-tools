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
}

declare module 'claude-code' {
  interface PluginState {
    'jev-compaction': {
      // Jev keep probabilities by fingerprint of tool and input (or role and text hash)
      scores: Record<string, number>
      stats: JevCompactionStats
      // context tokens of the last attempt that did not reach the target; 0 when none
      guard: number
    }
  }
}
