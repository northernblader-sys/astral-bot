/**
 * loan.js — .loan : peer-to-peer solar loan contracts.
 *
 * Jasyne's request: players draw up a contract to loan solars to each other,
 * and the contract holds the borrower liable until it is paid back. This is a
 * PLAYER-to-PLAYER loan and is a different thing from the bank loan (borrow
 * from the house) that lives in lib/astralpay.js as .loanrequest / .borrow /
 * .repay. This file never touches wallet.loan (the bank debt); it moves plain
 * wallet.solars between two players and tracks the contract in db.data.loans.
 *
 * The contract lifecycle:
 *   offer   lender proposes terms. No solars move yet.
 *   accept  borrower agrees. The principal moves lender -> borrower now, and
 *           the clock starts: the borrower owes principal + interest by the due
 *           date.
 *   repay   borrower pays it down out of their own wallet, borrower -> lender.
 *   collect once the loan is overdue the lender can seize whatever the borrower
 *           currently holds, up to what is still owed. This is the liability:
 *           the debt follows the borrower and can be collected again and again
 *           until it is cleared, so a borrower cannot walk away from it.
 *
 * Money moves are two separate top-level updatePlayer calls (debit one side,
 * then credit the other), never nested, for the exact deadlock reason spelled
 * out in plugins/transfer.js. The loan record on db.data.loans is mutated
 * INSIDE one of those mutators (the db.data.empires idiom in plugins/empire.js)
 * so the contract and the solar move are persisted by the same write.
 *
 * Player-facing copy keeps the no-dash rule: commas, colons, periods only.
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer, playerExists } from '../lib/player-repo.js'
import { genRef } from '../lib/astralpay.js'
import {
  MIN_LEVEL,
  MAX_SOLARS_PER_TRANSFER,
  resolveTargetJid,
  runTransferGuards,
} from '../lib/transfer-guards.js'

// ── Contract limits (balance). ──────────────────────────────────────────────
// Principal is capped at the same ceiling as a normal transfer so a loan can
// never move more solars in one go than a plain .send could. Interest is flat
// (charged once at accept, never compounding) and hard-capped so a lender
// cannot write a predatory contract. A borrower can only carry a few live
// contracts at once so nobody gets buried under a spiral of debt.
const MAX_PRINCIPAL                = MAX_SOLARS_PER_TRANSFER
const DEFAULT_TERM_DAYS            = 7
const MIN_TERM_DAYS               = 1
const MAX_TERM_DAYS               = 30
const DEFAULT_INTEREST_PCT        = 10
const MAX_INTEREST_PCT            = 50
const MAX_OPEN_LOANS_PER_BORROWER = 5
const MS_PER_DAY                  = 24 * 60 * 60 * 1000

const num = (n) => Math.floor(Number(n) || 0).toLocaleString()
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

function ensureLoans(db) {
  if (!db.data.loans || typeof db.data.loans !== 'object') db.data.loans = {}
  return db.data.loans
}

function nameOf(db, jid) {
  return getPlayer(db, jid)?.name ?? 'that player'
}

function newLoanId(db) {
  const loans = ensureLoans(db)
  let id
  do { id = `L${genRef()}` } while (loans[id])
  return id
}

const isOpen = (l) => l.status === 'pending' || l.status === 'active'
const isOverdue = (l) => l.status === 'active' && Date.now() >= (l.dueAt ?? Infinity)

function dueLine(l) {
  if (!l.dueAt) return ''
  const days = Math.ceil((l.dueAt - Date.now()) / MS_PER_DAY)
  const when = new Date(l.dueAt).toLocaleDateString()
  if (isOverdue(l)) return `⏰ *OVERDUE* (was due ${when})`
  return `📅 Due ${when} _(${days} day${days === 1 ? '' : 's'} left)_`
}

function contractLine(db, l, viewerJid) {
  const asLender = l.lender === viewerJid
  const other = asLender ? l.borrower : l.lender
  const role = asLender ? `to ${nameOf(db, other)}` : `from ${nameOf(db, other)}`
  const owed = l.status === 'active' ? `  ·  owed ☀️ ${num(l.outstanding)}` : ''
  const tag =
    l.status === 'pending'  ? (asLender ? '🕓 awaiting reply' : '🕓 needs your answer')
    : l.status === 'active' ? (isOverdue(l) ? '⏰ overdue' : '✅ active')
    : l.status === 'repaid' ? '✔️ repaid'
    : `✖️ ${l.status}`
  return `*#${l.id}*  ${role}  ·  ☀️ ${num(l.principal)} @ ${l.interestPct}%${owed}\n   ${tag}`
}

// ── .loan offer <target> <amount> [days] [interest%] ────────────────────────
async function loanOffer(ctx, targetRaw, amountRaw, daysRaw, interestRaw) {
  const p = config.prefix
  const borrowerJid = resolveTargetJid(ctx, targetRaw)
  const amount = Math.floor(Number(amountRaw))

  if (!Number.isFinite(amount) || amount <= 0) {
    return ctx.reply(
      `❓ Usage: *${p}loan offer <@player> <amount> [days] [interest%]*\n` +
      `_Example: ${p}loan offer @friend 500 7 10_  (lend 500, due in 7 days, 10% interest)`,
    )
  }
  if (amount > MAX_PRINCIPAL) {
    return ctx.reply(`❌ The most you can lend in one contract is ☀️ *${num(MAX_PRINCIPAL)}*.`)
  }
  const days = clamp(parseInt(daysRaw, 10) || DEFAULT_TERM_DAYS, MIN_TERM_DAYS, MAX_TERM_DAYS)
  const interestPct = clamp(
    interestRaw != null && interestRaw !== '' ? Math.floor(Number(interestRaw)) : DEFAULT_INTEREST_PCT,
    0, MAX_INTEREST_PCT,
  )

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, async lender => {
    const guard = await runTransferGuards(ctx, lender, borrowerJid)
    if (guard) { outcome = { ok: false }; return lender }

    const bal = lender.wallet?.solars ?? 0
    if (bal < amount) {
      await ctx.reply(`❌ You only have ☀️ *${num(bal)}*, you can't offer to lend *${num(amount)}*.`)
      outcome = { ok: false }; return lender
    }
    if ((getPlayer(ctx.db, borrowerJid)?.level ?? 1) < MIN_LEVEL) {
      await ctx.reply(`❌ ${nameOf(ctx.db, borrowerJid)} must be *Level ${MIN_LEVEL}+* to take a loan.`)
      outcome = { ok: false }; return lender
    }

    const loans = ensureLoans(ctx.db)
    const open = Object.values(loans).filter(l => l.borrower === borrowerJid && isOpen(l))
    if (open.length >= MAX_OPEN_LOANS_PER_BORROWER) {
      await ctx.reply(`❌ ${nameOf(ctx.db, borrowerJid)} already has *${MAX_OPEN_LOANS_PER_BORROWER}* open loans and cannot take another right now.`)
      outcome = { ok: false }; return lender
    }
    const dupe = Object.values(loans).find(l => l.lender === ctx.from && l.borrower === borrowerJid && l.status === 'pending')
    if (dupe) {
      await ctx.reply(`❌ You already have a pending offer *#${dupe.id}* out to them. Cancel it first with *${p}loan cancel ${dupe.id}*.`)
      outcome = { ok: false }; return lender
    }

    const id = newLoanId(ctx.db)
    const repayAmount = amount + Math.floor(amount * interestPct / 100)
    loans[id] = {
      id, lender: ctx.from, borrower: borrowerJid,
      principal: amount, interestPct, repayAmount, outstanding: repayAmount,
      status: 'pending', termDays: days,
      createdAt: Date.now(), acceptedAt: null, dueAt: null,
    }
    outcome = { ok: true, id, repayAmount }
    return lender
  })

  if (!outcome?.ok) return
  const repayAmount = outcome.repayAmount
  return ctx.reply(
    `📜 *LOAN OFFER DRAWN UP*  ·  *#${outcome.id}*\n\n` +
    `To: *${nameOf(ctx.db, borrowerJid)}*\n` +
    `Principal: ☀️ *${num(amount)}*\n` +
    `Interest: *${interestPct}%*  ·  Repay total: ☀️ *${num(repayAmount)}*\n` +
    `Term: *${days} day${days === 1 ? '' : 's'}* from acceptance.\n\n` +
    `_Nothing has moved yet._ They accept with *${p}loan accept ${outcome.id}*, or turn it down with *${p}loan decline ${outcome.id}*.\n` +
    `You can pull it back any time before then with *${p}loan cancel ${outcome.id}*.`,
  )
}

// ── .loan accept <id> ────────────────────────────────────────────────────────
async function loanAccept(ctx, id) {
  const p = config.prefix
  const loans = ensureLoans(ctx.db)
  const loan = loans[id]
  if (!loan) return ctx.reply(`❌ No loan *#${id}* found.`)
  if (loan.borrower !== ctx.from) return ctx.reply(`❌ Offer *#${id}* isn't addressed to you.`)
  if (loan.status !== 'pending') return ctx.reply(`❌ Offer *#${id}* is *${loan.status}*, it can't be accepted.`)

  // Phase 1: debit the lender and activate the contract, atomically. Re-checked
  // inside the lock because the lender may have spent the solars, or cancelled,
  // since the offer was written.
  let phase1 = null
  await updatePlayer(ctx.db, loan.lender, async lender => {
    const cur = ensureLoans(ctx.db)[id]
    if (!cur || cur.status !== 'pending') { phase1 = { reason: 'gone' }; return lender }
    const bal = lender.wallet?.solars ?? 0
    if (bal < cur.principal) { phase1 = { reason: 'lenderbroke' }; return lender }

    if (!lender.wallet) lender.wallet = {}
    lender.wallet.solars = bal - cur.principal
    lender.lastTransferAt = Date.now()

    cur.status = 'active'
    cur.acceptedAt = Date.now()
    cur.dueAt = Date.now() + cur.termDays * MS_PER_DAY
    cur.outstanding = cur.repayAmount
    phase1 = { ok: true }
    return lender
  })

  if (!phase1?.ok) {
    if (phase1?.reason === 'lenderbroke') {
      return ctx.reply(`❌ ${nameOf(ctx.db, loan.lender)} no longer has the ☀️ to fund this. The offer stays pending.`)
    }
    return ctx.reply(`❌ Offer *#${id}* is no longer available.`)
  }

  // Phase 2: credit the borrower (that is you).
  await updatePlayer(ctx.db, ctx.from, async borrower => {
    if (!borrower.wallet) borrower.wallet = {}
    borrower.wallet.solars = (borrower.wallet.solars ?? 0) + loan.principal
    return borrower
  })

  const l = ensureLoans(ctx.db)[id]
  return ctx.reply(
    `🤝 *LOAN #${id} IS LIVE.*\n\n` +
    `You received ☀️ *${num(l.principal)}* from *${nameOf(ctx.db, l.lender)}*.\n` +
    `You owe back ☀️ *${num(l.outstanding)}* _(with ${l.interestPct}% interest)_.\n` +
    `${dueLine(l)}\n\n` +
    `Pay it down any time with *${p}loan repay ${id} <amount|all>*.\n` +
    `_If it goes overdue, the lender can collect straight from your wallet._`,
  )
}

// ── .loan repay <id> <amount|all> ────────────────────────────────────────────
async function loanRepay(ctx, id, amountRaw) {
  const p = config.prefix
  const loans = ensureLoans(ctx.db)
  const loan = loans[id]
  if (!loan) return ctx.reply(`❌ No loan *#${id}* found.`)
  if (loan.borrower !== ctx.from) return ctx.reply(`❌ Loan *#${id}* isn't yours to repay.`)
  if (loan.status !== 'active') return ctx.reply(`❌ Loan *#${id}* is *${loan.status}*, there is nothing to repay.`)
  if (amountRaw == null || amountRaw === '') {
    return ctx.reply(`❓ Usage: *${p}loan repay ${id} <amount|all>*  ·  you owe ☀️ *${num(loan.outstanding)}*.`)
  }

  // Phase 1: debit the borrower (you) and write the paydown down.
  let phase1 = null
  await updatePlayer(ctx.db, ctx.from, async borrower => {
    const cur = ensureLoans(ctx.db)[id]
    if (!cur || cur.status !== 'active') { phase1 = { reason: 'gone' }; return borrower }
    const bal = borrower.wallet?.solars ?? 0
    const want = String(amountRaw).toLowerCase() === 'all'
      ? Math.min(cur.outstanding, bal)
      : Math.floor(Number(amountRaw))
    if (!Number.isFinite(want) || want <= 0) { phase1 = { reason: 'amt' }; return borrower }
    const pay = Math.min(want, cur.outstanding, bal)
    if (pay <= 0) { phase1 = { reason: 'broke', bal }; return borrower }

    if (!borrower.wallet) borrower.wallet = {}
    borrower.wallet.solars = bal - pay
    cur.outstanding -= pay
    if (cur.outstanding <= 0) { cur.outstanding = 0; cur.status = 'repaid'; cur.repaidAt = Date.now() }
    phase1 = { ok: true, pay, remaining: cur.outstanding, cleared: cur.status === 'repaid' }
    return borrower
  })

  if (!phase1?.ok) {
    if (phase1?.reason === 'amt') return ctx.reply(`❌ Enter a valid amount, or *all*.`)
    if (phase1?.reason === 'broke') return ctx.reply(`❌ You have ☀️ *${num(phase1.bal)}* in your wallet, nothing to pay with.`)
    return ctx.reply(`❌ Loan *#${id}* is no longer active.`)
  }

  // Phase 2: credit the lender.
  await updatePlayer(ctx.db, loan.lender, async lender => {
    if (!lender.wallet) lender.wallet = {}
    lender.wallet.solars = (lender.wallet.solars ?? 0) + phase1.pay
    return lender
  })

  return ctx.reply(
    phase1.cleared
      ? `✅ *LOAN #${id} CLEARED.*\nYou paid the last ☀️ *${num(phase1.pay)}* to *${nameOf(ctx.db, loan.lender)}*. You owe them nothing more.`
      : `💸 Paid ☀️ *${num(phase1.pay)}* to *${nameOf(ctx.db, loan.lender)}* on loan *#${id}*.\nStill owed: ☀️ *${num(phase1.remaining)}*.`,
  )
}

// ── .loan collect <id> ───────────────────────────────────────────────────────
async function loanCollect(ctx, id) {
  const loans = ensureLoans(ctx.db)
  const loan = loans[id]
  if (!loan) return ctx.reply(`❌ No loan *#${id}* found.`)
  if (loan.lender !== ctx.from) return ctx.reply(`❌ You are not the lender on loan *#${id}*.`)
  if (loan.status !== 'active') return ctx.reply(`❌ Loan *#${id}* is *${loan.status}*, there is nothing to collect.`)
  if (Date.now() < (loan.dueAt ?? Infinity)) {
    return ctx.reply(`❌ Loan *#${id}* is not overdue yet. ${dueLine(loan)}\nYou can only collect once it is past due.`)
  }

  // Phase 1: seize from the borrower, up to what they hold and what is owed.
  let phase1 = null
  await updatePlayer(ctx.db, loan.borrower, async borrower => {
    const cur = ensureLoans(ctx.db)[id]
    if (!cur || cur.status !== 'active') { phase1 = { reason: 'gone' }; return borrower }
    const bal = borrower.wallet?.solars ?? 0
    const seize = Math.min(cur.outstanding, bal)
    if (seize <= 0) { phase1 = { ok: true, seize: 0, remaining: cur.outstanding }; return borrower }

    if (!borrower.wallet) borrower.wallet = {}
    borrower.wallet.solars = bal - seize
    cur.outstanding -= seize
    // The contract stays active while anything is still owed, so an empty
    // borrower does not clear the debt, the lender can come back and collect
    // again once they have solars. Only a full paydown closes it.
    if (cur.outstanding <= 0) { cur.outstanding = 0; cur.status = 'repaid'; cur.repaidAt = Date.now() }
    phase1 = { ok: true, seize, remaining: cur.outstanding, cleared: cur.status === 'repaid' }
    return borrower
  })

  if (!phase1?.ok) return ctx.reply(`❌ Loan *#${id}* is no longer collectable.`)

  if (phase1.seize > 0) {
    await updatePlayer(ctx.db, ctx.from, async lender => {
      if (!lender.wallet) lender.wallet = {}
      lender.wallet.solars = (lender.wallet.solars ?? 0) + phase1.seize
      return lender
    })
  }

  if (phase1.seize <= 0) {
    return ctx.reply(`🧾 *${nameOf(ctx.db, loan.borrower)}* has no solars to collect right now. Loan *#${id}* still owes you ☀️ *${num(phase1.remaining)}*. Try again once they earn some.`)
  }
  return ctx.reply(
    phase1.cleared
      ? `⚖️ *COLLECTED IN FULL.*\nSeized the last ☀️ *${num(phase1.seize)}* from *${nameOf(ctx.db, loan.borrower)}*. Loan *#${id}* is settled.`
      : `⚖️ *COLLECTED.*\nSeized ☀️ *${num(phase1.seize)}* from *${nameOf(ctx.db, loan.borrower)}* on loan *#${id}*.\nStill owed: ☀️ *${num(phase1.remaining)}*. You can collect again once they hold more.`,
  )
}

// ── .loan decline <id> / .loan cancel <id> ───────────────────────────────────
async function loanClose(ctx, id, mode) {
  const loans = ensureLoans(ctx.db)
  const loan = loans[id]
  if (!loan) return ctx.reply(`❌ No loan *#${id}* found.`)
  if (loan.status !== 'pending') return ctx.reply(`❌ Loan *#${id}* is *${loan.status}*, there is no pending offer to ${mode === 'decline' ? 'decline' : 'cancel'}.`)
  const who = mode === 'decline' ? loan.borrower : loan.lender
  if (who !== ctx.from) {
    return ctx.reply(mode === 'decline'
      ? `❌ Offer *#${id}* isn't addressed to you.`
      : `❌ You didn't make offer *#${id}*.`)
  }

  await updatePlayer(ctx.db, ctx.from, async me => {
    const cur = ensureLoans(ctx.db)[id]
    if (cur && cur.status === 'pending') cur.status = mode === 'decline' ? 'declined' : 'cancelled'
    return me
  })
  return ctx.reply(mode === 'decline'
    ? `🚫 You declined offer *#${id}* from *${nameOf(ctx.db, loan.lender)}*.`
    : `🗑️ You pulled back offer *#${id}* to *${nameOf(ctx.db, loan.borrower)}*.`)
}

// ── .loan / .loan list ───────────────────────────────────────────────────────
function loanList(ctx) {
  const p = config.prefix
  const loans = ensureLoans(ctx.db)
  const mine = Object.values(loans)
    .filter(l => (l.lender === ctx.from || l.borrower === ctx.from) && isOpen(l))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))

  if (!mine.length) {
    return ctx.reply(
      `📜 *LOAN CONTRACTS*\n\n_You have no open loans._\n\n` +
      `Lend to someone: *${p}loan offer <@player> <amount> [days] [interest%]*\n` +
      `_Example: ${p}loan offer @friend 500 7 10_`,
    )
  }

  const asLender = mine.filter(l => l.lender === ctx.from)
  const asBorrower = mine.filter(l => l.borrower === ctx.from)
  const owedToMe = asLender.filter(l => l.status === 'active').reduce((s, l) => s + l.outstanding, 0)
  const iOwe = asBorrower.filter(l => l.status === 'active').reduce((s, l) => s + l.outstanding, 0)

  const lines = ['📜 *YOUR LOAN CONTRACTS*', '']
  if (asBorrower.length) {
    lines.push(`*You borrowed* _(you owe ☀️ ${num(iOwe)})_`)
    for (const l of asBorrower) lines.push(contractLine(ctx.db, l, ctx.from))
    lines.push('')
  }
  if (asLender.length) {
    lines.push(`*You lent out* _(owed to you ☀️ ${num(owedToMe)})_`)
    for (const l of asLender) lines.push(contractLine(ctx.db, l, ctx.from))
    lines.push('')
  }
  lines.push(`_Manage one with_ *${p}loan view <id>*, *${p}loan repay <id> <amt>*, *${p}loan collect <id>*.`)
  return ctx.reply(lines.join('\n'))
}

// ── .loan view <id> ──────────────────────────────────────────────────────────
function loanView(ctx, id) {
  const p = config.prefix
  const loan = ensureLoans(ctx.db)[id]
  if (!loan) return ctx.reply(`❌ No loan *#${id}* found.`)
  if (loan.lender !== ctx.from && loan.borrower !== ctx.from) {
    return ctx.reply(`❌ Loan *#${id}* isn't yours.`)
  }
  const you = loan.lender === ctx.from ? 'lender' : 'borrower'
  const out = [
    `📜 *LOAN #${loan.id}*`,
    ``,
    `Lender: *${nameOf(ctx.db, loan.lender)}*${you === 'lender' ? ' _(you)_' : ''}`,
    `Borrower: *${nameOf(ctx.db, loan.borrower)}*${you === 'borrower' ? ' _(you)_' : ''}`,
    `Principal: ☀️ *${num(loan.principal)}*  ·  Interest: *${loan.interestPct}%*`,
    `Repay total: ☀️ *${num(loan.repayAmount)}*`,
    `Status: *${loan.status}*`,
  ]
  if (loan.status === 'active') {
    out.push(`Still owed: ☀️ *${num(loan.outstanding)}*`)
    out.push(dueLine(loan))
    if (you === 'borrower') out.push(`\n_Pay it down:_ *${p}loan repay ${loan.id} <amount|all>*`)
    else if (isOverdue(loan)) out.push(`\n_Overdue: collect it_ *${p}loan collect ${loan.id}*`)
  } else if (loan.status === 'pending') {
    out.push(`\n_Waiting on ${nameOf(ctx.db, loan.borrower)} to accept._`)
  }
  return ctx.reply(out.join('\n'))
}

export default {
  name: 'loan',
  aliases: ['loans'],
  category: 'economy',
  requiresPlayer: true,
  description: 'Draw up, accept, repay and collect peer-to-peer solar loans',

  async run(ctx) {
    const p = config.prefix
    const [sub, ...rest] = ctx.args
    const s = (sub ?? '').toLowerCase()

    if (!s || s === 'list') return loanList(ctx)
    if (s === 'offer' || s === 'lend' || s === 'new') {
      return loanOffer(ctx, rest[0], rest[1], rest[2], rest[3])
    }
    if (s === 'accept' || s === 'take') return loanAccept(ctx, rest[0])
    if (s === 'repay' || s === 'pay') return loanRepay(ctx, rest[0], rest[1])
    if (s === 'collect' || s === 'claim') return loanCollect(ctx, rest[0])
    if (s === 'decline' || s === 'reject') return loanClose(ctx, rest[0], 'decline')
    if (s === 'cancel' || s === 'withdraw') return loanClose(ctx, rest[0], 'cancel')
    if (s === 'view' || s === 'show' || s === 'info') return loanView(ctx, rest[0])

    return ctx.reply(
      `📜 *LOANS*  _(player to player)_\n\n` +
      `*${p}loan offer <@player> <amount> [days] [interest%]*\n_draw up a contract_\n\n` +
      `*${p}loan accept <id>*  ·  *${p}loan decline <id>*\n_borrower answers an offer_\n\n` +
      `*${p}loan repay <id> <amount|all>*\n_borrower pays it back_\n\n` +
      `*${p}loan collect <id>*\n_lender seizes an overdue debt_\n\n` +
      `*${p}loan list*  ·  *${p}loan view <id>*  ·  *${p}loan cancel <id>*\n\n` +
      `_Max ☀️${num(MAX_PRINCIPAL)} per loan, up to ${MAX_INTEREST_PCT}% interest, ${MAX_TERM_DAYS} day term. Level ${MIN_LEVEL}+._`,
    )
  },
}
