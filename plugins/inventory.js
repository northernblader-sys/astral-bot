/**
 * <prefix>inventory — shows the player's inventory grouped by item type.
 * Consumables with multiple copies are stacked (e.g. Health Potion x3).
 * Equipped items are tagged with ⚡.
 */

import { config } from '../config.js'
import { allItems } from '../lib/game-data.js'
import { getInventoryCap } from '../lib/inventory-limits.js'
import { rarityStars } from '../lib/rarity.js'
import { curioUse, humanizeId } from '../lib/curios.js'

// Build a lookup map from item id → item object once at load time.
const itemMap = Object.fromEntries(allItems.map((i) => [i.id, i]))

const TYPE_ORDER = ['weapon', 'armor', 'accessory', 'relic', 'tool', 'material', 'consumable', 'food', 'ingredient', 'misc']
const TYPE_LABEL = {
  weapon:     '⚔️ Weapons',
  armor:      '🛡️ Armor',
  accessory:  '💍 Accessories',
  relic:      '🔮 Relics',
  tool:       '🔧 Tools',
  material:   '🧵 Materials',
  consumable: '🧪 Consumables',
  food:       '🍖 Food',
  ingredient: '🥕 Ingredients',
  misc:       '🎲 Curios',
}

/**
 * Trailing hint for a curio: the command that consumes it, or the salvage
 * pointer when nothing does. `misc` items have no slot and no effect, so
 * without this line a player has no way to tell a live Ender Pearl apart from
 * an inert Bar Tab Receipt. lib/curios.js owns that distinction.
 */
function curioHint(id) {
  const use = curioUse(id)
  return use ? `  ·  ${config.prefix}${use}` : `  ·  ${config.prefix}salvage`
}

const DIVIDER = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈'

/** 10-segment fill bar for slot usage, e.g. "▰▰▰▰▰▰▱▱▱▱" for 6/10-ish ratios. */
function slotBar(used, cap) {
  const segments = 10
  const filled = cap > 0 ? Math.round((used / cap) * segments) : 0
  const clamped = Math.max(0, Math.min(segments, filled))
  return '▰'.repeat(clamped) + '▱'.repeat(segments - clamped)
}

export default {
  name: 'inventory',
  aliases: ['inv', 'bag'],
  category: 'inventory',
  description: 'View your inventory.',
  requiresPlayer: true,

  async run(ctx) {
    const { player } = ctx
    const { inventory = [], equipped = {} } = player
    const cap = getInventoryCap(player)

    if (inventory.length === 0) {
      return ctx.reply(
        `🎒 *YOUR INVENTORY*\n${DIVIDER}\n` +
        `_Empty — 0/${cap} slots used_\n\n` +
        `You start with the items your class gives you at registration.\n` +
        `More gear comes from dungeons, monsters, and the shop.\n` +
        `Use *${config.prefix}register* if you haven't created your character yet.`,
      )
    }

    // Set of currently-equipped item ids for quick lookup.
    const equippedIds = new Set(Object.values(equipped).filter(Boolean))

    // Count occurrences of each item id (for stacking consumables).
    const counts = {}
    for (const id of inventory) {
      counts[id] = (counts[id] ?? 0) + 1
    }

    // Group unique item ids by type. Unrecognized ids (not present in
    // allItems — e.g. from stale data or a data file that hasn't loaded
    // this item type) are NOT dropped; they're collected separately so the
    // player always sees everything physically in their inventory array
    // instead of items silently vanishing from the list.
    const groups = {}
    const unknown = []
    const seen = new Set()
    for (const id of inventory) {
      if (seen.has(id)) continue
      seen.add(id)
      const item = itemMap[id]
      if (!item) {
        unknown.push(id)
        continue
      }
      if (!groups[item.type]) groups[item.type] = []
      groups[item.type].push(item)
    }

    const lines = [
      `🎒 *YOUR INVENTORY*`,
      DIVIDER,
      `${slotBar(inventory.length, cap)}  ${inventory.length}/${cap}`,
      '',
    ]

    let firstSection = true
    for (const type of TYPE_ORDER) {
      const group = groups[type]
      if (!group || group.length === 0) continue

      if (!firstSection) lines.push('')
      firstSection = false

      lines.push(`*${TYPE_LABEL[type]}*`)
      for (const item of group) {
        const star  = rarityStars(item.rarity)
        const count = counts[item.id] > 1 ? `  ×${counts[item.id]}` : ''
        const tag   = equippedIds.has(item.id) ? '  ⚡' : ''
        const hint  = type === 'misc' ? curioHint(item.id) : ''
        lines.push(`${star}  ${item.name}${count}${tag}${hint}`)
      }
      delete groups[type]
    }

    // Safety net: any item type that exists in the data but isn't wired
    // into TYPE_ORDER/TYPE_LABEL above (e.g. a new item category added
    // later) still needs to be shown — it was previously silently dropped
    // from the list while still counting toward the slot total, which is
    // exactly the "11 items but only 5 shown" bug this fixes. Fold any
    // leftover recognized-but-unlisted groups into the known items we
    // still show, rather than letting them vanish.
    const leftoverGroups = Object.values(groups).flat()
    if (leftoverGroups.length) unknown.push(...leftoverGroups.map((item) => item.id))

    if (unknown.length) {
      if (!firstSection) lines.push('')
      lines.push(`*❔ Other*`)
      for (const id of unknown) {
        const count = counts[id] > 1 ? `  ×${counts[id]}` : ''
        // Fall back to a human-readable version of the raw id so the
        // player still sees *something* instead of the item disappearing.
        lines.push(`☆☆☆☆☆  ${humanizeId(id)}${count}  ·  ${config.prefix}salvage`)
      }
      // Everything down here is dead weight: no slot, no effect, and no entry
      // in the item data to sell it by. It still eats a slot against the cap,
      // so point players at the one command that can clear it for solars.
      lines.push(`_Leftovers from retired content. ${config.prefix}salvage turns them into solars and frees the slots._`)
    }

    lines.push('', DIVIDER)
    lines.push(`*${config.prefix}inspect <item>* — view details`)
    lines.push(`*${config.prefix}equip <item>* — equip gear`)
    lines.push(`*${config.prefix}salvage* — scrap curios and leftovers for solars`)

    const caption = lines.join('\n')
    return ctx.reply(caption)
  },
}
