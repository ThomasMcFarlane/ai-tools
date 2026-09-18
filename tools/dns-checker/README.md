# @ai-tools/dns-checker

DNS lookup, expectation checks, waits and watchers for AI agents, inspired by dnschecker.org.

Query one or many resolvers, assert expectations against a rule, block until a record
changes, and run persistent named watches that fire hooks. Every command is non-interactive
and exit-code driven, so an agent can treat it as a pure function.

## Install and build

Quickest path: download a prebuilt binary from the Releases page of this repository. Artifacts follow the pattern `dns-checker-<os>-<arch>`: `dns-checker-linux-x64`, `dns-checker-linux-arm64`, `dns-checker-macos-x64`, `dns-checker-macos-arm64` and `dns-checker-win-x64.exe`. Make the downloaded file executable (`chmod +x`), put it on your `PATH`, and verify with `dns-checker --help`. The binaries are self-contained and need no Node at runtime. On macOS they are unsigned: remove the quarantine attribute with `xattr -d com.apple.quarantine dns-checker` or approve the binary in System Settings on first run.

Alternatively, build from source (requires Node >= 20 and npm). From the repository root:

| Step | Command |
| --- | --- |
| Install workspace dependencies | `npm install` |
| Build every workspace (recommended) | `npm run build` |
| Build only this tool | `npm run build -w @ai-tools/dns-checker` |
| Package self-contained native binaries | `npm run build:bin` |
| Typecheck | `npm run typecheck -w @ai-tools/dns-checker` |
| Test | `npm run test -w @ai-tools/dns-checker` |

The bin is `dns-checker`, mapped to `tools/dns-checker/dist/cli.js` (see `package.json`).
From the repo root either form works:

```sh
npx dns-checker --help
node tools/dns-checker/dist/cli.js --help
```

The package also exports a library API (`exports["."]`) pointing into `dist/`.

## Command reference

### dns-checker lookup

Look up DNS records for a domain.

