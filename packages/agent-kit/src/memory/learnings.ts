import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { agentPaths, type PathOptions } from './paths.js';

export const LEARNING_KINDS = ['block', 'selector', 'method', 'correction', 'note'] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

export const learningSchema = z.object({
  v: z.literal(1),
  ts: z.string().datetime({ offset: true }),
  agent: z.string().min(1),
  kind: z.enum(LEARNING_KINDS),
  site: z.string().min(1).nullable(),
  key: z.string().min(1),
  value: z.unknown(),
  expires: z.string().datetime({ offset: true }).nullable(),
  evidence: z.string().nullable(),
});

export type Learning = z.infer<typeof learningSchema>;

export interface NewLearning {
  kind: LearningKind;
  site?: string | null;
  key: string;
  value: unknown;
  expires?: string | null;
  evidence?: string | null;
}

export interface LearningsOptions extends PathOptions {
  now?: () => Date;
}

export class FlushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlushError';
  }
}

const UNFOLDED_KINDS: readonly LearningKind[] = ['correction', 'note'];

export function parseExpiry(text: string, now: Date): string {
  const relative = /^(\d+)\s*([mhdw])$/.exec(text.trim());
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
      relative[2] as 'm' | 'h' | 'd' | 'w'
    ];
    return new Date(now.getTime() + amount * unit).toISOString();
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid expiry '${text}': use 30m, 24h, 7d, 2w or an ISO date`);
  }
  return parsed.toISOString();
}

export function parseLearningLines(text: string): Learning[] {
  const out: Learning[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = learningSchema.safeParse(json);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function readLines(file: string): Learning[] {
  if (!existsSync(file)) return [];
  return parseLearningLines(readFileSync(file, 'utf8'));
}

export function readLearnings(agent: string, opts: LearningsOptions = {}): Learning[] {
  const paths = agentPaths(agent, opts);
  return [...readLines(paths.durableLearnings), ...readLines(paths.localLearnings)];
}

export function isExpired(entry: Learning, now: Date): boolean {
  return entry.expires !== null && new Date(entry.expires).getTime() <= now.getTime();
}

function byNewest(a: Learning, b: Learning): number {
  return b.ts < a.ts ? -1 : b.ts > a.ts ? 1 : 0;
}

export function foldLearnings(entries: Learning[], now: Date): Learning[] {
  const live = entries.filter((entry) => !isExpired(entry, now));
  const keyed = new Map<string, Learning>();
  const kept = new Map<string, Learning>();
  for (const entry of live) {
    if (UNFOLDED_KINDS.includes(entry.kind)) {
      kept.set(JSON.stringify([entry.kind, entry.site, entry.key, entry.ts, entry.value]), entry);
      continue;
    }
    const id = JSON.stringify([entry.kind, entry.site, entry.key]);
    const current = keyed.get(id);
    if (current === undefined || entry.ts >= current.ts) keyed.set(id, entry);
  }
  return [...[...keyed.values()].sort(byNewest), ...[...kept.values()].sort(byNewest)];
}

export function effectiveLearnings(agent: string, opts: LearningsOptions = {}): Learning[] {
  const now = (opts.now ?? (() => new Date()))();
  return foldLearnings(readLearnings(agent, opts), now);
}

export function appendLearning(
  agent: string,
  entry: NewLearning,
  opts: LearningsOptions = {},
): Learning {
  const now = (opts.now ?? (() => new Date()))();
  const learning = learningSchema.parse({
    v: 1,
    ts: now.toISOString(),
    agent,
    kind: entry.kind,
    site: entry.site ?? null,
    key: entry.key,
    value: entry.value === undefined ? null : entry.value,
    expires: entry.expires ?? null,
    evidence: entry.evidence ?? null,
  });
  const paths = agentPaths(agent, opts);
  mkdirSync(paths.stateDir, { recursive: true });
  const line = `${JSON.stringify(learning)}\n`;
  appendFileSync(paths.localLearnings, line);
  appendFileSync(paths.pendingLearnings, line);
  return learning;
}

export function liveBlock(learnings: Learning[], site: string, now: Date): Learning | null {
  return (
    learnings.find(
      (entry) => entry.kind === 'block' && entry.site === site && !isExpired(entry, now),
    ) ?? null
  );
}

export interface FlushResult {
  status: 'empty' | 'persisted';
  lines: number;
  method: 'none' | 'command' | 'append';
  target: string | null;
}

const FLUSHING = /^pending\.(\d+)\..*\.flushing$/;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function countLines(text: string): number {
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

function claimFiles(stateDir: string, pendingFile: string): string[] {
  const claimed: string[] = [];
  const stamp = Date.now();
  let index = 0;
  const claim = (from: string): void => {
    const target = join(
      stateDir,
      `pending.${process.pid}.${stamp}${index === 0 ? '' : `-${index}`}.flushing`,
    );
    try {
      renameSync(from, target);
      claimed.push(target);
      index += 1;
    } catch {
      return;
    }
  };
  if (existsSync(stateDir)) {
    for (const name of readdirSync(stateDir).sort()) {
      const match = FLUSHING.exec(name);
      if (match === null) continue;
      const pid = Number(match[1]);
      if (pid !== process.pid && pidAlive(pid)) continue;
      claim(join(stateDir, name));
    }
  }
  if (existsSync(pendingFile)) claim(pendingFile);
  return claimed;
}

function restore(files: string[], pendingFile: string): void {
  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8');
      if (text !== '') appendFileSync(pendingFile, text.endsWith('\n') ? text : `${text}\n`);
      rmSync(file, { force: true });
    } catch {
      continue;
    }
  }
}

function persistFile(
  agent: string,
  file: string,
  command: string | undefined,
  paths: ReturnType<typeof agentPaths>,
  env: NodeJS.ProcessEnv,
  text: string,
): 'command' | 'append' {
  if (command !== undefined && command !== '') {
    const filled = command.split('{agent}').join(agent).split('{file}').join(file);
    const result = spawnSync('/bin/sh', ['-c', filled], { encoding: 'utf8', env });
    if (result.status !== 0) {
      const detail = (result.stderr ?? '').trim();
      throw new FlushError(
        `AGENTS_MEMORY_PERSIST failed with exit ${result.status ?? 'signal'}${detail === '' ? '' : `: ${detail}`}`,
      );
    }
    return 'command';
  }
  try {
    mkdirSync(dirname(paths.durableLearnings), { recursive: true });
    appendFileSync(paths.durableLearnings, text.endsWith('\n') ? text : `${text}\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FlushError(
      `memory directory ${paths.memoryDir} is not writable (${reason}); set AGENTS_MEMORY_PERSIST to a command that stores {file}, or set AGENTS_MEMORY_DIR to a writable directory`,
    );
  }
  return 'append';
}

