/**
 * heatwave.js — Heat Blaze active (premium one-of-one ability).
 *
 * Thin wrapper: all logic lives in lib/premium-active-runner.js. Sets the
 * current opponent alight for heavy burn damage over 3-5 turns (scaled by their
 * strength), once per battle, in any format. Only the single player who won
 * 'heat_blaze' from the weekly Premium spin can use it.
 */
import { config } from '../config.js'
import { runPremiumActive } from '../lib/premium-active-runner.js'

export default {
  name: 'heatwave',
  aliases: ['heat', 'hw'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}heatwave — Heat Blaze: engulf your opponent in flame (premium 1-of-1)`,
  run: (ctx) => runPremiumActive(ctx, 'heat_blaze'),
}
