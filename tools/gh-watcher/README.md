# @ai-tools/gh-watcher

Watch every check on a commit (GitHub Actions runs, third-party check runs and
commit statuses such as Terraform Cloud), fire hooks when a step fails or
everything succeeds, and watch pull request events (draft, ready, merged, closed,
comments, reviews, pushes).

Built for AI agents: pick a PR, branch, commit or run, then either block on `wait` for a
terminal state or register a persistent watch that fires hooks. Every command is
non-interactive and exit-code driven.

## Webhooks through the relay only (0.7.0)

gh-watcher was designed for webhooks from the start. Since 0.7.0 this is the only mode.

- The agent never polls GitHub. gh-watcher makes no `gh` call and no GitHub API call.
- Every command asks the relay, a private service that receives the GitHub webhooks.
- The relay is the one central poller. One tracker for a commit or pull request serves every waiter, so the relay polls each target once.
- The relay polls GitHub only for owners that have no webhooks installed. It warns about this in the `warning` field.
- There is no silent fallback. If the relay does not answer, gh-watcher says so and retries only the relay.

Set the relay base URL with `--events-url <url>` or the `GH_WATCHER_EVENTS_URL` environment variable.
The relay contract is in [Relay API](#relay-api).

### Removed flags

`--source`, `--interval` and `--fallback-interval` were removed from every command.
If you pass one, gh-watcher prints this line to stderr and exits with code `2`:

```
gh-watcher: polling was removed; gh-watcher always uses the relay (drop --source/--interval)
```

`watch add --interval` stays. It sets how often the watch daemon asks the relay. It does not poll GitHub.

### Relay problems

| Situation | What gh-watcher does |
| --- | --- |
| Relay URL not set | Prints `gh-watcher: ERROR no relay configured (set GH_WATCHER_EVENTS_URL)` to stderr and exits `2` at once. With `--json` it also prints `{"error":"relay_not_configured",...}`. |
| Relay set but the request fails (timeout, HTTP error, connection error) | Prints one line to stderr that names the real cause: `gh-watcher: ERROR relay timed out after <N> s at <url>` (the request timeout is the wait plus 10 s), `gh-watcher: ERROR relay answered HTTP <code> at <url>`, or `gh-watcher: ERROR relay connection failed at <url>: <errno or message>` (ECONNREFUSED, ENOTFOUND, ECONNRESET and so on). An answer that cannot be read prints `relay sent an unreadable answer at <url>: <detail>`. Retries only the relay, after 5 s, then 10 s, 20 s, 40 s and 60 s (the maximum). |
| Still not reachable at `--timeout` | Exits `2`. With `--json` it prints `{"error":"relay_unreachable","url":"...","message":"..."}`. |
| Relay answers HTTP 400 | Exits `2` at once. A retry cannot help. |
| Relay sends `warning` | Prints it once to stderr, for example that the relay polls GitHub because no webhooks are installed. |
| Relay sends `stale: true` or `error` | Prints the error once and keeps waiting on the relay. The relay still shows its last good data. |

## Requirements

- Node >= 20 and npm when building from source; the prebuilt binaries are self-contained and need no Node.
- The URL of a relay (see above).
- A repository, given as `--repo OWNER/NAME` or the `GH_REPO` environment variable.
- The `gh` CLI is not needed.

## Install and build

Quickest path: download a prebuilt binary from the `gh-watcher-v<version>` release on the Releases page of this repository (for example `https://github.com/ThomasMcFarlane/ai-tools/releases/download/gh-watcher-v<version>/gh-watcher-linux-x64`). Artifacts follow the pattern `gh-watcher-<os>-<arch>`: `gh-watcher-linux-x64`, `gh-watcher-linux-arm64`, `gh-watcher-macos-x64`, `gh-watcher-macos-arm64` and `gh-watcher-win-x64.exe`. Make the downloaded file executable (`chmod +x`), put it on your `PATH`, and verify with `gh-watcher --help`. The binaries are self-contained and need no Node at runtime. On macOS they are unsigned: remove the quarantine attribute with `xattr -d com.apple.quarantine gh-watcher` or approve the binary in System Settings on first run.

Alternatively, build from source (requires Node >= 20 and npm). From the repository root:

| Step | Command |
| --- | --- |
| Install workspace dependencies | `npm install` |
| Build every workspace (recommended) | `npm run build` |
| Build only this tool | `npm run build -w @ai-tools/gh-watcher` |
| Package self-contained native binaries | `npm run build:bin` |
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

Every command that reads check or pull request state takes `--events-url <url>`
(default `$GH_WATCHER_EVENTS_URL`). Durations accept a bare number (seconds) or a unit suffix: `250ms`, `30s`, `5m`, `1h`.

### gh-watcher status

Read the state of all checks for a target once, from the relay.

```sh
gh-watcher status [options]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--repo <owner/name>` | `$GH_REPO` | Repository in OWNER/NAME form. |
| `--pr <number>` | | Pull request number. Exactly one target flag required. |
| `--branch <name>` | | Branch name. |
| `--commit <sha>` | | Commit sha (the relay needs the full 40 characters). |
| `--run <id>` | | Run id. |
| `--events-url <url>` | `$GH_WATCHER_EVENTS_URL` | Relay base URL. |
| `--timeout <duration>` | `10m` | Longest wait for an unreachable relay, capped at 24h. |
| `--json` | off | Emit the check report as JSON. |

Prints `repo target is <state>`, a table of runs, a table of other checks, the failed steps and the
failed checks. `status` exits `0` even when the state is `failure`.
The JSON report has `source: "relay"`, `relaySource` (`webhook` or `relay-poll`) and, when the relay sends one, `warning`.

| Code | Meaning |
| --- | --- |
| `0` | Report printed (any state) |
| `2` | Error: bad flags, relay unreachable at `--timeout`, or relay rejected the request |

### gh-watcher wait

Block until all checks for a target succeed or fail. `wait` long-polls the relay
(`/api/status?after=<rev>&wait=25`), so it returns at once when the relay learns of a change.

```sh
gh-watcher wait [options]
```

Takes the same target flags as `status`, plus:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--timeout <duration>` | `30m` | Overall wait limit, capped at 24h. |
| `--events-url <url>` | `$GH_WATCHER_EVENTS_URL` | Relay base URL. |
| `--json` | off | Emit the outcome as JSON. |

While it waits, `wait` writes a `.` to stderr for each change that leaves the state pending,
and a line `check 'NAME' is STATUS` when a non-Actions check appears or changes. On failure the outcome lists
`failedSteps` and `failedChecks`. The JSON outcome carries `source` (always `"relay"`), `relaySource` and `warning`.

| Code | Meaning |
| --- | --- |
| `0` | Aggregate state reached `success` |
| `1` | Aggregate state reached `failure` |
| `124` | Timed out while still `pending` (JSON: `{"state":"pending","timedOut":true,"source":"relay"}`) |
| `2` | Error: bad flags, or the relay is unreachable or rejected the request |

### gh-watcher follow

Like `wait`, but print one JSON line to stdout for each change. It asks the relay for jobs (`jobs=1`).

```sh
gh-watcher follow --repo octo-org/hello-world --pr 17
```

Takes the target flags and the `--timeout` and `--events-url` flags of `wait`. Each line:

```json
{"repo":"octo-org/hello-world","targetKey":"pr:17","state":"pending","runs":[{"databaseId":1,"workflowName":"CI","status":"in_progress","conclusion":null,"url":"https://example.com/run/1","attempt":1,"jobs":[{"name":"build","status":"in_progress","conclusion":null,"url":"https://example.com/job/2","steps":[{"name":"Test","number":3,"status":"in_progress","conclusion":null}]}]}],"checks":[],"failedSteps":[],"failedChecks":[],"source":"relay","relaySource":"webhook","checkedAt":"2026-01-01T00:01:00.000Z","isFinal":false}
```

Runs carry the fields of `status --json` plus `jobs`. The last line has `isFinal: true`
(and `timedOut: true` on timeout). If the relay is unreachable at `--timeout`, the last line is
`{"error":"relay_unreachable",...}`. Exit codes match `wait`.

### gh-watcher pr status

Show a pull request once, from the relay (`/api/pr-status`).

```sh
gh-watcher pr status --repo octo-org/hello-world --pr 17
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--repo <owner/name>` | `$GH_REPO` | Repository in OWNER/NAME form. |
| `--pr <number>` | | Pull request number. Exactly one of `--pr` and `--branch` is required. |
| `--branch <name>` | | Head branch; the relay finds the newest pull request with this head. |
| `--events-url <url>` | `$GH_WATCHER_EVENTS_URL` | Relay base URL. |
| `--timeout <duration>` | `10m` | Longest wait for an unreachable relay, capped at 24h. |
| `--json` | off | Emit the snapshot as JSON. |

Human output is one line (`repo #N is OPEN (draft): title [head sha, review decision ...]`), then the
counts of comments, reviews and inline review comments, then the latest review of each author. `--json` emits the snapshot:
`number`, `url`, `title`, `state` (`OPEN`, `CLOSED` or `MERGED`), `isDraft`, `headSha`, `headRef`,
`reviewDecision` (or `null`), `mergedAt`, `closedAt`, `comments`, `reviews`, `reviewComments` and `checkedAt`.
A `--branch` without a pull request prints `{"state":"none"}` (JSON) and exits `0`.

| Code | Meaning |
| --- | --- |
| `0` | Snapshot printed (including a branch with no pull request) |
| `2` | Error: bad flags, relay unreachable at `--timeout`, or relay rejected the request |

### gh-watcher pr wait

Block until a wanted pull request event happens. The wait long-polls `/api/pr-status`
and compares each answer with the previous one.

```sh
gh-watcher pr wait --repo octo-org/hello-world --pr 17 --on merged,closed --timeout 2h --json
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--repo <owner/name>` | `$GH_REPO` | Repository in OWNER/NAME form. |
| `--pr <number>` / `--branch <name>` | | Exactly one is required. With `--branch` and no pull request yet, the wait continues until the relay reports one (that is `opened`). |
| `--on <kinds>` | `any` | Comma-separated event kinds, or `any` (all kinds). An unknown kind exits `2`. |
| `--timeout <duration>` | `30m` | Overall limit, capped at 24h. |
| `--since <time>` | | ISO 8601 time. Comments, reviews and inline comments created after it count as new even when already present in the first answer. The relay filters by this time. |
| `--changes-only` | off | Do not match a state the pull request is already in. |
| `--events-url <url>` | `$GH_WATCHER_EVENTS_URL` | Relay base URL. |
| `--json` | off | Emit the outcome as JSON (no progress dots). |

Event kinds:

| Kind | Meaning |
| --- | --- |
| `opened` | The pull request exists (for `--branch`: it appeared). |
| `reopened` | A closed pull request was reopened. |
| `closed` | Closed without merging. |
| `merged` | Merged. |
| `draft` | Converted to draft. |
| `ready` | Marked ready for review. |
| `comment` | New conversation comment. |
| `review` | New submitted review; carries `reviewState` (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`). Pending reviews are ignored until submitted. |
| `review_comment` | New inline review comment (carries `path`). |
| `push` | The head commit changed (`from`, `to`). |
| `review_decision` | The review decision changed (`from`, `to`; `null` means none). |

The first answer is the baseline. With `--since`, the relay sends every comment, review and inline comment after that time, so none is missed. The wait returns as soon as the change since the previous answer
contains a wanted kind. Unless `--changes-only` is given, a state the pull request is already in
also matches when the kind is named explicitly (for example `--on merged` on a merged pull request
returns at once, with `"initial": true` on the event). `--on any` never matches the initial state.

```json
{
  "matched": true,
  "events": [{ "kind": "merged", "at": "2026-01-03T00:00:00Z" }],
  "pr": { "number": 17, "url": "https://github.com/octo-org/hello-world/pull/17", "state": "MERGED", "isDraft": false, "headSha": "...", "reviewDecision": "APPROVED" },
  "source": "relay",
  "relaySource": "webhook"
}
```

On timeout the outcome is `{"matched":false,"timedOut":true,"events":[],"source":"relay"}`.

| Code | Meaning |
| --- | --- |
| `0` | A wanted event matched |
| `2` | Error: bad flags, relay unreachable at `--timeout`, or relay rejected the request |
| `124` | Timed out |

### gh-watcher pr follow

Like `pr wait`, but keep going: print one JSON line to stdout for each wanted event until the
pull request is merged or closed, or the timeout ends. Takes the flags of `pr wait` (without `--json`).
Each line is the event with the repository and pull request number:
`{"repo":"octo-org/hello-world","pr":17,"kind":"review","at":"...","author":"alice","reviewState":"APPROVED"}`.
On timeout the last line is `{"repo":"...","timedOut":true,"source":"relay"}`.
Exit codes: `0` merged or closed, `2` error, `124` timed out.

### gh-watcher watch add

Add a persistent watch.

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
| `--on <event>` | `complete` | Comma-separated list mixing `failure`, `success`, `complete` (any terminal state) and pull request kinds (see [`pr wait`](#gh-watcher-pr-wait); `any` means every pull request kind). Pull request kinds need `--pr` or `--branch`. |
| `--interval <duration>` | `60s` | How often the daemon asks the relay for this watch. It never polls GitHub. |
| `--hook <spec>` | `none` | Hook specification, see [Hooks](#hooks). |
| `--json` | off | Emit the saved spec as JSON. |

Exit `1` if a watch with the same name already exists; `2` for invalid target flags, an invalid
`--on` value, or pull request kinds on a `--commit` or `--run` target.
A watch with only pull request kinds has no CI triggers and does not read runs.

### gh-watcher watch list

List saved watches. `--json` emits the raw specs.

### gh-watcher watch show

`gh-watcher watch show <name>` prints the full spec as JSON. Exit `1` for an unknown name.

### gh-watcher watch remove

`gh-watcher watch remove <name>` removes a watch. Exit `1` for an unknown name.

### gh-watcher watch check

```sh
gh-watcher watch check [names...] [--events-url <url>] [--json]
```

Check watches once and fire hooks on every trigger (manual checks bypass edge
suppression). Omit names to check all watches. Exit codes: `0` when at least one hook fired,
`1` when none fired, `2` for an unknown name or a relay problem.

### gh-watcher watch run

```sh
gh-watcher watch run [names...] [--events-url <url>]
```

Run the watch daemon until interrupted (Ctrl+C or SIGTERM). The daemon sweeps every 5
seconds and asks the relay for each watch when its `--interval` has elapsed. If the relay is
unreachable, the daemon prints the error and tries again at the next sweep.
Daemon checks are edge-fired: see [State semantics](#state-semantics). Exit `2` at startup if a given name is unknown.

### gh-watcher watch events

`gh-watcher watch events [--tail <n>] [--json]` shows recent watch events, oldest first
(`--tail` defaults to `20`). Events come from `events.jsonl` (see [State files](#state-files)).

## Relay API

The relay serves these endpoints on its tailnet host and in-cluster Service. The public host does not.
Long-polls wait at most 25 seconds (`wait` is clamped to 25).

### `GET /api/status`

```
/api/status?repo=OWNER/NAME&sha=<40-hex>&after=<rev>&wait=<seconds>&jobs=<0|1>
/api/status?repo=OWNER/NAME&pr=<n>&...
/api/status?repo=OWNER/NAME&branch=<name>&...
/api/status?repo=OWNER/NAME&run=<id>&...
```

`after` is the last `rev` the client saw. The relay answers at once when its `rev` is higher,
else it blocks until the state changes or `wait` ends, and then answers with `changed: false`.
Answer fields used by the client:

| Field | Meaning |
| --- | --- |
| `rev` | Revision of the snapshot. |
| `boot` | Random string per relay process. When it differs from the last one seen, the client resets `after` to 0 and treats the snapshot as fresh. |
| `changed` | `false` when the long-poll ended with no change. |
| `source` | `webhook` or `relay-poll`. |
| `warning` | Optional text, for example that the relay polls because no webhooks are installed. Printed once. |
| `stale`, `error` | The relay could not refresh from GitHub (`error` has `kind`, `message`, `retry_at`). The data is the last good snapshot. Printed once. |
| `runs[]` | Workflow runs. `jobs[]` (with `steps[]`) appears when `jobs=1`, and always for a failed run. |
| `check_runs[]` | Check runs of apps other than `github-actions`. |
| `statuses[]` | Commit statuses. |

The relay answers `400` for bad parameters and `503` when its waiter limit is full. gh-watcher
treats `503` and network errors as "relay unreachable" and retries. It stops at once on `400`.

### `GET /api/pr-status`

```
/api/pr-status?repo=OWNER/NAME&pr=<n>&after=<rev>&wait=<seconds>
/api/pr-status?repo=OWNER/NAME&branch=<name>&after=<rev>&wait=<seconds>
/api/pr-status?repo=OWNER/NAME&pr=<n>&since=<ISO>&...
```

`pr wait --since` sends `since`. The answer then also carries `comments[]`, `review_comments[]` and `reviews[]` with every item after `since`, oldest first, in the same item shape (`truncated: true` when the relay capped them at 100). The client matches on these arrays, and uses the `latest_*` items only when the arrays are absent.

The answer has the same `rev`, `changed`, `source`, `warning`, `stale` and `error` fields, and:

| Field | Meaning |
| --- | --- |
| `pr` | Pull request number (needed for `--branch`). |
| `state` | `open`, `closed`, `merged`, or `none` when the branch has no pull request. |
| `draft`, `html_url`, `head_sha`, `head_ref`, `base_ref`, `review_decision` | Pull request fields. `title` is not sent. |
| `merged_at`, `updated_at` | Times; missing or `null` means unknown. |
| `latest_comment` (issue comments only), `latest_review_comment` (inline), `latest_review` | The newest item of each kind, or `null`. Items are `{id, created_at, updated_at, user}`; reviews are `{id, state, submitted_at, user}`. `user` is the author (a login string or `{login}`). |

## Targets

Every `status`, `wait` and `watch add` takes exactly one of `--pr N`, `--branch B`,
`--commit SHA` or `--run ID`. Giving none, or more than one, is an error (exit `2`).
Validation: `--pr` and `--run` take positive integers, `--commit` takes 4 to 40
hexadecimal characters (the relay needs 40), `--branch` must be non-empty.

The relay resolves a pull request or branch to its head commit. It follows a new head commit
when a `pull_request` or `push` webhook arrives. Only runs for a single commit are in a snapshot, so results
from superseded commits cannot leak into the aggregate state. Within that commit, only the newest run of
each workflow name is kept (latest `createdAt`, then highest run id), so a re-run that succeeds supersedes
the failed attempt. A new head commit with no runs yet reports `none`.

### All checks, not only Actions

The snapshot also lists checks that are not Actions workflow runs (a `--run` target is Actions-only).
They are reported in `checks`:
each entry is `{kind: "check_run" | "status", name, source, status, conclusion, url, updatedAt?}`.
`source` is the app slug (check run) or the host of the status target URL (empty when there is none).
`status` is `pending`, `success` or `failure`.

| Raw | `status` |
| --- | --- |
| check run not `completed` | `pending` |
| check run conclusion `success`, `neutral`, `skipped` | `success` |
| any other completed conclusion (`failure`, `cancelled`, `timed_out`, `action_required`, ...) | `failure` |
| check run conclusion `stale` | ignored |
| status `pending` | `pending` |
| status `success` | `success` |
| status `failure`, `error` | `failure` |

Failed non-Actions checks are listed in `failedChecks` as `{kind, name, source, url}`.

## State semantics

The aggregate state of a target is derived from its Actions runs and its other checks:

| State | Condition |
| --- | --- |
| `none` | No runs and no other checks found for the target. |
| `pending` | Any run has `status` other than `completed`, or any other check is pending. |
| `failure` | Nothing pending and at least one run conclusion or other check is a failure. |
| `success` | Nothing pending and nothing failed. |

Failure conclusions: `failure`, `cancelled`, `timed_out`, `startup_failure`,
`action_required`.

Success conclusions: `success`, `neutral`, `skipped`.

Step-level failure collection: the relay always sends the jobs of a failed run.
For each failure-like job, every step with conclusion `failure` is recorded
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
- The edge is keyed by the set of run IDs of the runs considered (head commit, latest
  run per workflow) plus every other check with its status, so any status change of any check
  resets the edge. A key saved by an older version (run ids only) counts as the same edge as
  the new key when the run ids match, so an upgrade does not refire. A new attempt (a new run, e.g. after a push or sync) produces a different key, which resets the previous state to
  `none`, so the hook can fire again for the new attempt.

Pull request events (`prEvents` watches):

- The first check of a watch only records the baseline (`lastPr`) and fires nothing. Unlike
  `pr wait`, the daemon never matches an initial state.
- Later checks diff the pull request against `lastPr` and fire the hook once per check when any
  wanted event is found. A `--branch` target that had no pull request at the first check reports
  `opened` when one appears.
- A watch whose triggers are both off (only pull request kinds) skips listing CI runs.

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
| `EVENT_SUMMARY` | Multi-line summary: state line plus up to three failed steps and up to three failed checks. |

The event payload itself carries: `summary`, `watch`, `repo`, `targetKey`, `state`,
`failedSteps` (each with `runId`, `workflowName`, `jobName`, `stepName`, `stepNumber`),
`failedChecks`, `runsCount`, `checksCount`, `checkedAt`. A watch with pull request kinds fires `summary`, `watch`, `repo`,
`targetKey`, `prEvents` (the matched events) and `pr` (`number`, `url`, `state`, `isDraft`,
`headSha`, `reviewDecision`); when a CI trigger fires in the same check the CI fields are included
too.

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
gh-watcher wait --repo octo-org/hello-world --pr 17 --timeout 45m --json &
```

- Exit `0`: all runs succeeded; the JSON outcome has `state: "success"`.
- Exit `1`: something failed; the JSON outcome lists `failedSteps` so the agent can go
  straight to the broken step.
- Exit `124`: still pending at the timeout; wait again or run `status`.
- Exit `2`: a bad flag or a relay problem. Never replace the call with your own `gh` polling.

Watcher plus notify for long horizons:

```sh
gh-watcher watch add ci-main --repo octo-org/hello-world --branch main \
  --on failure --interval 60s --hook notify:claude
gh-watcher watch run ci-main
```

The daemon fires the hook once per new failing run, and the notified agent receives the
summary plus the first three failed steps.

Timing defaults:

| Context | Default |
| --- | --- |
| `wait` overall timeout | `30m`, capped at 24h |
| Relay long-poll | 25 s per request |
| Relay retry back-off | 5 s, doubling to 60 s |
| `watch add` interval | `60s` |
| Daemon sweep cadence | every 5 s (asks the relay for each watch when due) |

## Privacy

- gh-watcher reads no GitHub token and calls no GitHub API. It talks only to the relay you configure.
- Watch state stays in the local state directory.
- No telemetry and no analytics.
