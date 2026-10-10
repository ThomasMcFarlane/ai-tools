# plan-view

A Claude Code mod that shows the plan Claude writes in plan mode as formatted markdown (headings, lists, tables, code fences) in a docked right-hand pane.

## Install

```
/plugin marketplace add ThomasMcFarlane/ai-tools
/plugin install plan-view@ai-tools
```

## Behaviour

- When Claude writes or edits its plan file (a `.md` file directly in `<config dir>/plans/`, or the plan file the session reported), and when it calls `ExitPlanMode`, the pane opens or refreshes once the tool has finished. The pane is titled with the plan's first `# ` heading, else the file name.
- A dim line at the top gives the plan file path and when the pane last read it.
- `/plan-view` toggles the pane for the session's latest plan, or says `No plan yet.` The name is `/plan-view` because `/plan` is Claude Code's own command.
- The pane body scrolls with the wheel or arrow keys. A plan over 100,000 characters (the limit of one markdown drawing) is cut, with a dim note naming the file.
- The latest plan path is kept in `$.state`, so a reload keeps it.

There are no options.

## Development

```
claude plugin validate mods/plan-view
claude plugin test mods/plan-view
```
