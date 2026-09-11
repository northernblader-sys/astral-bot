/**
 * revoke.js — .revoke
 *
 * Invalidates the group's current invite link and issues a fresh one. The old
 * link stops working immediately, which is the point — this is the "someone
 * leaked our link" button.
 *
 * Same admin requirements as plugins/gclink.js: WhatsApp only lets admins
 * rotate the code, so the BOT has to be an admin, and the caller is gated to
 * admins/mods because rotating the link kicks every pending invite loose.
 */
import { isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'
import { NOT_GROUP, NOT_ALLOWED, checkBotAdmin } from '../lib/group-helpers.js'
import { config, logger } from '../config.js'

export default {
  name:        'revoke',
  aliases:     ['revokelink', 'resetlink', 'newlink'],
  category:    'utility',
  platforms:   ['whatsapp'],   // sock.groupRevokeInvite — Baileys-only
  description: 'Reset the group invite link, killing the old one (.revoke)',

  async run(ctx) {
    const { reply, sender, isGroup, sock } = ctx
    const p = config.prefix
    if (!isGroup) return reply(NOT_GROUP)
    if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

    const { isAdmin } = await checkBotAdmin(sock, sender).catch(() => ({ isAdmin: false }))
    if (!isAdmin) {
      return reply(`⚠️ I need to be a *group admin* to reset the invite link. Use *${p}botadmin* to check my status.`)
    }

    let code
    try {
      code = await sock.groupRevokeInvite(sender)
    } catch (err) {
      logger.warn({ err: err.message, jid: sender }, 'groupRevokeInvite failed')
      return reply(`❌ Couldn't reset the invite link: _${err.message}_`)
    }

    // Baileys returns the NEW code on success. No code back means the revoke
    // may still have happened, so don't claim a new link that isn't confirmed.
    if (!code) {
      return reply(
        `♻️ The old invite link was revoked, but WhatsApp didn't return the new code.\n` +
        `_Run ${p}gclink to fetch it._`,
      )
    }

    return reply(
      `♻️ *INVITE LINK RESET*\n─────────────────────\n` +
      `The old link no longer works. New link:\n\n` +
      `https://chat.whatsapp.com/${code}`,
    )
  },
}
