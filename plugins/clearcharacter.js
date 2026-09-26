/**
 * clearcharacter.js — `.clearcharacter <exclusive character>`.
 * Owner-only global reset for a one-of-one character: remove its saved
 * ownership entries, strip equipment bonuses, and reopen the bot-wide claim.
 */
import { isOwnerJid } from '../lib/group-helpers.js'
import { clearCharacter } from './admin.js'

export default {
  name: 'clearcharacter',
  aliases: ['clearchar', 'cc'],
  category: 'admin',
  requiresPlayer: false,
  description: 'Owner-only: clear an exclusive character claim and reopen it',

  async run(ctx) {
    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply('❌ This command is restricted to the bot owner.')
    }
    return clearCharacter({ ...ctx, args: [null, ...ctx.args] })
  },
}
