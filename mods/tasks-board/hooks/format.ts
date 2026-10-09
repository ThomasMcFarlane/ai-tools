// Keep in step with FORMAT.md at the plugin's root.
export const FORMAT_SPEC = `Canonical TASKS.md format ("epic tables"):

# Tasks
## <Epic name>
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| PZ-001 | … | in_progress | agent-name | feat/pz-001 | PZ-000 | 2026-10-10 14:00 ICT | … |

- One ## heading per epic; one table per epic, with exactly the header above.
- Status is exactly one of: todo, in_progress, in_review, blocked, blocked_on_owner, done.
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
- If an ID appears twice, renumber the later duplicate to the next free ID in that board's numbering and note its old ID in Notes.
- Verify with a script, kept outside the repository, that every original ID is present exactly once afterwards, and that the open and done counts match before and after.
- Commit, push, and run \`gh pr create\` titled "${FIX_PR_TITLE}".
- Do NOT merge the PR.
- Report the PR URL.${extra ? `\n\nAdditional rules:\n${extra}` : ''}`
