/**
 * auction.js — Astral Auction House (single global auction model).
 *
 * ONE auction runs realm-wide at a time. The owner starts it from any group
 * chat by naming ANYTHING the game has an id for — mythic auction gear,
 * ordinary equipment, a character, a pet, or a summon (beast) — plus a
 * starting bid and a duration. What can be sold and how each kind reaches
 * the winner lives in lib/auction-lots.js; this file only runs the auction. Anyone, from ANY group chat the bot is
 * in, can then bid — bidding is global, not tied to where the auction was
 * started. When the timer runs out, the bot returns to the ORIGINAL
 * starting group and @tags the winner there to announce them.
 *
 * Usage:
 *   .auction start <id> <startbid> <duration>       — owner only. <id> is
 *                                                       an item, character,
 *                                                       pet or beast id, or
 *                                                       a name. Prefix with
 *                                                       a kind to
 *                                                       disambiguate:
 *                                                       pet:shadow_cat.
 *                                                       Duration is a number
 *                                                       + unit, e.g. 30m/2h.
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
import { resolveAuctionLot, describeLot, kindLabel, exampleIds } from '../lib/auction-lots.js'
import { pushTxLog, genRef } from '../lib/astralpay.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { sendImageTo } from '../lib/image.js'

const MIN_DURATION_MS = 60_000                 // 1 minute
const MAX_DURATION_MS = 24 * 60 * 60_000       // 24 hours, sanity cap

const soldHistory = [] // { itemName, buyerName, price, at }

// The single global auction, or null if none is running.
// { item, bid, bidderId, bidderName, endsAt, startJid, _timeout }
let auction = null

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
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `_Nothing under the hammer right now._\n\n` +
      `*How it works*\n` +
      `  ▸ One auction runs at a time, realm-wide.\n` +
      `  ▸ Anyone can bid from any group the bot is in.\n` +
      `  ▸ Gear, characters, pets and summons all go up here.\n\n` +
      `  ▸ *${p}auction* — see the current lot\n` +
      `  ▸ *${p}auction <amount>* — bid\n` +
      `  ▸ *${p}auction history* — recent sales`
    )
  }

  const lot = auction.lot
  return (
    `🏛️ *ASTRAL AUCTION HOUSE*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${describeLot(lot)}\n` +
    (lot.description ? `_${lot.description}_\n` : '') +
    `\n` +
    `💰 Current bid: *${auction.bid.toLocaleString()} ☀️*` +
    (auction.bidderName ? `\n🥇 Top bidder: *${auction.bidderName}*` : `\n🥇 No bids yet — the floor is open`) + `\n` +
    `⏱️ Time left: *${humanRemaining(auction.endsAt - Date.now())}*\n\n` +
    `*To bid:* *${p}auction <amount>* — e.g. *${p}auction ${(auction.bid + 1000).toLocaleString('en-US').replace(/,/g, '')}*\n` +
    `_Your bid is held from your wallet and refunded the moment someone outbids you. ` +
    `You only pay if you win. A bid in the last minute adds another minute._`
  )
}

async function closeAuction(ctx) {
  const closing = auction
  if (!closing) return
  auction = null // free the slot immediately so a new one can start

  const lot = closing.lot

  if (!closing.bidderId) {
    remember({ lot, buyerName: null, price: 0 })
    try {
      await ctx.sock.sendMessage(closing.startJid, {
        text:
          `🏛️ *AUCTION CLOSED — NO SALE*\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `*${lot.name}* went unsold. Nobody bid.\n\n` +
          `_Better luck to the next lot — watch for *${config.prefix}auction*._`,
      })
    } catch {}
    return
  }

  // The winning bid was escrowed when it was placed, so settlement only has
  // to hand the thing over. Each kind knows where it goes (lib/auction-lots.js);
  // if it can't be delivered — full bag, duplicate character — the bid is
  // refunded in the same mutation and the lot goes unsold.
  let outcome = 'pending'
  let failReason = ''
  let note = ''
  await updatePlayer(ctx.db, closing.bidderId, player => {
    player.wallet = player.wallet ?? {}
    const result = lot.grant(player)
    if (!result.ok) {
      player.wallet.solars = (player.wallet.solars ?? 0) + closing.bid
      pushTxLog(player, {
        ref: genRef(), type: 'auction_refund', amount: closing.bid,
        note: `${lot.name} — ${result.reason}`,
      })
      outcome = 'undeliverable'
      failReason = result.reason
      return player
    }
    note = result.note ?? ''
    pushTxLog(player, {
      ref: genRef(), type: 'auction_win', amount: closing.bid,
      note: lot.name,
    })
    outcome = 'sold'
    return player
  }).catch(() => { outcome = 'error' })

  const bareWinner = String(closing.bidderId).replace(/@.*$/, '')

  if (outcome === 'undeliverable') {
    remember({ lot, buyerName: null, price: 0 })
    try {
      await ctx.sock.sendMessage(closing.startJid, {
        text:
          `🏛️ *AUCTION CLOSED — SALE FAILED*\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `*${lot.name}* would have gone to @${bareWinner} for *${closing.bid.toLocaleString()} ☀️*, ` +
          `but ${failReason}.\n` +
          `☀️ *${closing.bid.toLocaleString()}* refunded in full — the lot goes unsold.`,
        mentions: [closing.bidderId],
      })
    } catch {}
    return
  }

  if (outcome === 'sold') {
    remember({ lot, buyerName: closing.bidderName, price: closing.bid })
    try {
      await ctx.sock.sendMessage(closing.startJid, {
        text:
          `🏛️ *SOLD!* 🎉\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `${describeLot(lot)}\n\n` +
          `🥇 Winner: @${bareWinner}\n` +
          `💰 Hammer price: *${closing.bid.toLocaleString()} ☀️*\n\n` +
          `${claimHint(lot)}` +
          (note ? `\n_${note}_` : ''),
        mentions: [closing.bidderId],
      })
    } catch {}
  }
}

/** Where the winner will find what they just bought. */
function claimHint(lot) {
  const p = config.prefix
  switch (lot.kind) {
    case 'character': return `_It's in your collection — equip it with *${p}character equip ${lot.id}*._`
    case 'pet':       return `_It's yours — bring it out with *${p}pet equip ${lot.id}*._`
    case 'beast':     return `_Added to your summons — check *${p}summon*._`
    default:          return `_It's in your bag — see *${p}inventory*, equip with *${p}equip ${lot.id}*._`
  }
}

