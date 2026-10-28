// how often the caveman reminder is kept, and whether post-compaction texts are shortened
export type ContextDietOptions = { reminderEvery: number; shortenAfterCompact: boolean }

declare module 'claude-code' {
  interface PluginState {
    'context-diet': {
      // user prompts seen since the session started or was cleared
      prompts: number
      // a compaction happened since the last prompt, so the next one keeps the reminder
      compacted: boolean
    }
  }
}
