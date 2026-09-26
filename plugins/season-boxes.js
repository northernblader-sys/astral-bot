import { config } from '../config.js'
import { allItems } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getActiveSeason } from '../lib/season-engine.js'
import { hasInventoryRoom } from '../lib/inventory-limits.js'

const BOXES = {
  openiron: 'iron',
  opendiamond: 'diamond',
  openmythic: 'mythic',
}

function pickWeighted(pool) {
  const total = pool.reduce((sum, entry) => sum + Math.max(0, Number(entry.weight) || 0), 0)
  let roll = Math.random() * total
  for (const entry of pool) {
    roll -= Math.max(0, Number(entry.weight) || 0)
    if (roll <= 0) return entry
  }
  return pool[pool.length - 1]
}

function rewardName(reward) {
  if (reward.rewardType === 'solars') return `${reward.amount} Solars`
  if (reward.rewardType === 'gems') return `${reward.amount} Gems`
  return `${reward.amount ?? 1} × ${(allItems.find((item) => item.id === reward.itemId)?.name ?? reward.itemId)}`
}

export default {
  name: 'openiron',
  aliases: ['opendiamond', 'openmythic'],
  category: 'season',
  requiresPlayer: true,
  description: 'Open a Season 1 mystery box',

  async run(ctx) {
    const rarity = BOXES[ctx.cmd.toLowerCase()]
    const season = getActiveSeason(ctx.db)
    if (!season) return ctx.reply(`🌙 There is no active season right now.`)
    const boxId = `${rarity}_box`
    let outcome = null

    await updatePlayer(ctx.db, ctx.from, (player) => {
      const index = (player.inventory ?? []).indexOf(boxId)
      if (index < 0) {
        outcome = { reason: 'missing', boxId }
        return player
      }
      const reward = pickWeighted(season.mysteryBoxes?.[rarity] ?? [])
      if (!reward) {
        outcome = { reason: 'empty' }
        return player
      }
      const amount = Math.max(1, Number(reward.amount) || 1)
      if ((reward.rewardType === 'item' || reward.rewardType === 'weapon') && !hasInventoryRoom(player, amount)) {
        outcome = { reason: 'full' }
        return player
      }
      player.inventory.splice(index, 1)
      if (reward.rewardType === 'solars' || reward.rewardType === 'gems') {
        player.wallet = player.wallet ?? {}
        player.wallet[reward.rewardType] = (player.wallet[reward.rewardType] ?? 0) + amount
      } else {
        player.inventory.push(...Array.from({ length: amount }, () => reward.itemId))
      }
      outcome = { reason: 'ok', reward }
      return player
    })

    if (outcome.reason === 'missing') return ctx.reply(`❌ You do not have a *${outcome.boxId}*.`)
    if (outcome.reason === 'full') return ctx.reply(`❌ Your inventory is full. Make room before opening the box.`)
    if (outcome.reason === 'empty') return ctx.reply(`❌ This box has no configured pull table.`)
    return ctx.reply(`🎁 *${rarity.toUpperCase()} BOX OPENED!*\nYou pulled: *${rewardName(outcome.reward)}*`)
  },
}