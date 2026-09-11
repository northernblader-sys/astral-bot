/**
 * ban.js — .ban (reply to a member's message, or @mention them)
 * Bans a player account-wide: they cannot run ANY command (including
 * .register) until unbanned. Ban is stored independently of the player
 * record (lib/ban-repo.js), so it survives .admin resetplayer and can be
 * applied even to someone who has never registered.
 *
 * Permission: bot owner or a WhatsApp group admin (same tier as .kick/.add).
 * Optional reason: .ban <reason text> (reply/mention the target)
 */
import { extractTarget, isOwnerJid, NOT_ALLOWED } from '../lib/group-helpers.js'
import { isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'
import { banUser, getBan } from '../lib/ban-repo.js'
import { config } from '../config.js'

export default {
  name:        'ban',
  aliases:     [],
  category:    'admin',
  description: 'Ban a player account-wide (reply to their message or @mention them)',

  async run(ctx) {
    const { reply, msg, from, db, args, sock, sender } = ctx

    if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

    const target = extractTarget(msg)
    if (!target) {
      return reply(
        `❌ Reply to the member's message (or @mention them).\n\n` +
        `*Usage:* ${config.prefix}ban [reason] (reply to user)`,
      )
    }

    if (target === from) {
      return reply(`❌ You can't ban yourself.`)
    }
    if (isOwnerJid(target)) {
      return reply(`❌ Can't ban the bot owner.`)
    }

    const existing = getBan(db, target)
    const reason = args.join(' ').trim() || null

    await banUser(db, target, from, reason)

    const bareTarget = target.replace(/@.*$/, '')
    return sock.sendMessage(sender, {
      text:
        `🚫 ${existing ? 'Re-banned' : 'Banned'} @${bareTarget}.\n` +
        `They can no longer use any bot command until *${config.prefix}unban* is run on them.` +
        (reason ? `\nReason: _${reason}_` : '') +
        `\n\n📩 To appeal: DM the bot *${config.prefix}unban-me* — it sends the ` +
        `unban form, and the filled-in form comes back to the mod GC.`,
      mentions: [target],
    }, { quoted: msg })
  },
}
