// Keep in step with FORMAT.md at the plugin's root.
export const FORMAT_SPEC = `Canonical TASKS.md format ("epic tables"):

# Tasks
## <N>. <Epic name>
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| PZ-001 | … | in_progress | agent-name | feat/pz-001 | 1.PZ-000 | 2026-10-10 14:00 ICT | … |

- One ## heading per epic; one table per epic, with exactly the header above. The heading is "## <N>. <Epic name>",
  N a positive integer unique on the board. Numbers are stable: never renumber or reuse one; a new epic takes the
  highest number + 1. Headings that hold no task table (Conventions, Identities, archive notes) are not epics and
  are not numbered.
- A task's reference is <epic>.<task>, e.g. 3.579 or 2.PZ-001. The ID column keeps the task's own ID verbatim.
  Depends cells hold comma-separated references in that form, each resolving to an existing row.
- Status is exactly one of:
  - todo: not started; nobody has picked it up (Owner empty or "owner").
  - in_progress: an agent is working on it now. Owner is that agent; ETA is required.
  - in_review: a PR is open and waits on CI, review or merge. Link the PR in Notes; ETA is the expected merge.
  - blocked: cannot proceed because of something other than the owner's input: another row (name its ID in
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
  - done: merged or verified; Notes hold the evidence (PR, commit, check).
  When converting an old or free-text status, only rows that need the owner's input become blocked_on_owner; every
  other blocked row becomes blocked, except work the owner paused or held, which becomes parked.
- Branch is the git branch doing the row's work, when it can be determined (named in the row's notes or owner, or a
  registered worktree or open PR whose branch or task folder matches the row's owner or id); otherwise empty.
  Never invent one.
- ETA is YYYY-MM-DD HH:MM <timezone> (a timezone abbreviation, e.g. ICT, or an offset such as +07:00), or empty.
- Existing IDs are kept verbatim (numbers, PZ-001, CF-…). Checklist items without an ID get new IDs
  <REPOPREFIX>-<n>, continuing from the board's highest number.
- Cells are not padded: no run of two or more spaces next to a pipe.
- Prose that is not a task (status notes, decisions, conventions) is kept verbatim above the first epic, or
  under its own heading. Nothing is deleted.`

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
- Preserve every task and every piece of text; delete nothing.
- Number the epics in file order starting at 1, keeping any existing number (\`Task 12\`, \`12.\`) and never renumbering. Rewrite every Depends cell to comma-separated \`<epic>.<task>\` references. Leave Notes prose as written.
- If the repository's CI uses \`ThomasMcFarlane/ai-tools/actions/tasks-board-check@tasks-board-check-v1\`, change it to \`@tasks-board-check-v2\` in the same PR.
- If an ID appears twice, renumber the later duplicate to the next free ID in that board's numbering and note its old ID in Notes.
- Verify with a script, kept outside the repository, that every original ID is present exactly once afterwards, and that the open and done counts match before and after.
- Commit, push, and run \`gh pr create\` titled "${FIX_PR_TITLE}".
- Do NOT merge the PR.
- Report the PR URL.${extra ? `\n\nAdditional rules:\n${extra}` : ''}`
