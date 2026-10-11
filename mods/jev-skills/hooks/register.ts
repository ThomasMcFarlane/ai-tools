import type { EngineInterface, Register } from 'claude-code'

import { jevAsker } from './jev'
import { DEFAULT_KEY_FILE, keyFromFile, redact } from './key'
import { DEFAULTS, estimateTokens, formatAddition, formatListing, parseListing, resolveConfig, scoreSkills, selectPicks, skipPrompt, topScores } from './skills'
import type { Config, Skill } from './skills'

const ENABLED = { plugin: 'jev-skills', key: 'enabled' } as const
const ROSTER = { plugin: 'jev-skills', key: 'roster' } as const
const SHOWN = { plugin: 'jev-skills', key: 'shown' } as const
const REPLACED = { plugin: 'jev-skills', key: 'replaced' } as const
const RECENT = { plugin: 'jev-skills', key: 'recent' } as const
const LAST = { plugin: 'jev-skills', key: 'last' } as const
const FAILS = { plugin: 'jev-skills', key: 'fails' } as const
const STATS = { plugin: 'jev-skills', key: 'stats' } as const

const NO_STATS = { listings: 0, prompts: 0, requests: 0, failures: 0, added: 0, used: 0, usedShortlisted: 0, tokensBefore: 0, tokensAfter: 0 }
// The person's own prompts: only these are Jev's context and get skills added.
const OWN_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
const MAX_RECENT = 8
const FAIL_LIMIT = 2
const BACKOFF_MS = 30 * 60_000
const USAGE = 'Usage: /jev-skills on | off | why | stats'

let config: Config = DEFAULTS
// Kept in module memory once found; a missing key is looked for again next time.
let cachedKey: string | undefined

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Environment `JEV_COMPACTION_API_KEY`, then `TYPESAFE_API_KEY`, then the key file. */
async function resolveKey($: EngineInterface): Promise<string | undefined> {
  if (cachedKey) return cachedKey
  const fromEnv = (await $.env.get('JEV_COMPACTION_API_KEY')) || (await $.env.get('TYPESAFE_API_KEY'))
  if (fromEnv) return (cachedKey = fromEnv)
  let path = config.keyFile
  if (!path) {
    const home = await $.env.get('HOME')
    if (!home) return undefined
    path = `${home.replace(/\/+$/, '')}/${DEFAULT_KEY_FILE}`
  }
  try {
    return (cachedKey = keyFromFile(await $.fs.read(path)))
  } catch {
    return undefined
  }
}

/**
 * One Jev request, abandoned with an error after `ms`: `$.http.fetch` has no timeout and cannot be cancelled, so
 * the request is only left behind. The timeout is a `$.clock.after` timer, not a `$.clock.sleep`: a clock wait counts
 * against the hook's 10 s budget, a `$` call in flight does not.
 */
async function fetchWithin($: EngineInterface, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } | undefined, ms: number) {
  let timer: { cancel: () => void } | undefined
  const late = new Promise<never>((_, reject) => {
    timer = $.clock.after(ms, () => reject(new Error(`Jev request timed out after ${ms} ms`)))
  })
  late.catch(() => undefined)
  try {
    return await Promise.race([$.http.fetch(url, init), late])
  } finally {
    timer?.cancel()
  }
}

const isEnabled = async ($: EngineInterface) => (await $.state.get(ENABLED)).value ?? config.enabled

async function bump($: EngineInterface, change: Partial<typeof NO_STATS>) {
  const { value = NO_STATS } = await $.state.get(STATS)
  const next = { ...NO_STATS, ...value }
  for (const [name, by] of Object.entries(change)) next[name as keyof typeof NO_STATS] += by
  await $.state.set(STATS, next)
}

type Judged = { picks: Skill[]; requests: number; unscored: number }

