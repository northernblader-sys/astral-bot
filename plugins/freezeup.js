/**
 * freezeup.js — Freeze Touch active (premium one-of-one ability).
 *
 * Thin wrapper: all logic lives in lib/premium-active-runner.js. Freezes the
 * current opponent solid for 3-5 turns (scaled by their strength), once per
 * battle, in any format. Only the single player who won 'freeze_touch' from the
 * weekly Premium spin can use it.
 */
import { config } from '../config.js'
import { runPremiumActive } from '../lib/premium-active-runner.js'

export default {
  name: 'freezeup',
  aliases: ['freeze', 'fu'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}freezeup — Freeze Touch: freeze your opponent solid (premium 1-of-1)`,
  run: (ctx) => runPremiumActive(ctx, 'freeze_touch'),
}
