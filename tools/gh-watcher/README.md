# @ai-tools/gh-watcher

Watch GitHub Actions runs and checks via `gh`, fire hooks when a step fails or
everything succeeds.

Built for AI agents: pick a PR, branch, commit or run, then either block on `wait` for a
terminal state or register a persistent watch that fires hooks. Every command is
non-interactive and exit-code driven.

## Requirements

- Node >= 20.
- GitHub CLI (`gh`) installed and authenticated. Verify with `gh auth status`.
- A repository, given as `--repo OWNER/NAME` or the `GH_REPO` environment variable.

## Install and build

From the repository root:

| Step | Command |
| --- | --- |
| Install workspace dependencies | `npm install` |
| Build every workspace (recommended) | `npm run build` |
| Build only this tool | `npm run build -w @ai-tools/gh-watcher` |
| Typecheck | `npm run typecheck -w @ai-tools/gh-watcher` |
| Test | `npm run test -w @ai-tools/gh-watcher` |

The bin is `gh-watcher`, mapped to `tools/gh-watcher/dist/cli.js` (see `package.json`).
From the repo root either form works:

```sh
npx gh-watcher --help
node tools/gh-watcher/dist/cli.js --help
```

The package also exports a library API (`exports["."]`).

## Command reference

### gh-watcher status

Check the current state of runs for a target once.

```sh
gh-watcher status [options]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--repo <owner/name>` | `$GH_REPO` | Repository in OWNER/NAME form. |
| `--pr <number>` | | Pull request number. Exactly one target flag required. |
| `--branch <name>` | | Branch name. |
| `--commit <sha>` | | Commit sha. |
| `--run <id>` | | Run id. |
| `--json` | off | Emit the check report as JSON. |

Prints `repo target is <state>`, a table of runs, and any failed steps. Note that
`status` exits `0` even when the reported state is `failure`; it exits non-zero only for
errors.

| Code | Meaning |
| --- | --- |
| `0` | Check completed (any state, including `failure`) |
| `2` | Error: bad target flags, or `gh` failed |

### gh-watcher wait

Poll until runs for a target succeed or fail.

```sh
gh-watcher wait [options]
```

