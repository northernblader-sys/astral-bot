/**
 * plugins/lottery.js — a daily solars raffle.
 *
 *   .lottery              pot, your tickets, your odds, time to the draw
 *   .lottery buy [n]      buy n tickets (default 1)
 *   .lottery last         who won the previous round
 *
 * DESIGN: this is a solars SINK first and a prize second. Every ticket sends
 * POT_SHARE of its price into the pot and BURNS the rest, so the game removes
 * solars from the economy on every sale no matter who wins. Nothing here mints
 * gems, and the prize can only ever be solars players already paid in.
 *
 * NO SCHEDULER: this bot has no cron anywhere, so the draw is resolved LAZILY,
 * exactly like production collection. The first player to run any .lottery
 * subcommand after drawAt triggers the resolution of the round that just
 * closed, then their own command proceeds against the fresh round. If nobody
 * runs the command for three days, the round simply sits there and resolves
 * whenever someone next looks. That is intentional, not a bug.
 *
 * WRITE SAFETY:
 *   - The shared round record lives on db.data.lottery and is mutated INSIDE an
 *     updatePlayer mutator (the season-runtime idiom), so the round and the
 *     wallet move in one atomic serialized write.
 *   - Paying a winner who is not the caller is a SEPARATE top-level
 *     updatePlayer. updatePlayer is NEVER nested inside another one: they share
 *     one write queue and nesting deadlocks it.
 *   - Two players can race into the same draw. The paying mutator therefore
 *     re-checks roundId under the lock (compare-and-swap) and no-ops if another
 *     call already resolved that round, so a pot can never be paid twice.
 *   - The winner gets ONE inbox notification. There is no group broadcast and
 *     no DM fan-out.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { pushNotification } from '../lib/notification-repo.js'

// ── Tuning ───────────────────────────────────────────────────────────────────
const TICKET_PRICE = 500        // solars per ticket
const POT_SHARE = 0.9           // share of each sale that reaches the pot
const MAX_TICKETS = 20          // per player, per round
const ROUND_MS = 24 * 60 * 60 * 1000
const MIN_PARTICIPANTS = 2      // fewer than this and the pot rolls over
const MIN_LEVEL = 5             // same floor as player transfers

const RULE = '━━━━━━━━━━━━━━━━━━━━'

// ── Round record ─────────────────────────────────────────────────────────────

/**
 * Lazily creates and sanitizes db.data.lottery, returning the live record.
 * Safe to call inside or outside a mutator: it only ever fills in missing
 * fields, so a half written record from an older version self repairs.
 */
function ensureLottery(db, now) {
  const d = db.data
  if (!d.lottery || typeof d.lottery !== 'object') d.lottery = {}
  const L = d.lottery
  if (!Number.isFinite(L.roundId)) L.roundId = 1
  if (!Number.isFinite(L.potSolars) || L.potSolars < 0) L.potSolars = 0
  if (!Number.isFinite(L.drawAt) || L.drawAt <= 0) L.drawAt = now + ROUND_MS
  if (!L.tickets || typeof L.tickets !== 'object' || Array.isArray(L.tickets)) L.tickets = {}
  for (const [jid, entry] of Object.entries(L.tickets)) {
    const count = Math.floor(Number(entry?.count))
    if (!Number.isInteger(count) || count <= 0) { delete L.tickets[jid]; continue }
    L.tickets[jid] = { name: String(entry.name ?? 'Someone'), count: Math.min(count, MAX_TICKETS) }
  }
  if (L.lastResult && typeof L.lastResult !== 'object') L.lastResult = null
  return L
}

function totalTickets(L) {
  return Object.values(L.tickets).reduce((sum, t) => sum + t.count, 0)
}

function timeLeft(untilMs, now) {
  const ms = Math.max(0, (untilMs ?? 0) - now)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.ceil((ms % 3_600_000) / 60_000)
  if (h >= 1) return `${h}h ${m}m`
  return `${Math.max(1, m)}m`
}

