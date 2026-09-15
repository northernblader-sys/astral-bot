/**
 * daylight.js — Daylight Ring active (premium one-of-one ability).
 *
 * Thin wrapper: all logic lives in lib/premium-active-runner.js. Surges every
 * one of the owner's stats for 5 turns, and if the opponent was ALREADY the
 * weaker fighter, pins them in the light so their attacks do nothing. Once per
 * battle, in any format. Only the single player who won 'daylight_ring' from the
 * weekly Premium spin can use it.
 */
import { config } from '../config.js'
import { runPremiumActive } from '../lib/premium-active-runner.js'

export default {
  name: 'daylight',
  aliases: ['day', 'sunrise'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}daylight — Daylight Ring: the sun rises, every stat surges (premium 1-of-1)`,
  run: (ctx) => runPremiumActive(ctx, 'daylight_ring'),
}
