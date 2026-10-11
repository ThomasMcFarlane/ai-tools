export type JevSkillsStats = {
  // session listings replaced by a shortlist
  listings: number
  // prompts after the listing that were judged
  prompts: number
  // Jev requests made
  requests: number
  // listings and prompts where Jev could not answer (built-in behaviour kept)
  failures: number
  // skills added to later prompts
  added: number
  // skills invoked in the session
  used: number
  // of those, skills that had been shortlisted
  usedShortlisted: number
  // estimated tokens of the listing the engine built and of the shortlist that replaced it
  tokensBefore: number
  tokensAfter: number
}

export type JevSkillsLast = {
  at: 'listing' | 'prompt'
  prompt: string
  // best scores, highest first
  top: [string, number][]
  picks: string[]
  requests: number
  unscored: number
  failed?: string
}

declare module 'claude-code' {
  interface PluginState {
    'jev-skills': {
      // runtime override of the enabled option (/jev-skills on|off)
      enabled: boolean
      // every skill seen in the listing: name to description (empty when the listing gave none)
      roster: Record<string, string>
      // skills the model can currently see; only grows until a compaction
      shown: string[]
      // whether this session's listing was replaced by a shortlist
      replaced: boolean
      // the person's latest prompts, oldest first
      recent: string[]
      last: JevSkillsLast
      stats: JevSkillsStats
    }
  }
}
