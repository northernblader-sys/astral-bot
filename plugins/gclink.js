/**
 * gclink.js — .gclink
 *
 * Fetches this group's invite link. WhatsApp only hands the invite code to
 * group ADMINS, so the bot itself must be an admin — a non-admin bot gets a
 * generic 403 back from groupInviteCode(), which reads like the command is
 * broken rather than like a missing permission. Checked up front and named.
 *
 * Caller side is deliberately admin/mod-gated too: the invite link is the
 * group's front door, and any member being able to make the bot print it turns
 * a private group into a public one.
 */
import { isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'
import { NOT_GROUP, NOT_ALLOWED, checkBotAdmin } from '../lib/group-helpers.js'
import { config, logger } from '../config.js'

export default {
  name:        'gclink',
  aliases:     ['gcinvite', 'grouplink', 'invitelink'],
  category:    'utility',
  platforms:   ['whatsapp'],   // sock.groupInviteCode — Baileys-only
  description: 'Get this group\'s invite link (admins only)',

  async run(ctx) {
    const { reply, sender, isGroup, sock } = ctx
    const p = config.prefix
    if (!isGroup) return reply(NOT_GROUP)
    if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

    const { isAdmin, meta } = await checkBotAdmin(sock, sender)
      .catch(() => ({ isAdmin: false, meta: null }))
    if (!isAdmin) {
      return reply(`⚠️ I need to be a *group admin* to read the invite link. Use *${p}botadmin* to check my status.`)
    }

    let code
    try {
      code = await sock.groupInviteCode(sender)
    } catch (err) {
      logger.warn({ err: err.message, jid: sender }, 'groupInviteCode failed')
      return reply(`❌ Couldn't fetch the invite link: _${err.message}_`)
    }

    if (!code) {
      return reply(`❌ WhatsApp returned no invite code for this group. Try again in a moment.`)
    }

    return reply(
      `🔗 *GROUP INVITE LINK*\n─────────────────────\n` +
      `*${meta?.subject ?? 'This group'}*\n\n` +
      `https://chat.whatsapp.com/${code}\n\n` +
      `_Anyone with this link can join._\n` +
      `_Run ${p}revoke to invalidate it and generate a new one._`,
    )
  },
}
