/**
 * <prefix>equip <item id or partial name>  (alias: attune)
 * Equips a non-consumable item from inventory into its matching slot.
 * If the slot is already occupied, the old item is returned to inventory
 * first. Equipping/unequipping folds the item's statBonuses in/out of
 * player.stats (and maxHp/maxMp) directly.
 */

import { config } from '../config.js'
import { allItems } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { applyEquipmentBonus } from '../lib/combat-engine.js'
import { initDurability, clearDurability } from '../lib/durability.js'

const itemMap = Object.fromEntries(allItems.map((i) => [i.id, i]))

/** Find first matching item id in the player's inventory (exact id or partial name). */
function findInInventory(inventory, query) {
  const q = query.toLowerCase()
  // Exact id match.
  if (inventory.includes(q)) return q
  // Partial name match.
  for (const id of inventory) {
    const item = itemMap[id]
    if (item && item.name.toLowerCase().includes(q)) return id
  }
  return null
}

export default {
  name: 'equip',
  aliases: ['attune', 'switch', 'wield'],
  category: 'inventory',
  description: `${config.prefix}equip <item> — equip a weapon, offhand (shield), armor, or relic.`,
  requiresPlayer: true,

  async run(ctx) {
    const { player, args, db } = ctx

    if (!args || args.length === 0) {
      return ctx.reply(`Usage: *${config.prefix}equip <item id or name>*`)
    }

    const query = args.join(' ')
    const foundId = findInInventory(player.inventory ?? [], query)

    if (!foundId) {
      return ctx.reply(
        `❌ *"${query}"* not found in your inventory.\n` +
        `Use *${config.prefix}inventory* to see what you're carrying.`,
      )
    }

    const item = itemMap[foundId]
    if (!item) {
      return ctx.reply(`❌ Item data for *${foundId}* is missing. Please report this bug.`)
    }

    if (item.type === 'consumable') {
      return ctx.reply(
        `❌ *${item.name}* is a consumable — it can't be equipped.\n` +
        `Use *${config.prefix}use ${foundId}* to consume it instead.`,
      )
    }

    if (item.type === 'material') {
      return ctx.reply(
        `❌ *${item.name}* is a crafting material — visit the forge to use it, it can't be equipped.`,
      )
    }

    const slot = item.slot
    if (!slot) {
      return ctx.reply(`❌ Don't know how to equip item type "${item.type}". This is a bug.`)
    }

    if (player.level < item.levelReq) {
      return ctx.reply(
        `❌ You need to be *level ${item.levelReq}* to equip *${item.name}*.\n` +
        `You are currently level ${player.level}.`,
      )
    }

    // Perform the equip via updatePlayer to prevent stale-write races.
    let oldItemName = null
    let raceAborted = false

    await updatePlayer(db, player.id, (p) => {
      const inv = p.inventory ?? []
      const equipped = p.equipped ?? {}

      // Re-validate against fresh inventory before mutating.
      const idx = inv.indexOf(foundId)
      if (idx === -1) {
        raceAborted = true
        return // item no longer present — abort without mutation
      }

      // If the slot already has something, return it to inventory and
      // strip its stat bonuses back out first.
      const existing = equipped[slot]
      if (existing) {
        const oldItem = itemMap[existing]
        if (oldItem) applyEquipmentBonus(p, oldItem, -1)
        oldItemName = oldItem?.name ?? existing
        inv.push(existing)
        clearDurability(p, slot)
      }

      // Remove one instance of the new item from inventory, equip it, and
      // apply its stat bonuses.
      inv.splice(idx, 1)
      equipped[slot] = foundId
      applyEquipmentBonus(p, item, +1)
      initDurability(p, slot, foundId)

      p.inventory = inv
      p.equipped  = equipped
    })

    if (raceAborted) {
      return ctx.reply(
        `❌ *${item.name}* is no longer in your inventory. Inventory state changed — please try again.`,
      )
    }

    const swapLine = oldItemName
      ? `\n↩️ *${oldItemName}* returned to your inventory.`
      : ''

    return ctx.reply(
      `⚔️ You equipped *${item.name}*!${swapLine}\n` +
      `Slot: ${slot} — use *${config.prefix}profile* to see your full loadout.`,
    )
  },
}
