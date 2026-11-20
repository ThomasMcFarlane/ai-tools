# shopper

A CLI that compares prices and variants across online shops. It fetches, parses, filters and ranks with fixed code. A model chooses the queries and talks to the user. See [PRINCIPLES.md](../PRINCIPLES.md).

## Install

```sh
npm install
npm run build -w @ai-tools/shopper
node agents/shopper/dist/cli.js --help
```

Native binaries come from the `shopper-v<version>` GitHub release.

## Commands

```
shopper search <query...> [--sites a,b] [--condition new,used] [--max-price N] [--limit N]
                          [--include-oos] [--defaults f] [--memory-dir d] [--json]
shopper listing <url> [--json]
shopper sites [--json]
shopper defaults show|path|validate [file]|schema
shopper learn add --kind k [--site s] --key k --value json [--expires 24h|ISO] [--evidence t]
shopper learn list [--site s] [--json]
shopper learn flush
shopper script <site> search|listing
shopper parse <site> search|listing --url <u> [--file f]
shopper watch add|list|show|edit|remove|run|run-due|history|timer   (see Scheduled watches)
```

Exit codes: `0` ok, `1` nothing found, `2` error.

## Sites

| Id           | Site            | Fetch mode   |
| ------------ | --------------- | ------------ |
| `lazada-th`  | Lazada Thailand | headless     |
| `aliexpress` | AliExpress      | headless     |
| `jib`        | JIB             | http         |
| `advice`     | Advice IT       | headless     |
| `ihavecpu`   | iHAVECPU        | http         |
| `bnn`        | Banana IT       | user-browser |
| `shopee-th`  | Shopee Thailand | user-browser |

Shopee blocks headless browsers and logged-out profiles. Banana IT shows a Cloudflare challenge to headless browsers. The CLI never fetches these sites. Run `shopper script <site> search` and execute the script in a tab that the user already has open. Pass the result to `shopper parse <site> search --url <tab url>`.

Facebook Marketplace needs a personal profile. It has no adapter in this version.

## Defaults

The defaults file is JSON. [`defaults.schema.json`](defaults.schema.json) describes it. Run `shopper defaults show` to see the values in use. Order of precedence: `--defaults`, `SHOPPER_DEFAULTS`, `<memory dir>/shopper/defaults.json`, built-in values. A partial file merges over the built-in values.

Run `npm run schema -w @ai-tools/shopper` to regenerate the schema file. A test fails when the committed file is out of date.

## Filter and rank

- The condition rules pick the allowed conditions. The first rule whose `match` regex fits the query wins. Otherwise `condition.default` applies. An offer with an unknown condition counts as new.
- The CLI drops offers without a price, offers above the budget and out-of-stock offers. `--include-oos` keeps the last group.
- `cheapest` sorts by price. `value` puts in-stock offers with a rating of 4 or more first. `premium` sorts by rating, then price.
- Shipping counts in the price when `budget.includeShipping` is true and the shipping cost is known.

## Scheduled watches

A watch is a saved search that the CLI repeats and compares with the last result. It reports only what changed. A run never calls a model. Every step is fixed code, so a run is repeatable and testable.

### Files

| File                                     | Content                                           |
| ---------------------------------------- | ------------------------------------------------- |
| `<state dir>/shopper/watches.json`       | The watches. `SHOPPER_WATCHES_FILE` overrides it. |
| `<state dir>/shopper/history/<id>.jsonl` | One line per run of a watch.                      |
| `<state dir>/shopper/watch.lock`         | Lock for `run` and `run-due`.                     |
| `~/.config/ai-tools/shopper-watch.env`   | Optional environment for the systemd service.     |

The state dir is `AGENTS_STATE_DIR`, else `$XDG_STATE_HOME/ai-tools/agents`, else `~/.local/state/ai-tools/agents`. The JSON Schema of `watches.json` is [`watches.schema.json`](watches.schema.json). Run `npm run schema -w @ai-tools/shopper` to regenerate it. A test fails when the committed file is out of date.

### watches.json fields

| Field                                               | Meaning                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `id`                                                | `a-z`, `0-9` and `-`, 1 to 40 characters. The default is a slug of the query.                |
| `query`                                             | Search text sent to the shops.                                                               |
| `spec.include`                                      | Case-insensitive regexes. A title must match every one.                                      |
| `spec.exclude`                                      | Case-insensitive regexes. A title that matches any one is dropped.                           |
| `sites`                                             | Site ids, or `null` for `sites` in the defaults.                                             |
| `condition`                                         | Allowed conditions, or `null` for the condition rules in the defaults.                       |
| `maxPrice`                                          | Threshold in the watch currency, or `null`. It drives the `threshold` event only.            |
| `currency`                                          | ISO 4217 code, or `null` for `currency` in the defaults.                                     |
| `interval`                                          | Time between runs: `15m` minimum, units `m`, `h` and `d`.                                    |
| `notify.on`                                         | Event types to report: `new`, `price_drop`, `back_in_stock`, `threshold`, `scanner_failing`. |
| `notify.minDropPercent`                             | A price drop counts only when it is larger than this percentage.                             |
| `enabled`                                           | `false` stops the scheduled runs.                                                            |
| `createdAt`, `updatedAt`, `lastRunAt`, `lastStatus` | Set by the CLI. `lastStatus` is `ok`, `changes`, `error` or `baseline`.                      |

`watch add` takes `interval`, `notify.on` and `notify.minDropPercent` from the `watch` section of the defaults. `sites`, `condition` and `currency` stay `null` until a flag sets them, so a later change of the defaults applies to the watch. The flags `--sites all`, `--condition default`, `--currency default` and `--max-price none` set a value back to `null`. A list flag on `watch edit` replaces the old list.

