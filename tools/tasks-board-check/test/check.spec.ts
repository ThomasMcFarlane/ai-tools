import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../src/check.ts';
import { epicEtaWarnings } from '../../../mods/tasks-board/hooks/board.ts';

const H =
  '| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |\n|---|---|---|---|---|---|---|---|\n';

describe('check', () => {
  it('accepts the shipped fixture', () => {
    const r = check(readFileSync('../../actions/tasks-board-check/fixture/TASKS.md', 'utf8'));
    expect(r.problems).toEqual([]);
    expect(r.tasks).toBe(2);
  });

  it('flags a bad board with line numbers', () => {
    const r = check(
      H +
        '| 1 | t | wip | a | | | | |\n| 1 | t | todo | a | | | 2026-10-10 | |\n- [ ] loose\n| 2 |  p | todo | a | | | | |\n',
    );
    expect(r.failed).toBe(true);
    expect(r.problems.map((p) => p.line)).toEqual(expect.arrayContaining([3, 4, 5, 6]));
  });

  it('requires numbered epics and <epic>.<task> Depends', () => {
    const row = (d: string) => `| 1 | t | todo | a | |${d ? ` ${d} ` : ''}| | |\n`;
    expect(check('## 1. E\n\n' + H + row('')).failed).toBe(false);
    expect(check('## E\n\n' + H + row('')).failed).toBe(true);
    expect(check('## E\n\n' + H + row(''), 'lenient').failed).toBe(false);
    expect(check('## 1. E\n\n' + H + row('1')).failed).toBe(true);
    expect(check('## 1. E\n\n' + H + row('1.1')).failed).toBe(false);
  });

  it('requires numeric IDs and numeric references', () => {
    const r = (id: string, d = '') =>
      '## 1. E\n\n' + H + `| ${id} | t | todo | a | |${d ? ` ${d} ` : ''}| | |\n`;
    expect(check(r('PZ-001')).problems[0]!.message).toContain('not a positive integer');
    expect(check(r('PZ-001'), 'lenient').failed).toBe(false);
    expect(check(r('1', '1.PZ-001')).failed).toBe(true);
  });

  it('accepts the parked status', () => {
    expect(check(H + '| 1 | t | parked | | | | | Parked by owner |\n').failed).toBe(false);
  });

  it('superseded needs a Superseded by prefix naming an existing row', () => {
    const r = (n: string) =>
      '## 1. E\n\n' + H + `| 1 | t | superseded | | | | | ${n} |\n| 2 | t | todo | | | | | |\n`;
    expect(check(r('Superseded by 1.2.')).failed).toBe(false);
    expect(check(r('Superseded by 1.7.')).failed).toBe(true);
    expect(check(r('replaced')).failed).toBe(true);
  });
  it('dropped needs a Dropped: prefix', () => {
    expect(
      check('## 1. E\n\n' + H + '| 1 | t | dropped | | | | | Dropped: not needed. |\n').failed,
    ).toBe(false);
    expect(check('## 1. E\n\n' + H + '| 1 | t | dropped | | | | | not needed |\n').failed).toBe(
      true,
    );
  });

  it('rejects legacy statuses and points to the table', () => {
    const r = check('## 1. E\n\n' + H + '| 1 | t | deferred | | | | | x |\n');
    expect(r.failed).toBe(true);
    expect(r.problems[0]!.message).toContain('see FORMAT.md, Legacy statuses');
    expect(r.problems[0]!.message).toContain('dropped');
  });

  it('lenient fails only on duplicate IDs and padded cells', () => {
    expect(check('- [ ] x\n', 'lenient').failed).toBe(false);
    expect(check('| ID | Task |\n|---|---|\n| A | t |\n', 'lenient').failed).toBe(false);
    expect(
      check(H + '| 1 | t | todo | a | | | | |\n| 1 | t | todo | a | | | | |\n', 'lenient').failed,
    ).toBe(true);
    expect(check('| ID |  Task |\n|---|---|\n', 'lenient').failed).toBe(true);
  });

  it('counts letter+digit IDs in a Status table and ignores them in decision tables', () => {
    const r = check(
      H +
        '| F1 | t | todo | a | | | | |\n| F10 | t | done | a | | | | |\n\n| ID | Decision | Why |\n|---|---|---|\n| D1 | x | y |\n',
      'lenient',
    );
    expect(r.tasks).toBe(2);
    expect(r.failed).toBe(false);
  });
});

