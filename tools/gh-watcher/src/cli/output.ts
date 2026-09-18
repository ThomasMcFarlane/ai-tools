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
