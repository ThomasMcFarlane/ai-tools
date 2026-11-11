import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GitFacts {
  toplevel(cwd: string): Promise<string | null>;
  branch(root: string): Promise<string | null>;
  head(root: string): Promise<string | null>;
  dirty(root: string): Promise<boolean>;
  originUrl(root: string): Promise<string | null>;
  rootCommit(root: string): Promise<string | null>;
  hasCommit(root: string, sha: string): Promise<boolean>;
  changedFiles(root: string, from: string, to: string): Promise<string[]>;
  trackedFiles(root: string): Promise<string[]>;
}

export interface Deps {
  now(): Date;
  git: GitFacts;
  stateRoot(): string;
  newId(prefix: 's' | 'q'): string;
  fileExists(absPath: string): Promise<boolean>;
  readText(source: string): Promise<string>;
  print(text: string): void;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      resolve(error === null ? stdout : null);
    });
  });
}

function lines(output: string | null): string[] {
  return output === null ? [] : output.split('\n').filter((l) => l.length > 0);
}

export function realGit(): GitFacts {
  const head = async (root: string): Promise<string | null> => {
    const out = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
    const sha = out?.trim() ?? '';
    return sha.length > 0 ? sha : null;
  };
  return {
    async toplevel(cwd) {
      const out = await git(cwd, ['rev-parse', '--show-toplevel']);
      const top = out?.trim() ?? '';
      return top.length > 0 ? top : null;
    },
    async branch(root) {
      if ((await head(root)) === null) {
        return null;
      }
      const out = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
      const name = out?.trim() ?? '';
      return name.length > 0 ? name : null;
    },
    head,
    async dirty(root) {
      const out = await git(root, ['status', '--porcelain']);
      return out !== null && out.trim().length > 0;
    },
    async originUrl(root) {
      const out = await git(root, ['remote', 'get-url', 'origin']);
      const url = out?.trim() ?? '';
      return url.length > 0 ? url : null;
    },
    async rootCommit(root) {
      const first = lines(await git(root, ['rev-list', '--max-parents=0', 'HEAD'])).sort()[0];
      return first ?? null;
    },
    async hasCommit(root, sha) {
      return (await git(root, ['cat-file', '-e', `${sha}^{commit}`])) !== null;
    },
    async changedFiles(root, from, to) {
      return lines(await git(root, ['diff', '--name-only', from, to]));
    },
    async trackedFiles(root) {
      return lines(await git(root, ['ls-files']));
    },
  };
}

function stateDir(): string {
  const override = process.env.AI_TOOLS_REPO_READY_STATE_DIR;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const xdg = process.env.XDG_STATE_HOME;
  const base =
    xdg !== undefined && xdg.length > 0
      ? xdg
      : process.platform === 'win32'
        ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
        : join(homedir(), '.local', 'state');
  return join(base, 'ai-tools', 'repo-ready');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function defaultDeps(): Deps {
  return {
    now: () => new Date(),
    git: realGit(),
    stateRoot: stateDir,
    newId(prefix) {
      let id = '';
      for (let i = 0; i < 8; i += 1) {
        id += randomInt(36).toString(36);
      }
      return `${prefix}${id}`;
    },
    async fileExists(absPath) {
      try {
        await access(absPath);
        return true;
      } catch {
        return false;
      }
    },
    readText: (source) => (source === '-' ? readStdin() : readFile(source, 'utf8')),
    print: (text) => {
      process.stdout.write(`${text}\n`);
    },
  };
}
