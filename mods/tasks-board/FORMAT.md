# Canonical TASKS.md format ("epic tables")

```
# Tasks
## <N>. <Epic name>
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| PZ-001 | … | in_progress | agent-name | feat/pz-001 | 1.PZ-000 | 2026-10-10 14:00 ICT | … |
```

- One `##` heading per epic; one table per epic, with exactly the header above. The heading is `## <N>. <Epic name>`,
  N a positive integer unique on the board. Numbers are stable: never renumber or reuse one; a new epic takes the
  highest number + 1. Headings that hold no task table (Conventions, Identities, archive notes) are not epics and are
  not numbered. The parser still reads the older `Task <n>: <name>` form, but it is not canonical.
- A task's reference is `<epic>.<task>`, e.g. `3.579` or `2.PZ-001`; the ID column keeps the task's own ID verbatim
  (unique across the board). Agents use the reference everywhere they name a task: Depends, Notes, commit messages,
  PR titles and bodies, chat and reports. Depends cells hold comma-separated references in that form, each
  resolving to an existing row.
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
  - `done`: merged or verified; Notes hold the evidence (PR, commit, check).
- Branch is the git branch doing the row's work, when it can be determined (named in the row's notes or owner, or a
  registered worktree or open PR whose branch or task folder matches the row's owner or id); otherwise empty.
  Never invent one. The board pane does not display it.
- ETA is `YYYY-MM-DD HH:MM <timezone>` (a timezone abbreviation such as `ICT`, or an offset such as `+07:00`), or empty.
- Existing IDs are kept verbatim (numbers, `PZ-001`, `CF-…`). A repeated ID is renumbered to the next free one, with
  the old ID noted in Notes. Checklist items without an ID get new IDs `<REPOPREFIX>-<n>`, continuing from the
  board's highest number.
- Repos may enforce their board format in CI (a checker script run by a workflow). The formatting change must
  migrate those checkers, their tests and the documented conventions in the same PR, run them locally and wait for
  CI; if a checker cannot be migrated safely, change nothing.
- Cells are not padded: no run of two or more spaces next to a pipe.
- Prose that is not a task (status notes, decisions, conventions) is kept verbatim above the first epic, or
  under its own heading. Nothing is deleted.

## Keeping the board current

Agents update the board as work goes, not at the end of the session.

- Update the row the moment the state changes: on pick-up (`in_progress`, Owner, Branch, ETA), on each status
  change, when blocked (what on, and the row ID or the exact owner question), on PR open (`in_review` plus link),
  and on completion (`done` plus evidence).
- Every `in_progress` and `in_review` row carries an ETA in `YYYY-MM-DD HH:MM <TZ>`. Revise it as soon as it
  slips; an open row with an ETA in the past is wrong and must be updated.
- Add a row as soon as new work is discovered; never leave follow-up work only in chat, logs or PR comments.
- Clear the blocker fields when unblocked.
