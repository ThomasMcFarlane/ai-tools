export type HookConfig =
  | { kind: 'none' }
  | { kind: 'exec'; command: string }
  | { kind: 'webhook'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'notify'; tool: 'claude' | 'codex' | 'opencode' };

export interface HookResult {
  ok: boolean;
  detail?: string;
}

export type HookEvent = object;
