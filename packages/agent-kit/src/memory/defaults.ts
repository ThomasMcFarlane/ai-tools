import { existsSync, readFileSync } from 'node:fs';
import type { ZodTypeAny, z } from 'zod';
import { agentPaths, type PathOptions } from './paths.js';

export type DefaultsSource = 'flag' | 'env' | 'memory' | 'builtin';

export interface DefaultsIssue {
  path: string;
  message: string;
}

export class DefaultsError extends Error {
  readonly issues: DefaultsIssue[];
  readonly file: string | null;

  constructor(message: string, issues: DefaultsIssue[], file: string | null) {
    super(message);
    this.name = 'DefaultsError';
    this.issues = issues;
    this.file = file;
  }
}

export interface LoadDefaultsOptions extends PathOptions {
  file?: string;
  builtin: unknown;
}

export interface LoadedDefaults<S extends ZodTypeAny> {
  value: z.output<S>;
  source: DefaultsSource;
  file: string | null;
}

export function defaultsEnvName(agent: string): string {
  return `${agent.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_DEFAULTS`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) {
    return over === undefined ? base : over;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

function formatIssues(file: string | null, issues: DefaultsIssue[]): string {
  const lines = issues.map(
    (issue) => `  ${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`,
  );
  return `invalid defaults${file === null ? '' : ` in ${file}`}\n${lines.join('\n')}`;
}

export function validateDefaults<S extends ZodTypeAny>(
  schema: S,
  builtin: unknown,
  data: unknown,
  file: string | null,
): z.output<S> {
  const parsed = schema.safeParse(deepMerge(builtin, data));
  if (parsed.success) {
    return parsed.data as z.output<S>;
  }
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
  throw new DefaultsError(formatIssues(file, issues), issues, file);
}

export function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DefaultsError(`cannot read defaults file ${file}: ${reason}`, [], file);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DefaultsError(`defaults file ${file} is not valid JSON: ${reason}`, [], file);
  }
}

export function resolveDefaultsFile(
  agent: string,
  opts: Omit<LoadDefaultsOptions, 'builtin'>,
): { file: string | null; source: DefaultsSource } {
  const env = opts.env ?? process.env;
  if (opts.file !== undefined && opts.file !== '') {
    return { file: opts.file, source: 'flag' };
  }
  const fromEnv = env[defaultsEnvName(agent)];
  if (fromEnv !== undefined && fromEnv !== '') {
    return { file: fromEnv, source: 'env' };
  }
  const memoryFile = agentPaths(agent, opts).defaultsFile;
  if (existsSync(memoryFile)) {
    return { file: memoryFile, source: 'memory' };
  }
  return { file: null, source: 'builtin' };
}

export function loadDefaults<S extends ZodTypeAny>(
  agent: string,
  schema: S,
  opts: LoadDefaultsOptions,
): LoadedDefaults<S> {
  const { file, source } = resolveDefaultsFile(agent, opts);
  if (file === null) {
    return { value: validateDefaults(schema, opts.builtin, {}, null), source, file };
  }
  const data = readJsonFile(file);
  return { value: validateDefaults(schema, opts.builtin, data, file), source, file };
}
