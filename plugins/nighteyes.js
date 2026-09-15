/**
 * nighteyes.js — Night Eyes active (premium one-of-one ability).
 *
 * Thin wrapper: all logic lives in lib/premium-active-runner.js. Drags the
 * current opponent into sleep for 3 turns (they skip until they wake), once per
 * battle, in any format. Only the single player who won 'night_eyes' from the
 * weekly Premium spin can use it.
 */
import { config } from '../config.js'
import { runPremiumActive } from '../lib/premium-active-runner.js'

export default {
  name: 'nighteyes',
  aliases: ['ne'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}nighteyes — Night Eyes: lull your opponent to sleep (premium 1-of-1)`,
  run: (ctx) => runPremiumActive(ctx, 'night_eyes'),
}
