/**
 * plugins/astralpay.js — the AstralPay hub, and every standalone money command
 * that hangs off it.
 *
 *   .apay / .astralpay           the hub
 *   .balance / .bal              full statement, wallet through to debt
 *   .pay @player <n> [note]      send solars
 *   .tip @player <n> [note]      same money, tip wording
 *   .bank [deposit|withdraw]     interest bearing savings (wallet.bankGold)
 *   .deposit / .withdraw         vault moves (wallet.vault, robbery proof)
 *   .loan [request] <n>          borrow against your level
 *   .repay <n|all>               pay a loan down
 *   .tx / .txlog [n]             your ledger
 *   .giveaway <n> [minutes]      put solars up for the group
 *   .apay request|accept|decline ask someone else to pay you
 *
 * WHY EVERY ONE OF THOSE SAID "unknown command": this file had been overwritten
 * with a verbatim copy of lib/astralpay.js, the helper module. That copy has no
 * `export default`, and its `./transfer-guards.js` / `./player-repo.js` imports
 * resolved inside plugins/, where neither file exists — so the loader logged
 * "Plugin failed to import" once at boot and none of these names were ever
 * registered. All economy LOGIC still lives in lib/astralpay.js; this file is
 * routing and presentation only.
 *
 * WRITE SAFETY (same rules as plugins/lottery.js):
 *   - Every wallet change goes through updatePlayer(). The shared giveaway
 *     record on db.data.giveaways is mutated INSIDE a mutator, so pot and
 *     wallet move in one serialized write.
 *   - updatePlayer is NEVER nested inside another updatePlayer: they share one
 *     write queue and nesting deadlocks it. Paying someone who is not the
 *     caller is always a separate top level call.
 *   - There is no scheduler anywhere in this bot, so a giveaway resolves
 *     LAZILY: the next AstralPay command in that same chat closes it. Nothing
 *     is ever announced into a chat other than the one it happened in.
 */
import { config } from '../config.js'
import { getPlayer, playerExists, updatePlayer } from '../lib/player-repo.js'
import { pushNotification } from '../lib/notification-repo.js'
import { resolveTargetJid } from '../lib/transfer-guards.js'
import { trySendButtons } from '../lib/interactive-buttons.js'
import {
  BANK_DAILY_RATE,
  LOAN_DAILY_RATE,
  PAY_REQUEST_TIMEOUT_MS,
  applyBankInterest,
  applyLoanInterest,
  genRef,
  getBalanceSummary,
  loanMaxFor,
  mutateVault,
  pushTxLog,
  repayLoan,
  requestLoan,
  sendSolars,
} from '../lib/astralpay.js'

const RULE = '━━━━━━━━━━━━━━━━━━━━'

// Ledger page size. 200 entries are kept per player (pushTxLog), but a wall of
// them is unreadable on a phone.
const TX_PAGE = 8
const TX_MAX = 25

// Giveaways: a floor so the command isn't used to spam a group with 1 solar,
// and a ceiling on the window so a forgotten giveaway can't sit open for a day.
const GIVEAWAY_MIN_AMOUNT = 100
const GIVEAWAY_DEFAULT_MINUTES = 5
const GIVEAWAY_MIN_MINUTES = 1
const GIVEAWAY_MAX_MINUTES = 60

// ── Small formatting helpers ─────────────────────────────────────────────────

const num = (v) => Math.max(0, Math.floor(Number(v) || 0)).toLocaleString()

/** 'all'/'max' or a positive integer, commas tolerated. null when it's neither. */
function parseAmount(raw, available = 0) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/,/g, '')
  if (!s) return null
  if (s === 'all' || s === 'max') {
    const v = Math.floor(Number(available) || 0)
    return v > 0 ? v : null
  }
  const v = Math.floor(Number(s))
  return Number.isFinite(v) && v > 0 ? v : null
}

/**
 * Index of the token holding the amount in `<target> <amount> [note]`.
 *
 * The target can be typed as a raw phone number, which is also all digits, so
 * the token that produced the target is skipped. Without that, a literal
 * `.pay 2348022222222 300` read the phone number as the amount.
 */
function amountIndex(rest, targetJid) {
  const targetDigits = String(targetJid ?? '').split('@')[0].replace(/\D+/g, '')
  return rest.findIndex(tok => {
    const s = String(tok ?? '')
    if (!/^\d[\d,]*$/.test(s)) return false
    return !(targetDigits && s.replace(/\D+/g, '') === targetDigits)
  })
}

function ago(at) {
  const ms = Date.now() - (Number(at) || 0)
  if (ms < 60_000) return 'just now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function minutesLeft(untilMs) {
  const ms = Math.max(0, (Number(untilMs) || 0) - Date.now())
  if (ms < 60_000) return `${Math.max(1, Math.ceil(ms / 1000))}s`
  return `${Math.ceil(ms / 60_000)}m`
}

/** A readable label for a counterparty jid, without leaking the full number. */
function shortName(db, jid) {
  if (!jid) return 'someone'
  const known = getPlayer(db, jid)?.name
  if (known) return known
  const digits = String(jid).split('@')[0].replace(/\D+/g, '')
  return digits ? `…${digits.slice(-4)}` : 'someone'
}

// ── The ledger ───────────────────────────────────────────────────────────────

/**
 * Display metadata per txLog type. `sign` is from the holder's point of view,
 * so the same transfer reads '-' in the sender's log and '+' in the
 * recipient's. Every type actually present in the live database is listed here
 * (bank_deposit, bank_withdraw, deposit, withdraw, pay_sent, pay_received,
 * tip_sent, tip_received, giveaway_won, loan_taken, loan_repaid); anything an
 * older or newer writer invents falls through to the generic renderer below,
 * so an unknown type is never dropped from the ledger.
 */
