import { readFileSync } from 'node:fs';
import {
  agentPaths,
  appendLearning,
  effectiveLearnings,
  loadDefaults,
  type Learning,
  type NewLearning,
  type PathOptions,
} from '@ai-tools/agent-kit';
import {
  builtinDefaults,
  shopperDefaultsSchema,
  unknownSiteWarnings,
  type ShopperDefaults,
} from '../core/defaults.js';
import { createFetcher, type Fetcher } from '../core/fetcher.js';
import { ADAPTERS } from '../core/registry.js';
import { defaultRunDeps, type RunDeps } from '../core/run.js';
import type { SiteAdapter } from '../core/types.js';
import type { SpawnFn } from '../core/watch/notify.js';
import type { ExecInfo } from '../core/watch/timer.js';

export const AGENT = 'shopper';

export interface Deps {
  print: (text: string) => void;
  printErr: (text: string) => void;
  readStdin: () => Promise<string>;
  readFile: (path: string) => string;
  env: NodeJS.ProcessEnv;
  home?: string;
  now: () => Date;
  makeFetcher: () => Fetcher;
  adapters: readonly SiteAdapter[];
  spawn?: SpawnFn;
  exec?: ExecInfo;
}

export function defaultDeps(): Deps {
  return {
    print: (text) => console.log(text),
    printErr: (text) => console.error(text),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    readFile: (path) => readFileSync(path, 'utf8'),
    env: process.env,
    now: () => new Date(),
    makeFetcher: () => createFetcher(),
    adapters: ADAPTERS,
  };
}

export interface Ctx {
  deps: Deps;
  exitCode: number;
}

export interface StoreFlags {
  defaults?: string;
  memoryDir?: string;
}

export function pathOptions(deps: Deps, flags: StoreFlags): PathOptions {
  const opts: PathOptions = { env: deps.env };
  if (flags.memoryDir !== undefined) opts.memoryDir = flags.memoryDir;
  if (deps.home !== undefined) opts.home = deps.home;
  return opts;
}

export interface LoadedShopperDefaults {
  value: ShopperDefaults;
  source: string;
  file: string | null;
  warnings: string[];
}

export function loadShopperDefaults(
  deps: Deps,
  flags: StoreFlags,
  file?: string,
): LoadedShopperDefaults {
  const ids = deps.adapters.filter((a) => a.defaultMode !== 'user-browser').map((a) => a.id);
  const chosen = file ?? flags.defaults;
  const loaded = loadDefaults(AGENT, shopperDefaultsSchema, {
    ...pathOptions(deps, flags),
    ...(chosen === undefined ? {} : { file: chosen }),
    builtin: builtinDefaults(ids),
  });
  const value = loaded.value;
  const notify = deps.env.SHOPPER_NOTIFY_CMD;
  if (notify !== undefined && notify !== '') value.watch.notifyCommand = notify;
  return {
    value,
    source: loaded.source,
    file: loaded.file,
    warnings: unknownSiteWarnings(
      value,
      deps.adapters.map((a) => a.id),
    ),
  };
}

export function learningOptions(deps: Deps, flags: StoreFlags) {
  return { ...pathOptions(deps, flags), now: deps.now };
}

export function memoryFile(deps: Deps, flags: StoreFlags): string {
  return agentPaths(AGENT, pathOptions(deps, flags)).defaultsFile;
}

export function buildRunDeps(deps: Deps, flags: StoreFlags): RunDeps {
  const options = learningOptions(deps, flags);
  return defaultRunDeps({
    fetcher: deps.makeFetcher(),
    adapters: deps.adapters,
    learnings: effectiveLearnings(AGENT, options),
    recordLearning: (entry: NewLearning): Learning => appendLearning(AGENT, entry, options),
    now: deps.now,
  });
}
