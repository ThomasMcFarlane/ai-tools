/**
 * Prometheus counters of this mod, written to a node-exporter textfile directory.
 *
 * One file for each process: `jev_compaction_<host>_<pid>-<start>.prom`. No process ever reads, changes or writes the file of another,
 * so there is no lock and no lost update. A file is written whole to `<name>.tmp` and then renamed over its name (`mv`), so node-exporter
 * never reads a cut file. Where the host cannot run `mv`, the file is written in place: still one writer for each file.
 *
 * Every series carries `host` (the host or pod name, so two pods on one node never meet) and `process` (`<pid>-<start time in clock
 * ticks>`, so a reused pid is a new process). The series of a process are added at its start, at 0, so a first failure counts in
 * `increase()`, and they stay in the file until the file is older than `MAX_AGE_SECONDS`: the next process that starts or writes removes
 * it (`rm`, or an empty file where `rm` is not possible). A process that is still alive and was idle that long writes its whole file
 * again at its next event, because its counts live in memory.
 *
 * Series (all counters except the timestamp):
 *   jev_compaction_requests_total{host,process,status}              every Jev request by its HTTP status, `timeout` or `other`
 *   jev_compaction_failures_total{host,process,status,error_type}   the failed ones; error_type is Jev's `detail.error_type` or `none`
 *   jev_compaction_deferred_total{host,process,reason}              compactions that were not applied and left the conversation alone
 *   jev_compaction_updated_timestamp_seconds{host,process}          gauge, when this process last wrote
 *
 * Cardinality: a process starts with 15 series (4 request statuses, 5 failures, 5 deferral reasons, the timestamp). A status that is not
 * in that list adds its series when it first happens, and at most `MAX_KEYS` distinct keys exist in one table. So each process adds 15
 * to about 35 series for good in VictoriaMetrics, and 15 on a quiet day. At 100 to 300 processes a day on a host that is 1500 to 4500
 * new series a day (`count(count by (host, process) (jev_compaction_updated_timestamp_seconds))` after a week shows the real figure).
 */
export const FILE_PREFIX = 'jev_compaction_'
export const DEFAULT_METRICS_DIR = '/var/lib/node-exporter/textfile-collector'
/** A file that nothing wrote for this long belongs to an ended process, whatever `/proc` says: it is removed. Longer than the 30 minute alert window. */
export const MAX_AGE_SECONDS = 24 * 3600
/** How often a process looks for old files. */
export const PRUNE_EVERY_SECONDS = 3600
/** Most distinct keys in one counter table: a status or an error type Jev invents cannot grow the series without bound. */
export const MAX_KEYS = 20

export type MetricsIo = {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<unknown>
  exists(path: string): Promise<boolean>
  list(path: string): Promise<{ name: string; kind: string; size: number; mtimeMs: number }[]>
  /** Runs a command by its argument vector; resolves its exit code. Rejects when the host cannot run commands. */
  run(argv: readonly string[]): Promise<{ exitCode: number }>
}

export type Counts = {
  requests: Record<string, number>
  /** Key `<status>|<error_type>`. */
  failures: Record<string, number>
  deferred: Record<string, number>
}

const KNOWN_STATUSES = ['200', '400', 'timeout', 'other']
const KNOWN_FAILURES = ['400|max_tokens_exceeded', '400|api_usage_error', '400|none', 'timeout|none', 'other|none']
const KNOWN_DEFERRED = ['frees_too_little', 'jev_error', 'no_key', 'transcript_cut', 'rotation_skipped']

export function emptyCounts(): Counts {
  return {
    requests: Object.fromEntries(KNOWN_STATUSES.map((s) => [s, 0])),
    failures: Object.fromEntries(KNOWN_FAILURES.map((s) => [s, 0])),
    deferred: Object.fromEntries(KNOWN_DEFERRED.map((s) => [s, 0])),
  }
}

/** Adds one. A key the table has not seen, when the table is full, counts under `fallback` instead. */
export const bumpCount = (table: Record<string, number>, key: string, fallback = 'other') => {
  const at = key in table || Object.keys(table).length < MAX_KEYS ? key : fallback
  table[at] = (table[at] ?? 0) + 1
}

/** A label value: Prometheus text format escapes backslash, quote and newline. The values here are short ASCII names already. */
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
const safe = (v: string) => v.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 60) || 'none'

export type ProcessId = { host: string; process: string; file: string }

/** The pid and the start time (field 22, clock ticks since boot) from `/proc/<pid>/stat`; the command name in it may hold spaces and brackets. */
export function parseStat(stat: string): { pid: string; start: string } | undefined {
  const close = stat.lastIndexOf(')')
  const pid = /^\s*(\d+)\s/.exec(stat)?.[1]
  const start = stat.slice(close + 1).trim().split(/\s+/)[19]
  return close > 0 && pid && start && /^\d+$/.test(start) ? { pid, start } : undefined
}

