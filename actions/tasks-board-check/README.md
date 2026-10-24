# tasks-board-check action

```yaml
- uses: actions/checkout@v4
- uses: ThomasMcFarlane/ai-tools/actions/tasks-board-check@tasks-board-check-v4
  with:
    path: TASKS.md # default
    format: canonical # or lenient while migrating
```

v4 keeps v3's requirements (numeric task IDs, `<epic>.<task>` references) and adds four failing rules, in both `canonical` and (for `cell-count`) `lenient` mode; see `mods/tasks-board/FORMAT.md`, "Writing rows":

- `cell-count`: every table row has exactly the header's number of cells (escape literal pipes as `\|`).
- `epic-name`: an epic with open rows has a descriptive name, not a position, status or date (`Active`, `Backlog`, `Follow-ups 1.140 to 1.155`, `Archive: ... (2026-08-28)`).
- `long-cell`: an open row has a Task of at most 100 characters and Notes of at most 400.
- `wall-of-text`: no line over 400 characters under an epic with open rows.

Closed rows (`done`, `dropped`, `superseded`) are exempt from the length limits.

The action only validates. To repair mechanical table problems (multi-line rows, padding, missing or surplus cells, `<br/>`) run the fixer locally, which rewrites the file and then checks it:

```sh
node <ai-tools>/actions/tasks-board-check/dist/index.js --fix TASKS.md
```

The action runs a committed, bundled `dist/index.js` with Node from `actions/setup-node`, so the calling repository needs no `npm install`. Rebuild it with `npm run build -w @ai-tools/tasks-board-check` and commit the result whenever the check changes.

## Releasing the Action

Tag a release as `tasks-board-check-vX.Y.Z` and move the major tag `tasks-board-check-vX` to the same commit. Never use bare `v*` tags for the Action: they trigger `release.yml`, which publishes the tool binaries.
