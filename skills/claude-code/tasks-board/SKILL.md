---
name: tasks-board
description: Configure, debug or extend the tasks-board mod (the docked TASKS.md board pane in Claude Code), or edit or add TASKS.md board rules, formats or the board format check. Also use when an agent picks up, updates, blocks or finishes a TASKS.md row, to set its status and ETA.
---

# tasks-board

## Working on a board

Statuses (full text in [FORMAT.md](../../../mods/tasks-board/FORMAT.md)):

- `todo`: nobody has picked it up (Owner empty or `owner`).
- `in_progress`: an agent is working on it now; Owner is that agent; ETA required.
- `in_review`: a PR is open; link it in Notes; ETA is the expected merge.
- `blocked`: waits on something other than the owner's input (another row, an agent prerequisite, CI, an external service, a quota). Name the row ID in Depends and say what it waits on in Notes.
- `blocked_on_owner`: only when the owner must give input (a decision, approval, credentials, an action only they can take). Notes state exactly what is needed. Anything an agent or another task can resolve is `blocked`. Never for owner-paused work: use `parked`.
- `parked`: the owner deliberately paused or held the work. Nobody works on it and nothing is needed from the owner until the owner un-parks it. No ETA. Notes say who parked it, when, and the resume condition.
- `done`: merged or verified; Notes hold the evidence. Never for cancelled work.
- `dropped`: terminal; the work was cancelled and never done. Notes start `Dropped: <reason>.`

Old or free-text statuses (`cancelled`, `wontfix`, `deferred`, `on hold`, ...) map as in the Legacy statuses table in FORMAT.md; deferred work is `parked` only when the owner paused it, otherwise `todo` with Notes starting `Deferred: <reason>.`

Epic headings are numbered `## <N>. <name>`; numbers are stable (never renumbered or reused). Reference a task as `<epic>.<task>` (for example `3.579` or `2.PZ-001`) everywhere you name it: Depends cells (comma-separated references), Notes, commit messages, PR titles and bodies, chat and reports.

Update the row as work goes, the moment the state changes, not at the end of the session:

- Pick-up: `in_progress`, Owner, Branch, ETA. PR open: `in_review` plus link. Blocked: status plus what on (row ID or the exact owner question). Finished: `done` plus evidence.
- Every `in_progress` and `in_review` row carries an ETA (`YYYY-MM-DD HH:MM <TZ>`). Revise it as soon as it slips; an open row with an ETA in the past is wrong.
- Add a row as soon as new work is discovered; never leave follow-up work only in chat, logs or PR comments.
- Clear the blocker fields when unblocked.

## What the mod does

`mods/tasks-board` docks a thin pane on the right of the Claude Code terminal that shows the project's `TASKS.md`: what is blocked on you, what this session touched, what is in progress, grouped by epic. Rows expand to show owner, epic, dependencies and notes. Done rows are never shown.

- Open it with `/board`. `/board <file | directory | org/repo>` opens another board for this session; `/board path <file>` is the same. `/board pin|unpin <id...>`, `/board me <tag>`, `/board refresh`, `/board autofix on|off`.
- It rereads the board every 15 s and straight after any Edit or Write of a `TASKS.md`.
- Rows changed in the file within 30 minutes, or touched by this session during a running turn, get a spinner.

## Canonical board format

New boards, and boards the mod rewrites, use the "epic tables" format described in [FORMAT.md](../../../mods/tasks-board/FORMAT.md): one numbered `## <N>. <name>` heading per epic, one table per epic, header `| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |`, status one of `todo`, `in_progress`, `in_review`, `blocked`, `blocked_on_owner`, `parked`, `done`, `dropped`.

The parser also reads other layouts (numeric or prefixed ids, `Picked up by`, `Workstream`, free-text statuses such as `done (merged #12)`, multi-line rows, checklists with `- [ ]`). It keys tables by header names, so a table needs an id column (`#` or `ID`), a task or title column and a status column. `Branch` is parsed but never shown.

A bare `owner` in the Owner column means nobody has picked the row up. "Blocked on you" means the owner must give input (a decision, approval, credentials or an action only they can take); a row blocked by an agent prerequisite, another row, CI or a quota is plain `blocked`. A blocked row counts as blocked on you only with an explicit phrase (`owner action`, `owner decision`, `waiting on the owner`, `blocked on owner decision D7`, the configured `ownerNames` followed by `to decide`) or the status `blocked_on_owner`.

## Options

Declared under `userConfig` in `.claude-plugin/plugin.json`; all optional.

