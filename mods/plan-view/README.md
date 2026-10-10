# plan-view

A Claude Code mod that previews Markdown as formatted text (headings, lists, tables, code fences) in a docked right-hand pane: the plan Claude writes in plan mode, and any `.md` file Claude mentions in a reply, on request.

## Install

```
/plugin marketplace add ThomasMcFarlane/ai-tools
/plugin install plan-view@ai-tools
```

## Behaviour

- When Claude finishes a reply that mentions Markdown files, a band above the prompt asks `Preview <file>?` with `Open` and `Dismiss`. Mentions are `.md` paths in the reply text: absolute, `~/`, or relative (tried against the session's working directory, then its project root), bare, in backticks or in links (`file:` links too). Only files that exist are offered, each once per session. `TASKS.md` is never offered, as the tasks-board mod shows it. With several waiting the newest is shown with a dim `+n more`; `Open` opens that one, `Dismiss` clears them all. Nothing depends on a `plans` folder or a file name.
- `Open` loads the file into a docked right-hand pane titled with its first `# ` heading, else the file name.
- In plan mode, the plan file the session reported opens or refreshes the pane by itself when Claude writes or edits it, and when it calls `ExitPlanMode`.
- A dim line at the top gives the file path and when the pane last read it.
- `/plan-view` toggles the pane for the last file shown, or says `Nothing to preview yet.` The name is `/plan-view` because `/plan` is Claude Code's own command.
- The pane body scrolls with the wheel or arrow keys. A file over 100,000 characters (the limit of one markdown drawing) is cut, with a dim note naming the file.
- The last file shown and the offers are kept in `$.state`, so a reload keeps them.

There are no options.

## Development

```
claude plugin validate mods/plan-view
claude plugin test mods/plan-view
```
