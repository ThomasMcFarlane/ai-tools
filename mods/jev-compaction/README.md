# jev-compaction

A Claude Code mod that keeps long sessions inside a working band of context by compacting them again and again, guided by [Jev](https://typesafe.ai) (System One), instead of waiting for the built-in summary. On a 1M-token window it aims to keep the session between roughly 256k and 400k tokens.

Each compaction asks Jev which parts of the history still matter and then:

- **prunes tool calls**: a result Jev no longer needs is truncated to its first 300 characters plus a note; a call and its result that Jev no longer needs are both dropped. Calls and results are paired by `tool_use_id`, so a `tool_use` never loses its `tool_result` or the other way round.
- **shortens old text**: an assistant message longer than 400 characters is kept, abridged (first 600 and last 300 characters plus a `[… N chars omitted by jev-compaction …]` note) or replaced by a one-line stub, by Jev's probability. User text is never stubbed or dropped; only user text longer than 2000 characters may be abridged (first 1200 and last 600 characters).
- **compresses old text** (`textCompression`, on by default): inside a compaction, and so with no extra prompt-cache cost, old unpinned text loses padding. Long assistant messages (over 600 characters) that Jev kept or abridged are split into sentences and bullet lines, Jev rates each (`this sentence carries information still needed (a fact, decision, result, constraint, path, command or next step), not padding, a recap or a pleasantry`), and sentences below `sentenceKeepThreshold` (0.35) are dropped, never more than `maxSentenceDropRatio` (70%) of a message, highest scorers kept. A message that lost sentences ends with `[… N sentences omitted by jev-compaction …]`, which also stops it being cut again. Assistant text then gets a deterministic word filter (below). User text keeps its words verbatim inside a compaction: no word filter, never stubbed, no sentence lost; only text longer than 2000 characters may be abridged.
- keeps failure lines: whenever a result is truncated or text abridged, lines in the cut part that match error words (`error`, `fail`, `exception`, `traceback`, `panic`, `denied`, `warning`, `expected`, `not found`, `exit code N`, `status 4xx/5xx` and similar), with one line of context either side, stay after the head (at most 1500 characters, original order).
- never rebuilds a message that holds images or documents, never drops the call of a mutating tool (`Edit`, `Write`, `NotebookEdit`, `MultiEdit`, `mcp__*` write/edit/create/delete/update tools; only their results are truncated), leaves a short `[jev dropped <tool>: <start of the input>…]` note (Bash: the command; other tools: the path, pattern, URL, query or prompt; at most 80 characters, `…` only when cut) for any other dropped call (several calls dropped from one message, or from a run of adjacent messages left holding only notes, share one `[jev dropped N calls: Bash ×3, Read ×1]` note), recognising the older `[jev-compaction dropped <tool> call: …; re-run if needed]` form too, and never cuts text it has already marked.
- always leaves the first message and the newest six messages untouched.

No summary is written: the conversation stays real messages, only shorter.

### Word filter

A pure function (`hooks/squeeze.ts`, no Jev). On assistant text it removes a few pleasantries and hedges (`Great question`, `Hope this helps`, `Thanks for waiting`, `it is worth noting that`, `basically`, `actually`, `simply`, `really` and similar), turns `in order to` into `to`, drops a whole sentence that is only `Let me know if you have any questions` or `Feel free to ask ...` (never across a comma or conjunction), drops the lowercase articles `a`, `an` and `the` in plain English prose lines (not before a capitalised word, a single letter or another article, so names and labels survive) and collapses repeated whitespace and blank lines. `let me`, `sure`, `I'd be happy to` and `just` are never removed. On **user text** (only on entry, with `entryUser`; never inside a compaction) nothing is removed: only articles in plain prose and whitespace. It never touches fenced code (a fence closes only on a bare line of the same character, at least as long as the opener), indented code, diff hunks, `$ ` shell lines, `key: value` and `"key":` lines, stack frames, inline code, paths, URLs, tokens with digits (numbers with units), quoted strings, markdown tables, lines matching the failure words, or the mod's own notes. English is judged per paragraph and per line; other languages are left unchanged, and so is text with CRLF line ends. A negation (`not`, `never`, `no`, `only`, `except`, `without`, `n't` and the like) is never removed, and a hedge next to one stays; if the negation count would change, or the text would become empty, the original is returned. Running it twice changes nothing more.

Sentence splitting treats code, URLs, paths, quoted strings, failure lines, questions, tables, headings, numbered steps and any sentence with a negation or `must`, `should`, `never`, `always`, `required`, `do not` or `don't` as atomic: kept, never asked about, never dropped. The compaction's sentence note stands where the first sentence was cut.

### Compression on entry

The same rules can run as a row enters the transcript (`session.append`, switch `compressOnEntry`). The stored row is the only form the model ever reads and the cache ever holds, so this costs no cache miss. The screen shows the compressed row; there is no way to keep the typed or generated text on display. Rows that can be rewritten: text blocks of the person's own prompts (door `prompt`, origin the composer or bridge, not the SDK), of the model's response (door `response`) and the text of tool results (door `tool-result`). Nothing else is touched (commands, notices, reminders, subagent rows, thinking and tool-use blocks, rows with media). Entry has its own note, `[… N sentences cut on entry …]` or `[… N chars cut on entry …]`, which the compaction does not treat as already compacted, so a later compaction may still judge and cut such a row.

- **Tool results** (`entryToolResults`, **on by default**): only the output of a Bash command that matches the allowlist `entryTrimCommands` (default: `npm|pnpm|yarn|bun test|install|ci|add|run build|test|lint`, `pytest` (not `--collect-only`), `pip install`, `go test` (not `-list`), `cargo build|test`, `make` with no target or `build|test|check|lint|install|all|ci`, `mvn test|verify|package|install|compile`, `gradle build|test|check|assemble`, `tsc` (not `--showConfig`/`--listFiles`), `eslint`; log readers such as `docker logs` and `journalctl` are not trimmed) and is longer than `entryResultMinChars` (12000). The command is read from the matching tool call. Readers and filters (`cat`, `sed`, `head`, `git diff|show|log|grep|blame` with any global options, `rg`, `grep`, `find` and similar) are never trimmed, nor is a command with a later pipe stage that is a filter, a subshell, backticks or `xargs`, or a chain holding any step other than an allowlisted command, `cd` or `export`. The size is checked before the command is looked up, nor is any other tool (`Read`, `Grep`, `Glob`, agents, `mcp__*`). The output is cut into about 1200-character chunks (at most 60); the first and last stay, one Jev request rates the others (several text blocks one after another), and a dropped run keeps its failure lines with a line of context either side and leaves one note.
- **User prompts** (`entryUser`, **off by default**): articles and whitespace only.
- **Assistant text** (`entryAssistant`, **off by default**): word filter, then, above 600 characters, one Jev request per message for the sentence questions.

One timeout, `entryTimeoutMs` (3000), bounds the whole rewrite of a row (key lookup, reading the conversation and the request). After any failure or timeout entry makes no Jev request for 30 minutes (word filtering goes on), a 401 or 403 forgets the cached key, and the row always enters as it came when anything fails. Characters saved on entry are in `/jev-compact stats`.

### What is sent to Jev

Only to `api.typesafe.ai`, with your Jev key. In a compaction: the whole history as a state (tool results replaced by a note, long text abridged to fit the state ceiling), your goal, and one question per candidate (including up to 40 sentences per long assistant message). On entry: the last six messages (each cut to 500 characters) plus the new text (cut to 6000 characters), and the questions about it; for prompts nothing is sent; for tool results, chunk excerpts. Pre-scoring sends the same as a compaction ahead of time. Before every request all strings are passed through a masking step that replaces `KEY=`/`TOKEN=`/`SECRET=`/`PASSWORD=` values, `Bearer ...`, JWTs, `sk-...`, `ghp_...` and `github_pat_...` tokens, AWS `AKIA...` ids, `xox...` tokens, PEM blocks and `-----BEGIN` lines, and credentials in URLs, `Authorization: Basic`, `Cookie` and `Set-Cookie` headers, Stripe, Google, GitLab, npm and Hugging Face token prefixes, names containing `pwd` or `pass`, `--password`, `mysql -p…`, `curl -u`, base64 values in Kubernetes Secret YAML, and any standalone base64 or hex blob of 40 characters or more that holds a digit and a letter, with `***`. The masking is pattern based and not a guarantee; do not rely on it for secrets of other shapes. The stored conversation is not masked.

## Install

```
/plugin marketplace add ThomasMcFarlane/ai-tools
/plugin install jev-compaction@ai-tools
```

## API key

The key is never logged or shown. It is looked for, when a compaction first needs it, in:

1. the environment variable `JEV_COMPACTION_API_KEY`,
2. the environment variable `TYPESAFE_API_KEY`,
3. a key file: the `keyFile` option, default `$HOME/.config/ai-tools/jev-compaction.env`, with `KEY=value` lines and `#` comments. `JEV_COMPACTION_API_KEY` is taken first, else `TYPESAFE_API_KEY`; an empty value counts as missing.

```
# ~/.config/ai-tools/jev-compaction.env
JEV_COMPACTION_API_KEY=your-key-here
```

Without a key a compaction is deferred (periodic) or left to the built-in summary (`auto`, `/compact`).

## Behaviour

- **Periodic trigger.** When a main turn ends (`turn.complete`; `session.measure` fires while the turn still runs, where the host refuses `$.session.compact()`) the mod checks the context. At or above the trigger it calls `$.session.compact()`. After an attempt it waits until the context has grown by `regrowTokens` (50000) beyond it, and forgets the attempt only when the context falls below the target. At or above the hard limit the wait does not apply: every turn end attempts, so a session stuck above the limit is compacted at its next turn end. It does not work in headless (`-p`) sessions, where the host offers no `$.session.compact()`.
- **Pre-scoring.** From `prescoreMarginTokens` (100000) below the trigger on, each finished turn that ended in an answer asks Jev about up to `prescoreBatches` (4) batches of still-unscored tool calls and texts and remembers the answers, so the compaction at the trigger mostly reuses scores. A realistic 1500-message, 600-call transcript needs about 9 batches (about 3 rounds of 4) at the default 25000-token state ceiling.
- **Pre-scoring cost.** It runs after the turn has been handed on (a timer, not in the turn's way), only once the context has grown `prescoreEveryTokens` (20000) since the last one and at least `prescoreMinQuestions` (60, about a batch) questions are unscored. Whether the session is interactive is kept in `$.state`, so a hot reload keeps it; headless sessions are left alone and `/jev-compact now` says so.
- **Large histories.** When the history does not fit one state, Jev sees the oldest part and the pinned ends; the newest unpinned part is not judged and stays. A transcript of 4096 messages or more (the host's cap) defers periodic compactions below the hard limit (at or above it, the built-in summary runs) and is left to the built-in summary for `auto` and `/compact`.
- **Time limits.** Each Jev request is abandoned after `jevTimeoutMs` (8000), using a timer rather than a wait so it does not count against the hook's time budget. A timed-out request cannot be cancelled: the fetch is left behind and its late answer is ignored (no lingering-hook report appeared in a live run). A failed or timed-out batch only leaves its items unscored; the other batches' scores are kept and used, and no round starts that could not finish inside `jevTotalMs` (20000).
- **Thresholds.** Windows above 300k tokens use `triggerTokens` 400000, `targetTokens` 256000 and `hardTokens` 500000. Smaller windows use percentages of the window: `triggerPercent` 60, `targetPercent` 40, `hardPercent` 85.
- **Policy.** The size after is estimated as tokens before times characters after over characters before.
  - Periodic (soft): applied when the estimate is at or below the target, or frees at least `softMinFreedTokens` (100000 on windows above 300k, else `softMinFreedPercent` of the window, 25), because every rewrite costs a prompt-cache miss. Otherwise the compaction is deferred and the scores are kept. Below the hard limit that is all. **The hard limit is a ceiling:** at or above it (`hardTokens`, or `hardPercent` on small windows) a periodic result is applied only if its estimate ends below the hard limit (at or below the target is preferred); the gain test above does not apply there. Otherwise the mod's compaction hook returns to the built-in summary, which runs in that same compaction. A deferral never happens at or above the hard limit.
  - `auto` (the engine near its limit): applied when the estimate is below the hard limit and frees at least `minFreedTokens` (20000), else the built-in summary.
  - `/compact` (manual): applied when it frees at least `minFreedTokens` (and, at or above the hard limit, ends below it), else the built-in summary. `/compact <instructions>` always goes to the built-in summary, as does a transcript of 4096 messages or more (it may be cut).
  - A Jev error, a missing key or a history that cannot be fitted defers a periodic compaction below the hard limit, and falls back to the built-in summary at or above it and for `auto` and `/compact`. Work is never blocked.
  - Subagents and `precompute` are left alone.
- **Score memory.** Jev's probabilities are kept per session in `$.state`, keyed by a fingerprint of the tool and its input (for text: role and a hash of the text). A remembered score is reused unless it lies within 0.15 of a threshold it matters for.
- **Reporting.** Every outcome is shown as a toast and a log line: sizes before and after, kept, truncated, dropped, abridged and stubbed counts, sentences dropped, characters saved by word compression and the number of Jev requests; or the reason for a deferral or fallback.

## Commands

- `/jev-compact now` compacts when your next turn ends (the host refuses it inside a command), with the `/compact` policy. Below the hard limit it never falls back to the built-in summary: if it frees too little it defers and leaves the conversation as it is. At or above the hard limit, when its result would still end at or above it, it falls back to the built-in summary.
- `/jev-compact stats` shows the session totals: compactions applied, deferred and handed to the built-in summary, estimated tokens freed, Jev requests, sentences dropped, characters saved by word compression and characters saved on entry.

## Options

All options have defaults and are set in the plugin's config menu.

| Option                                                             | Default                              | Meaning                                                     |
| ------------------------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------- |
| `triggerTokens`, `targetTokens`, `hardTokens`                      | 400000, 256000, 500000               | Thresholds for windows above 300k tokens                    |
| `triggerPercent`, `targetPercent`, `hardPercent`                   | 60, 40, 85                           | Thresholds for smaller windows                              |
| `minFreedTokens`                                                   | 20000                                | A compaction freeing this much is applied even above target |
| `softMinFreedTokens`, `softMinFreedPercent`                        | 100000, 25                           | Minimum freed by a periodic compaction that misses the target |
| `regrowTokens`                                                     | 50000                                | Growth needed before a new attempt                          |
| `prescoreMarginTokens`, `prescoreBatches`                          | 100000, 4                            | Pre-scoring window below the trigger and batches per turn   |
| `prescoreEveryTokens`, `prescoreMinQuestions`                      | 20000, 60                            | Growth between pre-scores; questions needed to start one    |
| `jevTimeoutMs`, `jevTotalMs`                                       | 8000, 20000                          | Per request and per compaction (also held under the hook budget) |
| `keepThreshold`, `abridgeThreshold`                                | 0.5, 0.2                             | Jev probabilities for keep and abridge                      |
| `preserveRecentMessages`                                           | 6                                    | Newest messages never touched                               |
| `maxStateTokens`, `maxRequestTokens`                               | 25000, 30000                         | Estimated size of the state and of one Jev request          |
| `truncateHeadChars`                                                | 300                                  | Characters of a truncated tool result kept                  |
| `textCompression`                                                  | true                                 | Compress old text in a compaction (word filter, sentence drops) |
| `sentenceKeepThreshold`, `maxSentenceDropRatio`                    | 0.35, 0.7                            | Sentences below the threshold are dropped, at most this share of a message |
| `compressOnEntry`, `entryUser`, `entryAssistant`, `entryToolResults` | true, false, false, true           | Compress rows as they enter the transcript, and per kind    |
| `entryTimeoutMs`, `entryResultMinChars`                            | 3000, 12000                          | Jev timeout on entry; tool output size from which it is trimmed |
| `entryTrimCommands`                                                | build, test, install and log runners | Regular expression for Bash commands whose output may be trimmed |
| `model`, `keyFile`, `goal`                                         | `jev-latest`, see above, last prompts | Jev model, key file, ongoing-task description               |

## Jev request

One `POST https://api.typesafe.ai/v1/systemone` per batch of questions, with `authorization: Bearer <key>` and a JSON body `{ "model", "state", "questions" }`. The `state` is the whole history (tool results replaced by a note, long text abridged to fit `maxStateTokens`); each question is `{ "type": "noul", "instructions": "..." }`, two per tool call (`call_tN`, `result_tN`), one per long message (`text_mN`) and, for a long assistant message Jev kept or abridged, one per sentence worth asking about (`sent_mN_sK`; at most 40 per message, none for a message of fewer than three sentences). Sentence questions follow the text questions in a second phase, share the score memory (keyed by the sentence's hash), batching, time budget and pre-scoring, and a failed batch leaves its sentences kept. The response holds `answers`, each `{ "noul": 0..1 }`.

## Development

The library is a port of fast-jev-compaction (state fitting, batching, decisions), extended to message text, with the score memory and levels of the optim-jev compacter. It uses no npm packages and no Node: the hook runs in the mod environment and reaches Jev with `$.http.fetch`.

```
claude plugin validate mods/jev-compaction
claude plugin test mods/jev-compaction
```

## Licence and attribution

The ported parts derive from fast-jev-compaction, MIT licence, Copyright (c) 2025:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
