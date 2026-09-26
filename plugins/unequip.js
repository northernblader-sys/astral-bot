/**
 * <prefix>unequip <weapon|offhand|helmet|chestplate|boots|relic>
 * Moves the item in the given slot back into inventory, stripping its
 * stat bonuses back out of player.stats (and maxHp/maxMp).
 */

import { config } from '../config.js'
import { allItems } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { applyEquipmentBonus } from '../lib/combat-engine.js'
import { clearDurability } from '../lib/durability.js'

const itemMap = Object.fromEntries(allItems.map((i) => [i.id, i]))

const VALID_SLOTS = ['weapon', 'offhand', 'helmet', 'chestplate', 'boots', 'relic', 'tool']

export default {
  name: 'unequip',
  aliases: ['remove'],
  category: 'inventory',
  description: `${config.prefix}unequip <weapon|helmet|chestplate|boots|relic|tool> — move an equipped item back to inventory.`,
  requiresPlayer: true,

  async run(ctx) {
    const { player, args, db } = ctx

    if (!args || args.length === 0) {
      return ctx.reply(
        `Usage: *${config.prefix}unequip <slot>*\n` +
        `Valid slots: *${VALID_SLOTS.join(', ')}*`,
      )
    }

    const slot = args[0].toLowerCase()

    if (!VALID_SLOTS.includes(slot)) {
      return ctx.reply(
        `❌ *"${slot}"* is not a valid slot.\n` +
        `Valid slots: *${VALID_SLOTS.join(', ')}*`,
      )
    }

    const equipped = player.equipped ?? {}
    const currentId = equipped[slot]

    if (!currentId) {
      return ctx.reply(`❌ Your *${slot}* slot is already empty.`)
    }

    const itemName = itemMap[currentId]?.name ?? currentId

    let raceAborted = false

    await updatePlayer(db, player.id, (p) => {
      const inv = p.inventory ?? []
      const eq  = p.equipped  ?? {}

      // Re-validate against fresh equipped state before mutating.
      if (!eq[slot]) {
        raceAborted = true
        return // slot is already empty in fresh state — abort
      }

      const item = itemMap[eq[slot]]
      if (item) applyEquipmentBonus(p, item, -1)

      inv.push(eq[slot])
      eq[slot]    = null
      p.inventory = inv
      p.equipped  = eq
      clearDurability(p, slot)
    })

    if (raceAborted) {
      return ctx.reply(`❌ Your *${slot}* slot is already empty.`)
    }

    return ctx.reply(
      `✅ *${itemName}* unequipped and returned to your inventory.\n` +
      `Use *${config.prefix}equip <item>* to re-equip it anytime.`,
    )
  },
}
