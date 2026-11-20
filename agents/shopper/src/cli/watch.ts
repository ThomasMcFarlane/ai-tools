import { realpathSync, rmSync } from 'node:fs';
import type { Command } from 'commander';
import { WATCH_EVENTS } from '../core/defaults.js';
import { ShopperError } from '../core/types.js';
import { formatSeen, renderTable, truncate } from './output.js';
import { readHistory, rotateHistory } from '../core/watch/history.js';
import { resolveNotifyCommand, shellSpawn, summaryLine } from '../core/watch/notify.js';
import {
  isDue,
  nextRunAt,
  runDue,
  runOne,
  type DueResult,
  type WatchDeps,
  type WatchRunResult,
} from '../core/watch/runner.js';
import {
  addWatch,
  editWatch,
  findWatch,
  historyFile,
  readWatches,
  removeWatch,
  specHash,
  watchesJsonSchema,
  watchPaths,
  type Watch,
  type WatchInput,
} from '../core/watch/store.js';
import {
  DEFAULT_EVERY,
  ENABLE_COMMAND,
  checkEvery,
  execArgs,
  renderUnits,
  unitDir,
  writeUnits,
  type ExecInfo,
} from '../core/watch/timer.js';
import {
  buildRunDeps,
  loadShopperDefaults,
  pathOptions,
  type Ctx,
  type Deps,
  type StoreFlags,
} from './context.js';
import { list, parseConditions } from './search-commands.js';

interface WatchFlags extends StoreFlags {
  id?: string;
  include?: string[];
  exclude?: string[];
  sites?: string;
  condition?: string;
  maxPrice?: string;
  currency?: string;
  interval?: string;
  on?: string;
  minDrop?: string;
  enable?: boolean;
  disable?: boolean;
  notify?: boolean;
  notifyCmd?: string;
  limit?: string;
  every?: string;
  write?: boolean;
  keepHistory?: boolean;
  json?: boolean;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function percent(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new ShopperError('--min-drop must be a number from 0 to 100');
  }
  return number;
}

function amount(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new ShopperError('--max-price must be a positive number or none');
  }
  return number;
}

export function parseWatchFlags(flags: WatchFlags, deps: Deps): WatchInput {
  const input: WatchInput = {};
  if (flags.id !== undefined) input.id = flags.id;
  if (flags.include !== undefined) input.include = flags.include;
  if (flags.exclude !== undefined) input.exclude = flags.exclude;
  if (flags.sites !== undefined) {
    if (flags.sites === 'all') {
      input.sites = null;
    } else {
      const ids = list(flags.sites);
      const known = new Set(deps.adapters.map((adapter) => adapter.id));
      for (const id of ids) {
        if (!known.has(id)) {
          throw new ShopperError(`unknown site '${id}': use ${[...known].join(', ')}`);
        }
      }
      input.sites = ids;
    }
  }
  if (flags.condition !== undefined) {
    input.condition = flags.condition === 'default' ? null : parseConditions(flags.condition);
  }
  if (flags.maxPrice !== undefined) {
    input.maxPrice = flags.maxPrice === 'none' ? null : amount(flags.maxPrice);
  }
  if (flags.currency !== undefined) {
    input.currency = flags.currency === 'default' ? null : flags.currency.toUpperCase();
  }
  if (flags.interval !== undefined) input.interval = flags.interval;
  if (flags.on !== undefined) {
    const events = list(flags.on);
    for (const event of events) {
      if (!(WATCH_EVENTS as readonly string[]).includes(event)) {
        throw new ShopperError(`unknown event '${event}': use ${WATCH_EVENTS.join(', ')}`);
      }
    }
    input.on = events;
  }
  if (flags.minDrop !== undefined) input.minDropPercent = percent(flags.minDrop);
  if (flags.enable === true && flags.disable === true) {
    throw new ShopperError('use --enable or --disable, not both');
  }
  if (flags.enable === true) input.enabled = true;
  if (flags.disable === true) input.enabled = false;
  return input;
}

function defaultExec(): ExecInfo {
  const script = process.argv[1] ?? '';
  let scriptPath = script;
  try {
    scriptPath = realpathSync(script);
  } catch {
    scriptPath = script;
  }
  return {
    execPath: process.execPath,
    scriptPath,
    packaged: (process as { pkg?: unknown }).pkg !== undefined,
  };
}

