// The cap of one Markdown drawing.
export const MARKDOWN_MAX = 100_000

/** The text of the first `# ` heading, else the file name without its extension. */
export const planTitle = (text: string, path: string): string => {
  const m = /^# +(.+?)\s*#*\s*$/m.exec(text)
  return m?.[1] ?? (path.split('/').pop() ?? path).replace(/\.md$/, '')
}

/** Whether `path` is the plan file already remembered from plan mode. */
export const isPlanPath = (path: string, known: string): boolean => path !== '' && path === known

/** The `.md` paths a reply mentions (bare, in backticks, in links, `file:` links), as written, in order, deduped. */
export const mdMentions = (text: string): string[] => {
  const found = text.replace(/file:(\/\/)?/g, '').match(/[\w@%+.~/-]+\.md(?!\w)/g) ?? []
  // The tasks-board mod already shows TASKS.md, so never offer it.
  return [...new Set(found.map(m => m.replace(/^\.\//, '')))].filter(m => !/(^|\/)tasks\.md$/i.test(m))
}

/** The text to draw, cut at the Markdown cap, and whether it was cut. */
export const clip = (text: string): { text: string; isCut: boolean } =>
  text.length > MARKDOWN_MAX ? { text: text.slice(0, MARKDOWN_MAX), isCut: true } : { text, isCut: false }
