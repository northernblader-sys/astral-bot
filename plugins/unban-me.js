/**
 * unban-me.js — `.unban-me` (DM only): starts an unban appeal.
 *
 * This is the one command a banned account is allowed to run: handler.js
 * exempts it from both the ban lockout and the DM lock, so a banned user can
 * always reach it even though every other command is dead for them. It DMs
 * them the ASTRAL UNBAN FORM image and waits for the filled-in photo to come
 * back — see lib/unban-appeal.js for the rest of the flow (the image hook, the
 * forward to the mod GC, and the `.unban` command mods run to accept it).
 *
 * requiresPlayer is false on purpose: a ban can predate registration, so an
 * unregistered account must still be able to appeal.
 */
import { config, logger } from '../config.js'
import { getBan } from '../lib/ban-repo.js'
import { sendImage } from '../lib/image.js'
import { formatTimeLeft } from '../lib/time-format.js'
import {
  UNBAN_FORM_IMAGE, FORM_RESEND_COOLDOWN_MS, RESUBMIT_COOLDOWN_MS,
  getUnbanAppeal, openUnbanAppeal, unbanFormCaption,
} from '../lib/unban-appeal.js'

export default {
  name:           'unban-me',
  aliases:        ['unbanme', 'appeal'],
  category:       'utility',
  requiresPlayer: false,
  platforms:      ['whatsapp'], // form image + mod-GC forward are Baileys-only
  description:    'Start an unban appeal — DM the bot and it sends you the unban form',

  async run(ctx) {
    const { db, from, isGroup, reply } = ctx
    const p = config.prefix

    // Group use is pointless (and public) — the whole flow is a DM back and
    // forth, so point them at the DM instead of starting anything here.
    if (isGroup) {
      return reply(
        `📩 Appeals happen in my DM, not in the group.\n` +
        `Message me privately with *${p}unban-me* and I'll send you the unban form.`,
      )
    }

    if (!getBan(db, from)) {
      return reply(`✅ You're not banned — nothing to appeal. Go play.`)
    }

    const appeal = getUnbanAppeal(db, from)

    // Already sent the filled form in and it's still with the mods.
    const reviewLeft = (appeal?.submittedAt ?? 0) + RESUBMIT_COOLDOWN_MS - Date.now()
    if (appeal?.state === 'submitted' && reviewLeft > 0) {
      return reply(
        `⏳ Your filled form is already with the mod team.\n` +
        `Sit tight — if you hear nothing back you can send another one in *${formatTimeLeft(reviewLeft)}*.`,
      )
    }

    // Asked again right after getting the form — don't re-send the image, just
    // remind them what to do with the one they already have.
    const resendLeft = (appeal?.openedAt ?? 0) + FORM_RESEND_COOLDOWN_MS - Date.now()
    if (appeal?.state === 'awaiting_form' && resendLeft > 0) {
      return reply(
        `📄 I already sent you the form — scroll up.\n` +
        `Fill it in, then send a photo of it here as an image.`,
      )
    }

    await openUnbanAppeal(db, from)

    // The form lives on a remote host (lib/image.js's URL map), so the send
    // can fail for reasons that have nothing to do with the appeal. Falling
    // back to the instructions as plain text keeps the flow usable — they can
    // still write the form out by hand, and the appeal is already open, so the
    // photo they send back is still picked up.
    try {
      return await sendImage(ctx, UNBAN_FORM_IMAGE, unbanFormCaption())
    } catch (err) {
      logger.warn({ err: err.message, jid: from }, 'unban-me: form image send failed, falling back to text')
      return reply(
        `${unbanFormCaption()}\n\n` +
        `⚠️ _Couldn't attach the form image right now — write the four fields out ` +
        `by hand (Username / ID, Reason for ban, Date, Signature) and photograph that._`,
      )
    }
  },
}
