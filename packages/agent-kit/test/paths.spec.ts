import { describe, expect, it } from 'vitest';
import { agentPaths, resolveCacheDir, resolveMemoryDir, resolveStateDir } from '../src/index.js';

describe('paths', () => {
  it('uses the XDG defaults under the home directory', () => {
    expect(resolveMemoryDir({ env: {}, home: '/home/u' })).toBe('/home/u/.config/ai-tools/agents');
    expect(resolveStateDir({ env: {}, home: '/home/u' })).toBe(
      '/home/u/.local/state/ai-tools/agents',
    );
    expect(resolveCacheDir({ env: {}, home: '/home/u' })).toBe('/home/u/.cache/ai-tools/agents');
  });

  it('honours XDG variables', () => {
    const env = { XDG_CONFIG_HOME: '/c', XDG_STATE_HOME: '/s', XDG_CACHE_HOME: '/k' };
    expect(resolveMemoryDir({ env, home: '/h' })).toBe('/c/ai-tools/agents');
    expect(resolveStateDir({ env, home: '/h' })).toBe('/s/ai-tools/agents');
    expect(resolveCacheDir({ env, home: '/h' })).toBe('/k/ai-tools/agents');
  });

  it('ranks flag above AGENTS_MEMORY_DIR above XDG', () => {
    const env = { AGENTS_MEMORY_DIR: '/env-mem', XDG_CONFIG_HOME: '/c' };
    expect(resolveMemoryDir({ env, home: '/h' })).toBe('/env-mem');
    expect(resolveMemoryDir({ env, home: '/h', memoryDir: '/flag-mem' })).toBe('/flag-mem');
  });

  it('ranks AGENTS_STATE_DIR above XDG', () => {
    const env = { AGENTS_STATE_DIR: '/env-state', XDG_STATE_HOME: '/s' };
    expect(resolveStateDir({ env, home: '/h' })).toBe('/env-state');
  });

  it('builds per-agent file paths', () => {
    const paths = agentPaths('shopper', {
      env: { AGENTS_MEMORY_DIR: '/m', AGENTS_STATE_DIR: '/s' },
      home: '/h',
    });
    expect(paths.defaultsFile).toBe('/m/shopper/defaults.json');
    expect(paths.durableLearnings).toBe('/m/shopper/learnings.jsonl');
    expect(paths.localLearnings).toBe('/s/shopper/learnings.jsonl');
    expect(paths.pendingLearnings).toBe('/s/shopper/pending.jsonl');
  });
});
