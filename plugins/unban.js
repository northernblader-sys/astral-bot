/**
 * unban.js — .unban (reply to a member's message, @mention them, or pass a
 * number/name)
 *
 * Reverses a .ban. Same permission tier as .ban (bot owner or WhatsApp group
 * admin/mod). Always reachable even from a banned user's own chat (handler.js
 * exempts 'unban' from the ban lockout) — though the permission check below
 * still applies, so a banned non-admin can't unban themselves.
 *
 * The number/name form exists for appeals: an unban decision is usually taken
 * in the mod GC (a filled-in unban form arrives there — see
 * lib/unban-appeal.js), where the banned person isn't a member and so can be
 * neither replied to nor mentioned. The appeal message posted there spells out
 * the exact `.unban <number>` to run.
 *
 * Accepting an appeal also clears it and DMs the person, so they find out
 * without having to poke the bot to see whether it worked.
 */
import { extractTarget, isOwnerJid, NOT_ALLOWED } from '../lib/group-helpers.js'
import { isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'
import { unbanUser, getBan } from '../lib/ban-repo.js'
import { isMod } from '../lib/mod-repo.js'
import { getUnbanAppeal, clearUnbanAppeal } from '../lib/unban-appeal.js'
import { config } from '../config.js'

/** Digits of a jid, ignoring any `:device` suffix — 234700:12@lid → 234700. */
function jidDigits(jid) {
  return String(jid ?? '').replace(/[:@].*$/, '').replace(/\D/g, '')
}

/**
 * Resolves a free-text `.unban` argument to a JID. Handles, in order:
 *   - a full jid            2347060000000@s.whatsapp.net / 12345@lid
 *   - a phone number        +234 706 000 0000, 2347060000000
 *   - a registered name     okayokaery
 *
 * Numbers and names are matched against the ban list FIRST (any stored jid
 * whose digits match, whatever its @domain — LID accounts are banned under
 * @lid, not @s.whatsapp.net, so assuming a domain would miss them). Only if
 * nothing is banned under that number does it fall back to the plain
 * @s.whatsapp.net form, which then reports "isn't currently banned".
 */
function resolveTarget(db, query) {
  const raw = String(query ?? '').trim()
  if (!raw) return null

  const bannedJids = Object.keys(db.data.bans ?? {})

  if (/@/.test(raw)) return raw.toLowerCase()

  const digits = raw.replace(/\D/g, '')
  if (digits && /^[\d\s+()-]+$/.test(raw)) {
    return bannedJids.find(jid => jidDigits(jid) === digits) ?? `${digits}@s.whatsapp.net`
  }

  // Name lookup — banned players first, so a partial name can't resolve to
  // some unbanned player who merely matches the text better.
  const q = raw.toLowerCase()
  const users = Object.values(db.data.users ?? {})
  const banned = users.filter(u => bannedJids.includes(u.id))
  const pools = [banned, users]
  for (const pool of pools) {
    const hit = pool.find(u => u.name?.toLowerCase() === q)
      ?? pool.find(u => u.name?.toLowerCase().includes(q))
    if (hit) return hit.id
  }
  return null
}

export default {
  name:        'unban',
  aliases:     [],
  category:    'admin',
  description: 'Remove a ban (reply to their message, @mention them, or pass a number/name)',

  async run(ctx) {
    const { reply, msg, db, args, sock, sender } = ctx

    if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

    const query  = args.join(' ').trim()
    const target = extractTarget(msg) ?? (query ? resolveTarget(db, query) : null)

    if (!target) {
      return reply(
        query
          ? `❌ No banned player matching *"${query}"* — pass their number (e.g. ` +
            `*${config.prefix}unban 2347060000000*) or reply to one of their messages.`
          : `❌ Reply to the member's message, @mention them, or pass their number/name.\n\n` +
            `*Usage:* ${config.prefix}unban (reply to user)\n` +
            `        ${config.prefix}unban <number|name>`,
      )
    }

    const existing   = getBan(db, target)
    const bareTarget = jidDigits(target) || target.replace(/@.*$/, '')

    if (!existing) {
      return sock.sendMessage(sender, {
        text: `⚠️ @${bareTarget} isn't currently banned.`,
        mentions: [target],
      }, { quoted: msg })
    }

    // Antispam auto-bans are owner/mod-only to reverse. A group admin (who may
    // be the spammer's friend) must not be able to instantly override the
    // system's timeout — it's short and clears itself anyway. Manual .bans are
    // unaffected: any admin/owner/mod can still lift those (gate above).
    if (existing.auto && !(isOwnerJid(ctx.from) || isMod(db, ctx.from))) {
      return reply(
        `❌ @${bareTarget} is on an automatic spam timeout — only the bot owner or a mod can lift it early. ` +
        `It also clears on its own shortly.`,
      )
    }

    const hadAppeal = !!getUnbanAppeal(db, target)

    await unbanUser(db, target)
    await clearUnbanAppeal(db, target)

    // Tell them directly — most unbans are decided in the mod GC, where the
    // person being unbanned isn't present to see this reply.
    await sock.sendMessage(target, {
      text:
        `✅ *You've been unbanned.*\n\n` +
        (hadAppeal ? `Your unban form was accepted — ` : '') +
        `every command works again. Keep it clean this time.`,
    }).catch(() => {})

    return sock.sendMessage(sender, {
      text:
        `✅ Unbanned @${bareTarget}. They can use the bot again.` +
        (hadAppeal ? `\n_Their unban appeal was closed as accepted._` : ''),
      mentions: [target],
    }, { quoted: msg })
  },
}
