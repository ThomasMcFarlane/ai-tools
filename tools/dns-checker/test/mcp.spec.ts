import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadState, lookup } from '../src/index.js';
import { createToolHandlers, toolSchemas, type ToolResponse } from '../src/mcp/server.js';

let stateRoot: string;
let previousEnv: string | undefined;
let handlers: Record<string, (args: unknown) => Promise<ToolResponse>>;

const fakeLookup: typeof lookup = async (domain, type, opts) => ({
  domain,
  type,
  resolver: opts?.resolver ?? 'system',
  transport: 'system',
  answers: [{ value: '192.0.2.1', ttl: 300 }],
  checkedAt: '2026-01-01T00:00:00.000Z',
});

function parse(response: ToolResponse): unknown {
  return JSON.parse(response.content[0]!.text);
}

function addWatch(name: string): Promise<ToolResponse> {
  return handlers.dns_watch_add!({
    name,
    domain: 'example.com',
    type: 'A',
    rule: { kind: 'equals', values: ['203.0.113.5'] },
  });
}

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dns-checker-mcp-'));
  previousEnv = process.env['AI_TOOLS_DNS_STATE_DIR'];
  process.env['AI_TOOLS_DNS_STATE_DIR'] = stateRoot;
  handlers = createToolHandlers({
    lookupFn: fakeLookup,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
});

afterEach(async () => {
  if (previousEnv === undefined) {
    delete process.env['AI_TOOLS_DNS_STATE_DIR'];
  } else {
    process.env['AI_TOOLS_DNS_STATE_DIR'] = previousEnv;
  }
  await rm(stateRoot, { recursive: true, force: true });
});

describe('createToolHandlers', () => {
  it('adds a watch and returns the saved spec', async () => {
    const response = await handlers.dns_watch_add!({
      name: 'w1',
      domain: 'example.com',
      type: 'A',
      rule: { kind: 'equals', values: ['192.0.2.1'] },
    });
    expect(response.isError).toBeUndefined();
    const spec = parse(response) as {
      name: string;
      type: string;
      intervalSeconds: number;
      hook: { kind: string };
      createdAt: string;
    };
    expect(spec.name).toBe('w1');
    expect(spec.type).toBe('A');
    expect(spec.intervalSeconds).toBe(60);
    expect(spec.hook).toEqual({ kind: 'none' });
    expect(spec.createdAt).toBe('2026-01-01T00:00:00.000Z');
    const state = await loadState();
    expect(state.watchers).toHaveLength(1);
    expect(state.watchers[0]!.name).toBe('w1');
  });

  it('rejects duplicate watch names', async () => {
    await addWatch('w1');
    const duplicate = await addWatch('w1');
    expect(duplicate.isError).toBe(true);
    const payload = parse(duplicate) as { error: string };
    expect(payload.error).toContain('already exists');
  });

  it('lists saved watches', async () => {
    await addWatch('w1');
    await addWatch('w2');
    const response = await handlers.dns_watch_list!({});
    const names = (parse(response) as { name: string }[]).map((watcher) => watcher.name);
    expect(names).toEqual(['w1', 'w2']);
  });

  it('removes a watch and errors when missing', async () => {
    const missing = await handlers.dns_watch_remove!({ name: 'nope' });
    expect(missing.isError).toBe(true);
    await addWatch('w1');
    const response = await handlers.dns_watch_remove!({ name: 'w1' });
    expect(response.isError).toBeUndefined();
    expect(parse(response)).toEqual({ removed: true });
    const state = await loadState();
    expect(state.watchers).toHaveLength(0);
  });

  it('returns fake lookup results without network access', async () => {
    const response = await handlers.dns_lookup!({ domain: 'example.com', types: ['A', 'AAAA'] });
    const results = parse(response) as {
      domain: string;
      type: string;
      answers: { value: string }[];
    }[];
    expect(results).toHaveLength(2);
    expect(results[0]!.domain).toBe('example.com');
    expect(results[0]!.type).toBe('A');
    expect(results[0]!.answers[0]!.value).toBe('192.0.2.1');
    expect(results[1]!.type).toBe('AAAA');
  });

  it('checks an equals rule and rejects invalid rules', async () => {
    const response = await handlers.dns_check!({
      domain: 'example.com',
      type: 'A',
      rule: { kind: 'equals', values: ['192.0.2.1'] },
    });
    const outcome = parse(response) as { matched: boolean; reason: string };
    expect(outcome.matched).toBe(true);
    const bad = await handlers.dns_check!({
      domain: 'example.com',
      type: 'A',
      rule: { kind: 'bogus' },
    });
    expect(bad.isError).toBe(true);
    expect((parse(bad) as { error: string }).error).toBeDefined();
  });

  it('records an any-change baseline then reports no change', async () => {
    const args = {
      domain: 'example.com',
      type: 'A',
      rule: { kind: 'any-change' },
    };
    const first = parse(await handlers.dns_check!(args)) as {
      matched: boolean;
      reason: string;
    };
    expect(first.matched).toBe(false);
    expect(first.reason).toBe('baseline recorded');
    const second = parse(await handlers.dns_check!(args)) as {
      matched: boolean;
      reason: string;
    };
    expect(second.matched).toBe(false);
    expect(second.reason).toBe('no change');
  });

  it('returns events after a manual watch check', async () => {
    await addWatch('w1');
    const check = await handlers.dns_watch_check!({});
    const events = parse(check) as { watch: string; matched: boolean }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.watch).toBe('w1');
    expect(events[0]!.matched).toBe(false);
    const named = await handlers.dns_watch_check!({ name: 'w1' });
    expect(parse(named)).toHaveLength(1);
    const unknown = await handlers.dns_watch_check!({ name: 'nope' });
    expect(unknown.isError).toBe(true);
    const listed = await handlers.dns_events!({ tail: 5 });
    expect(parse(listed)).toHaveLength(2);
  });

  it('waits for a match and reports timeouts', async () => {
    const hit = parse(
      await handlers.dns_wait!({
        domain: 'example.com',
        type: 'A',
        rule: { kind: 'equals', values: ['192.0.2.1'] },
        intervalSeconds: 0.01,
        timeoutSeconds: 5,
      }),
    ) as { matched: boolean; timedOut: boolean; values: string[] };
    expect(hit.matched).toBe(true);
    expect(hit.timedOut).toBe(false);
    expect(hit.values).toEqual(['192.0.2.1']);
    const miss = parse(
      await handlers.dns_wait!({
        domain: 'example.com',
        type: 'A',
        rule: { kind: 'equals', values: ['203.0.113.5'] },
        intervalSeconds: 0.01,
        timeoutSeconds: 0.05,
      }),
    ) as { matched: boolean; timedOut: boolean };
    expect(miss.matched).toBe(false);
    expect(miss.timedOut).toBe(true);
  });
});

