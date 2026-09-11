/**
 * lib/astralpay.js — AstralPay economy helpers.
 *
 * RECONSTRUCTED FILE — the original was lost (a copy of plugins/astralpay.js
 * had been placed at this path instead, causing a self-import crash that
 * silently killed every astralpay/balance/pay/etc. command). This version
 * was rebuilt from every call site in plugins/astralpay.js, so the exported
 * function signatures and return shapes match exactly what that plugin
 * expects. The actual balance figures (rates, caps, ref format) are
 * reasonable defaults — tune the constants below if they don't match what
 * your players are used to.
 *
 * Wallet shape expected on player.wallet:
 *   { solars, vault, bankGold, gems, loan, lastInterestAt, lastLoanInterestAt }
 */
import { runTransferGuards } from './transfer-guards.js'
import { updatePlayer } from './player-repo.js'

// ── Tunable economy constants ────────────────────────────────────────────────
export const BANK_DAILY_RATE        = 0.02   // 2%/day bank interest
export const LOAN_DAILY_RATE        = 0.05   // 5%/day loan interest
export const PAY_REQUEST_TIMEOUT_MS = 30 * 60 * 1000  // 30 min
export const LOAN_CAP_PER_LEVEL     = 50     // max loan = player.level * 50

const MS_PER_DAY = 24 * 60 * 60 * 1000

// ── Ref generator ─────────────────────────────────────────────────────────────
// Short, human-readable transaction reference, e.g. "A3F9K2".
export function genRef() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I ambiguity
  let out = ''
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

// ── Wallet normalization ──────────────────────────────────────────────────────
function ensureWallet(player) {
  if (!player.wallet) player.wallet = {}
  const w = player.wallet
  w.solars   = w.solars   ?? 0
  w.vault    = w.vault    ?? 0
  w.bankGold = w.bankGold ?? 0
  w.gems     = w.gems     ?? 0
  w.loan     = w.loan     ?? 0
  return w
}

// ── Balance summary (read-only view, includes UNAPPLIED pending interest) ────
export function getBalanceSummary(player) {
  const w = ensureWallet(player)

  const now = Date.now()
  const bankElapsedDays = w.lastInterestAt ? (now - w.lastInterestAt) / MS_PER_DAY : 0
  const pendingBankInterest = w.bankGold > 0 && bankElapsedDays > 0
    ? Math.floor(w.bankGold * BANK_DAILY_RATE * bankElapsedDays)
    : 0

  const loanElapsedDays = w.lastLoanInterestAt ? (now - w.lastLoanInterestAt) / MS_PER_DAY : 0
  const pendingLoanInterest = w.loan > 0 && loanElapsedDays > 0
    ? Math.floor(w.loan * LOAN_DAILY_RATE * loanElapsedDays)
    : 0

  return {
    solars: w.solars,
    vault: w.vault,
    bankGold: w.bankGold,
    gems: w.gems,
    loan: w.loan,
    pendingBankInterest,
    pendingLoanInterest,
  }
}

// ── Bank interest — mutates player.wallet in place, returns interest applied ─
export function applyBankInterest(player) {
  const w = ensureWallet(player)
  const now = Date.now()
  if (!w.lastInterestAt) { w.lastInterestAt = now; return 0 }
  if (w.bankGold <= 0) { w.lastInterestAt = now; return 0 }

  const elapsedDays = (now - w.lastInterestAt) / MS_PER_DAY
  if (elapsedDays <= 0) return 0

  const interest = Math.floor(w.bankGold * BANK_DAILY_RATE * elapsedDays)
  if (interest > 0) w.bankGold += interest
  w.lastInterestAt = now
  return interest
}

// ── Loan interest — mutates player.wallet in place, returns interest applied ─
export function applyLoanInterest(player) {
  const w = ensureWallet(player)
  const now = Date.now()
  if (!w.lastLoanInterestAt) { w.lastLoanInterestAt = now; return 0 }
  if (w.loan <= 0) { w.lastLoanInterestAt = now; return 0 }

  const elapsedDays = (now - w.lastLoanInterestAt) / MS_PER_DAY
  if (elapsedDays <= 0) return 0

  const interest = Math.floor(w.loan * LOAN_DAILY_RATE * elapsedDays)
  if (interest > 0) w.loan += interest
  w.lastLoanInterestAt = now
  return interest
}

// ── Loan cap ───────────────────────────────────────────────────────────────────
export function loanMaxFor(player) {
  return Math.max(0, (player.level ?? 1) * LOAN_CAP_PER_LEVEL)
}

// ── Request a loan ─────────────────────────────────────────────────────────────
// Returns { ok:true, amount } or { ok:false, error }
export function requestLoan(player, amount) {
  const w = ensureWallet(player)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Enter a valid positive amount.' }
  }
  const cap = loanMaxFor(player)
  const projected = w.loan + amount
  if (projected > cap) {
    return { ok: false, error: `That would exceed your borrowing limit of ☀️ ${cap.toLocaleString()} (you owe ☀️ ${w.loan.toLocaleString()}).` }
  }
  // A debt going from clear to positive restarts the interest clock. Without
  // this, a stale lastLoanInterestAt left behind by an earlier balance check
  // (applyLoanInterest stamps it even at zero debt) would charge a brand new
  // loan for every day since that check.
  const wasClear = (w.loan ?? 0) <= 0
  w.loan  += amount
  w.solars = (w.solars ?? 0) + amount
  if (wasClear || !w.lastLoanInterestAt) w.lastLoanInterestAt = Date.now()
  return { ok: true, amount }
}

