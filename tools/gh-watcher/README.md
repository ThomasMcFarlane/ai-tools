# @ai-tools/gh-watcher

Watch GitHub Actions runs and checks via `gh`, fire hooks when a step fails or
everything succeeds, and watch pull request lifecycle events (draft, ready, merged, closed,
comments, reviews, pushes).

Built for AI agents: pick a PR, branch, commit or run, then either block on `wait` for a
terminal state or register a persistent watch that fires hooks. Every command is
non-interactive and exit-code driven.

## Requirements

- Node >= 20 and npm when building from source; the prebuilt binaries are self-contained and need no Node.
- GitHub CLI (`gh`) installed and authenticated. Verify with `gh auth status`.
- A repository, given as `--repo OWNER/NAME` or the `GH_REPO` environment variable.

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
| `--timeout <duration>` | `10m` | Longest wait for a GitHub rate limit to lift, see [Shared GitHub queue](#shared-github-queue-and-rate-limits). |
| `--json` | off | Emit the check report as JSON. |

Prints `repo target is <state>`, a table of runs, and any failed steps. Note that
`status` exits `0` even when the reported state is `failure`; it exits non-zero only for
errors.

| Code | Meaning |
| --- | --- |
| `0` | Check completed (any state, including `failure`) |
| `2` | Error: bad target flags, or `gh` failed |
| `124` | A GitHub rate limit did not lift within `--timeout` |

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
| `--source <mode>` | `auto` | `auto`, `events` or `poll`, see [Event mode](#event-mode). |
| `--events-url <url>` | `$GH_WATCHER_EVENTS_URL` | Base URL of the event relay. |
| `--fallback-interval <duration>` | `5m` | Event mode only: safety-net `gh` re-check interval. |
| `--json` | off | Emit the outcome as JSON. |

Durations accept a bare number (seconds) or a unit suffix: `250ms`, `30s`, `5m`, `1h`.
While polling, a `.` progress dot is written to stderr. On failure the outcome includes
the collected failed steps. The JSON outcome carries `source` (`"events"` or `"poll"`), the
mode the wait finished in. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Aggregate state reached `success` |
| `1` | Aggregate state reached `failure` |
| `124` | Timed out while still `pending` (JSON outcome: `{"state":"pending","timedOut":true,"source":"poll"}`) |
| `2` | Error: `gh` failed or bad flags |

A GitHub rate limit is waited out rather than reported as an error; see [Shared GitHub queue](#shared-github-queue-and-rate-limits).

### gh-watcher follow

Like `wait`, but stream progress. It reuses the same wait loop (event mode when a relay is
configured, polling otherwise) and prints one JSON line to stdout per check, always.

```sh
gh-watcher follow --repo octo-org/hello-world --pr 17
```

Takes the target flags and the `--interval`, `--timeout`, `--source`, `--events-url` and
`--fallback-interval` flags of `wait`. Each line:

```json
{"repo":"octo-org/hello-world","targetKey":"pr:17","state":"pending","runs":[{"databaseId":1,"workflowName":"CI","status":"in_progress","conclusion":null,"url":"https://example.com/run/1","startedAt":"2026-01-01T00:00:00Z","attempt":1,"jobs":[{"name":"build","status":"in_progress","conclusion":null,"url":"https://example.com/job/2","steps":[{"name":"Test","number":3,"status":"in_progress","conclusion":null}]}]}],"failedSteps":[],"source":"events","checkedAt":"2026-01-01T00:01:00.000Z","isFinal":false}
```

Runs carry the fields of `status --json` plus `startedAt`, `updatedAt`, `attempt` and `jobs`. Jobs are
fetched for non-terminal runs on every check and for a finished run once; they are not
refetched afterwards. The last line has `isFinal: true` (and `timedOut: true` on timeout).
Exit codes match `wait`: `0` success, `1` failure, `124` timeout, `2` error. `wait` and
`status` output is unchanged.

### gh-watcher pr status

Show a pull request once: state, comment and review counts, and the latest review of each author.

```sh
gh-watcher pr status --repo octo-org/hello-world --pr 17
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--repo <owner/name>` | `$GH_REPO` | Repository in OWNER/NAME form. |
| `--pr <number>` | | Pull request number. Exactly one of `--pr` and `--branch` is required. |
| `--branch <name>` | | Head branch; the newest pull request (any state) with this head is used. |
| `--timeout <duration>` | `10m` | Longest wait for a GitHub rate limit to lift, capped at 24h. |
| `--json` | off | Emit the snapshot as JSON. |

Human output is one line (`repo #N is OPEN (draft): title [head sha, review decision ...]`), then the
counts of comments, reviews and inline review comments, then `latest review by <author>: <STATE>`
lines. `--json` emits the full snapshot: `number`, `url`, `title`, `state` (`OPEN`, `CLOSED` or
`MERGED`), `isDraft`, `headSha`, `headRef`, `reviewDecision` (or `null`), `mergedAt`, `closedAt`,
`comments`, `reviews`, `reviewComments` and `checkedAt`. A `--branch` without a pull request prints
`{"state":"none"}` (JSON) and exits `0`.

| Code | Meaning |
| --- | --- |
| `0` | Snapshot printed (including a branch with no pull request) |
| `2` | Error: bad flags, or `gh` failed |
| `124` | A GitHub rate limit did not lift within `--timeout` |

### gh-watcher pr wait

Block until a wanted pull request event happens.

```sh
gh-watcher pr wait --repo octo-org/hello-world --pr 17 --on merged,closed --timeout 2h --json
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--repo <owner/name>` | `$GH_REPO` | Repository in OWNER/NAME form. |
| `--pr <number>` / `--branch <name>` | | Exactly one is required. With `--branch` and no pull request yet, the wait polls until one appears (that is `opened`) and then continues on it. |
| `--on <kinds>` | `any` | Comma-separated event kinds, or `any` (all kinds). An unknown kind exits `2`. |
| `--interval <duration>` | `60s` | Poll interval. |
| `--timeout <duration>` | `30m` | Overall limit, capped at 24h. |
| `--since <time>` | | ISO 8601 time. Comments, reviews and inline comments created after it count as new even when already present in the baseline; this closes the race between acting (for example posting a comment) and starting the wait. |
| `--changes-only` | off | Do not match a state the pull request is already in. |
| `--source <mode>` | `auto` | `auto`, `events` or `poll`, see [Pull request event mode](#pull-request-event-mode). |
| `--events-url <url>` | `$GH_WATCHER_EVENTS_URL` | Base URL of the event relay. |
| `--fallback-interval <duration>` | `5m` | Event mode only: safety-net `gh` re-check interval. |
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

The wait takes a baseline snapshot, then polls every `--interval` and returns as soon as the change
since the previous poll contains a wanted kind. Unless `--changes-only` is given, a state the
pull request is already in also matches when the kind is named explicitly (for example
`--on merged` on a merged pull request returns at once, with `"initial": true` on the event). The
initial state is the state kinds `opened` (open), `draft` or `ready` (open), `closed` and `merged`.
`--on any` never matches the initial state, otherwise every open pull request would return at once.

```json
{
  "matched": true,
  "events": [{ "kind": "merged", "at": "2026-01-03T00:00:00Z" }],
  "pr": { "number": 17, "url": "https://github.com/octo-org/hello-world/pull/17", "state": "MERGED", "isDraft": false, "headSha": "...", "reviewDecision": "APPROVED" },
  "source": "poll"
}
```

`events` lists every event seen since the baseline, wanted or not. On timeout the outcome is
`{"matched":false,"timedOut":true,"events":[],"source":"poll"}` (`events` holds any unwanted
events seen). A progress dot is written to stderr per poll unless `--json` is given.

With a relay configured the wait uses event mode instead of polling `gh` every `--interval`; see
[Pull request event mode](#pull-request-event-mode). The outcome's `source` is `"events"` or `"poll"`.

| Code | Meaning |
| --- | --- |
| `0` | A wanted event matched |
| `2` | Error: bad flags, or `gh` failed |
| `124` | Timed out, or a GitHub rate limit did not lift before the deadline |

### gh-watcher pr follow

Like `pr wait`, but keep going: print one JSON line to stdout per detected wanted event until the
pull request is merged or closed, or the timeout ends.

```sh
gh-watcher pr follow --repo octo-org/hello-world --pr 17 --on comment,review,push
```

Takes the same flags as `pr wait`, including `--source`, `--events-url` and `--fallback-interval` (without `--json`; output is always JSON lines). Each line is
the event with the repository and pull request number: `{"repo":"octo-org/hello-world","pr":17,"kind":"review","at":"...","author":"alice","reviewState":"APPROVED"}`.
On timeout the last line is `{"repo":"...","timedOut":true,"source":"poll"}`.

| Code | Meaning |
| --- | --- |
| `0` | The pull request was merged or closed (also when it already was) |
| `2` | Error: bad flags, or `gh` failed |
| `124` | Timed out, or a GitHub rate limit did not lift before the deadline |

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
| `--on <event>` | `complete` | Comma-separated list mixing `failure`, `success`, `complete` (any terminal state) and pull request kinds (see [`pr wait`](#gh-watcher-pr-wait); `any` means every pull request kind). Pull request kinds need `--pr` or `--branch`. |
| `--interval <duration>` | `60s` | Poll interval used by the daemon. |
| `--hook <spec>` | `none` | Hook specification, see [Hooks](#hooks). |
| `--json` | off | Emit the saved spec as JSON. |

Exit `1` if a watch with the same name already exists; `2` for invalid target flags, an invalid
`--on` value, or pull request kinds on a `--commit` or `--run` target.

With pull request kinds the spec gets `prEvents`, and the daemon polls the pull request on each
check. A watch with only pull request kinds (for example `--on merged,closed`) has no CI triggers and
does not list runs at all. Mixed lists (`--on failure,merged`) check both and fire one hook per
check. Specs without `prEvents` behave exactly as before.

### gh-watcher watch list

List saved watches. `--json` emits the raw specs. Columns include the target, triggers (pull
request kinds appear as `pr:<kinds>`, or `pr:any`), interval, hook, `lastCheckedAt` and `lastState`.

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
suppression; pull request events fire for what changed since the last stored check). Omit names to check all watches. `--json` emits the events as a JSON
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

## Event mode

By default `wait` polls GitHub through `gh` every `--interval`. If you run a private webhook
relay that receives GitHub `workflow_run` webhooks and implements the API below, `wait` can
block on the relay instead and make almost no GitHub API calls. The relay is not part of this
repository and no hostname is built in: configure it with `--events-url <url>` or the
`GH_WATCHER_EVENTS_URL` environment variable.

`--source` selects the mode:

- `auto` (default): use events when a URL is configured and the relay answers with
  `owner_mode == "app"` and `workflow_run_subscribed == true`; otherwise poll exactly as before.
- `events`: require a URL (exit `2` without one) and use the relay even if it does not report
  app mode (a warning is logged and the fallback interval carries the load).
- `poll`: never contact the relay.

How `wait` behaves in event mode:

1. Resolve the target to a head commit (PR head, branch tip, commit, or the run's commit), then
   probe the relay for its current `latest_seq`.
2. Run one `gh` status check (the baseline). If it is terminal, exit as usual.
3. Long-poll `/api/runs` (25 seconds at a time) with `after=<last seq>`. Each event for the
   commit is applied to the in-memory run list (matched by `run_id`, one run per
   `workflow_name`, stale attempts and older runs ignored) and the state is recomputed locally,
   with no `gh` call. Event data never ends a wait on its own: when the local state turns
   terminal, one fresh confirming `gh` check decides the outcome (and fetches failed jobs and
   steps). `gh` is also called on the `--fallback-interval` safety net (which also re-resolves a PR
   or branch head, so a new push is picked up), after a relay restart, and when an event lacks
   `run_id`, `workflow_name` or `status`, or would complete a run whose `attempt` is unknown, so it
   cannot be trusted. The wait fetches `attempt` and `updatedAt` so stale attempts and
   out-of-order events are ignored.
4. If `latest_seq` goes backwards (the relay restarted), the sequence is reset and `gh` is
   re-checked immediately.
5. Any relay failure (network error, HTTP 5xx or 503, malformed response) logs one line to
   stderr and the rest of the wait continues as normal polling. The relay never fails a wait.

Exit codes, the JSON outcome and `--timeout` are unchanged. A typical successful wait costs
one baseline `gh` call plus the head-commit resolution; events cost none. Runs created from
events have an empty `displayTitle` until the next full `gh` check.

`watch run` (the daemon) does not use event mode: it remains poll-only, and so do `pr status` and
`prEvents` watches. `pr wait` and `pr follow` have their own event mode, below.

### Pull request event mode

`pr wait` and `pr follow` accept `--source auto|events|poll` (default `auto`), `--events-url` and
`--fallback-interval`, with the same meaning and validation as for `wait`. The relay's
`workflow_run` endpoint is not used for them: they call `GET <base>/api/prs` (contract below).
Relay events are only wake-ups; `gh` stays the source of truth.

1. Probe `/api/prs` with `after=0&wait=0` to learn `latest_seq`, then take the `gh` baseline
   snapshot (the probe comes first so events landing during the baseline are not missed).
2. `auto` uses events only when the probe reports `owner_mode == "app"` and
   `pr_events_subscribed == true`; otherwise it logs one stderr line saying why (even with
   `--json`) and polls exactly as before. `events` needs a URL (exit `2` without one) and uses the
   relay even when it is not usable (a warning is logged). `poll` never contacts the relay. HTTP
   `404` (a host without the endpoint) or any probe failure means polling.
3. In event mode the wait long-polls `/api/prs` (25 seconds at a time) with `after=<last seq>`,
   filtered by `pr` (or by `head_ref` while a `--branch` target has no pull request yet). When an
   event for the target arrives, it re-takes the `gh` snapshot and diffs it exactly as polling
   does; an event alone never matches. `gh` is also checked every `--fallback-interval` as a safety
   net.
4. If `latest_seq` goes backwards (relay restart) `gh` is re-checked and the wait continues from
   the new sequence. Any relay error mid-wait logs one line and the rest of the wait polls.

**Each GitHub App owner must subscribe to the four pull request events** (`pull_request`,
`issue_comment`, `pull_request_review` and `pull_request_review_comment`) for the relay to report
`pr_events_subscribed: true`. Without that, `auto` falls back to polling.

### Relay API contract

```
GET <base>/api/runs?repo=OWNER/NAME&sha=<40-hex>&after=<seq>&wait=<seconds, at most 25>
```

Returns immediately when events with `seq > after` match the repository and commit; otherwise
holds the request for up to `wait` seconds and returns an empty `events` list. Responds `400`
on bad input and `503` when overloaded. The client sends an abort timeout of `wait + 10`
seconds.

```json
{
  "repo": "OWNER/NAME",
  "owner_mode": "app",
  "workflow_run_subscribed": true,
  "latest_seq": 42,
  "buffer_started_at": "2026-01-01T00:00:00Z",
  "events": [
    {
      "seq": 42,
      "received_at": "2026-01-01T00:01:00Z",
      "action": "completed",
      "repo": "OWNER/NAME",
      "run_id": 1,
      "run_attempt": 1,
      "workflow_name": "CI",
      "head_sha": "<40-hex>",
      "head_branch": "main",
      "status": "completed",
      "conclusion": "success",
      "event": "push",
      "html_url": "https://github.com/OWNER/NAME/actions/runs/1",
      "updated_at": "2026-01-01T00:01:00Z",
      "pull_requests": []
    }
  ]
}
```

`owner_mode` is `"app"`, `"poll"` or `"unknown"`; only `"app"` with
`workflow_run_subscribed: true` makes `auto` choose events.

### Pull request relay API contract

```
GET <base>/api/prs?repo=OWNER/NAME&pr=<n>&head_ref=<branch>&after=<seq>&wait=<seconds, at most 25>
```

`pr` and `head_ref` are optional filters. As for `/api/runs`: `400` on bad parameters, `503` when
too many waiters, `404` on hosts without the endpoint (treated as unusable).

```json
{
  "repo": "OWNER/NAME",
  "owner_mode": "app",
  "pr_events_subscribed": true,
  "latest_seq": 7,
  "buffer_started_at": "2026-01-01T00:00:00Z",
  "events": [
    {
      "seq": 7,
      "received_at": "2026-01-01T00:01:00Z",
      "event": "pull_request",
      "action": "closed",
      "repo": "OWNER/NAME",
      "pr": 17,
      "head_sha": "<40-hex>",
      "head_ref": "feature",
      "merged": true,
      "draft": false,
      "actor": "alice",
      "html_url": "https://github.com/OWNER/NAME/pull/17",
      "updated_at": "2026-01-01T00:01:00Z"
    }
  ]
}
```

`event` is one of `pull_request`, `issue_comment`, `pull_request_review` and
`pull_request_review_comment`; `head_sha`, `head_ref`, `merged` and `draft` are optional.

## Shared GitHub queue and rate limits

All agents on a host share one `gh` token, so every gh-watcher process sends its `gh` calls
through a daemon-less queue kept in files under `<state dir>/queue/` (directory mode `0700`,
files mode `0600`, no tokens stored; only `gh` stdout of successful calls):

- Single-flight: an advisory lock file per exact `gh` argument list (`O_EXCL`, with a unique
  token per holder, stale locks recovered by dead owner PID or an age of 3 minutes) ensures that
  concurrent processes asking the same thing make one `gh` call. The result is shared only with
  callers that were already waiting while that call ran; a call that starts after it finished
  always fetches fresh, so a result from before your action is never served. Entries are written
  with an atomic rename and keyed by host (`GH_HOST`), `GH_CONFIG_DIR` and a hash of
  `GH_TOKEN`/`GITHUB_TOKEN` as well as the arguments.
- Global spacing: calls from all processes with the same identity are at least a minimum
  interval apart. No process sleeps while holding a lock.
- Shared cooldown: when any process is rate-limited it records the resume time (per host and
  identity) and every such process waits for it before calling `gh`.
- A `gh` call that hangs is killed after 2 minutes, and daemon shutdown (SIGINT, SIGTERM) ends
  any queued wait at once.

Rate limits are a wait, not a failure. Primary limits ("API rate limit exceeded") resume at the
reset time reported by `gh api rate_limit` (that endpoint is not counted). Secondary limits
honour a `retry-after` when `gh` prints one, else back off exponentially from 60s, capped at 15
minutes. One stderr line per backoff names the resume time. The wait ends at the command's own
`--timeout` (`wait`, `follow`, and `status`, default `10m`): exit `124`, as for any timeout.
Long-running `watch` commands wait at most 10 minutes per call, then report an error.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `GH_WATCHER_CACHE_TTL` | `10` | Upper bound in seconds on how long a finished call may be shared with waiting callers (`0` disables sharing). |
| `GH_WATCHER_MIN_SPACING` | `1` | Minimum seconds between `gh` calls across processes (`0` disables). |
| `GH_WATCHER_QUEUE` | on | Set to `0`, `off` or `false` to bypass the shared queue entirely. |

The state-dir override (`AI_TOOLS_GH_WATCHER_STATE_DIR`) applies to the queue too.

## Targets

Every `status`, `wait` and `watch add` takes exactly one of `--pr N`, `--branch B`,
`--commit SHA` or `--run ID`. Giving none, or more than one, is an error (exit `2`).
Validation: `--pr` and `--run` take positive integers, `--commit` takes 4 to 40
hexadecimal characters, `--branch` must be non-empty.

How each target resolves to runs (via `gh`). Only runs for a single commit are ever
considered, so results from superseded commits cannot leak into the aggregate state:

| Target | Resolution |
| --- | --- |
| `--pr <number>` | `gh pr view <number> --repo R --json headRefName,headRefOid`, then `gh run list --commit <headRefOid> --limit 25`. Falls back to the branch rule below if `headRefOid` is missing. |
| `--branch <name>` | Branch tip resolved with `gh api repos/R/branches/<name> --jq .commit.sha`, then `gh run list --commit <tip> --limit 25`. If the tip cannot be resolved, falls back to `gh run list --branch <name> --limit 25` and keeps only the commit of the most recently created run. |
| `--commit <sha>` | `gh run list --commit <sha> --limit 25`. |
| `--run <id>` | `gh run view <id> --repo R --json ...` (single run). |

Within that commit, only the newest run of each workflow name is kept (latest
`createdAt`, then highest run id), so a re-run that succeeds supersedes the failed
attempt. A branch whose new tip has no runs yet reports `none` rather than the stale
result of the previous commit.

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
- The edge is keyed by the set of run IDs of the runs considered (head commit, latest
  run per workflow). A new attempt (a new run, e.g. after a push or sync) produces a different key, which resets the previous state to
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
| `EVENT_SUMMARY` | Multi-line summary: state line plus up to three failed steps. |

The event payload itself carries: `summary`, `watch`, `repo`, `targetKey`, `state`,
`failedSteps` (each with `runId`, `workflowName`, `jobName`, `stepName`, `stepNumber`),
`runsCount`, `checkedAt`. A watch with pull request kinds fires `summary`, `watch`, `repo`,
`targetKey`, `prEvents` (the matched events) and `pr` (`number`, `url`, `state`, `isDraft`,
`headSha`, `reviewDecision`); when a CI trigger fires in the same check the CI fields are included
too.

## State files

| File | Purpose |
| --- | --- |
| `~/.local/state/ai-tools/gh-watcher/watchers.json` | Watch specs and per-watch last-fired edges. |
| `~/.local/state/ai-tools/gh-watcher/events.jsonl` | One JSON event per line, appended on every check. |
| `~/.local/state/ai-tools/gh-watcher/queue/` | Shared `gh` queue: response cache, call-slot file, cooldown, lock files. |

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

## Privacy

- All GitHub access goes through your local `gh` binary and its existing
  authentication; no tokens are read or stored by this tool.
- Watch state stays in the local state directory.
- No telemetry, no analytics, no network calls beyond `gh` (and the event relay, when configured).
