import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatTable, printTable } from '../src/cli/output.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatTable', () => {
  it('pads each column to the widest cell', () => {
    expect(
      formatTable([
        ['name', 'value'],
        ['a', 'bbb'],
        ['ccc', 'd'],
      ]),
    ).toBe(['name  value', 'a     bbb', 'ccc   d'].join('\n'));
  });

  it('trims trailing padding on the final column', () => {
    expect(
      formatTable([
        ['ab', 'cd'],
        ['x', 'y'],
      ]),
    ).toBe(['ab  cd', 'x   y'].join('\n'));
  });

  it('handles ragged rows', () => {
    expect(
      formatTable([
        ['abc'],
        ['a', 'bb'],
      ]),
    ).toBe(['abc', 'a    bb'].join('\n'));
  });

  it('formats a resolver-style table', () => {
    const table = formatTable([
      ['name', 'label'],
      ['cloudflare', 'Cloudflare'],
      ['google', 'Google Public DNS'],
    ]);
    expect(table).toBe(
      ['name        label', 'cloudflare  Cloudflare', 'google      Google Public DNS'].join('\n'),
    );
  });
});

describe('printTable', () => {
  it('prints the formatted table', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printTable([
      ['a', 'b'],
      ['c', 'dd'],
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('a  b\nc  dd');
  });
});
