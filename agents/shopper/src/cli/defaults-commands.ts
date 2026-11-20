import type { Command } from 'commander';
import { DefaultsError, resolveDefaultsFile } from '@ai-tools/agent-kit';
import { defaultsJsonSchema } from '../core/defaults.js';
import {
  AGENT,
  loadShopperDefaults,
  memoryFile,
  pathOptions,
  type Ctx,
  type StoreFlags,
} from './context.js';

interface DefaultsFlags extends StoreFlags {
  json?: boolean;
}

export function registerDefaultsCommands(program: Command, ctx: Ctx): void {
  const defaults = program.command('defaults').description('show, locate and validate defaults');
  const { deps } = ctx;

  defaults
    .command('show')
    .description('print the effective defaults')
    .option('--defaults <file>', 'defaults file')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON with source and file')
    .action((flags: DefaultsFlags) => {
      const loaded = loadShopperDefaults(deps, flags);
      if (flags.json === true) {
        deps.print(
          JSON.stringify(
            {
              source: loaded.source,
              file: loaded.file,
              warnings: loaded.warnings,
              defaults: loaded.value,
            },
            null,
            2,
          ),
        );
        return;
      }
      deps.print(`source: ${loaded.source}${loaded.file === null ? '' : ` (${loaded.file})`}`);
      deps.print(JSON.stringify(loaded.value, null, 2));
      for (const warning of loaded.warnings) deps.print(`warning: ${warning}`);
    });

  defaults
    .command('path')
    .description('print which defaults file applies')
    .option('--defaults <file>', 'defaults file')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action((flags: DefaultsFlags) => {
      const resolved = resolveDefaultsFile(AGENT, {
        ...pathOptions(deps, flags),
        ...(flags.defaults === undefined ? {} : { file: flags.defaults }),
      });
      const memory = memoryFile(deps, flags);
      if (flags.json === true) {
        deps.print(
          JSON.stringify(
            { source: resolved.source, file: resolved.file, memoryFile: memory },
            null,
            2,
          ),
        );
        return;
      }
      deps.print(`source: ${resolved.source}`);
      deps.print(`file: ${resolved.file ?? '(built-in defaults)'}`);
      deps.print(`memory file: ${memory}`);
    });

  defaults
    .command('validate [file]')
    .description('check a defaults file against the schema')
    .option('--defaults <file>', 'defaults file')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action((file: string | undefined, flags: DefaultsFlags) => {
      try {
        const loaded = loadShopperDefaults(deps, flags, file);
        if (flags.json === true) {
          deps.print(
            JSON.stringify(
              { ok: true, source: loaded.source, file: loaded.file, warnings: loaded.warnings },
              null,
              2,
            ),
          );
        } else {
          deps.print(`ok: ${loaded.file ?? '(built-in defaults)'}`);
          for (const warning of loaded.warnings) deps.print(`warning: ${warning}`);
        }
      } catch (error) {
        if (flags.json === true && error instanceof DefaultsError) {
          deps.print(
            JSON.stringify({ ok: false, file: error.file, issues: error.issues }, null, 2),
          );
          ctx.exitCode = 2;
          return;
        }
        throw error;
      }
    });

  defaults
    .command('schema')
    .description('print the JSON Schema of the defaults file')
    .action(() => {
      deps.print(JSON.stringify(defaultsJsonSchema(), null, 2));
    });
}
