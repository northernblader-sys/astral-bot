/**
 * plugins/expedition.js — Dispatch idle companions, cards, or beasts on timed expeditions.
 *
 * Players can send an owned beast or waifu card on an expedition while offline or doing tasks:
 *   - 1h: Quick Scout (Solars + common materials)
 *   - 4h: Dungeon Skirmish (Solars + cooking food + uncommon/rare materials)
 *   - 8h: Deep Astral Raid (Solars + gems + epic materials + chance of rare cards/loot)
 *
 * Usage:
 *   .expedition                  — check status of active expedition
 *   .expedition start <1h|4h|8h> — start an expedition
 *   .expedition claim            — collect rewards from completed expedition
 *   .expedition cancel           — cancel active expedition early
 */

import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { materials, food } from '../lib/game-data.js'
import { formatTimeLeft } from '../lib/time-format.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'

const EXPEDITION_DURATIONS = {
  '1h': {
    id: '1h',
    name: 'Quick Scout',
    durationMs: 1 * 60 * 60 * 1000,
    minSolars: 1500,
    maxSolars: 3500,
    gemChance: 0.1,
    matCount: 2,
    rarities: ['common'],
  },
  '4h': {
    id: '4h',
    name: 'Dungeon Skirmish',
    durationMs: 4 * 60 * 60 * 1000,
    minSolars: 6000,
    maxSolars: 15000,
    gemChance: 0.5,
    minGems: 1,
    maxGems: 3,
    matCount: 4,
    foodCount: 2,
    rarities: ['common', 'uncommon'],
  },
  '8h': {
    id: '8h',
    name: 'Deep Astral Raid',
    durationMs: 8 * 60 * 60 * 1000,
    minSolars: 15000,
    maxSolars: 35000,
    gemChance: 1.0,
    minGems: 3,
    maxGems: 8,
    matCount: 6,
    foodCount: 4,
    rarities: ['common', 'uncommon', 'rare', 'epic'],
  },
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pickRandomMaterial(allowedRarities) {
  const eligible = materials.filter(m => allowedRarities.includes(m.rarity || 'common'))
  if (!eligible.length) return materials[0]?.id || 'iron_ore'
  return eligible[Math.floor(Math.random() * eligible.length)].id
}

function pickRandomFood() {
  if (!food || !food.length) return 'wheat'
  return food[Math.floor(Math.random() * food.length)].id
}

export default {
  name: 'expedition',
  aliases: ['expeditions', 'exp'],
  category: 'rpg',
  requiresPlayer: true,
  description: 'Dispatch companions on timed expeditions to scavenge Solars, food & materials',
  subcommands: [
    { cmd: 'start <1h|4h|8h>', desc: 'send companions out on a timed expedition' },
    { cmd: 'claim', desc: 'claim rewards once the expedition completes' },
    { cmd: 'status', desc: 'check time remaining on active expedition' },
    { cmd: 'cancel', desc: 'cancel an ongoing expedition' },
  ],

  async run(ctx) {
    const p = config.prefix
    const sub = ctx.args[0]?.toLowerCase()

    if (!sub || sub === 'status') {
      return statusExpedition(ctx)
    }
    if (sub === 'start') {
      return startExpedition(ctx, ctx.args[1]?.toLowerCase())
    }
    if (sub === 'claim' || sub === 'collect') {
      return claimExpedition(ctx)
    }
    if (sub === 'cancel' || sub === 'abort') {
      return cancelExpedition(ctx)
    }

    return ctx.reply(
      `🏕️ *EXPEDITION SYSTEM*\n\n` +
      `Send idle party members & beasts on timed scouting missions:\n\n` +
      `*${p}expedition start 1h* — Quick Scout (1 hour)\n` +
      `*${p}expedition start 4h* — Dungeon Skirmish (4 hours)\n` +
      `*${p}expedition start 8h* — Deep Astral Raid (8 hours)\n\n` +
      `*${p}expedition status* — check progress\n` +
      `*${p}expedition claim* — collect loot`,
    )
  },
}

function statusExpedition(ctx) {
  const p = config.prefix
  const exp = ctx.player.activeExpedition
  if (!exp) {
    return ctx.reply(
      `🏕️ *No companions on expedition right now.*\n\n` +
      `Start one to gather Solars and rare crafting materials while offline:\n` +
      `> *${p}expedition start 1h*\n` +
      `> *${p}expedition start 4h*\n` +
      `> *${p}expedition start 8h*`,
    )
  }

  const def = EXPEDITION_DURATIONS[exp.durationId] || EXPEDITION_DURATIONS['1h']
  const now = Date.now()
  const timeLeft = exp.finishesAt - now

  if (timeLeft <= 0) {
    return ctx.reply(
      `🎉 *EXPEDITION COMPLETE!*\n\n` +
      `Your expedition *${def.name}* has returned loaded with loot!\n\n` +
      `Claim your rewards with:\n> *${p}expedition claim*`,
    )
  }

  return ctx.reply(
    `🏕️ *ACTIVE EXPEDITION: ${def.name.toUpperCase()}*\n\n` +
    `⏳ Time remaining: *${formatTimeLeft(timeLeft)}*\n` +
    `Expected returns: Solars, rare materials, cooking food, and gems.\n\n` +
    `_Check back when the timer finishes or cancel with *${p}expedition cancel*._`,
  )
}

async function startExpedition(ctx, durationId) {
  const p = config.prefix
  const def = EXPEDITION_DURATIONS[durationId]
  if (!def) {
    return ctx.reply(
      `❌ Choose a valid duration: *1h*, *4h*, or *8h*.\n` +
      `Example: *${p}expedition start 4h*`,
    )
  }

  if (ctx.player.activeExpedition) {
    const timeLeft = ctx.player.activeExpedition.finishesAt - Date.now()
    if (timeLeft > 0) {
      return ctx.reply(`⚠️ An expedition is already active! *${formatTimeLeft(timeLeft)}* remaining.`)
    } else {
      return ctx.reply(`🎉 Your last expedition finished! Claim it with *${p}expedition claim*.`)
    }
  }

  const now = Date.now()
  await updatePlayer(ctx.db, ctx.player.id, player => {
    player.activeExpedition = {
      durationId: def.id,
      startedAt: now,
      finishesAt: now + def.durationMs,
    }
  })

  return ctx.reply(
    `🏕️ *Companions deployed on ${def.name}!* \n\n` +
    `⏳ Expedition duration: *${def.id}*\n` +
    `They will scavenge Solars, food ingredients, and crafting materials while you rest.\n` +
    `Inspect progress with *${p}expedition status*.`,
  )
}

async function claimExpedition(ctx) {
  const p = config.prefix
  const exp = ctx.player.activeExpedition
  if (!exp) return ctx.reply(`❌ You have no active expedition to claim.`)

  const now = Date.now()
  if (exp.finishesAt > now) {
    return ctx.reply(`⏳ Expedition still in progress! *${formatTimeLeft(exp.finishesAt - now)}* remaining.`)
  }

  const def = EXPEDITION_DURATIONS[exp.durationId] || EXPEDITION_DURATIONS['1h']

  // Roll rewards
  const solarsAward = randInt(def.minSolars, def.maxSolars)
  let gemsAward = 0
  if (def.gemChance && Math.random() < def.gemChance) {
    gemsAward = randInt(def.minGems || 1, def.maxGems || 2)
  }

  const rewardedItems = []
  for (let i = 0; i < def.matCount; i++) {
    rewardedItems.push(pickRandomMaterial(def.rarities))
  }
  if (def.foodCount) {
    for (let i = 0; i < def.foodCount; i++) {
      rewardedItems.push(pickRandomFood())
    }
  }

  await updatePlayer(ctx.db, ctx.player.id, player => {
    const wallet = player.wallet ?? (player.wallet = {})
    wallet.solars = (wallet.solars || 0) + solarsAward
    if (gemsAward > 0) {
      wallet.gems = (wallet.gems || 0) + gemsAward
    }

    const inv = player.inventory ?? (player.inventory = [])
    for (const itemId of rewardedItems) {
      inv.push(itemId)
    }

    player.activeExpedition = null
  })

  const itemNames = rewardedItems.map(id => {
    const m = materials.find(x => x.id === id) || food.find(x => x.id === id)
    return m ? m.name : id
  })

  let rewardMsg = `☀️ *+${solarsAward.toLocaleString()} Solars*`
  if (gemsAward > 0) rewardMsg += `\n💎 *+${gemsAward} Gems*`
  rewardMsg += `\n📦 *Items Found:* ${itemNames.join(', ')}`

  return ctx.reply(
    `🎉 *EXPEDITION REWARDS CLAIMED!*\n\n` +
    `Your team returned victoriously from *${def.name}*!\n\n` +
    `${rewardMsg}\n\n` +
    `_Start your next journey anytime with *${p}expedition start <1h|4h|8h>*!_`,
  )
}

async function cancelExpedition(ctx) {
  const exp = ctx.player.activeExpedition
  if (!exp) return ctx.reply(`❌ No active expedition to cancel.`)

  await updatePlayer(ctx.db, ctx.player.id, player => {
    player.activeExpedition = null
  })

  return ctx.reply(`👋 Active expedition canceled. Your companions have returned to base camp.`)
}
