# repo-ready design

Date: 2026-11-11
Status: approved by the owner, 2026-11-11

## Intent

`repo-ready` helps a person learn whether they understand a repository well enough to be interviewed on it, to maintain it, or to rebuild it.

An AI agent reads the repository, works out its design areas and the principles behind them, then teaches and quizzes the person live in chat. Every question, answer, time and score is recorded. Later sessions read that history, aim at the weak areas, and show progress as charts. Each session ends with a readiness level for each design area.

The owner's reason: a person should be able to point this at any repository and get an honest answer to "am I ready for an interview or a job on this code?"

## Decisions the owner made

These came from the owner. Do not change them without asking.

1. **Audience:** any person, any repository. It is a general tool to publish, with no particular learner in mind.
2. **Where it happens:** all live in chat. The skill writes no guide file and nothing into the studied repository.
3. **Purpose of the result:** the person learns if they are ready for an interview or a job on the code.
4. **Modes:** the person picks a mode at the start of each session: a learn mode with teaching and hints, or a strict mock-interview mode with no hints and a verdict.
5. **Saved state:** history is saved so the skill can learn the person's gaps and adapt. It lives in the home folder, per repository, under `ai-tools/repo-ready` in the XDG state directory.
6. **Tracking:** everything is tracked. Time and accuracy were named; the owner's words were "everything anything be tracked". Repository state (branch and commit) is tracked too.
7. **Charts:** progress is shown in chat as good-looking charts built from the history.
8. **Verdict:** levels per area. Each design area gets one of: can read it, can maintain it, can rebuild it. The overall verdict is the lowest level that holds across the key areas, with the gaps listed.
9. **Repository changes:** when the repository has changed since the last session, the areas that changed are marked stale, trust in the person's level for those areas drops, and new questions cover what changed. Untouched areas keep their level.
10. **Platforms:** Claude Code, Codex and OpenCode versions ship together, as `dns-checker` and `gh-watcher` do.
11. **Engine:** a new tested CLI in `tools/`, following the pattern of the existing tools. All three skills call the same commands.
12. **Name:** `repo-ready` for the CLI command, the package `@ai-tools/repo-ready`, and the skill.
13. **What the levels mean:** the verdict says it in plain words. `read` means ready to be interviewed on the code. `maintain` means ready to work on it. `rebuild` means ready to own it. Below `read` it says not yet ready.

Everything below that is not in this list is the designer's call. The larger calls are marked **(designer's call)** so the owner can check them.

## Goals

- A person can start a session with one command or one sentence, in any repository, with no setup beyond the installed CLI and skill.
- Questions test design understanding: why the code is shaped as it is, how a flow moves through it, what breaks if something changes, and how to rebuild it.
- The verdict comes from fixed rules applied to recorded results, so two sessions with the same results give the same verdict.
- Each session is better aimed than the last, because it reads the history.
- Times are real clock times stamped by the CLI, not estimates by the agent.
- Results match across Claude Code, Codex and OpenCode, because one CLI holds the state and the rules.

## Non-goals

- No guide document, web site or file in the studied repository.
- No team features: no shared results, no leaderboard, no sync between machines.
- No more than one learner per home folder. One operating-system user is one learner.
- No more than one map per repository. A person can focus a session on some areas, but there is one map.
- No level decay over time. Levels change only through new answers and repository changes. Charts show when each area was last tested, so the person can see old results.
- No network calls from the CLI.
- No plugin with a docked pane. That may come later.
- No install step for any particular machine. This design ships files in the `ai-tools` repository only.

## Anti-goals

