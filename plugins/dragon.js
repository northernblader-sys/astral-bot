/**
 * dragon.js — status check for Nisha's spin-exclusive standalone dragon
 * companion (lib/dragon-engine.js). Read-only: shows whether the dragon is
 * asleep (resting off its last ultimate) or awake and, if awake, a random
 * flavor line for what it's up to right now. Purely cosmetic — sleep never
 * gates the ultimate itself (see lib/dragon-engine.js's doc comment on
 * dragonSleepUntil); this command exists so the owner has something to
 * check between fights, nothing more.
 *
 * Usage: <prefix>dragon
 */
import { config } from '../config.js'
import { hasDragon, dragonStatusLine } from '../lib/dragon-engine.js'

export default {
  name: 'dragon',
  aliases: ['mydragon'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}dragon — check on your dragon (Nisha's spin-exclusive companion)`,

  async run(ctx) {
    const player = ctx.player
    if (!hasDragon(player)) {
      return ctx.reply(`❌ You don't have a dragon. It's granted automatically if you win Nisha's exclusive spin (*${config.prefix}ni-spin*).`)
    }
    return ctx.reply(
      `🐉 *YOUR DRAGON*\n─────────────\n` +
      dragonStatusLine(player) +
      `\n\n_Once per PvP duel, from turn 4 onward: *${config.prefix}ultimate*._`,
    )
  },
}
