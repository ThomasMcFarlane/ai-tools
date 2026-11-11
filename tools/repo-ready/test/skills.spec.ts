import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { validateMap } from '../src/core/map.js';

const FILES = ['claude-code/repo-ready/SKILL.md', 'codex/repo-ready.md', 'opencode/repo-ready.md'];
const COMMANDS = [
  'status',
  'map set',
  'map show',
  'map changes',
  'session start',
  'session end',
  'session list',
  'teach',
  'ask',
  'hint',
  'answer',
  'grade',
  'skip',
  'next',
  'levels',
  'history',
  'chart',
  'report',
  'export',
  'reset',
];
const LABELS = [
  'Ready to be interviewed on it',
  'Ready to work on it',
  'Ready to own it',
  'Not yet ready',
  'Not enough evidence yet',
];

function skill(file: string): Promise<string> {
  return readFile(new URL(`../../../skills/${file}`, import.meta.url), 'utf8');
}

function body(text: string): string {
  const start = text.indexOf('\n## ');
  expect(start).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const charts = rest.indexOf('## Charts\n');
  expect(charts).toBeGreaterThan(-1);
  const after = rest.indexOf('\n## ', charts);
  expect(after).toBeGreaterThan(charts);
  return rest.slice(0, charts) + rest.slice(after + 1);
}

describe('repo-ready skills', () => {
  it.each(FILES)('%s names every command and label', async (file) => {
    const text = await skill(file);
    for (const c of COMMANDS) expect(text).toContain(`repo-ready ${c}`);
    for (const l of LABELS) expect(text).toContain(l);
    expect(text).toContain('--follow-up-of');
  });

  it('the three bodies differ only in header and chart section', async () => {
    const [claude, codex, opencode] = await Promise.all(FILES.map(skill));
    const bodies = [claude, codex, opencode].map((t) => body(t ?? ''));
    expect(bodies[0]?.length).toBeGreaterThan(1000);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
  });

  it('the JSON example in the skill is a valid map', async () => {
    const text = await skill('claude-code/repo-ready/SKILL.md');
    const match = /```json\n([\s\S]*?)\n```/.exec(text);
    expect(match).not.toBeNull();
    const map = validateMap(JSON.parse(match?.[1] ?? ''));
    expect(map.areas).toHaveLength(1);
    expect(map.areas[0]?.principles).toHaveLength(1);
  });
});
