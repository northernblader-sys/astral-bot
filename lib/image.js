/**
 * lib/image.js — small reusable helper for sending an image + text caption
 * from ANY plugin, not just menu.js.
 *
 * Images are served from ImgBB (remote). Plugins still pass the same
 * filename they always did (e.g. 'menu-banner.jpg') — resolveImageSource()
 * maps it to the remote URL automatically. Local ./images/ fallback is kept
 * so any image not yet in the map still works during transition.
 *
 * Usage from a plugin (unchanged):
 *   import { sendImage } from '../lib/image.js'
 *   await sendImage(ctx, 'menu-banner.jpg', 'Some caption text')
 */

import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { localPathForAssetUrl } from './self-hosted-asset.js'
import { gifSourceToVideo } from './converter.js'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const IMAGES_DIR = path.join(__dirname, '..', 'images')
const VIDEOS_DIR = path.join(__dirname, '..', 'videos')

/**
 * Central map: base filename (no extension) → direct ImgBB URL.
 * Plugins pass filenames like 'menu-banner.jpg' — we strip the extension and
 * look up here first. Add new images here; remove the local file once confirmed.
 */
const IMAGES = {
  // Still awaiting a user-supplied ImgBB URL: 'urahara-tear'.
  // Missing keys intentionally fall back to the caption as plain text.
  //
  // Per-view banners added with the 2026-09-21 art drop:
  //   armor-shop   — .shop armor (plugins/shop.js)
  //   guild-*      — official art per guild, shown on .guild info (plugins/guild.js)
  //   premium      — .premium plans/status view (plugins/premium.js)
  //   top-up       — gem/mond/season-offer package lists (topup.js, monds.js, season.js)
  //   payment-done — buyer-facing "you got what you paid for" confirmation DMs
  //   rank-up      — the rank promotion announcement (lib/rank-up.js)
  'armor-shop':                'https://i.ibb.co/6RgWqj7f/armor-shop.jpg',
  'armor_shop':                'https://i.ibb.co/6RgWqj7f/armor-shop.jpg',
  'guild-astral-vanguard':     'https://i.ibb.co/n8jYTqB8/Vanguard.jpg',
  'guild-shadow-covenant':     'https://i.ibb.co/SDGHY92s/shdow.jpg',
  'guild-gilded-order':        'https://i.ibb.co/RGqS2XwB/gilded-order.jpg',
  'guild-stormbreakers':       'https://i.ibb.co/5XNnjzgn/stormbraker.jpg',
  'guild-emberwake':           'https://i.ibb.co/23BPJ3kG/emberwake.jpg',
  'premium':                   'https://i.ibb.co/prGbM4Mr/premium.jpg',
  'top-up':                    'https://i.ibb.co/rG4dKqLS/top-up.jpg',
  'top_up':                    'https://i.ibb.co/rG4dKqLS/top-up.jpg',
  'payment-done':              'https://i.ibb.co/x88P74cB/1046172188426924946.jpg',
  'payment_done':              'https://i.ibb.co/x88P74cB/1046172188426924946.jpg',
  'rank-up':                   'https://i.ibb.co/sdPTB84c/rank-up.jpg',
  'rank_up':                   'https://i.ibb.co/sdPTB84c/rank-up.jpg',
  'dragon-ultimate':           'https://i.ibb.co/mFBRDDNS/dragon-summon.jpg',
  'yoriichi-catform':          'https://i.ibb.co/gFynK9j8/yoruichi-god-of-thunder.jpg',
  'admin-banner':              'https://i.ibb.co/VcybVbg4/admin-banner.jpg',
  'background-default':        'https://i.ibb.co/BKFGtL3s/background-default.png',
  'background_default':        'https://i.ibb.co/BKFGtL3s/background-default.png',
  'cards-banner':              'https://i.ibb.co/Mkyfd2W1/Cotton-Candy.webp',
  'cards_banner':              'https://i.ibb.co/Mkyfd2W1/Cotton-Candy.webp',
  'character-default':         'https://i.ibb.co/PZ16z0rR/character-default.png',
  'character_default':         'https://i.ibb.co/PZ16z0rR/character-default.png',
  'character-banner':          'https://i.ibb.co/YSsyjRq/character-banner.jpg',
  'combat-banner':             'https://i.ibb.co/gFvwJxV4/combat-banner.jpg',
  'daily-card':                'https://i.ibb.co/8DY4h805/daily-card.jpg',
  'daily_card':                'https://i.ibb.co/8DY4h805/daily-card.jpg',
  'deposit-card':              'https://i.ibb.co/LDWcjFv7/deposit-card.jpg',
  'deposit_card':              'https://i.ibb.co/LDWcjFv7/deposit-card.jpg',
  'dungeon-banner':            'https://i.ibb.co/ZpwL3HDP/dungeon-banner.jpg',
  'economy-banner':            'https://i.ibb.co/5hTWn4Kr/economy-banner.jpg',
  'inventory-card':            'https://i.ibb.co/vC1rnhhQ/inventory-card.jpg',
  'inventory_card':            'https://i.ibb.co/vC1rnhhQ/inventory-card.jpg',
  'inventory-banner':          'https://i.ibb.co/F4C7Sykd/inventory-banner.jpg',
  'item-celestial-pickaxe':    'https://i.ibb.co/mVqDCM4n/item-celestial-pickaxe.jpg',
  'item_celestial_pickaxe':    'https://i.ibb.co/mVqDCM4n/item-celestial-pickaxe.jpg',
  'item-diamond-pickaxe':      'https://i.ibb.co/gbqKn8zF/item-diamond-pickaxe.jpg',
  'item_diamond_pickaxe':      'https://i.ibb.co/gbqKn8zF/item-diamond-pickaxe.jpg',
  'item-iron-pickaxe':         'https://i.ibb.co/n8BysZdy/item-iron-pickaxe.jpg',
  'item_iron_pickaxe':         'https://i.ibb.co/n8BysZdy/item-iron-pickaxe.jpg',
  'item-mythril-pickaxe':      'https://i.ibb.co/MxH0dSRX/item-mythril-pickaxe.jpg',
  'item_mythril_pickaxe':      'https://i.ibb.co/MxH0dSRX/item-mythril-pickaxe.jpg',
  'item-wooden-pickaxe':       'https://i.ibb.co/n8wrzvsN/item-wooden-pickaxe.jpg',
  'item_wooden_pickaxe':       'https://i.ibb.co/n8wrzvsN/item-wooden-pickaxe.jpg',
  'leaderboard-card':          'https://i.ibb.co/RGxrC5nL/leaderboard-card.jpg',
  'leaderboard_card':          'https://i.ibb.co/RGxrC5nL/leaderboard-card.jpg',
  'menu-banner':               'https://i.ibb.co/s9FxbDyq/menu-banner.jpg',
  'monster-default':           'https://i.ibb.co/GQRcvS38/monster-default.png',
  'monster_default':           'https://i.ibb.co/GQRcvS38/monster-default.png',
  'party-banner':              'https://i.ibb.co/9JncspX/party-banner.jpg',
  'pokemon-banner':            'https://i.ibb.co/MyVcCRmh/download.webp',
  'pokemon_banner':            'https://i.ibb.co/MyVcCRmh/download.webp',
  'pokemon-background':        'https://i.ibb.co/mZfsNTy/pokemon-battle-ground.jpg',
  'pokemon_background':        'https://i.ibb.co/mZfsNTy/pokemon-battle-ground.jpg',
  'premium-card':              'https://i.ibb.co/ynp998Mq/premium-card.jpg',
  'premium_card':              'https://i.ibb.co/ynp998Mq/premium-card.jpg',
  'rank-a-rank-hunter':        'https://i.ibb.co/qL19Fvqf/rank-a-rank-hunter.jpg',
  'rank_a_rank_hunter':        'https://i.ibb.co/qL19Fvqf/rank-a-rank-hunter.jpg',
  'rank-b-rank-hunter':        'https://i.ibb.co/0R3XJztH/rank-b-rank-hunter.jpg',
  'rank_b_rank_hunter':        'https://i.ibb.co/0R3XJztH/rank-b-rank-hunter.jpg',
  'rank-c-rank-hunter':        'https://i.ibb.co/C5YF8nGy/rank-c-rank-hunter.jpg',
  'rank_c_rank_hunter':        'https://i.ibb.co/C5YF8nGy/rank-c-rank-hunter.jpg',
  'rank-d-rank-hunter':        'https://i.ibb.co/LhkgWfP7/rank-d-rank-hunter.jpg',
  'rank_d_rank_hunter':        'https://i.ibb.co/LhkgWfP7/rank-d-rank-hunter.jpg',
  'rank-e-rank-hunter':        'https://i.ibb.co/N27P0WZq/rank-e-rank-hunter.jpg',
  'rank_e_rank_hunter':        'https://i.ibb.co/N27P0WZq/rank-e-rank-hunter.jpg',
  'rank-monarch':              'https://i.ibb.co/B2QmVgLL/rank-monarch.jpg',
  'rank_monarch':              'https://i.ibb.co/B2QmVgLL/rank-monarch.jpg',
  'rank-national-level-hunter':'https://i.ibb.co/5WSdDqwL/rank-national-level-hunter.jpg',
  'rank_national_level_hunter':'https://i.ibb.co/5WSdDqwL/rank-national-level-hunter.jpg',
  'rank-s-rank-hunter':        'https://i.ibb.co/r2sWBRr6/rank-s-rank-hunter.jpg',
  'rank_s_rank_hunter':        'https://i.ibb.co/r2sWBRr6/rank-s-rank-hunter.jpg',
  'rank-shadow-sovereign':     'https://i.ibb.co/Zzdf8W6X/rank-shadow-sovereign.jpg',
  'rank_shadow_sovereign':     'https://i.ibb.co/Zzdf8W6X/rank-shadow-sovereign.jpg',
  'rank-world-hunter':         'https://i.ibb.co/BHf82TrN/rank-world-hunter.jpg',
  'rank_world_hunter':         'https://i.ibb.co/BHf82TrN/rank-world-hunter.jpg',
  'season-banner':             'https://i.ibb.co/fGPHvWwx/download-1.jpg',
  'season_banner':             'https://i.ibb.co/fGPHvWwx/download-1.jpg',
  'rob-fail-card':             'https://i.ibb.co/7mzPZTZ/rob-fail-card.jpg',
  'rob_fail_card':             'https://i.ibb.co/7mzPZTZ/rob-fail-card.jpg',
  'rob-success-card':          'https://i.ibb.co/N21XXS2t/rob-success-card.jpg',
  'rob_success_card':          'https://i.ibb.co/N21XXS2t/rob-success-card.jpg',
  'shop':                      'https://i.ibb.co/CpS1wXM9/astral-shop.jpg',
  'social-banner':             'https://i.ibb.co/S7tstbXX/social-banner.jpg',
  'town-banner':               'https://i.ibb.co/mr0TfYqj/town-banner.jpg',
  'unban-form':                'https://i.ibb.co/6RqrmDsY/Whats-App-Image-2026-08-19-at-19-12-43.jpg',
  'unban_form':                'https://i.ibb.co/6RqrmDsY/Whats-App-Image-2026-08-19-at-19-12-43.jpg',
  'utility-banner':            'https://i.ibb.co/rfKDMD39/utility-banner.jpg',
  'willow-advisory':           'https://i.ibb.co/HLDPynLD/Gemini-Generated-Image-x3qnefx3qnefx3qn.png',
  'willow_advisory':           'https://i.ibb.co/HLDPynLD/Gemini-Generated-Image-x3qnefx3qnefx3qn.png',
  'withdraw-card':             'https://i.ibb.co/rK3WL5v7/withdraw-card.jpg',
  'withdraw_card':             'https://i.ibb.co/rK3WL5v7/withdraw-card.jpg',
  'work-card':                 'https://i.ibb.co/9kVzzk5D/work-card.jpg',
  'work_card':                 'https://i.ibb.co/9kVzzk5D/work-card.jpg',

  // Season Packs (plugins/pack.js). 'pack-overview' is the general banner shown
  // on the browse view; the rest are the per-pack art shown on `.pack info`.
  // Totem Pack has no dedicated art yet, so its info view reuses 'pack-overview'.
  'pack-overview':             'https://i.ibb.co/Gfr4RS1v/Gemini-Generated-Image-w6xzt8w6xzt8w6xz.jpg',
  'pack-space-sifter':         'https://i.ibb.co/wh8nt2PB/Space-Sifter.jpg',
  'pack-red-monster':          'https://i.ibb.co/Qvf0G3Ln/Red-Monster.jpg',
  'pack-dark-monarch':         'https://i.ibb.co/5hrsCBBy/Dark-monarch.jpg',
  'pack-knights-of-the-sicilian':'https://i.ibb.co/WvyDpw8G/Knights-of-the-Sicilian.jpg',
  'pack-gemstone':             'https://i.ibb.co/JWzS73qb/Gemstone.jpg',
  'pack-arlnord-divine-armor': 'https://i.ibb.co/fVyhBnWj/Arlnord-s-Divine-Armor.jpg',
}

