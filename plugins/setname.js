/**
 * setname.js — .setname <text> / .setdesc <text>
 *
 * Changes the group subject and description. Both require the BOT to be an
 * admin, not just the caller — WhatsApp rejects the update otherwise, and
 * the rejection is a generic 403 that reads like a bug unless it's checked
 * for up front.
 */
import { isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'
import { NOT_GROUP, NOT_ALLOWED, checkBotAdmin } from '../lib/group-helpers.js'
import { config, logger } from '../config.js'

const MAX_SUBJECT = 100   // WhatsApp's own limit
const MAX_DESC    = 2048

export default {
  name:        'setname',
  aliases:     ['setsubject', 'gcname', 'setdesc', 'setdescription', 'gcdesc'],
  category:    'utility',
  platforms:    ['whatsapp'],   // sock.groupUpdateSubject / groupUpdateDescription — Baileys-only
  description: 'Change the group name or description (.setname <text> / .setdesc <text>)',

  async run(ctx) {
    const { reply, sender, isGroup, sock, body, cmd } = ctx
    const p = config.prefix
    if (!isGroup) return reply(NOT_GROUP)
    if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

    const isDesc = ['setdesc', 'setdescription', 'gcdesc'].includes(cmd)
    const label  = isDesc ? 'description' : 'name'
    const limit  = isDesc ? MAX_DESC : MAX_SUBJECT

    // Taken off `body`, not `args.join(' ')`, so the text keeps its original
    // spacing and line breaks — descriptions are usually multi-line.
    const text = body.slice(config.prefix.length).replace(/^\S+\s*/, '').trim()

    if (!text) {
      return reply(
        `❌ *Usage:* ${p}${cmd} <new group ${label}>\n` +
        (isDesc ? `_Use ${p}setdesc clear to empty it._` : ''),
      )
    }
    if (text.length > limit) {
      return reply(`❌ Too long — the group ${label} can be at most *${limit}* characters (yours is ${text.length}).`)
    }

    const { isAdmin } = await checkBotAdmin(sock, sender).catch(() => ({ isAdmin: false }))
    if (!isAdmin) {
      return reply(`⚠️ I need to be a *group admin* to change the group ${label}.`)
    }

    const value = (isDesc && text.toLowerCase() === 'clear') ? '' : text

    try {
      if (isDesc) await sock.groupUpdateDescription(sender, value)
      else        await sock.groupUpdateSubject(sender, value)
    } catch (err) {
      // Reported, not swallowed — a failed rename that says nothing is
      // indistinguishable from one that worked.
      logger.warn({ err: err.message, jid: sender }, `Failed to update group ${label}`)
      return reply(`❌ Couldn't update the group ${label}: _${err.message}_`)
    }

    return reply(
      value
        ? `✅ Group ${label} updated to:\n\n*${value.slice(0, 200)}*`
        : `✅ Group description cleared.`,
    )
  },
}
