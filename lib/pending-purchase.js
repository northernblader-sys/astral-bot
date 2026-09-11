/**
 * pending-purchase.js — shared DM screenshot-confirmation flow for every
 * Naira purchase in the bot: Premium plans, Gem top-ups, Mond packs and
 * season offers. One image hook handles all of them, branching on whichever
 * of player.premiumPending / topupPending / mondPending / seasonOfferPending
 * is actually set — wired into the early screenshot bypass in handler.js so it
 * can run before the "must start with prefix" bail-out (a screenshot has no
 * prefix).
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { logger, config } from '../config.js'
import { updatePlayer } from './player-repo.js'

/**
 * Sends `content` to the configured owner. Tries the LID-based jid first
 * (required for LID-based accounts — @s.whatsapp.net silently fails to
 * deliver to them), then falls back to the plain phone-number jid. Mirrors
 * the candidate-list pattern main.js uses for the "bot is online" DM.
 * Returns the jid that succeeded, or null if every candidate failed.
 *
 * Exported because lib/unban-appeal.js needs the same owner-escalation path
 * when no mod GC is configured to review an appeal.
 */
export async function sendToOwner(sock, content) {
  const candidates = []
  if (config.ownerLid) candidates.push(`${config.ownerLid}@lid`)
  const ownerNumber = (config.ownerNumbers ?? [])[0]
  if (ownerNumber) candidates.push(`${ownerNumber.replace(/\D/g, '')}@s.whatsapp.net`)

  for (const jid of candidates) {
    try {
      await sock.sendMessage(jid, content)
      return jid
    } catch (err) {
      logger.warn({ jid, err: err.message }, 'sendToOwner: send failed, trying next candidate')
    }
  }
  return null
}

/**
 * True if `player` currently has a premium/topup purchase awaiting a
 * payment screenshot — used by handler.js to decide whether to intercept
 * a DM image before the normal command-prefix check.
 */
export function hasAwaitingScreenshot(player) {
  return player?.premiumPending?.state === 'awaiting_screenshot'
    || player?.topupPending?.state === 'awaiting_screenshot'
    || player?.mondPending?.state === 'awaiting_screenshot'
    || player?.seasonOfferPending?.state === 'awaiting_screenshot'
}

/**
 * Handles an incoming DM image while a purchase is awaiting its screenshot.
 * Downloads + saves the image, flips the pending state to
 * 'pending_confirmation', forwards the image + confirm/reject instructions
 * to the owner, and confirms receipt to the buyer.
 */
export async function handlePendingScreenshot(ctx, player) {
  const { sock, msg, db, from, reply } = ctx
  const kind = player.premiumPending?.state === 'awaiting_screenshot' ? 'premium'
    : player.topupPending?.state === 'awaiting_screenshot' ? 'topup'
    : player.mondPending?.state === 'awaiting_screenshot' ? 'mond'
    : player.seasonOfferPending?.state === 'awaiting_screenshot' ? 'seasonoffer'
    : null
  if (!kind) return false

  let buffer
  try {
    buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
  } catch (err) {
    logger.warn({ err: err.message }, 'handlePendingScreenshot: download failed')
    await reply('❌ Could not read that image — please try sending the screenshot again.').catch(() => {})
    return true
  }

  // Note: not saved to local disk — the buffer is forwarded straight to
  // the owner via WhatsApp below (sendToOwner), which is the only place
  // this image is ever actually used. Writing it to media/purchases/ too
  // used to leak one file per purchase attempt forever, since nothing
  // ever read it back — that was silently filling the VPS's disk.

  await updatePlayer(db, from, p => {
    if (kind === 'premium'     && p.premiumPending)     p.premiumPending.state     = 'pending_confirmation'
    if (kind === 'topup'       && p.topupPending)       p.topupPending.state       = 'pending_confirmation'
    if (kind === 'mond'        && p.mondPending)        p.mondPending.state        = 'pending_confirmation'
    if (kind === 'seasonoffer' && p.seasonOfferPending) p.seasonOfferPending.state = 'pending_confirmation'
  })

  const pending    = kind === 'premium' ? player.premiumPending
    : kind === 'topup' ? player.topupPending
    : kind === 'mond' ? player.mondPending
    : player.seasonOfferPending
  const detailLine = kind === 'premium'
    ? `Plan: *${pending.plan}*`
    : kind === 'topup'
    ? `Package: *${pending.packageId}* (${pending.gems} gems)`
    : kind === 'mond'
    ? `Pack: *${pending.packageId}* (${pending.monds} monds)`
    : `Offer: *${pending.packageId}* (${pending.gems ? `${pending.gems} gems` : `${pending.solars} solars`})`
  const confirmCmd  = kind === 'premium'
    ? `${config.prefix}premium confirm ${player.name} ${pending.plan}`
    : kind === 'topup'
    ? `${config.prefix}topup confirm ${player.name}`
    : kind === 'mond'
    ? `${config.prefix}monds confirm ${player.name}`
    : `${config.prefix}season offer confirm ${player.name}`
  const rejectCmd   = kind === 'seasonoffer'
    ? `${config.prefix}season offer reject ${player.name}`
    : kind === 'mond'
    ? `${config.prefix}monds reject ${player.name}`
    : `${config.prefix}${kind} reject ${player.name}`

  const ownerCaption =
    `🧾 *Payment screenshot received*\n` +
    `👤 ${player.name} (${from})\n` +
    `🛒 Type: *${kind}*\n` +
    `${detailLine}\n\n` +
    `Confirm: *${confirmCmd}*\n` +
    `Reject:  *${rejectCmd}*`

  const sentTo = await sendToOwner(sock, { image: buffer, caption: ownerCaption })

  await reply(
    sentTo
      ? `📨 Screenshot received! It's been forwarded to the owner for confirmation.\nYou'll get a DM here once it's approved.`
      : `⚠️ Screenshot received, but I couldn't reach the owner right now. Please contact support: ${config.supportGroupLink}`,
  ).catch(() => {})

  return true
}
