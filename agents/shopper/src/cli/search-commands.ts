import type { Command } from 'commander';
import { DefaultsError } from '@ai-tools/agent-kit';
import { runListing, runSearch, BlockedError } from '../core/run.js';
import { NothingFoundError, ShopperError, CONDITIONS, type Condition } from '../core/types.js';
import { UserBrowserRequiredError } from '../core/fetcher.js';
import { formatMoney } from '../core/money.js';
import { adapterForUrl } from '../core/registry.js';
import { buildRunDeps, loadShopperDefaults, type Ctx, type StoreFlags } from './context.js';
import { renderHits, renderVariants } from './output.js';

export function list(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

export function parseConditions(value: string): Condition[] {
  const parts = list(value);
  for (const part of parts) {
    if (!(CONDITIONS as readonly string[]).includes(part)) {
      throw new ShopperError(`unknown condition '${part}': use ${CONDITIONS.join(', ')}`);
    }
  }
  return parts as Condition[];
}

export function parseNumber(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new ShopperError(`${name} must be a positive number`);
  return number;
}

interface SearchFlags extends StoreFlags {
  sites?: string;
  condition?: string;
  maxPrice?: string;
  limit?: string;
  includeOos?: boolean;
  json?: boolean;
}

export function registerSearchCommands(program: Command, ctx: Ctx): void {
  program
    .command('search <query...>')
    .description('search the shops and print ranked offers')
    .option('--sites <ids>', 'comma-separated site ids (default: from defaults)')
    .option('--condition <list>', 'allowed conditions: new, used, refurbished, unknown')
    .option('--max-price <n>', 'drop offers above this price')
    .option('--limit <n>', 'number of offers to print')
    .option('--include-oos', 'keep out-of-stock offers')
    .option('--defaults <file>', 'defaults file (overrides SHOPPER_DEFAULTS and memory)')
    .option('--memory-dir <dir>', 'memory directory (overrides AGENTS_MEMORY_DIR)')
    .option('--json', 'print JSON')
    .action(async (words: string[], flags: SearchFlags) => {
      const { deps } = ctx;
      const loaded = loadShopperDefaults(deps, flags);
      const runDeps = buildRunDeps(deps, flags);
      const query = words.join(' ').trim();
      const sites = flags.sites === undefined ? undefined : list(flags.sites);
      try {
        const output = await runSearch(
          {
            query,
            defaults: loaded.value,
            defaultsSource: loaded.source,
            warnings: loaded.warnings,
            ...(sites === undefined ? {} : { sites }),
            ...(flags.condition === undefined
              ? {}
              : { condition: parseConditions(flags.condition) }),
            ...(flags.maxPrice === undefined
              ? {}
              : { maxPrice: parseNumber(flags.maxPrice, '--max-price') }),
            ...(flags.limit === undefined
              ? {}
              : { limit: Math.floor(parseNumber(flags.limit, '--limit')) }),
            includeOos: flags.includeOos === true,
          },
          runDeps,
        );
        if (flags.json === true) {
          deps.print(JSON.stringify(output, null, 2));
        } else {
          printSearch(ctx, output, loaded.value.report);
        }
        ctx.exitCode = output.hits.length === 0 ? 1 : 0;
      } finally {
        await runDeps.fetcher.close();
      }
    });

  program
    .command('listing <url>')
    .description('read one product page and print its variants and prices')
    .option('--defaults <file>', 'defaults file')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action(async (url: string, flags: SearchFlags) => {
      const { deps } = ctx;
      const loaded = loadShopperDefaults(deps, flags);
      const runDeps = buildRunDeps(deps, flags);
      try {
        const { listing } = await runListing(url, loaded.value, runDeps);
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
      } catch (error) {
        if (flags.json === true && error instanceof UserBrowserRequiredError) {
          const adapter = adapterForUrl(url, deps.adapters);
          deps.print(
            JSON.stringify({ needsUserBrowser: true, site: adapter?.id ?? null, url }, null, 2),
          );
          ctx.exitCode = 2;
          return;
        }
        if (flags.json === true && error instanceof BlockedError) {
          deps.print(
            JSON.stringify(
              { blocked: error.reason, site: error.site, learned: [error.learned] },
              null,
              2,
            ),
          );
          ctx.exitCode = 2;
          return;
        }
        throw error;
      } finally {
        await runDeps.fetcher.close();
      }
    });
}

export function printSearch(
  ctx: Ctx,
  output: Awaited<ReturnType<typeof runSearch>>,
  report: { showStock: boolean; showShop: boolean; timeZones: string[] },
): void {
  const { deps } = ctx;
  if (output.hits.length === 0) {
    deps.print(`no offers found for '${output.query}'`);
  } else {
    deps.print(renderHits(output.hits, report));
  }
  if (output.conditionUnresolved) {
    deps.print(
      'condition: no rule matches this query. Ask the user which conditions to allow, then search again with --condition.',
    );
  }
  for (const warning of output.warnings) deps.print(`warning: ${warning}`);
  for (const [site, info] of Object.entries(output.sites)) {
    if (info.status === 'ok') continue;
    deps.print(`${site}: ${info.status}${info.reason === undefined ? '' : ` (${info.reason})`}`);
  }
  for (const item of output.needsUserBrowser) {
    deps.print(
      `${item.site}: needs the user's browser. Ask the user, then run '${item.scriptCommand}' in a tab they have open.`,
    );
  }
  for (const learned of output.learned) {
    deps.print(
      `learned: ${learned.kind} ${learned.site ?? '-'} ${learned.key} (${learned.evidence ?? ''})`,
    );
  }
}

export function toExitMessage(error: unknown): { code: number; message: string } {
  if (error instanceof NothingFoundError) return { code: 1, message: error.message };
  if (error instanceof DefaultsError || error instanceof ShopperError) {
    return { code: 2, message: error.message };
  }
  return { code: 2, message: error instanceof Error ? error.message : String(error) };
}
