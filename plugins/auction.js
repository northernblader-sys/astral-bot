/**
 * auction.js — Astral Auction House (single global auction model).
 *
 * ONE auction runs realm-wide at a time. The owner starts it from any group
 * chat by picking an item id from the fixed catalog (data/auction.json —
 * mythic gear that exists ONLY here, never in the shop, never craftable),
 * a starting bid, and a duration. Anyone, from ANY group chat the bot is
 * in, can then bid — bidding is global, not tied to where the auction was
 * started. When the timer runs out, the bot returns to the ORIGINAL
 * starting group and @tags the winner there to announce them.
 *
 * Usage:
 *   .auction start <item_id> <startbid> <duration>  — owner only, opens
 *                                                       the auction and
 *                                                       posts the item's
 *                                                       image + price.
 *                                                       duration is a
 *                                                       number + unit,
 *                                                       e.g. 30m or 2h.
 *   .auction <amount>                                — bid, from any group.
 *   .auction                                         — show current auction.
 *   .auction history                                 — last few items sold.
 *   .auction cancel                                  — owner only, cancels
 *                                                       the running auction
 *                                                       (bid refunded).
 *
 * Bids are escrowed immediately (deducted from the bidder's wallet the
 * moment they bid) and refunded instantly if outbid — you only ever pay if
 * you're the winner when the timer ends. Bidding within the last minute
 * extends the timer by 1 minute (anti-snipe), repeatable.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { auctionItems } from '../lib/game-data.js'
import { hasInventoryRoom } from '../lib/inventory-limits.js'
import { pushTxLog, genRef } from '../lib/astralpay.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { sendImageTo } from '../lib/image.js'

const MIN_DURATION_MS = 60_000                 // 1 minute
const MAX_DURATION_MS = 24 * 60 * 60_000       // 24 hours, sanity cap

const soldHistory = [] // { itemName, buyerName, price, at }

// The single global auction, or null if none is running.
// { item, bid, bidderId, bidderName, endsAt, startJid, _timeout }
let auction = null

function slotLabel(item) {
  const map = { weapon: '⚔️ Weapon', offhand: '🛡️ Offhand', helmet: '⛑️ Helmet', chestplate: '👕 Chestplate', boots: '👢 Boots', relic: '💠 Relic' }
  return map[item.slot] ?? item.slot
}

function findItem(itemId) {
  return auctionItems.find(i => i.id === itemId) ?? null
}

/**
 * Parses a duration string like "30m", "2h", "90" (bare number = minutes)
 * into milliseconds. Returns null if unparseable or out of bounds.
 */
function parseDuration(input) {
  if (!input) return null
  const match = String(input).trim().match(/^(\d+(?:\.\d+)?)\s*(m|h)?$/i)
  if (!match) return null
  const value = parseFloat(match[1])
  if (!value || value <= 0) return null
  const unit = (match[2] ?? 'm').toLowerCase()
  const ms = unit === 'h' ? value * 60 * 60_000 : value * 60_000
  if (ms < MIN_DURATION_MS || ms > MAX_DURATION_MS) return null
  return ms
}

