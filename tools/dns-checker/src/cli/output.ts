import {
  summarise,
  type CompareGroup,
  type CompareRow,
  type CompareStatus,
} from '../core/compare.js';

export function formatTable(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export function printTable(rows: string[][]): void {
  console.log(formatTable(rows));
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export interface Painter {
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  magenta(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
}

export function colourEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = process.stdout.isTTY === true,
): boolean {
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') {
    return false;
  }
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0') {
    return true;
  }
  return isTty && env['TERM'] !== 'dumb';
}

export function createPainter(enabled: boolean): Painter {
  const wrap = (open: number, close: number) => (text: string) =>
    enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    green: wrap(32, 39),
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    magenta: wrap(35, 39),
    bold: wrap(1, 22),
    dim: wrap(2, 22),
  };
}

export interface Cell {
  text: string;
  paint?: (text: string) => string;
}

export function formatCells(rows: Cell[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.text.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, column) => {
          const pad = ' '.repeat((widths[column] ?? 0) - cell.text.length);
          const body = cell.paint ? cell.paint(cell.text) : cell.text;
          return column === row.length - 1 ? body : `${body}${pad}`;
        })
        .join('  '),
    )
    .join('\n');
}

function locationLabel(row: CompareRow): string {
  return row.location
    ? `${row.resolver} (${row.location.city}, ${row.location.countryCode})`
    : row.resolver;
}

function ttlOf(row: CompareRow): string {
  return row.answers.length === 0
    ? '-'
    : String(Math.min(...row.answers.map((answer) => answer.ttl)));
}

export function formatComparison(group: CompareGroup, painter: Painter): string {
  const paintFor = (status: CompareStatus): ((text: string) => string) =>
    status === 'match' ? painter.green : status === 'differ' ? painter.red : painter.magenta;
  const reference =
    group.referenceKind === 'expected'
      ? `expected ${group.reference.join(', ') || '(no records)'}`
      : `majority ${group.reference.join(', ') || '(no records)'}`;
  const lines: string[] = [
    painter.bold(`${group.domain} ${group.type}`) + painter.dim(`  ${reference}`),
  ];
  const located = group.rows.some((row) => row.location);
  const header: Cell[] = [
    { text: 'RESOLVER', paint: painter.bold },
    { text: 'ANSWER', paint: painter.bold },
    { text: 'STATUS', paint: painter.bold },
    { text: 'TTL', paint: painter.bold },
  ];
  const toRow = (row: CompareRow): Cell[] => {
    const answer =
      row.error !== undefined
        ? row.error.replace(/\s+/g, ' ')
        : row.answers.length === 0
          ? 'no records'
          : row.answers.map((a) => a.value).join(', ');
    const label = row.status === 'match' ? 'match' : row.status === 'differ' ? 'differ' : 'error';
    return [
      { text: locationLabel(row) },
      {
        text: answer,
        paint:
          row.status === 'error'
            ? painter.magenta
            : row.status === 'differ'
              ? painter.yellow
              : undefined,
      },
      { text: label, paint: paintFor(row.status) },
      { text: ttlOf(row) },
    ];
  };
  if (!located) {
    lines.push(formatCells([header, ...group.rows.map(toRow)]));
  } else {
    const byCountry = new Map<string, CompareRow[]>();
    for (const row of group.rows) {
      const key = row.location
        ? `${row.location.countryCode} ${row.location.country}`
        : 'Anycast / unlocated';
      const list = byCountry.get(key);
      if (list) {
        list.push(row);
      } else {
        byCountry.set(key, [row]);
      }
    }
    const keys = [...byCountry.keys()].sort((a, b) => {
      if (a === 'Anycast / unlocated') return 1;
      if (b === 'Anycast / unlocated') return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const body: Cell[][] = [header];
    const headings = new Map<number, string>();
    for (const key of keys) {
      headings.set(body.length, key);
      body.push(...(byCountry.get(key) ?? []).map(toRow));
    }
    const rendered = formatCells(body).split('\n');
    rendered.forEach((line, index) => {
      const heading = headings.get(index);
      if (heading !== undefined) {
        lines.push(painter.dim(`-- ${heading}`));
      }
      lines.push(line);
    });
  }
  const summary = summarise(group.rows);
  const parts = [
    painter.green(`${summary.match} match`),
    painter.red(`${summary.differ} differ`),
    painter.magenta(`${summary.error} error`),
  ];
  let line = `${painter.bold('summary:')} ${parts.join(', ')}`;
  if (summary.byCountry.length > 0) {
    line += painter.dim(
      `  by country: ${summary.byCountry.map((c) => `${c.countryCode} ${c.match}/${c.total}`).join(', ')}`,
    );
  }
  lines.push(line);
  return lines.join('\n');
}
