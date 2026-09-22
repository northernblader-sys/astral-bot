/**
 * .stats — inspect and spend the player's level-derived stat pool.
 *
 * Usage:
 *   .stats                                     — stat panel IMAGE + summary
 *   .stats add <str|agi|int|def|lck> <amount>  — allocate points (text reply)
 *   .train [amount]                            — buy points with Solars (text)
 *
 * Bare `.stats` renders the obsidian-and-gold stat sheet
 * (lib/stats-card-render.mjs) with the player's live numbers and sends it as
 * the image, with a short summary as the caption. The full text sheet below
 * is the fallback when the render fails, and stays the reply for unknown
 * subcommands — so the numbers are never hostage to canvas.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
  STAT_KEYS,
  ensureStatPoints,
  statPointCap,
  trainCostPerPoint,
  addAllocation,
  trainPlayer,
} from '../lib/stat-progression.js'
import { playerLevelCap } from '../lib/reborn-engine.js'
import { endStatusBadge } from '../lib/end-event.js'
import { renderStatsCard } from '../lib/stats-card-render.mjs'

/**
 * `db` is optional — pass it to surface The End's aura line, which is the only
 * place a player can see that their stats are being cut (lib/end-event.js).
 */
function stateText(player, db) {
  const state = ensureStatPoints(player)
  const stats = player.stats ?? {}
  const endLine = db ? endStatusBadge(db, player) : null
  return (
    `📊 *${player.name}'s Stat Points*\n\n` +
    (endLine ? `${endLine}\n\n` : '') +
    `🏅 Level: *${player.level}/${playerLevelCap(player)}*\n` +
    `✨ Unallocated: *${state.unallocated}*\n` +
    `📈 Earned: *${state.earned}/${statPointCap(player.level, player)}* at this level\n\n` +
    `💪 STR ${stats.str ?? 0}  🏃 AGI ${stats.agi ?? 0}  🧠 INT ${stats.int ?? 0}\n` +
    `🛡️ DEF ${stats.def ?? 0}  🍀 LCK ${stats.lck ?? 0}\n\n` +
    `Use *${config.prefix}stats add <stat> <amount>* to allocate points.\n` +
    `Use *${config.prefix}train [amount]* to buy points with Solars.\n` +
    `_Points are permanent once allocated._`
  )
}

export default {
  name: 'stats',
  aliases: ['stat'],
  category: 'account',
  requiresPlayer: true,
  description: 'View and allocate your level-based stat points',

  async run(ctx) {
    const [sub, stat, rawAmount] = ctx.args ?? []
    const command = String(sub ?? '').toLowerCase()
    if (!command) {
      // Stat sheet image with the player's live numbers. Short caption —
      // the image carries the breakdown; the full text sheet below is the
      // fallback so a canvas failure never swallows the command.
      const state = ensureStatPoints(ctx.player)
      const endLine = endStatusBadge(ctx.db, ctx.player)
      const caption =
        `📊 *${ctx.player.name}'s Stat Points*\n\n` +
        (endLine ? `${endLine}\n\n` : '') +
        `🏅 Level: *${ctx.player.level}/${playerLevelCap(ctx.player)}*  ·  ` +
        `✨ Unallocated: *${state.unallocated}*\n` +
        `Earned: *${state.earned}/${statPointCap(ctx.player.level, ctx.player)}* at this level\n\n` +
        `Use *${config.prefix}stats add <stat> <amount>* to allocate points.\n` +
        `Use *${config.prefix}train [amount]* to buy points with Solars.`
      try {
        const sheet = await renderStatsCard(ctx.player, { prefix: config.prefix, endLine })
        return await ctx.replyImage(sheet, caption)
      } catch (err) {
        return ctx.reply(stateText(ctx.player, ctx.db))
      }
    }

    if (command === 'add' || command === 'allocate') {
      const amount = Math.floor(Number(rawAmount))
      if (!STAT_KEYS.includes(String(stat).toLowerCase()) || !Number.isFinite(amount) || amount <= 0) {
        return ctx.reply(
          `❌ Usage: *${config.prefix}stats add <str|agi|int|def|lck> <amount>*`,
        )
      }

      let outcome
      await updatePlayer(ctx.db, ctx.from, (player) => {
        outcome = addAllocation(player, stat, amount)
        return player
      })
      if (!outcome?.ok) {
        return ctx.reply(
          outcome?.error === 'not_enough'
            ? `❌ You only have *${outcome.available}* unallocated point(s).`
            : `❌ Could not allocate those points.`,
        )
      }
      return ctx.reply(
        `✅ Added *${outcome.points}* point(s) to *${outcome.stat.toUpperCase()}*.\n` +
        `✨ Remaining: *${outcome.remaining}* unallocated point(s).`,
      )
    }

    if (command === 'train' || /^\d+$/.test(command)) {
      const requested = command === 'train' ? (rawAmount ?? stat) : command
      const amount = Math.floor(
        Number(requested) ||
        0,
      )
      const defaultAmount = 15
      const pointsToBuy = amount > 0 ? amount : defaultAmount
      let outcome
      await updatePlayer(ctx.db, ctx.from, (player) => {
        outcome = trainPlayer(player, pointsToBuy)
        return player
      })
      if (!outcome?.ok) {
        if (outcome?.error === 'full') {
          return ctx.reply(`✅ Your level ${ctx.player.level} pool is already full.`)
        }
        if (outcome?.error === 'poor') {
          return ctx.reply(
            `❌ Training ${outcome.points} point(s) costs *☀️ ${outcome.cost.toLocaleString()}*; ` +
            `you have *☀️ ${(outcome.have ?? 0).toLocaleString()}*.`,
          )
        }
        return ctx.reply(`❌ Training amount must be a positive whole number.`)
      }
      return ctx.reply(
        `✅ Training complete: *${outcome.points}* point(s) added for *☀️ ${outcome.cost.toLocaleString()}*.\n` +
        `✨ Unallocated: *${outcome.remaining}* point(s).\n` +
        `_Rate at level ${ctx.player.level}: ☀️ ${trainCostPerPoint(ctx.player.level)} per point._`,
      )
    }

    return ctx.reply(stateText(ctx.player, ctx.db))
  },
}