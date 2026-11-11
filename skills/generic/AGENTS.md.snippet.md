## External state tools (dns-checker, gh-watcher)

Two CLIs let you check external state, wait for changes, and resume work. Build them once with `npm install && npm run build -w @ai-tools/dns-checker -w @ai-tools/gh-watcher`; the binaries are then at `<repo>/tools/dns-checker/dist/cli.js` and `<repo>/tools/gh-watcher/dist/cli.js`.

### dns-checker (DNS)

- Look up records across resolvers: `dns-checker lookup example.com -t A AAAA MX -r cloudflare --json`
- Test a rule once: `dns-checker check example.com -t A --expect 203.0.113.10`
- Flaky resolvers are retried (`--retries <n>`, default 3; `--timeout <ms>` is per attempt, default 2000); results carry `attempts`.
- Block until a rule matches: `dns-checker wait _acme-challenge.example.com -t TXT --contains "token" --timeout 10m`
- Rule flags: `--expect <values...>`, `--expect-absent <values...>`, `--contains <value>`, `--regex <pattern>`, `--absent`, `--any-change`
- Resolver presets: cloudflare, google, quad9, opendns, adguard, yandex (or `system`, `all`, literal IPs)
- Persistent watches: `dns-checker watch add|list|show|remove|check|run|events`

### gh-watcher (GitHub Actions, requires authenticated `gh` CLI)

- One check: `gh-watcher status --repo octo-org/hello-world --pr 17 --json`
- Block until terminal state: `gh-watcher wait --repo octo-org/hello-world --pr 17 --json`
- Persistent watches: `gh-watcher watch add <name> --repo <owner/name> --pr <n> [--on failure|success|complete] [--hook <spec>]`, plus `list|show|remove|check|run|events`

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
gh-watcher wait --repo octo-org/hello-world --pr 17 --json
```

### Exit codes

| Code | Meaning               |
| ---- | --------------------- |
| 0    | Success or match      |
| 1    | No match or not found |
| 2    | Error                 |
| 124  | Timeout               |

Both CLIs support `--json` on every result-printing command. Prefer `--json` when an agent consumes the output.
