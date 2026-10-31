import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  allKeys,
  canExpand,
  ciPollReason,
  conclusionColor,
  defaultExpanded,
  failedStepNames,
  groupRuns,
  isEnded,
  parseLine,
  parseTrackArg,
  parseWatcherCommands,
  resultKey,
  runKey,
  splitLines,
  summaryOf,
  targetId,
  targetLabel,
  toggleKey,
  treeLines,
  USAGE,
} from './runs'
import type { ActiveRun, FollowLine, Result, Segment, Target } from './runs'

const COMMAND = 'ci-track'
const TICK_MS = 250
const FOLLOW_TIMEOUT = '6h'
const NOTICED_MAX = 300
const AUTO_NOTE = '(Reported automatically by the gh-runs mod; the user did not type this.)'

const targets = atom({ plugin: 'gh-runs', key: 'targets' } as const, [] as Target[])
const active = atom({ plugin: 'gh-runs', key: 'active' } as const, [] as ActiveRun[])
const noticed = atom({ plugin: 'gh-runs', key: 'noticed' } as const, [] as string[])
const results = atom({ plugin: 'gh-runs', key: 'results' } as const, {} as Record<string, Result>)
const frame = atom({ plugin: 'gh-runs', key: 'frame' } as const, 0)
const expanded = atom({ plugin: 'gh-runs', key: 'expanded' } as const, [] as string[])

type Follower = { stop: () => void }

// Handles cannot live in $.state: a reload kills the children, and session.start starts them again.
const followers = new Map<string, Follower>()
const claimed = new Set<string>()
let tick: Timer | undefined

const message = (err: unknown): string => String(err instanceof Error ? err.message : err)

const note = ($: EngineInterface, text: string) => {
  try {
    void Promise.resolve($.ui.status(`gh-runs: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`)).catch(() => undefined)
  } catch {
    /* nothing left to do */
  }
}

const ensureTick = ($: EngineInterface) => {
  if (tick) return
  tick = $.clock.every(TICK_MS, () => {
    void update($, frame, n => n + 1).catch(() => undefined)
  })
}

const stopTickIfIdle = async ($: EngineInterface) => {
  if (!tick || (await read($, targets)).length > 0) return
  tick.cancel()
  tick = undefined
}

// Forgets the expansion of every group, run and job that is no longer in the band.
const pruneExpanded = async ($: EngineInterface) => {
  const ids = new Set(allKeys(groupRuns(await read($, active))))
  await update($, expanded, l => (l.every(id => ids.has(id)) ? l : l.filter(id => ids.has(id))))
}

const toggle = (id: string) => (l: string[]): string[] => toggleKey(l, id)

// Removes a target everywhere: follower, band rows and state.
const drop = async ($: EngineInterface, target: Target, text?: string) => {
  const id = targetId(target)
  const follower = followers.get(id)
  followers.delete(id)
  follower?.stop()
  await update($, targets, l => l.filter(t => targetId(t) !== id))
  await update($, active, l => l.filter(a => targetId(a.target) !== id))
  await pruneExpanded($)
  await stopTickIfIdle($)
  if (text) note($, text)
}

// One result row per run id and attempt, kept in state so a reload does not repeat it.
// The row is placed in the transcript (display only); the model gets the plain summary as a separate row. A failure of either is only noted.
const announce = async ($: EngineInterface, a: ActiveRun, line: FollowLine) => {
  if (claimed.has(a.key)) return
  claimed.add(a.key)
  if ((await read($, noticed)).includes(a.key)) return
  await update($, noticed, l => (l.includes(a.key) ? l : [...l, a.key].slice(-NOTICED_MAX)))
  const key = resultKey(a)
  const summary = summaryOf(a, failedStepNames(a.run, line))
  await update($, results, r => Object.fromEntries(Object.entries({ ...r, [key]: summary }).slice(-NOTICED_MAX)))
  try {
    const placed = await $.ui.place({ id: key })
    if (!placed.isPlaced) note($, `result row: ${placed.reason}`)
  } catch (err) {
    note($, `result row: ${message(err)}`)
  }
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `${summary.text}\n${AUTO_NOTE}` }] } } as never)
  } catch (err) {
    note($, `result text: ${message(err)}`)
  }
}

