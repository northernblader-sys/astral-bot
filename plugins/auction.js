/**
 * auction.js — Astral Auction House. Solars-only bidding on mythic gear
 * that exists ONLY here (data/auction.json) — never in the shop, never
 * craftable.
 *
 * Usage:
 *   .auction              — show all 5 current lots
 *   .auction bid <#> <amt> — place a bid on lot number # (1-5)
 *   .auction history      — last few items sold
 *
 * 5 lots are active at once, shared realm-wide, and all refresh together
 * once per day (all 5 replaced with a fresh random 5 regardless of whether
 * they sold). Each lot has its own independent bid + 10-min countdown timer,
 * anti-sniped individually.
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { auctionItems } from '../lib/game-data.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import { pushTxLog, genRef } from '../lib/astralpay.js'

const BID_WINDOW_MS   = 10 * 60 * 1000
const LOT_COUNT       = 5
const DAY_MS          = 24 * 60 * 60 * 1000

let lots = []            // array of up to LOT_COUNT lot objects, see startLot()
let currentDayKey = null // which day's rotation is currently loaded
const soldHistory = []   // { itemName, buyerName, price, at }

function todayKey() {
  return Math.floor(Date.now() / DAY_MS)
}

function pickRandomFive() {
  const pool = [...auctionItems]
  const picked = []
  for (let i = 0; i < LOT_COUNT && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length)
    picked.push(pool.splice(idx, 1)[0])
  }
  return picked
}

function slotLabel(item) {
  const map = { weapon: '⚔️ Weapon', offhand: '🛡️ Offhand', helmet: '⛑️ Helmet', chestplate: '👕 Chestplate', boots: '👢 Boots', relic: '💠 Relic' }
  return map[item.slot] ?? item.slot
}

function startLot(item, ctx) {
  const lot = {
    item,
    bid: item.startingBid,
    bidderId: null,
    bidderName: null,
    endsAt: Date.now() + BID_WINDOW_MS,
    jid: ctx.sender,
    _timeout: null,
  }
  lot._timeout = setTimeout(() => closeLot(lot, ctx), BID_WINDOW_MS)
  return lot
}

/**
 * Ensures today's rotation of 5 lots is loaded. If the day has rolled over
 * since the lots were last built, wipes all 5 (regardless of sold/unsold
 * state) and replaces them with a fresh random 5 — this is a deliberate
 * "always replace all 5 daily" reset, not a carry-over.
 */
function ensureRotation(ctx) {
  const key = todayKey()
  if (currentDayKey === key && lots.length) return

  // Clear any still-running timers from the previous rotation.
  for (const lot of lots) {
    if (lot?._timeout) clearTimeout(lot._timeout)
  }

  currentDayKey = key
  lots = pickRandomFive().map(item => startLot(item, ctx))
}

