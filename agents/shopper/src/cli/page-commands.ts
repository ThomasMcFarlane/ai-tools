import type { Command } from 'commander';
import { ShopperError, type PageSnapshot } from '../core/types.js';
import { finalise, selectorsFor } from '../core/run.js';
import { effectiveLearnings } from '@ai-tools/agent-kit';
import {
  AGENT,
  learningOptions,
  loadShopperDefaults,
  type Ctx,
  type StoreFlags,
} from './context.js';
import { formatMoney } from '../core/money.js';
import { renderHits, renderVariants } from './output.js';
import { list, parseConditions, parseNumber } from './search-commands.js';

interface ParseFlags extends StoreFlags {
  url?: string;
  file?: string;
  condition?: string;
  maxPrice?: string;
  limit?: string;
  includeOos?: boolean;
  json?: boolean;
}

function findAdapter(ctx: Ctx, id: string) {
  const adapter = ctx.deps.adapters.find((candidate) => candidate.id === id);
  if (adapter === undefined) {
    const known = ctx.deps.adapters.map((candidate) => candidate.id).join(', ');
    throw new ShopperError(`unknown site '${id}': use one of ${known}`);
  }
  return adapter;
}

function requireKind(kind: string): 'search' | 'listing' {
  if (kind !== 'search' && kind !== 'listing') {
    throw new ShopperError(`unknown page kind '${kind}': use search or listing`);
  }
  return kind;
}

export function snapshotFromText(text: string, url: string | undefined, now: Date): PageSnapshot {
  const trimmed = text.trim();
  let html = text;
  let data: unknown;
  let snapUrl = url;
  if (trimmed.startsWith('{') || trimmed.startsWith('"')) {
    let parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string' && parsed.trim().startsWith('{')) parsed = JSON.parse(parsed);
    if (typeof parsed === 'string') {
      html = parsed;
    } else if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as { html?: unknown; data?: unknown; url?: unknown };
      html = typeof record.html === 'string' ? record.html : '';
      data = record.data;
      if (snapUrl === undefined && typeof record.url === 'string') snapUrl = record.url;
    }
  }
  if (snapUrl === undefined) throw new ShopperError('give the page address with --url');
  const snap: PageSnapshot = {
    url: snapUrl,
    html,
    fetchedAt: now.toISOString(),
    mode: 'user-browser',
  };
  if (data !== undefined) snap.data = data;
  return snap;
}

export function registerPageCommands(program: Command, ctx: Ctx): void {
  const { deps } = ctx;

  program
    .command('script <site> <kind>')
    .description('print the in-page script for a site (kind: search or listing)')
    .action((site: string, kindText: string) => {
      const adapter = findAdapter(ctx, site);
      const kind = requireKind(kindText);
      const script = kind === 'search' ? adapter.searchScript : adapter.listingScript;
      if (script === undefined) throw new ShopperError(`${site} has no ${kind} script`);
      deps.print(script);
    });

  program
    .command('parse <site> <kind>')
    .description('turn a page snapshot (JSON with html, or raw HTML) into offers or a listing')
    .option('--url <url>', 'address of the page')
    .option('--file <path>', 'snapshot file (default: standard input)')
    .option('--condition <list>', 'allowed conditions')
    .option('--max-price <n>', 'drop offers above this price')
    .option('--limit <n>', 'number of offers to print')
    .option('--include-oos', 'keep out-of-stock offers')
    .option('--defaults <file>', 'defaults file')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action(async (site: string, kindText: string, flags: ParseFlags) => {
      const adapter = findAdapter(ctx, site);
      const kind = requireKind(kindText);
      const text = flags.file === undefined ? await deps.readStdin() : deps.readFile(flags.file);
      const now = deps.now();
      const snap = snapshotFromText(text, flags.url, now);
      const loaded = loadShopperDefaults(deps, flags);
      const learnings = effectiveLearnings(AGENT, learningOptions(deps, flags));
      const parseCtx = {
        selectors: selectorsFor(adapter, learnings, now),
        now: now.toISOString(),
        currency: adapter.currency,
      };
      const reason = adapter.detectBlock(snap);
      if (reason !== null) {
        throw new ShopperError(`the page is a block page: ${reason}`);
      }
      if (kind === 'listing') {
        const listing = adapter.parseListing(snap, parseCtx);
        if (flags.json === true) {
          deps.print(JSON.stringify(listing, null, 2));
        } else {
          deps.print(`${listing.title}\n${listing.url}`);
          deps.print(
            `price: ${formatMoney(listing.price)}  stock: ${listing.stock}  shop: ${listing.shop ?? '-'}`,
          );
          deps.print(renderVariants(listing.variants));
        }
        ctx.exitCode = listing.title === '' && listing.price === null ? 1 : 0;
        return;
      }
      const parsed = adapter.parseSearch(snap, parseCtx);
      const final = finalise(parsed, {
        query: '',
        defaults: loaded.value,
        ...(flags.condition === undefined ? {} : { condition: parseConditions(flags.condition) }),
        ...(flags.maxPrice === undefined
          ? {}
          : { maxPrice: parseNumber(flags.maxPrice, '--max-price') }),
        ...(flags.limit === undefined
          ? {}
          : { limit: Math.floor(parseNumber(flags.limit, '--limit')) }),
        includeOos: flags.includeOos === true,
      });
      if (flags.json === true) {
        deps.print(
          JSON.stringify(
            {
              site,
              parsed: parsed.length,
              conditionUnresolved: final.conditionUnresolved,
              hits: final.hits,
            },
            null,
            2,
          ),
        );
      } else if (final.hits.length === 0) {
        deps.print(`no offers found (${parsed.length} parsed)`);
      } else {
        deps.print(renderHits(final.hits, loaded.value.report));
      }
      ctx.exitCode = final.hits.length === 0 ? 1 : 0;
    });
}

export { list };
