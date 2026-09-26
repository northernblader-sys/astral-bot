/**
 * unban-appeal.js — the `.unban-me` appeal flow.
 *
 * A banned account can't run ANY command (see the ban lockout in handler.js),
 * so appealing has to work from inside that lockout:
 *
 *   1. The "you are banned" notice tells them to DM the bot `.unban-me`.
 *   2. `.unban-me` (plugins/unban-me.js — exempt from both the ban lockout and
 *      the DM lock) DMs them the ASTRAL UNBAN FORM image and opens an appeal
 *      in state 'awaiting_form'.
 *   3. They fill the form in by hand and send the photo back to that same DM.
 *      A photo has no command prefix, so handler.js intercepts it in the same
 *      early bypass the payment-screenshot flow uses (lib/pending-purchase.js)
 *      and calls handleUnbanFormImage() below.
 *   4. The photo is forwarded to the mod GC (lib/mod-gc.js — the same group
 *      `.submit` posts to), captioned with the ready-to-run `.unban` command.
 *      A mod runs it; plugins/unban.js then clears the appeal and DMs the user.
 *
 * Appeal state lives in db.data.unbanAppeals keyed by JID, deliberately NOT on
 * the player record — same reasoning as lib/ban-repo.js: someone can be banned
 * (and so appeal) without ever having registered, and `.admin resetplayer`
 * must not wipe an in-flight appeal.
 *
 * Record shape:
 *   { state:       'awaiting_form' | 'submitted',
 *     openedAt:    number,          when .unban-me last sent the form
 *     submittedAt: number | null,   when the filled form last reached the mods
 *     submissions: number,         how many forms they've sent in total
 *     forwardedTo: string | null }  jid the last form was forwarded to
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { logger, config } from '../config.js'
import { getBan } from './ban-repo.js'
import { getModGc } from './mod-gc.js'
import { sendToOwner } from './pending-purchase.js'
import { getPlayer } from './player-repo.js'
import { formatTimeLeft } from './time-format.js'

/** Key in lib/image.js's remote-URL map — the blank form photo we hand out. */
export const UNBAN_FORM_IMAGE = 'unban-form.jpg'

/**
 * How long a submitted form blocks the next one. The point is to keep a banned
 * user from turning the mod GC into a photo feed: one form, then wait for a
 * decision. `.unban` clearing the appeal also lifts this, so an accepted
 * appeal never leaves a cooldown behind.
 */
export const RESUBMIT_COOLDOWN_MS = 12 * 60 * 60 * 1000 // 12h

/** How often `.unban-me` will re-send the form image itself (spam guard). */
export const FORM_RESEND_COOLDOWN_MS = 5 * 60 * 1000 // 5m

/** The appeal record for `id`, or null if they have no open appeal. */
export function getUnbanAppeal(db, id) {
  return db.data.unbanAppeals?.[id] ?? null
}

/**
 * True if `id` has an appeal in progress — checked by handler.js to decide
 * whether a prefix-less DM image should be treated as a filled-in form.
 * Covers 'submitted' too, so a second photo gets the "already with the mods"
 * answer instead of falling through to the generic "DMs are closed" notice.
 */
export function hasOpenUnbanAppeal(db, id) {
  return !!getUnbanAppeal(db, id)
}

/** Opens (or refreshes) an appeal and marks it as waiting on the filled form. */
export async function openUnbanAppeal(db, id) {
  if (!db.data.unbanAppeals) db.data.unbanAppeals = {}
  const existing = db.data.unbanAppeals[id]
  db.data.unbanAppeals[id] = {
    state:       'awaiting_form',
    openedAt:    Date.now(),
    submittedAt: existing?.submittedAt ?? null,
    submissions: existing?.submissions ?? 0,
    forwardedTo: existing?.forwardedTo ?? null,
  }
  await db.write()
  return db.data.unbanAppeals[id]
}

/**
 * Clears any appeal for `id`. Called by plugins/unban.js on a successful
 * unban, and by the form handler if the ban is already gone. Returns true if
 * there was something to clear.
 */
export async function clearUnbanAppeal(db, id) {
  if (!db.data.unbanAppeals?.[id]) return false
  delete db.data.unbanAppeals[id]
  await db.write()
  return true
}

/** Instructions sent alongside the blank form image. */
export function unbanFormCaption() {
  return (
    `📄 *ASTRAL UNBAN FORM*\n\n` +
    `You're banned, but you can appeal it. Here's the form.\n\n` +
    `*How to do it:*\n` +
    `1. Save this image (or write the same thing out on paper).\n` +
    `2. Fill in *Username / ID*, *Reason for ban*, *Date* and *Signature*.\n` +
    `3. Take a clear photo of the finished form.\n` +
    `4. Send that photo *right here in this chat* as an image.\n\n` +
    `I'll forward it straight to the mod team. If they accept it you'll be ` +
    `unbanned and I'll message you here.\n\n` +
    `_Blank, cropped or unreadable forms get thrown out — send one clean photo._`
  )
}