const TX_META = {
  bank_deposit:    { icon: '🏦', label: 'Into the bank',   sign: '-' },
  bank_withdraw:   { icon: '🏦', label: 'Out of the bank', sign: '+' },
  deposit:         { icon: '🔒', label: 'Into the vault',  sign: '-' },
  withdraw:        { icon: '🔓', label: 'Out of the vault', sign: '+' },
  pay_sent:        { icon: '📤', label: 'Paid',            sign: '-', to: 'to' },
  pay_received:    { icon: '📥', label: 'Received',        sign: '+', to: 'from' },
  tip_sent:        { icon: '🎁', label: 'Tipped',          sign: '-', to: 'to' },
  tip_received:    { icon: '🎉', label: 'Tipped by',       sign: '+', to: '' },
  giveaway_hosted: { icon: '🎪', label: 'Giveaway staked', sign: '-' },
  giveaway_refund: { icon: '↩️', label: 'Giveaway refund', sign: '+' },
  giveaway_won:    { icon: '🏆', label: 'Giveaway won',    sign: '+', to: 'from' },
  loan_taken:      { icon: '📝', label: 'Loan taken',      sign: '+' },
  loan_repaid:     { icon: '✅', label: 'Loan repaid',     sign: '-' },
}

function txLine(db, entry) {
  const meta = TX_META[entry?.type] ?? {
    icon: '•',
    label: String(entry?.type ?? 'entry').replace(/_/g, ' '),
    sign: '',
  }
  const who = entry?.counterparty && meta.to !== undefined
    ? ` ${meta.to} *${shortName(db, entry.counterparty)}*`.replace('  ', ' ')
    : ''
  const ref = entry?.ref ? `  ·  #${entry.ref}` : ''
  const note = entry?.note ? `\n   📝 _${String(entry.note).slice(0, 60)}_` : ''
  return `${meta.icon} ${meta.label}${who}: *${meta.sign}${num(entry?.amount)}*\n` +
    `   _${ago(entry?.at)}${ref}_${note}`
}

// ── Giveaway record ──────────────────────────────────────────────────────────

/**
 * Lazily creates and sanitizes db.data.giveaways: a map of chat jid to the ONE
 * giveaway open in that chat. Safe to call inside or outside a mutator, since it
 * only ever fills in or drops fields, so a half written record from an older
 * version repairs itself instead of throwing.
 */
function ensureGiveaways(db) {
  const d = db.data
  if (!d.giveaways || typeof d.giveaways !== 'object' || Array.isArray(d.giveaways)) d.giveaways = {}
  for (const [chat, g] of Object.entries(d.giveaways)) {
    const amount = Math.floor(Number(g?.amount))
    if (!g || typeof g !== 'object' || !g.hostJid || !Number.isFinite(amount) || amount <= 0) {
      delete d.giveaways[chat]
      continue
    }
    g.amount = amount
    g.ref = String(g.ref ?? genRef())
    g.id = String(g.id ?? g.ref)
    g.hostName = String(g.hostName ?? 'Someone')
    g.endsAt = Number.isFinite(Number(g.endsAt)) ? Number(g.endsAt) : Date.now()
    if (!g.entrants || typeof g.entrants !== 'object' || Array.isArray(g.entrants)) g.entrants = {}
  }
  return d.giveaways
}

function openGiveaway(db, chatJid) {
  return ensureGiveaways(db)[chatJid] ?? null
}

/** Pure: picks one entrant at random. Testable with no socket and no db. */
export function pickEntrant(entrants, rng = Math.random) {
  const list = Object.entries(entrants ?? {})
  if (!list.length) return null
  const [jid, name] = list[Math.min(list.length - 1, Math.floor(rng() * list.length))]
  return { jid, name: String(name ?? 'Someone') }
}

// ── Lazy giveaway resolution ─────────────────────────────────────────────────

/**
 * Closes the giveaway in `chatJid` if its window has shut, and returns a summary
 * for the caller to surface IN THAT SAME CHAT. Returns null when there is no
 * giveaway, when it is still open, or when a racing call already closed it.
 *
 * The winner is usually not the caller, so the payout is its own top level
 * updatePlayer, and it re-reads the record under the lock and compares the id
 * (compare-and-swap) so two people racing in can never pay one pot out twice.
 */
async function resolveGiveaway(ctx, chatJid) {
  const g = openGiveaway(ctx.db, chatJid)
  if (!g || Date.now() < g.endsAt) return null

  const { id, amount, hostJid, hostName } = g
  // Anyone whose record was deleted since joining can't be paid, so they are
  // dropped from the draw rather than allowed to win and throw in updatePlayer.
  const entrants = Object.fromEntries(
    Object.entries(g.entrants).filter(([jid]) => playerExists(ctx.db, jid)),
  )
  const winner = pickEntrant(entrants, Math.random)
  const count = Object.keys(entrants).length

  // Nobody eligible entered: refund the host so the stake isn't burned, and log
  // the refund so the ledger balances against the giveaway_hosted debit.
  if (!winner) {
    const payee = playerExists(ctx.db, hostJid) ? hostJid : ctx.from
    let closed = false
    await updatePlayer(ctx.db, payee, player => {
      const live = openGiveaway(ctx.db, chatJid)
      if (!live || live.id !== id) return player
      if (payee === hostJid) {
        player.wallet = player.wallet ?? {}
        player.wallet.solars = (player.wallet.solars ?? 0) + amount
        pushTxLog(player, { ref: live.ref, type: 'giveaway_refund', amount })
      }
      delete ensureGiveaways(ctx.db)[chatJid]
      closed = true
      return player
    })
    return closed ? { empty: true, amount, hostName, refunded: payee === hostJid } : null
  }

  let paid = 0
  let closed = false
  await updatePlayer(ctx.db, winner.jid, player => {
    const live = openGiveaway(ctx.db, chatJid)
    if (!live || live.id !== id) return player
    paid = live.amount
    player.wallet = player.wallet ?? {}
    player.wallet.solars = (player.wallet.solars ?? 0) + paid
    pushTxLog(player, {
      ref: live.ref, type: 'giveaway_won', amount: paid, counterparty: live.hostJid,
    })
    delete ensureGiveaways(ctx.db)[chatJid]
    closed = true
    return player
  })
  if (!closed) return null

  // The winner may never see the group message, so they get one inbox entry.
  // That is the only message sent outside this chat: no DMs, no fan-out.
  await pushNotification(ctx.db, winner.jid, {
    kind: 'reward',
    title: '🎪 You won a giveaway',
    body: `${hostName}'s giveaway drew your name. ☀️ ${paid.toLocaleString()} solars are in your wallet.`,
  }).catch(() => {})

  return { empty: false, winnerName: winner.name, amount: paid, hostName, count }
}