function humanRemaining(ms) {
  const totalMin = Math.max(0, Math.ceil(ms / 60_000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}

function formatAuction() {
  const p = config.prefix
  if (!auction) {
    return (
      `🏛️ *ASTRAL AUCTION HOUSE*\n` +
      `─────────────────────\n` +
      `_No auction is currently running._\n\n` +
      `_Check back later, or use *${p}auction history* to see recent sales._`
    )
  }

  const item = auction.item
  const bonusLines = Object.entries(item.statBonuses ?? {})
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k.toUpperCase()} +${v}`)
    .join(' · ')

  return (
    `🏛️ *ASTRAL AUCTION HOUSE*\n` +
    `─────────────────────\n` +
    `🟥 *${item.name}* _(Mythic)_\n` +
    `${slotLabel(item)} · 🔒 Lvl ${item.levelReq} · ${bonusLines}\n\n` +
    `💰 Current bid: *${auction.bid.toLocaleString()} ☀️*` +
    (auction.bidderName ? ` — *${auction.bidderName}*` : ' — no bids yet') + `\n` +
    `⏱️ Time left: *${humanRemaining(auction.endsAt - Date.now())}*\n\n` +
    `_Use *${p}auction <amount>* to bid, from any group — e.g. ${p}auction 25000_`
  )
}

async function closeAuction(ctx) {
  const closing = auction
  if (!closing) return
  auction = null // free the slot immediately so a new one can start

  if (!closing.bidderId) {
    soldHistory.unshift({ itemId: closing.item.id, itemName: closing.item.name, buyerName: null, price: 0, at: Date.now() })
    if (soldHistory.length > 20) soldHistory.length = 20
    try {
      await ctx.sock.sendMessage(closing.startJid, {
        text: `🏛️ *AUCTION CLOSED*\n\n*${closing.item.name}* went unsold — no bids were placed.`,
      })
    } catch {}
    return
  }

  // The winning bid was already escrowed from the bidder's wallet when they
  // bid. At settlement we only grant the item. If inventory is full, refund
  // the escrowed bid instead — the bidder keeps their solars, sale fails.
  let outcome = 'pending'
  await updatePlayer(ctx.db, closing.bidderId, player => {
    player.wallet = player.wallet ?? {}
    if (!hasInventoryRoom(player, 1)) {
      player.wallet.solars = (player.wallet.solars ?? 0) + closing.bid
      pushTxLog(player, {
        ref: genRef(), type: 'auction_refund', amount: closing.bid,
        note: `${closing.item.name} — inventory full at settlement`,
      })
      outcome = 'inventory_full'
      return player
    }
    if (!player.inventory.includes(closing.item.id)) player.inventory.push(closing.item.id)
    pushTxLog(player, {
      ref: genRef(), type: 'auction_win', amount: closing.bid,
      note: closing.item.name,
    })
    outcome = 'sold'
    return player
  }).catch(() => { outcome = 'error' })

  const bareWinner = String(closing.bidderId).replace(/@.*$/, '')

  if (outcome === 'inventory_full') {
    soldHistory.unshift({ itemId: closing.item.id, itemName: closing.item.name, buyerName: null, price: 0, at: Date.now() })
    if (soldHistory.length > 20) soldHistory.length = 20
    try {
      await ctx.sock.sendMessage(closing.startJid, {
        text:
`🏛️ *AUCTION CLOSED — SALE FAILED*

*${closing.item.name}* would have sold to @${bareWinner} for *${closing.bid.toLocaleString()} ☀️*, but their inventory is full.
☀️ *${closing.bid.toLocaleString()} solars* refunded — item goes unsold.`,
        mentions: [closing.bidderId],
      })
    } catch {}
    return
  }

  if (outcome === 'sold') {
    soldHistory.unshift({ itemId: closing.item.id, itemName: closing.item.name, buyerName: closing.bidderName, price: closing.bid, at: Date.now() })
    if (soldHistory.length > 20) soldHistory.length = 20
    try {
      await ctx.sock.sendMessage(closing.startJid, {
        text:
`🏛️ *AUCTION CLOSED — SOLD!* 🎉

Congratulations @${bareWinner}! You won *${closing.item.name}* for *${closing.bid.toLocaleString()} ☀️*!`,
        mentions: [closing.bidderId],
      })
    } catch {}
  }
}

export default {
  name:           'auction',
  aliases:        ['ah', 'auctionhouse'],
  category:       'economy',
  requiresPlayer: true,
  description:    'One global auction at a time on mythic gear that only ever appears here. Owner starts it, anyone can bid from any group.',
  subcommands: [
    { cmd: 'start <item_id> <startbid> <duration>', desc: 'owner only — open a new auction, e.g. .auction start solaris_reaver 18000 2h' },
    { cmd: '<amount>', desc: 'bid on the running auction from any group, e.g. .auction 25000' },
    { cmd: 'history', desc: 'see recently sold items' },
    { cmd: 'cancel', desc: 'owner only — cancel the running auction' },
  ],

  async run(ctx) {
    const { args, reply } = ctx
    const sub = args[0]?.toLowerCase()

    if (sub === 'start')   return startAuction(ctx)
    if (sub === 'history') return showHistory(ctx)
    if (sub === 'cancel')  return cancelAuction(ctx)

    // .auction <amount> — bid, if the first arg parses as a positive number
    if (args.length && /^\d+$/.test(args[0])) return placeBid(ctx)

    return reply(formatAuction())
  },
}

async function startAuction(ctx) {
  const { args, reply, from } = ctx
  const p = config.prefix

  if (!from || !isOwnerJid(from)) {
    return reply('❌ Owner only.')
  }

  if (auction) {
    return reply(
      `❌ An auction is already running — *${auction.item.name}* at *${auction.bid.toLocaleString()} ☀️*.\n` +
      `_Wait for it to close, or use *${p}auction cancel* first._`,
    )
  }

  const itemId       = args[1]
  const startBid     = Math.floor(Number(args[2]))
  const durationMs   = parseDuration(args[3])

  if (!itemId || !startBid || startBid <= 0 || !durationMs) {
    return reply(
      `❌ Usage: *${p}auction start <item_id> <startbid> <duration>*\n` +
      `_Duration uses m for minutes or h for hours — e.g. ${p}auction start solaris_reaver 18000 2h_`,
    )
  }

  const item = findItem(itemId)
  if (!item) {
    return reply(`❌ No auction-catalog item with id *"${itemId}"*. Check data/auction.json for valid ids.`)
  }

  auction = {
    item,
    bid: startBid,
    bidderId: null,
    bidderName: null,
    endsAt: Date.now() + durationMs,
    startJid: ctx.sender, // the group where the auction was started — winner is announced back here
    _timeout: null,
  }
  auction._timeout = setTimeout(() => closeAuction(ctx), durationMs)

  const bonusLines = Object.entries(item.statBonuses ?? {})
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k.toUpperCase()} +${v}`)
    .join(' · ')

  const caption =
    `🏛️ *AUCTION STARTED!*\n\n` +
    `🟥 *${item.name}* _(Mythic)_\n` +
    `${slotLabel(item)} · 🔒 Lvl ${item.levelReq} · ${bonusLines}\n\n` +
    `💰 Starting bid: *${startBid.toLocaleString()} ☀️*\n` +
    `⏱️ Ends in: *${humanRemaining(durationMs)}*\n\n` +
    `_Use *${p}auction <amount>* to bid — from any group chat!_`

  if (item.image) {
    return sendImageTo(ctx, item.image, caption, ctx.sender)
  }
  return reply(caption)
}

