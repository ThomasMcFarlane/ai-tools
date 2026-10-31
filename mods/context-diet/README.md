# context-diet

A Claude Code mod that cuts hook boilerplate other plugins inject over and over. It changes no plugin's files: it rewrites their hook output on its way to the model, so plugin updates do not undo it.

## Install

```
/plugin marketplace add ThomasMcFarlane/ai-tools
/plugin install context-diet@ai-tools
```

## What it does

1. **Caveman per-prompt reminder.** The caveman plugin's `UserPromptSubmit` hook adds a `CAVEMAN MODE ACTIVE (<mode>). Respond terse like smart caveman ...` reminder (about 110 tokens) to every prompt. The mod keeps it on the first prompt of a session, on the first prompt after a compaction and on every `reminderEvery` (10) prompts after that (1, 11, 21 ...), and takes it out of the others. Anything else in the hook output stays, and a prompt that switches caveman mode keeps the new ruleset and the reminder.
2. **Post-compaction SessionStart texts.** After a compaction the caveman, ponytail and superpowers `SessionStart` hooks re-inject their full texts (about 2.8k to 5k tokens together). With `shortenAfterCompact` on, each becomes a line or two naming the mode and pointing at the full skill. Startup, resume and `/clear` keep the full texts. Other hooks' output is left alone.

3. **Worker caveman text.** Caveman's `SubagentStart` hook gives every subagent worker the full ruleset (about 1.3k tokens). With `shortenWorkers` on, a worker gets two lines instead: terse, every technical fact, code, path and error exact, plain prose for warnings and irreversible steps. The main session is unchanged.

The reminder is trimmed in the `classic.UserPromptSubmit` result, so the transcript records what the model saw. Superpowers prints JSON `additionalContext`, trimmed in `classic.SessionStart`. Caveman and ponytail print plain text, which reaches the model as a `hook_success` attachment; that is rewritten in `prompt.attachment`, where the text carries `SessionStart:compact`, so the answer is the same on resume. The transcript keeps the hooks' original output there.

The count is kept per session in `$.state`. A compaction is noted from `classic.SessionStart` (source `compact`) and from `session.compact`, which also covers jev-compaction's own rewrites.

## Options

| Option | Default | Meaning |
|---|---|---|
| `reminderEvery` | 10 | Keep the caveman reminder on every this-many prompts; 1 keeps every one |
| `shortenAfterCompact` | true | Shorten the post-compaction caveman, ponytail and superpowers texts |
| `shortenWorkers` | true | Give subagent workers the two-line caveman text |

## Measured

Haiku, swap identity, `claude -p` with the mod loaded from its folder:

- Per prompt: 409 characters (about 108 tokens) of caveman reminder on every prompt before; on 2 of 12 prompts after (prompts 1 and 11).
- After `/compact`: the caveman, ponytail and superpowers texts were 10,809 characters (about 2.8k tokens); shortened they are 681 characters (about 180 tokens). The first request after the compaction fell from 23,937 to 20,350 input tokens.

## Checks

```
claude plugin validate mods/context-diet
claude plugin test mods/context-diet
```
