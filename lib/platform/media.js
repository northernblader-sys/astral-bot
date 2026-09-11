/**
 * media.js — platform-neutral attachment fetching.
 *
 * Several game commands need the image the player just sent: .setpfp,
 * .setbanner, .guild icon, and the Premium purchase-screenshot flow. On
 * WhatsApp that means Baileys' downloadMediaMessage() against a message that
 * may be the command itself or the message it replied to. On Discord it's a
 * CDN url in message.attachments; on Telegram it's a file_id that has to be
 * resolved through getFile() first.
 *
 * Each adapter installs its own `ctx.getAttachment()` returning a Buffer or
 * null. This module is the single entry point plugins call, so no plugin has
 * to know which platform it's running on.
 */

import { logger } from '../../config.js'

/**
 * Fetch the image attached to (or quoted by) the current command.
 *
 * @param {object} ctx
 * @returns {Promise<Buffer|null>} image bytes, or null when none was sent
 */
export async function getAttachmentBuffer(ctx) {
  if (typeof ctx?.getAttachment !== 'function') {
    logger.warn({ platform: ctx?.platform }, 'getAttachmentBuffer: adapter did not install ctx.getAttachment')
    return null
  }

  try {
    const buf = await ctx.getAttachment()
    if (!buf) return null
    if (!Buffer.isBuffer(buf)) {
      logger.warn({ platform: ctx.platform }, 'ctx.getAttachment did not return a Buffer')
      return null
    }
    return buf
  } catch (err) {
    logger.warn({ err: err.message, platform: ctx?.platform }, 'Attachment download failed')
    return null
  }
}

/**
 * Download a remote URL into a Buffer, with a hard size cap.
 *
 * Used by the Discord and Telegram adapters, which both hand back a CDN url
 * rather than bytes. The cap matters: without it a player could point the bot
 * at a multi-gigabyte file and exhaust the VPS's memory, since the whole
 * response is buffered before ImgBB ever sees it.
 *
 * @param {string} url
 * @param {number} maxBytes  default 12 MB — comfortably above any avatar
 */
export async function fetchToBuffer(url, maxBytes = 12 * 1024 * 1024) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Attachment fetch failed: HTTP ${res.status}`)

  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared && declared > maxBytes) {
    throw new Error(`Attachment too large: ${Math.round(declared / 1048576)} MB (max ${Math.round(maxBytes / 1048576)} MB)`)
  }

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxBytes) {
    throw new Error(`Attachment too large: ${Math.round(buf.length / 1048576)} MB (max ${Math.round(maxBytes / 1048576)} MB)`)
  }
  return buf
}
