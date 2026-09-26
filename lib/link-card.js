/**
 * lib/link-card.js — sends a WhatsApp "link preview" style card: a large
 * thumbnail image with a bold title, a description line, and a clickable
 * link underneath (the format WhatsApp renders specially, same as when you
 * paste a URL and it auto-expands into a rich preview).
 *
 * This is DIFFERENT from ctx.replyImage()/lib/image.js's sendImage() —
 * those send a plain image+caption message (one text blob under the
 * image). This sends Baileys' `extendedTextMessage` with a matched
 * `contextInfo.externalAdReply` block, which is what actually produces the
 * distinct bold-title / description / underlined-link layout.
 *
 * Images live in lib/assets/cards/ — same folder plugins/daily.js's
 * tryCard() helper already reads from, so card art for both styles (plain
 * replyImage and this rich link-preview) lives in one place. Drop a file
 * there and reference it by filename.
 *
 * Site: https://playastral.qzz.io — used as the default link when a
 * plugin doesn't pass its own `link`, and as the fallback source name.
 *
 * Verified: message shape matches Baileys' documented externalAdReply
 * structure (tested against a stubbed sock — see conversation), local
 * image loading, and the missing-image fallback path. NOT yet confirmed
 * against a live WhatsApp client — the card's exact visual rendering
 * should be checked with one real command before rolling out everywhere.
 *
 * Usage from a plugin:
 *   import { sendLinkCard } from '../lib/link-card.js'
 *   await sendLinkCard(ctx, {
 *     title: 'Tensura Daily Rewards',
 *     body: 'Maintain your streak and claim exclusive rewards!',
 *     thumbnail: 'daily_card.jpg',   // filename in lib/assets/cards/, a full URL, or a Buffer
 *     text: '🎉 You claimed 1000 coins + 3200 streak bonus (streak: 33)!',
 *   })
 */
import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { resolveImageSource } from './image.js'
import { config } from '../config.js'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const CARDS_DIR  = path.join(__dirname, 'assets', 'cards')

/**
 * The companion site, used as the default link on every card.
 *
 * This was `play.astral.qzz.io` — one dot too many. That hostname does not
 * resolve (ENOTFOUND), so every link card in the bot carried a dead link. The
 * real site is `playastral.qzz.io`, which is also what config.allowedOrigins
 * lists as the permitted frontend origin. Overridable via SITE_URL in .env so
 * a domain change doesn't need a code edit.
 *
 * Re-exported from config.siteUrl rather than read from process.env again —
 * a second copy of the same read drifts the moment one side gains handling
 * the other lacks (config.siteUrl treats a blank line as unset and strips
 * trailing slashes; a raw `process.env.SITE_URL ||` did neither).
 */
export const SITE_URL = config.siteUrl

/**
 * Resolve a thumbnail input (filename / URL / Buffer) to a Buffer Baileys
 * can embed.
 *
 * Lookup order for bare filenames:
 *   1. lib/image.js's IMAGES map (remote ImgBB URLs) — checked first since
 *      it's the confirmed-working source most card thumbnails already have
 *      an entry in (e.g. 'deposit_card.jpg' → IMAGES['deposit-card']).
 *   2. lib/assets/cards/<filename> — local fallback for anything not yet
 *      added to the remote map.
 */
// Hard ceiling on any single remote thumbnail fetch. Without this, a slow
// or hanging host (e.g. play.astral.qzz.io under load, or a DNS stall) can
// hold this promise open indefinitely. That's fatal for callers that invoke
// sendLinkCard() from inside player-repo.js's updatePlayer() mutator (see
// plugins/rob.js, plugins/shop.js): updatePlayer holds the single shared
// write queue for its whole mutator, so a hung fetch here doesn't just
// delay this command — it blocks EVERY other player's updatePlayer() call
// until the queue's own 20s QUEUE_TASK_TIMEOUT_MS fires. This timeout must
// stay comfortably under that so we surface a clean "no image" fallback
// instead of eating the whole queue budget ourselves.
const FETCH_TIMEOUT_MS = 6_000

async function fetchThumbnailBuffer(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    // Network error, timeout/abort, bad host, etc. — never let this reject
    // the caller. A missing thumbnail should degrade to a text-only card,
    // not crash the command.
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function resolveThumbnail(thumbnail) {
  if (Buffer.isBuffer(thumbnail)) return thumbnail

  if (/^https?:\/\//i.test(thumbnail)) {
    const buf = await fetchThumbnailBuffer(thumbnail)
    if (buf) return buf
    // Remote fetch failed — no local filename to fall back to since the
    // caller passed a full URL, so give up gracefully.
    return null
  }

  // Try the shared remote IMAGES map first (handles hyphen/underscore
  // variants and strips extensions internally — see lib/image.js).
  const mapped = resolveImageSource(thumbnail)
  if (/^https?:\/\//i.test(mapped)) {
    const buf = await fetchThumbnailBuffer(mapped)
    if (buf) return buf
    // Remote fetch failed — fall through and still try the local path
    // below before giving up entirely.
  }

  const localPath = path.join(CARDS_DIR, thumbnail)
  if (!existsSync(localPath)) return null
  return readFileSync(localPath)
}

/**
 * Sends a link-preview-style card to the current chat.
 *
 * @param ctx   - the plugin's ctx object (needs ctx.sock and ctx.sender/ctx.from)
 * @param opts.title      - bold title line (e.g. "Tensura Daily Rewards")
 * @param opts.body       - description line under the title (small grey text)
 * @param opts.thumbnail  - filename in lib/assets/cards/, a full https URL, or a Buffer
 * @param opts.link       - the URL shown/linked at the bottom of the card;
 *                          defaults to SITE_URL (play.astral.qzz.io) if omitted
 * @param opts.text       - the actual message body text (appears ABOVE the
 *                          card, same position as a normal reply's text —
 *                          this is where "You claimed 1000 coins..." goes)
 * @param opts.sourceName - small text above the title (e.g. your bot's name);
 *                          optional, defaults to the link's hostname
 *
 * Falls back to a plain text reply (via ctx.reply) if the thumbnail can't
 * be resolved, so a missing/renamed image never breaks the command.
 */
export async function sendLinkCard(ctx, { title, body, thumbnail, link = SITE_URL, text = '', sourceName } = {}) {
  const jid = ctx.sender ?? ctx.from
  if (!jid || !ctx.sock) {
    throw new Error('sendLinkCard: ctx.sock and ctx.sender/ctx.from are required')
  }

  const jpegThumbnail = thumbnail ? await resolveThumbnail(thumbnail) : null
  // If the thumbnail couldn't be resolved, continue without it — the rich
  // link card still shows title/body/link. Only fall back to plain text if
  // there is genuinely nothing to show (no title, no text).

  let host = sourceName
  if (!host && link) {
    try { host = new URL(link).hostname } catch { host = link }
  }

  return ctx.sock.sendMessage(jid, {
    text: text || title || '',
    contextInfo: {
      externalAdReply: {
        title:            title ?? '',
        body:             body ?? '',
        thumbnail:        jpegThumbnail ?? undefined,
        mediaType:        1,           // 1 = image preview
        renderLargerThumbnail: false,  // compact style: small square thumbnail left, text right
        sourceUrl:        link ?? undefined,
        showAdAttribution: false,
      },
    },
  })
}
