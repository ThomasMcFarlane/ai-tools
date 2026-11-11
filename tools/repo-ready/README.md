# @ai-tools/repo-ready

A quiz engine that helps a person find out whether they understand a repository well enough to be interviewed on it, to work on it, or to own it.

An AI agent reads the repository, works out its design areas and the principles behind them, then teaches and quizzes the person live in chat. `repo-ready` is the part that keeps the facts: it stamps the times, stores every question, answer and score, works out each area's level and the overall verdict, says what to ask next, and draws charts. It makes no network calls and never writes into the repository it studies.

## The split between agent and CLI

- **The agent does judgement.** It reads the repository, writes the map, writes each question, teaches, gives hints, and grades each answer from 0 to 4.
- **The CLI does facts.** It reads the branch and commit, stamps the clock, stores every event, finds what changed, computes levels and the verdict, chooses what to test next, and draws charts.

The agent never edits state files. It only calls the CLI, so the same rules give the same verdict on Claude Code, Codex and OpenCode. The skills that drive it are in `skills/` (see [skills/README.md](../../skills/README.md)).

## Requirements

- Node >= 20 and npm when building from source; the prebuilt binaries are self-contained and need no Node.
- `git` on the `PATH` for branch, commit and change detection. A folder that is not a git repository still works, but branch and commit are recorded as empty and there is no change detection.

## Install and build

Download a prebuilt binary from the `repo-ready-v<version>` release on the Releases page of this repository (for example `https://github.com/ThomasMcFarlane/ai-tools/releases/download/repo-ready-v<version>/repo-ready-linux-x64`). Artifacts follow the pattern `repo-ready-<os>-<arch>`: `repo-ready-linux-x64`, `repo-ready-linux-arm64`, `repo-ready-macos-x64`, `repo-ready-macos-arm64` and `repo-ready-win-x64.exe`. Make the file executable (`chmod +x`), put it on your `PATH`, and verify with `repo-ready --version`. On macOS the binaries are unsigned: remove the quarantine attribute with `xattr -d com.apple.quarantine repo-ready` or approve the binary in System Settings on first run.

To build from source, run these from the repository root:

| Step                                   | Command                                     |
| -------------------------------------- | ------------------------------------------- |
| Install workspace dependencies         | `npm install`                               |
| Build only this tool                   | `npm run build -w @ai-tools/repo-ready`     |
| Package self-contained native binaries | `npm run build:bin -w @ai-tools/repo-ready` |
| Typecheck                              | `npm run typecheck -w @ai-tools/repo-ready` |
| Test                                   | `npm run test -w @ai-tools/repo-ready`      |

The bin is `repo-ready`, mapped to `tools/repo-ready/dist/cli.js`:

```sh
node tools/repo-ready/dist/cli.js --help
```

## A session in short

Run the commands from inside the repository you are studying, or point at it with `--repo <path>`.

```sh
repo-ready status                       # exit 1 when there is no map yet
repo-ready map set --file map.json      # the agent submits the map it wrote
repo-ready session start --mode learn
repo-ready teach --area state-storage --principles append-only
echo 'Why are events only appended?' | repo-ready ask --area state-storage --level read --type explain --file - --evidence src/store.ts:1 --principles append-only
echo 'Because history stays auditable.' | repo-ready answer <id> --file -
echo 'Correct, missed ordering.' | repo-ready grade <id> --score 3 --gaps ordering --file -
repo-ready next
repo-ready session end
```

`ask` prints the question id; use it in `answer`, `grade`, `hint` and `skip`. Long text (question, answer, notes) is passed by `--file <path>` or on standard input with `--file -`, so shell quoting cannot damage it.

## Command reference

Global options, valid before any command:

| Flag            | Default           | Meaning                                 |
| --------------- | ----------------- | --------------------------------------- |
| `--repo <path>` | current directory | Path of the repository to study.        |
| `-V, --version` |                   | Print the version.                      |
| `-h, --help`    |                   | Show help for the program or a command. |

Every command that prints a result takes `--json`, except `export`, which always prints JSON.

