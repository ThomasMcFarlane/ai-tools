#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { NotFoundError } from '../core/types.js';
import { VERSION } from '../version.js';

function buildProgram(): Command {
  const p = new Command();
  p.name('repo-ready')
    .description('Repository readiness quiz engine for AI agents')
    .version(VERSION, '-V, --version', 'print the version')
    .option('--repo <path>', 'path of the repository to study');
  return p;
}

export async function run(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
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
