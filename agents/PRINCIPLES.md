# Agent principles

These rules apply to every agent in this repository and to the skills that drive them.

## Deterministic first

Agents prefer scripted, testable tools over model reasoning.

- The CLI fetches, parses, filters, ranks and records.
- The model plans, picks queries, judges relevance and talks to the user.
- Every result that an agent reports comes from a CLI output that it saw in this run.
- Never invent a price, a stock level, a link or a variant.
- Parsing code is pure. It takes a snapshot and returns data. Tests run it on saved pages.

## Shared memory

- Defaults are data in a file. They are not hard-coded in a skill.
- The CLI validates the defaults file with a schema. An invalid file stops the run with exit code `2`.
- Learnings are append-only JSON lines. Each line has a kind, a site, a key, a value, an optional expiry and the evidence.
- The CLI applies learnings when it runs. A block learning expires after 24 hours.
- Selectors are data. A learning can replace a selector without a code change.
- Record a learning only when a deterministic check shows the fact.

## Browser safety

- Never open a tab or navigate in the browser of the user.
- The CLI starts its own headless browser with its own profile, and closes it at the end of the run. Each run uses its own temporary profile folder, so two runs at once never collide. The kit deletes the folder at the end and removes stale ones of dead runs. It limits the memory of that browser when the system allows it, unless the CLI already runs inside a systemd service. If the CLI gets SIGINT or SIGTERM, or exits, the kit kills the browser and deletes the profile folder.
- A site that needs the login of the user has the fetch mode `user-browser`. The CLI never fetches it.
- For such a site, ask the user first. Then run the in-page script in a tab that the user already has open. Pass the result to the CLI parse command. Report only what the parse command prints.
- Never type a password or solve a captcha. Do not defeat a challenge or a block with tricks. A plain browser identity (a normal user agent) is allowed. Record the block and use the next method.

## Reporting

- Show the source site and the link for each result.
- Say plainly which sites you skipped and why.
- Report failures as failures.
