# dns-checker

Look up DNS records, verify expectations, wait for DNS changes, manage watchers.

## When to use

Use this prompt whenever a task needs to know what DNS records a domain has, whether they match an expectation, or when they will change: propagation checks, ACME challenge verification, cut-over confirmation, change detection.

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

## Watcher plus notify:codex

```sh
dns-checker watch add cut-over \
  --domain example.com -t A --expect 203.0.113.10 \
  --interval 60s --hook notify:codex
dns-checker watch run
```

When the record matches, the daemon runs `codex exec "<event prompt>"` asking the agent to continue the task that created the watcher. `--hook exec:<command>` gets `EVENT`, `EVENT_SUMMARY` and `DNS_*` variables plus the event JSON on stdin.

## Prefer native tools?

Register the MCP server once and the tools appear directly in your tool list:

```sh
codex mcp add dns-checker -- node <repo>/tools/dns-checker/dist/mcp.js
```

Exposed tools: `dns_lookup`, `dns_check`, `dns_wait`, `dns_watch_add`, `dns_watch_list`, `dns_watch_remove`, `dns_watch_check`, `dns_events` (wait capped at 900 seconds).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success or rule matched |
| 1 | No match, not found, or every lookup errored (`lookup --strict`) |
| 2 | Error |
| 124 | Timed out (`wait`) |
