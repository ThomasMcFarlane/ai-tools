import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PathOptions {
  memoryDir?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

export function resolveMemoryDir(opts: PathOptions = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const configHome = nonEmpty(env.XDG_CONFIG_HOME) ?? join(home, '.config');
  return (
    nonEmpty(opts.memoryDir) ??
    nonEmpty(env.AGENTS_MEMORY_DIR) ??
    join(configHome, 'ai-tools', 'agents')
  );
}

export function resolveStateDir(opts: PathOptions = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const stateHome = nonEmpty(env.XDG_STATE_HOME) ?? join(home, '.local', 'state');
  return (
    nonEmpty(opts.stateDir) ??
    nonEmpty(env.AGENTS_STATE_DIR) ??
    join(stateHome, 'ai-tools', 'agents')
  );
}

export function resolveCacheDir(opts: PathOptions = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cacheHome = nonEmpty(env.XDG_CACHE_HOME) ?? join(home, '.cache');
  return join(cacheHome, 'ai-tools', 'agents');
}

export function agentMemoryDir(agent: string, opts: PathOptions = {}): string {
  return join(resolveMemoryDir(opts), agent);
}

export function agentStateDir(agent: string, opts: PathOptions = {}): string {
  return join(resolveStateDir(opts), agent);
}

export interface AgentPaths {
  memoryDir: string;
  stateDir: string;
  defaultsFile: string;
  durableLearnings: string;
  localLearnings: string;
  pendingLearnings: string;
}

export function agentPaths(agent: string, opts: PathOptions = {}): AgentPaths {
  const memoryDir = agentMemoryDir(agent, opts);
  const stateDir = agentStateDir(agent, opts);
  return {
    memoryDir,
    stateDir,
    defaultsFile: join(memoryDir, 'defaults.json'),
    durableLearnings: join(memoryDir, 'learnings.jsonl'),
    localLearnings: join(stateDir, 'learnings.jsonl'),
    pendingLearnings: join(stateDir, 'pending.jsonl'),
  };
}
