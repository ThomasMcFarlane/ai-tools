# shopper

Find the best current prices for an item across online shops, read real listings and variants, and set up price watches, with shopper.

## When to use

Use these instructions when the user wants to buy something, shop for it, price-check it, compare prices, find the cheapest option or a deal, or watch the price of a product, in any shop. You are the buyer's assistant. The `shopper` CLI does the fixed work: it fetches pages, parses them, filters, ranks and records. You plan the queries, judge relevance and report.

## Rules

- **Deterministic first.** The CLI fetches, parses, filters, ranks and records. You choose queries, judge whether a listing is the item that the user asked for, judge whether a variant matches, and talk to the user.
- **Report only what the CLI returned in this run.** Never report a listing or a price that the CLI did not print. Never invent an alternative from a spec sheet. Never use a price from a search snippet.
- **Never take over the browser of the user.** Use only tabs that you create. See "Sites that need the browser of the user".
- **Failures are failures.** Say which sites you skipped or which failed, and why.

## Requirements

- `shopper` on `PATH`, or `node <ai-tools>/agents/shopper/dist/cli.js` from a built `ai-tools` checkout. Call it with `node` wherever these instructions say `shopper`.
- Chromium or Chrome on `PATH` for the sites that need a headless browser. `AGENTS_CHROMIUM` sets the binary.
- Optional environment variables:

| Variable                     | Use                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `AGENTS_MEMORY_DIR`          | Folder with `shopper/defaults.json` and `shopper/learnings.jsonl`              |
| `AGENTS_MEMORY_READONLY`     | Set to `1` to forbid a direct write to the memory folder                       |
| `AGENTS_MEMORY_PERSIST`      | Shell command that stores pending learnings. `{agent}` and `{file}` are filled |
| `AGENTS_STATE_DIR`           | Writable state: watches, history, pending learnings                            |
| `AGENTS_BROWSER_PROFILE_DIR` | Folder for the headless browser profile                                        |
| `AGENTS_CHROMIUM`            | Path of the browser binary                                                     |
| `SHOPPER_DEFAULTS`           | Defaults file that replaces the one in the memory folder                       |
| `SHOPPER_NOTIFY_CMD`         | Alert command for watches. It reads the message on standard input              |
| `SHOPPER_WATCHES_FILE`       | Path of `watches.json`                                                         |

Run `shopper --version` once. If the command is missing, stop and tell the user how to install it.

## Start of every run

1. Run `shopper defaults show --json`. Read the location, currency, condition rules, budget style, report options and `notes`. Apply them. Obey every line of `notes`.
2. Run `shopper learn list --json`. Apply what it says: skip sites that have a live `block`, and use the methods and selectors that are recorded.
3. Run `shopper sites --json` when you need the site ids, the fetch modes or the live blocks.

## Workflow

1. Pick 1 to 3 search queries. Use the words that a shop would use for the item. Add the model number when you know it.
2. Run `shopper search <query...> --json`. For computer parts, add the part type to the query, for example `ram ddr5 32gb` and not `ddr5 32gb`. Some shops rank whole PC sets first. Useful flags: `--sites a,b`, `--condition new,used`, `--max-price N`, `--limit N`, `--include-oos`.
3. Open the best candidates with `shopper listing <url> --json`. This reads the real variants, SKUs and prices. Always do this for marketplaces, such as AliExpress, where a title can list options that do not exist. AliExpress item pages often block headless reads. When `listing` reports a block for AliExpress, say that the price per variant could not be read. Never report the price on the search card as the price of a variant.
4. Filter by judgement. Drop a listing that is a different item, a different size or capacity, an accessory, or a pack that does not match. Keep the reason.
5. Report a table of the offers that match. Columns: price in the currency of the defaults, shop and site, stock, condition, variant, link, and the time that the CLI saw it. Put the cheapest offer first, unless the budget style says otherwise.
6. State the sites that you skipped, and the sites that need the browser of the user.

If the output has `conditionUnresolved: true`, no condition rule fits the query. Ask the user which conditions to allow with the question tool of your host. Then run the search again with `--condition`.

## Sites that need the browser of the user

Some sites show results only to a logged-in user. The output marks them `needsUserBrowser`, and `shopper sites` shows the mode `user-browser`. The CLI never opens them. Shopee Thailand (`shopee-th`), Banana IT (`bnn`) and Facebook Marketplace (`facebook-marketplace`) are such sites. The browser of the user holds the login. Facebook needs a personal profile, not a Page.