/**
 * Picks a winner jid weighted by ticket count. Pure: takes a plain snapshot of
 * the ticket map and an rng, so it is fully testable without a socket or a db.
 */
export function pickWinner(tickets, rng = Math.random) {
  const entries = Object.entries(tickets)
  const total = entries.reduce((sum, [, t]) => sum + t.count, 0)
  if (total <= 0) return null
  let roll = rng() * total
  for (const [jid, t] of entries) {
    roll -= t.count
    if (roll < 0) return { jid, name: t.name, count: t.count }
  }
  // Float drift only: fall back to the last entry rather than returning null.
  const [jid, t] = entries[entries.length - 1]
  return { jid, name: t.name, count: t.count }
}

// ── Lazy draw ────────────────────────────────────────────────────────────────

/**
 * Resolves the round if its deadline has passed. Returns a plain summary of
 * what happened so the caller can surface it in-chat, or null if the round is
 * still open (or was already resolved by a racing call).
 *
 * Shape: { rolledOver: true, participants } | { winnerName, prize, ... }
 */
async function maybeResolveDraw(ctx, now) {
  const L = ensureLottery(ctx.db, now)
  if (now < L.drawAt) return null

  const participants = Object.keys(L.tickets).length
  const roundId = L.roundId

  // Not enough players to make a draw meaningful: extend the deadline and keep
  // every ticket valid. Nobody loses the solars they already paid in.
  if (participants < MIN_PARTICIPANTS) {
    let applied = false
    await updatePlayer(ctx.db, ctx.from, player => {
      const rec = ensureLottery(ctx.db, now)
      if (rec.roundId !== roundId || now < rec.drawAt) return player
      rec.drawAt = now + ROUND_MS
      applied = true
      return player
    })
    if (!applied) return null
    return { rolledOver: true, participants, pot: L.potSolars }
  }

  const winner = pickWinner({ ...L.tickets }, Math.random)
  if (!winner) return null

  const prizeTarget = Math.max(0, Math.floor(L.potSolars))
  const ticketsSold = totalTickets(L)

  // The winner may not be the caller, so this is its own top-level write. The
  // roundId re-check under the lock is what stops a racing second caller from
  // paying the same pot twice.
  let paid = 0
  let applied = false
  await updatePlayer(ctx.db, winner.jid, player => {
    const rec = ensureLottery(ctx.db, now)
    if (rec.roundId !== roundId || now < rec.drawAt) return player
    paid = Math.max(0, Math.floor(rec.potSolars))
    player.wallet = player.wallet ?? {}
    player.wallet.solars = (player.wallet.solars ?? 0) + paid
    rec.lastResult = {
      roundId,
      winnerJid: winner.jid,
      winnerName: winner.name,
      prize: paid,
      winnerTickets: winner.count,
      ticketsSold,
      participants,
      at: now,
    }
    // Fresh round.
    rec.roundId = roundId + 1
    rec.potSolars = 0
    rec.tickets = {}
    rec.drawAt = now + ROUND_MS
    applied = true
    return player
  })
  if (!applied) return null

  await pushNotification(ctx.db, winner.jid, {
    kind: 'reward',
    title: `🎟️ You won the daily lottery`,
    body: `Round ${roundId} drew your ticket. ${paid.toLocaleString()} solars have been paid into your wallet.`,
  }).catch(() => {})

  return {
    rolledOver: false,
    winnerName: winner.name,
    winnerTickets: winner.count,
    prize: paid,
    prizeTarget,
    ticketsSold,
    participants,
    roundId,
  }
}

/** Renders a resolved-draw summary as a short block to prepend to any reply. */
function drawBanner(outcome) {
  if (!outcome) return ''
  if (outcome.rolledOver) {
    return (
      `⏭️ *The draw rolled over.*\n` +
      `Only ${outcome.participants} player${outcome.participants === 1 ? '' : 's'} had entered, so the pot of ` +
      `*${outcome.pot.toLocaleString()} solars* stays on the table and every ticket is still valid.\n\n`
    )
  }
  return (
    `🎉 *Round ${outcome.roundId} drawn!*\n` +
    `🏆 *${outcome.winnerName}* took *${outcome.prize.toLocaleString()} solars* ` +
    `on ${outcome.winnerTickets} ticket${outcome.winnerTickets === 1 ? '' : 's'} ` +
    `out of ${outcome.ticketsSold}.\n` +
    `_A new round is open._\n\n`
  )
}

