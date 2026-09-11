/**
 * giveitem.js — .giveitem <itemId> [amount] [@mention | reply]
 * Standalone top-level alias for ".admin giveitem" — owner-only. Grants an
 * item (e.g. totem_of_undying) to a target player (defaults to yourself if
 * no @mention/reply given). Shares the exact same logic as admin.js so
 * behavior never drifts between the two entry points.
 *
 * Example: .giveitem totem_of_undying 1 @player
 */
import { isOwnerJid } from '../lib/group-helpers.js'
import { giveItem } from './admin.js'

export default {
  name:        'giveitem',
  aliases:     ['gi', 'giveme'],
  category:    'admin',
  requiresPlayer: false,
  description: 'Owner-only: grant an item to a player',

  async run(ctx) {
    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply(`❌ This command is restricted to the bot owner.`)
    }

    // giveItem reads itemId from args[1] (args[0] is the subcommand name in
    // admin.js's flow) — shift args by one to line up the same way.
    const shiftedCtx = { ...ctx, args: [null, ...ctx.args] }
    return giveItem(shiftedCtx)
  },
}
