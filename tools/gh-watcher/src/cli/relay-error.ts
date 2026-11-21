import { RelayNotConfiguredError, RelayRequestError, RelayUnreachableError } from '../core/relay.js';
import { printJson } from './output.js';

export const POLLING_REMOVED_MESSAGE =
  'gh-watcher: polling was removed; gh-watcher always uses the relay (drop --source/--interval)';

const REMOVED_FLAGS = ['--source', '--interval', '--fallback-interval'];

/**
 * True when argv holds a removed polling flag. `watch add --interval` stays: it sets how often the
 * watch daemon reads the relay, not how often anything reads GitHub.
 */
export function usesRemovedFlag(argv: string[]): boolean {
  const args = argv.slice(2);
  const end = args.indexOf('--');
  const scanned = end < 0 ? args : args.slice(0, end);
  const watchAdd = scanned[0] === 'watch' && scanned[1] === 'add';
  return scanned.some((arg) =>
    REMOVED_FLAGS.some((flag) => (arg === flag || arg.startsWith(`${flag}=`)) && !(watchAdd && flag === '--interval')),
  );
}

/**
 * Report a relay failure the same way everywhere: exit code 2, and a JSON error when the command
 * prints JSON. Returns false for errors that are not relay failures.
 */
export function reportRelayError(error: unknown, json: boolean | undefined): boolean {
  if (error instanceof RelayNotConfiguredError) {
    if (json === true) {
      printJson({ error: 'relay_not_configured', message: error.message });
    }
    process.exitCode = 2;
    return true;
  }
  if (error instanceof RelayUnreachableError) {
    if (json === true) {
      printJson({ error: 'relay_unreachable', url: error.url, message: error.message });
    }
    process.exitCode = 2;
    return true;
  }
  if (error instanceof RelayRequestError) {
    if (json === true) {
      printJson({ error: 'relay_rejected', message: error.message });
    } else {
      console.error(`error: ${error.message}`);
    }
    process.exitCode = 2;
    return true;
  }
  return false;
}
