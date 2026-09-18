import { fireHook as fireSharedHook } from '@ai-tools/hooks';
import { describeRule } from './matcher.js';
import type { HookConfig, HookResult, MatchRule, WatchEvent } from './types.js';

export type { HookResult } from '@ai-tools/hooks';

export function buildPrompt(event: WatchEvent, rule?: MatchRule): string {
  const values = event.values.length > 0 ? event.values.join(', ') : '(no values)';
  const lines = [
    `DNS watch "${event.watch}" matched: ${event.domain} ${event.type}.`,
    rule ? `The watch rule is: ${describeRule(rule)}.` : `The watch rule outcome is: ${event.reason}.`,
    `Reason: ${event.reason}`,
    `Current values: ${values}`,
    `Checked at: ${event.checkedAt}`,
    'Continue the task that created this watcher using these results.',
  ];
  return lines.filter((line) => line.length > 0).join('\n');
}

export async function fireHook(hook: HookConfig, event: WatchEvent): Promise<HookResult> {
  return fireSharedHook(hook, event, {
    envExtras: {
      DNS_EVENT: JSON.stringify(event),
      DNS_WATCH_NAME: event.watch,
      DNS_DOMAIN: event.domain,
      DNS_TYPE: event.type,
      DNS_MATCHED: String(event.matched),
      DNS_REASON: event.reason,
      DNS_VALUES: JSON.stringify(event.values),
    },
  });
}
