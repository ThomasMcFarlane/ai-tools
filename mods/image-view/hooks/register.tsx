import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ImageItem } from '../types/index'
import { baseName, convertArgvs, fitCells, hashOf, isImagePath, pngSize, PNG_MAX_BYTES, resolvePath, SHRINK_STEPS } from './image'

const PANE = 'image-view'
const COMMAND = 'image'
const USAGE = 'Usage: /image <path to a png, jpg, jpeg, gif or webp file>'
const SHOWN_MAX = 50
const ITEMS_MAX = 200
const PANE_ROWS = 30
const CHAT_ROWS = 18
const CHAT_COLUMNS = 80
const DECODED_MAX = 1_900_000

const shown = atom({ plugin: 'image-view', key: 'shown' } as const, [] as ImageItem[])
const at = atom({ plugin: 'image-view', key: 'at' } as const, 0)
const items = atom({ plugin: 'image-view', key: 'items' } as const, {} as Record<string, ImageItem>)
const count = atom({ plugin: 'image-view', key: 'count' } as const, 0)

type Picture = { png: string; width: number; height: number }

// Decoded pictures stay out of $.state (up to 2 MiB each); a reload or resume refills them on first draw.
const pictures = new Map<string, Picture>()
const loading = new Set<string>()

const message = (err: unknown) => String(err instanceof Error ? err.message : err)

const note = ($: EngineInterface, where: string, err: unknown) => {
  try {
    const text = message(err)
    $.ui.status(`image-view: ${where}: ${text.length > 80 ? `…${text.slice(-79)}` : text}`)
  } catch {
    /* nothing left to do */
  }
}

const pictureKey = (i: { path: string; mtimeMs: number }) => `${i.path}\0${i.mtimeMs}`

const bytesOf = async ($: EngineInterface, path: string): Promise<string> => {
  const r = await $.fs.read(path, { as: 'bytes' })
  return typeof r === 'string' ? r : r.base64
}

const decodedLength = (b64: string) => Math.floor((b64.length * 3) / 4)

const convert = async ($: EngineInterface, path: string, mtimeMs: number): Promise<string> => {
  const dir = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
  const failures: string[] = []
  for (const side of SHRINK_STEPS) {
    const out = `${dir}/image-view-${hashOf(`${path}${mtimeMs}`)}-${side}.png`
    for (const argv of convertArgvs(path, out, side)) {
      try {
        const ran = await $.process.run(argv, { timeoutMs: 20000 })
        if (ran.exitCode !== 0) {
          failures.push(`${argv[0]}: ${ran.stderr.trim().split('\n')[0] ?? 'failed'}`)
          continue
        }
        const png = await bytesOf($, out)
        await $.process.run(['rm', '-f', out]).catch(() => undefined)
        if (decodedLength(png) <= DECODED_MAX) return png
        failures.push(`${argv[0]}: result over 2 MiB at ${side}px`)
        break
      } catch (err) {
        failures.push(`${argv[0]}: ${message(err)}`)
      }
    }
  }
  throw new Error(`cannot decode ${baseName(path)} (needs ImageMagick or ffmpeg): ${failures.slice(-1)[0] ?? 'no converter'}`)
}

const prepare = async ($: EngineInterface, path: string): Promise<ImageItem> => {
  const st = await $.fs.stat(path)
  if (st.kind !== 'file') throw new Error(`${baseName(path)} is not a file`)
  const key = pictureKey({ path, mtimeMs: st.mtimeMs })
  const hit = pictures.get(key)
  if (hit) return { path, mtimeMs: st.mtimeMs, width: hit.width, height: hit.height }
  let png: string | undefined
  let size: { width: number; height: number } | undefined
  if (path.toLowerCase().endsWith('.png') && st.size <= PNG_MAX_BYTES) {
    const b64 = await bytesOf($, path)
    size = pngSize(b64)
    if (size) png = b64
  }
  if (!png) {
    png = await convert($, path, st.mtimeMs)
    size = pngSize(png)
  }
  if (!size) throw new Error(`${baseName(path)} did not decode to a PNG`)
  pictures.set(key, { png, ...size })
  for (const k of [...pictures.keys()].slice(0, Math.max(0, pictures.size - 20))) pictures.delete(k)
  return { path, mtimeMs: st.mtimeMs, ...size }
}

const warm = async ($: EngineInterface, item: ImageItem) => {
  const key = pictureKey(item)
  loading.add(key)
  try {
    await prepare($, item.path)
    $.ui.invalidate('ui.render')
  } catch (err) {
    note($, 'load', err)
  } finally {
    loading.delete(key)
  }
}

const place = async ($: EngineInterface, item: ImageItem) => {
  const n = (await read($, count)) + 1
  await update($, count, () => n)
  const id = `img-${n}`
  await update($, items, m => Object.fromEntries(Object.entries({ ...m, [id]: item }).slice(-ITEMS_MAX)))
  const placed = await $.ui.place({ id })
  if (!placed.isPlaced) note($, 'chat item', (placed as { reason?: string }).reason ?? 'not placed')
}