function makeWatchDeps(
  ctx: Ctx,
  flags: WatchFlags,
): { deps: WatchDeps; close: () => Promise<void> } {
  const { deps } = ctx;
  const loaded = loadShopperDefaults(deps, flags);
  const runDeps = buildRunDeps(deps, flags);
  const notifyFlag = flags.notifyCmd;
  return {
    deps: {
      runDeps,
      defaults: loaded.value,
      defaultsSource: loaded.source,
      paths: watchPaths(pathOptions(deps, flags)),
      now: deps.now,
      notifyCommand: resolveNotifyCommand(notifyFlag, deps.env, loaded.value.watch.notifyCommand),
      env: deps.env,
      spawn: deps.spawn ?? shellSpawn,
      print: flags.json === true ? null : deps.print,
    },
    close: () => runDeps.fetcher.close(),
  };
}

function wantsNotify(flags: WatchFlags): boolean {
  return flags.notify === true || (flags.notifyCmd !== undefined && flags.notifyCmd !== '');
}

function describeResult(ctx: Ctx, result: WatchRunResult): void {
  const { deps } = ctx;
  const flavour = result.baseline ? ', baseline run' : '';
  deps.print(
    `${result.watchId}: ${result.status}${flavour}, ${result.hits.length} hits, ${result.events.length} events`,
  );
  for (const item of result.skipped) deps.print(`${item.site}: skipped (${item.reason})`);
  for (const error of result.errors) deps.print(`error: ${error.site}: ${error.message}`);
  for (const [site, outcome] of Object.entries(result.sites)) {
    if (outcome.status === 'ok' || outcome.status === 'empty') continue;
    deps.print(
      `${site}: ${outcome.status}${outcome.reason === undefined ? '' : ` (${outcome.reason})`}`,
    );
  }
  if (result.notify !== null && !result.notify.ok) {
    deps.printErr(`notify failed: ${result.notify.error ?? 'unknown error'}`);
    if (result.message !== null) deps.printErr(result.message);
  } else if (result.message !== null && result.notify?.method !== 'stdout') {
    deps.print(result.message);
  }
}

function resultExit(result: WatchRunResult): number {
  if (result.status === 'error' || (result.notify !== null && !result.notify.ok)) return 2;
  return result.hits.length === 0 ? 1 : 0;
}

function describeDue(ctx: Ctx, due: DueResult): void {
  const { deps } = ctx;
  if (due.locked) {
    deps.print('another run holds the lock, nothing was run');
    return;
  }
  if (due.due.length === 0) deps.print('no watches due');
  for (const result of due.results) describeResult(ctx, result);
  for (const failure of due.failures)
    deps.printErr(`${failure.watchId}: failed: ${failure.message}`);
}

function dueExit(due: DueResult): number {
  if (due.failures.length > 0) return 2;
  for (const result of due.results) {
    if (result.status === 'error' || (result.notify !== null && !result.notify.ok)) return 2;
  }
  return 0;
}

function showWatch(ctx: Ctx, watch: Watch, zones: string[]): void {
  const { deps } = ctx;
  const when = (iso: string | null): string => (iso === null ? '-' : formatSeen(iso, zones));
  deps.print(`id: ${watch.id}`);
  deps.print(`query: ${watch.query}`);
  deps.print(`include: ${watch.spec.include.join(' , ') || '-'}`);
  deps.print(`exclude: ${watch.spec.exclude.join(' , ') || '-'}`);
  deps.print(`sites: ${watch.sites?.join(',') ?? 'from defaults'}`);
  deps.print(`condition: ${watch.condition?.join(',') ?? 'from defaults'}`);
  deps.print(`max price: ${watch.maxPrice ?? '-'}`);
  deps.print(`currency: ${watch.currency ?? 'from defaults'}`);
  deps.print(`interval: ${watch.interval}`);
  deps.print(`notify on: ${watch.notify.on.join(',')}`);
  deps.print(`min drop percent: ${watch.notify.minDropPercent}`);
  deps.print(`enabled: ${watch.enabled}`);
  deps.print(`last run: ${when(watch.lastRunAt)}`);
  deps.print(`last status: ${watch.lastStatus ?? '-'}`);
  deps.print(`next run: ${when(nextRunAt(watch, deps.now()))}`);
}

