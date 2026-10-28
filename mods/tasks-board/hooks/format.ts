import type { TasksBoardTask } from '../types'
import type { RowChanges } from './board'
import { ageText, epicLabel } from './board'

// Keep in step with FORMAT.md at the plugin's root.
export const FORMAT_SPEC = `Canonical TASKS.md format ("epic tables"):

# Tasks
## <N>. <Epic name>
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 12 | … | in_progress | agent-name | feat/task-12 | 1.11 | 2026-10-10 14:00 ICT | … |

- One ## heading per epic; one table per epic, with exactly the header above. The heading is "## <N>. <Epic name>",
  N a positive integer unique on the board. Numbers are stable: never renumber or reuse one; a new epic takes the
  highest number + 1. Headings that hold no task table (Conventions, Identities, archive notes) are not epics and
  are not numbered.
- Each epic has an "ETA: YYYY-MM-DD HH:MM <TZ>" line directly under its heading, kept current (roughly the latest ETA of its open rows). The checker only warns when it is missing, malformed, or in the past while the epic has open rows.
- Epic numbers and task IDs are positive integers (^[1-9]\\d*$), each independently unique: epic numbers among
  epics, task IDs across the whole board (not per epic). A task's reference is <epic>.<task>, e.g. 3.579; the ID
  column holds the task's own integer ID. Whenever an agent mentions a task anywhere (Depends, Notes, commit
  messages, PR titles and bodies, chat, reports) it uses <epic>.<task>, never a bare task ID. Depends cells hold
  comma-separated references in that form, each resolving to an existing row.
- Status is exactly one of:
  - todo: not started; nobody has picked it up (Owner empty or "owner").
  - in_progress: an agent is working on it now. Owner is that agent; ETA is required.
  - in_review: a PR is open and waits on CI, review or merge. Link the PR in Notes; ETA is the expected merge.
  - blocked: cannot proceed because of something other than the owner's input: another row (name its reference in
    Depends), an agent prerequisite, a failing dependency, CI, an external service or a quota. Notes say what it
    waits on.
  - blocked_on_owner: only when the owner (the person running the agents) must give input: a decision, an
    approval, credentials, or an action only they can take. Notes state exactly what is needed from them. Never
    use it for anything an agent or another task can resolve; that is blocked. Never use it for work the owner has
    paused or held; that is parked.
  - parked: the owner deliberately paused or held this work (for example "native parity on hold until web is
    done"). Nobody works on it and nothing is needed from the owner until the owner un-parks it. No ETA. Notes say who
    parked it, when, and the resume condition. Distinct from blocked_on_owner, which is only for when the owner
    must actively give input.
  - done: merged or verified; Notes hold the evidence (PR, commit, check). Never use it for cancelled work.
  - dropped: terminal. The work was cancelled and never done. Notes must start "Dropped: <reason>."
  - superseded: terminal. Another task replaced this one. Notes must start "Superseded by <epic>.<task>." naming the replacing row, e.g. "Superseded by 3.12."
  When converting an old or free-text status, only rows that need the owner's input become blocked_on_owner; every
  other blocked row becomes blocked, except work the owner paused or held, which becomes parked.

Legacy statuses (convert as below; unknown text becomes todo):
| Legacy value | Canonical status | Notes rule |
|---|---|---|
| dropped, cancelled, canceled, rejected, declined, wontfix, won't fix, abandoned, obsolete, struck-through row marked cancelled | dropped | Start with "Dropped: <reason>." Never map cancelled work to done. |
| deferred, on hold, later, postponed, backlog, when the row shows the owner paused it (owner decision, owner paused) | parked | Say who parked it, when, and the resume condition. |
| the same values without that owner evidence | todo | Start with "Deferred: <reason>.", keeping the reason from the old row. |
| done, complete, closed, merged, shipped, resolved, ... with free text (done (merged #12)) | done | Keep or add the evidence. |
| superseded | superseded | Start with "Superseded by <epic>.<task>." |
| n/a, na, not applicable | decide from the row's context which status it really is (done, dropped, superseded, ...); never map it blindly | Say why in Notes. |
| in progress, doing, partly, review, in PR | in_progress (in_review when a PR is open) | Link the PR; ETA required. |
| blocked ..., waiting on ... | blocked (blocked_on_owner only when the owner must give input) | Say what it waits on. |
| Owner column "owner" | todo, Owner empty | None. |
| anything else (open, not started, empty) | todo | None. |
Do not write "Previous status: <old>." in Notes: the "Dropped:", "Superseded by" or "Deferred:" prefix carries the meaning.
- Branch is the git branch doing the row's work, when it can be determined (named in the row's notes or owner, or a
  registered worktree or open PR whose branch or task folder matches the row's owner or id); otherwise empty.
  Never invent one.
- ETA is YYYY-MM-DD HH:MM <timezone> (a timezone abbreviation, e.g. ICT, or an offset such as +07:00), or empty.
- Existing numeric IDs are kept. Any non-numeric ID (PZ-001, CF-3, 12a, 1.2, ...) is renumbered to the next free
  integer, continuing from the board's highest numeric ID in file order; its Notes gain "Was <old ID>." and every
  reference to it (Depends, "Superseded by", <epic>.<old> mentions in Notes) is rewritten. Checklist items without
  an ID get the next free integers. A repeated ID is renumbered the same way.
- Cells are not padded: no run of two or more spaces next to a pipe.
- Prose that is not a task (status notes, decisions, conventions) is kept verbatim above the first epic, or
  under its own heading. Prose sections and closed rows (done, dropped, superseded) are never deleted. When
  condensing open rows, keep the facts and evidence links; narrative history may be cut because git history keeps it.

Writing rows (the check fails on these; length limits apply only to open rows, the epic-name rule only to epics with open rows):
- Epic names are descriptive and focused: name the outcome or area of work, never its position, status or date.
  Bad: "Active", "Backlog", "Follow-ups 1.140 to 1.155", "Task 443 onwards", "Additional tracked work", "Open: Follow-ups",
  "Archive: ... (2026-08-28)". Good: "Sailfish card parity with mobile web", "pgBackRest repo2 backups". Dates and status live in the
  rows, not the heading. Rejected (case-insensitive): a name starting with Active, Backlog, Archive, Misc, Miscellaneous,
  Todo, Additional, In-progress or Authoritative current status; a name that is exactly Open, Done, New, Other, General, Board, Tasks,
  Current or In progress, optionally followed by work, tasks, items, issues, board or follow-ups ("Open banking" passes, "New tasks" fails); Follow-ups
  (Followups, Follow ups) alone or followed by a number range or date; a name containing "onwards", "rows added", "task <n>",
  "tasks <n>" or "<n> to <n>"; a status word followed by ":" or a dash at the start ("Open: ...", "Active - ...");
  a name ending in a date ("(2026-08-31)", ", 2026-09-29", "(7 October 2026)").
- Task is a short imperative title: 100 characters at most on open rows.
- Notes are concise: a few short facts separated by <br> (the pane shows each on its own line), 400 characters at most on open
  rows: current state, blocker, PR link, evidence. No narrative history or step-by-step logs; long evidence goes in the PR, the
  commit or a linked file.
- Prose under an epic is a short list, not paragraphs: no line over 400 characters while the epic has open rows.
- Every row has exactly the header's number of cells; escape literal pipes in a cell as \\|. Run the fixer for the mechanical
  problems (multi-line rows, padding, missing or surplus cells, <br/>): tasks-board-check --fix TASKS.md.`

