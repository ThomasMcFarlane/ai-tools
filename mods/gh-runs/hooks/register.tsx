import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  conclusionColor,
  failedStepNames,
  fitSegments,
  isEnded,
  noticeText,
  parseLine,
  parseNotice,
  parseTrackArg,
  parseWatcherCommands,
  rowSegments,
  runKey,
  splitLines,
  targetId,
  targetLabel,
  USAGE,
} from './runs'
import type { ActiveRun, FollowLine, Target } from './runs'

const COMMAND = 'ci-track'
const TICK_MS = 250
const FOLLOW_TIMEOUT = '6h'
const NOTICED_MAX = 300

const targets = atom({ plugin: 'gh-runs', key: 'targets' } as const, [] as Target[])
const active = atom({ plugin: 'gh-runs', key: 'active' } as const, [] as ActiveRun[])
const noticed = atom({ plugin: 'gh-runs', key: 'noticed' } as const, [] as string[])
const frame = atom({ plugin: 'gh-runs', key: 'frame' } as const, 0)

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

// Removes a target everywhere: follower, band rows and state.
const drop = async ($: EngineInterface, target: Target, text?: string) => {
  const id = targetId(target)
  const follower = followers.get(id)
  followers.delete(id)
  follower?.stop()
  await update($, targets, l => l.filter(t => targetId(t) !== id))
  await update($, active, l => l.filter(a => targetId(a.target) !== id))
  await stopTickIfIdle($)
  if (text) note($, text)
}

// One chat item per run id and attempt, kept in state so a reload does not repeat it.
const announce = async ($: EngineInterface, a: ActiveRun, line: FollowLine) => {
  if (claimed.has(a.key)) return
  claimed.add(a.key)
  if ((await read($, noticed)).includes(a.key)) return
  await update($, noticed, l => (l.includes(a.key) ? l : [...l, a.key].slice(-NOTICED_MAX)))
  const text = noticeText(a, failedStepNames(a.run, line))
  const result = await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
  if (result && 'deny' in result && result.deny) note($, `chat item refused: ${String(result.deny)}`)
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
  await update($, active, list => {
    const seen = new Map(list.filter(x => targetId(x.target) === id).map(x => [x.key, x.seenAt]))
    return [...list.filter(x => targetId(x.target) !== id), ...live.map(x => ({ ...x, seenAt: seen.get(x.key) ?? x.seenAt }))]
  })
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
      await $.command.register({ name: COMMAND, description: 'Track the GitHub Actions runs of a PR or run in the band above the prompt', argumentHint: '[PR or run URL | owner/repo#123]' })
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
      }
    } catch {
      /* the session is ending anyway */
    }
    return next(e)
  })

  // Never delays, changes or fails the call: the command is read after the fact and tracked from a timer.
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    try {
      for (const t of parseWatcherCommands(e.command)) $.clock.after(0, () => void track($, t, path).catch(err => note($, message(err))))
    } catch {
      /* a line that does not parse is skipped */
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
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {list.map(a => (
            <Text key={`run:${a.key}:${targetId(a.target)}`} wrap="truncate-end">
              {fitSegments(rowSegments(a, now, f), e.props.bodyColumns).map(s => (
                <Text key={s.id} {...(s.color ? { color: s.color } : {})} {...(s.dim ? { dimColor: true } : {})} {...(s.bold ? { bold: true } : {})}>
                  {s.text}
                </Text>
              ))}
            </Text>
          ))}
          {below}
        </Box>
      )
    } catch (err) {
      note($, `band: ${message(err)}`)
      return next(e)
    }
  })

  // Colours this mod's chat items only; every other notice goes through untouched.
  on('ui.render', { component: 'InfoNotice' }, async ($, e, next) => {
    try {
      const n = parseNotice(e.props.text)
      if (!n) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      const look = conclusionColor(n.conclusion)
      const tone = { ...(look.color ? { color: look.color } : {}), ...(look.dim ? { dimColor: true } : {}) }
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={look.color ?? 'inactive'} paddingX={1}>
          <Text wrap="wrap">
            <Text bold {...tone}>{n.conclusion.toUpperCase()}</Text>
            <Text {...(look.dim ? { dimColor: true } : {})}>{`  ${n.head}`}</Text>
          </Text>
          {n.failed ? <Text wrap="wrap" color="error">{`failed: ${n.failed}`}</Text> : null}
          {n.url ? <Text wrap="wrap" dimColor>{n.url}</Text> : null}
        </Box>
      )
    } catch (err) {
      note($, `notice: ${message(err)}`)
      return next(e)
    }
  })
}
