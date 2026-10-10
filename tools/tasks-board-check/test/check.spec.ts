import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check } from '../src/check.ts';

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
        '| A-1 | t | wip | a | | | | |\n| A-1 | t | todo | a | | | 2026-10-10 | |\n- [ ] loose\n| A-2 |  p | todo | a | | | | |\n',
    );
    expect(r.failed).toBe(true);
    expect(r.problems.map((p) => p.line)).toEqual(expect.arrayContaining([3, 4, 5, 6]));
  });

  it('requires numbered epics and <epic>.<task> Depends', () => {
    const row = (d: string) => `| A-1 | t | todo | a | |${d ? ` ${d} ` : ''}| | |\n`;
    expect(check('## 1. E\n\n' + H + row('')).failed).toBe(false);
    expect(check('## E\n\n' + H + row('')).failed).toBe(true);
    expect(check('## E\n\n' + H + row(''), 'lenient').failed).toBe(false);
    expect(check('## 1. E\n\n' + H + row('A-1')).failed).toBe(true);
    expect(check('## 1. E\n\n' + H + row('1.A-1')).failed).toBe(false);
  });

  it('accepts the parked status', () => {
    expect(check(H + '| A-1 | t | parked | | | | | Parked by owner |\n').failed).toBe(false);
  });

  it('dropped needs a Dropped: prefix', () => {
    expect(check('## 1. E\n\n' + H + '| A-1 | t | dropped | | | | | Dropped: not needed. |\n').failed).toBe(false);
    expect(check('## 1. E\n\n' + H + '| A-1 | t | dropped | | | | | not needed |\n').failed).toBe(true);
  });

  it('rejects legacy statuses and points to the table', () => {
    const r = check('## 1. E\n\n' + H + '| A-1 | t | deferred | | | | | x |\n');
    expect(r.failed).toBe(true);
    expect(r.problems[0]!.message).toContain('see FORMAT.md, Legacy statuses');
    expect(r.problems[0]!.message).toContain('dropped');
  });

  it('lenient fails only on duplicate IDs and padded cells', () => {
    expect(check('- [ ] x\n', 'lenient').failed).toBe(false);
    expect(check('| ID | Task |\n|---|---|\n| A | t |\n', 'lenient').failed).toBe(false);
    expect(
      check(H + '| A-1 | t | todo | a | | | | |\n| A-1 | t | todo | a | | | | |\n', 'lenient')
        .failed,
    ).toBe(true);
    expect(check('| ID |  Task |\n|---|---|\n', 'lenient').failed).toBe(true);
  });

  it('counts letter+digit IDs in a Status table and ignores them in decision tables', () => {
    const r = check(
      H +
        '| F1 | t | todo | a | | | | |\n| F10 | t | done | a | | | | |\n\n| ID | Decision | Why |\n|---|---|---|\n| D1 | x | y |\n',
    );
    expect(r.tasks).toBe(2);
    expect(r.failed).toBe(false);
  });
});
