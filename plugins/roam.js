/**
 * roam.js — walk the streets of Astral Town and see who you run into.
 *
 * Commands:
 *   .roam           — wander town, roll a random NPC encounter (5 min cooldown)
 *   .trade          — view your currently offered barter (if a Trader NPC appeared)
 *   .trade accept   — accept the current barter
 *   .trade decline  — walk away from the offer
 *
 * Design notes:
 *  - Only usable while in Astral Town (or another safe, non-dungeon location)
 *    and only when not in battle — roam is a town/social activity, not a
 *    combat shortcut.
 *  - Five NPC "types" can appear: Musician, Dancer, Storyteller, Wanderer,
 *    and Trader. The first four are flavor encounters that each still do
 *    something concrete — a small Solars find, a Fame tick, a stat-relevant
 *    consumable, or a bit of bonus XP — so roaming is never a dead end, just
 *    smaller and more frequent than a real dungeon reward.
 *  - Traders open a genuine item-for-item barter pulled from data/trades.json
 *    (42 hand-written offers, gated by player level, occasionally a "lucky"
 *    rare-tier deal). This is deliberately separate from .shop — no Solars
 *    change hands, it's pure barter, and it's the only way to get certain
 *    early materials without grinding a specific dungeon floor for them.
 *  - A barter offer is held on the player record until accepted, declined,
 *    or replaced by the next .roam — it does not expire on its own so a
 *    player can go check their inventory before deciding.
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { locationsMap, allItems, levelsData, classes, races, getTotalStats } from '../lib/game-data.js'
import { applyLevelUps } from '../lib/combat-engine.js'
import { getFameTier, formatFame } from '../lib/fame-engine.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import tradesData from '../data/trades.json' with { type: 'json' }

const ROAM_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

const RARITY_EMOJI = { common: '⬜', uncommon: '🟩', rare: '🟦', epic: '🟪', legendary: '🟨', lucky: '✨' }

function itemName(id) {
  return allItems.find(i => i.id === id)?.name ?? id
}

function randInt(lo, hi) { return Math.floor(Math.random() * (hi - lo + 1)) + lo }

// ── NPC flavor pools ──────────────────────────────────────────────────────

const MUSICIANS = [
  { name: 'Fenn the Fiddler', line: 'plays a lively jig that turns a few heads on Market Row.' },
  { name: 'Old Baritone Sol', line: 'hums a low, warm tune that quiets the whole street for a moment.' },
  { name: 'Wisp', line: 'plucks a lute with fingers too fast to follow, drawing a small crowd.' },
]

const DANCERS = [
  { name: 'Reyna', line: 'spins through the square in a blur of ribbons, grinning the whole time.' },
  { name: 'The Masked Twins', line: 'perform a mirrored routine so precise it draws applause from strangers.' },
  { name: 'Old Tomas', line: 'shows off a dance from before the Shattering — clumsy, but everyone claps anyway.' },
]

const STORYTELLERS = [
  { name: 'Auntie Vell', line: 'tells a story about the first adventurer to fall from the entry tower and climb back out.' },
  { name: 'The Blind Chronicler', line: 'recounts the founding of Astral Town from memory, word for word, as always.' },
  { name: 'Young Perrin', line: 'swears — again — that they saw a dungeon boss wandering the market at midnight.' },
]

const WANDERERS = [
  { name: 'A tired courier', line: 'nods at you and keeps walking, dropping a stray coin without noticing.' },
  { name: 'A guild scout', line: 'sizes you up, mutters something about your gear, and moves on.' },
  { name: 'An off-duty guard', line: 'is arguing with a merchant about the price of bread. You leave them to it.' },
]

// ── .roam ──────────────────────────────────────────────────────────────
async function roam(ctx) {
  const p = config.prefix

  await updatePlayer(ctx.db, ctx.from, async player => {
    if (player.inBattle) { await ctx.reply(`⚠️ You can't roam mid-battle!`); return player }
    if (player.inDungeon) { await ctx.reply(`⚠️ You're deep in a dungeon — no roaming here. Use *${p}dungeon leave* first.`); return player }

    const loc = locationsMap[player.location]
    if (!loc || loc.type !== 'town') {
      await ctx.reply(`❌ You can only roam in a town. You're currently at *${loc?.name ?? player.location}*.`)
      return player
    }

    const now = Date.now()
    const nextAvailable = player.lastRoamAt ? player.lastRoamAt + ROAM_COOLDOWN_MS : 0
    if (now < nextAvailable) {
      const mins = Math.ceil((nextAvailable - now) / 60000)
      await ctx.reply(`🚶 *Still out and about.* You can roam again in *${mins} min*.`)
      return player
    }
    player.lastRoamAt = now

    // Roll encounter type: 15% each for musician/dancer/storyteller/wanderer, 40% trader.
    const roll = Math.random()
    let msg

    if (roll < 0.15) {
      msg = await encounterMusician(player)
    } else if (roll < 0.30) {
      msg = await encounterDancer(player)
    } else if (roll < 0.45) {
      msg = await encounterStoryteller(player)
    } else if (roll < 0.60) {
      msg = await encounterWanderer(player)
    } else {
      msg = await encounterTrader(ctx, player)
    }

    await ctx.reply(msg)
    return player
  })
}

async function encounterMusician(player) {
  const npc = MUSICIANS[Math.floor(Math.random() * MUSICIANS.length)]
  const solars = randInt(3, 10)
  player.wallet.solars = (player.wallet.solars ?? 0) + solars
  return (
    `🎵 *${npc.name}* ${npc.line}\n\n` +
    `You toss a few coins in the case — someone tosses one back for good luck.\n` +
    `☀️ *+${solars} solars*`
  )
}

async function encounterDancer(player) {
  const npc = DANCERS[Math.floor(Math.random() * DANCERS.length)]
  const gained = randInt(2, 6)
  const prevTier = getFameTier(player.fame || 0)
  player.fame = (player.fame || 0) + gained
  const newTier = getFameTier(player.fame)
  const tierChanged = newTier.label !== prevTier.label
  const fameLine = `\n🌟 *+${gained} Fame* _(${formatFame(player.fame)} total)_` +
    (tierChanged ? `\n🎭 *FAME UP!* You're now *${newTier.label}* ${newTier.emoji}` : '')
  return (
    `💃 *${npc.name}* ${npc.line}\n\n` +
    `A few onlookers mention your name to each other, impressed you stopped to watch.` +
    fameLine
  )
}

async function encounterStoryteller(player) {
  const npc = STORYTELLERS[Math.floor(Math.random() * STORYTELLERS.length)]
  const xp = randInt(5, 15)
  player.xp = (player.xp ?? 0) + xp
  // Roaming XP has to be able to level too — player.xp is cumulative, so
  // granting it without this leaves the level owed but never applied.
  const lvl = applyLevelUps(player, levelsData, classes, races, getTotalStats)
  return (
    `📖 *${npc.name}* ${npc.line}\n\n` +
    `Something in the story sticks with you — a lesson learned secondhand.\n` +
    `✨ *+${xp} XP*` +
    (lvl.msgs.length ? `\n\n${lvl.msgs.join('\n')}` : '')
  )
}

async function encounterWanderer(player) {
  const npc = WANDERERS[Math.floor(Math.random() * WANDERERS.length)]
  const solars = randInt(1, 5)
  player.wallet.solars = (player.wallet.solars ?? 0) + solars
  return (
    `🚶 ${npc.name} ${npc.line}\n\n` +
    `☀️ *+${solars} solars* _(found on the ground)_`
  )
}

async function encounterTrader(ctx, player) {
  const p = config.prefix
  const eligible = tradesData.filter(t => (t.minLevel ?? 1) <= player.level)
  if (!eligible.length) {
    return `🧳 A trader eyes your gear from a distance but doesn't approach — you're not experienced enough yet.`
  }

  // Lucky-tier trades are rare — 5% chance to roll from that pool if any qualify.
  const luckyPool = eligible.filter(t => t.rare)
  const normalPool = eligible.filter(t => !t.rare)
  const pool = (luckyPool.length && Math.random() < 0.05) ? luckyPool : (normalPool.length ? normalPool : eligible)
  const trade = pool[Math.floor(Math.random() * pool.length)]

  player.pendingTrade = trade.id

  const giveText = trade.give.map(g => `${g.qty}x *${itemName(g.itemId)}*`).join(' + ')
  const wantText = trade.want.map(w => `${w.qty}x *${itemName(w.itemId)}*`).join(' + ')
  const rarityTag = RARITY_EMOJI[trade.tier] ?? ''

  return (
    `🧳 *${trade.traderName}* stops you in the street. ${rarityTag}\n\n` +
    `_${trade.flavor}_\n\n` +
    `*Offering:* ${giveText}\n` +
    `*Wants:* ${wantText}\n\n` +
    `*${p}trade accept* — take the deal\n` +
    `*${p}trade decline* — walk away`
  )
}

// ── .trade / .trade accept / .trade decline ──────────────────────────────
async function tradeStatus(ctx) {
  const p = config.prefix
  const player = getPlayer(ctx.db, ctx.from)
  if (!player) return ctx.reply(`❌ Not registered.`)
  if (!player.pendingTrade) {
    return ctx.reply(`❌ No active barter offer. Use *${p}roam* to explore town and see who you meet.`)
  }
  const trade = tradesData.find(t => t.id === player.pendingTrade)
  if (!trade) {
    return ctx.reply(`❌ That offer is no longer available.`)
  }
  const giveText = trade.give.map(g => `${g.qty}x *${itemName(g.itemId)}*`).join(' + ')
  const wantText = trade.want.map(w => `${w.qty}x *${itemName(w.itemId)}*`).join(' + ')
  await ctx.reply(
    `🧳 *${trade.traderName}*\n\n_${trade.flavor}_\n\n` +
    `*Offering:* ${giveText}\n*Wants:* ${wantText}\n\n` +
    `*${p}trade accept* · *${p}trade decline*`,
  )
}

async function tradeAccept(ctx) {
  const p = config.prefix
  await updatePlayer(ctx.db, ctx.from, async player => {
    if (!player.pendingTrade) {
      await ctx.reply(`❌ No active barter offer. Use *${p}roam* first.`)
      return player
    }
    const trade = tradesData.find(t => t.id === player.pendingTrade)
    if (!trade) {
      player.pendingTrade = null
      await ctx.reply(`❌ That offer is no longer available.`)
      return player
    }

    const inv = player.inventory ?? []
    for (const w of trade.want) {
      const owned = inv.filter(id => id === w.itemId).length
      if (owned < w.qty) {
        await ctx.reply(
          `❌ You don't have enough for this trade.\n` +
          `Need: *${w.qty}x ${itemName(w.itemId)}* _(you have ${owned})_`,
        )
        return player
      }
    }

    // Net slot change: items given by the trader minus items the player
    // hands over. Only block if the trade would net-increase inventory
    // beyond the player's cap.
    const wantQty = trade.want.reduce((sum, w) => sum + w.qty, 0)
    const giveQty = trade.give.reduce((sum, g) => sum + g.qty, 0)
    const netChange = giveQty - wantQty
    if (netChange > 0 && !hasInventoryRoom(player, netChange)) {
      await ctx.reply(
        `❌ Not enough room for this trade.\n` +
        `${inventoryFullMessage(player)}`,
      )
      return player
    }

    // Remove wanted items
    for (const w of trade.want) {
      let removed = 0
      player.inventory = player.inventory.filter(id => {
        if (id === w.itemId && removed < w.qty) { removed++; return false }
        return true
      })
    }
    // Add given items
    for (const g of trade.give) {
      for (let i = 0; i < g.qty; i++) player.inventory.push(g.itemId)
    }
    player.pendingTrade = null

    const giveText = trade.give.map(g => `${g.qty}x *${itemName(g.itemId)}*`).join(' + ')
    const wantText = trade.want.map(w => `${w.qty}x *${itemName(w.itemId)}*`).join(' + ')
    await ctx.reply(
      `┌─────────────────────┐\n│   🤝 *DEAL MADE*   │\n└─────────────────────┘\n\n` +
      `You handed over ${wantText}\n` +
      `*${trade.traderName}* handed over ${giveText}\n\n` +
      `_"Pleasure doing business."_`,
    )
    return player
  })
}

async function tradeDecline(ctx) {
  await updatePlayer(ctx.db, ctx.from, async player => {
    if (!player.pendingTrade) {
      await ctx.reply(`❌ No active barter offer to decline.`)
      return player
    }
    player.pendingTrade = null
    await ctx.reply(`🚶 You wave them off and keep walking.`)
    return player
  })
}

// ── Plugin exports ─────────────────────────────────────────────────────────
export default {
  name: 'roam',
  aliases: ['explore', 'walk'],
  category: 'town',
  requiresPlayer: true,
  description: 'Wander Astral Town and see who you meet',

  async run(ctx) {
    return roam(ctx)
  },
}

export { tradeStatus, tradeAccept, tradeDecline }