/** Renders a closed giveaway as a short block to prepend to any reply. */
function giveawayBanner(outcome) {
  if (!outcome) return ''
  if (outcome.empty) {
    return (
      `🎪 *${outcome.hostName}'s giveaway closed with nobody entered.*\n` +
      (outcome.refunded
        ? `The ☀️ *${num(outcome.amount)}* went back to them.\n\n`
        : `The stake could not be returned, their record is gone.\n\n`)
    )
  }
  return (
    `🎉 *GIVEAWAY DRAWN*\n` +
    `🏆 *${outcome.winnerName}* takes ☀️ *${num(outcome.amount)}* ` +
    `from ${outcome.hostName}'s giveaway, out of ${outcome.count} ` +
    `entrant${outcome.count === 1 ? '' : 's'}.\n\n`
  )
}

// ── Interest on touch ────────────────────────────────────────────────────────

/**
 * Applies pending bank and loan interest in ONE serialized write, then returns
 * the post-interest summary. Every view that shows a balance calls this: with no
 * scheduler in the bot, "on touch" is the only way interest ever accrues.
 */
async function touchAccounts(ctx) {
  let bank = 0
  let loan = 0
  let summary = null
  await updatePlayer(ctx.db, ctx.from, player => {
    bank = applyBankInterest(player)
    loan = applyLoanInterest(player)
    summary = getBalanceSummary(player)
    return player
  })
  return { summary: summary ?? getBalanceSummary(ctx.player), bank, loan }
}

function interestNotes(bank, loan) {
  const out = []
  if (bank > 0) out.push(`🏦 _+${num(bank)} bank interest credited._`)
  if (loan > 0) out.push(`📕 _+${num(loan)} interest added to your debt._`)
  return out
}

// ── Views ────────────────────────────────────────────────────────────────────

/** The full statement behind .balance / .bal. `s` is a getBalanceSummary(). */
function balanceText(ctx, s, bank, loan) {
  const p = config.prefix
  const net = s.solars + s.vault + s.bankGold - s.loan
  const lines = [
    `💳 *ASTRALPAY*  ·  _${ctx.player?.name ?? 'your account'}_`,
    RULE,
    `☀️ Wallet: *${num(s.solars)}*`,
    `🔒 Vault: *${num(s.vault)}*  _(safe from robbery)_`,
    `🏦 Bank: *${num(s.bankGold)}*  _(${Math.round(BANK_DAILY_RATE * 100)}% a day)_`,
    `💎 Gems: *${num(s.gems)}*`,
  ]
  if (s.loan > 0) {
    lines.push(`📕 Debt: *${num(s.loan)}*  _(${Math.round(LOAN_DAILY_RATE * 100)}% a day)_`)
  }
  lines.push(RULE, `📊 Net worth: *${net < 0 ? '-' : ''}${num(Math.abs(net))} solars*`)
  lines.push(...interestNotes(bank, loan))
  lines.push('', `> *${p}apay* for the hub  ·  *${p}tx* for your ledger`)
  return lines.join('\n')
}

/** The caller's inbound pay request, or null when there is none or it expired. */
function livePayRequest(player) {
  const r = player?.payRequest
  if (!r || !r.fromJid) return null
  const amount = Math.floor(Number(r.amount))
  if (!Number.isFinite(amount) || amount <= 0) return null
  if (Number(r.expiresAt) && Date.now() > Number(r.expiresAt)) return null
  return { ...r, amount }
}

/** The .apay landing card: what you hold, then every route out of here. */
function hubText(ctx, s, bank, loan) {
  const p = config.prefix
  const req = livePayRequest(ctx.player)
  const lines = [
    `🏛️ *ASTRALPAY*  ·  _the bank of the Astral Realm_`,
    RULE,
    `☀️ *${num(s.solars)}* wallet   🔒 *${num(s.vault)}* vault   🏦 *${num(s.bankGold)}* bank`,
  ]
  if (s.loan > 0) lines.push(`📕 You owe *${num(s.loan)}*`)
  if (req) lines.push(`📨 *${req.fromName ?? 'Someone'}* asked you for *${num(req.amount)}*`)
  lines.push(
    RULE,
    `*Move it*`,
    `> *${p}pay @player <n> [note]*  ·  send solars`,
    `> *${p}tip @player <n>*  ·  same money, nicer wording`,
    `> *${p}apay request @player <n>*  ·  ask to be paid`,
    '',
    `*Store it*`,
    `> *${p}deposit <n|all>*  ·  into the vault, safe from robbery`,
    `> *${p}withdraw <n|all>*  ·  back out of the vault`,
    `> *${p}bank deposit <n|all>*  ·  earns ${Math.round(BANK_DAILY_RATE * 100)}% a day`,
    `> *${p}bank withdraw <n|all>*  ·  take it back`,
    '',
    `*Borrow it*`,
    `> *${p}loan <n>*  ·  up to *${num(loanMaxFor(ctx.player ?? {}))}* at your level`,
    `> *${p}repay <n|all>*  ·  clear the debt down`,
    '',
    `*Watch it*`,
    `> *${p}balance*  ·  the full statement`,
    `> *${p}tx*  ·  your ledger`,
    `> *${p}giveaway <n> [minutes]*  ·  put solars up for the group`,
  )
  lines.push(...interestNotes(bank, loan))
  return lines.join('\n')
}

// ── Handlers: the ledger ─────────────────────────────────────────────────────

