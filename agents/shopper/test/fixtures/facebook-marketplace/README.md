# Facebook Marketplace fixtures

Facebook needs a personal profile. The CLI never fetches the site.
The agent runs the in-page script in a tab and gets `{ url, html }` back.

Real captures, trimmed on 21 Nov 2026. Class names are stripped and the seller name is replaced:

- `search.html` is the results area of a logged-in search. It has 8 cards. Each card is an `a[href*="/marketplace/item/"]` link with an `aria-label` of the form `<badge>, <title>, <price>, reduced from <old price>, <location>, listing <id>`. It covers a badge, a reduced price, Thai titles and a title that holds a price.
- `listing.html` is an item page. It has the title in `h1`, the price and stock line, a `Condition` row and a `Listed in` location.

Synthetic fixtures. A person wrote them. No browser loaded Facebook to make them:

- `search-synthetic.html` has cards without `aria-label`. It covers a struck-out price, a `Free` item, a `Sold` item, a `Pending` item, a `THB`-prefixed price, a repeated link and a link that is not an item.
- `ineligible.html` is a page for the URL `https://www.facebook.com/marketplace/ineligible`.
- `login.html` is a minimal login page.

The ids and the synthetic titles and prices are made up.