// ── Repay a loan ────────────────────────────────────────────────────────────────
// Returns { ok:true, paid, remaining } or { ok:false, error }
export function repayLoan(player, amount) {
  const w = ensureWallet(player)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Enter a valid positive amount.' }
  }
  if (w.loan <= 0) {
    return { ok: false, error: 'You have no outstanding loan.' }
  }
  if ((w.solars ?? 0) < amount) {
    return { ok: false, error: `You only have ☀️ ${(w.solars ?? 0).toLocaleString()} in your wallet.` }
  }
  const paid = Math.min(amount, w.loan)
  w.solars -= paid
  w.loan   -= paid
  if (w.loan <= 0) { w.loan = 0; w.lastLoanInterestAt = null }
  return { ok: true, paid, remaining: w.loan }
}

// ── Transaction log ────────────────────────────────────────────────────────────
// Prepends to player.txLog (most-recent-first), capped at 200 entries.
export function pushTxLog(player, entry) {
  if (!player.txLog) player.txLog = []
  player.txLog.unshift({ at: Date.now(), ...entry })
  if (player.txLog.length > 200) player.txLog.length = 200
  return player.txLog
}

// ── Vault deposit/withdraw ──────────────────────────────────────────────────────
// Vault is a simple separate stash (no interest), distinct from the bank.
// action: 'deposit' | 'withdraw'. amountRaw: string ('all' or a number).
// Mutates player.wallet in place. Returns:
//   { error: string }  — on failure (nothing mutated)
//   { amount, solars, vault, ref }  — on success
export function mutateVault(player, action, amountRaw, prefix) {
  const w = ensureWallet(player)

  if (action === 'deposit') {
    const available = w.solars
    const amount = (String(amountRaw ?? '').toLowerCase() === 'all')
      ? available
      : Math.floor(Number(amountRaw))
    if (!Number.isFinite(amount) || amount <= 0) {
      return { error: `❓ Usage: *${prefix}deposit <amount|all>*` }
    }
    if (amount > available) {
      return { error: `❌ You only have ☀️ *${available.toLocaleString()}* in your wallet.` }
    }
    w.solars -= amount
    w.vault  += amount
    const ref = genRef()
    pushTxLog(player, { ref, type: 'deposit', amount })
    return { amount, solars: w.solars, vault: w.vault, ref }
  }

  if (action === 'withdraw') {
    const available = w.vault
    const amount = (String(amountRaw ?? '').toLowerCase() === 'all')
      ? available
      : Math.floor(Number(amountRaw))
    if (!Number.isFinite(amount) || amount <= 0) {
      return { error: `❓ Usage: *${prefix}withdraw <amount|all>*` }
    }
    if (amount > available) {
      return { error: `❌ You only have 🔒 *${available.toLocaleString()}* in your vault.` }
    }
    w.vault  -= amount
    w.solars += amount
    const ref = genRef()
    pushTxLog(player, { ref, type: 'withdraw', amount })
    return { amount, solars: w.solars, vault: w.vault, ref }
  }

  return { error: '❌ Unknown vault action.' }
}

// ── Direct pay/tip (the `.pay` / `.tip` commands) ───────────────────────────────
// Runs the shared transfer guards, then moves solars atomically per-side via
// updatePlayer. flavor: 'paid' | 'tipped' — only affects wording/tx type.
export async function sendSolars(ctx, targetJid, amountRaw, note, flavor = 'paid') {
  const { db, player, reply } = ctx
  const prefix = flavor === 'tipped' ? 'tip' : 'pay'

  if (await runTransferGuards(ctx, player, targetJid)) return

  const amount = Math.floor(Number(amountRaw))
  if (!Number.isFinite(amount) || amount <= 0) {
    return reply(`❓ Usage: *${ctx.prefix ?? '.'}${prefix} @player <amount> [note]*`)
  }

  const ref = genRef()
  let sent = false

  await updatePlayer(db, ctx.from, sender => {
    const w = ensureWallet(sender)
    if (w.solars < amount) {
      reply(`❌ You only have ☀️ *${w.solars.toLocaleString()}* — can't send *${amount.toLocaleString()}*.`).catch(() => {})
      return sender
    }
    w.solars -= amount
    sender.lastTransferAt = Date.now()
    pushTxLog(sender, {
      ref, type: flavor === 'tipped' ? 'tip_sent' : 'pay_sent',
      amount, counterparty: targetJid, note,
    })
    sent = true
    return sender
  })

  if (!sent) return

  await updatePlayer(db, targetJid, recipient => {
    const w = ensureWallet(recipient)
    w.solars += amount
    pushTxLog(recipient, {
      ref, type: flavor === 'tipped' ? 'tip_received' : 'pay_received',
      amount, counterparty: ctx.from, note,
    })
    return recipient
  })

  // No DM to the recipient, on request. The transfer above still lands in
  // their wallet and is written to their txLog, they just aren't pinged about
  // it: they see it next time they run .balance or .tx. (This is the change
  // that was meant to happen here and was accidentally applied to
  // plugins/astralpay.js instead, which destroyed that plugin.)

  return reply(
    `✅ *${flavor === 'tipped' ? 'Tipped' : 'Sent'} ${amount.toLocaleString()} solars!*` +
    (note ? `\n📝 _${note}_` : '') +
    `\n\n_Ref #${ref} · ${ctx.prefix ?? '.'}tx for more_`
  )
}
