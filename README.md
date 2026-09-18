# ai-tools

Tools that let AI agents check external state, wait for changes, and resume work from hooks.

## Tools

| Name | Package | Bin | One line | What it does |
| --- | --- | --- | --- | --- |
| dns-checker | `@ai-tools/dns-checker` | `dns-checker` | Multi-resolver DNS tooling for agents | DNS lookups across resolvers in the spirit of dnschecker.org, expectation checks, blocking waits, persistent watchers with hooks, and an MCP server |
| gh-watcher | `@ai-tools/gh-watcher` | `gh-watcher` | GitHub Actions watcher for agents | Reads Actions runs and checks through the `gh` CLI, blocks until a target succeeds or fails, and fires hooks when a job step fails or everything succeeds |
| hooks | `@ai-tools/hooks` | (library) | Shared hook machinery | The shared `exec` / `webhook` / `file` / `notify` hook library both watcher tools use |

## Supported AI platforms

| Platform | What you install | How the tools are reached |
| --- | --- | --- |
| Claude Code | Skills + MCP + CLI | Skills under `skills/claude-code/`, MCP server via `claude mcp add`, CLI from any shell |
| Codex CLI | Custom prompt + MCP + CLI | Prompt files under `skills/codex/`, MCP server via `codex mcp add`, CLI from any shell |
| opencode | Command file + CLI | Command files under `skills/opencode/`, CLI from any shell |
| Gemini CLI / Cursor / any agent | Generic AGENTS snippet + CLI | Paste `skills/generic/AGENTS.md.snippet.md` into your instructions file, CLI from any shell |

See [skills/README.md](skills/README.md) for the full install matrix.

## Requirements

- Node >= 20
- `gh` CLI installed and authenticated (needed by gh-watcher only; dns-checker never calls GitHub)

## Quick start

```sh
git clone <repository-url> ai-tools
cd ai-tools
npm install
npm run build -w @ai-tools/dns-checker -w @ai-tools/gh-watcher
```

Three things you can do straight away:

```sh
# Look up a domain as several public resolvers see it
node tools/dns-checker/dist/cli.js lookup example.com --resolver cloudflare

# Block until a TXT record contains a value (e.g. an ACME challenge token)
node tools/dns-checker/dist/cli.js wait _acme-challenge.example.com -t TXT --contains "token" --timeout 10m

# Block until the checks on a pull request finish
node tools/gh-watcher/dist/cli.js wait --repo octo-org/hello-world --pr 17
```

## The agent resume pattern

The core loop every tool in this repo is built around:

1. The agent starts `dns-checker wait` (or `watch run`) as a background task.
2. The CLI blocks, polling quietly, until the rule matches or the timeout elapses.
3. The CLI prints a JSON event (with `--json`) and exits: `0` on match, `124` on timeout.
4. The agent resumes with the results and continues the task.

For long-running conditions, a persistent watcher plus a hook removes the resume step entirely. When the watch matches, the tool fires the hook you configured with `watch add --hook`:

```sh
node tools/dns-checker/dist/cli.js watch add deploy-live \
  --domain example.com -t A --expect 203.0.113.10 \
  --hook notify:claude
node tools/dns-checker/dist/cli.js watch run
```

`notify:claude`, `notify:codex` and `notify:opencode` adapters run the matching agent CLI with a prompt describing the event and ask it to continue the task that set up the watcher. Plain `exec:<command>`, `webhook:<url>` and `file:<path>` hooks integrate anything else.

### Hook environment variables

Hooks are fired through `@ai-tools/hooks`. Every hook process gets:

| Variable | Set by | Contents |
| --- | --- | --- |
| `EVENT` | both tools | The full event as a JSON string |
| `EVENT_SUMMARY` | both tools | A short human readable summary of the event |
| `DNS_EVENT` | dns-checker | The full event as JSON (same payload as `EVENT`) |
| `DNS_WATCH_NAME` | dns-checker | Name of the watch that matched |
| `DNS_DOMAIN` | dns-checker | Domain the watch polls |
| `DNS_TYPE` | dns-checker | Record type the watch polls |
| `DNS_MATCHED` | dns-checker | `true` or `false` |
| `DNS_REASON` | dns-checker | Why the check matched or did not |
| `DNS_VALUES` | dns-checker | The current record values as a JSON array |

