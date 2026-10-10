// The cap of one Markdown drawing.
export const MARKDOWN_MAX = 100_000

/** The text of the first `# ` heading, else the file name without its extension. */
export const planTitle = (text: string, path: string): string => {
  const m = /^# +(.+?)\s*#*\s*$/m.exec(text)
  return m?.[1] ?? (path.split('/').pop() ?? path).replace(/\.md$/, '')
}

/** Whether `path` is a markdown file directly in `<configDir>/plans`, or the plan already remembered. */
export const isPlanPath = (path: string, configDir: string, known: string): boolean => {
  if (path === '') return false
  const prefix = `${configDir.replace(/\/+$/, '')}/plans/`
  return path === known || (path.startsWith(prefix) && path.endsWith('.md') && !path.slice(prefix.length).includes('/'))
}

/** The text to draw, cut at the Markdown cap, and whether it was cut. */
export const clip = (text: string): { text: string; isCut: boolean } =>
  text.length > MARKDOWN_MAX ? { text: text.slice(0, MARKDOWN_MAX), isCut: true } : { text, isCut: false }