async function closeLot(lot, ctx) {
  const idx = lots.indexOf(lot)
  if (idx === -1) return // already replaced by a daily rotation

  if (!lot.bidderId) {
    soldHistory.unshift({ itemId: lot.item.id, itemName: lot.item.name, buyerName: null, price: 0, at: Date.now() })
    if (soldHistory.length > 20) soldHistory.length = 20
    try {
      await ctx.sock.sendMessage(lot.jid, {
        text: `🏛️ *AUCTION LOT CLOSED*\n\n*${lot.item.name}* went unsold — no bids reached the reserve.\n_All lots refresh daily — check *${config.prefix}auction*._`,
      })
    } catch {}
    return
  }

  // The winning bid was already escrowed from the bidder's wallet in placeBid.
  // At settlement we only grant the item. If the inventory is full, refund
  // the escrowed bid instead — the bidder keeps their solars, lot goes unsold.
  let outcome = 'pending'
  await updatePlayer(ctx.db, lot.bidderId, player => {
    player.wallet = player.wallet ?? {}
    if (!hasInventoryRoom(player, 1)) {
      // Inventory full: refund the escrowed bid
      player.wallet.solars = (player.wallet.solars ?? 0) + lot.bid
      pushTxLog(player, {
        ref: genRef(), type: 'auction_refund', amount: lot.bid,
        note: `${lot.item.name} — inventory full at settlement`,
      })
      outcome = 'inventory_full'
      return player
    }
    // Grant item — no solar deduction here, bid was already escrowed
    if (!player.inventory.includes(lot.item.id)) player.inventory.push(lot.item.id)
    pushTxLog(player, {
      ref: genRef(), type: 'auction_win', amount: lot.bid,
      note: lot.item.name,
    })
    outcome = 'sold'
    return player
  }).catch(() => { outcome = 'error' })

  if (outcome === 'inventory_full') {
    soldHistory.unshift({ itemId: lot.item.id, itemName: lot.item.name, buyerName: null, price: 0, at: Date.now() })
    if (soldHistory.length > 20) soldHistory.length = 20
    try {
      await ctx.sock.sendMessage(lot.jid, {
        text:
`🏛️ *AUCTION LOT CLOSED — SALE FAILED*

*${lot.item.name}* would have sold to *${lot.bidderName}* for *${lot.bid.toLocaleString()} ☀️*, but their inventory is full.
☀️ *${lot.bid.toLocaleString()} solars* refunded to *${lot.bidderName}* — lot goes unsold.

_All lots refresh daily — check *${config.prefix}auction*._`,
      })
    } catch {}
    return
  }

  if (outcome === 'sold') {
    soldHistory.unshift({ itemId: lot.item.id, itemName: lot.item.name, buyerName: lot.bidderName, price: lot.bid, at: Date.now() })
    if (soldHistory.length > 20) soldHistory.length = 20
    try {
      await ctx.sock.sendMessage(lot.jid, {
        text:
`🏛️ *AUCTION LOT CLOSED — SOLD!*

*${lot.item.name}* sold to *${lot.bidderName}* for *${lot.bid.toLocaleString()} ☀️*!

_All lots refresh daily — check *${config.prefix}auction*._`,
      })
    } catch {}
  }
}