/**
 * Resolve a filename to a remote URL (via the map above), or fall back to a
 * local path inside ./images/ if the image isn't in the map yet. Full
 * http(s) URLs are returned unchanged — so callers can always pass either.
 */
export function resolveImageSource(nameOrUrl) {
  if (/^https?:\/\//i.test(nameOrUrl)) {
    // One of our own /assets/ URLs: hand back the file on disk. Baileys would
    // otherwise fetch item art from Cloudflare and back into this same
    // process, which fails whenever the tunnel is down even though the PNG is
    // local. Non-ours (ImgBB banners, player pfps) stay remote.
    return localPathForAssetUrl(nameOrUrl) ?? nameOrUrl
  }
  // Normalise: strip extension and look up in the remote map
  const base = nameOrUrl.replace(/\.[^.]+$/, '')
  if (IMAGES[base]) return IMAGES[base]
  // Not in map — fall back to local file
  return path.join(IMAGES_DIR, nameOrUrl)
}

/**
 * Send an image with a caption. `image` can be:
 *   - a filename  (e.g. 'menu-banner.jpg') — resolved via map above
 *   - a full http(s) URL                   — used as-is
 *   - a raw Buffer                          — passed straight to Baileys
 *
 * If a local filename doesn't exist on disk (and it's not in the remote map),
 * falls back to a plain text reply instead of crashing.
 */
