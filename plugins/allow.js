/**
 * allow.js — .allow / .disallow (reply to a member's message, or @mention them)
 *
 * OWNER ONLY — not WhatsApp group admins. This deliberately does NOT use
 * isGroupOrBotOwner (which lets group admins through on things like .ban) —
 * granting tool access is a bot-owner-only power, same tier as .manhwa
 * itself, and stays that way regardless of who's an admin in a given group.
 *
 * Grants (or revokes) permission to use the manga/manhwa downloader tools:
 * .pill / .pilldl / .pillurl / .pillinfo, .manhwa / .manhwadl, and .dload.
 * The bot owner always has access to these regardless of the allowlist —
 * .allow is for extending that access to someone else.
 *
 * Usage:
 *   .allow (reply to user)       — grant manga/manhwa tool access
 *   .disallow (reply to user)    — revoke it
 *   .allow list                  — show everyone currently allowed
 */
import { extractTarget, isOwnerJid } from '../lib/group-helpers.js'
import { allowManga, disallowManga, listMangaAllowed, getMangaAllow } from '../lib/manga-allow-repo.js'
import { config } from '../config.js'

export default {
  name:        'allow',
  aliases:     ['disallow'],
  category:    'admin',
  description: '[OWNER] Grant/revoke access to the manga & manhwa download tools',

  async run(ctx) {
    const { reply, msg, from, db, args, sock, sender, cmd } = ctx

    if (!isOwnerJid(from)) {
      return reply('🔒 This command is owner-only.')
    }

    // ── .allow list ──────────────────────────────────────────────────────
    if (cmd === 'allow' && args[0]?.toLowerCase() === 'list') {
      const ids = listMangaAllowed(db)
      if (!ids.length) return reply('📋 No one has been granted manga/manhwa access yet.')
      const lines = ids.map(id => {
        const rec = getMangaAllow(db, id)
        const bare = id.replace(/@.*$/, '')
        return `• @${bare}${rec?.allowedAt ? `  _(since ${new Date(rec.allowedAt).toLocaleDateString()})_` : ''}`
      })
      return sock.sendMessage(sender, {
        text: `📋 *Manga/Manhwa access — allowed users*\n\n${lines.join('\n')}`,
        mentions: ids,
      }, { quoted: msg })
    }

    const target = extractTarget(msg)
    if (!target) {
      return reply(
        `❌ Reply to the member's message (or @mention them).\n\n` +
        `*Usage:*\n` +
        `${config.prefix}allow (reply to user) — grant manga/manhwa tool access\n` +
        `${config.prefix}disallow (reply to user) — revoke it\n` +
        `${config.prefix}allow list — show everyone currently allowed`,
      )
    }

    if (isOwnerJid(target)) {
      return reply('❌ The bot owner already has full access — nothing to change.')
    }

    const bareTarget = target.replace(/@.*$/, '')

    if (cmd === 'disallow') {
      const removed = await disallowManga(db, target)
      return sock.sendMessage(sender, {
        text: removed
          ? `🔒 Revoked manga/manhwa tool access from @${bareTarget}.`
          : `⚠️ @${bareTarget} didn't have manga/manhwa tool access.`,
        mentions: [target],
      }, { quoted: msg })
    }

    // ── .allow ────────────────────────────────────────────────────────────
    const existing = getMangaAllow(db, target)
    await allowManga(db, target, from)
    return sock.sendMessage(sender, {
      text:
        `✅ ${existing ? 'Re-confirmed' : 'Granted'} @${bareTarget} access to the manga/manhwa tools.\n` +
        `They can now use *${config.prefix}pill*, *${config.prefix}manhwa*, and *${config.prefix}dload*.\n` +
        `Revoke anytime with *${config.prefix}disallow* (reply to them).`,
      mentions: [target],
    }, { quoted: msg })
  },
}
