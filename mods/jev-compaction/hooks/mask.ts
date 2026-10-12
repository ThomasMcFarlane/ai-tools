// Everything that leaves for Jev passes through here first: common secret shapes are masked.
const MASK = '***'
const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, MASK],
  [/-----BEGIN\b[^\n]*/g, MASK],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, MASK],
  [/\bBearer\s+[\w.~+/=-]{8,}/gi, `Bearer ${MASK}`],
  [/\b(Authorization:\s*Basic\s+)\S+/gi, `$1${MASK}`],
  [/\b((?:Set-)?Cookie:)[^\n]*/gi, `$1 ${MASK}`],
  [/(:\/\/[^/\s:@]+:)[^@\s]+@/g, `$1${MASK}@`],
  [/\b(?:sk|rk)_(?:live|test)_\w{10,}|\brk_\w{16,}/g, MASK],
  [/\bsk-[\w-]{16,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_\w{20,}/g, MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  [/\bxox[abprs]-[\w-]{10,}/g, MASK],
  [/\bAIza[\w-]{30,}/g, MASK],
  [/\bglpat-[\w-]{15,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{30,}/g, MASK],
  [/\bhf_[A-Za-z0-9]{25,}/g, MASK],
  [/(--pass(?:word|wd)?[= ]\s*)\S+/gi, `$1${MASK}`],
  [/(\b(?:mysql|mysqldump|mariadb|psql)\b[^\n|;&]*?\s-p)\S+/g, `$1${MASK}`],
  [/(\bcurl\b[^\n]*?\s(?:-u|--user)[= ]?\s*)[^\s]+/g, `$1${MASK}`],
  [/(["']?[\w.-]*(?:key|token|secret|pwd|passwd|password|pass(?![a-z]))[\w.-]*["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;"']+)/gi, `$1${MASK}`],
  // A long base64 or hex blob that holds a digit and a letter and stands alone, anywhere.
  [/(?<![\w-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}(?![\w-])(?!\.\w)/g, MASK],
]

/** Masks secret-looking values; the rest of the text is unchanged. */
export function maskSecrets(text: string): string {
  let out = text
  for (const [re, to] of RULES) out = out.replace(re, to)
  // A Kubernetes Secret: every long base64 value under `data:` / `stringData:`.
  if (/\bkind:\s*Secret\b/.test(out)) out = out.replace(/^(\s+[\w.-]+:\s*)[A-Za-z0-9+/]{40,}={0,2}\s*$/gm, `$1${MASK}`)
  return out
}

/** Masks every string inside a JSON-like value. */
export function maskDeep<T>(value: T): T {
  if (typeof value === 'string') return maskSecrets(value) as T
  if (Array.isArray(value)) return value.map(maskDeep) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)])) as T
  return value
}
