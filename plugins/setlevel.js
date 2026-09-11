/**
 * setlevel.js — .setlevel <level> [@mention | reply]
 * Standalone top-level alias for ".admin setlevel" — owner-only. Force-sets
 * a target player's level (recalculating stats/HP/MP for it). Shares the
 * exact same logic as admin.js so behavior never drifts between the two
 * entry points.
 */
import { isOwnerJid } from '../lib/group-helpers.js'
import { setLevel } from './admin.js'

export default {
  name:        'setlevel',
  aliases:     ['forcelevel'],
  category:    'admin',
  requiresPlayer: false,
  description: 'Owner-only: force-set a player\'s level',

  async run(ctx) {
    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply(`❌ This command is restricted to the bot owner.`)
    }

    // setLevel reads level from args[1] (args[0] is the subcommand name in
    // admin.js's flow) — shift args by one to line up the same way.
    const shiftedCtx = { ...ctx, args: [null, ...ctx.args] }
    return setLevel(shiftedCtx)
  },
}
