#!/usr/bin/env node
import { isEntryModule, main } from './cli/index.js';

if ((process as { pkg?: unknown }).pkg !== undefined || isEntryModule(import.meta.url)) {
  await main();
}
