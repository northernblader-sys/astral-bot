/**
 * promote.js — .promote / .demote  (reply to a member, @mention them, or pass
 * their number)
 *
 * Follows plugins/kick.js's pattern: no upfront "am I admin?" gate on the
 * action itself, just the attempt and a named error if WhatsApp refuses —
 * checkBotAdmin's LID/jid matching can still miss an edge case, and a false
 * "I'm not an admin" block on an action that would have worked is worse than a
 * clear failure message.
 *
 * Demoting the bot owner is refused outright. That's not a permissions question
 * — it's a "should this ever happen" question, same as kick.js's owner guard.
 */
import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'
import { extractTarget, parseNumber, isOwnerJid, NOT_GROUP, NOT_ALLOWED, invalidateGroupMetadata } from '../lib/group-helpers.js'
import { config, logger } from '../config.js'

export default {
  name:        'promote',
  aliases:     ['demote'],
  category:    'utility',
  platforms:   ['whatsapp'],   // sock.groupParticipantsUpdate — Baileys-only
  description: 'Make a member an admin, or remove their admin (.promote / .demote)',

  async run(ctx) {
    const { reply, sender, isGroup, sock, msg, cmd } = ctx
    const p = config.prefix
    if (!isGroup) return reply(NOT_GROUP)
    if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

    const demote = String(cmd).toLowerCase() === 'demote'
    const action = demote ? 'demote' : 'promote'

    // Reply/@mention first, then a bare number as a fallback so an admin can
    // act on someone who hasn't spoken recently.
    const raw = extractTarget(ctx) ?? (() => {
      const num = parseNumber(ctx.args?.[0])
      return num ? `${num}@s.whatsapp.net` : null
    })()

    if (!raw) {
      return reply(
        `❌ *Usage:* ${p}${cmd} @user\n` +
        `_Reply to their message, tag them, or pass their number._`,
      )
    }

    const targetJid  = jidNormalizedUser(raw)
    const bareTarget = targetJid.replace(/@.*$/, '')

    if (demote && isOwnerJid(targetJid)) {
      return reply('❌ Cannot demote the bot owner.')
    }

    // Not a permission check — just a no-op guard so "promoted!" isn't
    // reported for someone who was already an admin (or vice versa).
    try {
      const meta  = await sock.groupMetadata(sender)
      const entry = meta.participants.find(pt => jidNormalizedUser(pt.id) === targetJid)
      if (!entry) {
        return reply(`❌ @${bareTarget} isn't a member of this group.`)
      }
      const isAdminAlready = entry.admin === 'admin' || entry.admin === 'superadmin'
      if (!demote && isAdminAlready) {
        return sock.sendMessage(sender, {
          text: `_@${bareTarget} is already an admin._`, mentions: [targetJid],
        }, { quoted: msg })
      }
      if (demote && !isAdminAlready) {
        return sock.sendMessage(sender, {
          text: `_@${bareTarget} isn't an admin._`, mentions: [targetJid],
        }, { quoted: msg })
      }
      if (demote && entry.admin === 'superadmin') {
        return reply(`❌ @${bareTarget} is the group creator — WhatsApp doesn't allow demoting them.`)
      }
    } catch {
      // Metadata unavailable — fall through; the update below reports its own
      // failure with a real reason.
    }

    try {
      await sock.groupParticipantsUpdate(sender, [targetJid], action)
      // The admin list just changed, so drop the cached metadata rather than
      // letting moderation run on a stale one for the rest of its TTL.
      invalidateGroupMetadata(sender)
    } catch (err) {
      logger.warn({ err: err.message, jid: sender, action }, 'promote/demote failed')
      return reply(
        `❌ Couldn't ${action} @${bareTarget} — I'm likely not an admin here (or lack permission). ` +
        `Use *${p}botadmin* to check.\n_Error: ${err.message}_`,
      )
    }

    return sock.sendMessage(sender, {
      text: demote
        ? `👤 @${bareTarget} is no longer an admin.`
        : `👑 @${bareTarget} is now a group *admin*.`,
      mentions: [targetJid],
    }, { quoted: msg })
  },
}