const display = async ($: EngineInterface, path: string) => {
  const item = await prepare($, path)
  const list = await read($, shown)
  const last = list[list.length - 1]
  const isRepeat = !!last && last.path === item.path && last.mtimeMs === item.mtimeMs
  if (!isRepeat) {
    await update($, shown, l => [...l, item].slice(-SHOWN_MAX))
    await place($, item)
  }
  await update($, at, () => Number.MAX_SAFE_INTEGER)
  await $.ui.open({ id: PANE, title: baseName(path) })
  return item
}

const clampAt = (list: ImageItem[], raw: number) => Math.min(Math.max(raw, 0), Math.max(list.length - 1, 0))

const picture = ($: EngineInterface, item: ImageItem): Picture | undefined => {
  const key = pictureKey(item)
  const hit = pictures.get(key)
  if (!hit && !loading.has(key)) void warm($, item)
  return hit
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: COMMAND, description: 'Show a local image (png, jpg, gif, webp) in the image pane and the chat', argumentHint: '<path>' })
    } catch (err) {
      note($, 'session.start', err)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const file = typeof (e as { file_path?: unknown }).file_path === 'string' ? (e as { file_path: string }).file_path : ''
    if (!file || !isImagePath(file)) return next(e)
    const ran = await next(e)
    try {
      if (ran.deny !== undefined || ran.isError === true) return ran
      const home = (await $.env.get('HOME')) ?? ''
      await display($, resolvePath(file, home, await $.session.cwd()))
    } catch (err) {
      note($, 'Read', err)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    try {
      const arg = e.args.trim()
      if (!arg) {
        if ((await $.ui.panes()).some(p => p.id === PANE)) {
          await $.ui.close({ id: PANE })
          return { text: 'Image pane closed.' }
        }
        const list = await read($, shown)
        if (!list.length) return { text: USAGE }
        await $.ui.open({ id: PANE, title: baseName(list[clampAt(list, await read($, at))].path) })
        return { text: 'Image pane opened.' }
      }
      const home = (await $.env.get('HOME')) ?? ''
      const path = resolvePath(arg, home, await $.session.cwd())
      if (!isImagePath(path)) return { text: `Not a png, jpg, jpeg, gif or webp file: ${path}` }
      if (!(await $.fs.exists(path))) return { text: `No such file: ${path}` }
      const item = await display($, path)
      return { text: `Showing ${baseName(path)} (${item.width} x ${item.height}).` }
    } catch (err) {
      note($, 'command.run', err)
      return { text: `Image failed: ${message(err)}` }
    }
  }).catch(() => ({ text: 'Image failed.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const list = await read($, shown)
    if (!list.length) return <Text dimColor>No image shown yet. Use /image &lt;path&gt;.</Text>
    const index = clampAt(list, await read($, at))
    const item = list[index]
    const pic = 'Image' in ui && e.surface === 'terminal' ? picture($, item) : undefined
    const go = (step: number) => () => update($, at, () => (index + step + list.length) % list.length)
    const many = list.length > 1
    const cells = fitCells(item.width, item.height, e.props.bodyColumns, PANE_ROWS)
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>{baseName(item.path)}</Text>
          <Text dimColor>{`  ${index + 1} of ${list.length}  ${item.width} x ${item.height}`}</Text>
        </Box>
        <Text dimColor wrap="truncate-middle">{item.path}</Text>
        {many ? (
          <Box>
            <Button key="prev" label="Prev" onPress={go(-1)} />
            <Button key="next" label="Next" onPress={go(1)} />
          </Box>
        ) : null}
        {'Image' in ui && e.surface === 'terminal' ? (
          pic ? <ui.Image source={{ png: pic.png }} columns={cells.columns} rows={cells.rows} alt={baseName(item.path)} /> : <Text dimColor>Loading image...</Text>
        ) : (
          <Text dimColor>This surface cannot draw images.</Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    try {
      if (e.props.plugin !== 'image-view') return next(e)
      const item = (await read($, items))[e.props.id]
      if (!item) return next(e)
      const ui = $.ui.resolve(e)
      const { Box, Text } = ui
      const pic = 'Image' in ui && e.surface === 'terminal' ? picture($, item) : undefined
      const width = Math.min(CHAT_COLUMNS, Math.max(10, (e.viewport?.columns ?? CHAT_COLUMNS + 4) - 4))
      const cells = fitCells(item.width, item.height, width, CHAT_ROWS)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
          <Text wrap="truncate-middle">
            <Text bold>{baseName(item.path)}</Text>
            <Text dimColor>{`  ${item.width} x ${item.height}  ${item.path}`}</Text>
          </Text>
          {'Image' in ui && e.surface === 'terminal' ? (
            pic ? <ui.Image source={{ png: pic.png }} columns={cells.columns} rows={cells.rows} alt={baseName(item.path)} /> : <Text dimColor>Loading image...</Text>
          ) : (
            <Text dimColor>Image not drawn on this surface.</Text>
          )}
        </Box>
      )
    } catch (err) {
      note($, 'Placed', err)
      return next(e)
    }
  }).catch(($, e, next) => next(e))
}