/**
 * Who this process is. `stat` is its `/proc/self/stat` and `random` a source of a unique word, used when the stat cannot be read, so no
 * two processes ever share an identity.
 */
export function processId(host: string, stat: string | undefined, random: () => string): ProcessId {
  const parsed = stat === undefined ? undefined : parseStat(stat)
  const process = parsed ? `${parsed.pid}-${parsed.start}` : `r${safe(random()).replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'x'}`
  const h = safe(host).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48) || 'host'
  return { host: h, process, file: `${FILE_PREFIX}${h}_${process}.prom` }
}

/** The lines of one process. */
export function renderFile(id: ProcessId, counts: Counts, nowSeconds: number): string {
  const base = `host="${esc(id.host)}",process="${esc(id.process)}"`
  const out: string[] = [
    '# HELP jev_compaction_requests_total Jev compaction requests by HTTP status, "timeout" or "other".',
    '# TYPE jev_compaction_requests_total counter',
  ]
  for (const [status, n] of Object.entries(counts.requests)) out.push(`jev_compaction_requests_total{${base},status="${esc(safe(status))}"} ${n}`)
  out.push('# HELP jev_compaction_failures_total Failed Jev compaction requests by status and Jev error_type.', '# TYPE jev_compaction_failures_total counter')
  for (const [key, n] of Object.entries(counts.failures)) {
    const [status = 'other', errorType = 'none'] = key.split('|')
    out.push(`jev_compaction_failures_total{${base},status="${esc(safe(status))}",error_type="${esc(safe(errorType))}"} ${n}`)
  }
  out.push('# HELP jev_compaction_deferred_total Compactions that were not applied (conversation left alone), by reason.', '# TYPE jev_compaction_deferred_total counter')
  for (const [reason, n] of Object.entries(counts.deferred)) out.push(`jev_compaction_deferred_total{${base},reason="${esc(safe(reason))}"} ${n}`)
  out.push('# HELP jev_compaction_updated_timestamp_seconds When the process last wrote its counters.', '# TYPE jev_compaction_updated_timestamp_seconds gauge')
  out.push(`jev_compaction_updated_timestamp_seconds{${base}} ${nowSeconds}`)
  return `${out.join('\n')}\n`
}

const dirPath = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`

/** Writes `text` to `path` so a reader never sees half of it: to `<path>.tmp`, then `mv`. Falls back to a write in place. */
export async function writeAtomic(io: MetricsIo, path: string, text: string): Promise<'renamed' | 'in place'> {
  const tmp = `${path}.tmp`
  try {
    await io.write(tmp, text)
    const { exitCode } = await io.run(['mv', '-f', '--', tmp, path])
    if (exitCode === 0) return 'renamed'
  } catch {
    // no `mv` here: write in place below
  }
  await io.write(path, text)
  return 'in place'
}

/** Writes the counters of this process. Never throws, and does nothing when the directory does not exist (a pod without the mount). */
export async function writeMetrics(io: MetricsIo, dir: string, id: ProcessId, counts: Counts, nowSeconds: number): Promise<boolean> {
  try {
    if (!(await io.exists(dir))) return false
    await writeAtomic(io, dirPath(dir, id.file), renderFile(id, counts, nowSeconds))
    return true
  } catch {
    return false
  }
}

/** Removes a file: `rm`, else an empty file (a valid textfile with no series). */
async function remove(io: MetricsIo, path: string): Promise<boolean> {
  try {
    if ((await io.run(['rm', '-f', '--', path])).exitCode === 0) return true
  } catch {
    // no `rm` here
  }
  try {
    await io.write(path, '')
    return true
  } catch {
    return false
  }
}

/**
 * Removes the files of this mod that nothing wrote for `MAX_AGE_SECONDS` (and the leftovers of a write that died between the temp file and
 * the rename), whether or not the process behind them still runs. Never the own file. Answers how many it removed; never throws.
 */
export async function pruneMetrics(io: MetricsIo, dir: string, own: ProcessId, nowMs: number): Promise<number> {
  let removed = 0
  try {
    for (const e of await io.list(dir)) {
      const ours = e.name.startsWith(FILE_PREFIX) && (e.name.endsWith('.prom') || e.name.endsWith('.prom.tmp'))
      if (e.kind !== 'file' || !ours || e.name === own.file || e.name === `${own.file}.tmp`) continue
      if (e.mtimeMs <= 0 || nowMs - e.mtimeMs <= MAX_AGE_SECONDS * 1000) continue
      // An empty file is what a removal leaves where `rm` is not possible: it holds no series, so leave it alone.
      if (e.size === 0 && e.name.endsWith('.prom')) continue
      if (await remove(io, dirPath(dir, e.name))) removed++
    }
  } catch {
    // best effort
  }
  return removed
}

/** The bounded `reason` label of a deferral, from its free text. */
export function deferReason(text: string): string {
  if (/^frees only/.test(text)) return 'frees_too_little'
  if (/no Jev API key/.test(text)) return 'no_key'
  return 'jev_error'
}