function remember(entry) {
  soldHistory.unshift({
    itemId: entry.lot.id,
    itemName: entry.lot.name,
    kind: entry.lot.kind,
    buyerName: entry.buyerName,
    price: entry.price,
    at: Date.now(),
  })
  if (soldHistory.length > 20) soldHistory.length = 20
}

export default {
  name:           'auction',
  aliases:        ['ah', 'auctionhouse'],
  category:       'economy',
  requiresPlayer: true,
  description:    'One global auction at a time — gear, characters, pets or summons. Owner starts it, anyone bids from any group.',
  subcommands: [
    { cmd: '(no args)', desc: 'show the current lot, the top bid and how bidding works' },
    { cmd: '<amount>', desc: 'bid on the running lot from any group, e.g. .auction 25000' },
    { cmd: 'history', desc: 'the last few lots and what they sold for' },
    { cmd: 'start <id> <startbid> <duration>', desc: 'owner — open a lot. <id> is any item, character, pet or beast, e.g. .auction start mei 40000 2h' },
    { cmd: 'cancel', desc: 'owner — cancel the running lot and refund the top bid' },
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
  const ex = exampleIds()

  if (!from || !isOwnerJid(from)) {
    return reply('❌ Owner only.')
  }

  if (auction) {
    return reply(
      `❌ An auction is already running — *${auction.lot.name}* at *${auction.bid.toLocaleString()} ☀️*.\n` +
      `_Wait for it to close, or use *${p}auction cancel* first._`,
    )
  }

  // The id can contain no spaces, so everything between the id and the last
  // two args is treated as part of a quoted-free name: `.auction start
  // ember hatchling 5000 1h` works as well as `.auction start ember_hatchling
  // 5000 1h`.
  const rest = args.slice(1)
  const durationMs = parseDuration(rest[rest.length - 1])
  const startBid   = Math.floor(Number(rest[rest.length - 2]))
  const query      = rest.slice(0, -2).join(' ')

  const usage =
    `❌ *Usage:* *${p}auction start <id> <startbid> <duration>*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Anything with an id can go up: equipment, characters, pets, summons.\n\n` +
    `  ▸ *${p}auction start ${ex.item} 18000 2h* — gear\n` +
    `  ▸ *${p}auction start ${ex.character} 40000 3h* — character\n` +
    `  ▸ *${p}auction start ${ex.pet} 5000 30m* — pet\n` +
    `  ▸ *${p}auction start ${ex.beast} 9000 1h* — summon\n\n` +
    `_Duration is m or h, 1m to 24h. If two things share a name, force the ` +
    `kind: *pet:${ex.pet}*, *character:${ex.character}*, *beast:${ex.beast}*._`

  if (!query || !startBid || startBid <= 0 || !durationMs) return reply(usage)

  const lot = resolveAuctionLot(query)
  if (!lot) {
    return reply(
      `❌ Nothing called *"${query}"* in any catalog — checked auction gear, ` +
      `equipment, characters, pets and summons.\n\n${usage}`,
    )
  }

  auction = {
    lot,
    bid: startBid,
    bidderId: null,
    bidderName: null,
    endsAt: Date.now() + durationMs,
    startJid: ctx.sender, // the group where it started — the winner is announced back here
    _timeout: null,
  }
  auction._timeout = setTimeout(() => closeAuction(ctx), durationMs)

  const caption =
    `🏛️ *AUCTION OPEN* — ${kindLabel(lot.kind)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${describeLot(lot)}\n` +
    (lot.description ? `_${lot.description}_\n` : '') +
    `\n` +
    `💰 Opening bid: *${startBid.toLocaleString()} ☀️*\n` +
    `⏱️ Closes in: *${humanRemaining(durationMs)}*\n\n` +
    `*Bid from any group:* *${p}auction <amount>*\n` +
    `_Bids are held from your wallet and refunded instantly if you're outbid. ` +
    `You only pay if you win. A bid in the final minute extends the clock by one._`

  if (lot.image) {
    return sendImageTo(ctx, lot.image, caption, ctx.sender)
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
        note: `${cancelled.lot.name} — auction cancelled`,
      })
      return p
    }).catch(() => {})
  }

  return reply(
    `🏛️ *Auction cancelled.*\n*${cancelled.lot.name}* — no sale.` +
    (cancelled.bidderName ? `\n*${cancelled.bidderName}*'s bid of *${cancelled.bid.toLocaleString()} ☀️* has been refunded.` : ''),
  )
}

