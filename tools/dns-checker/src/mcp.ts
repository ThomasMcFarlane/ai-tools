#!/usr/bin/env node
import { isEntryModule } from './cli/index.js';
import { startMcp } from './mcp/server.js';

if (isEntryModule(import.meta.url)) {
  await startMcp().catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