// ── Views ────────────────────────────────────────────────────────────────────

function statusText(ctx, L, now, banner) {
  const p = config.prefix
  const mine = L.tickets[ctx.from]?.count ?? 0
  const sold = totalTickets(L)
  const players = Object.keys(L.tickets).length
  const odds = sold > 0 && mine > 0 ? Math.round((mine / sold) * 100) : 0

  const lines = [
    `🎟️ *DAILY LOTTERY*  ·  round ${L.roundId}`,
    RULE,
    `💰 Pot: *${L.potSolars.toLocaleString()} solars*`,
    `🎫 Tickets sold: *${sold.toLocaleString()}* across *${players}* player${players === 1 ? '' : 's'}`,
    `⏳ Draw in: *${timeLeft(L.drawAt, now)}*`,
    RULE,
    mine > 0
      ? `You hold *${mine}* ticket${mine === 1 ? '' : 's'} (${odds}% of the pot's odds).`
      : `You have no tickets in this round yet.`,
  ]
  if (mine < MAX_TICKETS) {
    lines.push(`> *${p}lottery buy <n>*  ·  ${TICKET_PRICE.toLocaleString()} solars each, max ${MAX_TICKETS} per round`)
  } else {
    lines.push(`_You are at the ${MAX_TICKETS} ticket cap for this round._`)
  }
  if (L.lastResult?.winnerName) {
    lines.push('', `_Last round: ${L.lastResult.winnerName} won ${(L.lastResult.prize ?? 0).toLocaleString()} solars._`)
  }
  if (players < MIN_PARTICIPANTS) {
    lines.push(`_At least ${MIN_PARTICIPANTS} players must enter or the draw rolls over._`)
  }
  return banner + lines.join('\n')
}

function lastText(L, banner) {
  const r = L.lastResult
  if (!r?.winnerName) {
    return banner + `🎟️ No lottery round has been drawn yet. The first winner is still to come.`
  }
  return banner + [
    `🏆 *LOTTERY, ROUND ${r.roundId}*`,
    RULE,
    `Winner: *${r.winnerName}*`,
    `Prize: *${(r.prize ?? 0).toLocaleString()} solars*`,
    `Held ${r.winnerTickets} of ${r.ticketsSold} tickets, against ${r.participants} player${r.participants === 1 ? '' : 's'}.`,
  ].join('\n')
}

// ── Buy ──────────────────────────────────────────────────────────────────────

