# iHAVECPU fixtures

These pages are real. Plain HTTP fetched them on 21 November 2026 and the search is `ddr5 32gb`.
The site is a Next.js app. Results and product data sit in the `__NEXT_DATA__` JSON block, so the adapter reads that block.

- `search.html`: search `ddr5 32gb`, page 1 with 32 of 136 results.
- `search-oos.html`: search `ddr5 64gb`, five results, two with stock `0`.
- `search-empty.html`: search with no results.
- `listing.html`: a product in stock (Kingston FURY Beast 32GB).
- `listing-oos.html`: a product with stock `0`.

Scripts (other than the data block), styles, SVG and inline images are removed.
