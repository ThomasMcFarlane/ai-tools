# Banana IT fixtures

`blocked.html` is a real page. It is the Cloudflare challenge that `https://www.bnn.in.th/en/p?q=ddr5%2032gb` returned on 21 November 2026.
Plain HTTP got status 403 with `cf-mitigated: challenge`. The project headless browser stayed on the same page for 20 seconds.
Scripts and styles are removed from the file.

No result page or product page is saved. The site did not give one to an automated client, and the project never works around a block.
The selectors in `src/core/adapters/bnn.ts` are therefore not checked against real result markup.
Replace them with data from a real capture before you trust the parser.

## Mode

The adapter uses the `user-browser` mode. The CLI never fetches the site.
On 21 November 2026 the project headless browser still got the challenge after the user agent said `Chrome` instead of `HeadlessChrome`.
The agent runs `shopper script bnn search` in a tab that the user already has open. Then it passes the result to `shopper parse bnn search`.
