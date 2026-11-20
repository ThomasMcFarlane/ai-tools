# Shopee Thailand fixtures

These fixtures are synthetic. A person wrote them. No browser loaded Shopee to make them.

Shopee blocks headless browsers and logged-out sessions. It sends them to `/verify/traffic/error`. The CLI never fetches the site.
The agent runs the in-page script in a tab that the user already has open. The script returns `{ url, html }` for the results area.

- `search.html` imitates the markup that the script returns. It has item links of the form `a[href*="-i.<shopid>.<itemid>"]`, a title, a price, a sold count and a location.
  It covers a single price, a price range, `k` and `พัน` sold counts, a Thai title, a duplicate link and a link that is not an item.
- `verify.html` is a minimal page for the block URL `https://shopee.co.th/verify/traffic/error`.
- `captcha.html` is a minimal captcha page.

The ids, titles and prices are made up. Check the selectors in `src/core/adapters/shopee-th.ts` against a real snapshot when one exists.
