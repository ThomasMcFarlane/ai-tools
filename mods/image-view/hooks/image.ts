export const EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp']

export const PNG_MAX_BYTES = 1_500_000
export const SHRINK_STEPS = [1600, 1000, 600]

export const extensionOf = (path: string) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(path)
  return m ? m[1].toLowerCase() : ''
}

export const isImagePath = (path: string) => EXTENSIONS.includes(extensionOf(path))

export const resolvePath = (raw: string, home: string, cwd: string) => {
  const p = raw.trim().replace(/^(['"])(.*)\1$/, '$2')
  if (p.startsWith('/')) return p
  if (p === '~') return home
  if (p.startsWith('~/')) return `${home.replace(/\/+$/, '')}${p.slice(1)}`
  return `${cwd.replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`
}

export const pngSize = (base64: string): { width: number; height: number } | undefined => {
  let raw = ''
  try {
    raw = atob(base64.slice(0, 32))
  } catch {
    return undefined
  }
  if (raw.length < 24 || raw.slice(1, 4) !== 'PNG' || raw.slice(12, 16) !== 'IHDR') return undefined
  const int = (at: number) => ((raw.charCodeAt(at) << 24) | (raw.charCodeAt(at + 1) << 16) | (raw.charCodeAt(at + 2) << 8) | raw.charCodeAt(at + 3)) >>> 0
  const width = int(16)
  const height = int(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

// A terminal cell is about twice as tall as it is wide.
export const fitCells = (width: number, height: number, maxColumns: number, maxRows: number) => {
  const cap = Math.max(1, Math.min(255, Math.floor(maxColumns)))
  const rowCap = Math.max(1, Math.min(255, Math.floor(maxRows)))
  const ratio = height / width / 2
  let columns = cap
  let rows = Math.max(1, Math.round(columns * ratio))
  if (rows > rowCap) {
    rows = rowCap
    columns = Math.max(1, Math.min(cap, Math.round(rows / ratio)))
  }
  return { columns, rows }
}

export const convertArgvs = (src: string, out: string, side: number): string[][] => {
  const box = `${side}x${side}>`
  const magick = ['-auto-orient', '-resize', box, '-strip', `png:${out}`]
  return [
    ['magick', `${src}[0]`, ...magick],
    ['convert', `${src}[0]`, ...magick],
    ['ffmpeg', '-y', '-v', 'error', '-i', src, '-frames:v', '1', '-vf', `scale='min(${side},iw)':'min(${side},ih)':force_original_aspect_ratio=decrease`, '-f', 'image2', '-c:v', 'png', out],
  ]
}

export const hashOf = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export const baseName = (path: string) => path.split('/').pop() || path