/** Scores `candidates` for the prompt and records the judgement; throws when Jev cannot answer. */
async function judge($: EngineInterface, at: 'listing' | 'prompt', candidates: readonly Skill[], prompt: string, earlier: readonly string[]): Promise<Judged> {
  const key = await resolveKey($)
  if (!key) throw new Error('no Jev API key (environment or key file)')
  const ask = jevAsker(
    async (url, init) => {
      const r = await fetchWithin($, url, init, at === 'listing' ? config.jevTimeoutMs : config.promptTimeoutMs)
      return { status: r.status, ok: r.ok, text: r.text }
    },
    key,
    config.model,
  )
  try {
    const { scores, requests, unscored } = await scoreSkills(ask, candidates, prompt, earlier.slice(-config.recentPrompts), config)
    const picks = selectPicks(scores, candidates, config.minScore, config.maxPicks)
    await $.state.set(FAILS, { count: 0, until: 0 })
    await $.state.set(LAST, { at, prompt: prompt.slice(0, 120), top: topScores(scores), picks: picks.map((s) => s.name), requests, unscored })
    return { picks, requests, unscored }
  } catch (err) {
    throw new Error(redact(message(err), key))
  }
}

async function failed($: EngineInterface, at: 'listing' | 'prompt', prompt: string, reason: string) {
  $.ui.log(`jev-skills: ${at} left as it is (${reason})`)
  await $.state.set(LAST, { at, prompt: prompt.slice(0, 120), top: [], picks: [], requests: 0, unscored: 0, failed: reason })
  await bump($, { failures: 1 })
  const { value } = await $.state.get(FAILS)
  const count = (value?.count ?? 0) + 1
  await $.state.set(FAILS, { count, until: count >= FAIL_LIMIT ? Date.now() + BACKOFF_MS : 0 })
}

const pausedNow = async ($: EngineInterface) => ((await $.state.get(FAILS)).value?.until ?? 0) > Date.now()

const toSkills = (roster: Record<string, string>): Skill[] => Object.entries(roster).map(([name, description]) => ({ name, description }))

// The engine's first listing of a process is the full one; later ones are deltas (new skills) or partial repeats.
// The roster only grows. Only a listing that covers the whole roster is a true re-send and is shortlisted afresh.
async function onListing($: EngineInterface, e: { text: string; agentId?: string }, next: (e: never) => Promise<unknown>) {
  if (e.agentId !== undefined || !(await isEnabled($))) return next(e as never)
  const listed = parseListing(e.text)
  if (listed.length === 0) return next(e as never)
  const { value: known = {} } = await $.state.get(ROSTER)
  const { value: replaced = false } = await $.state.get(REPLACED)
  const roster = { ...known, ...Object.fromEntries(listed.map((s) => [s.name, s.description])) }
  await $.state.set(ROSTER, roster)
  const seen = new Set(listed.map((s) => s.name))
  if (replaced && !Object.keys(known).every((n) => seen.has(n))) {
    // A delta or a partial repeat: it goes through as it is, at the tail, so the model sees its skills.
    const { value: shown = [] } = await $.state.get(SHOWN)
    await $.state.set(SHOWN, [...new Set([...shown, ...seen])])
    return next(e as never)
  }
  await $.state.set(SHOWN, [])
  await $.state.set(REPLACED, false)
  const { value: recent = [] } = await $.state.get(RECENT)
  const prompt = recent[recent.length - 1] ?? ''
  if (skipPrompt(prompt) || (await pausedNow($))) return next(e as never)
  try {
    const all = toSkills(roster)
    const { picks, requests } = await judge($, 'listing', all, prompt, recent.slice(0, -1))
    const chosen = new Set(picks.map((s) => s.name))
    const text = formatListing(picks, all.filter((s) => !chosen.has(s.name)).map((s) => s.name))
    await $.state.set(SHOWN, [...chosen])
    await $.state.set(REPLACED, true)
    await bump($, { listings: 1, requests, tokensBefore: estimateTokens(e.text), tokensAfter: estimateTokens(text) })
    return { text }
  } catch (err) {
    await failed($, 'listing', prompt, message(err))
    return next(e as never)
  }
}

// A later prompt can need a skill the session listing left out. Its picks ride on that prompt, at the tail of the
// conversation, so nothing before it changes and the cached history stays valid. The set only grows until a compaction.
async function onSubmit($: EngineInterface, e: { text: string; origin: { kind: string }; context?: readonly string[] }) {
  if (!OWN_ORIGINS.has(e.origin.kind) || e.text.trim().startsWith('/')) return undefined
  const { value: recent = [] } = await $.state.get(RECENT)
  await $.state.set(RECENT, [...recent, e.text].slice(-MAX_RECENT))
  if (!(await isEnabled($)) || !(await $.state.get(REPLACED)).value || skipPrompt(e.text)) return undefined
  const { value: roster = {} } = await $.state.get(ROSTER)
  const { value: shown = [] } = await $.state.get(SHOWN)
  const candidates = toSkills(roster).filter((s) => !shown.includes(s.name))
  if (candidates.length === 0 || (await pausedNow($))) return undefined
  try {
    const { picks, requests } = await judge($, 'prompt', candidates, e.text, recent)
    await bump($, { prompts: 1, requests, added: picks.length })
    if (picks.length === 0) return undefined
    await $.state.set(SHOWN, [...shown, ...picks.map((s) => s.name)])
    return formatAddition(picks)
  } catch (err) {
    await failed($, 'prompt', e.text, message(err))
    return undefined
  }
}