| Option | Default | Meaning |
|---|---|---|
| `baseBoard` | empty | Path template for the primary board with `{org}`, `{repo}`, `{root}`. Example: `{root}/main/{org}/{repo}/TASKS.md`. |
| `reposRoot` | empty | Value of `{root}`; also where the walk-up for a board stops. Example: `/work/repos`. |
| `repoPatterns` | empty | Templates (one per line or `;`-separated) that derive `{org}`, `{repo}` and the worktree name `{task}` from the session root. Example: `{root}/trees/{org}/{task}/{repo}`. First match wins. |
| `fixInstructions` | empty | Extra rules appended to the formatting agent's prompt. Example: `Wait for CI with the team's watcher script.` |
| `autofix` | `true` | Offer non-canonical primary boards for automatic formatting. |
| `excludeWorktreesOlderThanHours` | `48` | Worktree boards older than this are not merged. |
| `maxWorktrees` | `50` | At most this many (the newest) worktree boards are merged. |
| `ownerNames` | empty | Comma- or `;`-separated names whose decision a row may wait on, besides "owner". Example: `Ann, Bo`. |
| `agentPrefixPattern` | empty | Regular expression removed from the start of an agent name when shown. Example: `^bot-\d{8}-`. |

### Where values live

In the `settings.json` of the config directory in use (`~/.claude/settings.json` for the user scope, or the project's `.claude/settings.json` / `.claude/settings.local.json`), under `pluginConfigs`, keyed by `<plugin>@<marketplace>` for an installed plugin (`tasks-board@ai-tools`); `tasks-board` applies only to a `--plugin-dir` load:

```json
{
  "pluginConfigs": {
    "tasks-board@ai-tools": {
      "options": {
        "baseBoard": "{root}/main/{org}/{repo}/TASKS.md",
        "reposRoot": "/work/repos",
        "repoPatterns": "{root}/trees/{org}/{task}/{repo}\n{root}/mirrors/{org}/{repo}",
        "ownerNames": "Ann",
        "autofix": true
      }
    }
  }
}
```

Each field is also a row in `/config`; a change reloads the module. A plugin loaded with `--plugin-dir` is keyed by its `plugin.json` name (or `<name>@inline`); an installed one by name and marketplace.

## Finding the board and merging worktrees

1. A board named with `/board <arg>` for this session wins.
2. Else the configured primary board for the session's repo (`baseBoard` with the org and repo that `repoPatterns` derive from the directory).
3. Else `TASKS.md` in the git **main worktree** (the first entry of `git worktree list --porcelain`, run from the session root).
4. Else the nearest `TASKS.md` above the session root.

The other entries of that `git worktree list` are merged in: only worktrees whose `TASKS.md` changed within `excludeWorktreesOlderThanHours` and after the primary board (the session's own worktree always counts), the newest `maxWorktrees`. A row that is new, or differs in status, title, owner or ETA, is shown tagged `[worktree]`; one variant replaces the primary row, several sit beside it. A worktree that has finished a row the primary still has open shows it dim with `✓`. Scans run every 60 s and cache by file time and size.

## Autofix

After a refresh of the **primary** board (never a walked-up or hand-picked one), if the board is not canonical, `autofix` is on, and no attempt for that repository (taken from `git remote get-url origin`) is recorded in the last 24 hours, the mod records the attempt, checks `gh pr list` for an open "TASKS.md: canonical board format" PR, and otherwise starts one background agent (model `sonnet`) with the prompt in `hooks/format.ts` plus `fixInstructions`. The agent works in a fresh git worktree, rewrites the board, migrates any CI board checker in the same PR, verifies ids and counts, opens a PR and never merges. The pane shows `formatting … board…`, then `format PR: <url>`.

Turn it off for good with `"autofix": false` in the options, or for the session with `/board autofix off`.

## CI

Check boards in CI with the shared format check, which applies the same rules as the mod (canonical header, numbered unique epics, `<epic>.<task>` Depends, status vocabulary, ETA format, duplicate ids, checklist items, padded cells):

```yaml
- uses: actions/checkout@v4
- uses: ThomasMcFarlane/ai-tools/actions/tasks-board-check@tasks-board-check-v2
  with:
    path: TASKS.md
    format: canonical # or lenient while migrating
```

Locally: `node tools/tasks-board-check/dist/cli.js [path] [--format canonical|lenient]`. Lenient reports everything but fails only on duplicate ids and padded cells.

## Extending

- Parsing, format, lint, merge, config: `hooks/board.ts`, `hooks/config.ts`, `hooks/format.ts` (pure, tested in `hooks/board.test.ts`).
- Drawing and engine calls: `hooks/register.tsx`; end-to-end render tests in `hooks/render.test.ts`.
- Check with `claude plugin validate`, `tsc -p` and `claude plugin test` on the mod folder. Keep machine paths, names and workflow rules out of the code: they belong in the options.
