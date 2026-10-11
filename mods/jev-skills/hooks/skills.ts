export type Skill = { name: string; description: string }
export type Question = { type: 'noul'; instructions: string }
export type JevAsker = (state: object, questions: Record<string, Question>) => Promise<Record<string, number>>

export type Config = {
  enabled: boolean
  maxPicks: number
  minScore: number
  recentPrompts: number
  jevTimeoutMs: number
  promptTimeoutMs: number
  maxRequestTokens: number
  maxBatches: number
  model: string
  keyFile: string
}

export const DEFAULTS: Config = {
  enabled: true,
  maxPicks: 5,
  minScore: 0.3,
  recentPrompts: 3,
  jevTimeoutMs: 6000,
  promptTimeoutMs: 3000,
  maxRequestTokens: 28_000,
  maxBatches: 3,
  model: 'jev-latest',
  keyFile: '',
}

export function resolveConfig(options: Readonly<Record<string, unknown>>): Config {
  const out: Record<string, string | number | boolean> = { ...DEFAULTS }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = options[key]
    if (typeof fallback === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    } else if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') out[key] = value
    } else if (typeof value === 'string' && value !== '') out[key] = value
  }
  const c = out as Config
  return { ...c, maxPicks: Math.max(1, Math.floor(c.maxPicks)), minScore: Math.min(1, Math.max(0, c.minScore)), recentPrompts: Math.max(0, Math.floor(c.recentPrompts)), maxBatches: Math.max(1, Math.floor(c.maxBatches)) }
}

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g

/** Estimates tokens without a tokenizer: a word costs one token per six letters, a digit half, any other symbol nine tenths. */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0)
    if (first >= 48 && first <= 57) tokens += piece.length / 2
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) tokens += 1 + Math.floor((piece.length - 1) / 6)
    else tokens += 0.9
  }
  return Math.ceil(tokens)
}

export const LISTING_HEADER = 'The following skills are available for use with the Skill tool:'
export const OTHER_SKILLS =
  'Other installed skills are not listed here to save context. If a task needs one that is not listed, call the Skill tool with its exact name; the user can also run any skill as /<name>.'
const DESCRIPTION_CHARS = 300

/**
 * The `- name: description` lines of the engine's listing. A line may carry the name alone (budget-trimmed), an alias in
 * parentheses after the name (dropped), and a description that continues on the following non-blank lines.
 */
export function parseListing(text: string): Skill[] {
  const out: Skill[] = []
  let open = false
  for (const line of text.split(/\r?\n/)) {
    const match = /^- (\S+?)(?: \([^)]*\))?(?::\s+(.*))?\s*$/.exec(line)
    if (match) {
      out.push({ name: match[1] as string, description: (match[2] ?? '').trim() })
      open = true
    } else if (open && line.trim() !== '' && line !== LISTING_HEADER) {
      const last = out[out.length - 1] as Skill
      last.description = `${last.description} ${line.trim()}`.trim()
    } else open = false
  }
  return out
}

const HIDDEN_NAME_TOKENS = 1000

/** Comma-separated names that fit the token budget, and how many were left out. */
export function hiddenNames(names: readonly string[], budget = HIDDEN_NAME_TOKENS): { text: string; omitted: number } {
  const kept: string[] = []
  let used = 0
  for (const n of names) {
    const cost = estimateTokens(n) + 1
    if (used + cost > budget) break
    kept.push(n)
    used += cost
  }
  return { text: kept.join(', '), omitted: names.length - kept.length }
}

export function formatListing(picks: readonly Skill[], hidden: readonly string[] = []): string {
  const lines = picks.map((s) => (s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`))
  const names = hiddenNames(hidden)
  const index = names.text ? [`Other skills (names only): ${names.text}${names.omitted > 0 ? `, and ${names.omitted} more` : ''}.`] : []
  return [LISTING_HEADER, '', ...lines, ...(lines.length > 0 ? [''] : []), OTHER_SKILLS, ...index].join('\n')
}

/** Context for a later prompt: skills picked for it that the model has not been shown yet. */
export function formatAddition(picks: readonly Skill[]): string {
  return ['Skills that fit this request, also available with the Skill tool:', ...picks.map((s) => (s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`))].join('\n')
}

const ACKNOWLEDGEMENT = /^(?:yes|yep|no|nope|ok|okay|k|sure|continue|go on|go ahead|proceed|do it|thanks|thank you|thx|done|stop|retry|again)\W*$/i

/** Slash commands, very short prompts and bare acknowledgements get no shortlist. */
export function skipPrompt(text: string): boolean {
  const t = text.trim()
  return t.startsWith('/') || t.length < 12 || ACKNOWLEDGEMENT.test(t)
}

