import type { ActiveRun, FollowLine, Job, Result, Run, Step, Target, TargetKind } from '../types'

export type { ActiveRun, FollowLine, Job, Result, Run, Step, Target, TargetKind }

export const targetId = (t: Target): string => `${t.repo.toLowerCase()}|${t.kind}:${t.value}`

export const targetLabel = (t: Target): string => {
  if (t.kind === 'pr') return `${t.repo}#${t.value}`
  if (t.kind === 'run') return `${t.repo} run ${t.value}`
  return `${t.repo}@${t.kind === 'commit' ? t.value.slice(0, 7) : t.value}`
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export const isRepo = (s: string): boolean => REPO.test(s)

// Splits a shell line into words per command, honouring quotes; operators end a command.
export const shellCommands = (line: string): string[][] => {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let has = false
  let quote = ''
  const endWord = () => {
    if (has) words.push(word)
    word = ''
    has = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    if (quote === "'") {
      if (c === "'") quote = ''
      else word += c
    } else if (quote === '"') {
      if (c === '"') quote = ''
      else if (c === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1] as string)) word += line[++i]
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]
      has = true
    } else if (c === ' ' || c === '\t') endWord()
    else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') endCommand()
    else {
      word += c
      has = true
    }
  }
  endCommand()
  return commands
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const FLAGS: Record<string, TargetKind> = { '--pr': 'pr', '--branch': 'branch', '--commit': 'commit', '--run': 'run' }

// Every `gh-watcher wait` in a shell line, as a target; ones with no repo are skipped.
export const parseWatcherCommands = (line: string): Target[] => {
  const found: Target[] = []
  let exported: string | undefined
  for (const words of shellCommands(line)) {
    let repoEnv = exported
    let i = 0
    if (words[0] === 'export') i = 1
    const isExport = i === 1
    while (i < words.length) {
      const m = ASSIGN.exec(words[i] as string)
      if (!m) break
      if (m[1] === 'GH_REPO') {
        if (isExport) exported = m[2]
        else repoEnv = m[2]
      }
      i++
    }
    if (i >= words.length) continue
    const exe = (words[i] as string).split('/').pop()
    if (exe !== 'gh-watcher' || words[i + 1] !== 'wait') continue
    let repo: string | undefined
    let kind: TargetKind | undefined
    let value: string | undefined
    for (let j = i + 2; j < words.length; j++) {
      const w = words[j] as string
      const eq = w.indexOf('=')
      const name = w.startsWith('--') && eq > 0 ? w.slice(0, eq) : w
      const inline = name === w ? undefined : w.slice(eq + 1)
      const take = () => inline ?? words[++j]
      if (name === '--repo') repo = take()
      else if (name in FLAGS) {
        kind = FLAGS[name]
        value = take()
      } else if (['--interval', '--timeout', '--source', '--events-url', '--fallback-interval'].includes(name)) take()
    }
    repo = repo ?? repoEnv
    if (repo && isRepo(repo) && kind && value) found.push({ repo, kind, value })
  }
  return found
}

// ---- CI wait guard ----------------------------------------------------------------------------

const HTTP_CLIENTS = ['curl', 'wget', 'http', 'https', 'xh', 'xhs']
const LEADING = new Set(['while', 'until', 'if', 'then', 'do', 'else', 'elif', '!', '{', 'time', 'nohup', 'exec', 'command', 'builtin'])
const LOOPS = new Set(['while', 'until', 'for'])
const SHELLS = ['bash', 'sh', 'zsh', 'dash']
const CI_URL = /api\.github\.com\/repos\/[^/\s]+\/[^/\s]+\/(actions\/(runs|jobs)\b|commits\/[^/\s]+\/(check-runs|status|statuses)\b)|(^|[/.])github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\//
const GH_API_CI = /actions\/(runs|jobs)\b|\/check-runs\b|\/commits\/[^/\s]+\/status(es)?\b/

type Poll = { api: boolean; poller: boolean; watch: boolean; loop: boolean; sleep: boolean }

// A heredoc body is data unless fed to a shell, and a whole-line comment never runs: both are dropped.
const stripInert = (line: string): string =>
  line
    .replace(/<<-?[ \t]*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, (_m, _q, _tag, rest: string) => rest)
    .split('\n')
    .filter(l => !l.trimStart().startsWith('#'))
    .join('\n')

