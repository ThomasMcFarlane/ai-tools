---
name: gh-watcher
description: Check GitHub Actions run state, wait for PR or branch checks, manage watchers, via the gh CLI.
---

# gh-watcher

## When to use

Use this skill whenever a task depends on GitHub Actions state: waiting for PR checks before merging, learning which job step failed, or continuing work once a run finishes. Requires the `gh` CLI installed and authenticated.

## Command reference

The binary is at `<repo>/tools/gh-watcher/dist/cli.js`. Examples below call it as `gh-watcher`.

Every command targets runs with:

- `--repo <owner/name>` (defaults to `GH_REPO`)
- `--pr <number>`, or `--branch <name>`, or `--commit <sha>`, or `--run <id>`

### status: one check, no blocking

```sh
gh-watcher status --repo octo-org/hello-world --pr 17
gh-watcher status --pr 17 --json
```

### wait: block until runs succeed or fail

```sh
gh-watcher wait --repo octo-org/hello-world --pr 17
gh-watcher wait --branch main --timeout 20m --json
```

- `--interval <duration>` (default 30s)
- `--timeout <duration>` (default 30m, capped at 24h)
- `--json`: emit the outcome as JSON

### watch: persistent watches with hooks

```sh
gh-watcher watch add <name> --repo <owner/name> (--pr | --branch | --commit | --run) [--on failure|success|complete]
gh-watcher watch list --json
gh-watcher watch show <name>
gh-watcher watch remove <name>
gh-watcher watch check [names...] --json   # check once, fire hooks on triggers
gh-watcher watch run [names...]            # run the daemon until interrupted
gh-watcher watch events --tail 20 --json
```

`--on` controls the trigger: `failure`, `success` or `complete` (any terminal state; default `complete`). `--hook <spec>` accepts `none` (default), `exec:<command>`, `webhook:<url>`, `file:<path>`, `notify:claude`, `notify:codex` or `notify:opencode`.

## Wait for PR checks, then continue

1. Run in the background: `gh-watcher wait --repo octo-org/hello-world --pr 17 --json`
2. The CLI polls quietly, then prints one JSON outcome.
3. Exit code `0` means the runs succeeded; `1` means a failure was detected (the event lists the failed job steps); `124` means timed out; `2` means error.
4. On `0`, continue the task. On `1`, read `failedSteps` from the JSON and fix the failing step.

## Watchers with notify:claude

```sh
gh-watcher watch add pr-17 \
  --repo octo-org/hello-world --pr 17 \
  --on complete --interval 60s --hook notify:claude
gh-watcher watch run
```

When the PR reaches a terminal state, the daemon runs `claude -p "<event prompt>"` with a summary (and, on failure, the failing step names) asking the agent to continue the task that created the watcher. `--hook exec:<command>` gets `EVENT` and `EVENT_SUMMARY` variables plus the event JSON on stdin.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success: runs succeeded (`wait`) or events fired (`watch check`) |
| 1 | Runs failed, no match, or not found |
| 2 | Error |
| 124 | Timed out (`wait`) |
