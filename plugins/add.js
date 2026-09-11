/**
 * add.js — .add <number>
 * Requires the sender to be either the bot owner or a WhatsApp admin of the
 * group. No upfront "am I admin?" check — attempts the add directly and
 * reports "not admin" only if WhatsApp's response indicates that's why it
 * failed (see status code handling below).
 */
import { parseNumber, NOT_GROUP, NOT_ALLOWED } from '../lib/group-helpers.js'
import { isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'

export default {
  name:        'add',
  aliases:     [],
  category:    'utility',
  platforms:    ['whatsapp'],   // sock.groupParticipantsUpdate — Baileys-only
  description: 'Add a member to the group by phone number',

  async run(ctx) {
    const { args, reply, sock, sender, isGroup } = ctx
    if (!isGroup) return reply(NOT_GROUP)
    if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

    const number = parseNumber(args.join(' '))
    if (!number) {
      return reply('❌ *Usage:* .add <number>\nExample: .add 2348012345678')
    }

    const targetJid = `${number}@s.whatsapp.net`

    try {
      const result = await sock.groupParticipantsUpdate(sender, [targetJid], 'add')
      const status = result?.[0]?.status

      if (status === '200') return reply(`✅ Successfully added @${number}`)
      if (status === '403') return reply(`❌ Couldn't add @${number} — their privacy settings block group adds. Send them the invite link instead.`)
      if (status === '408') return reply(`⚠️ Invite sent to @${number} — they need to accept it to join.`)
      if (status === '401' || status === '400') return reply(`❌ Failed to add @${number} — I'm likely not an admin here. Use *.botadmin* to check. (status: ${status})`)
      return reply(`❌ Failed to add @${number} (status: ${status ?? 'unknown'})`)
    } catch (e) {
      return reply(`❌ Failed to add @${number} — I'm likely not an admin here (or lack permission). Use *.botadmin* to check.\n_Error: ${e.message}_`)
    }
  },
}
