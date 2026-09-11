/**
 * report.js — .report <message>
 *
 * Files a structured bug/abuse report straight to the bot owner's DM. Kept
 * separate from the general support/contact flow on purpose: this one is for
 * "something is broken or someone is abusing the bot", so it carries the
 * context an owner needs to act (which chat, which user, the quoted message
 * if there is one) rather than being a free-text conversation starter.
 *
 * Rate-limited per user because a DM firehose to the owner is exactly what an
 * annoyed player will reach for.
 */
import { config, logger } from '../config.js'
import { extractTarget } from '../lib/group-helpers.js'

const COOLDOWN_MS = 5 * 60 * 1000
const MIN_LENGTH  = 10
const MAX_LENGTH  = 900

/** userJid -> last report timestamp. In-memory: a restart forgiving a
 *  cooldown is a non-issue, and it keeps this off the disk write path. */
const lastReport = new Map()

export default {
  name:        'report',
  aliases:     ['bugreport', 'reportbug'],
  category:    'utility',
  description: 'Send a bug or abuse report to the bot owner (.report <what happened>)',

  async run(ctx) {
    const { reply, sender, from, isGroup, sock, msg, body } = ctx
    const p = config.prefix

    const text = body.slice(config.prefix.length).replace(/^\S+\s*/, '').trim()

    if (text.length < MIN_LENGTH) {
      return reply(
        `📮 *REPORT*\n─────────────────────\n` +
        `Tell me what went wrong and I'll pass it to the owner.\n\n` +
        `*Usage:* ${p}report <what happened>\n` +
        `_e.g. ${p}report .mine gave me the same reward 5 times in a row_\n\n` +
        `Reporting a person? Reply to their message when you run it — I'll include who it was.`,
      )
    }
    if (text.length > MAX_LENGTH) {
      return reply(`❌ That's too long — keep it under *${MAX_LENGTH}* characters.`)
    }

    const last = lastReport.get(from)
    if (last && Date.now() - last < COOLDOWN_MS) {
      const mins = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 60000)
      return reply(`⏳ You already filed a report. Try again in *${mins} min*.`)
    }

    const owners = (config.ownerNumbers ?? []).filter(Boolean)
    if (!owners.length) {
      logger.warn('Report filed but no ownerNumbers are configured')
      return reply(`❌ No bot owner is configured, so I can't deliver that. Tell an admin directly.`)
    }

    // Where it came from — the owner can't act on "something is broken".
    const reported = extractTarget(msg)
    let chatLabel = 'a DM'
    if (isGroup) {
      // groupMetadata is Baileys-only. This command is deliberately NOT
      // WhatsApp-gated — reporting a bug matters most on the newer platforms —
      // so degrade to the generic label there rather than throwing.
      const subject = typeof sock?.groupMetadata === 'function'
        ? await sock.groupMetadata(sender).then(m => m.subject).catch(() => null)
        : (ctx.guild?.name ?? ctx.chatTitle ?? null)
      chatLabel = subject ? `group "${subject}"` : 'a group'
    }

    const payload =
      `📮 *NEW REPORT*\n─────────────────────\n` +
      `*From:* @${from.replace(/@.*$/, '')}\n` +
      `*Where:* ${chatLabel}\n` +
      (reported ? `*About:* @${reported.replace(/@.*$/, '')}\n` : '') +
      `*When:* ${new Date().toLocaleString()}\n` +
      `─────────────────────\n` +
      `${text}\n` +
      `─────────────────────\n` +
      `_Chat id: ${sender}_`

    const mentions = [from, ...(reported ? [reported] : [])]

    // Delivered to every configured owner. Tracked per-owner so a partial
    // failure is reported honestly instead of claiming success.
    let delivered = 0
    for (const num of owners) {
      const jid = `${String(num).replace(/\D/g, '')}@s.whatsapp.net`
      const ok = await sock.sendMessage(jid, { text: payload, mentions })
        .then(() => true)
        .catch(err => {
          logger.warn({ err: err.message, owner: jid }, 'Report delivery failed')
          return false
        })
      if (ok) delivered++
    }

    if (!delivered) {
      return reply(`❌ I couldn't reach the bot owner just now. Please try again in a few minutes.`)
    }

    lastReport.set(from, Date.now())
    return reply(
      `✅ *Report sent.*\n\n` +
      `The owner has it${delivered > 1 ? ` (${delivered} recipients)` : ''}. Thanks for flagging it.\n` +
      `_You can file another in 5 minutes._`,
    )
  },
}