Takes the same target flags as `status`, plus:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--interval <duration>` | `30s` | Poll interval. |
| `--timeout <duration>` | `30m` | Overall wait limit, capped at 24h. |
| `--json` | off | Emit the outcome as JSON. |

Durations accept a bare number (seconds) or a unit suffix: `250ms`, `30s`, `5m`, `1h`.
While polling, a `.` progress dot is written to stderr. On failure the outcome includes
the collected failed steps. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Aggregate state reached `success` |
| `1` | Aggregate state reached `failure` |
| `124` | Timed out while still `pending` (JSON outcome: `{"state":"pending","timedOut":true}`) |
| `2` | Error: `gh` failed or bad flags |

### gh-watcher watch add

Add a new persistent watch.

```sh
gh-watcher watch add [options] <name> --repo <owner/name>
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--repo <owner/name>` | (required) | Repository in OWNER/NAME form. |
| `--pr <number>` | | Watch runs for this pull request. Exactly one target flag required. |
| `--branch <name>` | | Watch runs for this branch. |
| `--commit <sha>` | | Watch runs for this commit. |
| `--run <id>` | | Watch this run. |
| `--on <event>` | `complete` | `failure`, `success` or `complete` (any terminal state). |
| `--interval <duration>` | `60s` | Poll interval used by the daemon. |
| `--hook <spec>` | `none` | Hook specification, see [Hooks](#hooks). |
| `--json` | off | Emit the saved spec as JSON. |

Exit `1` if a watch with the same name already exists; `2` for invalid target flags.

### gh-watcher watch list

List saved watches. `--json` emits the raw specs. Columns include the target, triggers,
interval, hook, `lastCheckedAt` and `lastState`.

### gh-watcher watch show

```sh
gh-watcher watch show <name>
```

Print the full spec as JSON. Exit `1` for an unknown name.

### gh-watcher watch remove

```sh
gh-watcher watch remove <name>
```

Remove a watch. Exit `1` for an unknown name.

### gh-watcher watch check

```sh
gh-watcher watch check [names...]
```

Check watches once and fire hooks on every trigger (manual checks bypass edge
suppression). Omit names to check all watches. `--json` emits the events as a JSON
array. Exit codes: `0` when at least one hook fired, `1` when none fired, `2` when any
given name is unknown.

### gh-watcher watch run

```sh
gh-watcher watch run [names...]
```

Run the watch daemon until interrupted (Ctrl+C or SIGTERM). The daemon sweeps every 5
seconds and checks each watch when its `--interval` has elapsed. Daemon checks are
edge-fired: see [State semantics](#state-semantics). Exit `2` at startup if any given
name is unknown.

### gh-watcher watch events

```sh
gh-watcher watch events [--tail <n>] [--json]
```

Show recent watch events, oldest first. `--tail <n>` defaults to `20`. Events come from
`events.jsonl` (see [State files](#state-files)).

### gh-watcher mcp

Placeholder only. The command currently prints `MCP server not available in this build`
and exits `1`. See [Roadmap](#roadmap).

## Targets

Every `status`, `wait` and `watch add` takes exactly one of `--pr N`, `--branch B`,
`--commit SHA` or `--run ID`. Giving none, or more than one, is an error (exit `2`).
Validation: `--pr` and `--run` take positive integers, `--commit` takes 4 to 40
hexadecimal characters, `--branch` must be non-empty.

How each target resolves to runs (via `gh`):

| Target | Resolution |
| --- | --- |
| `--pr <number>` | `gh pr view <number> --repo R --json headRefName`, then `gh run list --branch <headRefName> --limit 25`. |
| `--branch <name>` | `gh run list --branch <name> --limit 25`. |
| `--commit <sha>` | `gh run list --commit <sha> --limit 25`. |
| `--run <id>` | `gh run view <id> --repo R --json ...` (single run). |

Fetched run fields: `databaseId`, `workflowName`, `displayTitle`, `status`,
`conclusion`, `url`, `headSha`, `createdAt`.

## State semantics

The aggregate state of a target is derived from its runs:

| State | Condition |
| --- | --- |
| `none` | No runs found for the target. |
| `pending` | Any run has `status` other than `completed`. |
| `failure` | All runs completed and at least one conclusion is failure-like. |
| `success` | All runs completed and no conclusion is failure-like. |

Failure conclusions: `failure`, `cancelled`, `timed_out`, `startup_failure`,
`action_required`.

Success conclusions: `success`, `neutral`, `skipped`.

Step-level failure collection: for each failure-like run, `gh run view <id> --json jobs`
is fetched; for each failure-like job, every step with conclusion `failure` is recorded
(workflow, job, step name and number). A failed job with no failed steps is reported as
a job-level failure. Failures are collected only when the aggregate state is `failure`.

`--on` mapping for watches:

| `--on` | Fires when aggregate state becomes |
| --- | --- |
| `failure` | `failure` only. |
| `success` | `success` only. |
| `complete` (default) | `failure` or `success` (any terminal state). |

Edge firing:

- Daemon checks (`watch run`) fire the hook only on the transition into a triggered
  state. Staying in that state does not refire; leaving and re-entering does.
- Manual checks (`watch check`) always fire when the trigger condition holds.
- The edge is keyed by the set of run IDs. A new attempt (a new run, e.g. after a
  re-run, push or sync) produces a different key, which resets the previous state to
  `none`, so the hook can fire again for the new attempt.

## Hooks

Hook spec grammar (`--hook` on `watch add`):

```
none
exec:<command>
webhook:<url>
file:<path>
notify:claude|codex|opencode
```

| Spec | What happens | Timeout |
| --- | --- | --- |
| `none` | Nothing fires. | |
| `exec:<command>` | Runs the command through the shell with the full event JSON on stdin. Succeeds when the command exits 0. | 60s, then SIGKILL |
| `webhook:<url>` | `POST` with `content-type: application/json` and the event JSON as the body. Succeeds on any 2xx. | 60s |
| `file:<path>` | Appends one JSON line to the file, creating parent directories. | |
| `notify:<tool>` | Launches a coding agent CLI with a prompt built from the event summary, full event JSON and an instruction to continue the task. | 600s |

> Security: `exec:` runs an arbitrary shell command from the stored watch spec. Only
> register watch specs you wrote yourself or fully trust.

The notify backends map to `claude -p <prompt>`, `codex exec <prompt>` and
`opencode run <prompt>`.

Environment variables exposed to `exec` and `notify` hooks (exact names from source;
there are no `GH_*` extras):

| Variable | Value |
| --- | --- |
| `EVENT` | Full event JSON. |
| `EVENT_SUMMARY` | Multi-line summary: state line plus up to three failed steps. |

The event payload itself carries: `summary`, `watch`, `repo`, `targetKey`, `state`,
`failedSteps` (each with `runId`, `workflowName`, `jobName`, `stepName`, `stepNumber`),
`runsCount`, `checkedAt`.

## State files

| File | Purpose |
| --- | --- |
| `~/.local/state/ai-tools/gh-watcher/watchers.json` | Watch specs and per-watch last-fired edges. |
| `~/.local/state/ai-tools/gh-watcher/events.jsonl` | One JSON event per line, appended on every check. |

Path resolution: `AI_TOOLS_GH_WATCHER_STATE_DIR` overrides the whole directory;
otherwise `XDG_STATE_HOME` is honoured, defaulting to `~/.local/state` (`%LOCALAPPDATA%`
on Windows). The final directory is `<base>/ai-tools/gh-watcher`.

## Agent patterns

Blocking wait as a background task:

```sh
gh-watcher wait --repo octo-org/hello-world --pr 17 --interval 15s --timeout 45m --json &
```

- Exit `0`: all runs succeeded; the JSON outcome has `state: "success"`.
- Exit `1`: something failed; the JSON outcome lists `failedSteps` so the agent can go
  straight to the broken step.
- Exit `124`: still pending at the timeout; poll `status` or wait longer.

Watcher plus notify for long horizons:

```sh
gh-watcher watch add ci-main --repo octo-org/hello-world --branch main \
  --on failure --interval 60s --hook notify:claude
gh-watcher watch run ci-main
```

The daemon fires the hook once per new failing run, and the notified agent receives the
summary plus the first three failed steps.

Polling intervals to know about:

| Context | Default |
| --- | --- |
| `wait` poll interval | `30s` |
| `wait` overall timeout | `30m`, capped at 24h |
| `watch add` interval | `60s` |
| Daemon sweep cadence | every 5s (checks each watch when due) |

## Roadmap

- A full MCP server is planned. `gh-watcher mcp` is a stub today.
- Until then, `gh-watcher wait` and `gh-watcher watch check` / `watch run` work from any
  agent that can run shell commands and read exit codes.

## Privacy

- All GitHub access goes through your local `gh` binary and its existing
  authentication; no tokens are read or stored by this tool.
- Watch state stays in the local state directory.
- No telemetry, no analytics, no network calls beyond `gh`.