export const FIX_PR_TITLE = 'TASKS.md: canonical board format'

/**
 * The prompt for the background agent that rewrites a board into the canonical format. `extra` is the plugin's
 * `fixInstructions` option: workflow rules specific to the machine or organisation, appended verbatim.
 */
export const fixPrompt = (slug: string, boardPath: string, date: string, extra = ''): string => `Rewrite ${boardPath} (repository ${slug}) into the canonical board format below, and open a pull request.

${FORMAT_SPEC}

Rules:
- Create a new branch named board-format-${date} in a fresh \`git worktree\` of the repository, and work only in that worktree; never edit an existing checkout.
- Before rewriting, search the repository for board checkers and conventions: \`git grep -l -i 'TASKS.md'\` across scripts, tools, CI workflows, AGENTS.md, CLAUDE.md and docs. Some repos enforce their board format in CI.
- In the same PR, update those checkers, their tests and the documented conventions to the canonical format, and run them locally. Then wait for CI to finish and fix what it reports.
- If a checker cannot be migrated safely, leave the board unchanged, open no PR, and report why.
- Preserve every task, every closed row and every prose section; delete nothing except narrative history condensed out of open rows (git keeps it).
- Number the epics in file order starting at 1, keeping any existing number (\`Task 12\`, \`12.\`) and never renumbering. Rewrite every Depends cell to comma-separated \`<epic>.<task>\` references. Renumber task IDs as the format says: non-numeric and repeated IDs get the next free integer (add \`Was <old ID>.\` to Notes and rewrite every reference to them, including \`<epic>.<old>\` mentions in Notes); epic numbers stay. Leave other Notes prose as written.
- If the repository's CI uses \`ThomasMcFarlane/ai-tools/actions/tasks-board-check@tasks-board-check-v1\`, \`@tasks-board-check-v2\` or \`@tasks-board-check-v3\`, change it to \`@tasks-board-check-v4\` in the same PR (this change ships as the v4 action).
- Rename the vague name of every epic that has open rows to a descriptive one (outcome or area of work, not position, status or date), keeping its number. Split an epic that mixes unrelated work only if that is trivial; otherwise just rename it.
- Condense every open row to the limits: Task a short title (100 characters), Notes a few short facts separated by \`<br>\` (400 characters), keeping facts and evidence links and cutting narrative history. Break any line over 400 characters under an epic with open rows into a short list.
- Run \`node <ai-tools>/actions/tasks-board-check/dist/index.js --fix TASKS.md\` (the fixer) for mechanical table problems, then the check without \`--fix\`, and repeat until it passes.
- Verify with a script, kept outside the repository, that every original ID is present exactly once afterwards (as itself or via its \`Was <old ID>.\` note), and that the open and done counts match before and after.
- Commit, push, and run \`gh pr create\` titled "${FIX_PR_TITLE}". Put a line in the PR body stating that this is an automated board cleanup and that the agent that opened it merges it as soon as CI is green, without waiting for the owner.
- Wait for CI and fix what it reports. Once all checks pass and the PR is mergeable, merge it yourself with \`gh pr merge\`, using a merge method the repository allows, and delete the branch.
- If CI cannot be made green, leave the PR open and report why.
- Report the PR URL and the merge result.${extra ? `\n\nAdditional rules:\n${extra}` : ''}`