function formatLots(allLots) {
  const p = config.prefix
  const lines = [
    `🏛️ *ASTRAL AUCTION HOUSE*`,
    `─────────────────────`,
    `_5 mythic lots, refreshed daily. Highest bidder wins when the timer runs out._`,
    '',
  ]

  allLots.forEach((lot, i) => {
    const item = lot.item
    const remaining = Math.max(0, Math.ceil((lot.endsAt - Date.now()) / 60000))
    const bonusLines = Object.entries(item.statBonuses ?? {})
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${k.toUpperCase()} +${v}`)
      .join(' · ')

    lines.push(`*[${i + 1}]* 🟥 *${item.name}* _(Mythic)_`)
    lines.push(`${slotLabel(item)} · 🔒 Lvl ${item.levelReq} · ${bonusLines}`)
    lines.push(
      `💰 ${lot.bid.toLocaleString()} ☀️` +
      (lot.bidderName ? ` — *${lot.bidderName}*` : ' — no bids') +
      ` · ⏱️ ${remaining}m left`,
    )
    lines.push('')
  })

  lines.push(`_Use *${p}auction bid <#> <amount>* — e.g. ${p}auction bid 2 5000_`)
  return lines.join('\n')
}

export default {
  name:           'auction',
  aliases:        ['ah', 'auctionhouse'],
  category:       'economy',
  requiresPlayer: true,
  description:    'Bid on mythic gear that only ever appears in the Auction House — 5 lots, refreshed daily',

  async run(ctx) {
    const { args, reply } = ctx
    const sub = args[0]?.toLowerCase()

    ensureRotation(ctx)

    if (sub === 'history') return showHistory(ctx)
    if (sub === 'bid')      return placeBid(ctx)

    return reply(formatLots(lots))
  },
}

async function placeBid(ctx) {
  const { player, args, reply } = ctx
  const p = config.prefix

  const lotNum = parseInt(args[1], 10)
  const amount = Math.floor(Number(args[2]))

  if (!lotNum || lotNum < 1 || lotNum > lots.length) {
    return reply(`❌ Usage: *${p}auction bid <#> <amount>* — pick a lot number from 1-${lots.length} shown in *${p}auction*.`)
  }
  if (!amount || amount <= 0) {
    return reply(`❌ Usage: *${p}auction bid <#> <amount>*`)
  }

  const lot = lots[lotNum - 1]
  if (!lot) {
    return reply(`❌ Lot *#${lotNum}* isn't active right now. Run *${p}auction* to see current lots.`)
  }
  if (amount <= lot.bid) {
    return reply(`❌ Your bid must beat the current bid of *${lot.bid.toLocaleString()} ☀️* on lot #${lotNum}.`)
  }
  if (player.level < lot.item.levelReq) {
    return reply(`❌ *${lot.item.name}* requires Level *${lot.item.levelReq}* to bid on.`)
  }
  if ((player.wallet?.solars ?? 0) < amount) {
    return reply(`❌ You don't have *${amount.toLocaleString()} ☀️*. You have: ${(player.wallet?.solars ?? 0).toLocaleString()} ☀️.`)
  }
  if (lot.bidderId === player.id) {
    return reply(`⚠️ You're already the top bidder on lot #${lotNum} at *${lot.bid.toLocaleString()} ☀️*.`)
  }

  // Capture previous bidder before mutating the lot
  const prevBidderId = lot.bidderId
  const prevBid      = lot.bid
  const prevBidderName = lot.bidderName

  // Escrow the new bid — deduct now so the balance is reserved.
  // Re-check affordability inside updatePlayer against the FRESH balance
  // (the ctx.player snapshot above could be stale if they spent solars elsewhere).
  let escrowed = false
  await updatePlayer(ctx.db, ctx.from, p => {
    p.wallet = p.wallet ?? {}
    const fresh = p.wallet.solars ?? 0
    if (fresh < amount) {
      reply(`❌ Insufficient funds — you only have *${fresh.toLocaleString()} ☀️* right now.`).catch(() => {})
      return p
    }
    p.wallet.solars = Math.max(0, fresh - amount)
    pushTxLog(p, {
      ref: genRef(), type: 'auction_bid', amount,
      note: `Bid on ${lot.item.name} (lot #${lotNum})`,
    })
    escrowed = true
    return p
  }).catch(() => {})

  if (!escrowed) return  // balance changed between pre-check and escrow — bail (error already sent)

  // Update the lot record
  lot.bid        = amount
  lot.bidderId   = player.id
  lot.bidderName = player.name

  // Refund the outbid player immediately
  if (prevBidderId && prevBidderId !== player.id) {
    await updatePlayer(ctx.db, prevBidderId, prev => {
      prev.wallet = prev.wallet ?? {}
      prev.wallet.solars = (prev.wallet.solars ?? 0) + prevBid
      pushTxLog(prev, {
        ref: genRef(), type: 'auction_outbid', amount: prevBid,
        note: `Outbid on ${lot.item.name} — refunded`,
      })
      return prev
    }).catch(() => {})

    // DM to the outbid player disabled on request — refund above still
    // lands in their wallet and is logged via pushTxLog, they just aren't
    // pinged about it in DM anymore. They'll see the balance change next
    // time they check .stash/.mystats, or the new high bid if they're
    // still watching the lot in the host chat.
  }

  // Anti-snipe: bidding within the last minute extends that lot's window by 1 min
  const remaining = lot.endsAt - Date.now()
  if (remaining < 60_000) {
    lot.endsAt += 60_000
    clearTimeout(lot._timeout)
    lot._timeout = setTimeout(() => closeLot(lot, ctx), lot.endsAt - Date.now())
  }

  return reply(
    `✅ *Bid placed on lot #${lotNum}!*\n\n` +
    `🟥 *${lot.item.name}*\n` +
    `💰 New top bid: *${amount.toLocaleString()} ☀️* _(escrowed from your wallet)_\n` +
    `⏱️ Time left: *${Math.max(0, Math.ceil((lot.endsAt - Date.now()) / 60000))} min*\n\n` +
    `_If you're outbid your solars are refunded instantly. You pay only if you win._` +
    (prevBidderName ? `\n_${prevBidderName} has been refunded their bid._` : '')
  )
}

async function showHistory(ctx) {
  const { reply } = ctx
  if (!soldHistory.length) {
    return reply(`🏛️ *AUCTION HISTORY*\n\n_Nothing has sold yet._`)
  }
  const lines = soldHistory.slice(0, 10).map(h =>
    h.buyerName
      ? `• *${h.itemName}* → *${h.buyerName}* for ${h.price.toLocaleString()} ☀️`
      : `• *${h.itemName}* — unsold`
  )
  return reply(`🏛️ *AUCTION HISTORY*\n─────────────────────\n${lines.join('\n')}`)
}
