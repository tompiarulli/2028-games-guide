/**
 * Rasterize public/favicon.svg into:
 *   - favicon.ico  (32x32 + 16x16) — browsers fetch this regardless of <link> tags
 *   - logo192.png  (192x192)        — PWA manifest + apple-touch-icon
 *   - logo512.png  (512x512)        — PWA manifest
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

/**
 * Encode an array of PNG buffers as a multi-image ICO file.
 * Reference: https://en.wikipedia.org/wiki/ICO_(file_format)
 */
function encodeIco(pngBuffers) {
  const HEADER_SIZE = 6
  const DIR_ENTRY_SIZE = 16
  const header = Buffer.alloc(HEADER_SIZE)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(pngBuffers.length, 4)

  const directory = Buffer.alloc(DIR_ENTRY_SIZE * pngBuffers.length)
  let offset = HEADER_SIZE + DIR_ENTRY_SIZE * pngBuffers.length

  for (const [i, png] of pngBuffers.entries()) {
    // PNG size is encoded in bytes 16-23 of the PNG header (big-endian)
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    const entryOffset = i * DIR_ENTRY_SIZE
    directory.writeUInt8(width >= 256 ? 0 : width, entryOffset)
    directory.writeUInt8(height >= 256 ? 0 : height, entryOffset + 1)
    directory.writeUInt8(0, entryOffset + 2) // no palette
    directory.writeUInt8(0, entryOffset + 3) // reserved
    directory.writeUInt16LE(1, entryOffset + 4) // color planes
    directory.writeUInt16LE(32, entryOffset + 6) // bits per pixel
    directory.writeUInt32LE(png.length, entryOffset + 8)
    directory.writeUInt32LE(offset, entryOffset + 12)
    offset += png.length
  }

  return Buffer.concat([header, directory, ...pngBuffers])
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const publicDir = path.join(root, 'public')
const svgPath = path.join(publicDir, 'favicon.svg')

const svg = fs.readFileSync(svgPath)

const [png16, png32, png192, png512] = await Promise.all([
  sharp(svg).resize(16, 16).png().toBuffer(),
  sharp(svg).resize(32, 32).png().toBuffer(),
  // iOS fills a transparent apple-touch-icon with black, so give the large icons the tile color
  sharp(svg).resize(192, 192).flatten({ background: '#0a0a0a' }).png().toBuffer(),
  sharp(svg).resize(512, 512).flatten({ background: '#0a0a0a' }).png().toBuffer(),
])

const ico = encodeIco([png32, png16])

await Promise.all([
  fs.promises.writeFile(path.join(publicDir, 'favicon.ico'), ico),
  fs.promises.writeFile(path.join(publicDir, 'logo192.png'), png192),
  fs.promises.writeFile(path.join(publicDir, 'logo512.png'), png512),
])
