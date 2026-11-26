const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Replaces every lone UTF-16 surrogate with U+FFFD. Jev answers 400 "invalid Unicode text" to a request holding one. */
export function wellFormed(text: string): string {
  return LONE_SURROGATE.test(text) ? text.replace(LONE_SURROGATE, '�') : text
}

/** Every string inside a JSON-like value, made well formed. */
export function wellFormedDeep<T>(value: T): T {
  if (typeof value === 'string') return wellFormed(value) as T
  if (Array.isArray(value)) return value.map(wellFormedDeep) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [wellFormed(k), wellFormedDeep(v)])) as T
  return value
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

/** The first `n` UTF-16 units of `text`, without a surrogate pair cut in two. */
export function head(text: string, n: number): string {
  if (n >= text.length) return text
  const end = n > 0 && isHigh(text.charCodeAt(n - 1)) && isLow(text.charCodeAt(n)) ? n - 1 : n
  return text.slice(0, Math.max(0, end))
}

/** The last `n` UTF-16 units of `text`, without a surrogate pair cut in two. */
export function tail(text: string, n: number): string {
  if (n <= 0) return ''
  if (n >= text.length) return text
  const start = text.length - n
  return text.slice(isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1)) ? start + 1 : start)
}
