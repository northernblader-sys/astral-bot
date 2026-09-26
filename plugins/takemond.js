/**
 * takemond.js — `.takemond <amount|all> [@mention | reply]`.
 * Owner-only forced collection of Monds from a player's wallet.
 */
import { isOwnerJid } from '../lib/group-helpers.js'
import { takeMonds } from './admin.js'

export default {
  name: 'takemond',
  aliases: ['takemonds', 'tm'],
  category: 'admin',
  requiresPlayer: false,
  description: 'Owner-only: collect Monds from a player',

  async run(ctx) {
    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply('❌ This command is restricted to the bot owner.')
    }
    return takeMonds({ ...ctx, args: [null, ...ctx.args] })
  },
}
