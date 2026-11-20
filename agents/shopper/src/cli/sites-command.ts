import type { Command } from 'commander';
import { effectiveLearnings, liveBlock } from '@ai-tools/agent-kit';
import { effectiveMode } from '../core/run.js';
import {
  AGENT,
  learningOptions,
  loadShopperDefaults,
  type Ctx,
  type StoreFlags,
} from './context.js';
import { renderTable } from './output.js';

interface SitesFlags extends StoreFlags {
  json?: boolean;
}

export function registerSitesCommand(program: Command, ctx: Ctx): void {
  const { deps } = ctx;
  program
    .command('sites')
    .description('list adapters, fetch modes and live blocks')
    .option('--defaults <file>', 'defaults file')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action((flags: SitesFlags) => {
      const loaded = loadShopperDefaults(deps, flags);
      const learnings = effectiveLearnings(AGENT, learningOptions(deps, flags));
      const now = deps.now();
      const rows = deps.adapters.map((adapter) => {
        const block = liveBlock(learnings, adapter.id, now);
        return {
          id: adapter.id,
          name: adapter.name,
          currency: adapter.currency,
          domains: adapter.domains,
          mode: effectiveMode(adapter, loaded.value, learnings, now),
          blocked: block === null ? null : { reason: block.evidence, until: block.expires },
          searched:
            (loaded.value.sites.preferred.length === 0 ||
              loaded.value.sites.preferred.includes(adapter.id)) &&
            !loaded.value.sites.blocked.includes(adapter.id),
        };
      });
      if (flags.json === true) {
        deps.print(JSON.stringify(rows, null, 2));
        return;
      }
      deps.print(
        renderTable(
          ['id', 'mode', 'searched', 'block', 'domains'],
          rows.map((row) => [
            row.id,
            row.mode,
            row.searched ? 'yes' : 'no',
            row.blocked === null
              ? '-'
              : `${row.blocked.reason ?? 'blocked'} until ${row.blocked.until ?? '?'}`,
            row.domains.join(','),
          ]),
        ),
      );
    });
}
