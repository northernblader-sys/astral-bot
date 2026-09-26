/**
 * rename.js — .rename <new name>
 *
 * Lets a player change their display name. Gated by a 1-week cooldown
 * (tracked via player.lastRenameAt, epoch ms) to stop name-flipping abuse
 * — mirrors the once-per-day gate pattern used by plugins/daily.js, just
 * with a 7-day window instead of a calendar day.
 *
 * The rules themselves live in lib/rename-rules.js because the website's
 * PATCH /api/me offers the same thing; this file is just the chat phrasing.
 */
import { config } from '../config.js'
import {
  renamePlayer, formatRemaining, MIN_LENGTH, MAX_LENGTH,
} from '../lib/rename-rules.js'

export default {
  name: 'rename',
  aliases: ['namechange', 'setname'],
  category: 'account',
  requiresPlayer: true,
  description: `Change your display name (${config.prefix}rename <new name>) — 1x per week`,

  async run(ctx) {
    const { args, db, from, reply } = ctx
    const p = config.prefix
    const newName = args.join(' ').trim()

    if (!newName) {
      return reply(
        `❌ *Usage:* ${p}rename <new name>\n` +
        `${MIN_LENGTH}-${MAX_LENGTH} characters, letters/numbers only. Can be used once every 7 days.\n` +
        `Example: ${p}rename Aragorn`,
      )
    }

    const outcome = await renamePlayer(db, from, newName)

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'length':
          return reply(`❌ Name must be between *${MIN_LENGTH}* and *${MAX_LENGTH}* characters.`)
        case 'charset':
          return reply(`❌ Name can only contain letters, numbers, spaces, and *-_.'*`)
        case 'same':
          return reply(`⚠️ That's already your name.`)
        case 'cooldown':
          return reply(
            `⏳ *You can't rename yet.*\n` +
            `Next rename available in *${formatRemaining(outcome.remainingMs)}* ` +
            `_(${new Date(outcome.nextAllowedAt).toLocaleDateString()})_`,
          )
        default:
          return reply(`❌ *Usage:* ${p}rename <new name>`)
      }
    }

    return reply(
      `✅ *Name changed!*\n${outcome.oldName} → *${outcome.newName}*\n\n` +
      `_You can rename again in 7 days._`,
    )
  },
}
