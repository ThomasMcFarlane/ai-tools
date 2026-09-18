# AGENTS.md

Guidance for AI coding agents contributing to this repository.

## Repo map

```
ai-tools/
├── tools/
│   ├── dns-checker/   # @ai-tools/dns-checker: DNS lookup/check/wait/watch CLI + MCP server
│   └── gh-watcher/    # @ai-tools/gh-watcher: GitHub Actions status/wait/watch CLI
├── packages/
│   └── hooks/         # @ai-tools/hooks: shared exec/webhook/file/notify hook library
├── skills/            # installable skills/prompts for AI platforms (see skills/README.md)
└── .github/           # CI workflows
```

Tool source layout (both tools): `src/core/` (engine and stores), `src/cli/` (commander program), `src/mcp/` (dns-checker only, MCP server). Tests live in `test/` and run offline with injected dependencies.

## Commands

```sh
npm install                                   # all workspaces
npm run build                                 # build all workspaces
npm run build -w @ai-tools/dns-checker        # build one workspace
npm run typecheck                             # tsc --noEmit per workspace
npm run test                                  # vitest run per workspace
npm run lint                                  # eslint .
npm run format                                # prettier --write .
```

## Conventions

- TypeScript, strict mode, ESM with NodeNext module resolution.
- eslint (typescript-eslint recommended) + prettier. Both must pass before you finish.
- Tests use vitest and must run offline: inject lookups, `gh` clients, clocks and hook firers instead of performing real DNS or GitHub calls.
- Commits follow Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- Prose, comments and commit messages use British English.
- No personal information anywhere in code or docs: use example.com, example.org and octo-org/hello-world in every example.
- No code comments unless essential.
- Exit code conventions for both CLIs: `0` success or match, `1` no match or not found, `2` error, `124` timeout.
- Every result-printing command supports `--json`.
- Watcher state belongs under `ai-tools/<name>` in the XDG state directory, overridable via `AI_TOOLS_<NAME>_STATE_DIR`.
- Before touching a tool, read that tool's documentation: `tools/dns-checker/` and `tools/gh-watcher/` follow the patterns described in the root README ("Adding a tool"), and the CLI surface is the contract. Verify flags against `node tools/<tool>/dist/cli.js <command> --help` rather than guessing.