async function doBuy(ctx, nArg, now, banner) {
  const p = config.prefix
  const n = nArg === undefined ? 1 : Math.floor(Number(nArg))
  if (!Number.isInteger(n) || n <= 0) {
    return ctx.reply(`${banner}❌ How many tickets? e.g. *${p}lottery buy 3*. Each costs ${TICKET_PRICE.toLocaleString()} solars.`)
  }
  if ((ctx.player?.level ?? 1) < MIN_LEVEL) {
    return ctx.reply(`${banner}🔒 You must be level *${MIN_LEVEL}* to enter the lottery.`)
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const L = ensureLottery(ctx.db, now)
    const held = L.tickets[ctx.from]?.count ?? 0
    const room = MAX_TICKETS - held
    if (room <= 0) { outcome = { reason: 'cap', held }; return player }

    const want = Math.min(n, room)
    const cost = want * TICKET_PRICE
    player.wallet = player.wallet ?? {}
    const have = player.wallet.solars ?? 0
    if (have < cost) { outcome = { reason: 'poor', cost, have, want }; return player }

    player.wallet.solars = have - cost
    const toPot = Math.floor(cost * POT_SHARE)
    L.potSolars += toPot
    L.tickets[ctx.from] = { name: player.name ?? 'Someone', count: held + want }

    outcome = {
      reason: 'ok',
      bought: want,
      clipped: want < n,
      cost,
      burned: cost - toPot,
      held: held + want,
      pot: L.potSolars,
      balance: player.wallet.solars,
      sold: totalTickets(L),
      drawAt: L.drawAt,
      players: Object.keys(L.tickets).length,
    }
    return player
  })

  if (outcome?.reason === 'cap') {
    return ctx.reply(
      `${banner}🎫 You already hold the maximum *${MAX_TICKETS}* tickets for this round.\n` +
      `_Wait for the draw, then buy into the next one._`,
    )
  }
  if (outcome?.reason === 'poor') {
    return ctx.reply(
      `${banner}💸 ${outcome.want} ticket${outcome.want === 1 ? '' : 's'} costs *${outcome.cost.toLocaleString()} solars*.\n` +
      `You have *${outcome.have.toLocaleString()}*.`,
    )
  }
  if (outcome?.reason !== 'ok') {
    return ctx.reply(`${banner}❌ The ticket booth is closed. Try again in a moment.`)
  }

  const odds = outcome.sold > 0 ? Math.round((outcome.held / outcome.sold) * 100) : 100
  const lines = [
    `🎟️ *Bought ${outcome.bought} ticket${outcome.bought === 1 ? '' : 's'}.*`,
    RULE,
    `💸 Paid: *${outcome.cost.toLocaleString()} solars*  (${outcome.burned.toLocaleString()} taken as house fee)`,
    `🎫 You now hold: *${outcome.held}* / ${MAX_TICKETS}`,
    `📈 Your odds: *${odds}%* of ${outcome.sold} ticket${outcome.sold === 1 ? '' : 's'}`,
    `💰 Pot: *${outcome.pot.toLocaleString()} solars*`,
    `💳 Balance: *${outcome.balance.toLocaleString()} solars*`,
    `⏳ Draw in: *${timeLeft(outcome.drawAt, now)}*`,
  ]
  if (outcome.clipped) {
    lines.push(`_Only ${outcome.bought} fit under the ${MAX_TICKETS} ticket cap._`)
  }
  if (outcome.players < MIN_PARTICIPANTS) {
    lines.push(`_At least ${MIN_PARTICIPANTS} players must enter or the draw rolls over and your ticket carries._`)
  }
  return ctx.reply(banner + lines.join('\n'))
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default {
  name:           'lottery',
  aliases:        ['lotto'],
  category:       'economy',
  requiresPlayer: true,
  description:    'Buy tickets for the daily solars lottery',
  subcommands: [
    { cmd: 'buy <n>', desc: `buy tickets (${TICKET_PRICE} solars each)` },
    { cmd: 'last', desc: 'who won the previous round' },
  ],

  async run(ctx) {
    const p = config.prefix
    await ctx.db.read()
    const now = Date.now()

    // Resolve the round that just closed, if any, before doing anything else.
    // Whatever happened is surfaced to this caller in-chat and to the winner's
    // inbox. Never broadcast to a group.
    const outcome = await maybeResolveDraw(ctx, now)
    const banner = drawBanner(outcome)

    const L = ensureLottery(ctx.db, now)
    const sub = ctx.args[0]?.toLowerCase()

    if (sub === 'buy') return doBuy(ctx, ctx.args[1], now, banner)
    if (sub === 'last' || sub === 'winner') return ctx.reply(lastText(L, banner))
    if (!sub || sub === 'info') return ctx.reply(statusText(ctx, L, now, banner))

    // A bare number is treated as a buy count: .lottery 3
    if (/^\d+$/.test(sub)) return doBuy(ctx, sub, now, banner)

    return ctx.reply(
      `${banner}❓ Unknown lottery command.\n` +
      `Try *${p}lottery*, *${p}lottery buy <n>*, or *${p}lottery last*.`,
    )
  },
}
