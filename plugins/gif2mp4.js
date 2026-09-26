/**
 * gif2mp4.js — .gif2mp4 <url>  OR  reply to a GIF with .gif2mp4
 *
 * Owner/dev-only utility. NOT a player-facing game command — it exists so
 * whoever is authoring character art can convert a GIF (grabbed from Giphy
 * or wherever) into a real MP4 file ahead of time, instead of leaving a raw
 * external .gif URL sitting in data/characters.json for WhatsApp to fetch
 * and transcode live on every send (unreliable — see lib/converter.js's
 * gifToVideo() doc comment and plugins/tyla-alya-spin.js's GIF-handling
 * notes for the failure this avoids).
 *
 * Workflow: run this once per GIF, save the MP4 it sends back, re-host that
 * MP4 file somewhere reliable (own CDN/storage — not a re-uploaded giphy
 * link), then point the relevant character's `image` field in
 * data/characters.json at the new MP4 URL. No changes needed anywhere else
 * — ctx.replyGif already accepts either a Buffer or a URL for `image` (see
 * handler.js), so plugins/character.js and plugins/tyla-alya-spin.js keep
 * working unchanged once the URL/data behind character.image points at a
 * pre-converted MP4 instead of a raw GIF.
 *
 * Accepts:
 *   .gif2mp4 <url>        — fetches the GIF from the given URL
 *   .gif2mp4 (as a reply) — reads the quoted message; a GIF sent through
 *                           WhatsApp's own UI arrives as a videoMessage with
 *                           gifPlayback: true (see plugins/sticker.js's
 *                           note on this — WhatsApp has no native animated
 *                           image message type), so both imageMessage
 *                           (mimetype image/gif) and videoMessage are
 *                           accepted as input.
 *
 * Sends the result back two ways: once via ctx.replyGif so the author can
 * preview it autoplaying immediately, and once as a plain document
 * attachment so they can actually save the .mp4 file to re-host.
 */
import axios from 'axios'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { isOwnerJid } from '../lib/group-helpers.js'
import { gifToVideo } from '../lib/converter.js'
import { config } from '../config.js'

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

/** True if the resolved target is a GIF-shaped message (image/gif or any video, since
 * a GIF sent through WhatsApp's own UI arrives as a videoMessage — see sticker.js). */
function isGifShapedMessage(target) {
  const m = target?.message
  if (!m) return false
  if (m.videoMessage) return true
  if (m.imageMessage?.mimetype === 'image/gif') return true
  return false
}

/** Download a GIF URL as a Buffer. */
async function fetchGifBuffer(url) {
  const { data } = await axios.get(url, {
    responseType:     'arraybuffer',
    timeout:           30_000,
    maxContentLength:  Infinity,
    maxBodyLength:     Infinity,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  })
  return Buffer.from(data)
}

export default {
  name:        'gif2mp4',
  platforms:   ['whatsapp'],   // raw sock.sendMessage + Baileys downloadMediaMessage
  aliases:     ['gif2video', 'giftomp4'],
  category:    'admin',
  requiresPlayer: false,
  description: `${config.prefix}gif2mp4 <url> (or reply to a GIF) — owner-only: pre-convert a GIF to an MP4 for character art`,

  async run(ctx) {
    const { args, reply, sock, sender, msg, from } = ctx

    if (!from || !isOwnerJid(from)) {
      return reply(`❌ This command is restricted to the bot owner.`)
    }

    const urlArg = args[0]
    const target = resolveTarget(ctx)
    const hasQuotedGif = isGifShapedMessage(target)

    if (!urlArg && !hasQuotedGif) {
      return reply(
        `🎞️ *Usage:*\n` +
        `• *${config.prefix}gif2mp4 <url>* — convert a GIF from a URL\n` +
        `• Reply to a GIF with *${config.prefix}gif2mp4*\n\n` +
        `_Dev utility: converts a GIF into a real MP4 file ahead of time, so it can be_\n` +
        `_re-hosted and referenced in data/characters.json instead of a raw external GIF URL._`,
      )
    }

    await sock.sendMessage(sender, { react: { text: '🎞️', key: msg.key } }).catch(() => {})

    let gifBuffer
    try {
      gifBuffer = urlArg
        ? await fetchGifBuffer(urlArg)
        : await downloadMediaMessage(target, 'buffer', {})
    } catch (e) {
      await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } }).catch(() => {})
      return reply(`❌ Couldn't fetch the GIF: ${e.message || 'unknown error'}`)
    }

    let mp4Buffer
    try {
      mp4Buffer = await gifToVideo(gifBuffer)
    } catch (e) {
      await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } }).catch(() => {})
      return reply(`❌ Conversion failed: ${e.message || 'unknown error'}`)
    }

    try {
      // Autoplaying preview — lets the author eyeball it immediately.
      await ctx.replyGif(mp4Buffer, '✅ Converted — preview above.')

      // Plain file attachment — the actual .mp4 to save and re-host.
      await sock.sendMessage(
        sender,
        {
          document: mp4Buffer,
          fileName: `gif2mp4-${Date.now()}.mp4`,
          mimetype: 'video/mp4',
          caption:  `📎 *${(mp4Buffer.length / 1024).toFixed(0)} KB* — save this file and re-host it, then point the character's \`image\` field at the new URL.`,
        },
        { quoted: msg },
      )

      await sock.sendMessage(sender, { react: { text: '✅', key: msg.key } }).catch(() => {})
    } catch (e) {
      await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } }).catch(() => {})
      return reply(`❌ Conversion succeeded but sending the result failed: ${e.message || 'unknown error'}`)
    }
  },
}