const ghWords = (words: string[]): string[] => {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string
    if (w === '-R' || w === '--repo') i++
    else if (!w.startsWith('-')) out.push(w)
  }
  return out
}

const scan = (line: string, depth = 0): Poll => {
  const r: Poll = { api: false, poller: false, watch: false, loop: false, sleep: false }
  for (const raw of shellCommands(stripInert(line))) {
    const words = [...raw]
    if (LOOPS.has(words[0] as string)) r.loop = true
    while (words.length && (LEADING.has(words[0] as string) || ASSIGN.test(words[0] as string))) words.shift()
    if (!words.length) continue
    const exe = (words[0] as string).split('/').pop() as string
    const args = words.slice(1)
    if (exe === 'sleep') r.sleep = true
    else if (HTTP_CLIENTS.includes(exe)) {
      if (args.some(a => CI_URL.test(a))) r.api = true
    } else if (exe === 'watch') {
      r.watch = true
      const body = scan(args.filter((a, i) => !(a.startsWith('-') && !args[i - 1]?.startsWith('-n'))).join(' '), depth + 1)
      r.poller ||= body.poller
      r.api ||= body.api
      r.sleep = true
    } else if (SHELLS.includes(exe) && depth < 3 && args.includes('-c')) {
      const inner = scan(args[args.indexOf('-c') + 1] ?? '', depth + 1)
      r.api ||= inner.api
      r.poller ||= inner.poller
      r.watch ||= inner.watch
      r.loop ||= inner.loop
      r.sleep ||= inner.sleep
    } else if (exe === 'gh') {
      const w = ghWords(args)
      const pair = `${w[0]} ${w[1]}`
      if (pair === 'run watch' || (pair === 'pr checks' && args.some(a => a === '--watch' || a.startsWith('--watch=')))) r.watch = true
      else if (['pr checks', 'pr view', 'run view', 'run list'].includes(pair)) r.poller = true
      else if (w[0] === 'api' && args.some(a => GH_API_CI.test(a))) r.poller = true
    }
  }
  return r
}

const firstMatch = (text: string, ...res: RegExp[]): RegExpExecArray | null => {
  for (const re of res) {
    const m = re.exec(text)
    if (m) return m
  }
  return null
}

