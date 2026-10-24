# Canonical TASKS.md format ("epic tables")

```
# Tasks
## <N>. <Epic name>
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 12 | … | in_progress | agent-name | feat/task-12 | 1.11 | 2026-10-10 14:00 ICT | … |
```

- One `##` heading per epic; one table per epic, with exactly the header above. The heading is `## <N>. <Epic name>`,
  N a positive integer unique on the board. Numbers are stable: never renumber or reuse one; a new epic takes the
  highest number + 1. Headings that hold no task table (Conventions, Identities, archive notes) are not epics and are
  not numbered. The parser still reads the older `Task <n>: <name>` form, but it is not canonical.
- Each epic has an `ETA: YYYY-MM-DD HH:MM <TZ>` line directly under its heading, kept current (roughly the latest ETA of its open rows). The checker only warns when it is missing, malformed, or in the past while the epic has open rows.
- Epic numbers and task IDs are positive integers (`^[1-9]\d*$`), each independently unique: epic numbers among
  epics, task IDs across the whole board (not per epic). A task's reference is `<epic>.<task>`, e.g. `3.579`; the ID
  column holds the task's own integer ID. Whenever an agent mentions a task anywhere (Depends, Notes, commit
  messages, PR titles and bodies, chat, reports) it uses `<epic>.<task>`, never a bare task ID. Depends cells hold
  comma-separated references in that form, each resolving to an existing row.