/** .tx / .txlog [n] — the caller's own ledger, newest first. */
function doTx(ctx, banner, countArg) {
  const p = config.prefix
  const log = Array.isArray(ctx.player?.txLog) ? ctx.player.txLog : []
  if (!log.length) {
    return ctx.reply(
      `${banner}📒 *Your ledger is empty.*\n` +
      `Nothing has moved through your account yet. Try *${p}deposit 100* or *${p}pay @player 50*.`,
    )
  }
  const asked = Math.floor(Number(countArg))
  const want = Number.isFinite(asked) && asked > 0 ? Math.min(asked, TX_MAX) : TX_PAGE
  const page = log.slice(0, want)
  const lines = [
    `📒 *YOUR LEDGER*  ·  ${page.length} of ${log.length}`,
    RULE,
    ...page.map(e => txLine(ctx.db, e)),
  ]
  if (log.length > page.length) {
    lines.push(RULE, `_*${p}tx ${Math.min(log.length, TX_MAX)}* to see further back._`)
  }
  return ctx.reply(banner + lines.join('\n'))
}

// ── Handlers: the bank (interest bearing, wallet.bankGold) ───────────────────

/** .bank [deposit|withdraw] <n|all> */
async function doBank(ctx, banner, action, amountRaw) {
  const p = config.prefix
  const { summary, bank, loan } = await touchAccounts(ctx)

  if (!action) {
    return ctx.reply(banner + [
      `🏦 *THE BANK*`,
      RULE,
      `🏦 Saved: *${num(summary.bankGold)}*`,
      `☀️ Wallet: *${num(summary.solars)}*`,
      `📈 Rate: *${Math.round(BANK_DAILY_RATE * 100)}% a day*, paid whenever you look.`,
      ...interestNotes(bank, loan),
      RULE,
      `> *${p}bank deposit <n|all>*`,
      `> *${p}bank withdraw <n|all>*`,
      `_The bank pays interest but can be seen. The vault (*${p}deposit*) pays nothing and hides from robbers._`,
    ].join('\n'))
  }

  const isIn = ['deposit', 'in', 'save', 'd', 'put'].includes(action)
  const isOut = ['withdraw', 'out', 'take', 'w', 'wd'].includes(action)
  if (!isIn && !isOut) {
    return ctx.reply(`${banner}❓ Usage: *${p}bank deposit <n|all>* or *${p}bank withdraw <n|all>*`)
  }

  const available = isIn ? summary.solars : summary.bankGold
  const amount = parseAmount(amountRaw, available)
  if (!amount) {
    return ctx.reply(`${banner}❓ How much? e.g. *${p}bank ${isIn ? 'deposit' : 'withdraw'} 500*, or *all*.`)
  }
  if (amount > available) {
    return ctx.reply(banner + (isIn
      ? `❌ You only have ☀️ *${num(available)}* in your wallet.`
      : `❌ You only have 🏦 *${num(available)}* in the bank.`))
  }

  const ref = genRef()
  let out = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const w = player.wallet = player.wallet ?? {}
    const have = isIn ? (w.solars ?? 0) : (w.bankGold ?? 0)
    if (have < amount) return player // raced with another command: leave it alone
    if (isIn) {
      w.solars = have - amount
      w.bankGold = (w.bankGold ?? 0) + amount
    } else {
      w.bankGold = have - amount
      w.solars = (w.solars ?? 0) + amount
    }
    pushTxLog(player, { ref, type: isIn ? 'bank_deposit' : 'bank_withdraw', amount })
    out = { solars: w.solars, bankGold: w.bankGold }
    return player
  })
  if (!out) {
    return ctx.reply(`${banner}❌ That didn't go through. Check *${p}balance* and try again.`)
  }

  return ctx.reply(banner + [
    isIn
      ? `🏦 *Deposited ☀️ ${num(amount)} into the bank.*`
      : `🏦 *Withdrew ☀️ ${num(amount)} from the bank.*`,
    RULE,
    `🏦 Bank: *${num(out.bankGold)}*`,
    `☀️ Wallet: *${num(out.solars)}*`,
    `_Ref #${ref}_`,
  ].join('\n'))
}

// ── Handlers: the vault (no interest, hidden from robbery) ───────────────────

/** .deposit / .withdraw <n|all> — wallet to wallet.vault, via mutateVault. */
async function doVault(ctx, banner, action, amountRaw) {
  const p = config.prefix
  const w = ctx.player?.wallet ?? {}
  const available = action === 'deposit' ? (w.solars ?? 0) : (w.vault ?? 0)
  const amount = parseAmount(amountRaw, available)
  if (!amount) {
    return ctx.reply(
      `${banner}❓ Usage: *${p}${action} <amount|all>*\n` +
      (action === 'deposit'
        ? `_The vault hides solars from robbery. It pays no interest, that is the bank (*${p}bank*)._`
        : `_You have 🔒 *${num(available)}* in the vault._`),
    )
  }

  let out = null
  await updatePlayer(ctx.db, ctx.from, player => {
    out = mutateVault(player, action, amount, p)
    return player
  })
  if (out?.error) return ctx.reply(banner + out.error)
  if (!out) return ctx.reply(`${banner}❌ That didn't go through. Check *${p}balance* and try again.`)

  return ctx.reply(banner + [
    action === 'deposit'
      ? `🔒 *Locked ☀️ ${num(out.amount)} in the vault.*`
      : `🔓 *Took ☀️ ${num(out.amount)} out of the vault.*`,
    RULE,
    `🔒 Vault: *${num(out.vault)}*`,
    `☀️ Wallet: *${num(out.solars)}*`,
    `_Ref #${out.ref}_`,
  ].join('\n'))
}

// ── Handlers: loans ──────────────────────────────────────────────────────────

