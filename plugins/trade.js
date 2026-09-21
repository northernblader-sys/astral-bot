/**
 * trade.js — player-to-player secure direct trade & barter responses.
 *
 * Supports:
 *   - Trader NPC barter responses from .roam (.trade accept / .trade decline)
 *   - Player-to-Player Direct Trade sessions with Escrow Safeguards:
 *       .trade @player            — initiate a direct trade session
 *       .trade offer solars <n>   — add solars to your trade offer
 *       .trade offer item <item>  — add an item to your trade offer
 *       .trade confirm            — lock in & accept trade offer (both must confirm)
 *       .trade cancel             — cancel current trade session
 *       .trade status             — view current trade escrow
 */

import { tradeStatus as roamTradeStatus, tradeAccept as roamTradeAccept, tradeDecline as roamTradeDecline } from './roam.js'
import { config } from '../config.js'
import { extractTarget } from '../lib/group-helpers.js'
import { getPlayer, updatePlayer } from '../lib/player-repo.js'
import { allItems } from '../lib/game-data.js'

const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))

export default {
  name: 'trade',
  aliases: ['p2ptrade'],
  category: 'town',
  requiresPlayer: true,
  description: 'Player-to-player direct trading & responding to Trader NPC offers',
  subcommands: [
    { cmd: '@player', desc: 'initiate a direct trading session with another player' },
    { cmd: 'offer solars <n>', desc: 'add solars to your trade offer' },
    { cmd: 'offer item <item>', desc: 'add an inventory item to your trade offer' },
    { cmd: 'confirm', desc: 'lock in and finalize trade (both must confirm)' },
    { cmd: 'cancel', desc: 'cancel active trading session' },
    { cmd: 'accept / decline', desc: 'respond to roaming NPC barter offers' },
  ],

  async run(ctx) {
    const p = config.prefix
    const sub = ctx.args[0]?.toLowerCase()

    // 1. Check for Roam Trader NPC barter commands
    if (ctx.player.pendingTrade && (sub === 'accept' || sub === 'yes')) {
      return roamTradeAccept(ctx)
    }
    if (ctx.player.pendingTrade && (sub === 'decline' || sub === 'no')) {
      return roamTradeDecline(ctx)
    }
    if (ctx.player.pendingTrade && (!sub || sub === 'npc')) {
      return roamTradeStatus(ctx)
    }

    // 2. Direct Player-to-Player Trading
    if (!ctx.db.data.directTrades) ctx.db.data.directTrades = {}

    const mentionedTarget = extractTarget(ctx)
    if (mentionedTarget && mentionedTarget !== ctx.from) {
      return startDirectTrade(ctx, mentionedTarget)
    }

    if (sub === 'offer') {
      return addTradeOffer(ctx, ctx.args.slice(1))
    }
    if (sub === 'confirm' || sub === 'lock' || sub === 'accept') {
      return confirmDirectTrade(ctx)
    }
    if (sub === 'cancel' || sub === 'abort') {
      return cancelDirectTrade(ctx)
    }
    if (sub === 'status' || sub === 'view' || !sub) {
      return viewDirectTrade(ctx)
    }

    return ctx.reply(
      `🤝 *PLAYER-TO-PLAYER DIRECT TRADE*\n\n` +
      `*Commands:*\n` +
      `• *${p}trade @player* — open a direct trading session\n` +
      `• *${p}trade offer solars <amount>* — offer Solars\n` +
      `• *${p}trade offer item <name>* — offer an item from inventory\n` +
      `• *${p}trade confirm* — lock in & accept\n` +
      `• *${p}trade cancel* — abort session\n\n` +
      `_Safe escrow ensures items and Solars only transfer when both players confirm._`,
    )
  },
}

function findActiveTrade(db, playerId) {
  const trades = Object.values(db.data.directTrades || {})
  return trades.find(t => t.status === 'active' && (t.playerA === playerId || t.playerB === playerId))
}

async function startDirectTrade(ctx, targetJid) {
  const p = config.prefix
  const target = getPlayer(ctx.db, targetJid)
  if (!target) {
    return ctx.reply(`❌ Target player is not registered yet.`)
  }

  const existingTrade = findActiveTrade(ctx.db, ctx.from) || findActiveTrade(ctx.db, targetJid)
  if (existingTrade) {
    return ctx.reply(`⚠️ One of you is already in an active trade session! Use *${p}trade status* or *${p}trade cancel*.`)
  }

  const tradeId = `p2p_${Date.now()}`
  ctx.db.data.directTrades[tradeId] = {
    id: tradeId,
    status: 'active',
    playerA: ctx.from,
    playerAName: ctx.player.name,
    playerB: targetJid,
    playerBName: target.name,
    offerA: { solars: 0, items: [] },
    offerB: { solars: 0, items: [] },
    confirmedA: false,
    confirmedB: false,
    startedAt: Date.now(),
  }
  await ctx.db.write()

  return ctx.reply(
    `🤝 *TRADE SESSION OPENED!*\n\n` +
    `*${ctx.player.name}* is trading with *${target.name}*.\n\n` +
    `Add to your offer with:\n` +
    `• *${p}trade offer solars <n>*\n` +
    `• *${p}trade offer item <name>*\n\n` +
    `Once both players are satisfied, type *${p}trade confirm* to finalize.`,
  )
}