const apply = async ($: EngineInterface, target: Target, line: FollowLine) => {
  const id = targetId(target)
  const now = await $.clock.now()
  const parsed = Date.parse(line.checkedAt)
  const checkedAt = Number.isNaN(parsed) ? now : parsed
  const live: ActiveRun[] = []
  const ended: ActiveRun[] = []
  for (const run of line.runs) {
    const a: ActiveRun = { key: runKey(run), runId: run.databaseId, attempt: run.attempt ?? 1, target, run, source: line.source, checkedAt, seenAt: now }
    ;(isEnded(run) ? ended : live).push(a)
  }
  const merge = (list: ActiveRun[]): ActiveRun[] => {
    const seen = new Map(list.filter(x => targetId(x.target) === id).map(x => [x.key, x.seenAt]))
    return [...list.filter(x => targetId(x.target) !== id), ...live.map(x => ({ ...x, seenAt: seen.get(x.key) ?? x.seenAt }))]
  }
  // A group that appears is expanded; set before the band can draw it, never during a render.
  const before = await read($, active)
  const known = new Set(groupRuns(before).map(g => g.id))
  const fresh = defaultExpanded(groupRuns(merge(before)).filter(g => !known.has(g.id)))
  if (fresh.length) await update($, expanded, l => [...l, ...fresh.filter(k => !l.includes(k))])
  await update($, active, merge)
  await pruneExpanded($)
  for (const a of ended) await announce($, a, line)
}

const argvFor = (bin: string, t: Target): string[] => [bin, 'follow', '--repo', t.repo, `--${t.kind}`, t.value, '--timeout', FOLLOW_TIMEOUT]

// Reads the child's lines until it exits; every failure ends in dropping the target, never in a throw.
const startFollower = ($: EngineInterface, target: Target, bin: string) => {
  const id = targetId(target)
  if (followers.has(id)) return
  let stopped = false
  let stream: ReturnType<EngineInterface['process']['spawn']> | undefined
  followers.set(id, {
    stop: () => {
      stopped = true
      void stream?.return({ code: null, signal: null }).catch(() => undefined)
    },
  })
  void (async () => {
    let failure: string | undefined
    let lastError = ''
    try {
      stream = $.process.spawn({ argv: argvFor(bin, target) })
      let buffer = ''
      for (;;) {
        const step = await stream.next()
        if (stopped) return
        if (step.done) {
          const code = step.value.code
          if (code === 124) failure = `timed out following ${targetLabel(target)}`
          else if (code !== 0 && code !== 1) failure = `gh-watcher ${code === null ? 'was stopped' : `exited ${code}`} for ${targetLabel(target)}${lastError ? `: ${lastError}` : ''}`
          break
        }
        if (step.value.stream === 'stderr') {
          lastError = step.value.text.trim().split('\n').pop() ?? ''
          continue
        }
        const cut = splitLines(buffer, step.value.text)
        buffer = cut.rest
        for (const text of cut.lines) {
          const line = parseLine(text)
          if (!line) {
            failure = `unreadable gh-watcher output for ${targetLabel(target)}`
            break
          }
          await apply($, target, line)
          if (stopped) return
        }
        if (failure) break
      }
    } catch (err) {
      failure = `could not follow ${targetLabel(target)}: ${message(err)}`
    }
    if (stopped) return
    try {
      await drop($, target, failure)
    } catch (err) {
      note($, message(err))
    }
  })()
}

const bin = (options: unknown): string => {
  const path = (options as { watcherPath?: unknown } | undefined)?.watcherPath
  return typeof path === 'string' && path.trim() !== '' ? path.trim() : 'gh-watcher'
}

// Records a target and starts its follower from a timer, so the child outlives the hook that saw it.
const track = async ($: EngineInterface, target: Target, path: string): Promise<boolean> => {
  let isAdded = false
  await update($, targets, l => {
    isAdded = !l.some(t => targetId(t) === targetId(target))
    return isAdded ? [...l, target] : l
  })
  if (isAdded) {
    ensureTick($)
    $.clock.after(0, () => startFollower($, target, path))
  }
  return isAdded
}

