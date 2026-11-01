# image-view

A Claude Code mod that shows images in the chat UI: the images Claude reads, and any local image on request. Claude Code draws terminal images only through mod `<Image>` elements, never for files it reads, so this mod draws them.

## Install

```
/plugin marketplace add ThomasMcFarlane/ai-tools
/plugin install image-view@ai-tools
```

## Behaviour

- When Claude's `Read` tool reads a `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` file, the image opens in a docked right-hand pane (`image-view`) and is placed in the chat as a bordered item with the file name, size and path. A file Claude writes or produces with Bash is shown once Claude reads it.
- `/image <path>` shows any local image the same way: absolute, `~/` or relative to the working directory, quoted or not. `/image` alone toggles the pane (and says how to use the command when nothing has been shown yet).
- The pane shows the latest image with its path and size. With more than one image it has `Prev` and `Next` and a counter. The chat items stay in the transcript.
- The same file at the same modification time is not placed in the chat twice in a row.

## How images are delivered

`<Image>` takes base64 PNG bytes, raw RGBA or a PNG file path read by the terminal. The mod hands it PNG bytes, which works over SSH because the pixels travel with the drawing.

- A PNG up to 1.5 MB is read and passed as is.
- Other formats, and larger PNGs, are converted to one PNG frame (the first frame of a GIF), shrunk to fit 1600, 1000 or 600 pixels until the result is under 2 MiB, using `magick`, `convert` or `ffmpeg` (the first that works). Without any of them only PNG files up to 1.5 MB can be shown.
- Decoded pictures are held in memory only, not in `$.state`; after a reload or `/resume` they are decoded again on first draw.

Terminals that cannot show graphics, and the desktop and VS Code surfaces, show a text line instead of the picture.

## Known limitation: herdr

Pictures draw in kitty, including over SSH, but stay blank inside herdr 0.9.5. The pane and chat item open with the right details and an empty picture area.

Claude Code draws every `<Image>` with Kitty Unicode placeholders (`U=1`), and herdr does not yet render those correctly (see herdrdev/herdr#4858 and #5614). Direct placement, as `icat` uses, does work through herdr. The mod cannot change this, because Claude Code chooses the mode.

`CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` lets Claude Code attempt graphics inside a multiplexer, so keep it set for when herdr's placeholder support is fixed. To see images today, run Claude Code outside herdr.

## Development

```
claude plugin validate mods/image-view
claude plugin test mods/image-view
```
