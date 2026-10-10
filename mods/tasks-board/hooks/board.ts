import type { TasksBoardTask } from '../types'

// An explicit upper-case ETA token (not part of a word or path), then `:`/`=` or a digit/`~`, then a time-like value.
const ETA = /(?<![-_/.A-Za-z])ETA(?:\s*[:=]\s*|\s+(?=[\d~]))((?:[\d~]|[Tt]oday|[Tt]omorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^.;|]{0,39})/

export const extractEta = (notes: string): string => ETA.exec(notes)?.[1]?.trim() ?? ''
// Explicit owner-gate phrases; a bare "owner" or "approve" in long notes does not make a row blocked on you.
// `names` are the people (besides "the owner") whose decision a row may wait on.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const gateCache = new Map<string, RegExp>()
export function ownerGate(names: string[]): RegExp {
  const key = names.join('|')
  let re = gateCache.get(key)
  if (!re) {
    const who = ['owner', ...names.map(escapeRe)].join('|')
    const named = names.length > 0 ? `|(${names.map(escapeRe).join('|')}) (to|must|needs to) (decide|approve|confirm|choose)` : ''
    re = new RegExp(
      `owner action|owner decision|owner approval|owner\\/user[- ]choice|needs (the )?owner|waiting (on|for) (the )?(${who})|awaiting (${who}|approval from)|blocked on (the )?(${who})|user[- ]choice gate${named}`,
      'i',
    )
    gateCache.set(key, re)
  }
  return re
}

// PZ-001, CF-EMAIL-ROUTING-01, F10, 65, 12a, 3.2.1
const ID = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|[A-Z]{1,4}\d+[a-z]?|\d+(?:\.\d+)+|\d+[a-z]?)$/

