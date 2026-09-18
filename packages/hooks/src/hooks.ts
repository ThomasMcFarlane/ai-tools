import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HookConfig, HookEvent, HookResult } from './types.js';

const EXEC_TIMEOUT_MS = 60_000;
const WEBHOOK_TIMEOUT_MS = 60_000;
const NOTIFY_TIMEOUT_MS = 600_000;
const STDERR_TAIL_CHARS = 500;

export interface FireOptions {
  envExtras?: Record<string, string>;
  timeoutMs?: number;
}

function stderrTail(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 'no stderr output';
  }
  return trimmed.length > STDERR_TAIL_CHARS ? `...${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
}

function asRecord(event: HookEvent): Record<string, unknown> {
  return event as Record<string, unknown>;
}

export function summarizeEvent(event: HookEvent): string {
  const summary = asRecord(event)['summary'];
  if (typeof summary === 'string') {
    return summary;
  }
  return JSON.stringify(event);
}

export function buildPrompt(event: HookEvent): string {
  const summary = summarizeEvent(event);
  const json = JSON.stringify(event);
  const lines = [`Watcher event: ${summary}`];
  if (summary !== json) {
    lines.push(`Full event JSON: ${json}`);
  }
  lines.push('Continue the task that set up this watcher using these results.');
  return lines.join('\n');
}

function hookEnv(event: HookEvent, opts?: FireOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    EVENT: JSON.stringify(event),
    EVENT_SUMMARY: summarizeEvent(event),
    ...opts?.envExtras,
  };
}

function runProcess(
  command: string,
  args: string[],
  event: HookEvent,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  shell: boolean,
): Promise<HookResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const finish = (result: HookResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    const child = spawn(command, args, {
      shell,
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, detail: `hook timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      const detail =
        code === 'ENOENT'
          ? `command "${command}" not found on PATH`
          : `failed to start "${command}": ${error.message}`;
      finish({ ok: false, detail });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      finish({ ok: false, detail: `exit code ${code ?? 'unknown'}: ${stderrTail(stderr)}` });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(shell ? JSON.stringify(event) : undefined);
  });
}

async function fireWebhook(url: string, event: HookEvent, timeoutMs: number): Promise<HookResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      return { ok: true };
    }
    return { ok: false, detail: `webhook responded with status ${response.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `webhook request failed: ${message}` };
  }
}

async function fireFile(path: string, event: HookEvent): Promise<HookResult> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `failed to append to "${path}": ${message}` };
  }
}

function notifyCommand(tool: HookConfig & { kind: 'notify' }, prompt: string): { command: string; args: string[] } {
  switch (tool.tool) {
    case 'claude':
      return { command: 'claude', args: ['-p', prompt] };
    case 'codex':
      return { command: 'codex', args: ['exec', prompt] };
    case 'opencode':
      return { command: 'opencode', args: ['run', prompt] };
  }
}

async function fireNotify(
  hook: HookConfig & { kind: 'notify' },
  event: HookEvent,
  opts?: FireOptions,
): Promise<HookResult> {
  const { command, args } = notifyCommand(hook, buildPrompt(event));
  return runProcess(command, args, event, hookEnv(event, opts), opts?.timeoutMs ?? NOTIFY_TIMEOUT_MS, false);
}

export async function fireHook(hook: HookConfig, event: HookEvent, opts?: FireOptions): Promise<HookResult> {
  try {
    switch (hook.kind) {
      case 'none':
        return { ok: true };
      case 'exec':
        return await runProcess(
          hook.command,
          [],
          event,
          hookEnv(event, opts),
          opts?.timeoutMs ?? EXEC_TIMEOUT_MS,
          true,
        );
      case 'webhook':
        return await fireWebhook(hook.url, event, opts?.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
      case 'file':
        return await fireFile(hook.path, event);
      case 'notify':
        return await fireNotify(hook, event, opts);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `hook failed: ${message}` };
  }
}
