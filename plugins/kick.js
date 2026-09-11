/**
 * kick.js — .kick   (reply to a member's message to remove them)
 * Requires the sender to be either the bot owner or a WhatsApp admin of the
 * group. Never kicks an admin or the bot owner.
 *
 * No upfront "am I admin?" check — attempts the removal directly and only
 * reports "not admin" if WhatsApp actually rejects it. This is faster and,
 * since checkBotAdmin's LID/jid matching can still occasionally miss an edge
 * case, avoids a false "not admin" block on an action that would have
 * actually succeeded.
 */
import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { extractTarget, isOwnerJid, NOT_GROUP, NOT_ALLOWED, invalidateGroupMetadata } from '../lib/group-helpers.js'
import { isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'
import { config } from '../config.js'

export default {
  name:        'kick',
  aliases:     [],
  category:    'utility',
  platforms:    ['whatsapp'],   // sock.groupMetadata / groupParticipantsUpdate — Baileys-only
  description: 'Remove a member from the group (reply to their message)',

  async run(ctx) {
    const { reply, sock, sender, msg, isGroup } = ctx
    if (!isGroup) return reply(NOT_GROUP)
    if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

    const target = extractTarget(msg)
    if (!target) {
      return reply('❌ Reply to the member\'s message.\n\n*Usage:* .kick (reply to user)')
    }

    const targetJid = jidNormalizedUser(target)

    // Still worth blocking these two up front — they're not "am I admin"
    // questions, they're "should this ever happen" questions regardless of
    // permissions.
    if (isOwnerJid(targetJid)) {
      return reply('❌ Cannot kick the bot owner.')
    }
    try {
      const meta = await sock.groupMetadata(sender)
      const targetEntry = meta.participants.find(pt => jidNormalizedUser(pt.id) === targetJid)
      if (targetEntry?.admin === 'admin' || targetEntry?.admin === 'superadmin') {
        return reply('❌ Cannot kick a group admin.')
      }
    } catch {
      // If metadata fetch fails here, fall through — the actual remove call
      // below will fail too and report a clear reason.
    }

    const bareTarget = targetJid.replace(/@.*$/, '')
    try {
      await sock.groupParticipantsUpdate(sender, [targetJid], 'remove')
      // Participant list changed: forget the cached metadata.
      invalidateGroupMetadata(sender)
      return reply(`✅ Removed @${bareTarget}`)
    } catch (e) {
      // WhatsApp's own error message for a non-admin bot is distinctive
      // enough to surface directly rather than guessing.
      return reply(`❌ Failed to kick @${bareTarget} — I'm likely not an admin here (or lack permission). Use *.botadmin* to check.\n_Error: ${e.message}_`)
    }
  },
}
