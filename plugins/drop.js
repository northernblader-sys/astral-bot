/**
 * <prefix>drop <item id or partial name> [confirm]
 * Permanently removes one instance of an item from inventory.
 * Requires the "confirm" flag to prevent accidental drops.
 * Equipped items must be unequipped first.
 */

import { config } from '../config.js'
import { allItems } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'

const itemMap = Object.fromEntries(allItems.map((i) => [i.id, i]))

/** Find first matching item id in the player's inventory (exact id or partial name). */
function findInInventory(inventory, query) {
  const q = query.toLowerCase()
  if (inventory.includes(q)) return q
  for (const id of inventory) {
    const item = itemMap[id]
    if (item && item.name.toLowerCase().includes(q)) return id
  }
  return null
}

export default {
  name: 'drop',
  aliases: ['discard'],
  category: 'inventory',
  description: `${config.prefix}drop <item> [confirm] — permanently remove an item from your inventory.`,
  requiresPlayer: true,

  async run(ctx) {
    const { player, args, db } = ctx

    if (!args || args.length === 0) {
      return ctx.reply(`Usage: *${config.prefix}drop <item id or name> confirm*`)
    }

    // Split off trailing "confirm" flag.
    const hasConfirm = args[args.length - 1].toLowerCase() === 'confirm'
    const queryParts = hasConfirm ? args.slice(0, -1) : args
    const query = queryParts.join(' ')

    if (!query) {
      return ctx.reply(`Usage: *${config.prefix}drop <item id or name> confirm*`)
    }

    const foundId = findInInventory(player.inventory ?? [], query)

    if (!foundId) {
      return ctx.reply(
        `❌ *"${query}"* not found in your inventory.\n` +
        `Use *${config.prefix}inventory* to see what you're carrying.`,
      )
    }

    const item = itemMap[foundId]
    const itemName = item?.name ?? foundId

    // Check if the item is currently equipped.
    const equipped = player.equipped ?? {}
    const isEquipped = Object.values(equipped).includes(foundId)
    if (isEquipped) {
      const slot = Object.keys(equipped).find((k) => equipped[k] === foundId)
      return ctx.reply(
        `❌ *${itemName}* is currently equipped in your *${slot}* slot.\n` +
        `Use *${config.prefix}unequip ${slot}* first, then drop it.`,
      )
    }

    // Require explicit confirm flag.
    if (!hasConfirm) {
      return ctx.reply(
        `⚠️ Are you sure you want to permanently drop *${itemName}*? This cannot be undone.\n\n` +
        `Re-send: *${config.prefix}drop ${foundId} confirm*`,
      )
    }

    // Perform the drop.
    let raceAborted = false

    await updatePlayer(db, player.id, (p) => {
      const inv = p.inventory ?? []
      const idx = inv.indexOf(foundId)
      if (idx === -1) {
        raceAborted = true
        return // item no longer present — abort without mutation
      }
      inv.splice(idx, 1)
      p.inventory = inv
    })

    if (raceAborted) {
      return ctx.reply(
        `❌ *${itemName}* is no longer in your inventory. Inventory state changed — please try again.`,
      )
    }

    return ctx.reply(`🗑️ *${itemName}* has been dropped and is gone forever.`)
  },
}