export function flushLearnings(agent: string, opts: LearningsOptions = {}): FlushResult {
  const env = opts.env ?? process.env;
  const paths = agentPaths(agent, opts);
  const command = env.AGENTS_MEMORY_PERSIST;
  const hasCommand = command !== undefined && command !== '';
  if (!hasCommand && env.AGENTS_MEMORY_READONLY === '1') {
    throw new FlushError(
      'the memory directory is read-only (AGENTS_MEMORY_READONLY=1); set AGENTS_MEMORY_PERSIST to a command that stores {file}',
    );
  }
  const claimed = claimFiles(paths.stateDir, paths.pendingLearnings);
  let total = 0;
  let method: FlushResult['method'] = 'none';
  const done = new Set<string>();
  try {
    for (const file of claimed) {
      const text = readFileSync(file, 'utf8');
      const lines = countLines(text);
      if (lines > 0) {
        method = persistFile(agent, file, command, paths, env, text);
        total += lines;
      }
      rmSync(file, { force: true });
      done.add(file);
    }
  } catch (error) {
    restore(
      claimed.filter((file) => !done.has(file)),
      paths.pendingLearnings,
    );
    throw error;
  }
  if (total === 0) return { status: 'empty', lines: 0, method: 'none', target: null };
  return {
    status: 'persisted',
    lines: total,
    method,
    target: method === 'append' ? paths.durableLearnings : null,
  };
}
