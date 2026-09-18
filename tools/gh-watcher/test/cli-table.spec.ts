import { formatTable, printJson } from '../src/cli/output.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('formatTable', () => {
  it('pads each column to the widest cell', () => {
    const table = formatTable([
      ['name', 'state'],
      ['demo', 'success'],
      ['a-long-watch-name', 'failure'],
    ]);
    const lines = table.split('\n');
    expect(lines).toEqual([
      `${'name'.padEnd(17)}  state`,
      `${'demo'.padEnd(17)}  success`,
      'a-long-watch-name  failure',
    ]);
  });

  it('trims trailing whitespace on the last column', () => {
    const table = formatTable([
      ['id', 'extra'],
      ['1', 'x'],
    ]);
    const lines = table.split('\n');
    expect(lines[0]).toBe('id  extra');
    expect(lines[1]).toBe('1   x');
  });

  it('trims the final column of every row', () => {
    const table = formatTable([['only'], ['row']]);
    expect(table.split('\n')).toEqual(['only', 'row']);
  });
});

describe('printJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes pretty JSON to stdout', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printJson({ ok: true });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe('{\n  "ok": true\n}');
  });
});
