/**
 * ultimate.js — the dragon's ultimate, Nisha's spin-exclusive standalone
 * companion (lib/dragon-engine.js). Mirrors plugins/cinderverdict.js's
 * top-level-command-that-hands-off-to-pvp.js shape, but simpler: unlike
 * Cinder Verdict the dragon has no PvE path at all — it only works in PvP
 * duels (see lib/dragon-engine.js's doc comment for why) — so there's no
 * PvE branch to fall through to here.
 *
 * Usage: <prefix>ultimate   (while in a PvP duel, on your turn, turn 4+)
 */
import { config } from '../config.js'
import { hasDragon } from '../lib/dragon-engine.js'
import { pvpUltimate, inPvpDuel } from './pvp.js'

export default {
  name: 'ultimate',
  aliases: ['dragonultimate', 'dragon-ultimate'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}ultimate — the dragon's once-per-battle finisher (PvP only, from turn 4)`,

  async run(ctx) {
    const player = ctx.player
    if (!hasDragon(player)) {
      return ctx.reply(`❌ You don't have a dragon. It's granted automatically if you win Nisha's exclusive spin (*${config.prefix}ni-spin*).`)
    }
    if (!inPvpDuel(player)) {
      return ctx.reply(`❌ The dragon only answers in PvP duels. Challenge someone: *${config.prefix}pvp @target*`)
    }
    return pvpUltimate(ctx)
  },
}
