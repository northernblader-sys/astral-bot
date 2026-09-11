/**
 * plugins/cleanup.js
 * ─────────────────────────────────────────────────────────────────────────
 * Command : .cleanup
 * Aliases : .clearcache, .purgeimages
 * Access  : Bot admin only
 *
 * Immediately wipes all temporary / cached image files that pile up on disk:
 *   • temp/            — ffmpeg intermediate files (leftover if conversion crashed)
 *   • /tmp/astral-sticker/ — sticker temp files (leftover if sticker crashed)
 *   • media/pfp/       — local pfp files from before the ImgBB migration
 *   • media/banner/    — local banner files from before the ImgBB migration
 *   • media/guilds/    — local guild image files
 *
 * Reports total files deleted and bytes freed.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { readdir, unlink, stat } from 'fs/promises'
import { existsSync }            from 'fs'
import { join, dirname }         from 'path'
import { fileURLToPath }         from 'url'
import { tmpdir }                from 'os'
import { config }                from '../config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT      = join(__dirname, '..')

// Directories to wipe (all files inside, non-recursive for safety)
const FLAT_DIRS = [
  join(ROOT, 'temp'),
  join(tmpdir(), 'astral-sticker'),
  join(ROOT, 'media', 'pfp'),
  join(ROOT, 'media', 'banner'),
]

// Directories to wipe one level deep (files inside sub-folders)
const DEEP_DIRS = [
  join(ROOT, 'media', 'guilds'),
]

/**
 * Delete every file in `dir` (non-recursive).
 * Returns { count, bytes } of what was removed.
 */
async function wipeDir(dir) {
  if (!existsSync(dir)) return { count: 0, bytes: 0 }
  let count = 0, bytes = 0
  try {
    const entries = await readdir(dir)
    for (const entry of entries) {
      const full = join(dir, entry)
      try {
        const info = await stat(full)
        if (!info.isFile()) continue
        bytes += info.size
        await unlink(full)
        count++
      } catch {
        // file already gone or permission issue — skip silently
      }
    }
  } catch {
    // dir unreadable — skip
  }
  return { count, bytes }
}

/**
 * Wipe all files one level deep inside `dir` (files inside sub-folders,
 * but don't delete the sub-folders themselves).
 */
async function wipeDeep(dir) {
  if (!existsSync(dir)) return { count: 0, bytes: 0 }
  let count = 0, bytes = 0
  try {
    const subs = await readdir(dir)
    for (const sub of subs) {
      const subDir = join(dir, sub)
      try {
        const s = await stat(subDir)
        if (!s.isDirectory()) {
          // top-level file — wipe it too
          bytes += s.size
          await unlink(subDir).catch(() => {})
          count++
          continue
        }
        const result = await wipeDir(subDir)
        count += result.count
        bytes += result.bytes
      } catch {
        // skip
      }
    }
  } catch {
    // dir unreadable — skip
  }
  return { count, bytes }
}

function fmtBytes(b) {
  if (b < 1024)          return `${b} B`
  if (b < 1024 * 1024)   return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(2)} MB`
}

export default {
  name: 'cleanup',
  aliases: ['clearcache', 'purgeimages'],
  description: 'Wipe all cached/temp image files to free disk space. Bot admin only.',
  requiresAdmin: true,

  async run(ctx) {
    if (!ctx.isBotAdmin) {
      return ctx.reply('⛔ Only bot admins can run `.cleanup`.')
    }

    await ctx.reply('🧹 Cleaning up cached image files...')

    let totalCount = 0, totalBytes = 0

    for (const dir of FLAT_DIRS) {
      const r = await wipeDir(dir)
      totalCount += r.count
      totalBytes += r.bytes
    }

    for (const dir of DEEP_DIRS) {
      const r = await wipeDeep(dir)
      totalCount += r.count
      totalBytes += r.bytes
    }

    if (totalCount === 0) {
      return ctx.reply('✅ Nothing to clean — all temp/cache directories are already empty.')
    }

    return ctx.reply(
      `✅ *Cleanup complete!*\n\n` +
      `🗑️ Files deleted : *${totalCount}*\n` +
      `💾 Space freed   : *${fmtBytes(totalBytes)}*\n\n` +
      `_Wiped: temp/, sticker cache, media/pfp, media/banner, media/guilds_`
    )
  },
}