/** Statuses are grouped as in_progress / blocked / todo / parked / done; anything unknown counts as todo. */
export const normaliseStatus = (s: string): string => {
  // The leading phrase decides: `done (merged #337)`, `done - published as v1`, `merged via PR [#35](…)`, `open, not started`.
  const bare = s.replace(/\*\*|~~|`/g, '').trim().replace(/^[*_]+|[*_]+$/g, '')
  const lead = bare.split(/\s*(?:\(|—|–|,|:|;|\s-\s)/)[0]!
  const k = lead.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (/^(in_progress|in_review|review|partly|doing|in_pr$|in_pr_|pr_(#?\d+_)?open)/.test(k)) return 'in_progress'
  if (k === 'parked') return 'parked'
  if (k.startsWith('blocked') || k.startsWith('waiting_on') || k.startsWith('on_hold')) return 'blocked'
  if (DONE_WORDS.includes(k.split('_')[0]!) || DONE_PHRASES.some(p => k === p || k.startsWith(`${p}_`))) return 'done'
  return 'todo'
}

const DONE_PHRASES = ['not_applicable', 'n/a', 'client_side_done', 'root_cause_fixed', 'runtime_validated', 're_landed']
const DONE_WORDS = ['rejected', 'declined', 'deployed', 'configured', 'done', 'complete', 'completed', 'closed', 'merged', 'recorded', 'published', 'accepted', 'fixed', 'shipped', 'released', 'resolved', 'superseded', 'implemented', 'dropped', 'cancelled', 'canceled', "won't"]

// Splits on unescaped pipes only; `\|` inside a cell is a literal pipe.
const cells = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/(?<!\\)\|\s*$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))

/** A table row with no closing pipe continues on the following lines until one ends with a pipe; they are joined with a space. */
export function joinRowsNumbered(lines: string[]): { text: string; no: number }[] {
  const out: { text: string; no: number }[] = []
  let buf: { text: string; no: number } | undefined
  lines.forEach((line, i) => {
    if (buf !== undefined) {
      if (line.trim() !== '' && !line.startsWith('|') && !/^#{1,6}\s/.test(line)) {
        buf.text += ` ${line.trim()}`
        if (/(?<!\\)\|\s*$/.test(line)) {
          out.push(buf)
          buf = undefined
        }
        return
      }
      out.push(buf) // the row never closed: keep what there is
      buf = undefined
    }
    if (line.startsWith('|') && !/(?<!\\)\|\s*$/.test(line)) buf = { text: line, no: i + 1 }
    else out.push({ text: line, no: i + 1 })
  })
  if (buf !== undefined) out.push(buf)
  return out
}

export const joinRows = (lines: string[]): string[] => joinRowsNumbered(lines).map(l => l.text)

type Cols = { id: number; task: number; status: number; owner: number; depends: number; eta: number; branch: number; notes: number }

/** Maps a table's header to its columns by name; tables that are not task tables (no #/id, task/title and status) give none. */
function columnsOf(c: string[]): Cols | undefined {
  const at = (re: RegExp) => c.findIndex(x => re.test(x))
  const id = at(/^(#|id)$/i)
  const task = at(/^(task|title|workstream)/i)
  const status = at(/^status/i)
  if (id < 0 || task < 0 || status < 0) return undefined
  const notes = at(/^(notes|acceptance)/i)
  return { id, task, status, owner: at(/^(owner|picked up by|assignee|agent)/i), depends: at(/^depend/i), eta: at(/^eta/i), branch: at(/^branch/i), notes: notes < 0 ? c.length - 1 : notes }
}

const PROGRESS_ITEM = /Pending: live|pending live|in progress|\bPR #\d+/i
const ITEM_ID = /^(#\d+|[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|P\d+)(?::|\s|$)/

/** A checklist item (`- [ ] …` plus its indented continuation lines) as a task. */
function checklistTask(
  isDone: boolean,
  text: string,
  epic: string,
  section: number,
  item: number,
  taken: Set<string>,
  gate: RegExp,
): TasksBoardTask {
  const m = ITEM_ID.exec(text)
  const token = m && !taken.has(m[1]!) ? m[1]! : ''
  const id = token || `${section}.${item}`
  taken.add(id)
  const body = token ? text.slice(token.length).replace(/^[:\s]+/, '') : text
  const cut = body.slice(20).search(/[.:]\s/)
  const title = (cut < 0 ? body : body.slice(0, 20 + cut)).slice(0, 120)
  const ownerItem = !isDone && gate.test(text)
  const status = isDone ? 'done' : ownerItem ? 'blocked' : PROGRESS_ITEM.test(text) ? 'in_progress' : 'todo'
  return {
    id,
    key: id,
    n: Number(/(\d+)$/.exec(id)?.[1] ?? item),
    title,
    status,
    owner: '',
    agent: '',
    depends: '',
    notes: text,
    epic,
    eta: extractEta(text),
    line: text,
    ...(ownerItem ? { onOwner: true } : {}),
  }
}

export function parseBoard(text: string, opts: { ownerNames?: string[] } = {}): TasksBoardTask[] {
  const names = (opts.ownerNames ?? []).map(n => n.toLowerCase())
  const gate = ownerGate(opts.ownerNames ?? [])
  // Canonical vocabulary: only an explicit `blocked_on_owner` status means owner-blocked.
  const canonical = /\|\s*blocked_on_owner\s*\|/.test(text) || lintBoard(text).canonical
  const tasks: TasksBoardTask[] = []
  let epic = ''
  let parent = '' // the current `##` heading, inherited by its `###` sub-sections
  let col: Cols | undefined
  let section = 0
  let item = 0
  let pending: { isDone: boolean; text: string } | undefined
  const taken = new Set<string>()
  const flush = () => {
    if (pending) tasks.push(checklistTask(pending.isDone, pending.text, epic, section, item, taken, gate))
    pending = undefined
  }
  let prev: string[] = []
  for (const line of joinRows(text.split('\n'))) {
    const h = /^(#{2,3})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      const name = h[2]!.trim().replace(/^Active:\s*/, '').replace(/(?:,\s*|\s*\()\d{4}-\d{2}-\d{2}\)?$/, '')
      if (h[1] === '##') parent = epic = name
      // A `###` under a numbered `##` keeps the parent's number, so epicLabel still finds it.
      else epic = /^\d+\.\s+\S/.test(parent) ? `${parent} › ${name}` : name
      section += 1
      item = 0
      continue
    }
    const box = /^- \[( |x|X)\]\s*(.*)$/.exec(line)
    if (box) {
      flush()
      item += 1
      pending = { isDone: box[1] !== ' ', text: box[2]!.trim() }
      continue
    }
    if (pending) {
      if (/^\s+\S/.test(line)) {
        pending.text += ` ${line.trim()}`
        continue
      }
      flush() // a blank or unindented line ends the item
    }
    // Blank lines and prose may sit between a table's rows (the real boards have them), so only
    // another table's header changes the columns.
    if (!line.startsWith('|')) continue
    const c = cells(line)
    const before = prev
    prev = c
    if (/^(#|id)$/i.test(c[0] ?? '')) {
      col = columnsOf(c)
      continue
    }
    // A separator row starts a new table: if its header is not a task table, rows below are not tasks.
    if (c.length > 0 && c.every(x => /^:?-{2,}:?$/.test(x))) {
      if (!/^(#|id)$/i.test(before[0] ?? '')) col = undefined
      continue
    }
    const id = c[col?.id ?? 0] ?? ''
    if (!col || !ID.test(id)) continue
    const owner = col.owner < 0 ? '' : (c[col.owner] ?? '')
    const notes = c.slice(col.notes).join(' | ')
    const status = normaliseStatus(c[col.status] ?? '')
    tasks.push({
      id,
      key: id,
      n: Number(/(\d+)[a-z]?$/.exec(id)?.[1] ?? 0),
      title: c[col.task] ?? '',
      status,
      owner,
      agent: owner.split(' (')[0]!.trim(),
      depends: col.depends < 0 ? '' : (c[col.depends] ?? ''),
      notes,
      epic,
      eta: (col.eta >= 0 ? c[col.eta] : '') || extractEta(notes),
      line,
      ...(col.branch >= 0 && c[col.branch] ? { branch: c[col.branch] } : {}),
      ...(isOwnerGate(c[col.status] ?? '', status, notes, gate, canonical, names.includes(owner.split(' (')[0]!.trim().toLowerCase())) ? { onOwner: true } : {}),
    })
  }
  flush()
  // A repeated id keeps its first row's key; later ones are `id#2`, `id#3` in file order.
  const seen = new Map<string, number>()
  for (const t of tasks) {
    const n = (seen.get(t.id) ?? 0) + 1
    seen.set(t.id, n)
    t.key = n === 1 ? t.id : `${t.id}#${n}`
  }
  return tasks
}

/** Decided at parse time, from the whole status and notes (state keeps clipped notes). */
const isOwnerGate = (rawStatus: string, status: string, notes: string, gate: RegExp, canonical: boolean, isNamed: boolean): boolean =>
  /^blocked[\s_-]+on[\s_-]+owner/i.test(rawStatus) || (!canonical && status === 'blocked' && (isNamed || gate.test(`${rawStatus} ${latestUpdate(notes)}`)))

/** The newest dated update (`2026-10-10 …`) in the notes, up to the next date; the whole notes if none is dated. */
export function latestUpdate(notes: string): string {
  const ds = [...notes.matchAll(/\d{4}-\d{2}-\d{2}/g)]
  if (ds.length === 0) return notes
  let best = 0
  ds.forEach((d, i) => { if (d[0] >= ds[best]![0]) best = i })
  return notes.slice(ds[best]!.index, ds[best + 1]?.index)
}

export const isBlockedOnYou = (t: TasksBoardTask): boolean =>
  t.status === 'blocked' && t.onOwner === true // a bare `owner` in the Owner column means nobody has picked it up

/** Task ids (`| 65 |` or `| PZ-001 |` at a line start) in a piece of edited text. */
export const rowIds = (text: string): string[] =>
  [...text.matchAll(/^\s*\|\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|[A-Z]{1,4}\d+[a-z]?|\d+(?:\.\d+)+|\d+[a-z]?)\s*\|/gm)].map(m => m[1]!)

/** Task ids among command arguments (`65`, `pz-001`), upper-cased; anything else is dropped. */
export const parseIds = (args: string[]): string[] => args.map(a => (/^[a-z]/i.test(a) ? a.toUpperCase() : a)).filter(a => ID.test(a))

export const ageText = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}

const escapePath = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Matches a path against a template such as `{root}/{org}/{repo}` (placeholders {root} {org} {repo} {task}).
 * Unless `exact`, the path may continue below the template (a cwd inside the repo).
 */
export function matchTemplate(tpl: string, root: string, path: string, exact = false): { org?: string; repo?: string; task?: string } | undefined {
  const names: ('org' | 'repo' | 'task')[] = []
  let re = ''
  let last = 0
  for (const m of tpl.matchAll(/\{(org|repo|task|root)\}/g)) {
    re += escapePath(tpl.slice(last, m.index))
    last = m.index + m[0].length
    if (m[1] === 'root') re += escapePath(root)
    else {
      names.push(m[1] as 'org' | 'repo' | 'task')
      re += '([^/]+)'
    }
  }
  re += escapePath(tpl.slice(last))
  const x = new RegExp(`^${re}${exact ? '' : '(?:/.*)?'}$`).exec(path)
  if (!x) return undefined
  const out: { org?: string; repo?: string; task?: string } = {}
  names.forEach((n, i) => (out[n] = x[i + 1]))
  return out
}

export const fillTemplate = (tpl: string, v: { org?: string; repo?: string; root?: string }): string =>
  tpl.replace(/\{(org|repo|root)\}/g, (_, k: 'org' | 'repo' | 'root') => v[k] ?? `{${k}}`)

type PathConfig = { baseBoard: string; reposRoot: string; repoPatterns: string[] }

/** The repo (and worktree name) a cwd belongs to, by the first configured pattern that gives an org and a repo. */
export function repoFromCwd(cwd: string, cfg: PathConfig): { org: string; repo: string; task?: string } | undefined {
  for (const p of cfg.repoPatterns) {
    const m = matchTemplate(p, cfg.reposRoot, cwd)
    if (m?.org && m.repo) return { org: m.org, repo: m.repo, ...(m.task ? { task: m.task } : {}) }
  }
  return undefined
}

/** A worktree's short name: the {task} of a matching pattern, else the last path segment. */
export function worktreeTag(path: string, cfg: PathConfig): string {
  for (const p of cfg.repoPatterns) {
    const m = matchTemplate(p, cfg.reposRoot, path, true)
    if (m?.task) return m.task
  }
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The org and repo a board file belongs to: from the baseBoard template, else a repo pattern, else its directory's name. */
export function boardRepo(path: string, cfg: PathConfig): { org: string; repo: string } {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const t = cfg.baseBoard ? matchTemplate(cfg.baseBoard, cfg.reposRoot, path, true) : undefined
  if (t?.org && t.repo) return { org: t.org, repo: t.repo }
  const r = repoFromCwd(dir, cfg)
  if (r) return { org: r.org, repo: r.repo }
  return { org: '', repo: dir.slice(dir.lastIndexOf('/') + 1) }
}

/** `git rev-parse --git-common-dir` output made absolute (relative to `dir`) with `.` and `..` folded. */
export function normaliseGitDir(dir: string, out: string): string {
  const parts: string[] = []
  for (const seg of (out.startsWith('/') ? out : `${dir}/${out}`).split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '' && seg !== '.') parts.push(seg)
  }
  return `/${parts.join('/')}`
}

export type BoardCandidate = { path: string; source: 'primary' | 'walkup' }

/**
 * TASKS.md paths to try, in order: the configured primary board for the cwd's repo, the git main worktree's
 * TASKS.md, then walking up from the cwd (stopping at the configured root, if any).
 */
export function boardCandidates(cwd: string, cfg: PathConfig, mainWorktree = ''): BoardCandidate[] {
  const out: BoardCandidate[] = []
  const r = repoFromCwd(cwd, cfg)
  if (cfg.baseBoard && r) out.push({ path: fillTemplate(cfg.baseBoard, { ...r, root: cfg.reposRoot }), source: 'primary' })
  if (mainWorktree) out.push({ path: `${mainWorktree}/TASKS.md`, source: 'primary' })
  for (let dir = cwd; dir !== cfg.reposRoot && dir !== '' && dir !== '/'; dir = dir.slice(0, dir.lastIndexOf('/'))) out.push({ path: `${dir}/TASKS.md`, source: 'walkup' })
  return out.filter((c, i) => out.findIndex(o => o.path === c.path) === i)
}

/** The first entry of `git worktree list --porcelain`: the main worktree. */
export const worktreePaths = (porcelain: string): string[] =>
  porcelain
    .split('\n')
    .filter(l => l.startsWith('worktree '))
    .map(l => l.slice('worktree '.length).trim())

/** `/board <arg>`: `org/repo` names that repo's primary board (when baseBoard is configured); anything else is a file, or a directory holding TASKS.md. */
export function parseTarget(arg: string, cfg: PathConfig): string {
  const a = arg.trim()
  const m = /^([^/\s.~][^/\s]*)\/([^/\s]+)$/.exec(a)
  if (m && cfg.baseBoard && !m[2]!.endsWith('.md')) return fillTemplate(cfg.baseBoard, { org: m[1], repo: m[2], root: cfg.reposRoot })
  return a.endsWith('.md') ? a : `${a.replace(/\/$/, '')}/TASKS.md`
}

/** `git remote get-url origin` as an org and repo, or undefined. */
export function parseRemote(url: string): { org: string; repo: string } | undefined {
  const m = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(url.trim())
  return m ? { org: m[1]!, repo: m[2]! } : undefined
}

const PALETTE = ['cyan', 'magenta', 'yellow', 'blue', 'red', 'green', 'white']

/** A stable colour per worktree name. */
export const tagColor = (tag: string): string => PALETTE[hashLine(tag) % PALETTE.length]!

/**
 * The rows a worktree itself changed since it forked: new ids, and rows that differ from the fork-point board.
 * A stale branch differs from the primary board mostly because the primary moved on; those rows are not its changes.
 */
export function changedSinceFork(fork: TasksBoardTask[], worktree: TasksBoardTask[]): TasksBoardTask[] {
  const at = new Map(fork.map(t => [t.key, t]))
  return worktree.filter(t => {
    const f = at.get(t.key)
    return !f || !same(f, t)
  })
}

// `fork` is the board at the worktree's fork point; without it every field of a changed row counts as changed.
export type WorktreeBoard = { tag: string; path: string; isOwn: boolean; tasks: TasksBoardTask[]; fork?: TasksBoardTask[] }

const same = (a: TasksBoardTask, b: TasksBoardTask) =>
  a.status === b.status && a.title === b.title && a.owner === b.owner && a.eta === b.eta

/**
 * Merges worktree boards into the base board. A worktree's open row that is new, or differs from the base row
 * in status, title, owner or ETA, becomes a tagged variant; identical rows are ignored. One variant replaces the
 * base row; several are shown beside it.
 */
export function mergeBoards(base: TasksBoardTask[], worktrees: WorktreeBoard[]): TasksBoardTask[] {
  const byKey = new Map(base.map(t => [t.key, t])) // id plus occurrence, so duplicate ids match one to one
  const variants = new Map<string, TasksBoardTask[]>()
  const added: TasksBoardTask[] = []
  for (const w of worktrees) {
    const tag = w.tag.slice(0, 14)
    const forkAt = new Map((w.fork ?? []).map(f => [f.key, f]))
    for (let t of w.tasks) {
      const b = byKey.get(t.key)
      if (b) {
        // A field overrides only if the worktree changed it since the fork, and an empty one never blanks the base.
        const f = forkAt.get(t.key)
        const pick = (k: 'status' | 'title' | 'owner' | 'eta') => ((f && f[k] === t[k]) || (t[k] === '' && b[k] !== '') ? b[k] : t[k])
        t = { ...t, status: pick('status'), title: pick('title'), owner: pick('owner'), eta: pick('eta') }
      }
      // A worktree finishing a row the base still has open is shown (as done) until the base catches up;
      // other done rows are ignored.
      if (t.status === 'done' && (!b || b.status === 'done')) continue
      if (b && same(b, t)) continue
      const v = { ...t, key: `${t.key}@${w.tag}`, tag, wtPath: w.path, isOwn: w.isOwn, ...(t.status === 'done' && b ? { priorStatus: b.status } : {}) }
      if (b) variants.set(b.key, [...(variants.get(b.key) ?? []), v])
      else added.push(v)
    }
  }
  const out: TasksBoardTask[] = []
  for (const b of base) {
    const v = variants.get(b.key)
    if (v?.length === 1) out.push(v[0]!)
    else out.push(b, ...(v ?? []))
  }
  return [...out, ...added]
}

/**
 * Groups the visible rows by epic. Epic order is first appearance in `all` (file order);
 * rows within an epic sort by `rank`, then agent, then number. Epics with no visible rows are dropped.
 */
export function groupByEpic(
  all: TasksBoardTask[],
  visible: TasksBoardTask[],
  rank: (t: TasksBoardTask) => number,
): { epic: string; rows: TasksBoardTask[] }[] {
  const order = [...new Set(all.map(t => t.epic))]
  return order
    .map(epic => ({
      epic,
      rows: visible.filter(t => t.epic === epic).sort((a, b) => rank(a) - rank(b) || a.agent.localeCompare(b.agent) || a.n - b.n),
    }))
    .filter(g => g.rows.length > 0)
}

/** An epic heading such as `3. Code mode` (canonical) or `Task 443: code mode` (lenient) splits into its number and the name after the colon. */
export function epicLabel(epic: string): { num: string; name: string } {
  const n = /^(\d+)\.\s+(\S.*)$/.exec(epic)
  if (n) return { num: n[1]!, name: n[2]! }
  const m = /\bTask\s+(\d+)\b\s*[:\-–—]?\s*/i.exec(epic)
  if (!m) return { num: '', name: epic }
  return { num: m[1]!, name: epic.replace(m[0], '').trim() || epic }
}

/** Word-wraps `text` to `width` columns (a word longer than the width is cut); always returns at least one line. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const lines: string[] = []
  let cur = ''
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > w) {
      if (cur) lines.push(cur)
      lines.push(word.slice(0, w))
      cur = ''
      word = word.slice(w)
    }
    if (cur && cur.length + 1 + word.length > w) {
      lines.push(cur)
      cur = word
    } else cur = cur ? `${cur} ${word}` : word
  }
  if (cur || lines.length === 0) lines.push(cur)
  return lines
}

/** Epic ETA: the latest canonical ETA among open rows (time zone ignored); else the first ETA in file order (free text). */
export const epicEta = (rows: TasksBoardTask[]): string => {
  const key = (eta: string) => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(eta) ? eta.slice(0, 16) : '')
  const dated = rows.filter(t => t.status !== 'done' && t.status !== 'parked' && key(t.eta))
  const latest = dated.reduce((a, t) => (key(t.eta) > key(a.eta) ? t : a), dated[0] ?? { eta: '' })
  return latest.eta || (rows.find(t => t.eta !== '')?.eta ?? '')
}

export const ETA_W = 10 // fits "23rd 02:45"

/** `2026-10-11 02:45 ICT` (or `T` separator, TZ optional) -> `11th 02:45`; date only -> `11th`; anything else unchanged. */
export function shortEta(eta: string): string {
  const m = /^\d{4}-\d{2}-(\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?(?:\s*\S+)?)?$/.exec(eta.trim())
  if (!m) return eta
  const d = Number(m[1])
  const suffix = d % 100 >= 11 && d % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[d % 10] ?? 'th'
  return `${d}${suffix}${m[2] ? ` ${m[2]}` : ''}`
}

/**
 * Column indices of the `│` borders: chevron (1) | # (`numW`) | Task | Agent (12) | ETA (ETA_W) | gutter (1), a ` │ `
 * before every cell after the chevron. The last is the right border, at `width - 3` (mirroring column 2).
 */
export const barColumns = (taskW: number, hasAgent: boolean, hasEta: boolean, numW: number): number[] => {
  const bars = [2]
  let cursor = 4
  for (const w of [numW, taskW, ...(hasAgent ? [12] : []), ...(hasEta ? [ETA_W] : [])]) {
    cursor += w
    bars.push(cursor + 1)
    cursor += 3
  }
  return bars
}

const fit = (s: string, n: number, isRight = false) =>
  (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)[isRight ? 'padStart' : 'padEnd'](n)

/** A table line as plain text: the chevron cell, then each cell behind its ` │ `. */
export const tableLine = (
  c: { num?: string; task?: string; agent?: string; eta?: string },
  taskW: number,
  hasAgent: boolean,
  hasEta: boolean,
  numW: number,
): string =>
  ` ${' │ '}${fit(c.num ?? '', numW, true)} │ ${fit(c.task ?? '', taskW)}${hasAgent ? ` │ ${fit(c.agent ?? '', 12)}` : ''}${hasEta ? ` │ ${fit(c.eta ?? '', ETA_W)}` : ''} │  `

/** A horizontal rule from the first border (`├`) to the right border (`┤`), with `join` where the others meet it. */
export const ruleLine = (width: number, join: string, bars: number[]): string => {
  const last = bars[bars.length - 1]!
  return Array.from({ length: width }, (_, i) =>
    i < 2 || i > last ? ' ' : i === 2 ? '├' : i === last ? '┤' : bars.includes(i) ? join : '─',
  ).join('')
}

export type SubHeaderRun = { kind: 'blank' | 'accent' | 'band'; text: string }

/**
 * One of the three rows of a status sub-header, as runs to draw. The band spans only the first border
 * column F to the last L: `▐` at F and `▌` at L (the accent, on every row), between them spaces (the band's
 * background is drawn by the caller; the title row holds the title padded with spaces); outside F..L, blanks.
 */
export function subHeader(
  title: string,
  count: number,
  width: number,
  bars: number[],
  row: 'top' | 'title' | 'bottom',
): SubHeaderRun[] {
  const f = bars[0]!
  const l = bars[bars.length - 1]!
  const inner = l - f - 1
  const band = row === 'title' ? fit(` ${title} (${count})`, inner) : ' '.repeat(inner)
  return [
    { kind: 'blank', text: ' '.repeat(f) },
    { kind: 'accent', text: '▐' },
    { kind: 'band', text: band },
    { kind: 'accent', text: '▌' },
    { kind: 'blank', text: ' '.repeat(Math.max(0, width - l - 1)) },
  ]
}

export type HeaderRun = { kind: 'blank' | 'edge' | 'fill'; text: string }

/**
 * Splits a table line into runs: blank outside the first..last border; `▐` at F and `▌` at L as `edge` runs
 * (half blocks, so the band starts and ends on the border line); one continuous `fill` between (borders become spaces).
 */
export function headerRuns(line: string, bars: number[]): HeaderRun[] {
  const f = bars[0]!
  const l = bars[bars.length - 1]!
  return [
    { kind: 'blank', text: line.slice(0, f) },
    { kind: 'edge', text: '▐' },
    { kind: 'fill', text: line.slice(f + 1, l).replace(/│/g, ' ') },
    { kind: 'edge', text: '▌' },
    { kind: 'blank', text: line.slice(l + 1) },
  ]
}

export type RowChanges = Record<string, [hash: number, changedAt: number]>

/** 32-bit FNV-1a. */
export const hashLine = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h
}