// ETA helpers: pure, offline (Intl with bundled tz data).
const ZONE_MIN: Record<string, number> = { ICT: 420, UTC: 0, GMT: 0, BST: 60 }

/** The instant of a canonical `YYYY-MM-DD HH:MM <TZ>` ETA (ICT, UTC, GMT, BST or a +HH:MM offset), or undefined. */
export function etaInstant(eta: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) (\S+)$/.exec(eta.trim())
  if (!m) return undefined
  const off = /^([+-])(\d{2}):?(\d{2})$/.exec(m[6]!)
  const min = off ? (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) : ZONE_MIN[m[6]!]
  if (min === undefined) return undefined
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - min * 60_000
  return Number.isNaN(ms) ? undefined : ms
}

const parts = (ms: number, timeZone: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' })
      .formatToParts(ms)
      .map(x => [x.type, x.value]),
  ) as Record<string, string>
  return { day: `${p.year}-${p.month}-${p.day}`, date: `${p.day} ${p.month}`, time: `${p.hour}:${p.minute}`, zone: p.timeZoneName! }
}

/** An ETA as Bangkok and London times plus the time left; a date is added where it differs from the day it is read on. Undefined for an unknown zone. */
export function etaPair(eta: string, now: number = Date.now()): { ict: string; uk: string; leftMs: number } | undefined {
  const at = etaInstant(eta)
  if (at === undefined) return undefined
  const ict = parts(at, 'Asia/Bangkok')
  const uk = parts(at, 'Europe/London')
  return {
    ict: `${ict.day === parts(now, 'Asia/Bangkok').day ? '' : `${ict.date} `}${ict.time} ICT`,
    uk: `${uk.day === ict.day ? '' : `${uk.date} `}${uk.time} ${uk.zone}`,
    leftMs: at - now,
  }
}

/** The canonical ICT ETA for `+45m`, `+2h`, `14:30` (next occurrence, ICT) or `YYYY-MM-DD[ T]HH:MM` (ICT unless it carries Z or an offset); undefined if unreadable. */
export function parseEtaInput(input: string, now: number): string | undefined {
  const s = input.trim()
  let at: number | undefined
  const rel = /^\+(\d+)\s*([mh])$/i.exec(s)
  const clock = /^(\d{1,2}):(\d{2})$/.exec(s)
  const iso = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?\s*(Z|[+-]\d{2}:?\d{2}|ICT)?$/i.exec(s)
  if (rel) at = now + Number(rel[1]) * (rel[2]!.toLowerCase() === 'h' ? 3_600_000 : 60_000)
  else if (clock && Number(clock[1]) < 24 && Number(clock[2]) < 60) {
    const d = new Date(now + 7 * 3_600_000)
    at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(clock[1]), Number(clock[2])) - 7 * 3_600_000
    if (at <= now) at += 86_400_000
  } else if (iso) {
    const z = iso[3]?.toUpperCase()
    at = etaInstant(`${iso[1]} ${iso[2]} ${!z || z === 'ICT' ? 'ICT' : z === 'Z' ? 'UTC' : z}`)
  }
  if (at === undefined || Number.isNaN(at)) return undefined
  return `${new Date(at + 7 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} ICT`
}

