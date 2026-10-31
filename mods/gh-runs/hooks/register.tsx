import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  canExpand,
  conclusionColor,
  detailLines,
  expandKey,
  failedStepNames,
  fitSegments,
  isEnded,
  parseLine,
  parseTrackArg,
  parseWatcherCommands,
  resultFromText,
  resultKey,
  RESULT_COMMAND,
  rowSegments,
  runKey,
  splitLines,
  summaryOf,
  targetId,
  targetLabel,
  USAGE,
} from './runs'
import type { ActiveRun, FollowLine, Result, Segment, Target } from './runs'

const COMMAND = 'ci-track'
const TICK_MS = 250
const FOLLOW_TIMEOUT = '6h'
const NOTICED_MAX = 300
const RESULT_HINT = 'Internal: gh-runs result row'

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
// The key of the last ci-result run seen at append: its output row follows the echo row.
let lastKey: string | undefined

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

// Forgets the expansion of every run that is no longer in the band.
const pruneExpanded = async ($: EngineInterface) => {
  const ids = new Set((await read($, active)).map(expandKey))
  await update($, expanded, l => (l.every(id => ids.has(id)) ? l : l.filter(id => ids.has(id))))
}

const toggle = (id: string) => (l: string[]): string[] => (l.includes(id) ? l.filter(x => x !== id) : [...l, id])

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
// The command runs from a timer: the engine queues it until idle, and a refusal is only noted.
const announce = async ($: EngineInterface, a: ActiveRun, line: FollowLine) => {
  if (claimed.has(a.key)) return
  claimed.add(a.key)
  if ((await read($, noticed)).includes(a.key)) return
  await update($, noticed, l => (l.includes(a.key) ? l : [...l, a.key].slice(-NOTICED_MAX)))
  const key = resultKey(a)
  const summary = summaryOf(a, failedStepNames(a.run, line))
  await update($, results, r => Object.fromEntries(Object.entries({ ...r, [key]: summary }).slice(-NOTICED_MAX)))
  $.clock.after(0, () => {
    try {
      void Promise.resolve($.command.run({ command: RESULT_COMMAND, args: key })).catch(err => note($, `result row: ${message(err)}`))
    } catch (err) {
      note($, `result row: ${message(err)}`)
    }
  })
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
      await $.command.register({ name: RESULT_COMMAND, description: RESULT_HINT, immediate: true })
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
      if (arg === 'expand' || arg === 'collapse') {
        const runs = await read($, active)
        if (arg === 'collapse') await update($, expanded, () => [])
        else await update($, expanded, l => [...new Set([...l, ...runs.map(expandKey)])])
        if (!runs.length) return { text: 'No active runs.' }
        return { text: `${arg === 'expand' ? 'Expanded' : 'Collapsed'} ${runs.length} active run${runs.length === 1 ? '' : 's'}.` }
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
      const isTall = canExpand(e.viewport?.rows)
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
          {list.map(a => {
            const id = expandKey(a)
            const isOpen = open.includes(id)
            const rowKey = `${a.key}:${targetId(a.target)}`
            return (
              <Box key={`run:${rowKey}`} flexDirection="column">
                <Box>
                  <Button key={`expand:${rowKey}`} plain onPress={() => void update($, expanded, toggle(id)).catch(() => undefined)}>
                    {isOpen ? '▾' : '▸'}
                  </Button>
                  <Text wrap="truncate-end">{` `}{paint(fitSegments(rowSegments(a, now, f), columns - 2))}</Text>
                </Box>
                {isOpen && isTall
                  ? detailLines(a.run, columns, f).map((segs, i) => (
                      <Text key={`detail:${rowKey}:${i}`} wrap="truncate-end">
                        {paint(segs)}
                      </Text>
                    ))
                  : null}
              </Box>
            )
          })}
          {below}
        </Box>
      )
    } catch (err) {
      note($, `band: ${message(err)}`)
      return next(e)
    }
  })

  // Draws the result row in place of the engine's text; a missing summary (after /clear) shows the stored text.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    try {
      if (e.props.command !== RESULT_COMMAND) return next(e)
      const { Box, Link, Text } = $.ui.resolve(e)
      const all = await read($, results)
      const r = all[e.props.args.trim()] ?? resultFromText(all, e.props.text)
      if (!r) return <Text wrap="wrap">{e.props.text}</Text>
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
  })

  // The engine words an unanswered command's output itself; the model reads the plain summary instead.
  // The row keeps its `<local-command-stdout>` wrapper: only the inner text changes, or the row is no longer a command output.
  on('session.append', { door: 'command' }, async ($, e, next) => {
    try {
      const blocks = e.message.content
      const raw = typeof blocks === 'string' ? blocks : blocks.map(b => (b.type === 'text' ? b.text : '')).join('\n')
      const args = /<command-args>([^<]*)<\/command-args>/.exec(raw)
      if (args && raw.includes(`<command-name>/${RESULT_COMMAND}<`)) {
        lastKey = (args[1] ?? '').trim()
        return next(e)
      }
      if (!raw.includes('no command.run hook answered') || !raw.includes(RESULT_COMMAND)) return next(e)
      const found = lastKey ? (await read($, results))[lastKey] : undefined
      const plain = found?.text ?? '[gh-runs] a run ended. See /ci-track.'
      const wrapper = /<local-command-(stdout|stderr)>[\s\S]*<\/local-command-\1>/.exec(raw)
      const text = wrapper ? raw.replace(wrapper[0], `<local-command-${wrapper[1]}>${plain}</local-command-${wrapper[1]}>`) : plain
      if (typeof blocks === 'string') return next({ ...e, message: { ...e.message, content: text as never } })
      let isDone = false
      const content = blocks.map(b => {
        if (b.type !== 'text' || isDone) return b
        isDone = true
        return { ...b, text }
      })
      return next({ ...e, message: { ...e.message, content } })
    } catch {
      return next(e)
    }
  }).catch(($, e, next) => next(e))
}
