import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, removeWorlds, runCli } from './helpers.js';

afterEach(removeWorlds);

describe('usage errors', () => {
  it('an unknown command exits 2 and names it', async () => {
    const r = await runCli(['nope'], await makeWorld());
    expect(r.code).toBe(2);
    expect(r.error?.message).toContain('nope');
    expect(r.error?.message.startsWith('error:')).toBe(false);
    expect(r.out).toBe('');
  });

  it('an unknown option exits 2', async () => {
    const r = await runCli(['status', '--bogus'], await makeWorld());
    expect(r.code).toBe(2);
    expect(r.error?.message).toContain('--bogus');
  });

  it('--version prints the version and exits 0', async () => {
    const r = await runCli(['--version'], await makeWorld());
    expect(r.code).toBe(0);
    expect(r.out).toBe('0.1.0');
  });

  it('--help exits 0 and lists the commands', async () => {
    const r = await runCli(['--help'], await makeWorld());
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: repo-ready');
    expect(r.out).toContain('status');
  });

  it('a subcommand --help exits 0', async () => {
    const r = await runCli(['map', 'set', '--help'], await makeWorld());
    expect(r.code).toBe(0);
    expect(r.out).toContain('--file');
  });
});

describe('no command given', () => {
  it.each([[[] as string[]], [['map']], [['session']]])(
    '%j prints help and exits 2',
    async (args) => {
      const r = await runCli(args, await makeWorld());
      expect(r.code).toBe(2);
      expect(r.out).toContain('Usage:');
      expect(r.error?.message).toBe('no command given');
    },
  );

  it('a group help names its own subcommands', async () => {
    const r = await runCli(['map'], await makeWorld());
    expect(r.out).toContain('Usage: repo-ready map');
    expect(r.out).toContain('changes');
  });
});