/** .loan [request] <n> — borrow against your level. */
async function doLoan(ctx, banner, amountRaw) {
  const p = config.prefix
  const { summary, bank, loan } = await touchAccounts(ctx)
  const cap = loanMaxFor(ctx.player ?? {})
  const room = Math.max(0, cap - summary.loan)

  if (!amountRaw) {
    return ctx.reply(banner + [
      `📝 *THE LOAN DESK*`,
      RULE,
      `📕 You owe: *${num(summary.loan)}*`,
      `📏 Your limit: *${num(cap)}*  _(level ${ctx.player?.level ?? 1})_`,
      `✅ Still available: *${num(room)}*`,
      `📈 Interest: *${Math.round(LOAN_DAILY_RATE * 100)}% a day* on what you owe.`,
      ...interestNotes(bank, loan),
      RULE,
      `> *${p}loan <amount>*  ·  borrow`,
      `> *${p}repay <amount|all>*  ·  pay it back`,
      `_Interest is charged when you touch your account, so a debt left alone grows by the next time you look._`,
    ].join('\n'))
  }

  if (room <= 0) {
    return ctx.reply(
      `${banner}🚫 You are at your borrowing limit of *${num(cap)}* and owe *${num(summary.loan)}*.\n` +
      `_Pay some back with *${p}repay <amount|all>*, or level up to raise the limit._`,
    )
  }

  const amount = parseAmount(amountRaw, room)
  if (!amount) {
    return ctx.reply(`${banner}❓ How much? e.g. *${p}loan 500*, or *all* for the full *${num(room)}*.`)
  }

  const ref = genRef()
  let res = null
  let out = null
  await updatePlayer(ctx.db, ctx.from, player => {
    res = requestLoan(player, amount)
    if (res?.ok) {
      pushTxLog(player, { ref, type: 'loan_taken', amount: res.amount })
      out = { solars: player.wallet.solars, loan: player.wallet.loan }
    }
    return player
  })
  if (!res) return ctx.reply(`${banner}❌ The loan desk is closed. Try again in a moment.`)
  if (!res.ok) return ctx.reply(`${banner}❌ ${res.error}`)

  return ctx.reply(banner + [
    `📝 *Borrowed ☀️ ${num(res.amount)}.*`,
    RULE,
    `☀️ Wallet: *${num(out.solars)}*`,
    `📕 You now owe: *${num(out.loan)}*  _(of ${num(cap)})_`,
    `📈 *${Math.round(LOAN_DAILY_RATE * 100)}% a day* accrues on the balance.`,
    `_Ref #${ref}  ·  ${p}repay <amount|all>_`,
  ].join('\n'))
}

/** .repay <n|all> — pay a loan down out of the wallet. */
async function doRepay(ctx, banner, amountRaw) {
  const p = config.prefix
  const { summary, bank, loan } = await touchAccounts(ctx)

  if (summary.loan <= 0) {
    return ctx.reply(`${banner}✅ *You owe nothing.*\n_Borrow with *${p}loan <amount>* if you need to._`)
  }
  // 'all' means "clear as much as I can", so it is capped by the wallet and by
  // the debt, whichever is smaller.
  const payable = Math.min(summary.solars, summary.loan)
  const amount = parseAmount(amountRaw, payable)
  if (!amount) {
    return ctx.reply(banner + [
      `📕 *You owe ☀️ ${num(summary.loan)}.*`,
      `☀️ Wallet: *${num(summary.solars)}*`,
      ...interestNotes(bank, loan),
      `> *${p}repay <amount>*${payable > 0 ? `  or  *${p}repay all* (${num(payable)} now)` : ''}`,
    ].join('\n'))
  }

  const ref = genRef()
  let res = null
  let out = null
  await updatePlayer(ctx.db, ctx.from, player => {
    res = repayLoan(player, amount)
    if (res?.ok) {
      pushTxLog(player, { ref, type: 'loan_repaid', amount: res.paid })
      out = { solars: player.wallet.solars }
    }
    return player
  })
  if (!res) return ctx.reply(`${banner}❌ The loan desk is closed. Try again in a moment.`)
  if (!res.ok) return ctx.reply(`${banner}❌ ${res.error}`)

  return ctx.reply(banner + [
    res.remaining <= 0
      ? `✅ *Debt cleared, ☀️ ${num(res.paid)} paid.*`
      : `✅ *Paid ☀️ ${num(res.paid)} off your loan.*`,
    RULE,
    `📕 Still owing: *${num(res.remaining)}*`,
    `☀️ Wallet: *${num(out.solars)}*`,
    `_Ref #${ref}_`,
  ].join('\n'))
}

// ── Handlers: pay and tip ────────────────────────────────────────────────────

/**
 * .pay / .tip @player <n> [note]. sendSolars() runs the shared transfer guards
 * (level floor, cooldown, self and bot targets) and does the two phase transfer,
 * so all this handler owes it is a resolved target and a clean amount.
 *
 * The amount is the first token that is purely digits, which is what lets both
 * `.pay @tag 500 thanks` and a reply-quoted `.pay 500 thanks` work: in the
 * second case resolveTargetJid takes the target from the quote, and rest[0] is
 * already the amount. 'all' is deliberately NOT accepted here, since a fumbled
 * `.pay all` would empty a wallet into someone else's.
 */
async function doPay(ctx, banner, flavor, rest) {
  const p = config.prefix
  const verb = flavor === 'tipped' ? 'tip' : 'pay'
  if (banner) await ctx.reply(banner.trim())

  const targetJid = resolveTargetJid(ctx, rest[0])
  if (!targetJid) {
    return ctx.reply(
      `❓ Usage: *${p}${verb} @player <amount> [note]*\n` +
      `_Or reply to their message and just say *${p}${verb} 500*._`,
    )
  }

  const at = amountIndex(rest, targetJid)
  const amount = at >= 0 ? parseAmount(rest[at]) : null
  if (!amount) {
    return ctx.reply(`❓ How much? e.g. *${p}${verb} @player 500 ${verb === 'tip' ? 'nice one' : 'for the potion'}*`)
  }
  const note = at >= 0 ? rest.slice(at + 1).join(' ').trim().slice(0, 120) : ''

  return sendSolars({ ...ctx, prefix: p }, targetJid, amount, note, flavor)
}

// ── Handlers: pay requests ───────────────────────────────────────────────────

/**
 * .apay request @player <n> [note] — an invoice, not a transfer.
 *
 * The record lives on the PAYER as player.payRequest (that is the shape the live
 * database already had), so only one request can be outstanding against someone
 * at a time, and accepting it needs no search for who asked. The payer hears
 * about it through their notification inbox, never a DM.
 */