/**
 * Handles a DM image while an appeal is open: downloads the photo, forwards it
 * to the mod GC (falling back to the owner's DM if no mod GC is configured),
 * and flips the appeal to 'submitted'.
 *
 * Always returns true — the image was for this flow, so handler.js should stop
 * processing it either way, including on failure (where the user is told to
 * retry rather than left with a bare "DMs are closed").
 */
export async function handleUnbanFormImage(ctx) {
  const { sock, db, msg, from, reply } = ctx

  // Unbanned while the form was out — nothing left to appeal.
  if (!getBan(db, from)) {
    await clearUnbanAppeal(db, from)
    await reply(`✅ You're not banned anymore — no need to send the form.`).catch(() => {})
    return true
  }

  const appeal = getUnbanAppeal(db, from)
  const waitLeft = (appeal?.submittedAt ?? 0) + RESUBMIT_COOLDOWN_MS - Date.now()
  if (appeal?.state === 'submitted' && waitLeft > 0) {
    await reply(
      `⏳ Your form is already with the mod team — one appeal at a time.\n` +
      `You can send another in *${formatTimeLeft(waitLeft)}* if you haven't heard back.`,
    ).catch(() => {})
    return true
  }

  let buffer
  try {
    buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
  } catch (err) {
    logger.warn({ err: err.message, jid: from }, 'handleUnbanFormImage: download failed')
    await reply(`❌ Couldn't read that image — please send the photo of your form again.`).catch(() => {})
    return true
  }

  const ban        = getBan(db, from)
  const player     = getPlayer(db, from)
  const digits     = from.replace(/[:@].*$/, '')
  const name       = player?.name ?? null
  const attempt    = (appeal?.submissions ?? 0) + 1
  const bannedAt   = ban?.bannedAt ? new Date(ban.bannedAt).toLocaleString() : 'unknown'
  const byLabel    = ban?.bannedBy ? `@${ban.bannedBy.replace(/@.*$/, '')}` : 'an admin'

  const caption =
    `📄 *UNBAN APPEAL* — filled form attached\n\n` +
    `👤 ${name ? `*${name}*` : '_unregistered_'} (wa.me/${digits})\n` +
    `🚫 Banned: *${bannedAt}* by ${byLabel}\n` +
    (ban?.reason ? `📝 Ban reason: _${ban.reason}_\n` : '') +
    `📨 Appeal attempt: *#${attempt}*\n\n` +
    `Accept: *${config.prefix}unban ${digits}*` +
    (name ? `  _(or ${config.prefix}unban ${name})_` : '') + `\n` +
    `_Ignore it to leave the ban in place._`

  const modGc = await getModGc()
  let forwardedTo = null
  if (modGc) {
    try {
      await sock.sendMessage(modGc, { image: buffer, caption, mentions: ban?.bannedBy ? [ban.bannedBy] : [] })
      forwardedTo = modGc
    } catch (err) {
      logger.warn({ err: err.message, modGc }, 'handleUnbanFormImage: mod GC send failed')
    }
  }
  // No mod GC set (or it wouldn't take the message) — the owner is the
  // fallback reviewer, same escalation the purchase flow uses.
  if (!forwardedTo) {
    forwardedTo = await sendToOwner(sock, { image: buffer, caption })
  }

  if (!forwardedTo) {
    logger.warn({ jid: from }, 'handleUnbanFormImage: nowhere to forward the appeal')
    await reply(
      `⚠️ Got your form, but I couldn't reach the mod team right now. ` +
      `Please send it again later or ask in the support group: ${config.supportGroupLink}`,
    ).catch(() => {})
    return true
  }

  if (!db.data.unbanAppeals) db.data.unbanAppeals = {}
  db.data.unbanAppeals[from] = {
    ...(appeal ?? { openedAt: Date.now() }),
    state:       'submitted',
    submittedAt: Date.now(),
    submissions: attempt,
    forwardedTo,
  }
  await db.write()

  await reply(
    `📨 *Form received.* It's been sent to the mod team for review.\n\n` +
    `If they accept it you'll be unbanned and I'll message you here. ` +
    `Don't send it again unless *${formatTimeLeft(RESUBMIT_COOLDOWN_MS)}* pass with no answer.`,
  ).catch(() => {})

  return true
}
