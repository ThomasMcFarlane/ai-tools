# gh-watcher

**Use `gh-watcher` for every GitHub Actions and pull request lifecycle wait.**
Start each wait as a background command with `--json`. Keep the session active and continue independent work during the wait. Receive the command's JSON and exit code, then act on the result.

T3 `watch_pull_request` and other harness notifications can supplement the command. Never use a notification in place of the wait or as the sole trigger to resume work. Do not use `gh run watch`, `gh pr checks --watch`, sleep loops, manual status polling or a direct GitHub polling fallback.

In T3, use the shell tool's long-running command support. Use its session handle to collect the result without ending the turn.

Use gh-watcher 0.7.0 or later. Configure the relay with `GH_WATCHER_EVENTS_URL` or `--events-url <url>`. The CLI reads state only from that relay.

## Commands

Wait for PR checks before merging.

```sh
gh-watcher wait --repo octo-org/hello-world --pr 17 --timeout 45m --json
```

For each Actions run you own, including post-merge publication, release, promotion and deployment, find its ID in `runs[].databaseId`. Use the full 40-character SHA of the triggering commit.

```sh
gh-watcher status --repo octo-org/hello-world --commit "$SHA" --json
gh-watcher wait --repo octo-org/hello-world --run 123456789 --timeout 45m --json
```

If no run exists yet, start a commit wait. After it resolves, identify and wait for each exact run. Report each result with its run link. Verify the live deployment separately when applicable.

```sh
gh-watcher wait --repo octo-org/hello-world --commit "$SHA" --timeout 45m --json
```

For lifecycle events, use `pr wait`. Use `--since` with an ISO 8601 time to include reviews and comments since you acted.

```sh
gh-watcher pr wait --repo octo-org/hello-world --pr 17 --on merged,closed --timeout 2h --json
gh-watcher pr wait --repo octo-org/hello-world --pr 17 --on review,comment --since "$ACTED_AT" --json
gh-watcher pr wait --repo octo-org/hello-world --branch feature/example --on opened --json
```

## Results

- `0`: checks succeeded or the PR event matched. Read the JSON and continue.
- `1`: a check failed. Read `failedSteps` and `failedChecks`, then fix the failure if you own it.
- `2`: command or relay error. Correct invalid arguments or report the relay defect.
- `124`: timeout. Report it or start a new bounded wait if the task still requires it.

`status` exits `0` for any report. Read its `state`. A persistent watch can send notifications, but the active session must receive its background wait result.

See the [canonical gh-watcher skill](https://github.com/ThomasMcFarlane/ai-tools/blob/main/skills/claude-code/gh-watcher/SKILL.md) for event kinds and persistent watches.
