/**
 * trade.js — top-level `.trade` command for responding to a Trader NPC's
 * barter offer surfaced by `.roam`. Kept as its own file for the same
 * reason as work.js/pattack.js: the plugin loader registers one command
 * name (+aliases) per file's default export.
 */
import { tradeStatus, tradeAccept, tradeDecline } from './roam.js'

export default {
  name: 'trade',
  aliases: [],
  category: 'town',
  requiresPlayer: true,
  description: 'Respond to a Trader NPC\'s barter offer from .roam',

  async run(ctx) {
    const sub = ctx.args[0]?.toLowerCase()
    if (sub === 'accept' || sub === 'yes') return tradeAccept(ctx)
    if (sub === 'decline' || sub === 'no') return tradeDecline(ctx)
    return tradeStatus(ctx)
  },
}