export async function sendImage(ctx, image, caption = '', opts = {}) {
  return sendImageTo(ctx, image, caption, ctx.sender, opts)
}

/**
 * Discord path for sendImage/sendImageTo. Baileys' { image, caption } shape
 * (what the rest of this file speaks) isn't a Discord.js API — sending it
 * through ctx.sock.sendMessage() there was landing as a bare file attachment
 * (Discord's fallback for anything it doesn't recognise as an embed), which
 * is why menu images were showing up looking like a raw file download
 * instead of a banner. A proper Discord image reply is an embed with
 * .setImage(), the same pattern plugins-discord/serverinfo.js and
 * userinfo.js already use — so route through that instead of the WhatsApp
 * wire format whenever ctx.platform is 'discord'.
 *
 * discord.js is imported lazily here so WhatsApp-only calls (the vast
 * majority of sendImage's callers) never pay to load it.
 */
async function sendImageDiscord(ctx, image, caption = '', opts = {}) {
  const { EmbedBuilder } = await import('discord.js')

  const embed = new EmbedBuilder()
  if (caption) embed.setDescription(String(caption).slice(0, 4096))

  if (Buffer.isBuffer(image)) {
    // AttachmentBuilder path: Discord can embed a locally-provided buffer by
    // uploading it and referencing it back via attachment://<name>.
    const { AttachmentBuilder } = await import('discord.js')
    const filename = 'image.png'
    const attachment = new AttachmentBuilder(image, { name: filename })
    embed.setImage(`attachment://${filename}`)
    return ctx.channel.send({ embeds: [embed], files: [attachment] })
  }

  if (typeof image === 'string') {
    try {
      const { itemArtBufferForUrl } = await import('./item-art-cache.mjs')
      const plate = await itemArtBufferForUrl(image)
      if (plate) {
        const { AttachmentBuilder } = await import('discord.js')
        const filename = 'image.png'
        const attachment = new AttachmentBuilder(plate, { name: filename })
        embed.setImage(`attachment://${filename}`)
        return ctx.channel.send({ embeds: [embed], files: [attachment] })
      }
    } catch { /* fall through to the normal resolve path */ }
  }

  const source = resolveImageSource(image)
  const isLocal = !/^https?:\/\//i.test(source)

  if (isLocal) {
    if (!existsSync(source)) {
      // Missing local file: retry with the caller's fallback before giving up
      // on the picture, same ladder as the WhatsApp path.
      if (opts.fallbackImage && opts.fallbackImage !== image) {
        return sendImageDiscord(ctx, opts.fallbackImage, caption)
      }
      return ctx.channel.send({ content: String(caption || `⚠️ Image "${image}" not found.`) })
    }
    const { AttachmentBuilder } = await import('discord.js')
    const filename = path.basename(source)
    const attachment = new AttachmentBuilder(source, { name: filename })
    embed.setImage(`attachment://${filename}`)
    return ctx.channel.send({ embeds: [embed], files: [attachment] })
  }

  embed.setImage(source)
  try {
    return await ctx.channel.send({ embeds: [embed] })
  } catch {
    if (opts.fallbackImage && opts.fallbackImage !== image) {
      return sendImageDiscord(ctx, opts.fallbackImage, caption)
    }
    return ctx.channel.send({ content: String(caption) })
  }
}

