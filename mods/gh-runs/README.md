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
- `/ci-track expand` opens every group, run and job at once; `/ci-track collapse` closes them all, groups included. No keyboard is needed. A group that appears afterwards is open, and its runs and jobs are collapsed.
- The same repository and target is followed once, however it was added.
- A target is dropped when its follower exits (all runs ended, timed out after 6 hours, or failed). A missing binary, unreadable output or exit code 2 drops it with a short status note.
- Tracked targets and the spinner frame live in `$.state`, so a reload keeps them: followers are started again on `session.start`. They are stopped on `session.end`, and a `/clear` forgets the targets.

## The band

Drawn only while a tracked run has no conclusion yet; with nothing to show, or while a survey is open, the engine's own band stands. The tracked runs are grouped per PR or branch and drawn as a tree, Group > runs > jobs > steps:

```
▾ ⠴ octo-org/hello-world › #17 │ 3 runs │ ✓ 1 done 1 running 1 queued │ 4m 10s
  ▸ CI │ step 2/3 │ ███░░░░░ │ 42s │ updated 40s ago webhook
  ▾ Release │ step 5/9 │ █████░░░ │ 1m 50s │ updated 40s ago webhook
      ✓ build │ 9/9
      ▾ ⠴ publish │ step 3/7 │ Upload assets
          ✓ 1 Set up job
          ⠴ 3 Upload assets
          ○ 4 Post checkout
▸ octo-org/hello-world › main │ 1 run │ 1 running │ 6m 00s
```

Every level expands on its own, from the data gh-watcher already prints (no extra GitHub calls).

### Groups

- A PR target groups by repository and PR number. A branch target groups by repository and branch, which gh-watcher's run data does not carry for a PR or run, so the target's own branch is used. A commit target groups by its short sha.
- A run target (`--run`, a run URL) joins the group of a PR, branch or commit target that follows the same run, and is a group of its own, `repo › run <id>`, otherwise. The same run is never listed twice.
- The group row is a chevron, a spinner while any run is active, the breadcrumb `repo › #17` or `repo › branch` (the repository, the PR and the branch link to GitHub; a branch links to its `tree` page), then `│` fields: the run count, a coloured summary (`✓ n done` green, `✗ n failed` red, `n running`, `n queued` dim) and the time since the earliest start.
- A group goes when it has no active run left. Finished runs leave the band one by one and get their coloured result row as before.
- On a narrow band whole fields drop, the lowest priority first (run count, then the repository, then the summary, then the time), each together with its `│`. The PR or branch stays.

### Runs, jobs and steps

- Run rows are indented 2: the workflow name linked to the run, `step n/m`, a progress bar of finished steps, the elapsed time and when gh-watcher last reported (`webhook` or `polled`). A queued run shows its status.
- Job rows are indented 6: a mark, the job name linked to the job, then `│ step n/m` and the current step name; a finished job shows `n/m` steps done.
- Step rows are indented 10, one per step with its number and name.
- Marks: green `✓` done, red `✗` failed, spinner in the suggestion colour running, dim `○` queued or pending, dim `-` skipped, yellow `⊘` cancelled (timed out is a yellow `✗`).

### Expanding

Each group, run and job that has something below it starts with a button, `▸` collapsed and `▾` expanded. Click it, or reach it with ctrl+x tab, to toggle that level. Groups start expanded; runs and jobs start collapsed. Expansion is one set of keys in `$.state` (`g:<group id>`, `r:<run id>`, `j:<run id>:<job name>`), so it survives redraws, the tick and a reload, and is forgotten when its group, run or job leaves the band. `/ci-track expand` and `/ci-track collapse` set every level at once.

The height is capped for the whole tree so the band cannot flood the screen:

- at most 12 step lines, kept around the running or failed step
- at most 30 lines in all
- the rest is counted in a last dim `+5 more` line
- names are cut to the band width
- on a short terminal (fewer than 24 rows) only groups and runs are drawn, never jobs or steps

One 250 ms `$.clock.every` tick moves the spinner and the times. It runs only while something is tracked and is cancelled when nothing is. No request is made for it.

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

`hooks/runs.ts` holds the pure helpers (command and argument parsing, line handling, `groupRuns`, `treeLines`, result text); `hooks/register.tsx` the hooks. Tests use `claude-code/testing` with a scripted child process and run offline.