async function doRequest(ctx, banner, rest) {
  const p = config.prefix
  const targetJid = resolveTargetJid(ctx, rest[0])
  if (!targetJid) {
    return ctx.reply(`${banner}❓ Usage: *${p}apay request @player <amount> [note]*`)
  }
  if (targetJid === ctx.from) {
    return ctx.reply(`${banner}🙃 You cannot invoice yourself.`)
  }
  if (!playerExists(ctx.db, targetJid)) {
    return ctx.reply(`${banner}❌ *${shortName(ctx.db, targetJid)}* has no AstralPay account yet.`)
  }

  const at = amountIndex(rest, targetJid)
  const amount = at >= 0 ? parseAmount(rest[at]) : null
  if (!amount) {
    return ctx.reply(`${banner}❓ How much are you asking for? e.g. *${p}apay request @player 500 for the raid*`)
  }
  const note = rest.slice(at + 1).join(' ').trim().slice(0, 120)
  const ref = genRef()
  const expiresAt = Date.now() + PAY_REQUEST_TIMEOUT_MS

  let blocked = null
  await updatePlayer(ctx.db, targetJid, target => {
    const live = livePayRequest(target)
    if (live && live.fromJid !== ctx.from) { blocked = live; return target }
    target.payRequest = {
      fromJid: ctx.from,
      fromName: ctx.player?.name ?? shortName(ctx.db, ctx.from),
      amount, note, ref, expiresAt,
    }
    return target
  })
  if (blocked) {
    return ctx.reply(
      `${banner}⏳ *${shortName(ctx.db, targetJid)}* already has a request open from *${blocked.fromName}*.\n` +
      `_One at a time. It clears in ${minutesLeft(blocked.expiresAt)}._`,
    )
  }

  await pushNotification(ctx.db, targetJid, {
    kind: 'social',
    title: `📨 ${ctx.player?.name ?? 'Someone'} asked you for ${amount.toLocaleString()} solars`,
    body: (note ? `"${note}" ` : '') +
      `Send it with ${p}apay accept, or turn it down with ${p}apay decline.`,
    meta: { ref, amount, fromJid: ctx.from },
  }).catch(() => {})

  return ctx.reply(banner + [
    `📨 *Request sent to ${shortName(ctx.db, targetJid)}.*`,
    RULE,
    `☀️ Amount: *${num(amount)}*`,
    ...(note ? [`📝 _${note}_`] : []),
    `⏳ They have *${minutesLeft(expiresAt)}* to accept.`,
    `_Ref #${ref}  ·  they accept with *${p}apay accept*_`,
  ].join('\n'))
}

/** .apay accept / .apay decline — settle whatever is outstanding against you. */
async function doSettle(ctx, banner, decline) {
  const p = config.prefix
  const mins = Math.round(PAY_REQUEST_TIMEOUT_MS / 60_000)
  const req = livePayRequest(ctx.player)

  if (!req) {
    if (ctx.player?.payRequest) {
      // Expired husk: clear it so the hub stops rendering a dead request.
      await updatePlayer(ctx.db, ctx.from, player => { delete player.payRequest; return player })
    }
    return ctx.reply(
      `${banner}📭 *Nothing is outstanding against you.*\n` +
      `_Requests expire after ${mins} minutes. Ask for money with *${p}apay request @player <amount>*._`,
    )
  }

  if (decline) {
    await updatePlayer(ctx.db, ctx.from, player => { delete player.payRequest; return player })
    await pushNotification(ctx.db, req.fromJid, {
      kind: 'social',
      title: `🚫 ${ctx.player?.name ?? 'They'} declined your request`,
      body: `Your request for ${req.amount.toLocaleString()} solars (ref ${req.ref}) was turned down.`,
      meta: { ref: req.ref },
    }).catch(() => {})
    return ctx.reply(`${banner}🚫 *Declined ${req.fromName}'s request for ☀️ ${num(req.amount)}.*`)
  }

  if (banner) await ctx.reply(banner.trim())
  const paid = await sendSolars({ ...ctx, prefix: p }, req.fromJid, req.amount, req.note ?? '', 'paid')

  // Clear the request only once the money has actually moved. If the transfer was
  // blocked (a guard, or not enough solars) the request stays open so they can
  // top up and run it again. Failing this check the other way would delete an
  // unpaid invoice, so the harmless direction is to leave it until it expires.
  if (paid) {
    await updatePlayer(ctx.db, ctx.from, player => {
      if (player.payRequest?.ref === req.ref) delete player.payRequest
      return player
    })
  }
  return paid
}

// ── Handlers: giveaways ──────────────────────────────────────────────────────

/**
 * .giveaway <n> [minutes] | join | cancel
 *
 * Group only, one per chat, and the stake is taken into escrow on the record the
 * moment it opens, so nobody can host with solars they then spend elsewhere.
 * There is no timer: the window closes LAZILY, on the next AstralPay command in
 * this same chat (resolveGiveaway), which is also why a giveaway is only ever
 * announced in the chat it ran in.
 */
