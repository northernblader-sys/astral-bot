/**
 * mod.js — .mod (reply to a member's message, or @mention them)
 *          .mod list
 * Grants a member GLOBAL "mod" status (db.data.mods — see lib/mod-repo.js).
 * Once granted, that JID is a mod in every group the bot is in, not just
 * wherever the command was run. A mod is NOT a WhatsApp group admin and
 * NOT the bot owner; they're a bot-level role that unlocks exactly:
 *   .ban .unban .kick .add .antilink .welcome .setwelcome .goodbye .setgoodbye
 * Nothing else — any command still gated by the plain isGroupOrBotOwner()
 * check (game toggles, etc.) stays owner/WhatsApp-admin-only.
 *
 * Permission to GRANT/REVOKE mod status is OWNER-ONLY. WhatsApp group
 * admins cannot make someone a mod — only the bot owner can.
 */
import { extractTarget, isOwnerJid, NOT_ALLOWED } from '../lib/group-helpers.js'
import { addMod, getMods } from '../lib/mod-repo.js'
import { config } from '../config.js'

export default {
  name:        'mod',
  aliases:     [],
  category:    'admin',
  description: 'Grant a member global mod status (owner only, reply to their message or @mention them)',

  async run(ctx) {
    const { reply, msg, from, db, sender, args, sock } = ctx

    if (!isOwnerJid(from)) return reply(NOT_ALLOWED)

    if (args[0]?.toLowerCase() === 'list') {
      const mods = getMods(db)
      if (mods.length === 0) return reply('📋 No mods set yet.')
      return sock.sendMessage(sender, {
        text: `📋 *Bot mods:*\n\n` + mods.map(id => `• @${id.replace(/@.*$/, '')}`).join('\n'),
        mentions: mods,
      }, { quoted: msg })
    }

    const target = extractTarget(msg)
    if (!target) {
      return reply(
        `❌ Reply to the member's message (or @mention them).\n\n` +
        `*Usage:*\n` +
        `${config.prefix}mod (reply to user) — grant mod status\n` +
        `${config.prefix}mod list — show current mods`,
      )
    }

    if (target === from) {
      return reply(`❌ You can't mod yourself.`)
    }
    if (isOwnerJid(target)) {
      return reply(`❌ The bot owner doesn't need mod status.`)
    }

    const bareTarget = target.replace(/@.*$/, '')
    const added = await addMod(db, target)

    if (!added) {
      return sock.sendMessage(sender, {
        text: `⚠️ @${bareTarget} is already a mod.`,
        mentions: [target],
      }, { quoted: msg })
    }

    return sock.sendMessage(sender, {
      text:
        `🛡️ @${bareTarget} is now a *mod* (applies in every group).\n` +
        `They can use: ban, unban, kick, add, antilink, welcome, setwelcome, goodbye, setgoodbye.`,
      mentions: [target],
    }, { quoted: msg })
  },
}