These would make the tool a failure even if it runs. **(designer's call)**

- **Trivia.** Questions about file names, line numbers or exact identifiers for their own sake. Names may appear in a question, but the answer must need understanding.
- **Ungrounded grading.** A question or a grade that is not backed by a place in the code. Every question carries evidence as `path:line` references.
- **Flattery.** A verdict that the agent chooses by feel. The agent grades single answers against a rubric; the CLI alone computes levels and the verdict.
- **Lectures.** Long teaching blocks before the person does anything. Lessons are short and tied to a question.
- **Pollution.** Any write into the studied repository, including ignored files.

## The parts

| Part | Path | What it is |
| --- | --- | --- |
| CLI | `tools/repo-ready/` | `@ai-tools/repo-ready`, bin `repo-ready`. Holds state, clock, git facts, rules and charts. |
| Claude Code skill | `skills/claude-code/repo-ready/SKILL.md` | The session procedure for Claude Code. |
| Codex prompt | `skills/codex/repo-ready.md` | The same procedure for Codex. |
| OpenCode command | `skills/opencode/repo-ready.md` | The same procedure for OpenCode. |
| Generic snippet | `skills/generic/AGENTS.md.snippet.md` | A short `repo-ready` section, as for the other tools. |
| Docs | `tools/repo-ready/README.md`, root `README.md`, `AGENTS.md`, `skills/README.md` | Tool reference, repo map entry, install matrix rows. |
| Release | `.github/workflows/release.yml` and related scripts | `repo-ready` joins the per-tool release on a `repo-ready-v<version>` tag. First version `0.1.0`. |

### Who does what

The split is the centre of the design.

- **The agent does judgement:** it reads the repository, writes the map, writes each question, teaches, gives hints, and grades each answer against the rubric.
- **The CLI does facts:** it stamps times, reads branch and commit, stores every event, finds what changed, computes levels and the verdict, chooses what to test next, and draws charts.

The agent never edits state files directly. It only calls the CLI.

## The map

The map is the agent's model of the repository's design. The agent builds it on the first run and the CLI stores it.

A map holds 1 to 10 **areas**; the CLI rejects a map outside that range. **(designer's call)** A normal repository has 4 to 10. A very small one may have fewer, and the agent must not pad the map to reach a number. An area is a part of the design that a maintainer must understand as a unit, such as "state storage", "the watch loop" or "the release pipeline". An area is not a folder, though it lists the paths that belong to it.

Each area has:

- `id`: a short stable slug.
- `title` and `summary`.
- `key`: true if the area counts towards the overall verdict. At least one area must be key.
- `paths`: glob patterns for the files that belong to the area.
- `principles`: the design decisions and rules of the area. Each has an id, a statement, the reason for it, and evidence as `path:line` references.
- `revision`: a whole number. The agent raises it only when the design of the area changes. See "Repository changes".

The agent writes the map as a JSON file in a temporary location and submits it with `repo-ready map set --file <path>`. The CLI validates it, stamps it with the current branch and commit, and stores it. A bad map is rejected with a clear message and exit code `2`.

### Changing the map later

**(designer's call)** A later `map set` may change the map's structure, within rules that stop a verdict from rising without new answers:

- **Adding an area** is always accepted. A new area has no history, so it can only lower the verdict.
- **Renaming** a title or changing a summary, paths or principles is always accepted. The `id` is the identity: a new id is a new area.
- **Removing an area, or clearing its `key` flag,** is accepted only when files in that area changed since the map's commit, or when its paths no longer match any file. Otherwise the CLI rejects the map with exit code `2`.
- **Splitting an area** is a removal plus additions, under the same rules.
- `map set --force --reason <text>` overrides the rejection. The skill allows the agent to use it only when the person asks for the map to be redrawn.

The CLI prints every structural change in the `map set` result and records it in the log, and the agent tells the person. Events of a removed area stay in the log and appear in `history` and the charts as retired; they no longer count towards the verdict.

On large repositories the agent may explore with subagents where the platform has them, but the map still has at most 10 areas. **(designer's call)**

## A session

1. The person starts it: `/repo-ready`, or a plain request such as "quiz me on this repo".
2. The agent runs `repo-ready status --json`.
   - **No map:** the agent explores the repository, builds the map, submits it, and shows the person the list of areas.
   - **Map exists:** the agent runs `repo-ready map changes --json` and handles any changes (see "Repository changes"). Then it shows the person their progress chart.
3. The agent asks the person to pick a mode: learn or interview. The person may also name areas to focus on.
4. The agent runs `repo-ready session start --mode <mode>`.
5. The agent loops:
   1. `repo-ready next --json` returns what to test next: area, level, question type, the reason, and the recent prompts for that area so the agent does not repeat them.
   2. In learn mode, if the area is new or weak, the agent gives a short lesson (about 150 to 300 words, with code references) and records it with `repo-ready teach`.
   3. The agent writes one question grounded in the map's evidence and records it with `repo-ready ask`. The CLI stamps the start time and returns a question id. The agent then shows the question.
   4. When the person replies, the agent first runs `repo-ready answer <id>` with the reply text. The CLI stamps the end time. Only then does the agent grade.
   5. The agent grades with `repo-ready grade <id> --score <0-4>` plus notes and gap tags.
   6. Learn mode: the agent gives feedback at once, shows the evidence, and teaches again on a miss. Interview mode: the agent gives no feedback and moves on.
   7. The agent may ask one follow-up question before it returns to `repo-ready next`. See "Follow-up questions".
6. The session ends when the person says so, or after the default length of 8 questions. **(designer's call)** The agent runs `repo-ready session end`, which returns the levels and the verdict. The agent shows the verdict, the gaps, and the charts. In interview mode it now gives the full debrief for each question.

The person can ask for progress, history or charts at any time, in or out of a session.

### Modes

| | Learn | Interview |
| --- | --- | --- |
| Lessons | Yes, short, before questions on weak areas | No |
| Hints | Yes, on request; each is recorded with `repo-ready hint <id>` | No |
| Feedback | After each answer | Only in the debrief at the end |
| Looking at the code | Allowed | The person is asked not to; this is on trust |
| Follow-up questions | Gentle | Probing, as an interviewer would |

### Follow-up questions

**(designer's call)** A follow-up is a full question. The agent records it with `repo-ready ask --follow-up-of <id>`, and it is answered, timed and graded like any other. It counts in the level rules and in the session length.

- The agent chooses the follow-up's target, not `repo-ready next`. It must be in the same area, at the same level or one level higher.
- There is at most one follow-up for each question that `next` chose, so `next` stays in charge of the session.
- A failed follow-up can cost a level. That is intended: a probing interviewer finds the edge of what a person knows.

### Question types and levels

The levels and their plain labels are the owner's decision. The question types for each level are the designer's call.

| Level | Meaning | Label in the verdict | Question types |
| --- | --- | --- | --- |
| read | Can explain what the area does and why it is designed so | Ready to be interviewed on it | `explain`, `trace` |
| maintain | Can change and repair it without breaking the design | Ready to work on it | `predict` (what breaks if this changes), `debug` (given this symptom, where is the cause), `change` (how to add this within the design) |
| rebuild | Can design the area again from nothing | Ready to own it | `rebuild` |

Every place that prints a level or the verdict prints the label with it: `status`, `levels`, `session end`, the `levels` chart and the report.

### Grading rubric

**(designer's call)** The agent gives each answer a whole score:

- `0` wrong or blank
- `1` mostly wrong, one correct element
- `2` partly correct, a key element missing or wrong
- `3` correct, small gaps
- `4` correct and complete

An answer **passes** when its score is 3 or 4 and no hint was used. A skipped question counts as score 0.

### Level rules

**(designer's call)** The CLI computes these; the agent does not.

- An area holds a level when the person passed at least 2 of their last 3 valid graded questions at that level in that area, and the area holds every lower level. A question is valid unless a revision rise voided it; see "Repository changes".
- Passes in both modes count.
- An area is **untested** at a level when it has fewer than 2 valid graded questions at that level. Untested is not the same as failed, and the output keeps them apart.
- The **overall verdict** is the lowest level held across the key areas.
  - If a key area holds no level because it is untested at `read`, the verdict is "not enough evidence yet", with the count of untested key areas.
  - If every key area has been tested at `read` and one holds no level, the verdict is "not yet ready".
- The verdict lists the gaps: the areas that hold it down, the weakest question types, and the gap tags that recur.

A first verdict takes more than one session on a repository with many key areas. `session end` therefore prints two things: the cumulative levels and verdict above, and a **session summary** for this session alone: questions asked, pass rate, time per question, and results by area and level. In interview mode the session summary leads.

The numbers 2, 3 and 8 are named constants in one place.

## Repository changes

Every event records the branch, the commit and whether the working tree had uncommitted changes. There is one history per repository across all branches.

Two things can go out of date, and they are handled apart:

1. **The map.** `repo-ready map changes` lists the files that changed between the map's commit and the current commit, grouped by area, plus changed files that belong to no area. The agent reads those changes and submits an updated map. For each area it decides whether the design changed. If it did, the agent raises that area's `revision`. If only details changed, the revision stays.
2. **The person's level.** When an area's revision rises, the CLI voids the person's graded questions at the top level the area holds at that moment, and at every level above it. Questions at lower levels stay valid. **(designer's call)**
   - By the normal level rules the area now holds one level lower: rebuild becomes maintain, maintain becomes read, read becomes no level. This is the level that counts in the overall verdict.
   - The area is **stale**. The CLI shows the level it held before with a stale mark, and puts the area first in `repo-ready next`, targeted at that earlier level. The agent asks questions about what changed.
   - The person earns the earlier level back by the normal rule: 2 passes in the last 3 valid questions at that level. They do not start again from `read`, and passes at lower levels during the re-test cannot lower the counted level.
   - The stale mark clears when the area holds the earlier level again, or when 3 questions at that level have been graded on the new revision. In the second case the area keeps the lower level, without a mark.
   - If the revision rises again before the mark clears, the same rule applies again from the level the area holds at that moment, so the area drops one more level.

This means a typing fix in an area costs the person nothing, and a design change costs them one level in that area until they show they understand the change.

If the map's commit cannot be found, for example after a history rewrite, the CLI reports that it cannot compare, and the agent reviews every area. If the folder is not a git repository, branch and commit are recorded as empty and there is no change detection.

### Repository identity

**(designer's call)** State is keyed by repository, not by folder, so two clones share one history. The key is the normalised `origin` remote URL when there is one, otherwise the hash of the first commit, otherwise a hash of the absolute path.

## What is tracked

State lives under `ai-tools/repo-ready` in the XDG state directory, overridable by `AI_TOOLS_REPO_READY_STATE_DIR`. Each repository has its own folder holding the current map, earlier maps, and one append-only event log. All statistics, levels and charts are computed from the log; nothing derived is stored as the source of truth.

Every event has: time, session id, mode, branch, commit, dirty flag, and map commit. Events are recorded for:

- session start and end
- map set, with which revisions rose and every structural change
- lesson given: area and principles covered
- question asked: area, area revision, principles, level, type, the full question text, evidence, and the question it follows up, if any
- hint given
- answer received: the full answer text, and the time taken from ask to answer
- grade: score, notes, gap tags
- skip

The full question and answer text is kept so the person can review past sessions. It stays on the person's machine. `repo-ready reset --yes` deletes the history for a repository, and `repo-ready export` writes it out as JSON.

**Time taken** is from the moment the question is recorded to the moment the reply is recorded. It includes reading and typing time. The tool README states this plainly.

## Adapting

`repo-ready next` gives an ordered list of what to test. The order is fixed and tested: **(designer's call)**

1. stale areas
2. key areas at the lowest level, at the next level above what they hold
3. other areas at the lowest level
4. within an area, the question types with the lowest pass rate, then the slowest

A focus on named areas, when the person asks for one, filters this list. The agent writes the question; the CLI only chooses the target.

## Charts

`repo-ready chart <kind> --format text|json|html` and `repo-ready report --format text|html [--out <path>]`.

Kinds, at least:

- `levels`: each area with its level, stale marks, and when it was last tested
- `accuracy`: pass rate over sessions, overall and per area
- `speed`: time per question over sessions
- `types`: pass rate per question type
- `timeline`: sessions against the branch and commit they ran on

Formats:

- `text`: Unicode bars and sparklines that read well in a terminal chat. This is the form every platform can show.
- `html`: one self-contained page with inline SVG, no scripts from the network, readable in light and dark. `report` puts all kinds on one page.
- `json`: the numbers behind the chart.

**(designer's call)** Charts are drawn by code in the CLI, with no chart library, so the released binary stays small.

How the skills use them: each skill shows the `text` chart in chat by default. The Claude Code skill adds: where the session has a tool that shows HTML in chat, pass it the `html` output instead. The skill must not start a server to show a chart.

## CLI surface

All commands take `--repo <path>` (default: the current directory) and `--json` wherever a result is printed. Exit codes follow the repository convention: `0` success, `1` not found (for example no map or no history yet), `2` error.

| Command | Purpose |
| --- | --- |
| `status` | Repository identity, map state, levels, stale areas, last session |
| `map set --file <path> [--force --reason <text>]` | Validate and store a map; print structural changes |
| `map show` | Print the current map |
| `map changes` | Files changed since the map's commit, grouped by area |
| `session start --mode learn\|interview` | Open a session |
| `session end` | Close it and print levels and verdict |
| `session list` | Past sessions |
| `teach --area <id>` | Record a lesson |
| `ask --area <id> --level <level> --type <type> [--follow-up-of <id>]` | Record a question, stamp the start time, return its id |
| `hint <id>` | Record a hint |
| `answer <id>` | Record the reply and stamp the end time |
| `grade <id> --score <0-4>` | Record the grade |
| `skip <id>` | Record a skip |
| `next` | What to test next |
| `levels` | Levels and verdict now |
| `history` | Past questions and answers, filterable by area and session |
| `chart <kind>` | One chart |
| `report` | All charts |
| `export` | History as JSON |
| `reset --yes` | Delete this repository's history |

Long text (question, answer, notes, evidence) is passed by file or standard input, so shell quoting cannot damage it.

## Constraints

From the repository's own rules (`AGENTS.md`, root `README.md` "Adding a tool"):

- TypeScript, strict mode, ESM with NodeNext resolution. Source split into `src/core/` (engine, no I/O assumptions) and `src/cli/` (commander program).
- Tests use vitest and run offline. The clock, the file system location, and the git runner are injected.
- eslint and prettier pass. British English in prose, comments and commits. No code comments unless essential.
- No personal information; examples use `example.com`, `example.org` and `octo-org/hello-world`.
- Conventional Commits.
- `npm run build:bin` packages the CLI as a native binary, and the release workflow publishes it on a `repo-ready-v<version>` tag that matches `tools/repo-ready/package.json`. The agent that builds this runs the release; it is not left as an owner step.
- A row for this work goes on the `TASKS.md` board in the task worktree, in the board's format.

## How we know it works

- Unit tests cover: map validation and the structural-change rules, event storage, follow-up limits, time stamping with an injected clock, repository identity, change detection, staleness, level rules, verdict, `next` ordering, and each chart in `text` and `json` form.
- An end-to-end test drives the CLI through a whole session with a fixed clock and checks the verdict and the text report.
- A manual run of the Claude Code skill against the `ai-tools` repository itself: build a map, run one learn session and one interview session, change a file, and confirm that the area goes stale and comes back.

## Left to the builder

- Field names and file layout inside the state folder.
- How `src/core/` is split into modules.
- The exact look of each chart and of the HTML report, within the format rules above.
- The exact wording of the three skill files, as long as they describe the same session procedure and the same commands.
- Extra chart kinds or history filters that fall out naturally from the data.
- The wording of lessons, hints and questions, which the agent produces at run time.
