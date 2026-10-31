# gh-runs

A Claude Code mod that shows the GitHub Actions runs you are tracking in a live band above the prompt, removes each run when it ends, and leaves a coloured result row with the run link in the chat history.

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
- `/ci-track expand` and `/ci-track collapse` show or hide the steps of every active run at once, with no keyboard needed. A run that starts afterwards is collapsed.
- The same repository and target is followed once, however it was added.
- A target is dropped when its follower exits (all runs ended, timed out after 6 hours, or failed). A missing binary, unreadable output or exit code 2 drops it with a short status note.
- Tracked targets and the spinner frame live in `$.state`, so a reload keeps them: followers are started again on `session.start`. They are stopped on `session.end`, and a `/clear` forgets the targets.

## The band

Drawn only while a tracked run has no conclusion yet; with nothing to show, or while a survey is open, the engine's own band stands. One row per active run, cut to the band's width by dropping the least important parts first:

```
⠹ octo-org/hello-world › #17 › CI › build +2 jobs │ step 7/12 Run tests │ ████░░░░ │ 1m 23s │ updated 40s ago webhook
```

- spinner, dim while queued and in the suggestion colour while in progress
- repository, PR (or branch or commit), workflow and the leading job job (with `+2 jobs` when more are active), then the current step and its name
- a progress bar of finished steps over all steps known so far
- elapsed time and when gh-watcher last reported, with `webhook` or `polled` for its source

Run and job names in the band are clickable links to GitHub. The row reads as a breadcrumb trail (`owner/repo › #17 › workflow › job`, each crumb a link where GitHub has a page for it), with a dim `│` between the fields; a separator is dropped together with its field on a narrow band.

### Expanding a run

Each row starts with a button, `▸` when collapsed and `▾` when expanded. Click it, or reach it with ctrl+x tab, to toggle that run. Runs start collapsed. Expansion is kept in `$.state` by run id, so it survives redraws, the tick and a reload, and is forgotten when the run leaves the band.

Expanded, the row is followed by every job and then its steps, one line each, from the data gh-watcher already prints (no extra GitHub calls):

```
▾ ⠹ CI  octo-org/hello-world#17  ...
    ⠹ build  7/12
      ✓ 1 Set up job
      ✗ 2 Run tests
      ⠹ 3 Deploy
      ○ 4 Post checkout
```

- marks: green `✓` done, red `✗` failed, spinner in the suggestion colour running, dim `○` queued or pending, dim `-` skipped, yellow `⊘` cancelled (timed out is a yellow `✗`)
- the job line ends with its own finished steps over its step count
- at most 12 step lines per run, kept around the running or failed step, with a dim `+5 more` line for the rest
- names are cut to the band width
- on a short terminal (fewer than 24 rows) the expanded lines are not drawn and the collapsed row shows instead

One 250 ms `$.clock.every` tick moves the spinner and the two times. It runs only while something is tracked and is cancelled when nothing is. No request is made for it.

### How fresh the steps are

The mod shows what gh-watcher last printed and never asks GitHub itself. A new line arrives when gh-watcher checks: on a `workflow_run` webhook for the commit (a run is queued, starts or completes), and on its safety-net re-check (`--fallback-interval`, five minutes by default). GitHub sends no webhook per job or step, so between events the step, progress bar and job stay as they were and only the elapsed time and the `updated ... ago` note move. Without an event relay gh-watcher polls every `--interval` (30 seconds), and steps then move at that pace.

## When a run ends

Each run leaves the band the moment it has a conclusion, even while other runs of the target continue. It then gets one result row, deduplicated on run id and attempt, also across reloads.

The row is placed at the end of the transcript with `$.ui.place`, under the id `<run id>-<attempt>`, so nothing is typed or echoed as a message from you. The finished-run summary (conclusion, workflow, repo and target, duration, failed steps, URL) is kept in `$.state` under that id. If no surface can draw the row, the reason is noted in the status line.

A `ui.render` hook on `Placed` draws the row as a round bordered box sized to the viewport. The border and the bold conclusion are green for success, red for failure (and startup failure, action required), yellow for cancelled and timed out, dim for skipped and neutral. The first line has workflow, `repo#target` and duration, then a dim `failed: job / step` line if any, then the URL as plain text so the terminal makes it clickable. A placed row of another plugin, or an id the state does not know, is left to the engine.

Placed rows are display only: they are not restored on `--resume`, so finished rows from an earlier session do not come back. The model never reads them either, so the mod also appends this plain text to the conversation as a hidden row. It is the model's copy of the result, and a failed append is only noted:

```
[gh-runs] failure  CI  octo-org/hello-world#17  2m 05s
failed: build / Test
https://example.com/octo-org/hello-world/actions/runs/7
(Reported automatically by the gh-runs mod; the user did not type this.)
```

## CI wait guard

A `tool.call` hook refuses a Bash or Monitor call that waits on CI by polling GitHub itself, and the reason names the replacement: `gh-watcher wait --repo <owner/repo> (--pr <n>|--run <id>|--commit <sha>) --timeout 45m --json`, run in the background (Bash `run_in_background`), with the repo and id filled in when the command shows them. Refused:

- `curl`, `wget`, `http` or `xh` calls to the Actions or checks API (`/actions/runs`, `/actions/jobs`, `/commits/<sha>/check-runs|status|statuses`) or a `github.com/<o>/<r>/actions/runs/` page.
- `while`, `until` or `for` loops, or `watch`, that run `gh pr checks`, `gh pr view`, `gh run view`, `gh run list` or `gh api` on Actions together with `sleep`.
- `gh run watch` and `gh pr checks --watch`.

Allowed: every `gh-watcher` command, a single `gh pr checks` or `gh run view` (also `--log-failed`), other `gh` use, and text that only mentions these words in a quoted string, comment or heredoc that is not run. The matching is `ciPollReason` in `hooks/runs.ts`; it prefers missing an exotic form to blocking normal work. Commands that `gh-watcher wait` tracking sees are unchanged.

## Options

- `watcherPath`: path to the `gh-watcher` binary. Empty: found on `PATH`.

## Development

```
claude plugin validate mods/gh-runs
claude plugin test mods/gh-runs
```

`hooks/runs.ts` holds the pure helpers (command and argument parsing, line handling, row layout, result text); `hooks/register.tsx` the hooks. Tests use `claude-code/testing` with a scripted child process and run offline.
