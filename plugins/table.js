/**
 * table — Blacksmith discovery screen.
 * Shows every craftable item grouped by slot/type, marked as craftable
 * now or listing exactly what's missing. Must be in Astral Town.
 *
 * Usage: <prefix>table [weapon|armor|named|all]
 */
import { config } from '../config.js'
import { rarityStars } from '../lib/rarity.js'
import { allItems, recipes, materials } from '../lib/game-data.js'

const itemMap   = Object.fromEntries(allItems.map(i => [i.id, i]))
const matMap    = Object.fromEntries(materials.map(m => [m.id, m]))

const SLOT_ORDER = ['helmet', 'chestplate', 'boots', 'weapon']
const SLOT_LABEL = { helmet: '🪖 Helmets', chestplate: '🧥 Chestplates', boots: '👢 Boots', weapon: '⚔️ Weapons' }

function countInv(inventory, itemId) {
  return inventory.filter(id => id === itemId).length
}

function craftStatus(recipe, inventory, solars) {
  const missing = []
  for (const { itemId, qty } of recipe.materials) {
    const have = countInv(inventory, itemId)
    if (have < qty) {
      const mat = matMap[itemId] ?? itemMap[itemId]
      missing.push(`${mat?.name ?? itemId} ×${qty - have}`)
    }
  }
  if (solars < recipe.solarsCost) {
    missing.push(`${recipe.solarsCost - solars} more ☀️`)
  }
  return missing
}

export default {
  name:           'table',
  aliases:        ['blacksmith', 'forge'],
  category:       'town',
  requiresPlayer: true,
  description:    'Open the blacksmith crafting table',

  async run(ctx) {
    const { player, args } = ctx
    const pr = config.prefix

    if (player.inBattle) return ctx.reply(`⚔️ You can't visit the blacksmith mid-battle!`)
    if (player.inDungeon) return ctx.reply(`🗺️ Exit the dungeon first. Use *${pr}dungeon leave*.`)
    if (player.location !== 'astral_town') {
      return ctx.reply(`🔨 The blacksmith is in *Astral Town*. You are in *${player.location ?? 'unknown'}*.`)
    }

    const filter  = args[0]?.toLowerCase() ?? 'all'
    const inv     = player.inventory ?? []
    const solars  = player.wallet?.solars ?? 0

    // Group regular recipes by output item's slot
    const grouped = {}
    for (const recipe of recipes) {
      if (recipe.category === 'named') continue   // handled separately below
      const item = itemMap[recipe.output]
      if (!item) continue
      const slot = item.slot ?? recipe.category ?? 'other'
      if (!grouped[slot]) grouped[slot] = []
      grouped[slot].push({ recipe, item })
    }

    const sections = []

    // ── Regular armor / weapon sections ─────────────────────────────────────
    if (filter !== 'named') {
      const slotsToShow = filter === 'weapon' ? ['weapon']
        : filter === 'armor' ? ['helmet', 'chestplate', 'boots']
        : SLOT_ORDER

      for (const slot of slotsToShow) {
        const entries = grouped[slot]
        if (!entries?.length) continue
        const lines = [`*${SLOT_LABEL[slot] ?? slot}*`]
        for (const { recipe, item } of entries) {
          const rar     = rarityStars(item.rarity)
          const mats    = recipe.materials.map(m => {
            const have = countInv(inv, m.itemId)
            const mat  = matMap[m.itemId] ?? itemMap[m.itemId]
            return `${mat?.name ?? m.itemId} ${have}/${m.qty}`
          }).join(', ')
          const missing = craftStatus(recipe, inv, solars)
          const status  = missing.length === 0 ? '✅' : '❌'
          lines.push(`  ${status} ${rar} *${item.name}* (Lv${item.levelReq}) — ${mats} + ${recipe.solarsCost}☀️`)
          if (missing.length) lines.push(`      _Missing: ${missing.join(', ')}_`)
        }
        sections.push(lines.join('\n'))
      }
    }

    // ── Named Weapons section ────────────────────────────────────────────────
    if (filter === 'all' || filter === 'named') {
      const namedRecipes = recipes.filter(r => r.category === 'named')
      if (namedRecipes.length) {
        const lines = ['🗡️ *Named Weapons*', '_Crafted from boss trophies — unique endgame gear_']
        for (const recipe of namedRecipes) {
          const item = itemMap[recipe.output]
          if (!item) continue
          const rar     = rarityStars(item.rarity)
          const slotTag = item.slot ? ` [${item.slot}]` : ''
          const passive = item.passiveId ? ` ✨_${item.passiveId}_` : ''
          const mats    = recipe.materials.map(m => {
            const have = countInv(inv, m.itemId)
            const mat  = matMap[m.itemId] ?? itemMap[m.itemId]
            return `${mat?.name ?? m.itemId} ${have}/${m.qty}`
          }).join(', ')
          const missing = craftStatus(recipe, inv, solars)
          const status  = missing.length === 0 ? '✅' : '❌'
          lines.push(`  ${status} ${rar} *${item.name}*${slotTag} (Lv${item.levelReq})${passive}`)
          lines.push(`      ${mats} + ${recipe.solarsCost}☀️`)
          if (missing.length) lines.push(`      _Missing: ${missing.join(', ')}_`)
        }
        sections.push(lines.join('\n'))
      }
    }

    if (!sections.length) return ctx.reply(`🔨 No recipes found for filter: *${filter}*`)

    const header = `🔨 *BLACKSMITH — Astral Town*\n💰 Your solars: *${solars} ☀️*\n_Type *${pr}craft <item name>* to forge an item._\n`
    const footer = `\n_Filter: *${pr}table weapon* | *${pr}table armor* | *${pr}table named*_`

    return ctx.reply(header + '\n' + sections.join('\n\n') + footer)
  },
}
