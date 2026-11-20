import { formatMoney } from '../core/money.js';
import type { SearchHit } from '../core/types.js';
import type { Variant } from '../core/types.js';

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join('  ');
  return [line(headers), ...rows.map(line)].join('\n');
}

export interface HitTableOptions {
  showStock: boolean;
  showShop: boolean;
  timeZones?: string[];
}

export function formatSeen(iso: string, zones: string[]): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return zones
    .map((zone) => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(date);
      const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
      return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${zone}`;
    })
    .join(' | ');
}

export function priceCell(hit: SearchHit): string {
  const low = formatMoney(hit.price);
  return hit.priceMax === null || hit.priceMax === undefined
    ? low
    : `${low} - ${formatMoney(hit.priceMax)}`;
}

export function renderHits(hits: SearchHit[], opts: HitTableOptions): string {
  const headers = ['#', 'price', 'site'];
  if (opts.showShop) headers.push('shop');
  if (opts.showStock) headers.push('stock');
  headers.push('cond', 'title', 'seen', 'url');
  const rows = hits.map((hit, index) => {
    const row = [String(index + 1), priceCell(hit), hit.site];
    if (opts.showShop) row.push(truncate(hit.shop ?? '-', 24));
    if (opts.showStock) row.push(hit.stock);
    row.push(
      hit.condition,
      truncate(hit.title, 56),
      formatSeen(hit.seenAt, opts.timeZones ?? ['UTC']),
      hit.url,
    );
    return row;
  });
  return renderTable(headers, rows);
}

export function renderVariants(variants: Variant[]): string {
  if (variants.length === 0) return 'no variants found';
  return renderTable(
    ['variant', 'price', 'stock'],
    variants.map((variant) => [
      truncate(variant.name, 60),
      formatMoney(variant.price),
      variant.stock,
    ]),
  );
}
