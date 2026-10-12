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
  textCompression: boolean
  sentenceKeepThreshold: number
  maxSentenceDropRatio: number
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
  /** For a text or sentence question, the message index (it must be visible in the state). */
  textIndex?: number
  /** For a tool question, the call id (`t3`); it must be listed in the state. */
  callId?: string
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
  sentencesDropped: number
  wordCharsSaved: number
  abandoned: number
  failed: number
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
/** Options of one run that are not userConfig. */
export type RunOptions = {
  protect?: Protect
  /** Checked before each round of requests; true abandons the remaining batches (their items stay). */
  stop?: () => boolean
  /** Ask at most this many batches (pre-scoring); the rest is left for later. */
  maxBatches?: number
  /** Ask nothing unless at least this many questions are unscored (pre-scoring: one batch's worth). */
  minQuestions?: number
  /** Reuse every remembered score whatever its distance from a threshold. */
  reuseAll?: boolean
}

export type JevAsker = (state: object, questions: Record<string, { type: 'noul'; instructions: string }>) => Promise<Record<string, number>>

/** Messages that hold non-text content (images, documents) and must not be rebuilt. */
export type Protect = {
  ids: ReadonlySet<string>
  indexes: ReadonlySet<number>
  /** The session holds images or documents in user messages: no user text is abridged. */
  noUserText?: boolean
}

export type ApplyCounts = { truncated: number; dropped: number; abridged: number; stubbed: number; sentences?: number; wordChars?: number }
