#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { VERSION } from '../version.js';
import { defaultDeps, type Ctx, type Deps } from './context.js';
import { registerDefaultsCommands } from './defaults-commands.js';
import { registerLearnCommands } from './learn-commands.js';
import { registerPageCommands } from './page-commands.js';
import { registerSearchCommands, toExitMessage } from './search-commands.js';
import { registerSitesCommand } from './sites-command.js';

export function buildProgram(ctx: Ctx): Command {
  const { deps } = ctx;
  const program = new Command();
  program.exitOverride().configureOutput({
    writeOut: (text) => deps.print(text.replace(/\n$/, '')),
    writeErr: (text) => deps.printErr(text.replace(/\n$/, '')),
    outputError: () => undefined,
  });
  program
    .name('shopper')
    .description(
      'Compare prices across online shops with deterministic fetch, parse, filter and rank',
    )
    .version(VERSION, '-V, --version', 'print the version');
  registerSearchCommands(program, ctx);
  registerSitesCommand(program, ctx);
  registerDefaultsCommands(program, ctx);
  registerLearnCommands(program, ctx);
  registerPageCommands(program, ctx);
  return program;
}

export async function run(argv: string[], overrides: Partial<Deps> = {}): Promise<number> {
  const deps: Deps = { ...defaultDeps(), ...overrides };
  const ctx: Ctx = { deps, exitCode: 0 };
  try {
    await buildProgram(ctx).parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      if (error.code === 'commander.help') return 2;
      deps.printErr(`error: ${error.message.replace(/^error: /, '')}`);
      return 2;
    }
    const { code, message } = toExitMessage(error);
    deps.printErr(`error: ${message}`);
    return code;
  }
  return ctx.exitCode;
}

export function isEntryModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const selfPath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(entry) === realpathSync(selfPath);
  } catch {
    return selfPath === entry;
  }
}

export async function main(): Promise<void> {
  process.exitCode = await run(process.argv);
}
