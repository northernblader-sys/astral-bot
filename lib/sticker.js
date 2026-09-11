/**
 * lib/sticker.js — shared image/video → WhatsApp sticker (.webp) conversion.
 *
 * Extracted from plugins/stickerpack.js's original imageToSticker() so both
 * that plugin and plugins/sticker.js (convert-your-own-media) share one
 * ffmpeg/webpmux implementation instead of two copies drifting apart.
 *
 * Usage:
 *   import { bufferToSticker } from '../lib/sticker.js'
 *   const webpBuffer = await bufferToSticker(mediaBuffer, 'My Pack', 'Astral Bot')
 *
 * Works for both static images and short videos/gifs — ffmpeg produces an
 * animated webp automatically when the input has multiple frames, and a
 * static webp when it doesn't. No caller-side branching needed.
 */
import { exec }   from 'child_process'
import { tmpdir } from 'os'
import { join }   from 'path'
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import crypto     from 'crypto'
import webp       from 'node-webpmux'

// Video/gif input is capped in duration during conversion (see -t below) —
// WhatsApp animated stickers beyond ~6s tend to get rejected or truncated
// client-side anyway, so we trim proactively instead of sending something
// that silently fails to appear for the recipient.
const MAX_ANIMATED_SECONDS = 6

function getTmpDir() {
  const dir = join(tmpdir(), 'astral-sticker')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function runFfmpeg(cmd) {
  return new Promise((resolve, reject) => exec(cmd, (err) => (err ? reject(err) : resolve())))
}

function buildExif(packName, packAuthor) {
  const json = JSON.stringify({
    'sticker-pack-id':        crypto.randomBytes(32).toString('hex'),
    'sticker-pack-name':      packName,
    'sticker-pack-publisher': packAuthor,
    'emojis':                 ['✨'],
  })
  const jsonBuf  = Buffer.from(json, 'utf-8')
  const exifAttr = Buffer.from([
    0x49,0x49,0x2A,0x00,0x08,0x00,0x00,0x00,
    0x01,0x00,0x41,0x57,0x07,0x00,0x00,0x00,
    0x00,0x00,0x16,0x00,0x00,0x00,
  ])
  const exif = Buffer.concat([exifAttr, jsonBuf])
  exif.writeUIntLE(jsonBuf.length, 14, 4)
  return exif
}

async function attachExif(webpBuf, packName, packAuthor) {
  const img = new webp.Image()
  await img.load(webpBuf)
  img.exif = buildExif(packName, packAuthor)
  return img.save(null)
}

/**
 * Convert a raw media buffer (jpg/png/webp/mp4/gif — anything ffmpeg can
 * decode) into a WhatsApp sticker buffer with pack/author metadata baked in.
 *
 * @param {Buffer} buffer      - raw source media
 * @param {string}  packName   - shown as the sticker pack name in WhatsApp
 * @param {string}  author     - shown as the sticker pack author in WhatsApp
 * @param {boolean} isVideo    - true for video/gif input, applies duration
 *                                trim + framerate cap; false for a plain image
 */
export async function bufferToSticker(buffer, packName, author, isVideo = false) {
  const tmp  = getTmpDir()
  const id   = crypto.randomBytes(6).toString('hex')
  const inP  = join(tmp, `in_${id}`)
  const outP = join(tmp, `out_${id}.webp`)
  writeFileSync(inP, buffer)
  try {
    const trim = isVideo ? `-t ${MAX_ANIMATED_SECONDS} -r 15` : ''
    await runFfmpeg(
      `ffmpeg -y ${trim} -i "${inP}" ` +
      `-vf "crop=min(iw\\,ih):min(iw\\,ih),scale=512:512,format=rgba" ` +
      `-c:v libwebp -preset default -loop 0 -vsync 0 ` +
      `-pix_fmt yuva420p -quality 80 -compression_level 6 "${outP}"`,
    )
    const webpBuf = readFileSync(outP)
    return await attachExif(webpBuf, packName, author)
  } finally {
    try { unlinkSync(inP)  } catch {}
    try { unlinkSync(outP) } catch {}
  }
}
