# Canonical TASKS.md format ("epic tables")

```
# Tasks
## <Epic name>
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| PZ-001 | … | in_progress | agent-name | feat/pz-001 | PZ-000 | 2026-10-10 14:00 ICT | … |
```

- One `##` heading per epic; one table per epic, with exactly the header above.
- Status is exactly one of: `todo`, `in_progress`, `in_review`, `blocked`, `blocked_on_owner`, `done`.
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
