#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { check, type Format } from './check.ts';

const args = process.argv.slice(2);
let path = 'TASKS.md';
let format: Format = 'canonical';
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--format' || a.startsWith('--format=')) {
    const v = a === '--format' ? args[++i] : a.slice(9);
    if (v !== 'canonical' && v !== 'lenient') {
      console.error(`unknown --format "${v}" (canonical or lenient)`);
      process.exit(2);
    }
    format = v;
  } else path = a;
}

let text: string;
try {
  text = readFileSync(path, 'utf8');
} catch (e) {
  console.error(`cannot read ${path}: ${(e as Error).message}`);
  process.exit(2);
}
const { problems, tasks, failed } = check(text, format);
for (const p of problems) console.log(`${path}:${p.line}: [${p.rule}] ${p.message}`);
console.log(
  `${path}: ${tasks} tasks, ${problems.length} problems (${format}) - ${failed ? 'FAIL' : 'ok'}`,
);
process.exit(failed ? 1 : 0);