`exec` hooks additionally receive the full event JSON on stdin.

> **SECURITY**: `exec` hooks run arbitrary shell commands with these variables in the environment. `webhook` URLs receive the full event JSON in a POST body. Only point hooks at commands and endpoints you control.

## MCP

dns-checker ships an MCP server (`tools/dns-checker/dist/mcp.js`) exposing 8 tools:

- `dns_lookup`
- `dns_check`
- `dns_wait`
- `dns_watch_add`
- `dns_watch_list`
- `dns_watch_remove`
- `dns_watch_check`
- `dns_events`

Register it with Claude Code:

```sh
claude mcp add dns-checker -- node <absolute-path>/tools/dns-checker/dist/mcp.js
```

Register it with Codex CLI:

```sh
codex mcp add dns-checker -- node <absolute-path>/tools/dns-checker/dist/mcp.js
```

For any other MCP-compatible client:

```json
{
  "mcpServers": {
    "dns-checker": {
      "command": "node",
      "args": ["/absolute/path/to/ai-tools/tools/dns-checker/dist/mcp.js"]
    }
  }
}
```

gh-watcher's MCP server is on the roadmap. Its CLI `wait` / `check` pattern already works from any agent today: run `gh-watcher wait` in the background, read the JSON outcome, resume.

## State and configuration

Both watcher tools keep state under the XDG state directory:

| Tool | Default state dir | Override |
| --- | --- | --- |
| dns-checker | `~/.local/state/ai-tools/dns-checker` | `AI_TOOLS_DNS_STATE_DIR` |
| gh-watcher | `~/.local/state/ai-tools/gh-watcher` | `AI_TOOLS_GH_WATCHER_STATE_DIR` |

Each directory holds:

- `watchers.json`: saved watch specs (and per-watch baselines for dns-checker)
- `events.jsonl`: append-only log of watch events

`XDG_STATE_HOME` is honoured when set.

## Privacy and security

- No telemetry, no accounts, no network calls beyond the lookups and GitHub API requests the tools exist to make.
- DNS queries go only to the resolvers you pick (`system` by default, or a named preset, or a literal IP).
- gh-watcher talks to GitHub only through your local, authenticated `gh` CLI. No tokens are stored or proxied by this repo.
- This repository must never contain personal information. Contributors: keep examples generic (example.com, octo-org/hello-world).

## Monorepo layout

```
ai-tools/
├── tools/
│   ├── dns-checker/   # @ai-tools/dns-checker (CLI, core, MCP server)
│   └── gh-watcher/    # @ai-tools/gh-watcher (CLI, core)
├── packages/
│   └── hooks/         # @ai-tools/hooks (shared exec/webhook/file/notify hooks)
├── skills/            # copy-paste skills and prompts for AI platforms
└── .github/           # CI workflows
```

## Development

```sh
npm install      # install all workspaces
npm run build    # build all workspaces
npm run typecheck
npm run test
npm run lint
```

Every command runs across all workspaces from the repository root.

## Adding a tool

Follow the existing conventions:

- Package lives at `tools/<name>` and is named `@ai-tools/<name>`.
- Bin is named `<name>` and points at `dist/cli.js`.
- Source is split into `core/` (engine, no I/O assumptions), `cli/` (commander program) and `mcp/` (optional MCP server).
- Dependencies are injectable so tests run offline (no real DNS or GitHub calls).
- `--json` is supported everywhere a result is printed.
- Exit codes are documented: `0` success or match, `1` no match or not found, `2` error, `124` timeout.
- State lives under `ai-tools/<name>` in the XDG state directory, overridable by `AI_TOOLS_<NAME>_STATE_DIR`.

## License

MIT
