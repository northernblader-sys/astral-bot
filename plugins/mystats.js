/**
 * mystats.js — condensed personal snapshot.
 *
 * Shows three things at a glance:
 *   • Level
 *   • Combined net worth (wallet.solars + bankGold + vault, ignoring gems
 *     since they aren't freely convertible to solars)
 *   • Win/loss record (player.battleRecord.wins / player.battleRecord.losses,
 *     added in lib/combat-handlers.js — defaults to 0 for players registered
 *     before that field was added)
 *
 * Deliberately lighter than .profile — one quick read, no equip breakdown.
 */
import { config } from '../config.js'
import { endStatusBadge } from '../lib/end-event.js'

export default {
  name:           'mystats',
  aliases:        ['mystat', 'ms'],
  category:       'account',
  requiresPlayer: true,
  description:    'Quick personal snapshot: level, net worth, win/loss record',

  run(ctx) {
    const { player } = ctx
    const p = config.prefix
    const w = player.wallet ?? {}

    // Net worth: liquid solars + bank + vault (gems excluded — not fungible)
    const netWorth = (w.solars ?? 0) + (w.bankGold ?? 0) + (w.vault ?? 0)

    const wins   = player.battleRecord?.wins   ?? 0
    const losses = player.battleRecord?.losses ?? 0
    const total  = wins + losses
    const ratio  = total > 0 ? `${(wins / total * 100).toFixed(0)}% win rate` : 'no battles yet'

    // The End's aura, if it's running (lib/end-event.js) — null otherwise.
    const endLine = endStatusBadge(ctx.db, player)

    return ctx.reply(
      `📊 *${player.name}'s Stats*\n\n` +
      (endLine ? `${endLine}\n\n` : '') +
      `⚔️ Level: *${player.level}*\n` +
      `💰 Net worth: *☀️ ${netWorth.toLocaleString()}* _(wallet + bank + vault)_\n` +
      `🏆 Record: *${wins}W / ${losses}L* _(${ratio})_\n\n` +
      `_Full profile: *${p}profile* · Rankings: *${p}top*_`,
    )
  },
}
