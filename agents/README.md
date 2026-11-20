# Agents

An agent here is a CLI that does the repeatable work of a task. A model plans and talks to the user. The CLI fetches, parses, filters, ranks and records.

Read [PRINCIPLES.md](PRINCIPLES.md) before you change or add an agent.

## Agents

| Agent               | Purpose                                         |
| ------------------- | ----------------------------------------------- |
| [shopper](shopper/) | Compare prices and variants across online shops |

## Layout

Each agent lives at `agents/<name>` and is named `@ai-tools/<name>`.

```
agents/<name>/
  package.json          bin <name>, scripts build, build:bin, typecheck, test
  defaults.schema.json  JSON Schema of the defaults file, generated and committed
  src/core/             engine, no I/O assumptions
  src/cli/              commander program
  src/cli.ts            entry point
  test/                 offline tests, fixtures in test/fixtures
```

Shared code lives in [`packages/agent-kit`](../packages/agent-kit/). It gives every agent the same memory paths, defaults loader, learnings journal, HTTP helper and headless browser.

## Adding an agent

1. Copy the layout above. Use `agents/shopper` as the pattern.
2. Load defaults with `loadDefaults` and a zod schema. Commit the generated JSON Schema.
3. Record what the agent learns with `appendLearning`. Apply it with `effectiveLearnings`.
4. Use `fetchText` for plain pages. Use `launchBrowser` only when a page needs a browser.
5. Support `--json` on every command that prints a result. Use exit codes `0` (ok), `1` (nothing found) and `2` (error).
6. Write tests that run offline. Inject the fetcher, the clock and the memory paths.
7. Add the tag pattern and the `tool` choice to `.github/workflows/release.yml`.

## Memory

Every agent has two places for data.

- Durable memory: `<memory dir>/<agent>/defaults.json` and `learnings.jsonl`. It can be shared and version controlled.
- Local state: `<state dir>/<agent>/learnings.jsonl` and `pending.jsonl`. It is always writable.

| Setting          | Order of precedence                                                               |
| ---------------- | --------------------------------------------------------------------------------- |
| Memory directory | `--memory-dir`, then `AGENTS_MEMORY_DIR`, then `$XDG_CONFIG_HOME/ai-tools/agents` |
| State directory  | `AGENTS_STATE_DIR`, then `$XDG_STATE_HOME/ai-tools/agents`                        |
| Defaults file    | `--defaults`, then `<AGENT>_DEFAULTS`, then the memory directory, then built-in   |

`learn flush` moves pending learnings to durable memory. If `AGENTS_MEMORY_PERSIST` is set, the CLI runs it once as a shell command. The placeholders `{agent}` and `{file}` hold the agent name and the pending file. The CLI puts them in single quotes, so do not quote them again. The environment variables `AGENTS_PERSIST_AGENT` and `AGENTS_PERSIST_FILE` hold the same values. If it is not set and the memory directory is writable, the CLI appends the lines to `learnings.jsonl`. Otherwise it exits with code `2`. Set `AGENTS_MEMORY_READONLY=1` to forbid the direct append: then only `AGENTS_MEMORY_PERSIST` can store learnings.

The flush first renames `pending.jsonl` to `pending.<pid>.<time>.flushing` and stores that file, so lines added during the flush stay for the next flush. A failed flush puts the lines back. The next flush also stores leftover `.flushing` files of crashed runs.