1. Open your own new tab with the browser extension. Use the `tabs_create` tool with the `searchUrl` from the output. Create it in the tab group of your session. Never ask the user to open a tab.
2. Print the script with `shopper script <site> search`. Run it in your tab with the `javascript` tool of the extension.
3. Save the returned JSON to a file in a working folder outside the repository.
4. Run `shopper parse <site> search --url <tab url> --file <snapshot.json> --json`. Report only what this command prints.
5. For one product page, move your own tab with `location.assign('<item url>')`. Print the script with `shopper script <site> listing`, run it in the tab, and use `shopper parse <site> listing --url <tab url> --file <snapshot.json> --json`.
6. Close your tab when the work in it is done.

Work only in tabs that you created. Never navigate, adopt or take over an existing tab of the user, unless the user asks you to. The CLI itself never drives the browser of the user. Never type a password, solve a captcha or work around a block. If the tab shows a login page, tell the user. AliExpress stays in the headless browser of the CLI.

## Learn and improve

Record a learning when a deterministic check shows a fact:

- A site blocks the CLI: `shopper learn add --kind block --site <id> --key search --value '{"reason":"captcha"}' --expires 24h --evidence "captcha page"`.
- A selector breaks and you find a working one: `shopper learn add --kind selector --site <id> --key search.card --value '"<css selector>"' --evidence "<what you checked>"`.
- A fetch mode works better: `shopper learn add --kind method --site <id> --key fetch --value '"headless"' --evidence "http returns an empty page"`. A site that needs the user browser never changes mode.
- The user corrects you, or gives a rule to keep: `shopper learn add --kind correction --key <short key> --value "<the rule>"`. Use `--kind note` for a fact that is not a rule.

Options of `learn add`: `--kind`, `--key`, `--value` (JSON, or plain text stored as a string), `--site`, `--expires` (`24h`, `7d` or an ISO date) and `--evidence`.

At the end of a run, run `shopper learn flush`. By default it appends the new learnings to the durable memory folder (`$AGENTS_MEMORY_DIR`, or `~/.config/ai-tools/agents`). If `AGENTS_MEMORY_PERSIST` is set, it runs that shell command once instead. The placeholders `{file}` and `{agent}` are shell-quoted. The command also gets them as the environment variables `AGENTS_PERSIST_FILE` and `AGENTS_PERSIST_AGENT`. The command exits with `2` only in these cases: `AGENTS_MEMORY_READONLY=1` is set without `AGENTS_MEMORY_PERSIST`, the memory folder is not writable, or the persist command fails. Then tell the user.

## Watches

A watch is a saved search. The CLI repeats it and reports what changed. A run never calls a model.

```sh
shopper watch add "ddr5 32gb kit" --include "32 ?gb" --exclude "laptop|sodimm" --max-price 4500 --interval 6h --on new,price_drop,threshold
shopper watch list
shopper watch show ddr5-32gb-kit
shopper watch edit ddr5-32gb-kit --max-price 4000 --disable
shopper watch remove ddr5-32gb-kit
shopper watch run ddr5-32gb-kit --json
shopper watch history ddr5-32gb-kit --limit 5
```

- Without `--sites`, `--condition` and `--currency`, a watch follows the defaults. `--sites all`, `--condition default` and `--currency default` set a value back.
- A `watch run` without `--notify` keeps its events pending. A later run with `--notify`, such as the timer, delivers them.
- `shopper watch remove <id>` deletes the history of the watch. Add `--keep-history` to keep it.
- The first run is a baseline. A later run reports `new`, `price_drop`, `back_in_stock`, `threshold` and `scanner_failing` events.
- The scheduler is a systemd user timer. It runs `shopper watch run-due --notify`. No model, no CI job and no cron are used.

```sh
shopper watch timer --every 15m            # print the unit files
shopper watch timer --every 15m --write    # write them to the systemd user folder
systemctl --user daemon-reload && systemctl --user enable --now shopper-watch.timer
```

- Put `SHOPPER_NOTIFY_CMD` and the other variables in `~/.config/ai-tools/shopper-watch.env`. The service reads that file. `--notify-cmd` on `watch run` and `watch run-due` overrides the variable. The `watch.notifyCommand` setting in the defaults is the last choice.
- A scheduled run skips the sites that need the browser of the user. To check them, use the steps in the section above.
- Tell the user the exact watch id, the interval, the threshold and where the alerts go.

## Exit codes

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| 0    | Success                                                                  |
| 1    | Nothing found. For `parse` and `listing`: the page had no offers or data |
| 2    | Error. Read the message on standard error and fix the call               |

On `2`, never work around the error. A defaults file that is not valid also gives `2`. Run `shopper defaults validate` to see the issues.
