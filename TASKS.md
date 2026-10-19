# Tasks

## 1. dns-checker
ETA: 2026-11-30 18:00 ICT

| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| DNS-1 | Worldwide resolver locations like dnschecker.org | in_progress | claude | dns-checker-world-locations | | 2026-10-20 18:00 ICT | dns-checker `-r` only has the presets cloudflare, google, quad9, opendns, adguard and yandex (tools/dns-checker/src/core/resolvers.ts) plus literal IPs, with no geography. Add a location-tagged resolver set matching dnschecker.org's locations (public resolvers per country and city), a preset like `-r world`, and show the location in lookup, check, wait and watch output. Also follow NS delegations: today NS queries for a delegated zone return ENODATA, and `dig +norec` against the TLD servers was needed. |
| DNS-2 | Comparison table and interactive world map for results | in_progress | claude | dns-checker-results-view | 1.DNS-1 | 2026-10-20 18:00 ICT | Improve the dns-checker skill and the CLI and agent responses to render a proper table of results per location, highlighting matches and differences across the world (expected vs actual per resolver and location). Separately, build a UI app that renders the results on an interactive world map. |
