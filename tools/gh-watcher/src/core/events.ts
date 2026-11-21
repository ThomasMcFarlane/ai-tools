/** Relay selection: the relay base URL comes from `--events-url` or GH_WATCHER_EVENTS_URL. */

export const EVENTS_URL_ENV = 'GH_WATCHER_EVENTS_URL';
/** The relay clamps a long-poll to this many seconds (gateway timeout). */
export const MAX_EVENT_WAIT_SECONDS = 25;

export function resolveEventsUrl(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = (flag ?? env[EVENTS_URL_ENV])?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