export const register: Register = (on, options) => {
  const path = bin(options)

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: COMMAND, description: 'Track the GitHub Actions runs of a PR or run in the band above the prompt', argumentHint: '[PR or run URL | owner/repo#123 | expand | collapse]' })
      const list = await read($, targets)
      if (list.length) ensureTick($)
      for (const t of list) startFollower($, t, path)
    } catch (err) {
      note($, `session.start: ${message(err)}`)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      for (const f of followers.values()) f.stop()
      followers.clear()
      tick?.cancel()
      tick = undefined
      if (e.reason === 'clear') {
        await update($, targets, () => [])
        await update($, active, () => [])
        await update($, expanded, () => [])
      }
    } catch {
      /* the session is ending anyway */
    }
    return next(e)
  })

  // Guards first: a Bash or Monitor call that polls CI itself is refused with the gh-watcher command to use, before anything is tracked.
  // Otherwise never delays, changes or fails the call: a Bash command is read after the fact and tracked from a timer.
  on('tool.call', ($, e, next) => {
    let reason: string | undefined
    try {
      reason = ciPollReason(e.tool, e)
    } catch {
      /* a line that does not parse is let through */
    }
    if (reason) return { deny: reason }
    if (e.tool === 'Bash') {
      try {
        for (const t of parseWatcherCommands((e as { command: string }).command)) $.clock.after(0, () => void track($, t, path).catch(err => note($, message(err))))
      } catch {
        /* a line that does not parse is skipped */
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    try {
      const arg = e.args.trim()
      if (arg === '') {
        const list = await read($, targets)
        const runs = await read($, active)
        if (!list.length) return { text: `Nothing is tracked. ${USAGE}` }
        return { text: ['Tracking:', ...list.map(t => `- ${targetLabel(t)} (${runs.filter(a => targetId(a.target) === targetId(t)).length} active)`)].join('\n') }
      }
      if (arg === 'expand' || arg === 'collapse') {
        const runs = await read($, active)
        const groups = groupRuns(runs)
        if (arg === 'collapse') await update($, expanded, () => [])
        else await update($, expanded, l => [...new Set([...l, ...allKeys(groups)])])
        if (!runs.length) return { text: 'No active runs.' }
        const g = `${groups.length} group${groups.length === 1 ? '' : 's'}`
        return { text: `${arg === 'expand' ? 'Expanded' : 'Collapsed'} ${g} and ${runs.length} active run${runs.length === 1 ? '' : 's'}.` }
      }
      const target = parseTrackArg(arg)
      if (!target) return { text: USAGE }
      const isAdded = await track($, target, path)
      return { text: `${isAdded ? 'Tracking' : 'Already tracking'} ${targetLabel(target)}.` }
    } catch (err) {
      note($, `command: ${message(err)}`)
      return { text: `/${COMMAND} failed: ${message(err)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) return next(e)
      const list = await read($, active)
      if (!list.length || !(await read($, targets)).length) return next(e)
      const now = await $.clock.now()
      const f = await read($, frame)
      const drawn = await Promise.resolve(next(e)).catch(() => null)
      const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
      const open = await read($, expanded)
      const { Box, Button, Link, Text } = $.ui.resolve(e)
      const columns = e.props.bodyColumns
      const lines = treeLines(groupRuns(list), open, now, f, columns, canExpand(e.viewport?.rows))
      const paint = (segs: Segment[]) =>
        segs.map(s => {
          const t = (
            <Text key={s.id} {...(s.color ? { color: s.color } : {})} {...(s.dim ? { dimColor: true } : {})} {...(s.bold ? { bold: true } : {})}>
              {s.text}
            </Text>
          )
          return s.href ? (
            <Link key={s.id} href={s.href}>
              {t}
            </Link>
          ) : (
            t
          )
        })
      return (
        <Box flexDirection="column">
          {lines.map(l => (
            <Box key={`line:${l.id}`}>
              {l.indent > 0 ? <Text>{' '.repeat(l.indent)}</Text> : null}
              {l.kind === 'step' || l.kind === 'more' ? null : l.toggle ? (
                <Button key={`expand:${l.toggle}`} plain onPress={() => void update($, expanded, toggle(l.toggle as string)).catch(() => undefined)}>
                  {l.isOpen ? '▾' : '▸'}
                </Button>
              ) : (
                <Text>{'  '}</Text>
              )}
              <Text wrap="truncate-end">{l.kind === 'step' || l.kind === 'more' || !l.toggle ? null : ' '}{paint(l.segs)}</Text>
            </Box>
          ))}
          {below}
        </Box>
      )
    } catch (err) {
      note($, `band: ${message(err)}`)
      return next(e)
    }
  })

  // Draws the placed result row; a row of another plugin, or an id the state does not know, is left to the engine.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    try {
      if (e.props.plugin !== 'gh-runs') return next(e)
      const r = (await read($, results))[e.props.id]
      if (!r) return next(e)
      const { Box, Link, Text } = $.ui.resolve(e)
      const look = conclusionColor(r.conclusion)
      const tone = { ...(look.color ? { color: look.color } : {}), ...(look.dim ? { dimColor: true } : {}) }
      const width = e.viewport?.columns
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={look.color ?? 'inactive'} paddingX={1} {...(width ? { width: Math.max(20, width - 2) } : {})}>
          <Text wrap="wrap">
            <Text bold {...tone}>{r.conclusion.toUpperCase()}</Text>
            <Text {...(look.dim ? { dimColor: true } : {})}>{'  '}</Text>
            {r.url ? (
              <Link href={r.url}>
                <Text {...(look.dim ? { dimColor: true } : {})}>{r.workflow}</Text>
              </Link>
            ) : (
              <Text {...(look.dim ? { dimColor: true } : {})}>{r.workflow}</Text>
            )}
            <Text {...(look.dim ? { dimColor: true } : {})}>{`  ${r.target}  ${r.duration}`}</Text>
          </Text>
          {r.failed.length ? <Text wrap="wrap" dimColor>{`failed: ${r.failed.join(', ')}`}</Text> : null}
          {r.url ? (
            <Text wrap="wrap">
              <Link href={r.url}>{r.url}</Link>
            </Text>
          ) : null}
        </Box>
      )
    } catch (err) {
      note($, `result: ${message(err)}`)
      return next(e)
    }
  }).catch(($, e, next) => next(e))
}
