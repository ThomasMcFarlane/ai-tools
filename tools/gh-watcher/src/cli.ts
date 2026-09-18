#!/usr/bin/env node
import { isEntryModule, main } from './cli/index.js';

if (isEntryModule(import.meta.url)) {
  await main();
}
