/**
 * loanrequest.js — top-level alias for .apay loan request <amount>.
 *
 * Delegates entirely to requestLoan() in lib/astralpay.js — zero loan logic
 * lives here. Exists purely so players can type .loanrequest 500 instead of
 * the longer .apay loan request 500. Repaying still uses .apay loan repay.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
  requestLoan,
  loanMaxFor,
  genRef,
  pushTxLog,
  LOAN_DAILY_RATE,
} from '../lib/astralpay.js'

export default {
  name:           'loanrequest',
  aliases:        ['borrow'],
  category:       'economy',
  requiresPlayer: true,
  description:    'Quick loan shortcut — same as .apay loan request <amount>',

  async run(ctx) {
    const { args, db, player } = ctx
    const p = config.prefix

    const amount = parseInt(args[0], 10)
    if (!args[0] || !Number.isFinite(amount) || amount <= 0) {
      const cap = loanMaxFor(player)
      return ctx.reply(
        `💳 *Quick Loan*\n\n` +
        `Usage: *${p}loanrequest <amount>*\n` +
        `Your borrowing limit: ☀️ *${cap.toLocaleString()}* _(Level ${player.level} × 50)_\n` +
        `Interest: *${(LOAN_DAILY_RATE * 100).toFixed(0)}%/day*\n\n` +
        `_To repay: *${p}apay loan repay <amount|all>*_`,
      )
    }

    await updatePlayer(db, ctx.from, (pl) => {
      const result = requestLoan(pl, amount)
      if (!result.ok) {
        ctx.reply(`❌ ${result.error}`).catch(() => {})
        return pl
      }
      const ref = genRef()
      pushTxLog(pl, { ref, type: 'loan_taken', amount: result.amount })
      ctx.reply(
        `📤 *Loan granted: ☀️ ${result.amount.toLocaleString()} solars!*\n` +
        `📊 Total owed: *${pl.wallet.loan.toLocaleString()} solars* at *${(LOAN_DAILY_RATE * 100).toFixed(0)}%/day*\n` +
        `💰 Wallet: *${pl.wallet.solars.toLocaleString()} solars*\n\n` +
        `_Ref #${ref} · To repay: *${p}apay loan repay <amount|all>*_`,
      ).catch(() => {})
      return pl
    })
  },
}