/**
 * Send an image to an explicit recipient. This is used by combat passives
 * that must DM the player even when the triggering command came from a group.
 *
 * Media failure NEVER costs the caption. Three layers, in order:
 *   1. the requested image;
 *   2. `opts.fallbackImage`, if the first one couldn't be sent;
 *   3. the caption as a plain text message.
 *
 * Layer 3 used to only cover a missing LOCAL file — a remote URL was handed
 * straight to Baileys, which fetches it itself and THROWS when the fetch
 * fails. Any dead image host therefore took out the entire reply: `.shop info
 * <item>` sent no artwork *and* no item details, because every catalog entry's
 * `image` points at our own origin and that origin was returning 521. A broken
 * picture must degrade to text, not to silence.
 */
export async function sendImageTo(ctx, image, caption = '', recipient = ctx.sender, opts = {}) {
  if (ctx.platform === 'discord') {
    return sendImageDiscord(ctx, image, caption, opts)
  }

  const quoted = recipient === ctx.sender ? { quoted: ctx.msg } : undefined
  const asText = () => ctx.sock.sendMessage(recipient, { text: String(caption) }, quoted)

  if (Buffer.isBuffer(image)) {
    try {
      return await ctx.sock.sendMessage(recipient, { image, caption: String(caption) }, quoted)
    } catch {
      return asText()
    }
  }

  // Try the requested image, then the caller's fallback, then plain text.
  const candidates = [image]
  if (opts.fallbackImage && opts.fallbackImage !== image) candidates.push(opts.fallbackImage)

  for (const candidate of candidates) {
    try {
      const sent = await sendOneImage(ctx, candidate, caption, recipient, quoted)
      if (sent) return sent
    } catch { /* try the next candidate */ }
  }

  return asText()
}

