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

  it('accepts the parked status', () => {
    expect(check(H + '| A-1 | t | parked | | | | | Parked by owner |\n').failed).toBe(false);
  });

  it('lenient fails only on duplicate IDs and padded cells', () => {
    expect(check('- [ ] x\n', 'lenient').failed).toBe(false);
    expect(check('| ID | Task |\n|---|---|\n| A | t |\n', 'lenient').failed).toBe(false);
    expect(
      check(H + '| A-1 | t | todo | a | | | | |\n| A-1 | t | todo | a | | | | |\n', 'lenient').failed,
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
