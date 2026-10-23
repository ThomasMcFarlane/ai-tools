# Tasks

## 1. dns-checker
ETA: 2026-11-30 18:00 ICT

| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| DNS-1 | Worldwide resolver locations like dnschecker.org | done | claude | dns-checker-world-locations | | 2026-10-20 18:00 ICT | dns-checker `-r` only has the presets cloudflare, google, quad9, opendns, adguard and yandex (tools/dns-checker/src/core/resolvers.ts) plus literal IPs, with no geography. Add a location-tagged resolver set matching dnschecker.org's locations (public resolvers per country and city), a preset like `-r world`, and show the location in lookup, check, wait and watch output. Also follow NS delegations: today NS queries for a delegated zone return ENODATA, and `dig +norec` against the TLD servers was needed. Done in #45 (33 world resolvers, -r world, NS referral lookups); released as dns-checker-v0.2.0. |
| DNS-2 | Comparison table and interactive world map for results | done | claude | dns-checker-results-view | 1.DNS-1 | 2026-10-20 18:00 ICT | Improve the dns-checker skill and the CLI and agent responses to render a proper table of results per location, highlighting matches and differences across the world (expected vs actual per resolver and location). Separately, build a UI app that renders the results on an interactive world map. Done in #44 (comparison table, map command); released as dns-checker-v0.2.0. |
| DNS-3 | Retry timed-out resolvers and query in parallel | done | claude | dns-checker-retries | | 2026-10-20 18:00 ICT | World resolvers (uol-br, telefonica-cl, level3-jp, vnpt-vn and others) time out intermittently (UDP, 5000ms) and show as error, although they are alive. There is no retry option, and lookups query resolvers one at a time so every timeout adds its full wait. Add `--retries` with a shorter per-attempt timeout and query resolvers concurrently with a bound. Done in #47 (retries on timeout, SERVFAIL and refused/reset, default 3; 32 parallel queries; world NS lookup 39/39 in about 4s); released as dns-checker-v0.2.1. |
| DNS-4 | Add --version | done | claude | dns-checker-retries | | 2026-10-20 18:00 ICT | `dns-checker --version` fails with `error: unknown option '--version'` in the 0.2.0 binary. Print the package version, including from the compiled binary. Done in #47; released as dns-checker-v0.2.1. |
| DNS-5 | Normalise trailing dots before comparing | done | claude | dns-checker-retries | | 2026-10-20 18:00 ICT | DoH answers (cloudflare, google) end in a trailing dot, so identical NS and MX answers count as differ against UDP resolvers. Strip the trailing dot and lowercase names before comparing and displaying. Done in #47; released as dns-checker-v0.2.1. |
| DNS-6 | Normalise TXT quoting before comparing | done | claude | dns-checker-txt-quotes | | 2026-10-20 18:00 ICT | Cloudflare DoH returns TXT strings wrapped in double quotes ("v=spf1 ...") while UDP resolvers and Google return them bare, so identical TXT answers count as differ (seen on phoenixcourt.vc TXT: cloudflare differs from google, quad9, opendns and the authoritative server with the same 5 values). Strip the wrapping quotes (and join split TXT chunks consistently) before comparing, like the trailing-dot fix in DNS-5. Done in #48; released as dns-checker-v0.2.2. |

## 2. Housekeeping
ETA: 2026-10-21 18:00 ICT

| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| OPS-1 | CLUSTER-287 hq0 disk cleanup for this repository | done | claude | cluster-287-cleanup | | 2026-10-21 18:00 ICT | Finished the merged task worktrees board-owner-gate-explicit (#12), fix-action-bundle (#14) and epic-eta-lint (#40); removed downloaded resolver lists and vendored type copies from .data scratch. Kept scripts, notes, results and the tasks-board plugin config. |

## 3. jev-compaction
ETA: 2026-10-23 14:00 ICT

| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| JEV-1 | Shorten dropped-call notes | done | claude | jev-note-collapse | | 2026-10-23 14:00 ICT | Each dropped tool call left `[jev-compaction dropped <tool> call: <raw JSON head>; re-run if needed]` in history, one transcript row per call (about 40 to 45 tokens each). Now `[jev dropped <tool>: <readable head>]` (Bash command, else path, pattern, URL, query or prompt; 80-char cap), roughly half the tokens; old format still recognised so compacted text is never cut twice. Done in #50; version 0.2.2. |
| JEV-2 | Collapse runs of dropped-call notes into one expandable row | dropped | claude | jev-note-collapse | | | Dropped: the engine gives `AssistantMessage` render props no `isExpanded` and no view of neighbouring rows, so a run cannot be merged into one row with a ctrl+o expand; owner chose the shorter note (3.JEV-1) instead, 2026-10-23. |
