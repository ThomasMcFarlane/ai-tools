---
name: gh-watcher
description: Use gh-watcher for every GitHub Actions and pull request lifecycle wait. Wait for checks before merging, follow exact workflow runs through publication and deployment, and wait for reviews, merges and other pull request events.
---

# gh-watcher

**Use `gh-watcher` for every GitHub Actions and pull request lifecycle wait.**
Start each wait as a background command with `--json`. Keep the session active and continue independent work during the wait. Receive the command's JSON and exit code, then act on the result.

T3 `watch_pull_request` and other harness notifications can supplement the command. Never use a notification in place of the wait or as the sole trigger to resume work. Do not use `gh run watch`, `gh pr checks --watch`, sleep loops, manual status polling or a direct GitHub polling fallback.

- **Claude Code in T3.** Start Bash with `run_in_background: true`. Call `t3_background_wait` with the task ID and keep the turn open until the command completes.
- **Codex in T3.** Use the shell tool's long-running command support. Keep the turn open and use its command session handle to receive the output and exit code.
- **Other harnesses.** Use the harness's background command support and collect the completion result in the active session.

## Relay configuration

Use gh-watcher 0.7.0 or later. Set `GH_WATCHER_EVENTS_URL` or pass `--events-url <url>`. Use `--repo OWNER/NAME` or set `GH_REPO`.

The CLI reads state only from the relay. The relay shares GitHub webhook data across waiters. For owners without webhooks, the relay can poll GitHub and returns a `warning` in the result. The CLI needs no authenticated `gh` session.

The wait commands accept `--timeout` (default 30 minutes, maximum 24 hours). Omit the removed polling flags `--source`, `--interval` and `--fallback-interval` from waits. A missing relay configuration fails immediately. If the relay is unreachable, the CLI retries only the relay and returns exit `2` if it remains unreachable at the timeout.

## Wait for checks before merging

```sh
gh-watcher wait --repo octo-org/hello-world --pr 17 --timeout 45m --json
```

The PR target follows the current head and keeps the latest run of each workflow. The aggregate includes Actions runs, checks from other apps and commit statuses. A target with no checks stays in state `none` until checks appear or the wait times out.

## Follow each Actions run to completion

For CI or releases you own, wait for each exact Actions run, including post-merge publication, release, promotion and deployment.

```sh
gh-watcher status --repo octo-org/hello-world --commit "$SHA" --json
gh-watcher wait --repo octo-org/hello-world --run 123456789 --timeout 45m --json
```

Use the full 40-character SHA of the commit that triggers the workflow. Read `runs[].databaseId`, `workflowName` and `url` from the status report. Start a wait for each relevant run ID. The `status` command returns exit `0` for any report, so read its `state`.

If no run exists yet, start a wait on the full SHA.

```sh
gh-watcher wait --repo octo-org/hello-world --commit "$SHA" --timeout 45m --json
```

After that wait resolves, use `status --commit` to identify the runs and wait for each exact ID. The commit wait can finish when other checks finish. Keep any expected workflow pending until you confirm its run result. Report each outcome with the run link. For deployments, separately verify the live version and service health at the deployed endpoint.

## Wait for pull request lifecycle events

```sh
gh-watcher pr wait --repo octo-org/hello-world --pr 17 --on merged,closed --timeout 2h --json
gh-watcher pr wait --repo octo-org/hello-world --pr 17 --on review,comment --since "$ACTED_AT" --json
gh-watcher pr wait --repo octo-org/hello-world --branch feature/example --on opened --json
```

- Use one of `--pr` and `--branch`. To read a single snapshot, use `gh-watcher pr status` with the same target and `--json`.
- Separate event kinds with commas. The kinds are `opened`, `reopened`, `closed`, `merged`, `draft`, `ready`, `comment`, `review`, `review_comment`, `push` and `review_decision`. The default is `any`.
- A named state can match the initial snapshot. Use `--changes-only` to require a new change. The default `any` does not match an initial state.
- Set `--since` to the ISO 8601 time before you act to include comments and reviews that arrive before the wait starts.
- Read `events` and `pr` from the JSON. Check the event kind and review state before acting.

## Act on the wait result

| Exit  | Meaning                                                         | Action                                                                               |
| ----- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `0`   | Checks succeeded or a requested PR event matched                | Read the JSON and continue.                                                          |
| `1`   | A check failed (`wait`)                                         | Read `failedSteps` and `failedChecks`. Report the failure and fix it if you own it.  |
| `2`   | Command or relay error                                          | Read the JSON error or stderr. Correct invalid arguments or report the relay defect. |
| `124` | The target did not reach the requested state before the timeout | Report the timeout or start a new bounded wait if the task still requires it.        |

## Persistent watches

For monitoring beyond one session, `gh-watcher watch add` registers a persistent watch. Its `--interval` option sets how often the daemon reads the relay. A `notify:*` hook launches a separate agent session and requires a request for that follow-up. Stop the watch daemon and remove the watch when its work ends.

See the command and hook reference in [the gh-watcher README](https://github.com/ThomasMcFarlane/ai-tools/blob/main/tools/gh-watcher/README.md).
