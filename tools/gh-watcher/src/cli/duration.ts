const USAGE_HINT = 'use a bare number for seconds or a unit suffix like 250ms, 30s, 5m, 1h';

export function parseDuration(input: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(input.trim());
  if (match === null) {
    throw new Error(`invalid duration "${input}": ${USAGE_HINT}`);
  }
  const amount = Number(match[1]);
  switch (match[2]) {
    case 'ms':
      return amount;
    case 'm':
      return amount * 60_000;
    case 'h':
      return amount * 3_600_000;
    default:
      return amount * 1000;
  }
}

export function formatDuration(ms: number): string {
  if (ms === 0) {
    return '0s';
  }
  if (ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}h`;
  }
  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  if (ms % 1000 === 0) {
    return `${ms / 1000}s`;
  }
  return `${ms}ms`;
}