### Events

The first run of a watch is a baseline. It reports only `threshold` events. A later run compares each site with its last 5 non-empty runs. A run that returns no matching listings does not replace those snapshots. It counts as a failure for `scanner_failing`.

- `new`: the listing was in none of the last 5 non-empty runs of that site. A listing that is absent for one run and then returns is not `new`. It can still give a `price_drop`, `back_in_stock` or `threshold` event against its last known state.
- `price_drop`: the price is lower by more than `notify.minDropPercent`.
- `back_in_stock`: the stock was `out_of_stock` and is now `in_stock` or `low_stock`.
- `threshold`: the price is at or below `maxPrice` now, and it was above it, missing or the listing was new.
- `scanner_failing`: a site failed or returned no listings 3 runs in a row. The run reports it once. The run that follows the recovery reports a note.

A site that fails keeps its last hits as the known state. When it works again, its old listings do not count as `new`. The key of a listing is the site plus the URL without query string and fragment.

### History

Each history line stores a hash of the query, spec, sites, condition and currency. When the hash differs from the last line, the run is a new baseline. `watch edit` that changes one of these fields also renames the history file to `<id>.<time>.jsonl.old`. `watch remove` deletes the history file. Add `--keep-history` to keep it.

### Notify contract

The command comes from `--notify-cmd`, then the `SHOPPER_NOTIFY_CMD` environment variable, then `watch.notifyCommand` in the defaults. The CLI runs it with `/bin/sh -c`. The message is on stdin. The environment holds `SHOPPER_WATCH_ID` and `SHOPPER_NOTIFY_STATE`. The state is `fail` when there are events and `ok` otherwise.

- Line 1 is the summary, for example `shopper: ddr5-32gb: 2 new, 1 price drop`.
- Then comes one line per event: kind, price with currency, previous price, site, title, URL.
- The last line is the check time in every zone of `report.timeZones`.
- The CLI sends nothing when there are no events and `watch.quietUnchanged` is true.
- Without a command, `--notify` prints the message to stdout.
- A command that fails makes the CLI exit with `2`. It prints the error and the message to stderr.
- A failed alert is not lost. The history line gets `notified: false` and keeps its events. The next `--notify` run sends those events again with its own events, once per type and listing. It then marks the new line `notified: true`. A run without `--notify` always records its line as `notified: false`, so the next notify run delivers its events. Old lines without the field count as delivered. Pending events make the CLI send a message even when `watch.quietUnchanged` is true.

### Scheduling

Scheduling uses a systemd user timer on the host. No CI job and no GitHub Actions schedule is used. No T3 or other agent scheduler is needed, because the runs are deterministic and never start a model.

```sh
shopper watch timer [--every 15m]          # print the two unit files
shopper watch timer --write                # write them to ~/.config/systemd/user
systemctl --user daemon-reload && systemctl --user enable --now shopper-watch.timer
```

`--write` uses `$XDG_CONFIG_HOME/systemd/user`. It never runs `systemctl`. The timer starts 5 minutes after boot and then every `--every`. The service is `Type=oneshot` with `Nice=19`, `MemoryHigh=2G`, `MemoryMax=3G` and `TimeoutStartSec=20min`. It reads the optional file `~/.config/ai-tools/shopper-watch.env`. Put `SHOPPER_NOTIFY_CMD`, `AGENTS_MEMORY_DIR` and `AGENTS_STATE_DIR` there. `ExecStart` holds the absolute path of the shopper binary, or of node and `cli.js`, followed by `watch run-due --notify`.

`watch run-due` runs each enabled watch whose `lastRunAt` plus `interval` has passed. It runs them one at a time under the lock file. The lock holds the process id and a token. A run takes over the lock at once when that process is dead, or when the lock is older than 2 hours. The takeover writes a temporary file, renames it over the lock, and aborts if the token it reads back is not its own. An alert command that runs longer than 60 seconds is killed with its whole process group.

User-browser sites, such as `shopee-th`, are never part of a scheduled run. A run lists them as skipped. Use `shopper script` and `shopper parse` with a tab that the user has open to check them.

### Watch commands

```
shopper watch add <query...> [--id] [--include re]... [--exclude re]... [--sites] [--condition]
                  [--max-price N|none] [--currency] [--interval 6h] [--on new,price_drop,...]
                  [--min-drop P] [--json]
shopper watch list [--json]
shopper watch show <id> [--json]
shopper watch edit <id> [same flags] [--enable|--disable]
shopper watch remove <id> [--keep-history]
shopper watch run <id> [--notify] [--notify-cmd cmd] [--json]
shopper watch run-due [--notify] [--notify-cmd cmd] [--json]
shopper watch history <id> [--limit N] [--json]
shopper watch timer [--every 15m] [--write] [--json]
shopper watch schema
```

Exit codes: `watch run` exits `0` when it found hits, `1` when it found none, and `2` on an error, such as every site failing or a failed alert command. `watch run-due` exits `0` or `2`.

## Learnings

A `block` learning makes `search` skip a site for 24 hours. A `selector` learning replaces an adapter selector. A `method` learning with the key `fetch` changes the fetch mode. A site that needs the user browser never changes mode. See [agents/README.md](../README.md) for the memory layout and `learn flush`.

## Adapters

Each adapter is one file in `src/core/adapters/`. It sets the id, the domains, the fetch mode, the selectors and the pure functions `parseSearch`, `parseListing` and `detectBlock`. Tests load saved pages with `test/helpers/fixture.ts` from `test/fixtures/<id>/<name>.html`.