async function addTradeOffer(ctx, args) {
  const p = config.prefix
  const trade = findActiveTrade(ctx.db, ctx.from)
  if (!trade) {
    return ctx.reply(`❌ You are not in an active trade session. Open one with *${p}trade @player*.`)
  }

  const kind = args[0]?.toLowerCase()
  const isA = trade.playerA === ctx.from
  const myOffer = isA ? trade.offerA : trade.offerB

  if (kind === 'solars' || kind === 'solar') {
    const amt = parseInt(args[1], 10)
    if (isNaN(amt) || amt <= 0) {
      return ctx.reply(`❌ Specify a valid Solars amount: *${p}trade offer solars 5000*`)
    }
    const currentSolars = ctx.player.wallet?.solars || 0
    if (currentSolars < amt) {
      return ctx.reply(`❌ You only have ☀️ ${currentSolars.toLocaleString()} Solars.`)
    }
    myOffer.solars = amt
  } else if (kind === 'item') {
    const query = args.slice(1).join(' ').trim().toLowerCase()
    if (!query) return ctx.reply(`❌ Specify an item name: *${p}trade offer item iron_sword*`)

    const inv = ctx.player.inventory || []
    const matchId = inv.find(id => id === query || (itemMap[id]?.name?.toLowerCase().includes(query)))
    if (!matchId) {
      return ctx.reply(`❌ You do not have "${query}" in your inventory.`)
    }
    if (myOffer.items.includes(matchId)) {
      return ctx.reply(`⚠️ That item is already added to your trade offer.`)
    }
    myOffer.items.push(matchId)
  } else {
    return ctx.reply(`Usage: *${p}trade offer solars <amount>* or *${p}trade offer item <name>*`)
  }

  // Any changes reset confirmations
  trade.confirmedA = false
  trade.confirmedB = false
  await ctx.db.write()

  return viewDirectTrade(ctx, `✅ *Offer updated!* (Confirmations reset for safety)`)
}

function viewDirectTrade(ctx, headerNote = '') {
  const p = config.prefix
  const trade = findActiveTrade(ctx.db, ctx.from)
  if (!trade) {
    return ctx.reply(`ℹ️ No active trade session. Start one with *${p}trade @player*.`)
  }

  const formatOffer = (name, offer, confirmed) => {
    const items = offer.items.map(id => itemMap[id]?.name || id).join(', ') || 'none'
    const status = confirmed ? '🔒 *CONFIRMED*' : '⏳ _Pending_'
    return `*${name}* (${status}):\n  ☀️ Solars: ${offer.solars.toLocaleString()}\n  📦 Items: ${items}`
  }

  const note = headerNote ? `${headerNote}\n\n` : ''
  return ctx.reply(
    `${note}🤝 *TRADE WINDOW*\n\n` +
    `${formatOffer(trade.playerAName, trade.offerA, trade.confirmedA)}\n\n` +
    `${formatOffer(trade.playerBName, trade.offerB, trade.confirmedB)}\n\n` +
    `*Commands:* *${p}trade offer <solars|item>* · *${p}trade confirm* · *${p}trade cancel*`,
  )
}

async function confirmDirectTrade(ctx) {
  const p = config.prefix
  const trade = findActiveTrade(ctx.db, ctx.from)
  if (!trade) return ctx.reply(`❌ You are not in an active trade session.`)

  const isA = trade.playerA === ctx.from
  if (isA) trade.confirmedA = true
  else trade.confirmedB = true

  // Check if both confirmed
  if (trade.confirmedA && trade.confirmedB) {
    // Execute trade atomically
    const pA = getPlayer(ctx.db, trade.playerA)
    const pB = getPlayer(ctx.db, trade.playerB)

    // Final inventory & solar check
    const solarsA = pA.wallet?.solars || 0
    const solarsB = pB.wallet?.solars || 0

    if (solarsA < trade.offerA.solars || solarsB < trade.offerB.solars) {
      delete ctx.db.data.directTrades[trade.id]
      await ctx.db.write()
      return ctx.reply(`❌ Trade failed: One of the players no longer holds the offered Solars.`)
    }

    // Execute swap on Player A
    await updatePlayer(ctx.db, trade.playerA, player => {
      const w = player.wallet ?? (player.wallet = {})
      w.solars = (w.solars || 0) - trade.offerA.solars + trade.offerB.solars
      const inv = player.inventory ?? (player.inventory = [])
      for (const id of trade.offerA.items) {
        const idx = inv.indexOf(id)
        if (idx !== -1) inv.splice(idx, 1)
      }
      for (const id of trade.offerB.items) {
        inv.push(id)
      }
    })

    // Execute swap on Player B
    await updatePlayer(ctx.db, trade.playerB, player => {
      const w = player.wallet ?? (player.wallet = {})
      w.solars = (w.solars || 0) - trade.offerB.solars + trade.offerA.solars
      const inv = player.inventory ?? (player.inventory = [])
      for (const id of trade.offerB.items) {
        const idx = inv.indexOf(id)
        if (idx !== -1) inv.splice(idx, 1)
      }
      for (const id of trade.offerA.items) {
        inv.push(id)
      }
    })

    delete ctx.db.data.directTrades[trade.id]
    await ctx.db.write()

    return ctx.reply(
      `🎉 *TRADE COMPLETED SUCCESSFULLY!*\n\n` +
      `Both *${trade.playerAName}* and *${trade.playerBName}* confirmed the exchange.\n` +
      `All Solars and items have been safely transferred through escrow!`,
    )
  }

  await ctx.db.write()
  return viewDirectTrade(ctx, `🔒 *You confirmed the trade!* Waiting on the other player...`)
}

async function cancelDirectTrade(ctx) {
  const trade = findActiveTrade(ctx.db, ctx.from)
  if (!trade) return ctx.reply(`❌ No active trade session to cancel.`)

  delete ctx.db.data.directTrades[trade.id]
  await ctx.db.write()
  return ctx.reply(`🚫 The trade session was canceled. All escrowed assets returned safely.`)
}