async function doGiveaway(ctx, banner, sub, amountRaw, minutesRaw) {
  const p = config.prefix
  const chat = ctx.sender
  if (!ctx.isGroup) {
    return ctx.reply(`${banner}👥 *Giveaways run in groups only.* There is nobody here to give to.`)
  }

  const open = openGiveaway(ctx.db, chat)
  const word = String(sub ?? '').toLowerCase()
  const headcount = open ? Object.keys(open.entrants).length : 0

  if (['join', 'enter', 'in', 'me'].includes(word)) {
    if (!open) {
      return ctx.reply(`${banner}🎪 No giveaway is running here. Start one with *${p}giveaway 500*.`)
    }
    if (open.hostJid === ctx.from) {
      return ctx.reply(`${banner}🎪 You are hosting this one, so you cannot enter it.`)
    }
    if (open.entrants[ctx.from]) {
      return ctx.reply(
        `${banner}✅ *You are already in.* ${headcount} entrant${headcount === 1 ? '' : 's'} so far, ` +
        `drawn in *${minutesLeft(open.endsAt)}*.`,
      )
    }
    let count = 0
    await updatePlayer(ctx.db, ctx.from, player => {
      const live = openGiveaway(ctx.db, chat)
      if (!live || live.id !== open.id) return player
      live.entrants[ctx.from] = player.name ?? 'Someone'
      count = Object.keys(live.entrants).length
      return player
    })
    if (!count) return ctx.reply(`${banner}🎪 That giveaway just closed.`)
    return ctx.reply(
      `${banner}🙋 *You are in ${open.hostName}'s giveaway for ☀️ ${num(open.amount)}.*\n` +
      `${count} entrant${count === 1 ? '' : 's'}  ·  drawn in *${minutesLeft(open.endsAt)}*`,
    )
  }

  if (['cancel', 'stop', 'abort'].includes(word)) {
    if (!open) return ctx.reply(`${banner}🎪 Nothing to cancel here.`)
    if (open.hostJid !== ctx.from) {
      return ctx.reply(`${banner}🚫 Only *${open.hostName}* can cancel that giveaway.`)
    }
    if (headcount > 0) {
      return ctx.reply(
        `${banner}🚫 *${headcount} player${headcount === 1 ? ' has' : 's have'} already entered*, so it has to run.\n` +
        `_It draws in ${minutesLeft(open.endsAt)}._`,
      )
    }
    let refunded = 0
    await updatePlayer(ctx.db, ctx.from, player => {
      const live = openGiveaway(ctx.db, chat)
      if (!live || live.id !== open.id) return player
      player.wallet = player.wallet ?? {}
      player.wallet.solars = (player.wallet.solars ?? 0) + live.amount
      pushTxLog(player, { ref: live.ref, type: 'giveaway_refund', amount: live.amount })
      refunded = live.amount
      delete ensureGiveaways(ctx.db)[chat]
      return player
    })
    if (!refunded) return ctx.reply(`${banner}🎪 That giveaway just closed on its own.`)
    return ctx.reply(`${banner}↩️ *Giveaway cancelled.* ☀️ *${num(refunded)}* is back in your wallet.`)
  }

  if (!word || ['status', 'info', 'check'].includes(word)) {
    if (!open) {
      return ctx.reply(banner + [
        `🎪 *GIVEAWAYS*`,
        RULE,
        `Nothing is running in this chat.`,
        `> *${p}giveaway <amount> [minutes]*  ·  put your own solars up`,
        `_Minimum ☀️ ${num(GIVEAWAY_MIN_AMOUNT)}. Window ${GIVEAWAY_MIN_MINUTES} to ${GIVEAWAY_MAX_MINUTES} minutes, ${GIVEAWAY_DEFAULT_MINUTES} by default._`,
      ].join('\n'))
    }
    const names = Object.values(open.entrants).slice(0, 10)
    return ctx.reply(banner + [
      `🎪 *GIVEAWAY*  ·  hosted by *${open.hostName}*`,
      RULE,
      `☀️ Prize: *${num(open.amount)}*`,
      `🙋 Entrants: *${headcount}*`,
      `⏳ Draws in: *${minutesLeft(open.endsAt)}*`,
      ...(names.length ? [`_${names.join(', ')}${headcount > names.length ? ', …' : ''}_`] : []),
      RULE,
      open.entrants[ctx.from] ? `_You are in. Good luck._` : `> *${p}giveaway join*  ·  free to enter`,
      `_Nothing runs in the background, so the draw happens on the next AstralPay command in this chat once the window shuts._`,
    ].join('\n'))
  }

  // Anything else has to be an amount: .giveaway 500 [minutes]
  if (open) {
    return ctx.reply(
      `${banner}🎪 *${open.hostName}* already has a giveaway running here for ☀️ *${num(open.amount)}*.\n` +
      `_It draws in ${minutesLeft(open.endsAt)}. Join that one with *${p}giveaway join*._`,
    )
  }
  const amount = parseAmount(amountRaw ?? sub, ctx.player?.wallet?.solars ?? 0)
  if (!amount) {
    return ctx.reply(`${banner}❓ Usage: *${p}giveaway <amount> [minutes]*, e.g. *${p}giveaway 1000 10*`)
  }
  if (amount < GIVEAWAY_MIN_AMOUNT) {
    return ctx.reply(`${banner}❌ The smallest giveaway is ☀️ *${num(GIVEAWAY_MIN_AMOUNT)}*.`)
  }
  const asked = minutesRaw === undefined ? GIVEAWAY_DEFAULT_MINUTES : Math.floor(Number(minutesRaw))
  if (!Number.isFinite(asked) || asked <= 0) {
    return ctx.reply(`${banner}❓ Minutes must be a number from ${GIVEAWAY_MIN_MINUTES} to ${GIVEAWAY_MAX_MINUTES}.`)
  }
  const mins = Math.min(GIVEAWAY_MAX_MINUTES, Math.max(GIVEAWAY_MIN_MINUTES, asked))
  const endsAt = Date.now() + mins * 60_000
  const ref = genRef()

  let staked = null
  await updatePlayer(ctx.db, ctx.from, player => {
    if (openGiveaway(ctx.db, chat)) return player // someone raced us to it
    const w = player.wallet = player.wallet ?? {}
    if ((w.solars ?? 0) < amount) { staked = { poor: w.solars ?? 0 }; return player }
    w.solars -= amount
    pushTxLog(player, { ref, type: 'giveaway_hosted', amount })
    ensureGiveaways(ctx.db)[chat] = {
      id: ref,
      ref,
      hostJid: ctx.from,
      hostName: player.name ?? 'Someone',
      amount,
      endsAt,
      entrants: {},
    }
    staked = { ok: true, solars: w.solars }
    return player
  })

  if (staked?.poor !== undefined) {
    return ctx.reply(
      `${banner}💸 A ☀️ *${num(amount)}* giveaway needs that much in your wallet.\n` +
      `You have *${num(staked.poor)}*.`,
    )
  }
  if (!staked?.ok) {
    return ctx.reply(`${banner}🎪 Someone opened a giveaway here a moment ago. Wait for that one to draw.`)
  }

  return ctx.reply(banner + [
    `🎪 *GIVEAWAY OPEN*`,
    RULE,
    `*${ctx.player?.name ?? 'Someone'}* is giving away ☀️ *${num(amount)}*.`,
    `⏳ Closes in *${mins} minute${mins === 1 ? '' : 's'}*.`,
    `🙋 *${p}giveaway join* to enter. Free.`,
    RULE,
    `☀️ Your wallet: *${num(staked.solars)}*  _(the stake is held until it draws)_`,
    `_Ref #${ref}  ·  the winner is drawn on the next AstralPay command in this chat once the window shuts._`,
  ].join('\n'))
}

