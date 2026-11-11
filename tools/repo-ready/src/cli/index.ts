#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { defaultDeps, type Deps } from '../core/deps.js';
import { NotFoundError } from '../core/types.js';
import { VERSION } from '../version.js';
import { registerMapCommands } from './map-commands.js';
import { registerSessionCommands } from './session-commands.js';

function buildProgram(deps: Deps): Command {
  const p = new Command();
  p.exitOverride().configureOutput({
    writeOut: (text) => deps.print(text.replace(/\n$/, '')),
    writeErr: () => undefined,
  });
  p.name('repo-ready')
    .description('Repository readiness quiz engine for AI agents')
    .version(VERSION, '-V, --version', 'print the version')
    .option('--repo <path>', 'path of the repository to study');
  registerMapCommands(p, deps);
  registerSessionCommands(p, deps);
  return p;
}

export async function run(argv: string[], overrides: Partial<Deps> = {}): Promise<void> {
  const deps: Deps = { ...defaultDeps(), ...overrides };
  try {
    await buildProgram(deps).parseAsync(argv);
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    if (error.exitCode === 0) return;
    throw new Error(error.message.replace(/^error: /, ''));
  }
}

export function isEntryModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  const selfPath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(entry) === realpathSync(selfPath);
  } catch {
    return selfPath === entry;
  }
}

export async function main(): Promise<void> {
  await run(process.argv).catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof NotFoundError ? 1 : 2;
  });
}
