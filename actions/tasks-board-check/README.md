# tasks-board-check action

```yaml
- uses: actions/checkout@v4
- uses: ThomasMcFarlane/ai-tools/actions/tasks-board-check@tasks-board-check-v2
  with:
    path: TASKS.md # default
    format: canonical # or lenient while migrating
```

The action runs a committed, bundled `dist/index.js` with Node from `actions/setup-node`, so the calling repository needs no `npm install`. Rebuild it with `npm run build -w @ai-tools/tasks-board-check` and commit the result whenever the check changes.

## Releasing the Action

Tag a release as `tasks-board-check-vX.Y.Z` and move the major tag `tasks-board-check-vX` to the same commit. Never use bare `v*` tags for the Action: they trigger `release.yml`, which publishes the tool binaries.
