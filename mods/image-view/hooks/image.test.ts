import { describe, expect, test } from 'claude-code/testing'

import { baseName, convertArgvs, extensionOf, fitCells, isImagePath, pngSize, resolvePath } from './image'

const PNG_4x2 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAACZgbYnAAAAEklEQVR4nGP4z8Dwn4GBgQEAFAAC/6a5wQAAAABJRU5ErkJggg=='

describe('image helpers', () => {
  test('recognises the supported extensions case-insensitively', () => {
    expect(['a.PNG', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp'].every(isImagePath)).toBe(true)
    expect(isImagePath('notes.md')).toBe(false)
    expect(extensionOf('/x/y')).toBe('')
  })
  test('resolves absolute, home and relative paths and strips quotes', () => {
    expect(resolvePath('/a/b.png', '/home/u', '/w')).toBe('/a/b.png')
    expect(resolvePath('~/b.png', '/home/u', '/w')).toBe('/home/u/b.png')
    expect(resolvePath('./shots/b.png', '/home/u', '/w/')).toBe('/w/shots/b.png')
    expect(resolvePath('"/a/my b.png"', '/home/u', '/w')).toBe('/a/my b.png')
  })
  test('reads the size from a PNG header', () => {
    expect(pngSize(PNG_4x2)).toEqual({ width: 4, height: 2 })
    expect(pngSize('AAAA')).toBeUndefined()
  })
  test('fits a picture into cells that are twice as tall as wide', () => {
    expect(fitCells(200, 100, 40, 30)).toEqual({ columns: 40, rows: 10 })
    expect(fitCells(100, 400, 40, 10)).toEqual({ columns: 5, rows: 10 })
    expect(fitCells(1, 1000, 255, 255).rows).toBeLessThanOrEqual(255)
  })
  test('builds converter commands without a shell', () => {
    const argvs = convertArgvs('/a/x y.webp', '/t/o.png', 600)
    expect(argvs.map(a => a[0])).toEqual(['magick', 'convert', 'ffmpeg'])
    expect(argvs[0][1]).toBe('/a/x y.webp[0]')
    expect(baseName('/a/b.png')).toBe('b.png')
  })
})
