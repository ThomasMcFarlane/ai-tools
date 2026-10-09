import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TasksBoardFix, TasksBoardChanges, TasksBoardFilter, TasksBoardTask } from '../types'
import type { WorktreeBoard } from './board'
import type { BoardConfig } from './config'
import { DEFAULT_CONFIG, readConfig } from './config'
import { fixPrompt } from './format'
import { ETA_W, epicEta, shortEta, ageText, boardRepo, normaliseGitDir, barColumns, changedSinceFork, boardCandidates, epicLabel, groupByEpic, isBlockedOnYou, isActive, lintBoard, mergeBoards, numColumnWidth, parseBoard, parseIds, parseRemote, parseTarget, pickBoard, repoFromCwd, rowIds, ruleLine, shouldLaunchFix, slimTasks, SPINNER, subHeader, tableLine, tagColor, trackChanges, headerRuns, wrapText, worktreePaths, worktreeTag } from './board'

const PANE = 'tasks-board'
const empty = { numW: 3, repo: '', path: '', mtimeMs: 0, size: 0, checkedAt: 0, tasks: [], error: '' }

const board = atom({ plugin: 'tasks-board', key: 'board' } as const, empty)
const filter = atom({ plugin: 'tasks-board', key: 'filter' } as const, 'all' as TasksBoardFilter)
const expanded = atom({ plugin: 'tasks-board', key: 'expanded' } as const, [] as string[])
// Keys (`section|epic`) whose open/closed state the person flipped from its default.
const epicFlips = atom({ plugin: 'tasks-board', key: 'epicFlips' } as const, [] as string[])
const isTurnRunning = atom({ plugin: 'tasks-board', key: 'isTurnRunning' } as const, false)
const changes = atom({ plugin: 'tasks-board', key: 'changes' } as const, null as TasksBoardChanges | null)
const frame = atom({ plugin: 'tasks-board', key: 'frame' } as const, 0)
// /board autofix on|off for this session: '' defers to the plugin's option
const autofixOverride = atom({ plugin: 'tasks-board', key: 'autofixOverride' } as const, '')
const pathOverride = atom({ plugin: 'tasks-board', key: 'pathOverride' } as const, '')
const fix = atom({ plugin: 'tasks-board', key: 'fix' } as const, { repo: '', url: '', isRunning: false } as TasksBoardFix)
const pinned = atom({ plugin: 'tasks-board', key: 'pinned' } as const, [] as string[])
const touched = atom({ plugin: 'tasks-board', key: 'touched' } as const, [] as string[])
const me = atom({ plugin: 'tasks-board', key: 'me' } as const, '')

// The plugin's options, set by register() on every load or reload.
let cfg: BoardConfig = DEFAULT_CONFIG

// Cell cap for boards over the engine's 4 MiB read limit; the pane clips notes far below it.
const CELL_CAP = 2000
const CLIP_AWK = `{for(i=1;i<=NF;i++) if(length($i)>${CELL_CAP}) $i=substr($i,1,${CELL_CAP - 1}) "…"; print}`
const isOverLimit = (err: unknown) => /over the \d+-byte limit/.test(String(err instanceof Error ? err.message : err))
const reason = (err: unknown) => String(err instanceof Error ? err.message : err).replace(/^(\w*Error: )?tasks-board: /, '').slice(0, 120)

