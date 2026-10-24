#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fixBoard } from '../../../mods/tasks-board/hooks/board.ts';
import { check, type Format } from './check.ts';

const args = process.argv.slice(2);
let path = 'TASKS.md';
let format: Format = 'canonical';
let fix = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--fix') fix = true;
  else if (a === '--format' || a.startsWith('--format=')) {
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
if (fix) {
  const fixed = fixBoard(text);
  for (const c of fixed.changes) console.log(`${path}: fixed ${c}`);
  if (fixed.text !== text) {
    try {
      writeFileSync(path, fixed.text);
    } catch (e) {
      console.error(`cannot write ${path}: ${(e as Error).message}`);
      process.exit(2);
    }
  }
  text = fixed.text;
}
const { problems, warnings, tasks, failed } = check(text, format);
for (const p of problems) console.log(`${path}:${p.line}: [${p.rule}] ${p.message}`);
for (const w of warnings) console.log(`${path}:${w.line}: warning [${w.rule}] ${w.message}`);
console.log(
  `${path}: ${tasks} tasks, ${problems.length} problems (${format}) - ${failed ? 'FAIL' : 'ok'}`,
);
process.exit(failed ? 1 : 0);