export type Staleness = { kind: 'passed' | 'stale'; ms: number }

/** ETA passed, or (in_progress only) nothing about the row changed for `staleMs`. `changedAt` is when the row last changed, 0 unknown. */
export function staleness(a: { status: string; leftMs: number | undefined; changedAt: number; now: number; staleMs: number }): Staleness | undefined {
  if (a.leftMs !== undefined && a.leftMs < 0) return { kind: 'passed', ms: -a.leftMs }
  if (a.status === 'in_progress' && a.changedAt > 0 && a.now - a.changedAt >= a.staleMs) return { kind: 'stale', ms: a.now - a.changedAt }
  return undefined
}

export type EtaItem = { ref: string; key: string; title: string; status: string; eta: string; pair?: { ict: string; uk: string; leftMs: number }; stale?: Staleness }

/** One item per open row of this session (in_progress or in_review, pinned, touched or owned by the session tag). `mtimeMs` stands in for rows with no change time yet. */
export function etaItems(tasks: TasksBoardTask[], s: { mine: string[]; tag: string; changes: RowChanges | undefined; now: number; mtimeMs: number; staleMs: number }): EtaItem[] {
  return tasks
    .filter(t => (t.status === 'in_progress' || t.status === 'in_review') && (s.mine.includes(t.id) || (s.tag !== '' && t.owner.toLowerCase().includes(s.tag))))
    .map(t => {
      const num = epicLabel(t.epic).num
      const pair = etaInstant(t.eta) === undefined ? undefined : etaPair(t.eta, s.now)
      const changedAt = s.changes?.[t.key]?.[1] || s.mtimeMs
      return { ref: num ? `${num}.${t.id}` : t.id, key: t.key, title: t.title, status: t.status, eta: t.eta, pair, stale: staleness({ status: t.status, leftMs: pair?.leftMs, changedAt, now: s.now, staleMs: s.staleMs }) }
    })
}

export const BAND_MAX = 4
export const BAND_MIN_ROWS = 20 // the band is hidden on terminals shorter than this

/** Band lines, at most BAND_MAX including the "+N more" line. */
export function bandLines(items: EtaItem[]): { text: string; color?: 'red' | 'yellow' }[] {
  const line = (i: EtaItem) => {
    const when = i.pair ? `${i.pair.ict} / ${i.pair.uk}` : i.eta || 'no ETA'
    const mark = i.stale ? (i.stale.kind === 'passed' ? `ETA passed ${ageText(i.stale.ms)} ago` : `no update ${ageText(i.stale.ms)}`) : i.pair ? `(${ageText(i.pair.leftMs)} left)` : ''
    return { text: `${i.ref} ${i.title}   ${when}   ${mark}`.trim(), color: i.stale ? (i.stale.kind === 'passed' ? ('red' as const) : ('yellow' as const)) : i.eta === '' ? ('yellow' as const) : undefined }
  }
  const shown = items.length > BAND_MAX ? items.slice(0, BAND_MAX - 1) : items
  return [...shown.map(line), ...(items.length > shown.length ? [{ text: `+${items.length - shown.length} more` }] : [])]
}

export const NUDGE_MS = 15 * 60_000

/** One nudge line per row whose ETA passed, went stale or is missing, at most one per row per NUDGE_MS (`last` is updated). */
export function nudgeLines(items: EtaItem[], now: number, last: Map<string, number>): string[] {
  const out: string[] = []
  for (const i of items) {
    const why = i.stale ? (i.stale.kind === 'passed' ? `ETA for ${i.ref} passed ${ageText(i.stale.ms)} ago.` : `${i.ref} has had no update for ${ageText(i.stale.ms)}.`) : i.status === 'in_progress' && i.eta === '' ? `${i.ref} is in_progress with no ETA.` : ''
    if (!why || now - (last.get(i.key) ?? -Infinity) < NUDGE_MS) continue
    last.set(i.key, now)
    out.push(`${why} Call the eta tool with a new estimate or update the status.`)
  }
  return out
}