/**
 * One send attempt for a filename/URL. Returns the Baileys result, or null when
 * this candidate is unusable (missing local file) so the caller can move on to
 * the next one. Throws only if sendMessage itself throws, which sendImageTo
 * catches.
 */
async function sendOneImage(ctx, image, caption, recipient, quoted) {
  // Item art is generated on demand rather than stored (lib/item-art-cache.mjs),
  // so there's no file for Baileys to open — hand it the rendered buffer. Lazy
  // import: the cache pulls in game-data + canvas, which is a lot to load for
  // the many callers that only ever send a banner URL.
  if (typeof image === 'string') {
    try {
      const { itemArtBufferForUrl } = await import('./item-art-cache.mjs')
      const plate = await itemArtBufferForUrl(image)
      if (plate) {
        return ctx.sock.sendMessage(recipient, {
          image: plate,
          caption: String(caption),
        }, quoted)
      }
    } catch { /* fall through to the normal resolve path */ }
  }

  const source = resolveImageSource(image)
  const isLocal = !/^https?:\/\//i.test(source)

  if (isLocal && !existsSync(source)) return null

  return ctx.sock.sendMessage(recipient, {
    image: { url: source },
    caption: String(caption),
  }, quoted)
}

/**
 * Discord path for sendGif/sendGifTo. Discord autoplays a GIF attachment
 * natively as long as the filename ends in .gif — same reasoning as
 * replyGif in adapters/discord/adapter.js. No embed needed (embeds don't
 * animate .setImage() the way a raw attachment does), so this is a plain
 * file send, unlike sendImageDiscord's embed-based approach.
 */
async function sendGifDiscord(ctx, image, caption = '') {
  if (Buffer.isBuffer(image)) {
    const { AttachmentBuilder } = await import('discord.js')
    const attachment = new AttachmentBuilder(image, { name: 'animation.gif' })
    return ctx.channel.send({ content: caption ? String(caption).slice(0, 2000) : undefined, files: [attachment] })
  }
  // Remote URL: Discord will fetch and render it as long as the filename
  // (inferred here, since we control the attachment name) ends in .gif.
  return ctx.channel.send({
    content: caption ? String(caption).slice(0, 2000) : undefined,
    files: [{ attachment: image, name: 'animation.gif' }],
  })
}

