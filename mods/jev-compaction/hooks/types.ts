import type { SessionMessage } from 'claude-code'

export type Message = SessionMessage

export type Options = {
  goal: string
  keepThreshold: number
  abridgeThreshold: number
  preserveRecentMessages: number
  maxStateTokens: number
  maxRequestTokens: number
  truncateHeadChars: number
}

/** A tool call paired with its result by `tool_use_id`. */
export type ToolCall = {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  id: string
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
  callIndex: number
  resultIndex: number
  resultChars: number
  isError: boolean
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean
}

/** Message text that Jev may judge: not pinned and long enough. */
export type TextCandidate = {
  index: number
  role: 'user' | 'assistant'
  chars: number
}

export type Question = {
  /** The name in the Jev request. */
  name: string
  /** Score memory key. */
  key: string
  instructions: string
  /** Thresholds the score is compared with; a score near one is asked again. */
  thresholds: number[]
  /** For a text question, the message index (it must be visible in the state). */
  textIndex?: number
}

/** Jev's keep probabilities remembered by fingerprint. */
export type Scores = Record<string, number>

export type ToolAction = 'keep' | 'drop_result' | 'drop_call'
export type TextAction = 'keep' | 'abridge' | 'stub'

export type CompactStats = {
  messagesBefore: number
  messagesAfter: number
  charsBefore: number
  charsAfter: number
  calls: number
  toolsKept: number
  resultsTruncated: number
  callsDropped: number
  textsKept: number
  textsAbridged: number
  textsStubbed: number
  pinned: number
  stateTokens: number
  stateStage: string
  requests: number
  reused: number
}

export type CompactResult = {
  messages: Message[]
  stats: CompactStats
  /** Scores Jev answered in this run, to remember. */
  scores: Scores
}

/** Anything that can answer noul questions: the probability per question name. */
export type JevAsker = (state: object, questions: Record<string, { type: 'noul'; instructions: string }>) => Promise<Record<string, number>>
