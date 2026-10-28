export type Config = { reminderEvery: number; shortenAfterCompact: boolean }

export const DEFAULTS: Config = { reminderEvery: 10, shortenAfterCompact: true }

export function resolveConfig(options: Record<string, unknown> | undefined): Config {
  const every = Number(options?.reminderEvery)
  return {
    reminderEvery: Number.isFinite(every) && every >= 1 ? Math.floor(every) : DEFAULTS.reminderEvery,
    shortenAfterCompact: typeof options?.shortenAfterCompact === 'boolean' ? options.shortenAfterCompact : DEFAULTS.shortenAfterCompact,
  }
}

// The caveman tracker's per-prompt reminder; it is always the last paragraph of its context.
const REMINDER = /(^|\n\n)CAVEMAN MODE ACTIVE \([^)\n]*\)\. [^\n]*$/

/** The context with the caveman reminder taken out; null when nothing else was in it. */
export function dropReminder(context: string): string | null {
  // A mode switch carries the new ruleset; that turn keeps everything.
  if (context.includes('CAVEMAN MODE ACTIVE — mode:')) return context
  const rest = context.replace(REMINDER, '')
  return rest.trim() ? rest : null
}

export const keepReminder = (prompt: number, every: number, compacted: boolean) => compacted || every <= 1 || prompt % every === 1

/** A line or two in place of a known SessionStart text; null for anything else. */
export function shortStart(text: string): string | null {
  const caveman = /^CAVEMAN MODE ACTIVE — mode: (\S+)/.exec(text)
  if (caveman) {
    return `CAVEMAN MODE ACTIVE — mode: ${caveman[1]}. Respond terse like smart caveman: answer first, no filler, every technical fact, code, path and error exact; plain prose for warnings, irreversible steps and anything persisted. Full rules: the caveman skill. Off: "stop caveman" or "normal mode".`
  }
  const ponytail = /^PONYTAIL MODE ACTIVE — level: (\S+)/.exec(text)
  if (ponytail) {
    return `PONYTAIL MODE ACTIVE — level: ${ponytail[1]}. Make the smallest change that fully solves the task, reuse what exists, and end each reply with one or two lines on what you skipped and any risk. Full rules: the ponytail skill.`
  }
  if (/^<EXTREMELY_IMPORTANT>\s*You have superpowers\./.test(text)) {
    return 'You have superpowers: before any response or action, check whether a skill applies and, if one does, invoke it with the Skill tool. Full rules: the superpowers:using-superpowers skill.'
  }
  return null
}

const COMPACT_SUCCESS = 'SessionStart:compact hook success: '

/** The shortened text of a post-compaction SessionStart hook output attachment; null to leave it as it is. */
export function shortCompactOutput(text: string): string | null {
  if (!text.startsWith(COMPACT_SUCCESS)) return null
  const short = shortStart(text.slice(COMPACT_SUCCESS.length))
  return short === null ? null : COMPACT_SUCCESS + short
}