// Board text from a file (or a `git show` ref). Over the read limit it is read through awk with every table cell clipped.
async function readBoard($: EngineInterface, path: string, ref?: { wt: string; sha: string }): Promise<{ text: string; isClipped: boolean; isTruncated: boolean }> {
  if (!ref) {
    try {
      return { text: await $.fs.read(path), isClipped: false, isTruncated: false }
    } catch (err) {
      if (!isOverLimit(err)) throw err
    }
  }
  const r = ref
    ? await $.process.run(['sh', '-c', 'git -C "$1" show "$2" | awk -F"|" -v OFS="|" "$3"', 'sh', ref.wt, `${ref.sha}:TASKS.md`, CLIP_AWK], { timeoutMs: 20000 })
    : await $.process.run(['awk', '-F|', '-v', 'OFS=|', CLIP_AWK, path], { timeoutMs: 20000 })
  if (r.exitCode !== 0 || (ref && r.stdout === '')) throw new Error(`cannot read ${ref ? `${ref.sha}:TASKS.md` : path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
  return { text: r.stdout, isClipped: true, isTruncated: r.isStdoutTruncated }
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])]

// The git main worktree of the checkout at `dir` (the first `git worktree list` entry), or ''.
async function mainWorktree($: EngineInterface, dir: string): Promise<string> {
  try {
    const r = await $.process.run(['git', '-C', dir, 'worktree', 'list', '--porcelain'], { timeoutMs: 20000 })
    return r.exitCode === 0 ? (worktreePaths(r.stdout)[0] ?? '') : ''
  } catch {
    return ''
  }
}

async function resolvePath($: EngineInterface): Promise<{ path: string; source: string; org: string; repo: string; root: string }> {
  const root = await $.session.root()
  const main = await mainWorktree($, root)
  const picked = await pickBoard(await read($, pathOverride), boardCandidates(root, cfg, main), p => $.fs.exists(p))
  // The label follows the picked board, never the session's directory.
  const { org, repo } = picked.path ? boardRepo(picked.path, cfg) : { org: '', repo: '' }
  return { path: picked.path, source: picked.source, org, repo, root }
}

// Other worktrees of the repo, merged into the base board. Kept in module variables (not $.state):
// the parsed rows can be large, and a reload simply rescans.
type ParsedBoard = { mtimeMs: number; size: number; baseSha: string; tasks: TasksBoardTask[]; fork?: TasksBoardTask[] }
const wtParsed = new Map<string, ParsedBoard>()
// The board as committed at a fork point, by commit sha (the same in every checkout of the repository).
const forkParsed = new Map<string, TasksBoardTask[]>()
let wtBoards: WorktreeBoard[] = []
let wtSignature = ''
let wtScannedAt = 0
let baseCache: { path: string; mtimeMs: number; size: number; all: TasksBoardTask[]; isClipped: boolean; warn: string } | undefined
// The board the module state above belongs to, and a counter that moves whenever it changes: a refresh that
// started for an earlier board drops its results instead of writing them.
let curPath = ''
let gen = 0
type WtInfo = { path: string; mtimeMs: number; isOwn: boolean; changed: number }
let wtInfos: WtInfo[] = []
let lastPick = { source: '', org: '', repo: '', root: '' }

const resetFor = (path: string) => {
  curPath = path
  gen += 1
  wtBoards = []
  wtSignature = ''
  wtScannedAt = 0
  wtInfos = []
  baseCache = undefined
}

// The common git directory of `dir`, normalised, or '' when it is not in a repository.
async function commonDir($: EngineInterface, dir: string): Promise<string> {
  try {
    const r = await $.process.run(['git', '-C', dir, 'rev-parse', '--git-common-dir'], { timeoutMs: 20000 })
    return r.exitCode === 0 && r.stdout.trim() ? normaliseGitDir(dir, r.stdout.trim()) : ''
  } catch {
    return ''
  }
}

// The board of `wt` at its fork point from the primary checkout's HEAD, or undefined when git cannot say.
async function forkBoard($: EngineInterface, wt: string, baseSha: string): Promise<TasksBoardTask[] | undefined> {
  try {
    if (!baseSha) return undefined
    const mb = await $.process.run(['git', '-C', wt, 'merge-base', 'HEAD', baseSha], { timeoutMs: 20000 })
    const sha = mb.stdout.trim()
    if (mb.exitCode !== 0 || !sha) return undefined
    let tasks = forkParsed.get(sha)
    if (!tasks) {
      tasks = parseBoard((await readBoard($, '', { wt, sha })).text, { ownerNames: cfg.ownerNames })
      forkParsed.set(sha, tasks)
    }
    return tasks
  } catch {
    return undefined
  }
}

// The other registered worktrees of the board's checkout whose board changed within the configured hours and
// after the primary board (the session's own worktree always counts), the newest few. Stats first; only those are read. True when the set changed.
async function scanWorktrees($: EngineInterface, basePath: string, baseMtime: number, root: string, now: number): Promise<{ found: WorktreeBoard[]; infos: WtInfo[] }> {
  const found: WorktreeBoard[] = []
  const infos: WtInfo[] = []
  {
    const baseDir = basePath.slice(0, basePath.lastIndexOf('/'))
    // The session's own worktree counts only when it belongs to the same repository as the board.
    const baseCommon = await commonDir($, baseDir)
    const isSameRepo = baseCommon !== '' && baseCommon === (await commonDir($, root))
    const listed = await $.process.run(['git', '-C', baseDir, 'worktree', 'list', '--porcelain'], { timeoutMs: 20000 })
    const head = await $.process.run(['git', '-C', baseDir, 'rev-parse', 'HEAD'], { timeoutMs: 20000 })
    const baseSha = head.exitCode === 0 ? head.stdout.trim() : ''
    const paths = listed.exitCode === 0 ? worktreePaths(listed.stdout).filter(p => p !== baseDir) : []
    const stats: { p: string; mtimeMs: number; size: number; isOwn: boolean }[] = []
    for (const p of paths) {
      try {
        const st = await $.fs.stat(`${p}/TASKS.md`)
        const isOwn = isSameRepo && (root === p || root.startsWith(`${p}/`))
        if (isOwn || (now - st.mtimeMs < cfg.excludeWorktreesOlderThanHours * 3_600_000 && st.mtimeMs > baseMtime)) stats.push({ p, mtimeMs: st.mtimeMs, size: st.size, isOwn })
      } catch {
        /* no board there */
      }
    }
    stats.sort((a, b) => Number(b.isOwn) - Number(a.isOwn) || b.mtimeMs - a.mtimeMs)
    for (const s of stats.slice(0, cfg.maxWorktrees)) {
      let parsed = wtParsed.get(s.p)
      if (!parsed || parsed.mtimeMs !== s.mtimeMs || parsed.size !== s.size || parsed.baseSha !== baseSha) {
        let all: TasksBoardTask[]
        try {
          all = parseBoard((await readBoard($, `${s.p}/TASKS.md`)).text, { ownerNames: cfg.ownerNames })
        } catch {
          continue // an unreadable worktree board is skipped, not fatal
        }
        // Only what the worktree changed since it forked counts; if git cannot say, every row does.
        const fork = await forkBoard($, s.p, baseSha)
        parsed = { mtimeMs: s.mtimeMs, size: s.size, baseSha, tasks: fork ? changedSinceFork(fork, all) : all, fork }
        wtParsed.set(s.p, parsed)
      }
      found.push({ tag: worktreeTag(s.p, cfg), path: s.p, isOwn: s.isOwn, tasks: parsed.tasks, fork: parsed.fork })
      infos.push({ path: s.p, mtimeMs: s.mtimeMs, isOwn: s.isOwn, changed: parsed.tasks.length })
    }
  }
  return { found, infos }
}

const sync = async ($: EngineInterface) => {
  await refresh($, true)
  await openPane($, (await read($, board)).repo)
}

const openPane = ($: EngineInterface, repo: string) =>
  $.ui.open({ id: PANE, title: repo ? `Board · ${repo}` : 'Board', columns: 44 })

let ticket = 0

async function refresh($: EngineInterface, isForced = false) {
  const mine = ++ticket
  const { path, source, org, repo, root } = await resolvePath($)
  if (path !== curPath) {
    // A refresh that started before a newer one must not move the module state back to its (older) board.
    if (mine !== ticket) return
    resetFor(path)
  }
  const g = gen
  const isStale = () => g !== gen
  lastPick = { source, org, repo, root }
  const prev = await read($, board)
  if (isStale()) return
  if (prev.repo !== repo) await update($, board, b => ({ ...b, repo }))
  if (path === '') {
    await update($, board, () => ({ ...empty, repo, checkedAt: Date.now() }))
    return
  }
  try {
    const st = await $.fs.stat(path)
    const now = Date.now()
    const isBaseChanged = !(prev.path === path && prev.mtimeMs === st.mtimeMs && prev.size === st.size)
    let isWtChanged = false
    if (isForced || isBaseChanged || now - wtScannedAt >= 60_000) {
      wtScannedAt = now
      const scanned = await scanWorktrees($, path, st.mtimeMs, root, now)
      if (isStale()) return
      const signature = scanned.found.map(w => `${w.path}:${wtParsed.get(w.path)?.mtimeMs}:${wtParsed.get(w.path)?.size}`).join('|')
      isWtChanged = signature !== wtSignature
      wtSignature = signature
      wtBoards = scanned.found
      wtInfos = scanned.infos
    }
    if (!isBaseChanged && !isWtChanged && !isForced) {
      await update($, board, b => ({ ...b, checkedAt: now }))
      return
    }
    // Only the primary board is ever offered for formatting: not a walked-up one, and never one the person pointed at by hand.
    const mayFix = source === 'primary'
    if (!baseCache || baseCache.path !== path || baseCache.mtimeMs !== st.mtimeMs || baseCache.size !== st.size) {
      const text = await readBoard($, path)
      const all = parseBoard(text.text, { ownerNames: cfg.ownerNames })
      if (isStale()) return
      baseCache = { path, mtimeMs: st.mtimeMs, size: st.size, all, isClipped: text.isClipped, warn: text.isTruncated ? 'board over 4 MiB even clipped: later rows missing' : '' }
    }
    // A clipped board is never offered for formatting: the agent would see the full file, the lint only the clipped one.
    if (mayFix && isBaseChanged && !baseCache.isClipped) void maybeAutofix($, path, lintBoard((await readBoard($, path)).text)).catch(err => report($, 'autofix', err))
    const all = mergeBoards(baseCache.all, wtBoards)
    // Only open rows are kept in state (and tracked): the done rows are most of a multi-megabyte file.
    const open = all.filter(t => t.status !== 'done')
    const tasks = slimTasks(all)
    const old = await read($, changes)
    if (isStale()) return
    await update($, changes, () => ({ path, rows: trackChanges(old?.path === path ? old.rows : undefined, open, Date.now()) }))
    if (isStale()) return
    await update($, board, () => ({ numW: numColumnWidth(all), repo, path, mtimeMs: st.mtimeMs, size: st.size, checkedAt: Date.now(), tasks, error: baseCache.warn }))
  } catch (err) {
    // Keep the last good rows; say why they may be stale.
    if (!isStale()) await update($, board, b => ({ ...b, path, checkedAt: Date.now(), error: `board unreadable: ${reason(err)}` }))
  }
}

const padR = (s: string, n: number) => (s.length > n ? clip(s, n) : s.padEnd(n))
const padL = (s: string, n: number) => (s.length > n ? clip(s, n) : s.padStart(n))
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

async function debugText($: EngineInterface): Promise<string> {
  await refresh($)
  const b = await read($, board)
  const base = baseCache?.path === b.path ? baseCache.all : []
  const counts = new Map<string, number>()
  for (const t of base) counts.set(t.status, (counts.get(t.status) ?? 0) + 1)
  const merged = b.tasks.filter(t => t.wtPath)
  const lines = [
    `board: ${b.path || '(none)'} (${lastPick.source})`,
    `org/repo: ${lastPick.org || '-'}/${lastPick.repo || '-'}`,
    `session root: ${lastPick.root}`,
    `base mtime: ${b.mtimeMs ? new Date(b.mtimeMs).toISOString() : '-'}; rows ${base.length}: ${[...counts].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    `worktrees considered: ${wtInfos.length}`,
    ...wtInfos.map(w => `  ${w.path} mtime ${new Date(w.mtimeMs).toISOString()} own ${w.isOwn} changed rows ${w.changed} variants ${merged.filter(t => t.wtPath === w.path).length}`),
    `total variants: ${merged.length}`,
    `state size: ${JSON.stringify(b).length} bytes, ${b.tasks.length} rows`,
  ]
  return lines.join('\n')
}

async function runBoardCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const [sub = 'open', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  if (sub === 'path') {
    if (!rest[0]) return { text: 'Usage: /board path <file>' }
    const target = parseTarget(rest.join(' '), cfg)
    await update($, pathOverride, () => target)
    await sync($)
    return { text: `Board: ${target}` }
  }
  if (sub === 'debug') return { text: await debugText($) }
  if (sub === 'autofix') {
    if (rest[0] !== 'on' && rest[0] !== 'off') return { text: 'Usage: /board autofix on|off' }
    await update($, autofixOverride, () => rest[0]!)
    return { text: `Board auto-format ${rest[0]}.` }
  }
  if (sub === 'pin') {
    await update($, pinned, p => union(p, parseIds(rest)))
    await sync($)
    return { text: `Pinned ${parseIds(rest).join(' ') || 'nothing'}.` }
  }
  if (sub === 'unpin') {
    const drop = parseIds(rest)
    await update($, pinned, p => p.filter(n => !drop.includes(n)))
    await update($, touched, p => p.filter(n => !drop.includes(n)))
    await sync($)
    return { text: `Unpinned ${drop.join(' ') || 'nothing'}.` }
  }
  if (sub === 'me') {
    await update($, me, () => rest[0] ?? '')
    await sync($)
    return { text: rest[0] ? `Session tag: ${rest[0]}` : 'Session tag cleared.' }
  }
  if (sub === 'refresh') {
    await sync($)
    return { text: 'Board refreshed.' }
  }
  if (sub !== 'open' && sub !== 'autofix') {
    // `/board <file | dir | org/repo>` opens that board for this session.
    const target = parseTarget([sub, ...rest].join(' '), cfg)
    await update($, pathOverride, () => target)
    await sync($)
    return { text: `Board: ${target}` }
  }
  // /board and /board open: drop any override and find the board for the session's directory again.
  await update($, pathOverride, () => '')
  await sync($)
  const at = (await read($, board)).path
  return { text: at ? `Board opened: ${at}` : 'Board opened: no TASKS.md for this session.' }
}

const AUTOFIX_KEY = (org: string, repo: string) => `autofix:${org}/${repo}`
const FIX_SEARCH = 'TASKS.md canonical board format in:title'

async function openFixPr($: EngineInterface, slug: string): Promise<string> {
  const r = await $.process.run(['gh', 'pr', 'list', '-R', slug, '--state', 'open', '--search', FIX_SEARCH, '--json', 'url'])
  if (r.exitCode !== 0) return ''
  const list = JSON.parse(r.stdout || '[]') as { url: string }[]
  return list[0]?.url ?? ''
}

// Starts ONE background agent to rewrite a non-canonical primary board, at most once per repo per 24 h across sessions.
async function maybeAutofix($: EngineInterface, path: string, lint: { canonical: boolean }) {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const remote = await $.process.run(['git', '-C', dir, 'remote', 'get-url', 'origin'])
  const repo = remote.exitCode === 0 ? parseRemote(remote.stdout) : undefined
  if (!repo) return
  const key = AUTOFIX_KEY(repo.org, repo.repo)
  const now = Date.now()
  const record = await $.store.get(key)
  const override = await read($, autofixOverride)
  const go = shouldLaunchFix({
    autofix: override === '' ? cfg.autofix : override === 'on',
    canonical: lint.canonical,
    repo,
    record: record && typeof record === 'object' ? (record as { at: number }) : undefined,
    now,
  })
  if (!go) return
  await $.store.set(key, { at: now }) // recorded before anything else, so a reload or another identity does not repeat it
  const slug = `${repo.org}/${repo.repo}`
  const existing = await openFixPr($, slug)
  if (existing) {
    await $.store.set(key, { at: now, pr: existing })
    await update($, fix, () => ({ repo: slug, url: existing, isRunning: false }))
    return
  }
  const date = new Date(now).toISOString().slice(0, 10).replace(/-/g, '')
  await $.agent.spawn({
    prompt: fixPrompt(slug, path, date, cfg.fixInstructions),
    description: `Format ${slug} TASKS.md`,
    subagentType: 'general-purpose',
    model: 'sonnet',
  })
  await update($, fix, () => ({ repo: slug, url: '', isRunning: true }))
  $.ui.toast(`tasks-board: formatting ${slug} TASKS.md in the background`)
}

// While the agent runs, look for its pull request; the first one found is shown and remembered.
async function pollFixPr($: EngineInterface) {
  const f = await read($, fix)
  if (!f.isRunning) return
  const url = await openFixPr($, f.repo)
  if (!url) return
  const [org, name] = f.repo.split('/')
  await $.store.set(AUTOFIX_KEY(org!, name!), { at: Date.now(), pr: url })
  await update($, fix, () => ({ repo: f.repo, url, isRunning: false }))
  $.ui.toast(`tasks-board: format PR ${url}`)
}

// Whether any row actually drawn is active; set by the last render, read by the frame timer.
// A module variable on purpose: a render may not write $.state, and a reload redraws and resets it.
let hasDrawnActive = false

// Reports a failure on the status line so the next one names its cause, never throwing itself.
const report = ($: EngineInterface, where: string, err: unknown) => {
  try {
    $.ui.status(`tasks-board: ${where}: ${String(err instanceof Error ? err.message : err).slice(0, 80)}`)
  } catch {
    /* nothing left to do */
  }
}

export const register: Register = (on, options) => {
  cfg = readConfig(options)
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'board',
        description: 'TASKS.md board pane: open | path <file> | debug | pin <n...> | unpin <n...> | me <tag> | refresh',
        argumentHint: '[open|path|debug|pin|unpin|me|refresh]',
      })
      // session.start also fires on a mid-session enable and on a reload (changed modules): start clean there
      // so a stale override cannot win, then search like /board does and open the pane.
      await update($, pathOverride, () => '')
      void sync($).catch(err => report($, 'session.start', err))
      // session.start fires again on a hot reload, which drops the old timers. Callbacks return their
      // promise (the period waits for it) and never throw, so a failure cannot end a timer.
      // Frame timer: does nothing, with no $ call, unless the last render drew an active row.
      $.clock.every(120, () => {
        if (!hasDrawnActive) return
        return update($, frame, n => (n + 1) % SPINNER.length).then(
          () => undefined,
          err => report($, 'frame', err),
        )
      })
      // If the first search never ran (nothing loaded yet), the timer does it, as /board would.
      $.clock.every(15000, async () => {
        try {
          if ((await read($, board)).checkedAt === 0) await sync($)
          else await refresh($)
          await pollFixPr($)
        } catch (err) {
          report($, 'refresh', err)
        }
      })
    } catch (err) {
      report($, 'session.start', err)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    try {
      await update($, isTurnRunning, () => true)
    } catch (err) {
      report($, 'turn.start', err)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    try {
      await update($, isTurnRunning, () => false)
    } catch (err) {
      report($, 'turn.complete', err)
    }
    return next(e)
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    try {
      return await runBoardCommand($, e.args)
    } catch (err) {
      report($, 'command.run', err)
      return { text: `Board command failed: ${String(err instanceof Error ? err.message : err)}` }
    }
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const path = String(input.file_path ?? '')
    if (!['Edit', 'Write', 'MultiEdit'].includes(String(e.tool)) || !path.endsWith('TASKS.md')) return next(e)
    const edits = Array.isArray(input.edits) ? (input.edits as { new_string?: unknown }[]) : []
    const text = [input.new_string, input.content, ...edits.map(x => x.new_string)].filter(x => typeof x === 'string').join('\n')
    const rows = rowIds(text)
    const ran = await next(e)
    // A board failure must never fail an Edit or Write that already ran.
    try {
      if (rows.length) await update($, touched, t => union(t, rows))
      await refresh($, true)
    } catch (err) {
      $.ui.status(`tasks-board: ${String(err).slice(0, 60)}`)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, board)
    const f = await read($, filter)
    const open = await read($, expanded)
    const flips = await read($, epicFlips)
    const fx = await read($, fix)
    const fixNote = fx.url ? `format PR: ${fx.url}` : fx.isRunning ? `formatting ${fx.repo} board…` : ''
    const running = await read($, isTurnRunning)
    const ch = await read($, changes)
    const spin = SPINNER[await read($, frame)] ?? SPINNER[0]!
    const now = Date.now()
    const touchedNow = await read($, touched)
    let seenActive = false
    const activeOf = (t: TasksBoardTask) => isActive(t, { touched: touchedNow, isTurnRunning: running, changes: ch?.rows, now })
    const mine = union(await read($, pinned), await read($, touched))
    const tag = (await read($, me)).toLowerCase()

    // A done variant from a worktree sits in the section of the base row it replaces.
    const st = (t: TasksBoardTask) => t.priorStatus ?? t.status
    const live = b.tasks.filter(t => t.status !== 'done' || t.priorStatus)
    const count = (s: string) => live.filter(t => st(t) === s).length
    const shownMine = new Set<string>()
    const shown = new Set<string>()
    const take = (list: TasksBoardTask[]) => {
      const fresh = list.filter(t => !shown.has(t.key))
      fresh.forEach(t => shown.add(t.key))
      return fresh
    }
    const blocked = live.filter(t => st(t) === 'blocked')
    const isMine = (t: TasksBoardTask) => mine.includes(t.id) || (tag !== '' && t.owner.toLowerCase().includes(tag))
    // In the session view its rows lead, so a blocked row of ours is not claimed by "Blocked on you".
    const session = f === 'session' ? take(live.filter(isMine)) : []
    const onYou = take(blocked.filter(isBlockedOnYou))
    if (f !== 'session') session.push(...take(live.filter(isMine)))
    live.filter(isMine).forEach(t => shownMine.add(t.key))
    const other = take(blocked)
    const working = take(live.filter(t => st(t) === 'in_progress'))
    working.sort((x, y) => x.agent.localeCompare(y.agent) || x.n - y.n)
    const todo = take(live.filter(t => st(t) === 'todo'))

    const W = e.props.bodyColumns
    const HEAD_BG = '#262626'
    const HEAD_FG = '#bcbcbc' // the column header is inverted: light fill, dark text and borders
    const SUB_BG = '#3a3a3a'
    const CHILD_BG = '#181818' // darker than HEAD_BG and SUB_BG
    const hasAgent = W >= 50
    const hasEta = W >= 36
    const prefix = (() => {
      try {
        return cfg.agentPrefixPattern ? new RegExp(cfg.agentPrefixPattern) : undefined
      } catch {
        return undefined
      }
    })()
    const short = (a: string) => (prefix ? a.replace(prefix, '') : a)
    // owner / unassigned / empty means nobody has picked the row up yet
    const who = (a: string) => (/^(owner|unassigned|)$/i.test(a.trim()) ? '—' : short(a))
    // One table: # (numW, right) | Task (flex) [| Agent (12)] [| ETA (10)]; sections are full-width sub-header rows.
    // Columns: chevron (1) | # (numW) | Task (flex) [| Agent (12)] [| ETA (10)], a three-cell ` │ ` between each.
    const numW = b.numW
    const taskW = Math.max(6, W - (11 + numW) - (hasAgent ? 15 : 0) - (hasEta ? ETA_W + 3 : 0))
    const header = tableLine({ num: '#', task: 'Task', agent: 'Agent', eta: 'ETA' }, taskW, hasAgent, hasEta, numW)
    // Hovering anywhere on a row (it is a keyed Box) inverts every cell of it.
    const HV = { inverse: true } as const
    const bar = () => <Text dimColor hover={{ dimColor: false, inverse: true }}> │ </Text>
    // A Button holds only a label (the engine refuses other children), so every plain cell is its own Button
    // with the row's onPress. A Button takes no colour: cells that carry one stay Text, and are not pressable.
    const cellButton = (k: string, label: string, onPress: () => unknown) => <Button key={k} label={label} plain hover={HV} onPress={onPress} />
    // Child rows carry CHILD_BG on the row's Box, not on each Text, so the focus and pointer inversion
    // of the Button covers separators and padding uniformly (explicit Text colours would resist it).
    // Detail lines keep the blank chevron and # cells (and their separators), then use the Task column to the right edge.
    // Only the first border runs through the details; rules above and below start at it and meet the
    // other column borders (┴ above, ┬ below).
    const detailW = Math.max(6, W - 8) // between the first and right borders
    const bars = barColumns(taskW, hasAgent, hasEta, numW)
    const rule = (join: string) => ruleLine(W, join, bars)
    let used = 0 // rows drawn below the header, to pad the column borders down to the pane's end
    const details = (t: TasksBoardTask) => {
      const fields: [string, string][] = [['Owner  ', t.owner], ['Epic   ', t.epic]]
      if (t.id.length > numW - 2) fields.unshift(['Id      ', t.id])
      if (t.wtPath) fields.unshift(['Worktree ', t.wtPath])
      if (t.depends !== '') fields.push(['Depends ', t.depends])
      fields.push(['ETA    ', t.eta || '—'], ['', t.notes.slice(0, 300)])
      return fields.flatMap(([label, text]) =>
        wrapText(label + text, detailW).map((line, i) =>
          i === 0 ? { label, text: line.slice(label.length) } : { label: '', text: line },
        ),
      )
    }
    const row = (t: TasksBoardTask, numColor?: string, indent = 0, accent?: string) => {
      const doneText = t.priorStatus ? '✓ ' : ''
      const tagText = t.tag ? `[${t.tag}${t.isOwn ? '*' : ''}] ` : ''
      const isOn = activeOf(t)
      if (isOn) seenActive = true
      used += 1 + (open.includes(t.key) ? details(t).length + 2 : 0)
      const bg = indent > 0 ? CHILD_BG : undefined
      const toggle = () => update($, expanded, x => (x.includes(t.key) ? x.filter(n => n !== t.key) : [...x, t.key]))
      const isNumColoured = numColor !== undefined || shownMine.has(t.key)
      const numText = padL(t.id, isOn ? numW - 1 : numW)
      const cell = `${' '.repeat(indent)}${tagText}${doneText}${padR(t.title, taskW - indent - tagText.length - doneText.length)}`
      return (
        <Box key={`row${t.key}`} flexDirection="column" backgroundColor={bg}>
          <Box flexDirection="row">
            <Text hover={HV}> </Text>{bar()}
            {isOn && <Text color={accent} hover={HV}>{spin}</Text>}
            {isNumColoured ? <Text hover={HV} color={numColor ?? 'green'} bold>{numText}</Text> : cellButton(`cn${t.key}`, numText, toggle)}
            {bar()}
            <Button key={`t${t.key}`} label={cell} plain hover={HV} onPress={toggle} />
            {hasAgent && bar()}{hasAgent && cellButton(`ca${t.key}`, padR(who(t.agent), 12), toggle)}
            {hasEta && bar()}{hasEta && cellButton(`ce${t.key}`, padR(shortEta(t.eta || '') || '—', ETA_W), toggle)}{bar()}<Text hover={HV}> </Text>
          </Box>
          {open.includes(t.key) && (
            <Box flexDirection="column" backgroundColor={bg}>
              <Text dimColor>{rule('┴')}</Text>
              {details(t).map((l, i) => (
                <Text key={`d${i}`}>
                  <Text dimColor>{' '}{' │ '}</Text>
                  <Text dimColor>{l.label}</Text>{padR(l.text, detailW - l.label.length)}
                  {bar()}<Text> </Text>
                </Text>
              ))}
              <Text dimColor>{rule('┬')}</Text>
            </Box>
          )}
        </Box>
      )
    }
    // An epic is a normal row; its tasks nest beneath it. All epics start collapsed; a press flips one
    // (kept per section+epic).
    const epicRow = (title: string, name: string, rows: TasksBoardTask[], numColor?: string, accent?: string) => {
      const isOn = rows.some(activeOf)
      if (isOn) seenActive = true
      const id = `${title}|${name}`
      used += 1
      const isOpen = flips.includes(id)
      const agents = [...new Set(rows.map(t => t.agent))]
      const eta = epicEta(rows)
      const suffix = ` (${rows.length})`
      const { num, name: shownName } = epicLabel(name)
      const toggle = async () => {
        // Closing an epic also collapses its tasks' details, so reopening shows them folded.
        if (isOpen) await update($, expanded, x => x.filter(n => !rows.some(t => t.key === n)))
        await update($, epicFlips, x => (x.includes(id) ? x.filter(y => y !== id) : [...x, id]))
      }
      const numText = padL(num, isOn ? numW - 1 : numW)
      const label = clip(shownName, Math.max(1, taskW - suffix.length))
      const cell = `${label}${suffix}${' '.repeat(Math.max(0, taskW - label.length - suffix.length))}`
      // Child rows are siblings of the epic's Box, not inside it: hover is scoped to the keyed Box, so nesting them lit the epic.
      return [
        <Box key={`epic${id}`} flexDirection="column">
          <Box flexDirection="row">
            {cellButton(`ch${id}`, isOpen ? '▾' : '▸', toggle)}{bar()}
            {isOn && <Text color={accent} hover={HV}>{spin}</Text>}
            {numColor !== undefined ? <Text hover={HV} bold color={numColor}>{numText}</Text> : cellButton(`cn${id}`, numText, toggle)}
            {bar()}
            <Button key={`epic:${id}`} label={cell} plain hover={HV} onPress={toggle} />
            {hasAgent && bar()}{hasAgent && cellButton(`ca${id}`, padR(agents.length === 1 ? who(agents[0]!) : `${agents.length} agents`, 12), toggle)}
            {hasEta && bar()}{hasEta && cellButton(`ce${id}`, padR(shortEta(eta), ETA_W), toggle)}{bar()}<Text hover={HV}> </Text>
          </Box>
        </Box>,
        ...(isOpen ? rows.map(t => row(t, numColor, 2, accent)) : []),
      ]
    }
    const section = (title: string, list: TasksBoardTask[], color?: string, isDim = false, numColor?: string) => {
      if (list.length === 0) return false
      used += 3 // title plus a half-row of padding either side, each still a whole row
      return (
        <Box key={title} flexDirection="column">
          {(['top', 'title', 'bottom'] as const).map(row => (
            <Text key={row}>
              {subHeader(title, list.length, W, bars, row).map((r, i) => (
                <Text
                  key={`${row}${i}`}
                  bold={r.kind === 'band' && row === 'title'}
                  color={r.kind === 'accent' || (r.kind === 'band' && row === 'title') ? (isDim ? 'gray' : color) : undefined}
                  backgroundColor={r.kind === 'band' ? SUB_BG : undefined}
                >
                  {r.text}
                </Text>
              ))}
            </Text>
          ))}
          {groupByEpic(b.tasks, list, () => 0).map(x => epicRow(title, x.epic, x.rows, numColor, isDim ? undefined : color))}
        </Box>
      )
    }
    const key = (k: string, label: string, hotkey: string, f2?: TasksBoardFilter) => (
      <Button key={k} label={`[${hotkey}] ${label}`} plain hotkey={hotkey} dimColor={f2 !== f} onPress={() => (f2 ? update($, filter, () => f2) : refresh($, true))} />
    )
    const age = b.mtimeMs ? `updated ${ageText(b.checkedAt - b.mtimeMs)} ago` : 'not loaded'

    const sections = [
      f !== 'session' && section('BLOCKED ON YOU', onYou, 'red', false, 'red'),
      f !== 'blocked' && section('THIS SESSION', session, 'green'),
      f === 'all' && section('IN PROGRESS', working, 'cyan'),
      f !== 'session' && section('BLOCKED', other, 'yellow'),
      f === 'all' && section('TODO', todo, undefined, true),
    ]
    hasDrawnActive = seenActive // only rows drawn above count: filter, collapsed epics and dedup have applied
    // counts, repo, rule, filter row, a blank spacer and the three-row column header are always drawn; the notice and error when present.
    const room = e.props.scroll.bodyRows - (8 + (fixNote !== '' ? 1 : 0) + (b.path === '' ? 1 : 0) + (b.error !== '' ? 1 : 0)) - used
    const blank = tableLine({}, taskW, hasAgent, hasEta, numW)

    return (
      <Box flexDirection="column">
        <Text>
          <Text color="green">{count('in_progress')} IP</Text> <Text color="red">{count('blocked')} BLK</Text> {count('todo')} todo <Text dimColor>· {age}</Text>
        </Text>
        <Text dimColor>{clip(b.repo, W)}</Text>
        {fixNote !== '' && <Text dimColor>{clip(fixNote, W)}</Text>}
        <Text dimColor>{'─'.repeat(W)}</Text>
        {b.path === '' && <Text color="yellow" wrap="wrap">No TASKS.md for this session — /board path &lt;file&gt;</Text>}
        <Box flexWrap="wrap">
          {key('fa', 'all', 'a', 'all')}
          <Text> </Text>
          {key('fb', 'blocked', 'b', 'blocked')}
          <Text> </Text>
          {key('fs', 'session', 's', 'session')}
          <Text> </Text>
          {key('fr', 'refresh', 'r')}
        </Box>
        {b.error !== '' && <Text color="red">{clip(b.error, W)}</Text>}
        <Box flexDirection="column">
        <Text> </Text>
        {[blank, header, blank].map((l, i) => (
          <Text key={`head${i}`}>
            {headerRuns(padR(l, W), bars).map((r, j) =>
              r.kind === 'edge' ? (
                <Text key={`h${i}-${j}`} color={HEAD_FG}>{r.text}</Text>
              ) : r.kind === 'fill' ? (
                <Text key={`h${i}-${j}`} bold color={HEAD_BG} backgroundColor={HEAD_FG}>{r.text}</Text>
              ) : (
                <Text key={`h${i}-${j}`}>{r.text}</Text>
              ),
            )}
          </Text>
        ))}
        {sections}
        {Array.from({ length: Math.min(Math.max(0, room), 200) }, (_, i) => (
          <Text key={`pad${i}`} dimColor>{blank}</Text>
        ))}
        </Box>
      </Box>
    )
    } catch (err) {
      // A throw here would blank the pane: draw the reason in its place (and on the status line).
      report($, 'ui.render', err)
      const { Text } = $.ui.resolve(e)
      return <Text color="red" wrap="wrap">{`tasks-board: render failed: ${String(err instanceof Error ? `${err.message} @ ${(err.stack ?? '').split('\n')[1] ?? ''}` : err)}`}</Text>
    }
  })
}
