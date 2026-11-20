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
```

Exit codes: `0` ok, `1` nothing found, `2` error.

## Sites

| Id           | Site            | Fetch mode   |
| ------------ | --------------- | ------------ |
| `lazada-th`  | Lazada Thailand | headless     |
| `aliexpress` | AliExpress      | headless     |
| `jib`        | JIB             | http         |
| `advice`     | Advice IT       | http         |
| `ihavecpu`   | iHAVECPU        | http         |
| `bnn`        | Banana IT       | http         |
| `shopee-th`  | Shopee Thailand | user-browser |

Shopee blocks headless browsers and logged-out profiles. The CLI never fetches it. Run `shopper script shopee-th search` and execute the script in a tab that the user already has open. Pass the result to `shopper parse shopee-th search --url <tab url>`.

Facebook Marketplace needs a personal profile. It has no adapter in this version.

## Defaults

The defaults file is JSON. [`defaults.schema.json`](defaults.schema.json) describes it. Run `shopper defaults show` to see the values in use. Order of precedence: `--defaults`, `SHOPPER_DEFAULTS`, `<memory dir>/shopper/defaults.json`, built-in values. A partial file merges over the built-in values.

Run `npm run schema -w @ai-tools/shopper` to regenerate the schema file. A test fails when the committed file is out of date.

## Filter and rank

- The condition rules pick the allowed conditions. The first rule whose `match` regex fits the query wins. Otherwise `condition.default` applies. An offer with an unknown condition counts as new.
- The CLI drops offers without a price, offers above the budget and out-of-stock offers. `--include-oos` keeps the last group.
- `cheapest` sorts by price. `value` puts in-stock offers with a rating of 4 or more first. `premium` sorts by rating, then price.
- Shipping counts in the price when `budget.includeShipping` is true and the shipping cost is known.

## Learnings

A `block` learning makes `search` skip a site for 24 hours. A `selector` learning replaces an adapter selector. A `method` learning with the key `fetch` changes the fetch mode. A site that needs the user browser never changes mode. See [agents/README.md](../README.md) for the memory layout and `learn flush`.

## Adapters

Each adapter is one file in `src/core/adapters/`. It sets the id, the domains, the fetch mode, the selectors and the pure functions `parseSearch`, `parseListing` and `detectBlock`. Tests load saved pages with `test/helpers/fixture.ts` from `test/fixtures/<id>/<name>.html`.
