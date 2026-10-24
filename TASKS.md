# Tasks

## 1. dns-checker
ETA: 2026-11-30 18:00 ICT

| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Worldwide resolver locations like dnschecker.org | done | claude | dns-checker-world-locations | | 2026-10-20 18:00 ICT | dns-checker `-r` only has the presets cloudflare, google, quad9, opendns, adguard and yandex (tools/dns-checker/src/core/resolvers.ts) plus literal IPs, with no geography. Add a location-tagged resolver set matching dnschecker.org's locations (public resolvers per country and city), a preset like `-r world`, and show the location in lookup, check, wait and watch output. Also follow NS delegations: today NS queries for a delegated zone return ENODATA, and `dig +norec` against the TLD servers was needed. Done in #45 (33 world resolvers, -r world, NS referral lookups); released as dns-checker-v0.2.0. Was DNS-1. |
| 2 | Comparison table and interactive world map for results | done | claude | dns-checker-results-view | 1.1 | 2026-10-20 18:00 ICT | Improve the dns-checker skill and the CLI and agent responses to render a proper table of results per location, highlighting matches and differences across the world (expected vs actual per resolver and location). Separately, build a UI app that renders the results on an interactive world map. Done in #44 (comparison table, map command); released as dns-checker-v0.2.0. Was DNS-2. |
| 3 | Retry timed-out resolvers and query in parallel | done | claude | dns-checker-retries | | 2026-10-20 18:00 ICT | World resolvers (uol-br, telefonica-cl, level3-jp, vnpt-vn and others) time out intermittently (UDP, 5000ms) and show as error, although they are alive. There is no retry option, and lookups query resolvers one at a time so every timeout adds its full wait. Add `--retries` with a shorter per-attempt timeout and query resolvers concurrently with a bound. Done in #47 (retries on timeout, SERVFAIL and refused/reset, default 3; 32 parallel queries; world NS lookup 39/39 in about 4s); released as dns-checker-v0.2.1. Was DNS-3. |
| 4 | Add --version | done | claude | dns-checker-retries | | 2026-10-20 18:00 ICT | `dns-checker --version` fails with `error: unknown option '--version'` in the 0.2.0 binary. Print the package version, including from the compiled binary. Done in #47; released as dns-checker-v0.2.1. Was DNS-4. |
| 5 | Normalise trailing dots before comparing | done | claude | dns-checker-retries | | 2026-10-20 18:00 ICT | DoH answers (cloudflare, google) end in a trailing dot, so identical NS and MX answers count as differ against UDP resolvers. Strip the trailing dot and lowercase names before comparing and displaying. Done in #47; released as dns-checker-v0.2.1. Was DNS-5. |
| 6 | Normalise TXT quoting before comparing | done | claude | dns-checker-txt-quotes | | 2026-10-20 18:00 ICT | Cloudflare DoH returns TXT strings wrapped in double quotes ("v=spf1 ...") while UDP resolvers and Google return them bare, so identical TXT answers count as differ (seen on phoenixcourt.vc TXT: cloudflare differs from google, quad9, opendns and the authoritative server with the same 5 values). Strip the wrapping quotes (and join split TXT chunks consistently) before comparing, like the trailing-dot fix in 1.5. Done in #48; released as dns-checker-v0.2.2. Was DNS-6. |

## 2. Housekeeping
ETA: 2026-10-21 18:00 ICT

| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 7 | CLUSTER-287 hq0 disk cleanup for this repository | done | claude | cluster-287-cleanup | | 2026-10-21 18:00 ICT | Finished the merged task worktrees board-owner-gate-explicit (#12), fix-action-bundle (#14) and epic-eta-lint (#40); removed downloaded resolver lists and vendored type copies from .data scratch. Kept scripts, notes, results and the tasks-board plugin config. Was OPS-1. |

## 3. jev-compaction
ETA: 2026-10-23 14:00 ICT

| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 8 | Shorten dropped-call notes | done | claude | jev-note-collapse | | 2026-10-23 14:00 ICT | Each dropped tool call left `[jev-compaction dropped <tool> call: <raw JSON head>; re-run if needed]` in history, one transcript row per call (about 40 to 45 tokens each). Now `[jev dropped <tool>: <readable head>]` (Bash command, else path, pattern, URL, query or prompt; 80-char cap), roughly half the tokens; old format still recognised so compacted text is never cut twice. Done in #50; version 0.2.2. Was JEV-1. |
| 9 | Collapse runs of dropped-call notes into one expandable row | dropped | claude | jev-note-collapse | | | Dropped: the engine gives `AssistantMessage` render props no `isExpanded` and no view of neighbouring rows, so a run cannot be merged into one row with a ctrl+o expand; owner chose the shorter note (3.8) instead, 2026-10-23. Was JEV-2. |

## 4. tasks-board
ETA: 2026-10-25 03:00 ICT

| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 10 | Numeric board IDs, <epic>.<task> references, cleanup PR self-merge | done | claude | board-numeric-ids | | 2026-10-24 23:00 ICT | Lint rule numeric-id, renumbering in the format agent prompt, agent merges the cleanup PR when CI is green; ships as tasks-board-check-v3 and tasks-board 0.7.0. Done in #51 (642c550); tagged tasks-board-check-v3.0.0, tasks-board-check-v3 and tasks-board-v0.7.0; skill docs in ThomasMcFarlane/.ais#82. |
| 11 | Board quality rules: descriptive epic names, concise rows, cell-count fixer | done | claude | | | | Done in #54 (13ac1fe); tags tasks-board-check-v4.0.0, tasks-board-check-v4, tasks-board-v0.8.0; skill in ThomasMcFarlane/.ais#83; 31 boards migrated |
| 12 | Fix the failing pane-label target test | todo | | | | | target.test.ts "the pane is labelled and filled from the picked board, not the session directory": expected "Board · a", got undefined<br>Fails on main 9517976 too (95 pass, 1 fail) |
| 13 | Fix fixer edge cases: trailing prose tables, empty surplus cells, short rows | done | claude | fixboard-edges | | 2026-10-25 03:00 ICT | Done in #55 (6846c92)<br>Tags tasks-board-check-v4.0.1, tasks-board-check-v4, tasks-board-v0.8.1 |