/** Row change times: with no `prev` (first load) every row is seeded at 0, so nothing counts as recent. */
export function trackChanges(prev: RowChanges | undefined, tasks: TasksBoardTask[], now: number): RowChanges {
  const out: RowChanges = {}
  for (const t of tasks) {
    const hash = hashLine(t.line)
    const old = prev?.[t.key]
    out[t.key] = prev === undefined ? [hash, 0] : old && old[0] === hash ? old : [hash, now]
  }
  return out
}

export const STATE_BUDGET = 80_000

/**
 * What the pane keeps in `$.state`: open (not done) rows only, long fields clipped to what is drawn, no raw
 * lines. The real boards run to megabytes of done rows; a state value must stay far below that. Notes start at
 * min(300, 60000 / open rows) characters and shrink further until the whole value fits `STATE_BUDGET`.
 */
export function slimTasks(tasks: TasksBoardTask[]): TasksBoardTask[] {
  const open = tasks.filter(t => t.status !== 'done' || t.priorStatus)
  const build = (notesCap: number, titleCap: number) =>
    open.map(({ branch: _branch, ...t }) => ({ // branch is never shown, so it is not kept in state; state values must not hold undefined
      ...t,
      title: t.title.slice(0, titleCap),
      owner: t.owner.slice(0, 120),
      depends: t.depends.slice(0, 120),
      notes: t.notes.slice(0, notesCap),
      line: '',
    }))
  const rows = Math.max(1, open.length)
  let notesCap = Math.min(300, Math.floor(60_000 / rows))
  let titleCap = 120
  let out = build(notesCap, titleCap)
  for (let size = JSON.stringify(out).length; size > STATE_BUDGET && (notesCap > 0 || titleCap > 20); size = JSON.stringify(out).length) {
    const cut = Math.ceil((size - STATE_BUDGET) / rows)
    if (notesCap > 0) notesCap = Math.max(0, notesCap - cut)
    else titleCap = Math.max(20, titleCap - cut) // notes are gone: shorten titles last
    out = build(notesCap, titleCap)
  }
  return out
}