// The replacement command, with the repo and the id filled in where the line shows them.
const replacement = (line: string): string => {
  const repo =
    firstMatch(line, /(?:^|\s)(?:-R|--repo)[ =]([\w.-]+\/[\w.-]+)/, /repos\/([\w.-]+\/[\w.-]+)\//, /github\.com\/([\w.-]+\/[\w.-]+)\/(?:actions|pull)/)?.[1] ?? '<owner/repo>'
  const run = firstMatch(line, /actions\/runs\/(\d+)/, /\bgh run (?:view|watch)\s+(?:-\S+\s+)*(\d+)/)?.[1]
  const sha = firstMatch(line, /commits\/([0-9a-f]{7,40})\//)?.[1]
  const pr = firstMatch(line, /\bgh pr (?:checks|view)\s+(?:-\S+\s+)*(\d+)/)?.[1]
  const target = run ? `--run ${run}` : sha ? `--commit ${sha}` : pr ? `--pr ${pr}` : '(--pr <n>|--run <id>|--commit <sha>)'
  return `gh-watcher wait --repo ${repo} ${target} --timeout 45m --json`
}

// Why a Bash or Monitor command polls CI itself, with the gh-watcher command to use; undefined when it is fine.
export const ciPollReason = (tool: string, input: unknown): string | undefined => {
  if (tool !== 'Bash' && tool !== 'Monitor') return undefined
  const line = (input as { command?: unknown } | null | undefined)?.command
  if (typeof line !== 'string' || line === '') return undefined
  let found: Poll
  try {
    found = scan(line)
  } catch {
    return undefined
  }
  const how = tool === 'Bash' ? 'run it in the background (Bash run_in_background)' : 'run it in the background with Bash run_in_background instead of Monitor'
  const fix = `Wait on CI with gh-watcher, never by polling GitHub yourself: ${replacement(line)}; ${how} and you are told when it ends.`
  if (found.api) return `Do not call the GitHub Actions or checks API directly to wait on CI. ${fix}`
  if (found.watch) return `Do not use gh run watch, gh pr checks --watch or watch to wait on CI. ${fix}`
  if (found.poller && found.loop && found.sleep) return `Do not poll CI in a sleep loop. ${fix}`
  return undefined
}

// A PR or run URL, `owner/repo#123`, or `owner/repo 123`.
export const parseTrackArg = (arg: string): Target | undefined => {
  const s = arg.trim()
  let m = /^https?:\/\/[^/\s]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(s)
  if (m) return { repo: m[1] as string, kind: 'pr', value: m[2] as string }
  m = /^https?:\/\/[^/\s]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/(\d+)(?:[/?#].*)?$/.exec(s)
  if (m) return { repo: m[1] as string, kind: 'run', value: m[2] as string }
  m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#|\s+#?)(\d+)$/.exec(s)
  if (m) return { repo: m[1] as string, kind: 'pr', value: m[2] as string }
  return undefined
}

export const USAGE = 'Usage: /ci-track <PR URL | run URL | owner/repo#123 | owner/repo 123 | expand | collapse>'

// Reads one NDJSON line from gh-watcher follow; undefined when it is not a usable line.
export const parseLine = (text: string): FollowLine | undefined => {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (typeof o.repo !== 'string' || typeof o.state !== 'string' || !Array.isArray(o.runs)) return undefined
  if (o.source !== 'events' && o.source !== 'poll') return undefined
  if (typeof o.checkedAt !== 'string' || typeof o.isFinal !== 'boolean') return undefined
  for (const r of o.runs) {
    const run = r as Record<string, unknown> | null
    if (!run || typeof run.databaseId !== 'number' || typeof run.status !== 'string') return undefined
  }
  return { failedSteps: [], targetKey: '', ...(o as object) } as unknown as FollowLine
}

// Cuts a chunked stream into whole lines; `rest` is the unfinished tail.
export const splitLines = (buffer: string, chunk: string): { lines: string[]; rest: string } => {
  const parts = (buffer + chunk).split('\n')
  const rest = parts.pop() as string
  return { lines: parts.map(p => p.replace(/\r$/, '')).filter(p => p.trim() !== ''), rest }
}

export const isEnded = (run: Run): boolean => run.conclusion !== null && run.conclusion !== undefined && run.conclusion !== ''

export const attemptOf = (run: Run): number => run.attempt ?? 1

export const runName = (a: ActiveRun): string => a.run.workflowName || a.run.displayTitle || `run ${a.runId}`

export const runKey = (run: Run): string => `${run.databaseId}#${attemptOf(run)}`

const ms = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}

export const startOf = (a: ActiveRun): number => ms(a.run.startedAt) ?? ms(a.run.createdAt) ?? a.seenAt

export const formatDuration = (totalMs: number): string => {
  const s = Math.max(0, Math.round(totalMs / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const activeJobs = (jobs: Job[]): Job[] => jobs.filter(j => j.status !== 'completed')

export type Progress = { job?: Job; more: number; step?: Step; stepIndex: number; stepTotal: number; done: number; total: number }

export const progressOf = (run: Run): Progress => {
  const jobs = run.jobs ?? []
  const active = activeJobs(jobs)
  const job = active.find(j => j.status === 'in_progress') ?? active[0] ?? jobs[0]
  const steps = job?.steps ?? []
  const step = steps.find(s => s.status === 'in_progress') ?? steps.find(s => s.status !== 'completed')
  let done = 0
  let total = 0
  for (const j of jobs) {
    for (const s of j.steps ?? []) {
      total++
      if (s.status === 'completed') done++
    }
  }
  return {
    job,
    more: Math.max(0, active.length - 1),
    step,
    stepIndex: step ? step.number : 0,
    stepTotal: steps.length,
    done,
    total,
  }
}

export const bar = (done: number, total: number, width = 8): { filled: string; empty: string } => {
  const n = total > 0 ? Math.min(width, Math.round((done / total) * width)) : 0
  return { filled: '█'.repeat(n), empty: '░'.repeat(width - n) }
}

export type Segment = { text: string; color?: string; dim?: boolean; bold?: boolean; drop: number; id: string; href?: string }

export const sourceNote = (source: 'events' | 'poll'): string => (source === 'events' ? 'webhook' : 'polled')

export const statusColor = (status: string): { color?: string; dim?: boolean } =>
  status === 'in_progress' ? { color: 'suggestion' } : { dim: true }

// Drops whole segments, highest `drop` first, until the row fits; the rest is cut by the terminal.
export const fitSegments = (segs: Segment[], columns: number): Segment[] => {
  const width = (s: Segment[]) => s.reduce((n, x) => n + [...x.text].length, 0)
  let out = segs
  while (width(out) > columns) {
    const top = Math.max(...out.map(s => s.drop))
    if (top === 0) break
    const ids = new Set(out.filter(s => s.drop === top).map(s => s.id))
    out = out.filter(s => !ids.has(s.id))
  }
  return out
}

export const MAX_STEP_LINES = 12
export const MIN_ROWS = 24

// Expanded lines need a tall enough viewport; an unmeasured one is trusted.
export const canExpand = (rows: number | undefined): boolean => rows === undefined || rows >= MIN_ROWS

export const isDone = (s: { status?: string; conclusion: string | null }): boolean => s.status === 'completed'

// Mark and colour of a step or job: done green tick, failed red cross, running spinner, cancelled yellow, the rest dim.
export const stateMark = (status: string | undefined, conclusion: string | null | undefined, frame: number): { mark: string; color?: string; dim?: boolean } => {
  if (status === 'in_progress') return { mark: SPINNER[frame % SPINNER.length] as string, color: 'suggestion' }
  if (conclusion === 'success') return { mark: '✓', color: 'success' }
  if (conclusion === 'failure' || conclusion === 'startup_failure' || conclusion === 'action_required') return { mark: '✗', color: 'error' }
  if (conclusion === 'cancelled') return { mark: '⊘', color: 'warning' }
  if (conclusion === 'timed_out') return { mark: '✗', color: 'warning' }
  if (conclusion === 'skipped' || conclusion === 'neutral') return { mark: '-', dim: true }
  return { mark: '○', dim: true }
}

const cut = (text: string, width: number): string => {
  const chars = [...text]
  if (width <= 0) return ''
  if (chars.length <= width) return text
  return width === 1 ? '…' : `${chars.slice(0, width - 1).join('')}…`
}

// First step of the window: it holds every running or failed step when they fit, else the first running (or failed) one.
const windowStart = (steps: Step[], size: number): number => {
  const n = steps.length
  if (n <= size) return 0
  const running = steps.findIndex(s => s.status === 'in_progress')
  const hot = steps.flatMap((s, i) => (s.status === 'in_progress' || s.conclusion === 'failure' || s.conclusion === 'timed_out' ? [i] : []))
  const open = steps.findIndex(s => !isDone(s))
  const lo = hot.length ? Math.min(...hot) : open >= 0 ? open : n - 1
  const hi = hot.length ? Math.max(...hot) : lo
  const start = hi - lo < size ? lo - Math.floor((size - (hi - lo + 1)) / 2) : (running >= 0 ? running : lo) - Math.floor(size / 2)
  return Math.max(0, Math.min(start, n - size))
}

// ---- Groups and the tree ------------------------------------------------------------------------

export type Group = {
  id: string
  repo: string
  kind: TargetKind
  // `#17`, the branch, the short sha or `run <id>`
  ref: string
  href?: string
  runs: ActiveRun[]
}

const branchPath = (branch: string): string => branch.split('/').map(encodeURIComponent).join('/')

const groupOf = (t: Target): Omit<Group, 'runs'> => {
  const gh = `https://github.com/${t.repo}`
  if (t.kind === 'pr') return { id: targetId(t), repo: t.repo, kind: t.kind, ref: `#${t.value}`, href: `${gh}/pull/${t.value}` }
  if (t.kind === 'branch') return { id: targetId(t), repo: t.repo, kind: t.kind, ref: t.value, href: `${gh}/tree/${branchPath(t.value)}` }
  if (t.kind === 'commit') return { id: targetId(t), repo: t.repo, kind: t.kind, ref: t.value.slice(0, 7) }
  return { id: targetId(t), repo: t.repo, kind: t.kind, ref: `run ${t.value}` }
}

// Groups the active runs per repo and PR, else per repo and branch (gh-watcher's runs carry no head branch, so the target's own),
// else per commit. A run target joins the group of a PR, branch or commit target that follows the same run, and is a group of its own otherwise.
// Groups are ordered by their earliest start, runs within a group likewise.
export const groupRuns = (list: ActiveRun[]): Group[] => {
  const groups = new Map<string, Group>()
  const own = (a: ActiveRun) => {
    const g = groups.get(targetId(a.target)) ?? { ...groupOf(a.target), runs: [] }
    groups.set(g.id, g)
    if (!g.runs.some(r => r.key === a.key)) g.runs.push(a)
  }
  for (const a of list) if (a.target.kind !== 'run') own(a)
  for (const a of list) {
    if (a.target.kind !== 'run') continue
    const host = [...groups.values()].find(g => g.kind !== 'run' && g.repo.toLowerCase() === a.target.repo.toLowerCase() && g.runs.some(r => r.key === a.key))
    if (host) continue
    own(a)
  }
  const out = [...groups.values()]
  for (const g of out) g.runs.sort((x, y) => startOf(x) - startOf(y) || x.runId - y.runId)
  const first = (g: Group) => Math.min(...g.runs.map(startOf))
  return out.sort((x, y) => first(x) - first(y) || (x.id < y.id ? -1 : 1))
}

export type Summary = { total: number; done: number; failed: number; running: number; queued: number }

const QUEUED = new Set(['queued', 'waiting', 'pending', 'requested'])

export const summaryCounts = (g: Group): Summary => {
  const s: Summary = { total: g.runs.length, done: 0, failed: 0, running: 0, queued: 0 }
  for (const a of g.runs) {
    if (isEnded(a.run) || a.run.status === 'completed') {
      const c = a.run.conclusion
      if (c === 'success' || c === 'skipped' || c === 'neutral') s.done++
      else s.failed++
    } else if (QUEUED.has(a.run.status)) s.queued++
    else s.running++
  }
  return s
}

// Expansion keys, one set in state: `g:<group id>`, `r:<run id>`, `j:<run id>:<job name>`.
export const groupKey = (g: Group): string => `g:${g.id}`
export const expandKey = (a: ActiveRun): string => `r:${a.runId}`
export const jobKey = (a: ActiveRun, j: Job): string => `j:${a.runId}:${j.name}`

// Groups start expanded; runs and jobs start collapsed.
export const defaultExpanded = (groups: Group[]): string[] => groups.map(groupKey)

export const allKeys = (groups: Group[]): string[] =>
  groups.flatMap(g => [groupKey(g), ...g.runs.flatMap(a => [expandKey(a), ...(a.run.jobs ?? []).map(j => jobKey(a, j))])])

export const toggleKey = (list: string[], key: string): string[] => (list.includes(key) ? list.filter(x => x !== key) : [...list, key])

const dimOf = (look: { color?: string; dim?: boolean }) => ({ ...(look.color ? { color: look.color } : {}), ...(look.dim ? { dim: true } : {}) })

// The segments of a group row after its chevron; `drop` orders what goes first on a narrow band (higher first).
export const groupSegments = (g: Group, now: number, frame: number): Segment[] => {
  const sum = summaryCounts(g)
  const sep = (id: string, drop: number): Segment => ({ id: `sep:${id}`, text: ' │ ', dim: true, drop })
  const segs: Segment[] = []
  if (sum.done + sum.failed < sum.total) segs.push({ id: 'spin', text: `${SPINNER[frame % SPINNER.length]} `, color: 'suggestion', drop: 0 })
  segs.push({ id: 'repo', text: g.repo, dim: true, href: `https://github.com/${g.repo}`, drop: 4 }, { id: 'chev:ref', text: ' › ', dim: true, drop: 4 })
  segs.push({ id: 'ref', text: g.ref, bold: true, ...(g.href ? { href: g.href } : {}), drop: 0 })
  segs.push(sep('count', 5), { id: 'count', text: `${sum.total} run${sum.total === 1 ? '' : 's'}`, dim: true, drop: 5 })
  const parts: Pick<Segment, 'text' | 'color' | 'dim'>[] = []
  if (sum.done) parts.push({ text: `✓ ${sum.done} done`, color: 'success' })
  if (sum.failed) parts.push({ text: `✗ ${sum.failed} failed`, color: 'error' })
  if (sum.running) parts.push({ text: `${sum.running} running`, color: 'suggestion' })
  if (sum.queued) parts.push({ text: `${sum.queued} queued`, dim: true })
  if (parts.length) {
    segs.push(sep('sum', 3))
    parts.forEach((p, i) => segs.push({ id: i === 0 ? 'sum' : `sum${i}`, ...p, text: i === 0 ? p.text : ` ${p.text}`, drop: 3 }))
  }
  const start = Math.min(...g.runs.map(startOf))
  segs.push(sep('elapsed', 2), { id: 'elapsed', text: formatDuration(now - start), drop: 2 })
  return segs
}

// The segments of a run row after its chevron.
export const runSegments = (a: ActiveRun, now: number): Segment[] => {
  const p = progressOf(a.run)
  const look = statusColor(a.run.status)
  const sep = (id: string, drop: number): Segment => ({ id: `sep:${id}`, text: ' │ ', dim: true, drop })
  const segs: Segment[] = [{ id: 'wf', text: runName(a), bold: true, ...(a.run.url ? { href: a.run.url } : {}), drop: 0 }]
  if (QUEUED.has(a.run.status)) segs.push(sep('queued', 5), { id: 'queued', text: a.run.status, dim: true, drop: 5 })
  if (p.step && p.stepTotal > 0) segs.push(sep('step', 4), { id: 'step', text: `step ${p.stepIndex}/${p.stepTotal}`, drop: 4 })
  if (p.total > 0) {
    const b = bar(p.done, p.total)
    segs.push(sep('fill', 7), { id: 'fill', text: b.filled, ...look, drop: 7 })
    segs.push({ id: 'empty', text: b.empty, dim: true, drop: 7 })
  }
  segs.push(sep('elapsed', 2), { id: 'elapsed', text: formatDuration(now - startOf(a)), drop: 2 })
  segs.push(sep('updated', 8), { id: 'updated', text: `updated ${formatDuration(now - a.checkedAt)} ago ${sourceNote(a.source)}`, dim: true, drop: 8 })
  return segs
}

// The segments of a job row after its chevron: mark, name, then `step n/m` and the step name (`n/m` once it is done).
export const jobSegments = (j: Job, frame: number): Segment[] => {
  const look = stateMark(j.status, j.conclusion, frame)
  const steps = j.steps ?? []
  const sep = (id: string, drop: number): Segment => ({ id: `sep:${id}`, text: ' │ ', dim: true, drop })
  const segs: Segment[] = [
    { id: 'mark', text: `${look.mark} `, ...dimOf(look), drop: 0 },
    { id: 'name', text: j.name, ...(j.url ? { href: j.url } : {}), drop: 0 },
  ]
  if (!steps.length) return segs
  const current = j.status === 'completed' ? undefined : (steps.find(s => s.status === 'in_progress') ?? steps.find(s => !isDone(s)))
  if (current) {
    segs.push(sep('step', 2), { id: 'step', text: `step ${current.number}/${steps.length}`, drop: 2 })
    segs.push(sep('stepname', 3), { id: 'stepname', text: current.name, dim: true, drop: 3 })
  } else {
    segs.push(sep('step', 2), { id: 'step', text: `${steps.filter(isDone).length}/${steps.length}`, dim: true, drop: 2 })
  }
  return segs
}

export type TreeLine = {
  id: string
  kind: 'group' | 'run' | 'job' | 'step' | 'more'
  indent: number
  // key toggled by the chevron; group, run and job rows without anything to open have none
  toggle?: string
  isOpen: boolean
  segs: Segment[]
}

export const INDENT = { group: 0, run: 2, job: 6, step: 10 }
export const MAX_TREE_LINES = 30

// The visible lines of the whole tree, Group > runs > jobs > steps, each fitted to `columns`.
// A collapsed key hides what is below it; a short viewport (`isTall` false) shows no jobs or steps.
// At most `MAX_STEP_LINES` step lines and `MAX_TREE_LINES` lines in all, the rest counted in a last `+N more` line.
export const treeLines = (groups: Group[], open: readonly string[], now: number, frame: number, columns: number, isTall = true): TreeLine[] => {
  const isOpen = (k: string) => open.includes(k)
  const fit = (segs: Segment[], indent: number) => fitSegments(segs, columns - indent - 2)
  const rows: { line: TreeLine; step?: Step }[] = []
  for (const g of groups) {
    const gk = groupKey(g)
    const gOpen = isOpen(gk)
    rows.push({ line: { id: gk, kind: 'group', indent: INDENT.group, toggle: gk, isOpen: gOpen, segs: fit(groupSegments(g, now, frame), INDENT.group) } })
    if (!gOpen) continue
    for (const a of g.runs) {
      const rk = expandKey(a)
      const jobs = a.run.jobs ?? []
      const rOpen = isOpen(rk)
      rows.push({
        line: { id: `${gk}/${rk}`, kind: 'run', indent: INDENT.run, ...(jobs.length ? { toggle: rk } : {}), isOpen: rOpen && jobs.length > 0, segs: fit(runSegments(a, now), INDENT.run) },
      })
      if (!rOpen || !isTall) continue
      for (const j of jobs) {
        const jk = jobKey(a, j)
        const steps = j.steps ?? []
        const jOpen = isOpen(jk)
        rows.push({
          line: { id: `${gk}/${jk}`, kind: 'job', indent: INDENT.job, ...(steps.length ? { toggle: jk } : {}), isOpen: jOpen && steps.length > 0, segs: fit(jobSegments(j, frame), INDENT.job) },
        })
        if (!jOpen) continue
        for (const s of steps) {
          const sl = stateMark(s.status, s.conclusion, frame)
          const room = columns - INDENT.step - 2
          rows.push({
            step: s,
            line: {
              id: `${gk}/${jk}/s${s.number}`,
              kind: 'step',
              indent: INDENT.step,
              isOpen: false,
              segs: [
                { id: 'mark', text: `${sl.mark} `, ...dimOf(sl), drop: 0 },
                { id: 'name', text: cut(`${s.number} ${s.name}`, room), ...(sl.dim ? { dim: true } : {}), drop: 0 },
              ],
            },
          })
        }
      }
    }
  }
  const stepRows = rows.filter(r => r.step)
  const start = windowStart(stepRows.map(r => r.step as Step), MAX_STEP_LINES)
  const keep = new Set(stepRows.slice(start, start + MAX_STEP_LINES))
  let hidden = stepRows.length - keep.size
  let lines = rows.filter(r => !r.step || keep.has(r)).map(r => r.line)
  if (lines.length > MAX_TREE_LINES - (hidden > 0 ? 1 : 0)) {
    const room = MAX_TREE_LINES - 1
    hidden += lines.length - room
    lines = lines.slice(0, room)
  }
  if (hidden > 0) lines.push({ id: 'more', kind: 'more', indent: INDENT.step, isOpen: false, segs: [{ id: 'more', text: cut(`+${hidden} more`, columns - INDENT.step), dim: true, drop: 0 }] })
  return lines
}

export const NOTICE_PREFIX = '[gh-runs]'

export const conclusionColor = (conclusion: string): { color?: string; dim?: boolean } => {
  if (conclusion === 'success') return { color: 'success' }
  if (conclusion === 'skipped' || conclusion === 'neutral') return { dim: true }
  if (conclusion === 'cancelled' || conclusion === 'timed_out') return { color: 'warning' }
  return { color: 'error' }
}

export const noticeDuration = (a: ActiveRun): number => {
  const end = ms(a.run.updatedAt) ?? a.checkedAt
  return Math.max(0, end - startOf(a))
}

// The one text block of a finished run's chat item.
export const noticeText = (a: ActiveRun, failed: string[]): string => {
  const conclusion = a.run.conclusion ?? 'unknown'
  const lines = [
    `${NOTICE_PREFIX} ${conclusion}  ${a.run.workflowName || `run ${a.runId}`}  ${targetLabel(a.target)}  ${formatDuration(noticeDuration(a))}`,
  ]
  if (failed.length) lines.push(`failed: ${failed.join(', ')}`)
  lines.push(a.run.url)
  return lines.join('\n')
}

// `<run id>-<attempt>`: names a result in state and the row placed for it (a placed id allows letters, digits, `_` and `-`).
export const resultKey = (a: ActiveRun): string => `${a.runId}-${a.attempt}`

export const summaryOf = (a: ActiveRun, failed: string[]): Result => ({
  conclusion: a.run.conclusion ?? 'unknown',
  workflow: a.run.workflowName || `run ${a.runId}`,
  repo: a.target.repo,
  target: targetLabel(a.target),
  duration: formatDuration(noticeDuration(a)),
  failed,
  url: a.run.url,
  text: noticeText(a, failed),
})

export const failedStepNames = (run: Run, line: FollowLine): string[] => {
  const names: string[] = []
  for (const j of run.jobs ?? []) {
    for (const s of j.steps ?? []) if (s.conclusion === 'failure') names.push(`${j.name} / ${s.name}`)
  }
  if (names.length) return names
  return line.failedSteps.filter(f => f.stepName && (f.runId === undefined || f.runId === run.databaseId)).map(f => `${f.jobName} / ${f.stepName}`)
}
