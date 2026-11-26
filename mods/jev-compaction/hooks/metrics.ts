/**
 * Prometheus counters of this mod, written to a node-exporter textfile directory.
 *
 * Every Claude process writes its own series (label `pid`) into one shared file, so no two processes need a lock: a process reads the
 * file, replaces its own lines, keeps the lines of the others, and writes it back. Two writers at the same instant can lose one update;
 * the next event of the loser writes its whole section again, and counters only grow, so nothing stays wrong. The lines of a process that
 * has ended stay for an hour (a short burst of failures must still be inside the alert window), then the next writer removes them.
 *
 * Series (all counters except the timestamp):
 *   jev_compaction_requests_total{pid,status}           every Jev request by its HTTP status (`200`), `timeout` or `other`
 *   jev_compaction_failures_total{pid,status,error_type} the failed ones; error_type is Jev's `detail.error_type` or `none`
 *   jev_compaction_deferred_total{pid,reason}           compactions that were not applied and left the conversation alone
 *   jev_compaction_updated_timestamp_seconds{pid}       gauge, when this process last wrote
 *
 * The usual series start at 0 with the process, so a first failure counts in `increase()`.
 */
export const METRICS_FILE = 'jev_compaction.prom'
export const DEFAULT_METRICS_DIR = '/var/lib/node-exporter/textfile-collector'
/** How long the lines of an ended process stay in the file. */
export const KEEP_ENDED_SECONDS = 3600

export type MetricsFs = {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<unknown>
  exists(path: string): Promise<boolean>
}

export type Counts = {
  requests: Record<string, number>
  /** Key `<status>|<error_type>`. */
  failures: Record<string, number>
  deferred: Record<string, number>
}

const KNOWN_STATUSES = ['200', '400', '401', '403', '429', '500', '502', '503', 'timeout', 'other']
const KNOWN_FAILURES = ['400|max_tokens_exceeded', '400|api_usage_error', '400|none', '401|none', '403|none', '429|none', '500|none', '502|none', '503|none', 'timeout|none', 'other|none']
const KNOWN_DEFERRED = ['frees_too_little', 'jev_error', 'no_key']

export function emptyCounts(): Counts {
  return {
    requests: Object.fromEntries(KNOWN_STATUSES.map((s) => [s, 0])),
    failures: Object.fromEntries(KNOWN_FAILURES.map((s) => [s, 0])),
    deferred: Object.fromEntries(KNOWN_DEFERRED.map((s) => [s, 0])),
  }
}

export const bumpCount = (table: Record<string, number>, key: string) => {
  table[key] = (table[key] ?? 0) + 1
}

/** A label value: Prometheus text format escapes backslash, quote and newline. The values here are short ASCII names already. */
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
const safe = (v: string) => v.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 60) || 'none'

/** The lines of one process. */
export function renderSection(pid: string, counts: Counts, nowSeconds: number): string[] {
  const out: string[] = []
  for (const [status, n] of Object.entries(counts.requests)) out.push(`jev_compaction_requests_total{pid="${pid}",status="${esc(safe(status))}"} ${n}`)
  for (const [key, n] of Object.entries(counts.failures)) {
    const [status = 'other', errorType = 'none'] = key.split('|')
    out.push(`jev_compaction_failures_total{pid="${pid}",status="${esc(safe(status))}",error_type="${esc(safe(errorType))}"} ${n}`)
  }
  for (const [reason, n] of Object.entries(counts.deferred)) out.push(`jev_compaction_deferred_total{pid="${pid}",reason="${esc(safe(reason))}"} ${n}`)
  out.push(`jev_compaction_updated_timestamp_seconds{pid="${pid}"} ${nowSeconds}`)
  return out
}

const HEADER = [
  '# HELP jev_compaction_requests_total Jev compaction requests by HTTP status, "timeout" or "other".',
  '# TYPE jev_compaction_requests_total counter',
  '# HELP jev_compaction_failures_total Failed Jev compaction requests by status and Jev error_type.',
  '# TYPE jev_compaction_failures_total counter',
  '# HELP jev_compaction_deferred_total Compactions that were not applied (conversation left alone), by reason.',
  '# TYPE jev_compaction_deferred_total counter',
  '# HELP jev_compaction_updated_timestamp_seconds When the process last wrote its counters.',
  '# TYPE jev_compaction_updated_timestamp_seconds gauge',
]

const PID_OF = /\{pid="(\d+)"/

/**
 * The file after this process writes its section: the lines of other processes stay, unless that process has ended and wrote more than
 * `KEEP_ENDED_SECONDS` ago. `alive` says whether a pid still runs.
 */
export async function mergeFile(existing: string, pid: string, section: string[], nowSeconds: number, alive: (pid: string) => Promise<boolean>): Promise<string> {
  const others = new Map<string, string[]>()
  for (const line of existing.split('\n')) {
    const m = PID_OF.exec(line)
    if (!m || line.startsWith('#')) continue
    if (m[1] === pid) continue
    const list = others.get(m[1]!) ?? []
    list.push(line)
    others.set(m[1]!, list)
  }
  const kept: string[] = []
  for (const [other, lines] of others) {
    const stamp = lines.find((l) => l.startsWith('jev_compaction_updated_timestamp_seconds'))
    const at = stamp ? Number(stamp.slice(stamp.lastIndexOf(' ') + 1)) : 0
    if (nowSeconds - at > KEEP_ENDED_SECONDS && !(await alive(other))) continue
    kept.push(...lines)
  }
  return `${[...HEADER, ...kept, ...section].join('\n')}\n`
}

/** Writes the counters. Never throws, and does nothing when the directory does not exist (a pod without the mount). */
export async function writeMetrics(fs: MetricsFs, dir: string, pid: string, counts: Counts, nowSeconds: number): Promise<boolean> {
  try {
    if (!(await fs.exists(dir))) return false
    const path = `${dir.replace(/\/+$/, '')}/${METRICS_FILE}`
    const existing = await fs.read(path).then(String, () => '')
    const text = await mergeFile(existing, pid, renderSection(pid, counts, nowSeconds), nowSeconds, (p) => fs.exists(`/proc/${p}`).catch(() => true))
    await fs.write(path, text)
    return true
  } catch {
    return false
  }
}

/** The bounded `reason` label of a deferral, from its free text. */
export function deferReason(text: string): string {
  if (/^frees only/.test(text)) return 'frees_too_little'
  if (/no Jev API key/.test(text)) return 'no_key'
  return 'jev_error'
}
