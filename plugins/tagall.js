/**
 * tagall.js — .tagall [message] / .hidetag [message]
 *
 * Two ways to notify everyone:
 *   .tagall   — visible numbered roll-call, every member @mentioned in the text
 *   .hidetag  — just your message, with the whole member list in the mentions
 *               field only. Everyone gets the notification, nobody's screen
 *               fills up with 200 phone numbers.
 *
 * Admin/mod-gated, because this pings every single member and an ungated
 * version is a spam button.
 *
 * A mention only fires if the jid is in BOTH the text (as @<number>) and the
 * mentions array — for hidetag we deliberately supply only the array, which is
 * the documented way to get a silent-looking broadcast on WhatsApp.
 */
import { isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'
import { NOT_GROUP, NOT_ALLOWED } from '../lib/group-helpers.js'
import { config, logger } from '../config.js'

/** Chunk size for the visible roll-call — one message per 250 members. */
const PER_MESSAGE = 250

export default {
  name:        'tagall',
  aliases:     ['everyone', 'hidetag', 'htag'],
  category:    'utility',
  platforms:   ['whatsapp'],   // sock.groupMetadata + mentions — Baileys-only
  description: 'Mention every member (.tagall <msg> visible / .hidetag <msg> quiet)',
  subcommands: [
    { cmd: '<message>', desc: 'tagall — visible roll-call of every member' },
  ],

  async run(ctx) {
    const { reply, sender, isGroup, sock, msg, body, cmd } = ctx
    const p = config.prefix
    if (!isGroup) return reply(NOT_GROUP)
    if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

    const hidden = ['hidetag', 'htag'].includes(String(cmd).toLowerCase())

    // Off `body`, not args.join(' '), so line breaks in an announcement survive
    // — same reasoning as plugins/setname.js.
    const note = body.slice(config.prefix.length).replace(/^\S+\s*/, '').trim()

    let meta
    try {
      meta = await sock.groupMetadata(sender)
    } catch (err) {
      logger.warn({ err: err.message, jid: sender }, 'tagall: groupMetadata failed')
      return reply(`❌ Couldn't read the member list: _${err.message}_`)
    }

    const jids = (meta.participants ?? []).map(pt => pt.id).filter(Boolean)
    if (!jids.length) return reply('❌ I couldn\'t see any members in this group.')

    // ── .hidetag — message only, mentions carried invisibly ────────────────
    if (hidden) {
      if (!note) {
        return reply(`❌ *Usage:* ${p}${cmd} <message>\n_Sends your message and quietly notifies everyone._`)
      }
      return sock.sendMessage(sender, { text: note, mentions: jids }, { quoted: msg })
    }

    // ── .tagall — visible roll-call ────────────────────────────────────────
    const header =
      `📢 *ATTENTION — ${meta.subject ?? 'everyone'}*\n─────────────────────\n` +
      (note ? `${note}\n\n` : '') +
      `👥 *${jids.length}* member${jids.length === 1 ? '' : 's'}\n\n`

    // Split so a 500-member group doesn't produce one message WhatsApp
    // truncates or refuses. Each chunk carries only its own mentions.
    for (let i = 0; i < jids.length; i += PER_MESSAGE) {
      const chunk = jids.slice(i, i + PER_MESSAGE)
      const lines = chunk.map((jid, n) => `${i + n + 1}. @${jid.replace(/@.*$/, '')}`)
      const part  = jids.length > PER_MESSAGE
        ? `_(part ${Math.floor(i / PER_MESSAGE) + 1} of ${Math.ceil(jids.length / PER_MESSAGE)})_\n`
        : ''

      await sock.sendMessage(
        sender,
        { text: (i === 0 ? header : '') + part + lines.join('\n'), mentions: chunk },
        i === 0 ? { quoted: msg } : {},
      ).catch(err => logger.warn({ err: err.message, jid: sender }, 'tagall: chunk send failed'))
    }
  },
}