export function registerWatchCommands(program: Command, ctx: Ctx): void {
  const watch = program
    .command('watch')
    .description('scheduled price watches: add, list, run and send alerts');
  const { deps } = ctx;
  const paths = (flags: StoreFlags) => watchPaths(pathOptions(deps, flags));

  const sharedFlags = (command: Command): Command =>
    command
      .option('--include <regex>', 'title must match this regex (repeatable)', collect)
      .option('--exclude <regex>', 'drop titles that match this regex (repeatable)', collect)
      .option('--sites <ids>', 'comma-separated site ids, or all for the defaults')
      .option('--condition <list>', 'allowed conditions, or default for the defaults rules')
      .option('--max-price <n>', 'price threshold, or none to clear it')
      .option('--currency <code>', 'ISO 4217 code, or default for the defaults currency')
      .option('--interval <every>', 'time between runs: 15m minimum, units m, h and d')
      .option('--on <events>', `events to report: ${WATCH_EVENTS.join(', ')}`)
      .option('--min-drop <percent>', 'smallest price drop that counts, in percent');

  sharedFlags(
    watch
      .command('add <query...>')
      .description('add a watch')
      .option('--id <id>', 'watch id (default: slug of the query)')
      .option('--defaults <file>', 'defaults file')
      .option('--memory-dir <dir>', 'memory directory')
      .option('--json', 'print JSON'),
  ).action((words: string[], flags: WatchFlags) => {
    const loaded = loadShopperDefaults(deps, flags);
    const added = addWatch(
      paths(flags).watchesFile,
      { ...parseWatchFlags(flags, deps), query: words.join(' ') },
      loaded.value,
      deps.now(),
    );
    deps.print(
      flags.json === true
        ? JSON.stringify(added, null, 2)
        : `added ${added.id}: '${added.query}' every ${added.interval}`,
    );
  });

  watch
    .command('list')
    .description('list the watches')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action((flags: WatchFlags) => {
      const data = readWatches(paths(flags).watchesFile);
      if (flags.json === true) {
        deps.print(JSON.stringify(data.watches, null, 2));
        return;
      }
      if (data.watches.length === 0) {
        deps.print('no watches');
        return;
      }
      const now = deps.now();
      deps.print(
        renderTable(
          ['id', 'on', 'every', 'max', 'last status', 'due', 'query'],
          data.watches.map((entry) => [
            entry.id,
            entry.enabled ? 'yes' : 'no',
            entry.interval,
            entry.maxPrice === null ? '-' : String(entry.maxPrice),
            entry.lastStatus ?? '-',
            isDue(entry, now) ? 'yes' : 'no',
            truncate(entry.query, 48),
          ]),
        ),
      );
    });

  watch
    .command('show <id>')
    .description('print one watch')
    .option('--defaults <file>', 'defaults file')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action((id: string, flags: WatchFlags) => {
      const found = findWatch(readWatches(paths(flags).watchesFile), id);
      if (flags.json === true) {
        deps.print(JSON.stringify({ ...found, nextRunAt: nextRunAt(found, deps.now()) }, null, 2));
        return;
      }
      showWatch(ctx, found, loadShopperDefaults(deps, flags).value.report.timeZones);
    });

  sharedFlags(
    watch
      .command('edit <id>')
      .description('change a watch: a given list flag replaces the old list')
      .option('--enable', 'enable the watch')
      .option('--disable', 'disable the watch')
      .option('--memory-dir <dir>', 'memory directory')
      .option('--json', 'print JSON'),
  ).action((id: string, flags: WatchFlags) => {
    const input = parseWatchFlags(flags, deps);
    delete input.id;
    const where = paths(flags);
    const before = findWatch(readWatches(where.watchesFile), id);
    const updated = editWatch(where.watchesFile, id, input, deps.now());
    const rotated =
      specHash(before) === specHash(updated)
        ? null
        : rotateHistory(historyFile(where, id), deps.now());
    if (flags.json === true) {
      deps.print(JSON.stringify(updated, null, 2));
      return;
    }
    deps.print(
      rotated === null
        ? `updated ${updated.id}`
        : `updated ${updated.id}: history rotated, the next run is a baseline`,
    );
  });

  watch
    .command('remove <id>')
    .description('remove a watch and delete its history file')
    .option('--keep-history', 'keep the history file')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action((id: string, flags: WatchFlags) => {
      const where = paths(flags);
      const removed = removeWatch(where.watchesFile, id);
      if (flags.keepHistory !== true) rmSync(historyFile(where, id), { force: true });
      deps.print(
        flags.json === true ? JSON.stringify({ removed: removed.id }) : `removed ${removed.id}`,
      );
    });

  watch
    .command('run <id>')
    .description('run one watch now, record the result and print the events')
    .option('--notify', 'send the alert when there are events')
    .option(
      '--notify-cmd <command>',
      'alert command (overrides SHOPPER_NOTIFY_CMD), implies --notify',
    )
    .option('--defaults <file>', 'defaults file')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action(async (id: string, flags: WatchFlags) => {
      const { deps: watchDeps, close } = makeWatchDeps(ctx, flags);
      try {
        const found = findWatch(readWatches(watchDeps.paths.watchesFile), id);
        const result = await runOne(found, watchDeps, { notify: wantsNotify(flags) });
        if (result === null) {
          throw new ShopperError('another run holds the lock; try again later');
        }
        if (flags.json === true) deps.print(JSON.stringify(result, null, 2));
        else describeResult(ctx, result);
        ctx.exitCode = resultExit(result);
      } finally {
        await close();
      }
    });

  watch
    .command('run-due')
    .description('run every enabled watch that is due, one at a time (for the scheduler)')
    .option('--notify', 'send the alert when there are events')
    .option(
      '--notify-cmd <command>',
      'alert command (overrides SHOPPER_NOTIFY_CMD), implies --notify',
    )
    .option('--defaults <file>', 'defaults file')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action(async (flags: WatchFlags) => {
      const { deps: watchDeps, close } = makeWatchDeps(ctx, flags);
      try {
        const due = await runDue(watchDeps, { notify: wantsNotify(flags) });
        if (flags.json === true) deps.print(JSON.stringify(due, null, 2));
        else describeDue(ctx, due);
        ctx.exitCode = dueExit(due);
      } finally {
        await close();
      }
    });

  watch
    .command('history <id>')
    .description('print the last runs of a watch')
    .option('--limit <n>', 'number of runs to print', '10')
    .option('--defaults <file>', 'defaults file')
    .option('--memory-dir <dir>', 'memory directory')
    .option('--json', 'print JSON')
    .action((id: string, flags: WatchFlags) => {
      const watchPathsValue = paths(flags);
      findWatch(readWatches(watchPathsValue.watchesFile), id);
      const limit = Math.floor(Number(flags.limit));
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new ShopperError('--limit must be a positive number');
      }
      const lines = readHistory(historyFile(watchPathsValue, id), limit);
      if (flags.json === true) {
        deps.print(JSON.stringify(lines, null, 2));
        return;
      }
      if (lines.length === 0) {
        deps.print('no history yet');
        return;
      }
      const zones = loadShopperDefaults(deps, flags).value.report.timeZones;
      deps.print(
        renderTable(
          ['time', 'hits', 'sites ok', 'events'],
          lines.map((line) => {
            const sites = Object.values(line.sites);
            const ok = sites.filter((site) => site.status === 'ok' || site.status === 'empty');
            return [
              formatSeen(line.ts, zones),
              String(line.hits.length),
              `${ok.length}/${sites.length}`,
              line.events.length === 0
                ? '-'
                : summaryLine(id, line.events).replace(`shopper: ${id}: `, ''),
            ];
          }),
        ),
      );
    });

  watch
    .command('timer')
    .description('print or write the systemd user timer that runs the due watches')
    .option('--every <interval>', 'how often the timer runs, 15m minimum', DEFAULT_EVERY)
    .option('--write', 'write the unit files to the systemd user directory')
    .option('--json', 'print JSON')
    .action((flags: WatchFlags) => {
      const every = checkEvery(flags.every ?? DEFAULT_EVERY);
      const files = renderUnits(
        { every, exec: execArgs(deps.exec ?? defaultExec()) },
        unitDir(deps.env, deps.home),
      );
      if (flags.write === true) writeUnits(files);
      if (flags.json === true) {
        deps.print(
          JSON.stringify(
            {
              written: flags.write === true,
              files: [files.service, files.timer],
              command: ENABLE_COMMAND,
            },
            null,
            2,
          ),
        );
        return;
      }
      if (flags.write === true) {
        deps.print(`wrote ${files.service.path}`);
        deps.print(`wrote ${files.timer.path}`);
      } else {
        for (const file of [files.service, files.timer]) {
          deps.print(`# ${file.path}`);
          deps.print(file.content);
        }
      }
      deps.print(`run this to start the timer: ${ENABLE_COMMAND}`);
    });

  watch
    .command('schema')
    .description('print the JSON Schema of watches.json')
    .action(() => {
      deps.print(JSON.stringify(watchesJsonSchema(), null, 2));
    });
}