const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`)

export function buildState(prompt: string, recent: readonly string[]): object {
  return { user_request: clip(prompt, 4000), earlier_user_requests: recent.filter((t) => t.trim() !== '').map((t) => clip(t, 500)) }
}

export function instructionsFor(skill: Skill): string {
  const about = skill.description ? ` (${clip(skill.description, DESCRIPTION_CHARS)})` : ''
  return `The user's current request needs the skill "${skill.name}"${about}: loading it would clearly help with this request, more than answering without it`
}

const WORD = /[a-z0-9]{3,}/g
const words = (text: string) => new Set(text.toLowerCase().match(WORD) ?? [])

/** Skills ordered by how many words their name and description share with the prompt, most first (stable). */
export function byOverlap(skills: readonly Skill[], prompt: string): Skill[] {
  const wanted = words(prompt)
  const score = (s: Skill) => [...words(`${s.name} ${s.description}`)].filter((w) => wanted.has(w)).length
  return skills.map((s, i) => ({ s, i, n: score(s) })).sort((a, b) => b.n - a.n || a.i - b.i).map((x) => x.s)
}

export type Batches = { batches: Skill[][]; unscored: number }

/**
 * Splits skills into requests that each fit `maxRequestTokens` with the state. More than `maxBatches` requests
 * keeps the best keyword matches for the prompt and leaves the rest unscored.
 */
export function planBatches(skills: readonly Skill[], state: object, prompt: string, maxRequestTokens: number, maxBatches: number): Batches {
  const base = estimateTokens(JSON.stringify({ model: 'jev-latest', state, questions: {} }))
  const cost = (s: Skill, i: number) => estimateTokens(JSON.stringify({ [`s${i}`]: { type: 'noul', instructions: instructionsFor(s) } })) + 1
  const fit = (list: readonly Skill[]) => {
    const batches: Skill[][] = []
    let current: Skill[] = []
    let used = base
    for (const [i, s] of list.entries()) {
      const c = cost(s, i)
      if (current.length > 0 && used + c > maxRequestTokens) {
        batches.push(current)
        current = []
        used = base
      }
      current.push(s)
      used += c
    }
    if (current.length > 0) batches.push(current)
    return batches
  }
  let batches = fit(skills)
  if (batches.length <= maxBatches) return { batches, unscored: 0 }
  batches = fit(byOverlap(skills, prompt)).slice(0, maxBatches)
  return { batches, unscored: skills.length - batches.reduce((n, b) => n + b.length, 0) }
}

export type Scored = { scores: Map<string, number>; requests: number; unscored: number }

/** One Jev request per batch, in parallel. A failed batch leaves its skills unscored; every batch failing is an error. */
export async function scoreSkills(ask: JevAsker, skills: readonly Skill[], prompt: string, recent: readonly string[], config: Pick<Config, 'maxRequestTokens' | 'maxBatches'>): Promise<Scored> {
  const state = buildState(prompt, recent)
  const plan = planBatches(skills, state, prompt, config.maxRequestTokens, config.maxBatches)
  const results = await Promise.allSettled(
    plan.batches.map((batch) => ask(state, Object.fromEntries(batch.map((s, i) => [`s${i}`, { type: 'noul' as const, instructions: instructionsFor(s) }])))),
  )
  const scores = new Map<string, number>()
  let failed = 0
  let unscored = plan.unscored
  results.forEach((r, b) => {
    const batch = plan.batches[b] as Skill[]
    if (r.status === 'fulfilled') batch.forEach((s, i) => scores.set(s.name, r.value[`s${i}`] as number))
    else {
      failed++
      unscored += batch.length
    }
  })
  if (plan.batches.length > 0 && failed === plan.batches.length) {
    const first = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    throw first?.reason instanceof Error ? first.reason : new Error(String(first?.reason))
  }
  return { scores, requests: plan.batches.length, unscored }
}

/** At most `maxPicks` skills at or above `minScore`, best first. */
export function selectPicks(scores: ReadonlyMap<string, number>, skills: readonly Skill[], minScore: number, maxPicks: number): Skill[] {
  const byName = new Map(skills.map((s) => [s.name, s]))
  return [...scores]
    .filter(([name, p]) => p >= minScore && byName.has(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxPicks)
    .map(([name]) => byName.get(name) as Skill)
}

export const topScores = (scores: ReadonlyMap<string, number>, n = 5): [string, number][] =>
  [...scores].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, p]) => [name, Math.round(p * 100) / 100])
