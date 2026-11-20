import type { Command } from 'commander';
import {
  LEARNING_KINDS,
  appendLearning,
  effectiveLearnings,
  flushLearnings,
  parseExpiry,
  type LearningKind,
} from '@ai-tools/agent-kit';
import { ShopperError } from '../core/types.js';
import { AGENT, learningOptions, type Ctx, type StoreFlags } from './context.js';
import { renderTable, truncate } from './output.js';

interface LearnFlags extends StoreFlags {
  kind?: string;
  site?: string;
  key?: string;
  value?: string;
  expires?: string;
  evidence?: string;
  json?: boolean;
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function registerLearnCommands(program: Command, ctx: Ctx): void {
  const learn = program.command('learn').description('record and list learnings');
  const { deps } = ctx;

  learn
    .command('add')
    .description('append a learning to the local journal')
    .requiredOption('--kind <kind>', `one of ${LEARNING_KINDS.join(', ')}`)
    .requiredOption('--key <key>', 'learning key, for example search.card')
    .requiredOption('--value <json>', 'JSON value (plain text is stored as a string)')
    .option('--site <id>', 'site id the learning applies to')
    .option('--expires <when>', '24h, 7d or an ISO date')
    .option('--evidence <text>', 'short proof')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action((flags: LearnFlags) => {
      if (!(LEARNING_KINDS as readonly string[]).includes(flags.kind ?? '')) {
        throw new ShopperError(`unknown kind '${flags.kind}': use ${LEARNING_KINDS.join(', ')}`);
      }
      const entry = appendLearning(
        AGENT,
        {
          kind: flags.kind as LearningKind,
          site: flags.site ?? null,
          key: flags.key as string,
          value: parseValue(flags.value as string),
          expires: flags.expires === undefined ? null : parseExpiry(flags.expires, deps.now()),
          evidence: flags.evidence ?? null,
        },
        learningOptions(deps, flags),
      );
      deps.print(
        flags.json === true
          ? JSON.stringify(entry, null, 2)
          : `recorded ${entry.kind} ${entry.key}`,
      );
    });

  learn
    .command('list')
    .description('list effective learnings')
    .option('--site <id>', 'only this site')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action((flags: LearnFlags) => {
      const all = effectiveLearnings(AGENT, learningOptions(deps, flags)).filter(
        (entry) => flags.site === undefined || entry.site === flags.site,
      );
      if (flags.json === true) {
        deps.print(JSON.stringify(all, null, 2));
        return;
      }
      if (all.length === 0) {
        deps.print('no learnings');
        return;
      }
      deps.print(
        renderTable(
          ['kind', 'site', 'key', 'value', 'expires'],
          all.map((entry) => [
            entry.kind,
            entry.site ?? '-',
            entry.key,
            truncate(JSON.stringify(entry.value), 48),
            entry.expires ?? '-',
          ]),
        ),
      );
    });

  learn
    .command('flush')
    .description('move pending learnings into the durable memory')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action((flags: LearnFlags) => {
      const result = flushLearnings(AGENT, learningOptions(deps, flags));
      deps.print(
        flags.json === true
          ? JSON.stringify(result, null, 2)
          : result.status === 'empty'
            ? 'nothing to flush'
            : `flushed ${result.lines} learnings (${result.method})`,
      );
    });
}
