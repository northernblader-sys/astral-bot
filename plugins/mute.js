/**
 * mute.js — .mute @user [duration] / .unmute @user / .mutelist
 *
 * A muted member stays in the group; their messages are silently deleted by
 * the scan in handler.js. No kick, ever — that's the whole point of mute as
 * distinct from kick.
 *
 * Duration accepts 30s / 10m / 2h / 1d. Omitted means indefinite.
 */
import { setMute, clearMute, listMutes, clearExpiredMutes } from '../lib/moderation-state.js'
import { isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'
import { NOT_GROUP, NOT_ALLOWED, extractTarget, isOwnerJid, checkBotAdmin } from '../lib/group-helpers.js'
import { config } from '../config.js'
import { humanDuration } from './afk.js'

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
const MAX_MS = 30 * 86_400_000   // 30d ceiling so a typo can't mute for a decade

/** "10m" -> 600000. Bare digits are read as minutes. Returns null if unparseable. */
function parseDuration(input) {
  const raw = String(input ?? '').trim().toLowerCase()
  if (!raw) return null
  const m = raw.match(/^(\d+)\s*([smhd])?$/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!n) return null
  const ms = n * (UNITS[m[2] ?? 'm'] ?? 60_000)
  return ms > MAX_MS ? null : ms
}

const tag = jid => `@${String(jid).replace(/@.*$/, '')}`

export default {
  name:        'mute',
  aliases:     ['unmute', 'mutelist', 'muted'],
  category:    'utility',
  platforms:    ['whatsapp'],   // enforced by handler.js's WhatsApp message loop only
  description: 'Silently delete a member\'s messages without removing them (.mute @user [10m])',
  subcommands: [
    { cmd: '@user [duration]', desc: 'mute — 30s / 10m / 2h / 1d, blank = forever' },
  ],

  async run(ctx) {
    const { args, reply, sender, from, isGroup, msg, sock } = ctx
    const p = config.prefix
    if (!isGroup) return reply(NOT_GROUP)

    // ── .mutelist ─────────────────────────────────────────────────────────
    if (ctx.cmd === 'mutelist' || ctx.cmd === 'muted') {
      await clearExpiredMutes()
      const list = await listMutes(sender)
      if (!list.length) return reply(`🔇 *MUTE LIST*\n\n_Nobody is muted here._`)
      const lines = list.map(([jid, rec]) =>
        `• ${tag(jid)} — ` +
        (rec.until == null
          ? 'indefinite'
          : `${humanDuration(rec.until - Date.now())} left`),
      )
      return sock.sendMessage(sender, {
        text: `🔇 *MUTE LIST*\n─────────────────────\n${lines.join('\n')}\n\n_${p}unmute @user to lift one._`,
        mentions: list.map(([jid]) => jid),
      }, { quoted: msg })
    }

    if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

    const target = extractTarget(msg)
    if (!target) {
      return reply(`❌ *Usage:* ${p}${ctx.cmd} @user${ctx.cmd === 'mute' ? ' [10m]' : ''}\n_Tag them, or reply to one of their messages._`)
    }

    // ── .unmute ───────────────────────────────────────────────────────────
    if (ctx.cmd === 'unmute') {
      const existed = await clearMute(sender, target)
      return sock.sendMessage(sender, {
        text: existed
          ? `🔊 ${tag(target)} is unmuted — they can talk again.`
          : `_${tag(target)} wasn't muted._`,
        mentions: [target],
      }, { quoted: msg })
    }

    // ── .mute ─────────────────────────────────────────────────────────────
    if (isOwnerJid(target)) return reply(`❌ You can't mute the bot owner.`)
    if (target === from)     return reply(`❌ You can't mute yourself.`)

    // Muting an admin would be a no-op the scan refuses to act on, so say so
    // up front rather than writing a record that never does anything.
    try {
      const { meta } = await checkBotAdmin(sock, sender)
      const entry = meta.participants.find(pt => pt.id === target)
      if (entry?.admin === 'admin' || entry?.admin === 'superadmin') {
        return reply(`❌ ${tag(target).replace('@', '')} is a group admin — admins are exempt from mute.`)
      }
    } catch { /* metadata unavailable — proceed, the scan re-checks anyway */ }

    // The bot has to be admin to delete anything, so warn instead of writing
    // a mute that will silently do nothing.
    const { isAdmin: botIsAdmin } = await checkBotAdmin(sock, sender).catch(() => ({ isAdmin: false }))

    const durArg = args.find(a => /^\d+\s*[smhd]?$/i.test(a))
    let until = null
    if (durArg) {
      const ms = parseDuration(durArg)
      if (ms == null) return reply(`❌ Bad duration. Use *30s*, *10m*, *2h* or *1d* (max 30d).`)
      until = Date.now() + ms
    }

    await setMute(sender, target, { until, by: from })

    return sock.sendMessage(sender, {
      text:
        `🔇 ${tag(target)} is muted${until ? ` for *${humanDuration(until - Date.now())}*` : ' *indefinitely*'}.\n` +
        `_Their messages will be deleted. They stay in the group._\n` +
        `Lift it with *${p}unmute @user*.` +
        (botIsAdmin ? '' : `\n\n⚠️ I'm not an admin here, so I can't actually delete their messages yet. Make me an admin.`),
      mentions: [target],
    }, { quoted: msg })
  },
}
