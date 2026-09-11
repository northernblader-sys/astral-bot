// ═══════════════════════════════════════════════════════
//   🌌 ASTRAL UTILITY — CONVERTER
//   lib/converter.js
//   toAudio / toPTT / toVideo / gifToVideo — ffmpeg buffer helpers
// ═══════════════════════════════════════════════════════

import { writeFile, readFile, unlink, mkdir } from 'fs/promises'
import { existsSync }                          from 'fs'
import { spawn }                               from 'child_process'
import { join, dirname }                       from 'path'
import { fileURLToPath }                       from 'url'
import axios                                   from 'axios'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMP_DIR  = join(__dirname, '../temp')

async function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) await mkdir(TEMP_DIR, { recursive: true })
}

/**
 * Run an ffmpeg conversion on a buffer.
 * @param {Buffer} buffer  - Input audio/video data
 * @param {string[]} args  - Extra ffmpeg flags
 * @param {string} ext     - Input extension  (e.g. 'm4a')
 * @param {string} ext2    - Output extension (e.g. 'mp3')
 * @returns {Promise<Buffer>}
 */
function ffmpeg(buffer, args = [], ext = '', ext2 = '') {
  return new Promise(async (resolve, reject) => {
    let tmp, out
    try {
      await ensureTempDir()
      tmp = join(TEMP_DIR, `${Date.now()}.${ext}`)
      out = `${tmp}.${ext2}`
      await writeFile(tmp, buffer)

      // Wrapped in try/finally below so tmp/out always get cleaned up —
      // including when ffmpeg fails to even start (the 'error' event),
      // which previously skipped cleanup entirely and leaked the input
      // file into temp/ on every failed conversion.
      spawn('ffmpeg', ['-y', '-i', tmp, ...args, out])
        .on('error', async (err) => {
          await unlink(tmp).catch(() => {})
          reject(err)
        })
        .on('close', async (code) => {
          try {
            if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}`))
            const result = await readFile(out)
            resolve(result)
          } catch (e) {
            reject(e)
          } finally {
            await unlink(tmp).catch(() => {})
            await unlink(out).catch(() => {})
          }
        })
    } catch (e) {
      if (tmp) await unlink(tmp).catch(() => {})
      reject(e)
    }
  })
}

/**
 * Convert any audio buffer → WhatsApp-playable MP3
 * @param {Buffer} buffer
 * @param {string} ext  - Source file extension
 */
export function toAudio(buffer, ext) {
  return ffmpeg(buffer, [
    '-vn',
    '-ac', '2',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'mp3',
  ], ext, 'mp3')
}

/**
 * Convert any audio buffer → WhatsApp PTT (voice note, opus)
 * @param {Buffer} buffer
 * @param {string} ext
 */
export function toPTT(buffer, ext) {
  return ffmpeg(buffer, [
    '-vn',
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-vbr', 'on',
    '-compression_level', '10',
  ], ext, 'opus')
}

/**
 * Convert any video buffer → WhatsApp-playable MP4
 * @param {Buffer} buffer
 * @param {string} ext
 */
export function toVideo(buffer, ext) {
  return ffmpeg(buffer, [
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-ab', '128k',
    '-ar', '44100',
    '-crf', '32',
    '-preset', 'slow',
  ], ext, 'mp4')
}

/**
 * Convert a GIF buffer → WhatsApp-playable, gifPlayback-compatible MP4.
 * No audio stream (GIFs have none) — video-only encode. Deliberately does
 * NOT reuse toVideo(): toVideo's `-c:a aac` flag expects a source audio
 * track to encode, and fails against a GIF's audio-less input.
 * @param {Buffer} buffer
 */
export function gifToVideo(buffer) {
  return ffmpeg(buffer, [
    '-movflags', 'faststart',
    '-pix_fmt', 'yuv420p',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // ensure even dimensions, x264 requirement
    '-c:v', 'libx264',
    '-crf', '23',
    '-preset', 'medium',
  ], 'gif', 'mp4')
}

// ── GIF → MP4 send helper (with per-source cache) ──────────────────────────
// WhatsApp/Baileys can't animate a raw .gif sent as a video message — it needs
// a real MP4 container (see gifToVideo above). This resolves a GIF *source*
// (http(s) URL, local path, or Buffer) to a WhatsApp-ready MP4 Buffer, so the
// live send paths (lib/image.js sendGif, handler.js replyGif) can transcode on
// the fly instead of shipping a raw .gif URL that silently fails to play.
//
// Results are cached per string source, so the same character's art isn't
// re-fetched/re-encoded on every send. A failed transcode is evicted from the
// cache so a later call (e.g. once ffmpeg is installed) can retry.
const gifMp4Cache = new Map()

/** True if a Buffer's magic bytes mark it as a GIF ("GIF87a" / "GIF89a"). */
function isGifBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 &&
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 // "GIF8"
}

async function fetchBuffer(url) {
  const { data } = await axios.get(url, {
    responseType:     'arraybuffer',
    timeout:           30_000,
    maxContentLength:  Infinity,
    maxBodyLength:     Infinity,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  })
  return Buffer.from(data)
}

/**
 * Resolve a GIF source to a WhatsApp-playable MP4 Buffer.
 *   - Buffer: transcoded only if it's actually a GIF; a non-GIF Buffer (e.g.
 *     an already-converted MP4 handed in by .gif2mp4) is returned untouched.
 *   - http(s) URL / local path: fetched/read, then transcoded. Cached per source.
 * Rejects if fetching or ffmpeg conversion fails — callers should catch and
 * fall back (e.g. to a static image).
 * @param {Buffer|string} source
 * @returns {Promise<Buffer>}
 */
export function gifSourceToVideo(source) {
  if (Buffer.isBuffer(source)) {
    return isGifBuffer(source) ? gifToVideo(source) : Promise.resolve(source)
  }

  if (gifMp4Cache.has(source)) return gifMp4Cache.get(source)

  const task = (async () => {
    const buf = /^https?:\/\//i.test(source) ? await fetchBuffer(source) : await readFile(source)
    return gifToVideo(buf)
  })()

  gifMp4Cache.set(source, task)
  task.catch(() => gifMp4Cache.delete(source)) // never cache a failure
  return task
}

export { ffmpeg }
