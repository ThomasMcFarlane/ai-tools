import { advice } from './adapters/advice.js';
import { aliexpress } from './adapters/aliexpress.js';
import { bnn } from './adapters/bnn.js';
import { facebookMarketplace } from './adapters/facebook-marketplace.js';
import { ihavecpu } from './adapters/ihavecpu.js';
import { jib } from './adapters/jib.js';
import { lazadaTh } from './adapters/lazada-th.js';
import { shopeeTh } from './adapters/shopee-th.js';
import type { SiteAdapter } from './types.js';

export const ADAPTERS: readonly SiteAdapter[] = [
  lazadaTh,
  aliexpress,
  jib,
  advice,
  ihavecpu,
  bnn,
  shopeeTh,
  facebookMarketplace,
];

export function listAdapters(): SiteAdapter[] {
  return [...ADAPTERS];
}

export function getAdapter(
  id: string,
  adapters: readonly SiteAdapter[] = ADAPTERS,
): SiteAdapter | null {
  return adapters.find((adapter) => adapter.id === id) ?? null;
}

export function adapterForUrl(
  url: string,
  adapters: readonly SiteAdapter[] = ADAPTERS,
): SiteAdapter | null {
  return adapters.find((adapter) => adapter.matchesUrl(url)) ?? null;
}
