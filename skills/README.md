# skills

Copy-paste skills and prompt files that teach AI platforms how to use the CLIs in this repo.

The tools work from any agent that can run shell commands. The files here add platform-specific entry points on top. The CLI commands the skills invoke work the same whether the tools are installed as release binaries or run from a source checkout.

## Install matrix

| Platform    | File(s) below                                                                                                                                | Install path                                                                       | How invoked                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Claude Code | `claude-code/dns-checker/SKILL.md`, `claude-code/gh-watcher/SKILL.md`, `claude-code/repo-ready/SKILL.md`, `claude-code/tasks-board/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` (or `<project>/.claude/skills/<name>/SKILL.md`) | Automatically when relevant, or `/dns-checker`, `/gh-watcher`, `/repo-ready`, `/tasks-board` |
| Codex CLI   | `codex/dns-checker.md`, `codex/gh-watcher.md`, `codex/repo-ready.md`                                                                         | `~/.codex/prompts/<name>.md`                                                       | `/dns-checker`, `/gh-watcher`, `/repo-ready`                                                 |
| opencode    | `opencode/dns-checker.md`, `opencode/gh-watcher.md`, `opencode/repo-ready.md`                                                                | `~/.config/opencode/command/<name>.md`                                             | `/dns-checker`, `/gh-watcher`, `/repo-ready`                                                 |
| Gemini CLI  | `generic/AGENTS.md.snippet.md`                                                                                                               | Paste the section into `GEMINI.md`                                                 | Always in context                                                                            |
| Cursor      | `generic/AGENTS.md.snippet.md`                                                                                                               | Paste the section into `.cursor/rules`                                             | Always in context                                                                            |
| Any agent   | `generic/AGENTS.md.snippet.md`                                                                                                               | Paste into your harness instructions file (`AGENTS.md`, `CONVENTIONS.md`, ...)     | Always in context                                                                            |

## Install examples

Claude Code:

```sh
mkdir -p ~/.claude/skills/dns-checker ~/.claude/skills/gh-watcher ~/.claude/skills/repo-ready
cp <repo>/skills/claude-code/dns-checker/SKILL.md ~/.claude/skills/dns-checker/SKILL.md
cp <repo>/skills/claude-code/gh-watcher/SKILL.md ~/.claude/skills/gh-watcher/SKILL.md
cp <repo>/skills/claude-code/repo-ready/SKILL.md ~/.claude/skills/repo-ready/SKILL.md
```

Codex CLI:

```sh
mkdir -p ~/.codex/prompts
cp <repo>/skills/codex/dns-checker.md ~/.codex/prompts/dns-checker.md
cp <repo>/skills/codex/gh-watcher.md ~/.codex/prompts/gh-watcher.md
cp <repo>/skills/codex/repo-ready.md ~/.codex/prompts/repo-ready.md
```

opencode:

```sh
mkdir -p ~/.config/opencode/command
cp <repo>/skills/opencode/dns-checker.md ~/.config/opencode/command/dns-checker.md
cp <repo>/skills/opencode/gh-watcher.md ~/.config/opencode/command/gh-watcher.md
cp <repo>/skills/opencode/repo-ready.md ~/.config/opencode/command/repo-ready.md
```

Gemini CLI / Cursor / generic: open `generic/AGENTS.md.snippet.md` and paste the whole section into your instructions file.

Replace `<repo>` with the absolute path of your checkout. If running from source rather than an installed release binary, build first so the compiled CLI files exist:

```sh
npm install && npm run build -w @ai-tools/dns-checker -w @ai-tools/gh-watcher -w @ai-tools/repo-ready
```
