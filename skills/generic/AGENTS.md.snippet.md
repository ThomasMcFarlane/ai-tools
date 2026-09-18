## External state tools (dns-checker, gh-watcher)

Two CLIs let you check external state, wait for changes, and resume work. Build them once with `npm install && npm run build -w @ai-tools/dns-checker -w @ai-tools/gh-watcher`; the binaries are then at `<repo>/tools/dns-checker/dist/cli.js` and `<repo>/tools/gh-watcher/dist/cli.js`.

### dns-checker (DNS)

- Look up records across resolvers: `dns-checker lookup example.com -t A AAAA MX -r cloudflare --json`
- Test a rule once: `dns-checker check example.com -t A --expect 203.0.113.10`
- Block until a rule matches: `dns-checker wait _acme-challenge.example.com -t TXT --contains "token" --timeout 10m`
- Rule flags: `--expect <values...>`, `--expect-absent <values...>`, `--contains <value>`, `--regex <pattern>`, `--absent`, `--any-change`
- Resolver presets: cloudflare, google, quad9, opendns, adguard, yandex (or `system`, `all`, literal IPs)
- Persistent watches: `dns-checker watch add|list|show|remove|check|run|events`

### gh-watcher (GitHub Actions, requires authenticated `gh` CLI)

- One check: `gh-watcher status --repo octo-org/hello-world --pr 17 --json`
- Block until terminal state: `gh-watcher wait --repo octo-org/hello-world --pr 17 --json`
- Persistent watches: `gh-watcher watch add <name> --repo <owner/name> --pr <n> [--on failure|success|complete] [--hook <spec>]`, plus `list|show|remove|check|run|events`

### The wait pattern

Run `wait` (or `watch run`) as a background task. The CLI blocks quietly, then prints a JSON event and exits. Read the JSON, then continue the task with the results. Example:

```sh
dns-checker wait example.com -t A --expect 203.0.113.10 --timeout 15m --json
gh-watcher wait --repo octo-org/hello-world --pr 17 --json
```

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success or match |
| 1 | No match or not found |
| 2 | Error |
| 124 | Timeout |

Both CLIs support `--json` on every result-printing command. Prefer `--json` when an agent consumes the output.
