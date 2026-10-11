# jev-compaction

A Claude Code mod that keeps long sessions inside a working band of context by compacting them again and again, guided by [Jev](https://typesafe.ai) (System One), instead of waiting for the built-in summary. On a 1M-token window it aims to keep the session between roughly 256k and 400k tokens.

Each compaction asks Jev which parts of the history still matter and then:

- **prunes tool calls**: a result Jev no longer needs is truncated to its first 300 characters plus a note; a call and its result that Jev no longer needs are both dropped. Calls and results are paired by `tool_use_id`, so a `tool_use` never loses its `tool_result` or the other way round.
- **shortens old text**: an assistant message longer than 400 characters is kept, abridged (first 600 and last 300 characters plus a `[… N chars omitted by jev-compaction …]` note) or replaced by a one-line stub, by Jev's probability. User text is never stubbed or dropped; only user text longer than 2000 characters may be abridged (first 1200 and last 600 characters).
- keeps failure lines: whenever a result is truncated or text abridged, lines in the cut part that match error words (`error`, `fail`, `exception`, `traceback`, `panic`, `denied`, `warning`, `expected`, `not found`, `exit code N`, `status 4xx/5xx` and similar), with one line of context either side, stay after the head (at most 1500 characters, original order).
- always leaves the first message and the newest six messages untouched.

No summary is written: the conversation stays real messages, only shorter.

## Install

```
/plugin marketplace add ThomasMcFarlane/ai-tools
/plugin install jev-compaction@ai-tools
```

## API key

The key is never logged or shown. It is looked for, when a compaction first needs it, in:

1. the environment variable `AIS_SESSION_COMPACTION_JEV_API_KEY`,
2. the environment variable `TYPESAFE_API_KEY`,
3. a key file: the `keyFile` option, default `$HOME/.config/ai-tools/jev-compaction.env`, with `KEY=value` lines and `#` comments. `AIS_SESSION_COMPACTION_JEV_API_KEY` is taken first, else `TYPESAFE_API_KEY`; an empty value counts as missing.

```
# ~/.config/ai-tools/jev-compaction.env
AIS_SESSION_COMPACTION_JEV_API_KEY=your-key-here
```

Without a key a compaction is deferred (periodic) or left to the built-in summary (`auto`, `/compact`).

## Behaviour

- **Periodic trigger.** After each main turn (`session.measure`) the mod checks the context. At or above the trigger it calls `$.session.compact()`. After a deferred or below-target attempt it waits until the context has grown by 25000 tokens (the regrowth guard), and forgets the attempt once the context falls below the trigger.
- **Thresholds.** Windows above 300k tokens use `triggerTokens` 400000, `targetTokens` 256000 and `hardTokens` 500000. Smaller windows use percentages of the window: `triggerPercent` 60, `targetPercent` 40, `hardPercent` 85.
- **Policy.** The size after is estimated as tokens before times characters after over characters before.
  - Periodic (soft): applied when the estimate is at or below the target, or frees at least `minFreedTokens` (20000). Otherwise the compaction is deferred and the scores are kept. At or above the hard limit a compaction that cannot do that falls back to the built-in summary.
  - `auto` (the engine near its limit): applied when the estimate is below the hard limit, else the built-in summary.
  - `/compact` (manual): applied when it frees at least `minFreedTokens`, else the built-in summary.
  - A Jev error, a missing key or a history that cannot be fitted defers a periodic compaction and falls back to the built-in summary for `auto` and `/compact`. Work is never blocked.
  - Subagents and `precompute` are left alone.
- **Score memory.** Jev's probabilities are kept per session in `$.state`, keyed by a fingerprint of the tool and its input (for text: role and a hash of the text). A remembered score is reused unless it lies within 0.15 of a threshold it matters for.
- **Reporting.** Every outcome is shown as a toast and a log line: sizes before and after, kept, truncated, dropped, abridged and stubbed counts and the number of Jev requests; or the reason for a deferral or fallback.

## Commands

- `/jev-compact now` compacts now with the `/compact` policy, but never falls back to the built-in summary: if it frees too little it says so and leaves the conversation as it is.
- `/jev-compact stats` shows the session totals: compactions applied, deferred and handed to the built-in summary, estimated tokens freed and Jev requests.

## Options

All options have defaults and are set in the plugin's config menu.

| Option                                                             | Default                              | Meaning                                                     |
| ------------------------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------- |
| `triggerTokens`, `targetTokens`, `hardTokens`                      | 400000, 256000, 500000               | Thresholds for windows above 300k tokens                    |
| `triggerPercent`, `targetPercent`, `hardPercent`                   | 60, 40, 85                           | Thresholds for smaller windows                              |
| `minFreedTokens`                                                   | 20000                                | A compaction freeing this much is applied even above target |
| `regrowthTokens`                                                   | 25000                                | Growth needed before a new attempt                          |
| `keepThreshold`, `abridgeThreshold`                                | 0.5, 0.2                             | Jev probabilities for keep and abridge                      |
| `preserveRecentMessages`                                           | 6                                    | Newest messages never touched                               |
| `maxStateTokens`, `maxRequestTokens`                               | 25000, 30000                         | Estimated size of the state and of one Jev request          |
| `truncateHeadChars`                                                | 300                                  | Characters of a truncated tool result kept                  |
| `model`, `keyFile`, `goal`                                         | `jev-latest`, see above, last prompts | Jev model, key file, ongoing-task description               |

## Jev request

One `POST https://api.typesafe.ai/v1/systemone` per batch of questions, with `authorization: Bearer <key>` and a JSON body `{ "model", "state", "questions" }`. The `state` is the whole history (tool results replaced by a note, long text abridged to fit `maxStateTokens`); each question is `{ "type": "noul", "instructions": "..." }`, two per tool call (`call_tN`, `result_tN`) and one per long message (`text_mN`). The response holds `answers`, each `{ "noul": 0..1 }`.

## Development

The library is a port of fast-jev-compaction (state fitting, batching, decisions), extended to message text, with the score memory and levels of the optim-jev compacter. It uses no npm packages and no Node: the hook runs in the mod environment and reaches Jev with `$.http.fetch`.

```
claude plugin validate mods/jev-compaction
claude plugin test mods/jev-compaction
```

## Licence and attribution

The ported parts derive from fast-jev-compaction, MIT licence, Copyright (c) 2025:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