export const ACTIVE_MS = 30 * 60 * 1000

/** Being worked on: touched by this session while a turn runs, or its line changed in the last 30 minutes. */
export const isActive = (
  t: { id: string; key: string },
  s: { touched: string[]; isTurnRunning: boolean; changes: RowChanges | undefined; now: number },
): boolean => {
  if (s.isTurnRunning && s.touched.includes(t.id)) return true
  const at = s.changes?.[t.key]?.[1] ?? 0
  return at > 0 && s.now - at < ACTIVE_MS
}

export const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

/** Width of the `#` cell: the widest task or epic-heading number on the whole board, plus the spinner and a space. */
export const numColumnWidth = (tasks: TasksBoardTask[]): number => {
  let widest = 1
  for (const t of tasks) {
    widest = Math.max(widest, t.id.length, epicLabel(t.epic).num.length)
  }
  return Math.min(18, Math.max(3, widest + 2)) // long ids (CF-EMAIL-ROUTING-01) are clipped; details show them whole
}

/** Which TASKS.md to read: the session's override if set, else the first candidate that exists, else none (''). */
export async function pickBoard(
  override: string,
  candidates: BoardCandidate[],
  exists: (path: string) => Promise<boolean>,
): Promise<{ path: string; source: 'override' | 'primary' | 'walkup' | 'none' }> {
  if (override) return { path: override, source: 'override' }
  for (const c of candidates) if (await exists(c.path)) return c
  return { path: '', source: 'none' }
}

