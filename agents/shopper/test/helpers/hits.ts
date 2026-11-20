import type { SearchHit } from '../../src/core/types.js';

export function hit(partial: Partial<SearchHit> & { site?: string }): SearchHit {
  return {
    site: 'a',
    title: 'Item',
    url: `https://example.com/${partial.title ?? 'item'}`,
    price: { amount: 100, currency: 'THB' },
    condition: 'new',
    stock: 'in_stock',
    seenAt: '2026-11-21T00:00:00.000Z',
    ...partial,
  };
}