async function placeBid(ctx) {
  const { player, args, reply } = ctx
  const p = config.prefix

  if (!auction) {
    return reply(
      `❌ No auction is running right now.\n` +
      `_Run *${p}auction* to see the house, or *${p}auction history* for recent sales._`,
    )
  }

  const amount = Math.floor(Number(args[0]))
  if (!amount || amount <= 0) {
    return reply(`❌ Usage: *${p}auction <amount>* — e.g. ${p}auction 25000`)
  }
  if (amount <= auction.bid) {
    return reply(`❌ Your bid must beat the current bid of *${auction.bid.toLocaleString()} ☀️*.`)
  }
  if (player.level < (auction.lot.levelReq ?? 1)) {
    return reply(
      `❌ *${auction.lot.name}* is for Level *${auction.lot.levelReq}* and up. _You're Level ${player.level}._`,
    )
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
      note: `Bid on ${auction.lot.name}`,
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
        note: `Outbid on ${auction.lot.name} — refunded`,
      })
      return prev
    }).catch(() => {})

    ctx.sock.sendMessage(prevBidderId, {
      text:
        `🏛️ *Outbid on ${auction.lot.name}*\n` +
        `*${player.name}* went to *${amount.toLocaleString()} ☀️*.\n` +
        `☀️ Your *${prevBid.toLocaleString()}* is already back in your wallet.\n\n` +
        `_Take it back with *${config.prefix}auction <higher amount>* — ` +
        `${humanRemaining(auction.endsAt - Date.now())} left._`,
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
    `✅ *Bid placed — you're top bidder.*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${describeLot(auction.lot)}\n\n` +
    `💰 Your bid: *${amount.toLocaleString()} ☀️* _(held from your wallet)_\n` +
    `⏱️ Closes in: *${humanRemaining(auction.endsAt - Date.now())}*\n\n` +
    `_Refunded in full the second someone outbids you. ${claimHint(auction.lot)}_` +
    (prevBidderName ? `\n_${prevBidderName} has been refunded._` : '')
  )
}

async function showHistory(ctx) {
  const { reply } = ctx
  const p = config.prefix
  if (!soldHistory.length) {
    return reply(
      `🏛️ *AUCTION HISTORY*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `_Nothing has come under the hammer yet._`,
    )
  }
  const lines = soldHistory.slice(0, 10).map(h => {
    const tag = kindLabel(h.kind ?? 'item').split(' ')[0]
    return h.buyerName
      ? `${tag} *${h.itemName}* → *${h.buyerName}* · ${h.price.toLocaleString()} ☀️`
      : `${tag} *${h.itemName}* · unsold`
  })
  return reply(
    `🏛️ *AUCTION HISTORY*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${lines.join('\n')}\n\n` +
    `_Last ${lines.length} lot${lines.length === 1 ? '' : 's'}. Current lot: *${p}auction*._`
  )
}
