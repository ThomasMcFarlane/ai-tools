import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DefaultsError,
  defaultsEnvName,
  deepMerge,
  loadDefaults,
  validateDefaults,
} from '../src/index.js';
import { tempDir } from './helpers.js';

const schema = z.object({
  version: z.literal(1),
  country: z.string().length(2),
  nested: z.object({ a: z.number(), list: z.array(z.string()) }),
});
const builtin = { version: 1, country: 'TH', nested: { a: 1, list: ['x', 'y'] } };

function setup(): { mem: string; file: string } {
  const mem = tempDir();
  mkdirSync(join(mem, 'demo'));
  return { mem, file: join(mem, 'demo', 'defaults.json') };
}

describe('loadDefaults', () => {
  it('names the env variable from the agent', () => {
    expect(defaultsEnvName('shopper')).toBe('SHOPPER_DEFAULTS');
    expect(defaultsEnvName('my-agent')).toBe('MY_AGENT_DEFAULTS');
  });

  it('falls back to built-in defaults', () => {
    const { mem } = setup();
    const out = loadDefaults('demo', schema, { builtin, memoryDir: mem, env: {} });
    expect(out.source).toBe('builtin');
    expect(out.file).toBeNull();
    expect(out.value).toEqual(builtin);
  });

  it('reads the memory file and deep-merges it over the built-in values', () => {
    const { mem, file } = setup();
    writeFileSync(file, JSON.stringify({ nested: { list: ['z'] } }));
    const out = loadDefaults('demo', schema, { builtin, memoryDir: mem, env: {} });
    expect(out.source).toBe('memory');
    expect(out.value.nested).toEqual({ a: 1, list: ['z'] });
    expect(out.value.country).toBe('TH');
  });

  it('ranks flag above env above memory', () => {
    const { mem, file } = setup();
    writeFileSync(file, JSON.stringify({ country: 'GB' }));
    const envFile = join(mem, 'env.json');
    const flagFile = join(mem, 'flag.json');
    writeFileSync(envFile, JSON.stringify({ country: 'DE' }));
    writeFileSync(flagFile, JSON.stringify({ country: 'FR' }));
    const env = { DEMO_DEFAULTS: envFile };
    expect(loadDefaults('demo', schema, { builtin, memoryDir: mem, env }).value.country).toBe('DE');
    const flagged = loadDefaults('demo', schema, { builtin, memoryDir: mem, env, file: flagFile });
    expect(flagged.value.country).toBe('FR');
    expect(flagged.source).toBe('flag');
  });

  it('reports path and message for an invalid file', () => {
    const { mem, file } = setup();
    writeFileSync(file, JSON.stringify({ country: 'THAI' }));
    try {
      loadDefaults('demo', schema, { builtin, memoryDir: mem, env: {} });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DefaultsError);
      const issue = (error as DefaultsError).issues[0];
      expect(issue?.path).toBe('country');
      expect((error as DefaultsError).message).toContain(file);
      expect((error as DefaultsError).message).toContain('country');
    }
  });

  it('fails on a missing flag file and on bad JSON', () => {
    const { mem, file } = setup();
    expect(() =>
      loadDefaults('demo', schema, {
        builtin,
        memoryDir: mem,
        env: {},
        file: join(mem, 'none.json'),
      }),
    ).toThrow(DefaultsError);
    writeFileSync(file, '{oops');
    expect(() => loadDefaults('demo', schema, { builtin, memoryDir: mem, env: {} })).toThrow(
      /not valid JSON/,
    );
  });
});

describe('deepMerge and validateDefaults', () => {
  it('replaces arrays and merges objects', () => {
    expect(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2] } })).toEqual({ a: { b: 1, c: [2] } });
  });

  it('validates data directly', () => {
    expect(() => validateDefaults(schema, builtin, { version: 2 }, null)).toThrow(DefaultsError);
  });
});
