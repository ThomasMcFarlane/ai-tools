# gh-runs

A Claude Code mod that shows the GitHub Actions runs you are tracking in a live band above the prompt, removes each run when it ends, and leaves a coloured item with the run link in the chat history.

It does not talk to GitHub. Each tracked target is followed by one `gh-watcher follow` child process ([tools/gh-watcher](../../tools/gh-watcher/README.md)), and the mod only displays the JSON lines that command prints. gh-watcher gets its updates from webhooks when an event relay is configured, and from `gh` otherwise.

## Install

```
/plugin marketplace add ThomasMcFarlane/ai-tools
/plugin install gh-runs@ai-tools
```

`gh-watcher` (version 0.2.0 or later, which has `follow`) must be on `PATH`, or set the `watcherPath` option.

## Tracking

- A Bash call that runs `gh-watcher wait --repo octo-org/hello-world --pr 17` (or `--branch`, `--commit`, `--run`) starts tracking that target, in the main conversation and in subagents. Quotes, env prefixes, `cd x &&` and pipes are understood. Without `--repo`, a `GH_REPO=` prefix or `export` supplies it; otherwise the call is skipped. Reading the command never delays, changes or fails the call.
- `/ci-track <target>` tracks one by hand. A target is a PR URL, a run URL (with or without `/job/...`), `octo-org/hello-world#17` or `octo-org/hello-world 17`. Without an argument it lists what is tracked; with a bad one it prints the usage line.
- The same repository and target is followed once, however it was added.
- A target is dropped when its follower exits (all runs ended, timed out after 6 hours, or failed). A missing binary, unreadable output or exit code 2 drops it with a short status note.
- Tracked targets and the spinner frame live in `$.state`, so a reload keeps them: followers are started again on `session.start`. They are stopped on `session.end`, and a `/clear` forgets the targets.

## The band

Drawn only while a tracked run has no conclusion yet; with nothing to show, or while a survey is open, the engine's own band stands. One row per active run, cut to the band's width by dropping the least important parts first:

```
⠹ CI  octo-org/hello-world#17  build +2 jobs  step 7/12 Run tests  ████░░░░  1m 23s  updated 40s ago webhook
```

- spinner, dim while queued and in the suggestion colour while in progress
- workflow, repository and target, the leading job (with `+2 jobs` when more are active), the current step and its name
- a progress bar of finished steps over all steps known so far
- elapsed time and when gh-watcher last reported, with `webhook` or `polled` for its source

One 250 ms `$.clock.every` tick moves the spinner and the two times. It runs only while something is tracked and is cancelled when nothing is. No request is made for it.

### How fresh the steps are

The mod shows what gh-watcher last printed and never asks GitHub itself. A new line arrives when gh-watcher checks: on a `workflow_run` webhook for the commit (a run is queued, starts or completes), and on its safety-net re-check (`--fallback-interval`, five minutes by default). GitHub sends no webhook per job or step, so between events the step, progress bar and job stay as they were and only the elapsed time and the `updated ... ago` note move. Without an event relay gh-watcher polls every `--interval` (30 seconds), and steps then move at that pace.

## When a run ends

Each run leaves the band the moment it has a conclusion, even while other runs of the target continue. It then gets one chat item, deduplicated on run id and attempt, also across reloads. It is a `system` row (a notice the model never reads) with one text block:

```
[gh-runs] failure  CI  octo-org/hello-world#17  2m 05s
failed: build / Test
https://example.com/octo-org/hello-world/actions/runs/7
```

A `ui.render` hook on `InfoNotice` draws rows that start with `[gh-runs]` as a bordered box with the conclusion in bold: green for success, red for failure (and startup failure, action required), yellow for cancelled and timed out, dim for skipped and neutral. Other notices are left alone. `InfoNotice` is raised on the terminal surface only; elsewhere the row shows as plain text with the link.

## Options

- `watcherPath`: path to the `gh-watcher` binary. Empty: found on `PATH`.

## Development

```
claude plugin validate mods/gh-runs
claude plugin test mods/gh-runs
```

`hooks/runs.ts` holds the pure helpers (command and argument parsing, line handling, row layout, notice text); `hooks/register.tsx` the hooks. Tests use `claude-code/testing` with a scripted child process and run offline.
