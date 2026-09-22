/**
 * card-media.js — the ONE send path for every card image in the bot.
 *
 * The Cards API pool is mixed media: most cards are jpg/png, but some are
 * animated .gif. Those two need different Baileys shapes on WhatsApp:
 *
 *   - still image → `{ image: { url }, caption }`
 *   - animated    → `{ video: <mp4 Buffer>, gifPlayback: true, caption }`
 *
 * Two bugs this fixes at once:
 *
 *   1. The spawn sweeps (main.js runCardSpawnSweep, lib/spawn-timer.js
 *      cardTick) and `.waifu spawn` sent EVERYTHING as `{ image }`, so a gif
 *      card arrived as a static first frame with no animation.
 *   2. plugins/card.js's sendCard() sent gif URLs as `{ video: { url } }`
 *      RAW — but WhatsApp/Baileys cannot animate a raw .gif served as a
 *      video message, it needs a real MP4 container (see
 *      lib/converter.js's gifSourceToVideo, and handler.js replyGif which
 *      already transcodes for exactly this reason). Those sends silently
 *      failed to play.
 *
 * So: gif URLs are transcoded to MP4 first (cached per source inside
 * gifSourceToVideo, failures evicted so a later send can retry), real video
 * URLs (.mp4/.webm) loop directly, and everything else goes as a still. A
 * gif whose transcode fails still degrades to its first frame as `{ image }`
 * rather than a video WhatsApp silently drops — same fallback ladder as
 * replyGif. And if the media send itself throws, the caption goes out as
 * plain text so a spawn's claim code is never lost to a dead image host
 * (the spawn IS already active in memory at that point).
 *
 * Callers: main.js, lib/spawn-timer.js, plugins/waifu.js, plugins/card.js.
 * Pokémon spawns (animated .gif sprites) can adopt this later — the helper
 * takes a bare URL, not a card object, so nothing about it is card-specific.
 */

import { gifSourceToVideo } from './converter.js'

/** True when the URL points at a GIF (extension check, query-tolerant). */
export function isGifUrl(url) {
  return /\.gif(\?|$)/i.test(String(url ?? ''))
}

/** True when the URL is already a real video container — loopable as-is. */
export function isDirectVideoUrl(url) {
  return /\.(mp4|webm)(\?|$)/i.test(String(url ?? ''))
}

/**
 * Build the Baileys media payload for a card URL. Never throws for a gif:
 * a failed transcode falls back to the still first frame. `extra` carries
 * through Baileys-accepted fields the caller wants on the message
 * (mentions, etc.).
 */
export async function cardMediaPayload(imageUrl, caption, extra = {}) {
  const text = String(caption ?? '')
  if (!imageUrl) return { text }

  if (isGifUrl(imageUrl)) {
    try {
      const mp4 = await gifSourceToVideo(imageUrl)
      return { video: mp4, gifPlayback: true, caption: text, ...extra }
    } catch {
      // Transcode failed (ffmpeg missing, fetch error) — still frame.
      return { image: { url: imageUrl }, caption: text, ...extra }
    }
  }

  if (isDirectVideoUrl(imageUrl)) {
    return { video: { url: imageUrl }, gifPlayback: true, caption: text, ...extra }
  }

  return { image: { url: imageUrl }, caption: text, ...extra }
}

/**
 * Send a card's media + caption. Resolves with the Baileys result, or null
 * if even the text fallback couldn't go out (the caller logs it).
 */
export async function sendCardMedia(sock, jid, imageUrl, caption, opts = {}) {
  const { quoted, ...extra } = opts
  const sendOpts = quoted ? { quoted } : undefined
  const payload = await cardMediaPayload(imageUrl, caption, extra)
  try {
    return await sock.sendMessage(jid, payload, sendOpts)
  } catch {
    try {
      return await sock.sendMessage(jid, { text: String(caption ?? '') }, sendOpts)
    } catch {
      return null
    }
  }
}
