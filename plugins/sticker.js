/**
 * sticker.js — .sticker / .s <optional pack name | author>
 *   .sticker                  — reply to (or send with) an image/video/gif,
 *                                converts it to a WhatsApp sticker
 *   .sticker <pack name>      — same, with a custom pack name
 *   .sticker <pack>|<author>  — pipe-separated pack name and author
 *
 * Accepts: imageMessage, videoMessage (short clips/gifs), and
 * stickerMessage (re-stickering, e.g. to relabel pack/author).
 * Video/gif input is auto-trimmed to a few seconds by lib/sticker.js so
 * WhatsApp doesn't silently drop an oversized animated sticker.
 *
 * Uses the same ffmpeg + node-webpmux conversion as plugins/stickerpack.js
 * (see lib/sticker.js — shared so the two don't drift into two different
 * implementations of the same conversion).
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { bufferToSticker } from '../lib/sticker.js'
import { config } from '../config.js'

const DEFAULT_PACK   = 'Astral'
const DEFAULT_AUTHOR = 'Astral Bot'

/** Resolve the quoted message (if replying) or fall back to the message itself. */
function resolveTarget(ctx) {
  const { msg, sender } = ctx
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
  if (!quoted) return msg
  return {
    key: {
      remoteJid:   sender,
      id:          msg.message.extendedTextMessage.contextInfo.stanzaId,
      participant: msg.message.extendedTextMessage.contextInfo.participant,
    },
    message: quoted,
  }
}

function detectMediaType(target) {
  const m = target?.message
  if (!m) return null
  if (m.imageMessage)   return 'image'
  if (m.stickerMessage) return 'sticker'
  if (m.videoMessage) {
    // Treat short/looping clips the same as gifs — both become animated
    // webp. gifPlayback is set on messages sent as "GIF" from WhatsApp's UI.
    return 'video'
  }
  return null
}

export default {
  name:        'sticker',
  platforms:   ['whatsapp'],   // WebP sticker pipeline is Baileys-specific
  requires:    ['stickers'],
  aliases:     ['s', 'stiker'],
  category:    'utility',
  description: `${config.prefix}sticker — reply to an image/video/gif to convert it into a sticker`,

  async run(ctx) {
    const { args, reply, sock, sender, msg } = ctx

    const target = resolveTarget(ctx)
    const mediaType = detectMediaType(target)

    if (!mediaType) {
      return reply(
        `🖼️ *Usage:*\n` +
        `• Reply to an image/video/gif with *${config.prefix}sticker*\n` +
        `• Or send an image/video with caption *${config.prefix}sticker*\n` +
        `• Optional: *${config.prefix}sticker PackName|Author*`,
      )
    }

    // Parse optional "PackName|Author" from args, same "pipe" convention as
    // most WhatsApp bots use for this command so it's a familiar syntax.
    const raw = args.join(' ').trim()
    let packName = DEFAULT_PACK
    let author   = DEFAULT_AUTHOR
    if (raw) {
      const [p, a] = raw.split('|').map(s => s?.trim()).filter(Boolean)
      if (p) packName = p
      if (a) author = a
    }

    await sock.sendMessage(sender, { react: { text: '🖌️', key: msg.key } }).catch(() => {})
    try {
      const buffer = await downloadMediaMessage(target, 'buffer', {})
      const webpBuffer = await bufferToSticker(buffer, packName, author, mediaType === 'video')

      await sock.sendMessage(sender, { sticker: webpBuffer }, { quoted: msg })
      await sock.sendMessage(sender, { react: { text: '✅', key: msg.key } }).catch(() => {})
    } catch (e) {
      await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } }).catch(() => {})
      return reply(`❌ Sticker conversion failed: ${e.message || 'unknown error'}`)
    }
  },
}