/**
 * sendGif(ctx, image, caption) / sendGifTo(ctx, image, caption, recipient)
 * — TRUE autoplaying/looping GIF, mirroring sendImage/sendImageTo's shape
 * exactly (same signature, same fallback behavior) but routed to each
 * platform's actual animated-GIF mechanism instead of its static-image
 * mechanism:
 *   - WhatsApp/Baileys: video message + gifPlayback: true (Baileys has no
 *     native animated-image type; { image: { url } } on a .gif URL sends
 *     a STILL FRAME only — this is the bug these helpers exist to avoid).
 *   - Discord: plain file attachment named *.gif (embeds' .setImage()
 *     does not animate; a raw attachment does).
 *   - Telegram: sendAnimation (sendPhoto renders a .gif URL as a still).
 *
 * `image` can be a filename (resolved via resolveImageSource, same as
 * sendImage), a full http(s) URL, or a raw Buffer. Missing local files
 * fall back to a plain text reply, same as sendImage.
 */
export async function sendGif(ctx, image, caption = '') {
  return sendGifTo(ctx, image, caption, ctx.sender)
}

export async function sendGifTo(ctx, image, caption = '', recipient = ctx.sender) {
  if (ctx.platform === 'discord') {
    return sendGifDiscord(ctx, image, caption)
  }

  if (ctx.platform === 'telegram') {
    const { InputFile } = await import('grammy')
    return ctx.bot.api.sendAnimation(
      recipient,
      Buffer.isBuffer(image) ? new InputFile(image) : resolveImageSource(image),
      { caption: String(caption) },
    )
  }

  // WhatsApp/Baileys (default platform)
  const quoted = recipient === ctx.sender ? { quoted: ctx.msg } : undefined

  if (Buffer.isBuffer(image)) {
    // A buffer may be a raw GIF (needs transcoding) or an already-encoded MP4
    // (gifSourceToVideo passes non-GIF buffers straight through). Either way we
    // hand Baileys a real video buffer it can loop back with gifPlayback.
    try {
      const mp4 = await gifSourceToVideo(image)
      return ctx.sock.sendMessage(recipient, {
        video: mp4,
        gifPlayback: true,
        caption: String(caption),
      }, quoted)
    } catch {
      return ctx.sock.sendMessage(recipient, { image, caption: String(caption) }, quoted)
    }
  }

  const source = resolveImageSource(image)
  const isLocal = !/^https?:\/\//i.test(source)

  if (isLocal && !existsSync(source)) {
    return ctx.sock.sendMessage(recipient, {
      text: String(caption || `⚠️ Animation "${image}" not found.`),
    }, quoted)
  }

  // WhatsApp can't animate a raw .gif sent as { video: { url } } — Baileys
  // needs a real MP4 container, so transcode the GIF first (cached per source).
  // If transcoding fails (ffmpeg missing, fetch error), fall back to the still
  // first frame via { image } rather than a video WhatsApp silently drops.
  if (/\.gif(\?|$)/i.test(source)) {
    try {
      const mp4 = await gifSourceToVideo(source)
      return ctx.sock.sendMessage(recipient, {
        video: mp4,
        gifPlayback: true,
        caption: String(caption),
      }, quoted)
    } catch {
      return ctx.sock.sendMessage(recipient, {
        image: { url: source },
        caption: String(caption),
      }, quoted)
    }
  }

  // Non-GIF source that still wants gif playback (e.g. a pre-converted .mp4
  // URL, the recommended way to host character art) — loop it as video directly.
  return ctx.sock.sendMessage(recipient, {
    video: { url: source },
    gifPlayback: true,
    caption: String(caption),
  }, quoted)
}

/**
 * Send a local video from ./videos. The text caption is sent as a normal
 * message when the file has not been supplied yet, so a missing asset never
 * makes a combat turn fail.
 */
export async function sendLocalVideoTo(ctx, filename, caption = '', recipient = ctx.sender) {
  const filePath = path.join(VIDEOS_DIR, filename)
  const options = recipient === ctx.sender ? { quoted: ctx.msg } : undefined
  if (!existsSync(filePath)) {
    return ctx.sock.sendMessage(recipient, {
      text: String(caption || `⚠️ Video "${filename}" not found.`),
    }, options)
  }

  return ctx.sock.sendMessage(recipient, {
    video: readFileSync(filePath),
    caption: String(caption),
    mimetype: 'video/mp4',
  }, options)
}
