---
description: Look up DNS records, verify expectations, wait for DNS changes, manage watchers with dns-checker.
---

# dns-checker

Use this command whenever a task needs to know what DNS records a domain has, whether they match an expectation, or when they will change: propagation checks, ACME challenge verification, cut-over confirmation, change detection.

## Command reference

The binary is at `<repo>/tools/dns-checker/dist/cli.js`. Examples below call it as `dns-checker`.

### lookup: read records as one or more resolvers see them

```sh
dns-checker lookup example.com
dns-checker lookup example.com -t A AAAA MX -r cloudflare google --json
```

- `-t, --type <types...>`: record types (A, AAAA, CNAME, MX, NS, TXT, SOA, SRV, CAA, PTR; default A)
- `-r, --resolver <names...>`: `system`, preset names, `all`, or literal IPs (default system)
- `--transport <mode>`: `auto`, `udp`, `doh` or `system` (default auto)
- `--timeout <ms>`: per-lookup timeout (default 5000)
- `--strict`: exit 1 when every lookup errors
- `--json`: emit results as JSON

List the built-in resolver presets (cloudflare, google, quad9, opendns, adguard, yandex) with:

```sh
dns-checker resolvers --json
```

### check: test one rule once

```sh
dns-checker check example.com -t A --expect 203.0.113.10
dns-checker check example.com -t TXT --contains "verification" --json
```

Rule flags: `--expect <values...>` (value set equals), `--expect-absent <values...>`, `--contains <value>`, `--regex <pattern>`, `--absent` (no records), `--any-change` (differs from recorded baseline).

### wait: block until a rule matches

Same rule flags as `check`, plus:

- `--interval <duration>` (default 30s)
- `--timeout <duration>` (default 30m, capped at 24h)

```sh
dns-checker wait _acme-challenge.example.com -t TXT --contains "token" --timeout 10m
```

### watch: persistent watches with hooks

```sh
dns-checker watch add <name> --domain <d> [rule flags] [--interval <duration>] [--hook <spec>]
dns-checker watch list --json
dns-checker watch show <name>
dns-checker watch remove <name>
dns-checker watch check [names...] --json   # check once, fire hooks on matches
dns-checker watch run [names...]            # run the daemon until interrupted
dns-checker watch events --tail 20 --json
```

`--hook <spec>` accepts `none` (default), `exec:<command>`, `webhook:<url>`, `file:<path>`, `notify:claude`, `notify:codex` or `notify:opencode`.

## The wait-as-background-task pattern

1. Run as a background task: `dns-checker wait example.com -t A --expect 203.0.113.10 --timeout 15m --json`
2. The CLI blocks, then prints one JSON outcome: `{"matched": true, "reason": ..., "values": [...]}`.
3. Exit code `0` means matched, `124` means timed out, `2` means error.
4. Read the JSON and continue the task with the result.

## Watcher plus notify:opencode

```sh
dns-checker watch add cut-over \
  --domain example.com -t A --expect 203.0.113.10 \
  --interval 60s --hook notify:opencode
dns-checker watch run
```

When the record matches, the daemon runs `opencode run "<event prompt>"` asking the agent to continue the task that created the watcher. `--hook exec:<command>` gets `EVENT`, `EVENT_SUMMARY` and `DNS_*` variables plus the event JSON on stdin.

## World locations and NS delegation

- `-r world` (`lookup` only) queries every location-tagged public resolver (33 cities). `-r all` is unchanged and means the six global presets.
- With `--json`, each per-resolver result carries `location` (`city`, `country`, `countryCode`, `lat`, `lon`) when the resolver has one; anycast presets and literal IPs omit the key. `check`, `wait` and watch events carry it too.
- `lookup -t NS` against a parent or authoritative server (a literal IP such as a TLD server) falls back to a non-recursive query and reports the delegated NS set from the referral, instead of failing with ENODATA.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success or rule matched |
| 1 | No match, not found, or every lookup errored (`lookup --strict`) |
| 2 | Error |
| 124 | Timed out (`wait`) |

## Presenting results across resolvers and locations

When a task compares resolvers or locations, run the lookup with `--json` and present the result as a markdown table instead of pasting raw output. One table per record type, one row per resolver, located resolvers first and grouped by country.

```sh
dns-checker lookup example.com -t A -r cloudflare google quad9 --expect 203.0.113.10 --json
```

Each result in the JSON has `resolver`, `type`, `answers` (`value`, `ttl`), optional `error` and, for location-tagged resolvers, `location` (`city`, `country`, `countryCode`, `lat`, `lon`). Resolvers without `location` (anycast presets such as cloudflare and google) have no place on a map: list them in a separate "Anycast" group.

Table template (replace the example values):

```markdown
**example.com A** expected `203.0.113.10`

| Location | Resolver | Answer | Status | TTL |
| --- | --- | --- | --- | --- |
| US, New York | 8.8.8.8 | `203.0.113.10` | ✅ match | 300 |
| DE, Berlin | 9.9.9.9 | **`198.51.100.7`** | ❌ differs | 300 |
| JP, Tokyo | 77.88.8.8 | timed out after 5000ms | ⚠️ error | - |
| Anycast | cloudflare | `203.0.113.10` | ✅ match | 300 |

**Summary:** 2 match, 1 differs, 1 error. Differences: Berlin (DE) still serves the old address.
```

- Status is `match` when the answer set equals the expected set (`--expect`), or, without `--expect`, the most common answer set across resolvers; otherwise `differs`. A failed lookup is `error`, never `differs`.
- Bold the answers that differ so they stand out, and list matching answers plainly.
- Always end with a one-line summary (N match, M differ, K error), naming the locations or countries that differ.
- Sort by country code, then city; TTL is the lowest TTL among the answers.
- To give the user an interactive world map, run `dns-checker map example.com -r <resolvers> --expect <values> -o dns-map.html` (or `dns-checker map --input results.json`), or add `--serve --port 8787` to serve it on localhost. The page is self-contained and works offline.
