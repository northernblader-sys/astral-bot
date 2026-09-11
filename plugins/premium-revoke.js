/**
 * premium-revoke.js — .premium-revoke <player name> or reply/@mention
 *
 * Owner-only command for removing a player's Premium subscription. It clears
 * both active Premium state and any pending Premium purchase, while leaving
 * the player's inventory, progress, currency, and other account data intact.
 */
import { config } from '../config.js'
import { extractTarget, isOwnerJid } from '../lib/group-helpers.js'
import { getPlayer, updatePlayer } from '../lib/player-repo.js'

function playersMatchingName(db, query) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []

  const players = Object.values(db.data.users ?? {})
  const exact = players.filter(player => player.name?.trim().toLowerCase() === normalized)
  if (exact.length) return exact

  return players.filter(player => player.name?.toLowerCase().includes(normalized))
}

function resolveTarget(ctx) {
  const mentionedId = extractTarget(ctx)
  if (mentionedId) {
    return { player: getPlayer(ctx.db, mentionedId), ambiguous: false }
  }

  const query = ctx.args.join(' ').trim()
  if (!query) return { player: null, ambiguous: false }

  // Allow the owner to use a stored player id when a name is inconvenient.
  const direct = getPlayer(ctx.db, query)
  if (direct) return { player: direct, ambiguous: false }

  const matches = playersMatchingName(ctx.db, query)
  return {
    player: matches.length === 1 ? matches[0] : null,
    ambiguous: matches.length > 1,
  }
}

function usage() {
  return (
    `Usage: *${config.prefix}premium-revoke <player name>*\n` +
    `Or reply to the player's message / @mention them.`
  )
}

export default {
  name: 'premium-revoke',
  aliases: ['revoke-premium'],
  category: 'admin',
  platforms: ['whatsapp'],
  requiresPlayer: false,
  description: '[OWNER] Remove a player\'s Premium plan',

  async run(ctx) {
    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply(`❌ This command is restricted to the bot owner.`)
    }

    const { player: target, ambiguous } = resolveTarget(ctx)
    if (ambiguous) {
      return ctx.reply(
        `❌ More than one player matches that name. Reply to the correct player's message or @mention them.\n\n${usage()}`,
      )
    }
    if (!target) {
      return ctx.reply(`❌ Player not found, or no target was provided.\n\n${usage()}`)
    }

    if (isOwnerJid(target.id)) {
      return ctx.reply(`❌ The bot owner cannot be downgraded with this command.`)
    }

    const hadPremiumState = Boolean(
      target.premium?.active ||
      target.premium?.plan ||
      target.premium?.expiresAt,
    )
    const hadPendingPurchase = Boolean(target.premiumPending)

    if (!hadPremiumState && !hadPendingPurchase) {
      return ctx.reply(`ℹ️ *${target.name}* is already a normal player with no Premium state.`)
    }

    await updatePlayer(ctx.db, target.id, player => {
      if (player.premium) {
        player.premium.active = false
        player.premium.plan = null
        player.premium.expiresAt = null
        player.premium.autoReviveUsedToday = false
        player.premium.autoReviveDate = null
      }
      player.premiumPending = null
    })

    await ctx.sock.sendMessage(target.id, {
      text:
        `🔓 *Your Premium plan has been removed.*\n\n` +
        `Your account is now a normal player account. Your level, inventory, ` +
        `currency, and other progress were not changed.`,
    }).catch(() => {})

    const cleared = [
      hadPremiumState ? 'active Premium' : null,
      hadPendingPurchase ? 'pending Premium purchase' : null,
    ].filter(Boolean).join(' and ')

    return ctx.reply(`✅ Removed *${cleared}* from *${target.name}*. They are now a normal player.`)
  },
}