## External state tools (dns-checker, gh-watcher, repo-ready)

Three CLIs let you check external state, wait for changes, resume work, and quiz a person on a repository. Build them once with `npm install && npm run build -w @ai-tools/dns-checker -w @ai-tools/gh-watcher -w @ai-tools/repo-ready`; the binaries are then at `<repo>/tools/dns-checker/dist/cli.js`, `<repo>/tools/gh-watcher/dist/cli.js` and `<repo>/tools/repo-ready/dist/cli.js`.

### dns-checker (DNS)

- Look up records across resolvers: `dns-checker lookup example.com -t A AAAA MX -r cloudflare --json`
- Test a rule once: `dns-checker check example.com -t A --expect 203.0.113.10`
- Flaky resolvers are retried (`--retries <n>`, default 3; `--timeout <ms>` is per attempt, default 2000); results carry `attempts`.
- Block until a rule matches: `dns-checker wait _acme-challenge.example.com -t TXT --contains "token" --timeout 10m`
- Rule flags: `--expect <values...>`, `--expect-absent <values...>`, `--contains <value>`, `--regex <pattern>`, `--absent`, `--any-change`
- Resolver presets: cloudflare, google, quad9, opendns, adguard, yandex (or `system`, `all`, literal IPs)
- Persistent watches: `dns-checker watch add|list|show|remove|check|run|events`

### gh-watcher (GitHub Actions and pull requests)

Use `gh-watcher` for every GitHub Actions and pull request lifecycle wait. Start each wait in the background with `--json`. Keep the session active and receive the command's JSON and exit code before you act on the result.

- Before merging, wait for checks with `gh-watcher wait --repo octo-org/hello-world --pr 17 --json`.
- For lifecycle events, use `gh-watcher pr wait --repo octo-org/hello-world --pr 17 --on merged,closed --json`.
- Find exact run IDs in `runs[].databaseId` with `gh-watcher status --repo octo-org/hello-world --commit "$SHA" --json`. Use a full 40-character SHA. Read `state` because `status` returns `0` for any report.
- Wait on each exact run with `gh-watcher wait --repo octo-org/hello-world --run 123456789 --json`. Include post-merge publication, release, promotion and deployment. If no run exists, wait with `--commit "$SHA"`, then identify and wait for each exact run. Verify the live deployment separately when applicable.
- On `0`, inspect the successful check or matched event. On `1`, inspect `failedSteps` and `failedChecks` and fix failures you own. On `2`, correct the command or report the relay defect. On `124`, report the timeout or start a new bounded wait.

Set `GH_WATCHER_EVENTS_URL` or use `--events-url <url>`. T3 `watch_pull_request` and other notifications can supplement the wait. Never use them as the sole trigger to resume. Do not use GitHub CLI watch commands, sleep loops, manual status polling or a direct GitHub polling fallback. See the [canonical gh-watcher skill](https://github.com/ThomasMcFarlane/ai-tools/blob/main/skills/claude-code/gh-watcher/SKILL.md).

### repo-ready (learning a repository)

Teach and quiz a person on a repository's design, and report whether they are ready to be interviewed on it, work on it or own it. Build with `npm run build -w @ai-tools/repo-ready`; the binary is then at `<repo>/tools/repo-ready/dist/cli.js`. Run commands from the studied repository's root. Pass long text on standard input with `--file -`.

- Start: `repo-ready status --json`. On exit `1` (no map), write a map of 1 to 10 design areas, with principles and `path:line` evidence, to a temporary folder outside the repository and run `repo-ready map set --file <path>`. With a map, run `repo-ready map changes --json`, raise `revision` only where an area's design changed, and `map set` again.
- Then: `repo-ready chart levels --format text`, ask for learn or interview mode, `repo-ready session start --mode learn|interview`
- Loop, until `next` reports `session.done`:
  1. `repo-ready next --json`
  2. learn mode: `repo-ready teach --area <id>` after a short lesson
  3. `repo-ready ask --area <id> --level <level> --type <type> --evidence <path:line> --file -`, then show the question
  4. learn mode, on request: `repo-ready hint <id>`
  5. `repo-ready answer <id> --file -` before grading, or `repo-ready skip <id>`
  6. `repo-ready grade <id> --score <0-4> --gaps <tags> --file -`
  7. at most one follow-up per question: `repo-ready ask ... --follow-up-of <id>`
- End: `repo-ready session end`, then show the verdict, gaps and `repo-ready chart <kind> --format text`
- Rules: only the CLI touches state; never write into the studied repository; every question rests on code you read; no trivia; show a question only after `ask` and record `answer` before grading; quote levels and the verdict only as printed, with the label (Ready to be interviewed on it, Ready to work on it, Ready to own it, Not yet ready, Not enough evidence yet); `map set --force` only when the person asks for a redraw; lessons of 150 to 300 words; interview mode gives no hints, feedback or teaching until the end.

### The wait pattern

Run `wait` (or `watch run`) as a background task. The CLI blocks quietly, then prints a JSON event and exits. Read the JSON, then continue the task with the results. Example:

```sh
dns-checker wait example.com -t A --expect 203.0.113.10 --timeout 15m --json
```

### Exit codes

| Code | Meaning               |
| ---- | --------------------- |
| 0    | Success or match      |
| 1    | No match or not found |
| 2    | Error                 |
| 124  | Timeout               |

All three CLIs support `--json` on every result-printing command. Prefer `--json` when an agent consumes the output.

## Shopping (shopper)

`shopper` compares prices and variants across online shops. The CLI fetches, parses, filters and ranks with fixed code. You plan the queries, judge relevance and report. Build it with `npm install && npm run build -w @ai-tools/agent-kit -w @ai-tools/shopper`; the binary is then at `<repo>/agents/shopper/dist/cli.js`. Use it when the user wants to buy, price-check, compare or watch the price of a product.

- Start: `shopper defaults show --json` and `shopper learn list --json`. Apply both.
- Search: `shopper search <query...> --json` (flags `--sites`, `--condition`, `--max-price`, `--limit`, `--include-oos`).
- Read real variants and prices: `shopper listing <url> --json`. Always do this for marketplaces such as AliExpress.
- Report a table: price, shop and site, stock, condition, variant, link, time seen. Report only what the CLI printed in this run. Never invent a price, a link or an alternative.
- If the output has `conditionUnresolved`, ask the user which conditions to allow, then search again with `--condition`.
- Sites in the mode `user-browser` (`needsUserBrowser`) need the logged-in browser of the user. The CLI never opens them. Ask first. Then run `shopper script <site> search` in a tab that the user already has open, save the JSON and run `shopper parse <site> search --url <tab url> --file <snapshot.json> --json`. Never open a tab or navigate the browser of the user.
- Learn: `shopper learn add --kind block|selector|method|correction|note --key <key> --value <json> [--site <id>] [--expires 24h] [--evidence <text>]`. At the end run `shopper learn flush`.
- Watches: `shopper watch add|list|show|edit|remove|run|history`. A systemd user timer from `shopper watch timer --write` runs `shopper watch run-due --notify`. Alerts go to `SHOPPER_NOTIFY_CMD`. Scheduled runs skip `user-browser` sites.
- Environment: `AGENTS_MEMORY_DIR`, `AGENTS_STATE_DIR`, `AGENTS_MEMORY_PERSIST`, `AGENTS_MEMORY_READONLY`, `AGENTS_BROWSER_PROFILE_DIR`, `SHOPPER_DEFAULTS`, `SHOPPER_NOTIFY_CMD`.
- Exit codes: `0` ok, `1` nothing found, `2` error. On `2`, read the message and fix the call.
