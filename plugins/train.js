/**
 * .train — buy level-pool stat points with Solars.
 * The level-derived ceiling is enforced again inside updatePlayer.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { trainCostPerPoint, trainPlayer } from '../lib/stat-progression.js'
import { armyTrainSoldier } from './army.js'

export default {
  name: 'train',
  aliases: [],
  category: 'account',
  requiresPlayer: true,
  description: 'Buy stat points with Solars without exceeding your level cap',

  async run(ctx) {
    // .train soldier <n> promotes empire troops, not stat points. Delegate to
    // the army plugin and leave the stat-point path below completely untouched.
    if (String(ctx.args?.[0] ?? '').toLowerCase() === 'soldier') {
      return armyTrainSoldier(ctx, ctx.args?.[1])
    }

    const requested = Math.floor(Number(ctx.args?.[0] ?? 15))
    if (!Number.isFinite(requested) || requested <= 0) {
      return ctx.reply(`❌ Usage: *${config.prefix}train [positive amount]*`)
    }

    let outcome
    await updatePlayer(ctx.db, ctx.from, (player) => {
      outcome = trainPlayer(player, requested)
      return player
    })

    if (!outcome?.ok) {
      if (outcome.error === 'full') {
        return ctx.reply(`✅ Your level ${ctx.player.level} stat-point pool is already full.`)
      }
      if (outcome.error === 'poor') {
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
  },
}