// ── Plugin ───────────────────────────────────────────────────────────────────

/**
 * ONE plugin serves fourteen command names. The loader registers `name` plus
 * every alias, and dispatch() sets ctx.cmd to whichever of them was actually
 * typed before calling run(), so the router below branches on ctx.cmd first and
 * only falls through to .apay subcommand parsing for the hub itself. This is the
 * same pattern .sleep uses to reach the inn.
 */
export default {
  name: 'apay',
  aliases: [
    'astralpay',
    'balance', 'bal',
    'pay', 'tip',
    'bank', 'deposit', 'withdraw',
    'loan', 'repay',
    'tx', 'txlog',
    'giveaway',
  ],
  category: 'economy',
  requiresPlayer: true,
  description: 'AstralPay: wallet, bank, vault, loans, transfers and giveaways',
  subcommands: [
    { cmd: 'balance', desc: 'your full statement' },
    { cmd: 'pay @player <n> [note]', desc: 'send solars' },
    { cmd: 'tip @player <n>', desc: 'same money, nicer wording' },
    { cmd: 'bank deposit|withdraw <n>', desc: `savings at ${Math.round(BANK_DAILY_RATE * 100)}% a day` },
    { cmd: 'deposit|withdraw <n>', desc: 'move solars in and out of the vault' },
    { cmd: 'loan <n>', desc: 'borrow against your level' },
    { cmd: 'repay <n|all>', desc: 'pay a loan down' },
    { cmd: 'request @player <n>', desc: 'ask someone to pay you' },
    { cmd: 'accept | decline', desc: 'settle a request against you' },
    { cmd: 'tx [n]', desc: 'your ledger' },
    { cmd: 'giveaway <n> [minutes]', desc: 'put solars up for the group' },
  ],

  async run(ctx) {
    const p = config.prefix
    await ctx.db.read()

    // Close the giveaway that ran in THIS chat, if its window has shut. What
    // happened is prepended to this caller's reply and pushed to the winner's
    // inbox, and is never announced in any other chat.
    const banner = giveawayBanner(await resolveGiveaway(ctx, ctx.sender))

    const cmd = String(ctx.cmd ?? 'apay').toLowerCase()
    const args = Array.isArray(ctx.args) ? ctx.args : []

    // The aliases that are commands in their own right: .pay @x 500, .bank
    // deposit 100, .tx 20, and so on.
    switch (cmd) {
      case 'balance':
      case 'bal': {
        const { summary, bank, loan } = await touchAccounts(ctx)
        return ctx.reply(banner + balanceText(ctx, summary, bank, loan))
      }
      case 'pay':      return doPay(ctx, banner, 'paid', args)
      case 'tip':      return doPay(ctx, banner, 'tipped', args)
      case 'bank':     return doBank(ctx, banner, args[0]?.toLowerCase(), args[1])
      case 'deposit':  return doVault(ctx, banner, 'deposit', args[0])
      case 'withdraw': return doVault(ctx, banner, 'withdraw', args[0])
      case 'loan':
        // .loan 500 and .loan request 500 both mean the same thing.
        return doLoan(ctx, banner, args[0]?.toLowerCase() === 'request' ? args[1] : args[0])
      case 'repay':    return doRepay(ctx, banner, args[0])
      case 'tx':
      case 'txlog':    return doTx(ctx, banner, args[0])
      case 'giveaway': return doGiveaway(ctx, banner, args[0], args[0], args[1])
    }

    // .apay / .astralpay [subcommand]
    const sub = String(args[0] ?? '').toLowerCase()
    const rest = args.slice(1)

    switch (sub) {
      case '':
      case 'help':
      case 'hub':
      case 'menu':
      case 'info': {
        const { summary, bank, loan } = await touchAccounts(ctx)
        return trySendButtons({ ...ctx, jid: ctx.sender, prefix: p }, {
          body: banner + hubText(ctx, summary, bank, loan),
          footer: 'AstralPay',
          buttons: [
            { id: `${p}balance`, label: '💳 Statement' },
            { id: `${p}tx`, label: '📒 Ledger' },
            { id: `${p}bank`, label: '🏦 Bank' },
          ],
        })
      }
      case 'balance':
      case 'bal':
      case 'statement': {
        const { summary, bank, loan } = await touchAccounts(ctx)
        return ctx.reply(banner + balanceText(ctx, summary, bank, loan))
      }
      case 'pay':
      case 'send':     return doPay(ctx, banner, 'paid', rest)
      case 'tip':      return doPay(ctx, banner, 'tipped', rest)
      case 'bank':     return doBank(ctx, banner, rest[0]?.toLowerCase(), rest[1])
      case 'deposit':
      case 'vault':    return doVault(ctx, banner, 'deposit', rest[0])
      case 'withdraw': return doVault(ctx, banner, 'withdraw', rest[0])
      case 'loan':
        // .apay loan repay <n|all> is the route loanrequest.js advertises.
        if (rest[0]?.toLowerCase() === 'repay') return doRepay(ctx, banner, rest[1])
        return doLoan(ctx, banner, rest[0]?.toLowerCase() === 'request' ? rest[1] : rest[0])
      case 'repay':    return doRepay(ctx, banner, rest[0])
      case 'tx':
      case 'txlog':
      case 'log':
      case 'history':  return doTx(ctx, banner, rest[0])
      case 'request':
      case 'invoice':
      case 'ask':      return doRequest(ctx, banner, rest)
      case 'accept':
      case 'yes':      return doSettle(ctx, banner, false)
      case 'decline':
      case 'reject':
      case 'no':       return doSettle(ctx, banner, true)
      case 'giveaway':
      case 'drop':     return doGiveaway(ctx, banner, rest[0], rest[0], rest[1])
    }

    return ctx.reply(
      `${banner}❓ *${p}apay ${sub}* is not an AstralPay command.\n` +
      `_Try *${p}apay* for the hub, or *${p}balance*, *${p}pay*, *${p}bank*, *${p}loan*, *${p}tx*._`,
    )
  },
}