async function onCommand($: EngineInterface, args: string) {
  const word = args.trim().split(/\s+/)[0] ?? ''
  if (word === 'on' || word === 'off') {
    await $.state.set(ENABLED, word === 'on')
    return { text: `${word}. The session's skill listing changes only when the engine builds it again (a new session or a compaction); later prompts follow the new setting at once.` }
  }
  if (word === 'why') {
    const { value: last } = await $.state.get(LAST)
    if (!last) return { text: 'nothing judged yet in this session' }
    const { value: shown = [] } = await $.state.get(SHOWN)
    const { value: roster = {} } = await $.state.get(ROSTER)
    const lines = [
      `Last judgement (${last.at === 'listing' ? 'session listing' : 'later prompt'}): "${last.prompt}"`,
      `Shortlisted: ${last.picks.join(', ') || 'none'}`,
      `Best scores: ${last.top.map(([n, p]) => `${n} ${p}`).join(', ') || 'none'}`,
      `Jev requests: ${last.requests}, skills left unscored: ${last.unscored}`,
      ...(last.failed ? [`Failed: ${last.failed}`] : []),
      `Visible to the model: ${shown.length} of ${Object.keys(roster).length} skills`,
    ]
    return { text: lines.join('\n') }
  }
  if (word === 'stats') {
    const { value } = await $.state.get(STATS)
    const s = { ...NO_STATS, ...value }
    const lines = [
      `${(await isEnabled($)) ? 'on' : 'off'}`,
      `Listings replaced: ${s.listings} (~${s.tokensBefore} tokens became ~${s.tokensAfter})`,
      `Later prompts judged: ${s.prompts}, skills added: ${s.added}`,
      `Jev requests: ${s.requests}, failures: ${s.failures}`,
      `Skills used: ${s.used}, of them shortlisted: ${s.usedShortlisted}`,
    ]
    return { text: lines.join('\n') }
  }
  return { text: `${(await isEnabled($)) ? 'on' : 'off'}\n${USAGE}` }
}

export const register: Register = (on, options) => {
  config = resolveConfig(options)
  cachedKey = undefined
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'jev-skills', description: 'Jev skill shortlist: on, off, why, stats', argumentHint: 'on | off | why | stats' })
    } catch (err) {
      $.ui.log(`jev-skills: command not registered: ${message(err)}`)
    }
    return next(e)
  })
  // /clear ends the conversation and the process goes on without a new session.start.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await $.state.set(REPLACED, false)
      await $.state.set(SHOWN, [])
      await $.state.set(RECENT, [])
    }
    return next(e)
  })
  on('prompt.attachment', { type: 'skill_listing' }, ($, e, next) =>
    onListing($, e, next as never).catch((err) => {
      $.ui.log(`jev-skills: listing left as it is (${message(err)})`)
      return next(e)
    }) as never,
  )
  on('prompt.submit', async ($, e, next) => {
    const extra = await onSubmit($, e).catch((err) => {
      $.ui.log(`jev-skills: prompt left as it is (${message(err)})`)
      return undefined
    })
    return next(extra ? { ...e, context: [...(e.context ?? []), extra] } : e)
  })
  // After a compaction the model no longer sees what earlier prompts added.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in result && result.skip)) await $.state.set(SHOWN, [])
    return result
  })
  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    const { value: shown = [] } = await $.state.get(SHOWN)
    const listed = shown.includes(e.skill) || shown.some((n) => n.endsWith(`:${e.skill}`))
    await bump($, { used: 1, usedShortlisted: listed ? 1 : 0 })
    return result
  })
  on('command.run', { command: 'jev-skills' }, ($, e) => onCommand($, e.args))
}