```sh
dns-checker lookup [options] <domain>
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `-t, --type <types...>` | `A` | Record types, comma or space separated. Repeatable. |
| `-r, --resolver <names...>` | `system` | Resolver names, `all`, or literal IPs. Comma or space separated. |
| `--transport <mode>` | `auto` | `auto`, `udp`, `doh` or `system`. |
| `--timeout <ms>` | `5000` | Per-lookup timeout in milliseconds. |
| `--strict` | off | Exit 1 when every lookup errors. |
| `--json` | off | Emit results as JSON. |

Results print one block per type and resolver combination, answers sorted
lexicographically. Lookup failures are reported per result and do not change the exit
code unless `--strict` is set and every lookup errored.

### dns-checker check

Check DNS records against a rule once.

```sh
dns-checker check [options] <domain>
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `-t, --type <type>` | `A` | Single record type. |
| `-r, --resolver <name>` | `system` | `system`, a registry name, or a literal IP. |
| `--transport <mode>` | `auto` | `auto`, `udp`, `doh` or `system`. |
| `--timeout <ms>` | `5000` | Lookup timeout in milliseconds. |
| `--expect <values...>` | | Rule: see [Match rules](#match-rules). |
| `--expect-absent <values...>` | | Rule. |
| `--contains <value>` | | Rule. |
| `--regex <pattern>` | | Rule. |
| `--absent` | off | Rule. |
| `--any-change` | off | Rule. |
| `--json` | off | Emit the outcome as JSON. |

Exactly one rule flag is required. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Matched (also: `--any-change` recorded its first baseline) |
| `1` | Not matched |
| `2` | Lookup error, or invalid rule (missing or multiple rule flags) |

### dns-checker wait

Poll DNS until a rule matches or the wait times out.

```sh
dns-checker wait [options] <domain>
```

Takes the same rule flags as `check`, plus:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--interval <duration>` | `30s` | Poll interval. |
| `--timeout <duration>` | `30m` | Overall wait limit, capped at 24h. |

Durations accept a bare number (seconds) or a unit suffix: `250ms`, `30s`, `5m`, `1h`.
While polling, a `.` progress dot is written to stderr. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Matched |
| `124` | Timed out without a match |
| `2` | Lookup error, or invalid rule |

### dns-checker resolvers

List the built-in resolver presets. `--json` emits the same data as JSON.

### dns-checker watch add

Add a new persistent watch.

```sh
dns-checker watch add [options] <name> --domain <d>
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--domain <d>` | (required) | Domain name to watch. |
| `-t, --type <type>` | `A` | Record type. |
| `--expect <values...>` | | Rule. Exactly one rule flag required. |
| `--expect-absent <values...>` | | Rule. |
| `--contains <value>` | | Rule. |
| `--regex <pattern>` | | Rule. |
| `--absent` | off | Rule. |
| `--any-change` | off | Rule. |
| `--interval <duration>` | `60s` | Poll interval used by the daemon. |
| `-r, --resolver <name>` | `system` | `system`, a registry name, or a literal IP. |
| `--transport <mode>` | `auto` | `auto`, `udp`, `doh` or `system`. |
| `--hook <spec>` | `none` | Hook specification, see [Hooks](#hooks). |
| `--json` | off | Emit the saved spec as JSON. |

Exit `1` if a watch with the same name already exists; `2` for an invalid rule.

### dns-checker watch list

List saved watches. `--json` emits the raw specs.

### dns-checker watch show

```sh
dns-checker watch show <name>
```

Print the full spec as JSON. Exit `1` for an unknown name.

### dns-checker watch remove

```sh
dns-checker watch remove <name>
```

Remove a watch and its baseline and match state. Exit `1` for an unknown name.

### dns-checker watch check

```sh
dns-checker watch check [names...]
```

Check watches once and fire hooks on every match (manual checks bypass edge
suppression). Omit names to check all watches. `--json` emits the events as a JSON
array. Exit codes: `0` when at least one watch matched, `1` when none matched, `2` when
any given name is unknown.

### dns-checker watch run

```sh
dns-checker watch run [names...]
```

Run the watch daemon until interrupted (Ctrl+C or SIGTERM). The daemon sweeps every 5
seconds and checks each watch when its `--interval` has elapsed. Daemon checks are
edge-fired: see [Watchers](#watchers). Exit `2` at startup if any given name is unknown.

### dns-checker watch events

```sh
dns-checker watch events [--tail <n>] [--json]
```

Show recent watch events, oldest first. `--tail <n>` defaults to `20`. Events come from
`events.jsonl` (see [Watchers](#watchers)).

## Exit codes at a glance

| Code | dns-checker meaning |
| --- | --- |
| `0` | Match or success (including baseline recording on `check`) |
| `1` | Not matched, not found, or general usage error |
| `2` | Error: lookup failure in `check`/`wait`, invalid rule, unknown watch name in `watch check`/`watch run` |
| `124` | `wait` timed out |

## Multi-resolver lookup

`lookup` accepts multiple resolvers and expands the cartesian product of types times
resolvers. Built-in registry:

| Name | Label | IPs | DoH |
| --- | --- | --- | --- |
| `cloudflare` | Cloudflare | 1.1.1.1, 1.0.0.1 | `https://cloudflare-dns.com/dns-query` |
| `google` | Google Public DNS | 8.8.8.8, 8.8.4.4 | `https://dns.google/resolve` |
| `quad9` | Quad9 | 9.9.9.9, 149.112.112.112 | none |
| `opendns` | OpenDNS | 208.67.222.222, 208.67.220.220 | none |
| `adguard` | AdGuard DNS | 94.140.14.14, 94.140.15.15 | none |
| `yandex` | Yandex DNS | 77.88.8.8, 77.88.8.1 | none |

`dns-checker resolvers` prints this table; add `--json` for machine output.

Resolver arguments may be:

- `system`: the operating system resolver.
- A registry name from the table above.
- `all` (`lookup` only): expands to every registry name.
- A literal IP address: used directly.

Transport selection with `--transport`:

| Mode | Behaviour |
| --- | --- |
| `auto` | `system` resolver uses the OS resolver; resolvers with a DoH endpoint use DoH; others use plain UDP. |
| `udp` | Send the query over UDP to the resolver's first IP. |
| `doh` | Use DNS-over-HTTPS JSON (`application/dns-json`). Fails for resolvers without a DoH endpoint. |
| `system` | Force the OS resolver, overriding `--resolver`. |

## Match rules

Exactly one rule flag is allowed per `check`, `wait` or `watch add`. Values are compared
against the normalised answer values for the record type.

| Flag | Matches when |
| --- | --- |
| `--expect <values...>` | The set of returned values equals the given set (order insensitive). |
| `--expect-absent <values...>` | None of the listed values are present. |
| `--contains <value>` | At least one value contains the substring. |
| `--regex <pattern>` | At least one value matches the regular expression (JavaScript syntax). |
| `--absent` | The lookup returned no records. |
| `--any-change` | The values differ from the recorded baseline. |

`--any-change` baseline behaviour:

- `check`: the baseline key is `domain|type|resolver`, stored in `watchers.json`. The
  first invocation records the baseline, prints `baseline recorded`, and exits `0`
  without evaluating a rule. Later invocations compare against it.
- `wait`: if no baseline exists yet, the first poll records one and the wait continues
  (it will not match on that first poll). If a baseline already exists in state, it is
  used immediately.
- Watchers: the baseline is keyed by watch name and refreshed after every check, so a
  change fires once and only a further change fires again.

## Record types and normalisation

Supported types: `A`, `AAAA`, `CNAME`, `MX`, `NS`, `TXT`, `SOA`, `SRV`, `CAA`, `PTR`.

Answers are normalised to plain strings so rules work uniformly:

| Type | Normalised form | Example |
| --- | --- | --- |
| `A` / `AAAA` | Address, TTL preserved where available | `93.184.216.34` |
| `MX` | `<priority> <exchange>` | `10 mail.example.com` |
| `TXT` | Multi-string chunks joined into one string | `hello` `world` becomes `helloworld` |
| `SRV` | `<priority> <weight> <port> <target>` | `10 5 8080 svc.example.com` |
| `CAA` | `<critical> <tag> "<value>"` | `0 issue "letsencrypt.org"` |
| `SOA` | Space-joined fields | `ns1.example.com hostmaster.example.com 2024010101 7200 3600 1209600 3600` |

Answer lists are sorted lexicographically, so `--expect` comparisons are stable across
resolvers.

## Watchers

Watches persist in a state directory:

| File | Purpose |
| --- | --- |
| `~/.local/state/ai-tools/dns-checker/watchers.json` | Watch specs, per-watch baselines and match edges. |
| `~/.local/state/ai-tools/dns-checker/events.jsonl` | One JSON event per line, appended on every check. |

Path resolution: `AI_TOOLS_DNS_STATE_DIR` overrides the whole directory; otherwise
`XDG_STATE_HOME` is honoured, defaulting to `~/.local/state` (`%LOCALAPPDATA%` on
Windows). The final directory is `<base>/ai-tools/dns-checker`.

Event semantics:

- Every check appends an event to `events.jsonl` with `watch`, `domain`, `type`,
  `matched`, `reason`, `values`, `checkedAt` and `fired`.
- Daemon checks (`watch run`) are edge-fired: the hook fires only on the transition from
  not-matched to matched. A watch that stays matched does not refire; once a check
  returns not-matched, the edge resets and the next match fires again.
- Manual checks (`watch check`) fire the hook on every match.
- `--any-change` watchers update their baseline after every check, so each change fires
  at most once.

## Hooks

Hook spec grammar (`--hook` on `watch add`):

```
none
exec:<command>
webhook:<url>
file:<path>
notify:claude|codex|opencode
```

| Spec | What happens | Timeout |
| --- | --- | --- |
| `none` | Nothing fires. | |
| `exec:<command>` | Runs the command through the shell with the full event JSON on stdin. Succeeds when the command exits 0. | 60s, then SIGKILL |
| `webhook:<url>` | `POST` with `content-type: application/json` and the event JSON as the body. Succeeds on any 2xx. | 60s |
| `file:<path>` | Appends one JSON line to the file, creating parent directories. Always succeeds on write. | |
| `notify:<tool>` | Launches a coding agent CLI with a prompt built from the event summary, full event JSON and an instruction to continue the task. | 600s |

> Security: `exec:` runs an arbitrary shell command from the stored watch spec. Only
> register watch specs you wrote yourself or fully trust.

The notify backends map to:

| Tool | Command |
| --- | --- |
| `notify:claude` | `claude -p <prompt>` |
| `notify:codex` | `codex exec <prompt>` |
| `notify:opencode` | `opencode run <prompt>` |

Environment variables exposed to `exec` and `notify` hooks (exact names from source):

| Variable | Value |
| --- | --- |
| `EVENT` | Full event JSON. |
| `EVENT_SUMMARY` | Human readable summary (the event's `summary` field if present, else the JSON). |
| `DNS_EVENT` | Full event JSON (same as `EVENT`). |
| `DNS_WATCH_NAME` | Watch name. |
| `DNS_DOMAIN` | Domain that was checked. |
| `DNS_TYPE` | Record type. |
| `DNS_MATCHED` | `true` or `false`. |
| `DNS_REASON` | Match reason string. |
| `DNS_VALUES` | JSON array string of the current values. |

## Agent patterns

Blocking wait as a background task:

```sh
# shell or agent harness
dns-checker wait example.com --type TXT --contains "verification-code" \
  --interval 10s --timeout 15m --json &
```

- Exit `0`: the record matched; read the JSON result for `values`.
- Exit `124`: timed out; retry or escalate.
- Exit `2`: resolver or rule error; fix the invocation.

Watcher plus notify for long horizons:

```sh
dns-checker watch add deploy-done --domain example.org --type A \
  --expect 93.184.216.34 --interval 30s --hook notify:claude
dns-checker watch run deploy-done
```

The daemon fires the hook once when the record flips to the expected address, and the
notified agent receives the watch name, reason and current values.

Exit code quick reference for agents:

| Situation | Command | Code |
| --- | --- | --- |
| Record matched / rule satisfied | `check`, `wait` | `0` |
| Record present but rule not satisfied | `check` | `1` |
| Wait ran out of time | `wait` | `124` |
| Lookup or rule error | `check`, `wait` | `2` |
| Any watch matched on a manual pass | `watch check` | `0` |
| No watch matched on a manual pass | `watch check` | `1` |

## Privacy

- DNS queries go only to the resolver you chose: the OS resolver, the registry entry's
  servers, its DoH endpoint, or your literal IP.
- Watch state stays in the local state directory.
- No telemetry, no analytics, no third-party calls beyond the chosen resolver.
