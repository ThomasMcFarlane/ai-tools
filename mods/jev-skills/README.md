# jev-skills

A Claude Code mod that replaces the built-in listing of every installed skill with a short list of the skills your prompt needs, picked by [Jev](https://typesafe.ai) (System One). With 120 or so skills the built-in listing costs about 10k tokens on every request; the shortlist costs a few hundred.

Skills that are not listed stay installed and callable. The Skill tool does not check names against the listing, so the model, or you with `/<name>`, can still run any skill by its exact name (checked live: with an empty shortlist the model invoked an unlisted skill without trouble).

## Install

```
/plugin marketplace add ThomasMcFarlane/ai-tools
/plugin install jev-skills@ai-tools
```

## What happens

1. **Session listing.** Claude Code builds the skill listing once per session, in the first message. The mod reads the `skill_listing` attachment (`prompt.attachment`), parses its `- name: description` lines into a roster, and asks Jev which skills your first prompt needs. The listing becomes at most `maxPicks` (5) skills scoring at least `minScore` (0.3), then one line saying that other skills exist and can be requested by name, and the names (only) of the skills left out, best Jev score first, capped at about 1k tokens. The model has no search over the hidden roster beyond that name index; it calls the Skill tool with a name from it. The index sits in the same cached listing, so it costs nothing per prompt.
2. **Later listings.** The engine sends the full listing first; later listings are mostly deltas or partial repeats. The roster only grows. A later listing that does not cover the whole roster goes through unchanged (its skills are marked as shown); only one that covers the whole roster is shortlisted afresh.
3. **Later prompts.** The listing cannot change after the first request, so each later prompt (`prompt.submit`) is judged against the skills the model has not been shown yet. Picks ride on that prompt as hidden context, at the end of the conversation. The set of shown skills only grows, and is reset by a compaction.
4. **Skipped prompts.** Slash commands, prompts under 12 characters and bare acknowledgements ("ok", "continue") are never judged. Prompts that are not yours (task notifications, peers) are ignored. Subagents keep the built-in listing.
5. **Fail open.** No key, an HTTP error, a malformed answer or a timeout leaves the built-in listing untouched (or adds nothing to the prompt) and is counted as a failure. Later prompts use `promptTimeoutMs` (3000), the first listing `jevTimeoutMs` (6000). After two failures in a row judging pauses for 30 minutes. `/clear` resets the shortlist state.

Jev sees the current prompt and your previous `recentPrompts` (3) prompts, never Claude's replies or tool output.

## Prompt-cache safety

The listing sits in the first user message, before the whole conversation. Anything that changed it between prompts would invalidate the cache for every message after it, at every turn. The engine asks for the listing once per process and keeps the answer, so the replacement is as stable as the original; the shortlist is fixed for the session.

What the mod adds later goes at the tail of the new prompt. Nothing before it changes, so the cached history stays valid. Each addition is paid for once (cache write) and then read like the rest of the history.

Measured with Haiku on a machine with 124 skills (first request of a session, input + cache creation + cache read):

| | Prompt tokens |
| --- | --- |
| built-in listing | 31,653 |
| shortlist (5 picks, without name index) | 21,783 |
| shortlist (5 picks, with name index) | 21,801 |

The listing text fell from 30,058 to 4,864 characters with the name index. The token totals include cache effects of the two runs and are only indicative; the name index adds roughly 0.6k estimated tokens.

At the usual prices (cache write 1.25 times, cache read 0.1 times the input price), a 20-request session pays for the built-in listing about 9.9k x (1.25 + 19 x 0.1) = 31k input-token equivalents. The shortlist with its name index costs about 1.2k x 3.15 = 3.8k, and five judged prompts adding up to five skills each (about 0.5k tokens, read for about half the remaining requests) cost about 5k. The net saving is about 22k, roughly three quarters.

Rewriting the listing for every prompt would be a loss even if the engine allowed it: at a context of 100k tokens, one change in the first message re-writes the whole prefix, 100k x (1.25 - 0.1) = 115k input-token equivalents, against at most 10k saved.

Jev requests are separate from this arithmetic: one request per judged prompt, about 12.5k estimated tokens for 120 skills (state, then one `noul` question per skill), well under Jev's 32k limit.

## API key

Looked for when first needed, never logged or shown, in:

1. the environment variable `JEV_COMPACTION_API_KEY`,
2. the environment variable `TYPESAFE_API_KEY`,
3. a key file: the `keyFile` option, default `$HOME/.config/ai-tools/jev-compaction.env`, with `KEY=value` lines and `#` comments (the same file as the jev-compaction mod).

## Commands

- `/jev-skills on` and `/jev-skills off` switch the mod for the running session. The listing the engine already built is not rebuilt: `off` stops further additions, `on` resumes them.
- `/jev-skills why` shows the last judgement: the prompt, the shortlist, the best scores, requests and how many skills the model can currently see.
- `/jev-skills stats` shows listings replaced (estimated tokens before and after), prompts judged, skills added, Jev requests and failures, and the skills used, of them shortlisted. Use is logged by `skill.prompt`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | true | Shortlist skills; `/jev-skills on\|off` overrides it per session |
| `maxPicks`, `minScore` | 5, 0.3 | Largest shortlist, lowest Jev probability |
| `recentPrompts` | 3 | Earlier prompts Jev sees |
| `jevTimeoutMs` | 6000 | A request is abandoned after this long (a timer, held under the hook's 10 s budget) |
| `maxRequestTokens`, `maxBatches` | 28000, 3 | Estimated ceiling of one request; more skills than fit are split into parallel requests, and past `maxBatches` only the best keyword matches are asked |
| `model`, `keyFile` | `jev-latest`, see above | Jev model, key file |

## Jev request

`POST https://api.typesafe.ai/v1/systemone` with `authorization: Bearer <key>` and `{ "model", "state", "questions" }`. The state is `{ user_request, earlier_user_requests }`; each skill is one question `{ "type": "noul", "instructions": "..." }` that names the skill and its description. The answer holds `{ "answers": { id: { "noul": 0..1 } } }`.

## Limits

- The roster is what the engine's own listings contained. When the engine trims descriptions to fit its budget, such a skill is judged by its name alone.
- A first prompt that is trivial ("hi") leaves the built-in listing in place for that session.
- Not verified: whether the engine sends the listing again after a compaction. In one live `/compact` no rewrite was logged, so the model may see only what later prompts add.
- Skills in a later listing pass through unchanged and join the roster.

## Development

No npm packages and no Node: the hook runs in the mod environment and reaches Jev with `$.http.fetch`. The scoring idea (one yes/no probability per skill, shortlisted above a floor) is ported from optim-jev, MIT licence.

```
claude plugin validate mods/jev-skills
claude plugin test mods/jev-skills
```
