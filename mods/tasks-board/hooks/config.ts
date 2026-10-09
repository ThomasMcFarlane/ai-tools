import type { PluginOptions } from 'claude-code'

/** The plugin's options (`userConfig` in plugin.json), read once per load. Every field is optional. */
export type BoardConfig = {
  /** Path template for the primary board; placeholders {org} {repo} {root}. Empty: the git main worktree's TASKS.md. */
  baseBoard: string
  /** Value of {root} in the templates. */
  reposRoot: string
  /** Path templates ({root} {org} {repo} {task}) that derive org, repo and worktree name from the cwd. */
  repoPatterns: string[]
  /** Extra workflow rules inserted into the formatting agent's prompt. */
  fixInstructions: string
  /** Whether a non-canonical primary board is offered for automatic formatting. */
  autofix: boolean
  excludeWorktreesOlderThanHours: number
  maxWorktrees: number
  /** Names (besides "owner") that make a blocked row "blocked on you": the person who must decide. */
  ownerNames: string[]
  /** A regular expression removed from the start of an agent name when shown (e.g. a date-stamped prefix). */
  agentPrefixPattern: string
}

export const DEFAULT_CONFIG: BoardConfig = {
  baseBoard: '',
  reposRoot: '',
  repoPatterns: [],
  fixInstructions: '',
  autofix: true,
  excludeWorktreesOlderThanHours: 48,
  maxWorktrees: 50,
  ownerNames: [],
  agentPrefixPattern: '',
}

const text = (v: unknown, d: string) => (typeof v === 'string' ? v.trim() : d)
const list = (v: unknown, split: RegExp) =>
  (typeof v === 'string' ? v : '')
    .split(split)
    .map(s => s.trim())
    .filter(Boolean)
const count = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)

export function readConfig(o: PluginOptions): BoardConfig {
  return {
    baseBoard: text(o.baseBoard, ''),
    reposRoot: text(o.reposRoot, '').replace(/\/$/, ''),
    repoPatterns: list(o.repoPatterns, /[\n;]/),
    fixInstructions: typeof o.fixInstructions === 'string' ? o.fixInstructions.trim() : '',
    autofix: typeof o.autofix === 'boolean' ? o.autofix : DEFAULT_CONFIG.autofix,
    excludeWorktreesOlderThanHours: count(o.excludeWorktreesOlderThanHours, DEFAULT_CONFIG.excludeWorktreesOlderThanHours),
    maxWorktrees: count(o.maxWorktrees, DEFAULT_CONFIG.maxWorktrees),
    ownerNames: list(o.ownerNames, /[\n;,]/),
    agentPrefixPattern: text(o.agentPrefixPattern, ''),
  }
}
