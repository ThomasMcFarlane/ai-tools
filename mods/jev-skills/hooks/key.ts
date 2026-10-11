export const DEFAULT_KEY_FILE = '.config/ai-tools/jev-compaction.env'

/** Parses `KEY=value` lines (`#` comments, optional `export`, optional quotes). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = (match[2] ?? '').trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '')
    out[match[1] as string] = value.trim()
  }
  return out
}

/** The key from file contents: the session variable first, else `TYPESAFE_API_KEY`; empty counts as missing. */
export function keyFromFile(text: string): string | undefined {
  const vars = parseEnvFile(text)
  return vars['JEV_COMPACTION_API_KEY'] || vars['TYPESAFE_API_KEY'] || undefined
}

/** Removes the key from a message that is about to be shown. */
export const redact = (text: string, key: string | undefined) => (key ? text.split(key).join('***') : text)
