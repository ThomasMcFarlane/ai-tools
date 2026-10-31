# plan-view

A Claude Code mod that previews Markdown as formatted text (headings, lists, tables, code fences) in a docked right-hand pane: the plan Claude writes in plan mode, and any `.md` file Claude mentions in a reply, on request.

## Install

```
/plugin marketplace add ThomasMcFarlane/ai-tools
/plugin install plan-view@ai-tools
```

## Behaviour

- Every assistant message that mentions existing Markdown files gets a bordered `Markdown preview` card under it, with the file name, its path and an `Open` button per file. The card stays on that message for good. Mentions are `.md` paths in the message text: absolute, `~/`, or relative (tried against the session's working directory, then its project root), bare, in backticks or in links (`file:` links too). Only files that exist are shown. `TASKS.md` is never offered, as the tasks-board mod shows it. Nothing depends on a `plans` folder or a file name.
- When Claude finishes a reply that mentions such files, the same card also appears above the prompt, with `Open`, `Dismiss`, `Dismiss all` and `List`, once per file per session. It shows one file at a time, newest first, with `Prev`, `Next` and a counter such as `2 of 3`. With one file waiting, `Prev` and `Next` stay but are dimmed and do nothing, and the counter reads `1 of 1`. `Open` opens the shown file and `Dismiss` drops it; both remove only that one from the band. `Dismiss all` empties the band; the files stay in the list.
- When Claude asks a question (`AskUserQuestion`) that names existing `.md` files in its text, headers, option labels, descriptions or previews, the first one opens in the pane at once, while the question is still open, and the rest join the band. Each file is offered once per session.
- `Open` loads the file into a docked right-hand pane titled with its first `# ` heading, else the file name.
- `List` and `/plan-view-list` toggle a second right-hand pane, `Markdown files`, listing every `.md` file suggested this session (file name, dim path, `Open`). `Open` there shows the file and drops it from the band. With none it says `No Markdown files suggested yet.`, the plan file the session reported opens or refreshes the pane by itself when Claude writes or edits it, and when it calls `ExitPlanMode`.
- A dim line at the top gives the file path and when the pane last read it.
- `/plan-view` toggles the pane for the last file shown, or says `Nothing to preview yet.` The name is `/plan-view` because `/plan` is Claude Code's own command.
- The pane body scrolls with the wheel or arrow keys. A file over 100,000 characters (the limit of one markdown drawing) is cut, with a dim note naming the file.
- The last file shown and the offers are kept in `$.state`, so a reload keeps them.

## Options

- `promptBand` (default on): offer the Markdown files Claude mentions in a band above the prompt, with Open, Dismiss, Dismiss all and List. When off, they are offered only on the message card and in the list.

## Development

```
claude plugin validate mods/plan-view
claude plugin test mods/plan-view
```
