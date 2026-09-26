/**
 * unmod.js — .unmod (reply to a member's message, or @mention them)
 * Reverses .mod. Same permission tier as .mod: OWNER-ONLY. WhatsApp group
 * admins cannot revoke mod status either — only the bot owner can.
 */
import { extractTarget, isOwnerJid, NOT_ALLOWED } from '../lib/group-helpers.js'
import { removeMod } from '../lib/mod-repo.js'
import { config } from '../config.js'

export default {
  name:        'unmod',
  aliases:     [],
  category:    'admin',
  description: 'Revoke global mod status from a member (owner only, reply to their message or @mention them)',

  async run(ctx) {
    const { reply, msg, from, db, sender, sock } = ctx

    if (!isOwnerJid(from)) return reply(NOT_ALLOWED)

    const target = extractTarget(msg)
    if (!target) {
      return reply(
        `❌ Reply to the member's message (or @mention them).\n\n` +
        `*Usage:* ${config.prefix}unmod (reply to user)`,
      )
    }

    const bareTarget = target.replace(/@.*$/, '')
    const removed = await removeMod(db, target)

    if (!removed) {
      return sock.sendMessage(sender, {
        text: `⚠️ @${bareTarget} isn't a mod.`,
        mentions: [target],
      }, { quoted: msg })
    }

    return sock.sendMessage(sender, {
      text: `✅ @${bareTarget} is no longer a mod.`,
      mentions: [target],
    }, { quoted: msg })
  },
}
