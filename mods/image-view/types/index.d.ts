export type ImageItem = {
  // absolute path of the image file
  path: string
  // file modification time (epoch ms) when it was read
  mtimeMs: number
  // pixel size of the picture handed to Image (after any shrinking)
  width: number
  height: number
}

declare module 'claude-code' {
  interface PluginState {
    'image-view': {
      // every image shown this session, oldest first
      shown: ImageItem[]
      // index into shown of the picture in the pane; clamped on read
      at: number
      // chat items placed, by placed id
      items: Record<string, ImageItem>
      // placed ids handed out so far
      count: number
    }
  }
}
