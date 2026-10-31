import type { ActiveRun, FollowLine, Job, Run, Step, Target, TargetKind } from '../types'

export type { ActiveRun, FollowLine, Job, Run, Step, Target, TargetKind }

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

export const USAGE = 'Usage: /ci-track <PR URL | run URL | owner/repo#123 | owner/repo 123>'

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
      if (s.status === 'completed' || s.conclusion !== null) done++
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

export type Segment = { text: string; color?: string; dim?: boolean; bold?: boolean; drop: number; id: string }

export const sourceNote = (source: 'events' | 'poll'): string => (source === 'events' ? 'webhook' : 'polled')

export const statusColor = (status: string): { color?: string; dim?: boolean } =>
  status === 'in_progress' ? { color: 'suggestion' } : { dim: true }

// The segments of one band row; `drop` orders what goes first on a narrow band (higher first).
export const rowSegments = (a: ActiveRun, now: number, frame: number): Segment[] => {
  const p = progressOf(a.run)
  const look = statusColor(a.run.status)
  const segs: Segment[] = [
    { id: 'spin', text: `${SPINNER[frame % SPINNER.length]} `, ...look, drop: 0 },
    { id: 'wf', text: a.run.workflowName || `run ${a.runId}`, bold: true, drop: 0 },
    { id: 'target', text: `  ${targetLabel(a.target)}`, dim: true, drop: 3 },
  ]
  if (a.run.status === 'queued' || a.run.status === 'waiting' || a.run.status === 'pending') {
    segs.push({ id: 'queued', text: `  ${a.run.status}`, dim: true, drop: 5 })
  }
  if (p.job) {
    segs.push({ id: 'job', text: `  ${p.job.name}${p.more > 0 ? ` +${p.more} job${p.more === 1 ? '' : 's'}` : ''}`, drop: 1 })
  }
  if (p.step && p.stepTotal > 0) {
    segs.push({ id: 'step', text: `  step ${p.stepIndex}/${p.stepTotal}`, drop: 4 })
    segs.push({ id: 'stepname', text: ` ${p.step.name}`, dim: true, drop: 6 })
  }
  if (p.total > 0) {
    const b = bar(p.done, p.total)
    segs.push({ id: 'fill', text: `  ${b.filled}`, ...look, drop: 7 })
    segs.push({ id: 'empty', text: b.empty, dim: true, drop: 7 })
  }
  segs.push({ id: 'elapsed', text: `  ${formatDuration(now - startOf(a))}`, drop: 2 })
  segs.push({
    id: 'updated',
    text: `  updated ${formatDuration(now - a.checkedAt)} ago ${sourceNote(a.source)}`,
    dim: true,
    drop: 8,
  })
  return segs
}

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

// Reads a notice back from its text, tolerating a surface that flattens the lines.
export const parseNotice = (text: string): { conclusion: string; head: string; failed?: string; url?: string } | undefined => {
  const t = text.trim()
  if (!t.startsWith(`${NOTICE_PREFIX} `)) return undefined
  const m = /^\[gh-runs\] (\S+)\s*([\s\S]*?)(?:\s+failed: ([\s\S]*?))?(?:\s+(https?:\/\/\S+))?\s*$/.exec(t)
  if (!m) return undefined
  const [, conclusion = '', head = '', failed, url] = m
  return { conclusion, head, ...(failed ? { failed } : {}), ...(url ? { url } : {}) }
}

export const failedStepNames = (run: Run, line: FollowLine): string[] => {
  const names: string[] = []
  for (const j of run.jobs ?? []) {
    for (const s of j.steps ?? []) if (s.conclusion === 'failure') names.push(`${j.name} / ${s.name}`)
  }
  if (names.length) return names
  return line.failedSteps.filter(f => f.stepName && (f.runId === undefined || f.runId === run.databaseId)).map(f => `${f.jobName} / ${f.stepName}`)
}
