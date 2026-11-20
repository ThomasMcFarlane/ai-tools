import type { Money } from './types.js';

const SYMBOLS: Array<[RegExp, string]> = [
  [/US\s*\$|USD|\$/i, 'USD'],
  [/฿|THB|บาท|baht/i, 'THB'],
  [/€|EUR/i, 'EUR'],
  [/£|GBP/i, 'GBP'],
  [/¥|JPY/i, 'JPY'],
  [/\bRM\b\s*\d|MYR/i, 'MYR'],
  [/₱|PHP/i, 'PHP'],
];

const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

function currencyOf(text: string, fallback: string): string {
  for (const [pattern, code] of SYMBOLS) {
    if (pattern.test(text)) return code;
  }
  return fallback;
}

export interface ParsedPrice {
  min: Money;
  max: Money | null;
}

const RANGE =
  /(\d[\d,]*(?:\.\d+)?)\s*(?:บาท|THB)?\s*(?:[-–~]|\bto\b|ถึง)\s*(?:฿|\$|€|£|THB|USD|US\s*\$)?\s*(\d[\d,]*(?:\.\d+)?)(?![\d,.]*\s*%)/i;

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

export function parsePrice(text: string, fallbackCurrency: string): ParsedPrice | null {
  const currency = currencyOf(text, fallbackCurrency);
  const range = RANGE.exec(text);
  if (range !== null) {
    const first = toNumber(range[1] ?? '');
    const second = toNumber(range[2] ?? '');
    if (Number.isFinite(first) && Number.isFinite(second)) {
      const low = Math.min(first, second);
      const high = Math.max(first, second);
      return {
        min: { amount: low, currency },
        max: high === low ? null : { amount: high, currency },
      };
    }
  }
  const matches = text.match(NUMBER);
  if (matches === null || matches[0] === undefined) return null;
  const amount = toNumber(matches[0]);
  if (!Number.isFinite(amount)) return null;
  return { min: { amount, currency }, max: null };
}

export function formatMoney(money: Money | null | undefined): string {
  if (money === null || money === undefined) return '-';
  const symbol =
    money.currency === 'THB' ? '฿' : money.currency === 'USD' ? '$' : `${money.currency} `;
  const text = money.amount.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(money.amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${symbol}${text}`;
}
