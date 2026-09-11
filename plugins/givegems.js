/**
 * givegems.js — .givegems <amount> [@mention | reply]
 * Standalone top-level alias for ".admin givegems" — owner-only. Grants
 * Gems to a target player (defaults to yourself if no @mention/reply given).
 * Shares the exact same logic as admin.js so behavior never drifts between
 * the two entry points.
 */
import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { giveCurrency } from './admin.js'

export default {
  name:        'givegems',
  aliases:     ['givegem'],
  category:    'admin',
  requiresPlayer: false,
  description: 'Owner-only: grant Gems to a player',

  async run(ctx) {
    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply(`❌ This command is restricted to the bot owner.`)
    }

    // giveCurrency reads amount from args[1] (args[0] is the subcommand name
    // in admin.js's flow) — so shift args by one to line up the same way.
    const shiftedCtx = { ...ctx, args: [null, ...ctx.args] }
    return giveCurrency(shiftedCtx, 'gems')
  },
}