describe('toolSchemas', () => {
  const toolNames = [
    'dns_lookup',
    'dns_check',
    'dns_wait',
    'dns_watch_add',
    'dns_watch_list',
    'dns_watch_remove',
    'dns_watch_check',
    'dns_events',
  ];

  it('covers every exported tool name', () => {
    expect(Object.keys(toolSchemas).sort()).toEqual([...toolNames].sort());
    expect(Object.keys(handlers).sort()).toEqual([...toolNames].sort());
    for (const name of toolNames) {
      expect(typeof toolSchemas[name]!.parse).toBe('function');
    }
  });

  it('applies defaults', () => {
    const lookupArgs = toolSchemas.dns_lookup!.parse({ domain: 'example.com' }) as {
      types: string[];
      resolver: string;
      transport: string;
    };
    expect(lookupArgs.types).toEqual(['A']);
    expect(lookupArgs.resolver).toBe('system');
    expect(lookupArgs.transport).toBe('auto');
    const waitArgs = toolSchemas.dns_wait!.parse({
      domain: 'example.com',
      type: 'A',
      rule: { kind: 'absent' },
    }) as { intervalSeconds: number; timeoutSeconds: number };
    expect(waitArgs.intervalSeconds).toBe(30);
    expect(waitArgs.timeoutSeconds).toBe(600);
    const hookArgs = toolSchemas.dns_watch_add!.parse({
      name: 'w1',
      domain: 'example.com',
      rule: { kind: 'absent' },
    }) as { intervalSeconds: number; hook: { kind: string } };
    expect(hookArgs.intervalSeconds).toBe(60);
    expect(hookArgs.hook).toEqual({ kind: 'none' });
    expect(toolSchemas.dns_watch_list!.parse({})).toEqual({});
  });

  it('rejects unknown record types and transports', () => {
    expect(() => toolSchemas.dns_lookup!.parse({ domain: 'example.com', types: ['BOGUS'] })).toThrow();
    expect(() =>
      toolSchemas.dns_lookup!.parse({ domain: 'example.com', transport: 'smoke' }),
    ).toThrow();
  });
});