export const FORMAT_STATUSES = ['todo', 'in_progress', 'in_review', 'blocked', 'blocked_on_owner', 'parked', 'done']
export const CANON_HEADER = ['ID', 'Task', 'Status', 'Owner', 'Branch', 'Depends', 'ETA', 'Notes']
// `YYYY-MM-DD HH:MM` and a timezone: an abbreviation (ICT, UTC), `UTC+07(:00)` or an offset `+07:00`.
const ETA_FORMAT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (?:[A-Z]{2,5}|UTC[+-]\d{2}(?::?\d{2})?|[+-]\d{2}:\d{2})$/

export type LintIssue = { line: number; rule: string; message: string }

/**
 * Checks a board against the canonical "epic tables" format (see FORMAT.md). `findings` carry the line and the
 * rule; `issues` are their distinct messages. Rules: header, status, eta, checklist, duplicate-id, padded-cell, epic-number, epic-unique, depends.
 */
export function lintBoard(text: string): { canonical: boolean; issues: string[]; findings: LintIssue[] } {
  const findings: LintIssue[] = []
  const add = (line: number, rule: string, message: string) => findings.push({ line, rule, message })
  let canonicalTable = false
  let col: Cols | undefined
  let items = 0
  let firstItem = 0
  const seenIds = new Set<string>()
  let prev: string[] = []
  // `##` headings that hold a task table are epics; they need a unique `<N>. ` number.
  const epics: { no: number; num?: string; hasTable: boolean }[] = []
  const refs = new Set<string>()
  const deps: { no: number; value: string }[] = []
  const raw = text.split('\n')
  raw.forEach((line, i) => {
    if (line.startsWith('|') && (/ {2,}\|/.test(line) || /\| {2,}/.test(line))) add(i + 1, 'padded-cell', 'two or more spaces next to a pipe: cells must not be padded')
  })
  for (const { text: line, no } of joinRowsNumbered(raw)) {
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading) epics.push({ no, num: /^(\d+)\.\s+\S/.exec(heading[1]!.trim())?.[1], hasTable: false })
    if (/^- \[( |x|X)\]/.test(line)) {
      items += 1
      firstItem ||= no
    }
    if (!line.startsWith('|')) continue
    const c = cells(line)
    const before = prev
    prev = c
    if (c.length > 0 && c.every(x => /^:?-{2,}:?$/.test(x))) {
      if (!/^(#|id)$/i.test(before[0] ?? '')) col = undefined
      continue
    }
    if (/^(#|id)$/i.test(c[0] ?? '')) {
      col = columnsOf(c)
      if (col && epics.length > 0) epics[epics.length - 1]!.hasTable = true
      canonicalTable = col !== undefined && c.join('|') === CANON_HEADER.join('|')
      if (col && !canonicalTable) add(no, 'header', `non-canonical header: | ${c.join(' | ')} |`)
      continue
    }
    if (col && ID.test(c[col.id] ?? '')) {
      if (seenIds.has(c[col.id]!)) add(no, 'duplicate-id', `duplicate ID ${c[col.id]}`)
      seenIds.add(c[col.id]!)
    }
    if (!col || !canonicalTable || !ID.test(c[col.id] ?? '')) continue
    if (!FORMAT_STATUSES.includes(c[col.status] ?? '')) add(no, 'status', `status outside the vocabulary: "${c[col.status]}"`)
    const epicNum = epics[epics.length - 1]?.num
    if (epicNum !== undefined) refs.add(`${epicNum}.${c[col.id]}`)
    if (col.depends >= 0 && (c[col.depends] ?? '') !== '') deps.push({ no, value: c[col.depends]! })
    const eta = c[col.eta] ?? ''
    if (eta !== '' && !ETA_FORMAT.test(eta)) add(no, 'eta', `ETA not YYYY-MM-DD HH:MM <timezone>: "${eta}"`)
  }
  const seenNums = new Set<string>()
  for (const e of epics.filter(x => x.hasTable)) {
    if (e.num === undefined) add(e.no, 'epic-number', 'epic heading without a number: expected "## <N>. <name>"')
    else if (seenNums.has(e.num)) add(e.no, 'epic-unique', `duplicate epic number ${e.num}`)
    if (e.num !== undefined) seenNums.add(e.num)
  }
  for (const d of deps)
    for (const ref of d.value.split(',').map(x => x.trim())) {
      if (!/^\d+\..+$/.test(ref)) add(d.no, 'depends', `Depends entry not an <epic>.<task> reference: "${ref}"`)
      else if (!refs.has(ref)) add(d.no, 'depends', `Depends reference ${ref} matches no row`)
    }
  if (items > 0) add(firstItem, 'checklist', `${items} checklist items instead of table rows`)
  findings.sort((a, b) => a.line - b.line)
  return { canonical: findings.length === 0, issues: [...new Set(findings.map(f => f.message))], findings }
}

/**
 * The findings that should fail CI. `canonical` fails on every rule; `lenient` (for boards not yet migrated)
 * only on duplicate ids and padded cells.
 */
export const checkBoard = (text: string, mode: 'canonical' | 'lenient'): LintIssue[] =>
  lintBoard(text).findings.filter(f => mode === 'canonical' || f.rule === 'duplicate-id' || f.rule === 'padded-cell')

export const FIX_WINDOW_MS = 24 * 60 * 60 * 1000

/** Launch the formatting agent at most once per repo per 24 h, only for non-canonical boards of a known repo. */
export const shouldLaunchFix = (a: {
  autofix: boolean
  canonical: boolean
  repo: { org: string; repo: string } | undefined
  record: { at: number } | undefined
  now: number
}): boolean => a.autofix && !a.canonical && a.repo !== undefined && (a.record === undefined || a.now - a.record.at >= FIX_WINDOW_MS)