- Status is exactly one of the following.
  - `todo`: not started; nobody has picked it up (Owner empty or `owner`).
  - `in_progress`: an agent is working on it now. Owner is that agent; ETA is required.
  - `in_review`: a PR is open and waits on CI, review or merge. Link the PR in Notes; ETA is the expected merge.
  - `blocked`: cannot proceed because of something other than the owner's input: another row (name its reference in
    Depends), an agent prerequisite, a failing dependency, CI, an external service or a quota. Notes say what it
    waits on.
  - `blocked_on_owner`: only when the owner (the person running the agents) must give input: a decision, an
    approval, credentials, or an action only they can take. Notes state exactly what is needed from them. Never use
    it for anything an agent or another task can resolve; that is `blocked`. Never use it for work the owner has
    paused or held; that is `parked`.
  - `parked`: the owner deliberately paused or held this work (for example "native parity on hold until web is
    done"). Nobody works on it and nothing is needed from the owner until the owner un-parks it. No ETA. Notes say who
    parked it, when, and the resume condition. Distinct from `blocked_on_owner`, which is only for when the owner
    must actively give input.
  - `done`: merged or verified; Notes hold the evidence (PR, commit, check). Never use it for cancelled work.
  - `dropped`: terminal. The work was cancelled and never done. Notes must start `Dropped: <reason>.` The pane hides
    it like `done` and does not count it open.
  - `superseded`: terminal. Another task replaced this one. Notes must start `Superseded by <epic>.<task>.` naming
    the replacing row (for example `Superseded by 3.12.`); the check fails if that row does not exist. The pane hides
    it like `done` and does not count it open.
- Branch is the git branch doing the row's work, when it can be determined (named in the row's notes or owner, or a
  registered worktree or open PR whose branch or task folder matches the row's owner or id); otherwise empty.
  Never invent one. The board pane does not display it.
- ETA is `YYYY-MM-DD HH:MM <timezone>` (a timezone abbreviation such as `ICT`, or an offset such as `+07:00`), or empty.
- Existing numeric IDs are kept. Any non-numeric ID (`PZ-001`, `CF-3`, `12a`, `1.2`, ...) is renumbered to the next
  free integer, continuing from the board's highest numeric ID in file order; its Notes gain `Was <old ID>.` and
  every reference to it (Depends, `Superseded by`, `<epic>.<old>` mentions in Notes) is rewritten. Checklist items
  without an ID get the next free integers. A repeated ID is renumbered the same way.
- Repos may enforce their board format in CI (a checker script run by a workflow). The formatting change must
  migrate those checkers, their tests and the documented conventions in the same PR, run them locally and wait for
  CI; if a checker cannot be migrated safely, change nothing.
- Cells are not padded: no run of two or more spaces next to a pipe.
- Prose that is not a task (status notes, decisions, conventions) is kept verbatim above the first epic, or
  under its own heading. Prose sections and closed rows (`done`, `dropped`, `superseded`) are never deleted. When
  condensing open rows, keep the facts and evidence links; narrative history may be cut because git history keeps it.

## Writing rows

The check fails on all of these. The length limits apply only to open rows (status not `done`, `dropped` or
`superseded`); the epic-name rule applies only to epics with at least one open row.

- Epic names are descriptive and focused: name the outcome or area of work, never its position, status or date.
  Bad: "Active", "Backlog", "Follow-ups 1.140 to 1.155", "Task 443 onwards", "Additional tracked work", "Open:
  Follow-ups", "Archive: ... (2026-08-28)". Good: "Sailfish card parity with mobile web", "pgBackRest repo2
  backups". Dates and status live in the rows, not the heading. The check rejects a name that (case-insensitive):
  starts with `Active`, `Backlog`, `Archive`, `Misc`, `Miscellaneous`, `Todo`, `Additional`, `In-progress` or
  `Authoritative current status`; is exactly `Open`, `Done`, `New`, `Other`, `General`, `Board`, `Tasks`, `Current` or
  `In progress`, optionally followed by `work`, `tasks`, `items`, `issues`, `board` or `follow-ups` (`Open banking`
  and `New user onboarding` pass, `New tasks` fails); is `Follow-ups` (or `Followups`, `Follow ups`) alone or followed by a number range or date; contains `onwards`,
  `rows added`, `task <n>`, `tasks <n>` or `<n> to <n>`; starts with a status word followed
  by `:` or a dash (`Open: ...`, `Active - ...`); or ends with a date (`(2026-08-31)`, `, 2026-09-29`,
  `(7 October 2026)`). The patterns are `EPIC_NAME_DENY` in `hooks/board.ts`.
- Task is a short imperative title: 100 characters at most on open rows.
- Notes are concise: a few short facts separated by `<br>` (the pane shows each on its own line), 400 characters at
  most on open rows: current state, blocker, PR link, evidence. No narrative history or step-by-step logs; long
  evidence goes in the PR, the commit or a linked file.
- Prose under an epic is a short list, not paragraphs: no line over 400 characters while the epic has open rows.
- Every row has exactly the header's number of cells. Escape literal pipes in a cell as `\|`. The fixer repairs the
  mechanical problems (joins multi-line rows, strips padding, pads short rows, merges surplus Notes cells as escaped
  pipes, turns `<br/>` into `<br>`): run `tasks-board-check --fix TASKS.md`. The mod runs it on every agent edit of
  `TASKS.md`.

## Legacy statuses

The parser reads old and free-text statuses leniently (the leading phrase decides, so `done (merged #12)` is `done`).
When rewriting a board into the canonical format, convert them as follows. Unknown text counts as `todo`; the
canonical check rejects any status outside the list above.

| Legacy value | Canonical status | Notes rule |
|---|---|---|
| `dropped`, `cancelled`, `canceled`, `rejected`, `declined`, `wontfix`, `won't fix`, `abandoned`, `obsolete`, a struck-through row marked cancelled | `dropped` | Start with `Dropped: <reason>.` Never map cancelled work to `done`. |
| `deferred`, `on hold`, `later`, `postponed`, `backlog`, when the row shows the owner paused it (owner decision, owner paused, a configured owner name pausing it) | `parked` | Say who parked it, when, and the resume condition. |
| the same values without that owner evidence | `todo` | Start with `Deferred: <reason>.`, keeping the reason from the old row. |
| `done`, `complete`, `closed`, `merged`, `shipped`, `released`, `resolved`, `fixed`, `deployed`, `published`, and similar, with free text after (`done (merged #12)`, `merged via PR #35`) | `done` | Keep or add the evidence (PR, commit, check). |
| `superseded` | `superseded` | Start with `Superseded by <epic>.<task>.` naming the replacing row. |
| `n/a`, `na`, `not applicable` | not mapped automatically: decide from the row's context which status it really is (`done`, `dropped`, `superseded`, ...) | Say why in Notes. The check rejects `n/a` as an unknown status. |
| `in progress`, `doing`, `partly`, `review`, `in PR`, `PR #n open` | `in_progress` (or `in_review` when a PR is open) | Link the PR; ETA is required. |
| `blocked ...`, `waiting on ...` | `blocked`, or `blocked_on_owner` only when the owner must give input | Say what it waits on. |
| `parked` | `parked` | As above. |
| Owner column `owner` (a bare placeholder) | `todo`, unassigned | Leave Owner empty. |
| anything else (`open`, `not started`, empty) | `todo` | None. |

Do not add `Previous status: <old>.` to Notes: the `Dropped:`, `Superseded by` or `Deferred:` prefix carries the meaning.

## Keeping the board current

Agents update the board as work goes, not at the end of the session.

- Update the row the moment the state changes: on pick-up (`in_progress`, Owner, Branch, ETA), on each status
  change, when blocked (what on, and the row ID or the exact owner question), on PR open (`in_review` plus link),
  and on completion (`done` plus evidence).
- Every `in_progress` and `in_review` row carries an ETA in `YYYY-MM-DD HH:MM <TZ>`. Revise it as soon as it
  slips; an open row with an ETA in the past is wrong and must be updated.
- Add a row as soon as new work is discovered; never leave follow-up work only in chat, logs or PR comments.
- Clear the blocker fields when unblocked.
