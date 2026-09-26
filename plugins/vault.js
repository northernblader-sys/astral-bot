/**
 * vault.js — thin delegate to lib/astralpay.js.
 * Core deposit/withdraw logic now lives in mutateVault() in lib/astralpay.js
 * so plugins/astralpay.js's .deposit / .withdraw commands share the same
 * code path. This file stays registered so .vault / .vault deposit / .vault
 * withdraw keep working for existing players.
 *
 * NOTE: 'bank' alias REMOVED — .bank now routes to bankGold via
 * plugins/astralpay.js. If you need the vault, use .vault.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { mutateVault, getBalanceSummary } from '../lib/astralpay.js'
import { sendButtons } from '../lib/interactive-buttons.js'

export default {
  name: 'vault',
  aliases: [],   // 'bank' intentionally removed — see astralpay.js
  category: 'economy',
  requiresPlayer: true,
  description: `${config.prefix}vault deposit|withdraw <amount> — safe-storage for Solars, immune to robbery/PvP`,

  async run(ctx) {
    const { args, db } = ctx
    const pr  = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    if (sub !== 'deposit' && sub !== 'withdraw') {
      const bal = getBalanceSummary(ctx.player)
      const text =
        `🏦 *Your Vault*\n\n` +
        `☀️ Wallet: *${bal.solars.toLocaleString()} solars*\n` +
        `🔒 Vaulted: *${bal.vault.toLocaleString()} solars*\n\n` +
        `_Vaulted solars can't be stolen by *${pr}rob* or lost in *${pr}pvp*._`
      // Button ids get folded straight into the next inbound `body` as if
      // typed (see handler.js's extractButtonReplyId wiring) — so each id
      // is the full prefixed command, not a bare "1"/"2". Routed to the
      // standalone .deposit/.withdraw commands (plugins/astralpay.js) —
      // same mutateVault() core as .vault deposit/withdraw, and matches
      // the "Usage: .deposit <amount|all>" hint mutateVault() already
      // sends back when no amount follows, so tapping just nudges the
      // player toward typing the amount next.
      try {
        return await sendButtons({ ...ctx, jid: ctx.sender }, {
          body: text,
          footer: 'Tap to continue, or type the amount directly.',
          buttons: [
            { id: `${pr}deposit`, label: '🔒 Deposit' },
            { id: `${pr}withdraw`, label: '🔓 Withdraw' },
          ],
        })
      } catch (err) {
        ctx.logger?.warn?.({ err: err.message }, 'vault.js: sendButtons failed')
        return ctx.reply(
          text + `\n\n*${pr}deposit <amount|all>*\n*${pr}withdraw <amount|all>*`
        )
      }
    }

    await updatePlayer(db, ctx.from, player => {
      const result = mutateVault(player, sub, args[1], pr)
      if (result.error) { ctx.reply(result.error); return player }
      ctx.reply(
        sub === 'deposit'
          ? `🔒 Deposited *${result.amount.toLocaleString()}* solars into your vault.\n` +
            `☀️ Wallet: *${result.solars.toLocaleString()}*  🔒 Vaulted: *${result.vault.toLocaleString()}*`
          : `🔓 Withdrew *${result.amount.toLocaleString()}* solars from your vault.\n` +
            `☀️ Wallet: *${result.solars.toLocaleString()}*  🔒 Vaulted: *${result.vault.toLocaleString()}*`
      )
      return player
    })
  },
}