async function cancelAuction(ctx) {
  const { reply, from } = ctx

  if (!from || !isOwnerJid(from)) {
    return reply('❌ Owner only.')
  }
  if (!auction) {
    return reply('❌ No auction is currently running.')
  }

  clearTimeout(auction._timeout)
  const cancelled = auction
  auction = null

  // Refund the current top bidder, if any — they were escrowed.
  if (cancelled.bidderId) {
    await updatePlayer(ctx.db, cancelled.bidderId, p => {
      p.wallet = p.wallet ?? {}
      p.wallet.solars = (p.wallet.solars ?? 0) + cancelled.bid
      pushTxLog(p, {
        ref: genRef(), type: 'auction_refund', amount: cancelled.bid,
        note: `${cancelled.item.name} — auction cancelled`,
      })
      return p
    }).catch(() => {})
  }

  return reply(
    `🏛️ *Auction cancelled.*\n*${cancelled.item.name}* — no sale.` +
    (cancelled.bidderName ? `\n*${cancelled.bidderName}*'s bid of *${cancelled.bid.toLocaleString()} ☀️* has been refunded.` : ''),
  )
}

async function placeBid(ctx) {
  const { player, args, reply } = ctx
  const p = config.prefix

  if (!auction) {
    return reply(`❌ No auction is currently running. Check *${p}auction* for updates.`)
  }

  const amount = Math.floor(Number(args[0]))
  if (!amount || amount <= 0) {
    return reply(`❌ Usage: *${p}auction <amount>* — e.g. ${p}auction 25000`)
  }
  if (amount <= auction.bid) {
    return reply(`❌ Your bid must beat the current bid of *${auction.bid.toLocaleString()} ☀️*.`)
  }
  if (player.level < auction.item.levelReq) {
    return reply(`❌ *${auction.item.name}* requires Level *${auction.item.levelReq}* to bid on.`)
  }
  if ((player.wallet?.solars ?? 0) < amount) {
    return reply(`❌ You don't have *${amount.toLocaleString()} ☀️*. You have: ${(player.wallet?.solars ?? 0).toLocaleString()} ☀️.`)
  }
  if (auction.bidderId === player.id) {
    return reply(`⚠️ You're already the top bidder at *${auction.bid.toLocaleString()} ☀️*.`)
  }

  // Capture previous bidder before mutating the auction record.
  const prevBidderId   = auction.bidderId
  const prevBid        = auction.bid
  const prevBidderName = auction.bidderName

  // Escrow the new bid — deduct now so the balance is reserved. Re-check
  // affordability inside updatePlayer against the FRESH balance (the
  // ctx.player snapshot above could be stale if they spent solars elsewhere).
  let escrowed = false
  await updatePlayer(ctx.db, ctx.from, p2 => {
    p2.wallet = p2.wallet ?? {}
    const fresh = p2.wallet.solars ?? 0
    if (fresh < amount) {
      reply(`❌ Insufficient funds — you only have *${fresh.toLocaleString()} ☀️* right now.`).catch(() => {})
      return p2
    }
    p2.wallet.solars = Math.max(0, fresh - amount)
    pushTxLog(p2, {
      ref: genRef(), type: 'auction_bid', amount,
      note: `Bid on ${auction.item.name}`,
    })
    escrowed = true
    return p2
  }).catch(() => {})

  if (!escrowed) return // balance changed between pre-check and escrow — bail (error already sent)
  if (!auction) return  // auction was cancelled/closed while we were escrowing — extremely rare race, bail silently

  // Update the auction record
  auction.bid        = amount
  auction.bidderId   = player.id
  auction.bidderName = player.name

  // Refund the outbid player immediately
  if (prevBidderId && prevBidderId !== player.id) {
    await updatePlayer(ctx.db, prevBidderId, prev => {
      prev.wallet = prev.wallet ?? {}
      prev.wallet.solars = (prev.wallet.solars ?? 0) + prevBid
      pushTxLog(prev, {
        ref: genRef(), type: 'auction_outbid', amount: prevBid,
        note: `Outbid on ${auction.item.name} — refunded`,
      })
      return prev
    }).catch(() => {})
  }

  // Anti-snipe: bidding within the last minute extends the window by 1 min.
  const remaining = auction.endsAt - Date.now()
  if (remaining < 60_000) {
    auction.endsAt += 60_000
    clearTimeout(auction._timeout)
    auction._timeout = setTimeout(() => closeAuction(ctx), auction.endsAt - Date.now())
  }

  return reply(
    `✅ *Bid placed!*\n\n` +
    `🟥 *${auction.item.name}*\n` +
    `💰 New top bid: *${amount.toLocaleString()} ☀️* _(escrowed from your wallet)_\n` +
    `⏱️ Time left: *${humanRemaining(auction.endsAt - Date.now())}*\n\n` +
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