| Command         | Purpose                                                               | Flags                                                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`        | Show the repository, the map, area levels and the verdict.            | `--json`                                                                                                                                                                                                                                                              |
| `map set`       | Validate and store a map; prints structural changes.                  | `--file <path>` JSON map file, or `-` for standard input (required); `--force` override the rules that protect untouched areas; `--reason <text>` why `--force` is needed (required with `--force`); `--json`                                                         |
| `map show`      | Print the stored map.                                                 | `--json`                                                                                                                                                                                                                                                              |
| `map changes`   | List files changed since the map was set, grouped by area.            | `--json`                                                                                                                                                                                                                                                              |
| `session start` | Start a session, ending any open one.                                 | `--mode <mode>` `learn` or `interview` (required); `--json`                                                                                                                                                                                                           |
| `session end`   | End the open session and print its summary, levels and verdict.       | `--json`                                                                                                                                                                                                                                                              |
| `session list`  | List sessions, newest first.                                          | `--json`                                                                                                                                                                                                                                                              |
| `teach`         | Record that a lesson was given in the open session.                   | `--area <id>` (required); `--principles <ids>` comma-separated principle ids; `--json`                                                                                                                                                                                |
| `ask`           | Record a question in the open session and print its id.               | `--area <id>`, `--level <level>` (`read`, `maintain` or `rebuild`), `--type <type>` (all required); `--file <path>` prompt text, or `-`; `--evidence <path:line>` (repeatable, at least one); `--principles <ids>`; `--follow-up-of <id>` answered question; `--json` |
| `hint <id>`     | Record a hint for an open question (learn mode only).                 | `--json`                                                                                                                                                                                                                                                              |
| `answer <id>`   | Record the answer to an open question and its duration.               | `--file <path>` answer text, or `-`; `--json`                                                                                                                                                                                                                         |
| `grade <id>`    | Record the score for an answered question.                            | `--score <0-4>` whole number (required); `--file <path>` grading notes, or `-`; `--gaps <tags>` comma-separated gap tags; `--json`                                                                                                                                    |
| `skip <id>`     | Record that an open question was skipped.                             | `--json`                                                                                                                                                                                                                                                              |
| `next`          | Suggest the next areas, levels and question types to ask about.       | `--area <id>` limit to an area (repeatable); `--count <n>` how many targets (default 3); `--json`                                                                                                                                                                     |
| `levels`        | Show each area level, stale and untested marks, and the verdict.      | `--json`                                                                                                                                                                                                                                                              |
| `history`       | List recorded questions, newest first.                                | `--area <id>`; `--session <id>`; `--limit <n>`; `--json`                                                                                                                                                                                                              |
| `export`        | Print the repository, map and event log as JSON.                      | `--json` (accepted for consistency)                                                                                                                                                                                                                                   |
| `chart <kind>`  | Show one chart: `levels`, `accuracy`, `speed`, `types` or `timeline`. | `--format <format>` `text`, `json` or `html` (default `text`); `--json` same as `--format json`                                                                                                                                                                       |
| `report`        | Show all charts as text, or as one self-contained HTML page.          | `--format <format>` `text` or `html` (default `text`); `--out <path>` write to a file outside the repository; `--json` print (or write) all charts as JSON                                                                                                            |
| `reset`         | Delete this repository's map and history.                             | `--yes` confirm the deletion (required); `--json`                                                                                                                                                                                                                     |

Question types by level:

| Level      | Question types               |
| ---------- | ---------------------------- |
| `read`     | `explain`, `trace`           |
| `maintain` | `predict`, `debug`, `change` |
| `rebuild`  | `rebuild`                    |

Rules the commands enforce:

- `ask` needs an open session, one known area and principle ids, a prompt that is not empty, and a type that belongs to the level. Every `--evidence` value must be `path:line` or `path:line-line`, follow the map's path rules (below), and point at a file that exists in the repository.
- `answer` is accepted once per question; `grade` only after `answer`, once. `grade --gaps` drops repeated tags.
- `answer`, `grade`, `hint` and `skip` refuse a question whose session has ended, including one ended by a later `session start`.
- A follow-up (`ask --follow-up-of <id>`) must target an answered question of the same session and area that is not itself a follow-up, and each question can have one follow-up.
- `hint` is refused in interview mode, and only an open question can take a hint.
- `next` leaves out an area once 3 questions in it have been asked in the session, and reports the session as done after 8 questions.
- `report --out` refuses a path inside the studied repository.
- Every command refuses to run when the state folder is inside the studied repository.

### Exit codes

| Code | Meaning                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success                                                                                                                                           |
| `1`  | Not found: no map yet, no open session to end, no sessions, or no questions match a history filter                                                |
| `2`  | Error: bad flags, an invalid map or refused update, an unknown id, or a rule above was broken (for example `ask` or `teach` with no open session) |

There is no timeout exit code; the CLI never waits.

## The map

The agent submits the map as JSON with `map set --file <path>`. A map has 1 to 10 areas and at least one area must be `key`. An area is a part of the design a maintainer must understand as a unit, not a folder.

```json
{
  "areas": [
    {
      "id": "state-storage",
      "title": "State storage",
      "summary": "How state is kept on disk.",
      "key": true,
      "paths": ["src/**"],
      "revision": 1,
      "principles": [
        {
          "id": "append-only",
          "statement": "Events are only appended.",
          "reason": "History stays auditable.",
          "evidence": ["src/store.ts:1"]
        }
      ]
    }
  ]
}
```

| Field                    | Rule                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `id`                     | A slug: lower-case letters, digits and hyphens. It is the area's identity.                          |
| `title`, `summary`       | Not empty.                                                                                          |
| `key`                    | `true` or `false`. Key areas count towards the verdict.                                             |
| `paths`                  | At least one glob for the files of the area, relative to the repository root; a folder needs `/**`. |
| `revision`               | A whole number of 1 or more. The agent raises it only when the area's design changes.               |
| `principles[].id`        | A slug.                                                                                             |
| `principles[].statement` | The design decision or rule.                                                                        |
| `principles[].reason`    | Why it is so.                                                                                       |
| `principles[].evidence`  | `path:line` or `path:line-line` references; the files must exist.                                   |

Area paths and evidence paths must not be absolute, start with `./`, contain a `..` segment or contain a backslash; such a map is always rejected.

`map set` stamps the map with the current branch and commit and prints every structural change: areas added, removed, `key` set or cleared, and revisions raised. In a git repository with tracked files, every area's paths, in the first map and in every later one, must match at least one tracked file. Adding an area, and changing titles, summaries, paths or principles, is otherwise accepted. Removing an area, or clearing its `key` flag, is refused unless files in that area changed since the map's commit or its paths no longer match any tracked file. When the map's commit cannot be compared, only the second reason counts, and outside a git repository every removal and key clear is refused. A revision may never go down. An area that comes back after it was removed is judged against the highest revision on record for its id: above it, the return counts as a revision rise (`revision_raised` from the recorded revision); below it, the map is refused; at it, the area is simply added. `--force --reason <text>` overrides the refusals about paths, removals, key clears and unchanged files (never a lowered revision) and records the reason in the log.

`map changes` lists the files changed between the map's commit and now, grouped by area, plus changed files that belong to no area. A renamed file is listed under both its old and its new path, so a file moved out of an area still counts against it. If the map's commit cannot be found (for example after a history rewrite) it says it cannot compare, and every area should be reviewed.

## Levels, stale marks and the verdict

Every question is for one area at one of three levels. The labels are printed wherever a level or the verdict is printed.

| Level      | Meaning                                              | Label                         |
| ---------- | ---------------------------------------------------- | ----------------------------- |
| `read`     | Can explain what the area does and why               | Ready to be interviewed on it |
| `maintain` | Can change and repair it without breaking the design | Ready to work on it           |
| `rebuild`  | Can design the area again from nothing               | Ready to own it               |
| none       | Holds no level                                       | Not yet ready                 |

The numbers below are named constants in `src/core/types.ts`.

| Constant                 | Value | Used for                                                   |
| ------------------------ | ----- | ---------------------------------------------------------- |
| `PASS_SCORE`             | 3     | Lowest score that can pass                                 |
| `LEVEL_PASSES`           | 2     | Passes needed to hold a level                              |
| `LEVEL_WINDOW`           | 3     | Number of latest valid questions looked at                 |
| `STALE_CLEAR_AFTER`      | 3     | Graded questions that clear a stale mark                   |
| `SESSION_QUESTIONS`      | 8     | Questions in a session before `next` reports it done       |
| `SESSION_AREA_CAP`       | 3     | Most questions on one area in a session                    |
| `MIN_AREAS`, `MAX_AREAS` | 1, 10 | Allowed number of areas in a map                           |
| `RECENT_PROMPTS`         | 5     | Earlier prompts `next` shows so questions are not repeated |

**Passing.** The agent gives each answer a whole score: 0 wrong or blank, 1 mostly wrong, 2 partly correct, 3 correct with small gaps, 4 correct and complete. An answer passes when its score is 3 or 4 and no hint was used. A skipped question counts as score 0. Passes count in both modes.

**Holding a level.** An area holds a level when the person passed at least 2 of their last 3 valid graded questions at that level, and the area holds every lower level. A skipped question counts as valid and not passed. An area is **untested** when it has fewer than 2 valid counted (graded or skipped) questions at `read`; only `read` carries the mark. Untested is not the same as failed, and the output keeps the two apart.

**Stale areas.** When the agent raises an area's `revision`, the design of that area has changed. The CLI voids the questions at the top level the area held, and at every level above it, including questions still open or answered but not yet graded; a voided question never counts, even if it is graded later (`grade` then reports `voided: true` and says the grade does not count). Lower levels stay valid. If the area held no level, all its counted questions are voided and it gets no stale mark; it is simply untested again (an area that was already stale keeps its mark, and the count towards clearing it starts again from 0).

- The area now holds one level lower, and that lower level is the one that counts in the verdict.
- The area is marked `stale (was <level>: <label>)` and comes first in `next`, aimed at the earlier level.
- The person earns the earlier level back by the normal rule: 2 passes in the last 3 valid questions at that level.
- The stale mark clears when the area holds the earlier level again, or after 3 questions at the earlier level have been graded or skipped on the new revision (a skipped question counts towards the 3, and questions at other levels do not). In the second case the area keeps the lower level, without a mark.
- If the revision rises again before the mark clears, the same rule applies again from the level the area holds then, so the area drops one more level.

A typing fix costs the person nothing; a design change costs one level in that area until they show they understand the change.

**The verdict** is the lowest level held across the key areas.

| Verdict                       | When                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Ready to be interviewed on it | The lowest level across key areas is `read`.                                                                                |
| Ready to work on it           | The lowest level across key areas is `maintain`.                                                                            |
| Ready to own it               | The lowest level across key areas is `rebuild`.                                                                             |
| Not yet ready                 | Every key area has been tested at `read` and at least one holds no level.                                                   |
| Not enough evidence yet       | A key area holds no level because it has fewer than 2 graded questions at `read`. The count of untested key areas is shown. |

The verdict also lists the gaps: the areas holding it down, the weakest question types and the gap tags that recur (on at least two questions; a tag counts once per question). `session end` prints the cumulative levels and verdict, and a summary for that session alone (questions asked, pass rate, time per question, results by area and level), because a first verdict can take more than one session.

`next` orders its targets as: stale areas first, then key areas at the lowest level (aimed at the level above the one held), then other areas at the lowest level; within an area it picks the question type with the lowest pass rate, then the slowest. `--area` filters the list.

## Time taken

The time taken for a question runs from the moment the question is recorded with `ask` to the moment the reply is recorded with `answer`. It therefore includes the person's reading and typing time, and any time the agent takes between showing the question and recording the reply. It is a measure of the whole exchange, not of thinking alone.

## What is stored and where

State lives in the XDG state directory. The default is `~/.local/state/ai-tools/repo-ready` (`XDG_STATE_HOME` is honoured; `%LOCALAPPDATA%` is used on Windows). `AI_TOOLS_REPO_READY_STATE_DIR` overrides the whole directory.

```
~/.local/state/ai-tools/repo-ready/
└── repos/
    └── <name>/
        ├── repo.json        # repository key, root and first-seen time
        ├── map.json         # the current map
        ├── maps/            # earlier maps, one file per replaced map
        └── events.jsonl     # append-only event log
```

`<name>` is the repository key made safe for a file name (at most 80 characters) plus a short hash. The state folder must lie outside the studied repository; a relative `AI_TOOLS_REPO_READY_STATE_DIR` or `XDG_STATE_HOME` is resolved against the current folder first, and if the result is inside the repository every command refuses to run (exit `2`).

### Repository identity

State is keyed by repository, not by folder, and there is one history across all branches. The tool works out up to three candidate keys in this order: the normalised `origin` remote URL, the first commit (`root:<commit>`), and the absolute path of the repository root (`path:<root>`), each only when it is available. It uses the first candidate whose state folder already exists, and the first candidate when none does, so a repository seen for the first time is keyed by `origin` and two clones with the same `origin` share one history. History made before the first commit, or before `origin` was added, is still found under its older key; `status` prints the key in use. Two cases start fresh: a repository with no `origin` whose first commit is rewritten, and a history kept under an older key (for example from before the first commit) once another checkout of the same repository has started a history under a higher-priority key.

Every event records the time, session, mode, branch, commit, whether the working tree had uncommitted changes, and the map's commit. The log holds session starts and ends, map changes, lessons, questions, hints, answers, grades and skips. Levels, statistics and charts are all computed from the log; nothing derived is stored.

**The full text of every question and answer is kept so you can review past sessions. It stays on your machine and is never sent anywhere.** To see what is stored, run `repo-ready export`, which prints the repository, the map and the event log as JSON. To delete a repository's map and history, run `repo-ready reset --yes`. Without `--yes` it refuses. The tool never writes into the repository it studies: git is only read, with optional locks turned off so `.git/index` is never refreshed, `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` from the environment are ignored, and `report --out` refuses a path inside the repository.

## Charts

`chart <kind>` shows one chart and `report` shows all of them. `text` uses Unicode bars and sparklines that read well in a terminal chat; `html` is one self-contained page with inline SVG and no network scripts; `json` gives the numbers behind a chart.

| Kind       | Shows                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `levels`   | Each area with its level, stale and untested marks, and last test time; retired areas follow, marked `retired`, outside the verdict |
| `accuracy` | Pass rate over sessions, overall and per area                                                                                       |
| `speed`    | Time per question over sessions                                                                                                     |
| `types`    | Pass rate per question type                                                                                                         |
| `timeline` | Sessions against the branch and commit they ran on                                                                                  |

```sh
repo-ready chart levels
repo-ready chart speed --format json
repo-ready report --format html --out ~/repo-ready-report.html
```

## Privacy

- No network calls, no telemetry, no accounts.
- Everything is stored in the local state directory, including the full question and answer text.
- Nothing is written into the studied repository.