describe('epic ETA warnings', () => {
  it('warns without failing', () => {
    const r = check('## 1. E\n\n' + H + '| 1 | t | todo | a | | | | |\n');
    expect(r.failed).toBe(false);
    expect(r.warnings.map((w) => w.rule)).toEqual(['epic-eta']);
  });
});

describe('epicEtaWarnings', () => {
  const T = (eta: string, status = 'todo') =>
    `## 1. E\n${eta}\n\n${H}| 1 | t | ${status} | | | | | |\n`;
  const now = new Date('2026-10-15T00:00:00Z');
  it('accepts an ETA line under the heading without disturbing lint or parse', () => {
    const text = T('ETA: 2026-10-20 18:00 ICT');
    expect(check(text).problems).toEqual([]);
    expect(check(text).tasks).toBe(1);
    expect(epicEtaWarnings(text, now)).toEqual([]);
  });
  it('warns on a missing, malformed or past ETA while rows are open', () => {
    expect(epicEtaWarnings(T(''), now)[0]!.message).toContain('no "ETA');
    expect(epicEtaWarnings(T('ETA: soon'), now)[0]!.message).toContain('not YYYY');
    expect(epicEtaWarnings(T('ETA: 2026-10-14 18:00 ICT'), now)[0]!.message).toContain('past');
    expect(epicEtaWarnings(T('ETA: 2026-10-14 18:00 ICT', 'done'), now)).toEqual([]);
    expect(epicEtaWarnings(T('', 'done'), now)).toEqual([]);
  });
});

describe('board quality rules', () => {
  const row = (r: string, head = '## 1. Card parity') => `${head}\n\n${H}${r}\n`;

  it('fails on a wrong cell count, even when lenient', () => {
    expect(check(row('| 1 | t | todo | a | | | n |'), 'lenient').failed).toBe(true);
    expect(check(row('| 1 | t | todo | a | | | | n |')).failed).toBe(false);
  });

  it('fails on a vague epic name with open rows only', () => {
    expect(check(row('| 1 | t | todo | a | | | | |', '## 1. Active')).failed).toBe(true);
    expect(check(row('| 1 | t | done | a | | | | |', '## 1. Active')).failed).toBe(false);
  });

  it('fails on long open cells and walls of text', () => {
    expect(check(row(`| 1 | ${'x'.repeat(101)} | todo | a | | | | |`)).failed).toBe(true);
    expect(check(row(`| 1 | t | todo | a | | | | ${'y'.repeat(401)} |`)).failed).toBe(true);
    expect(check(row(`| 1 | t | done | a | | | | ${'y'.repeat(401)} |`)).failed).toBe(false);
    expect(check(row('| 1 | t | todo | a | | | | |') + 'w'.repeat(401) + '\n').failed).toBe(true);
  });
});

describe('--fix', () => {
  it('rewrites the file in place and exits with the check result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-'));
    const file = join(dir, 'TASKS.md');
    writeFileSync(file, '## 1. Card parity\n\n' + H + '|  1 | t | todo | a | | | | n |\n');
    const r = spawnSync('node', ['--experimental-strip-types', 'src/cli.ts', '--fix', file], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('| 1 | t | todo | a | | | | n |');
    expect(r.stdout).toContain('fixed line 5');
  });

  it('leaves a trailing non-task table alone and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-'));
    const file = join(dir, 'TASKS.md');
    const body = '## 1. Card parity\n\n' + H + '| 1 | t | todo | a | | | | n | |\n\nProse.\n\n| Name | Value |\n|---|---|\n| a |\n';
    writeFileSync(file, body);
    const run = () => spawnSync('node', ['--experimental-strip-types', 'src/cli.ts', '--fix', file], { encoding: 'utf8' });
    run();
    const once = readFileSync(file, 'utf8');
    expect(once).toBe(body.replace('| n | |', '| n |'));
    run();
    expect(readFileSync(file, 'utf8')).toBe(once);
  });
});
