/**
 * cookbook — The recipe book.
 * Lists every dish you can cook, with the ingredients you have vs. need,
 * the cooking fee, and how much hunger each restores (✅ ready / ❌ missing).
 *
 * This is the kitchen twin of plugins/table.js (the blacksmith table), but a
 * cookbook is a *book* — readable anywhere, no town gate. You still need the
 * Astral Town kitchen to actually <prefix>cook.
 *
 * Usage: <prefix>cookbook
 */
import { config } from '../config.js'
import { rarityStars } from '../lib/rarity.js'
import { allItems, foodRecipes } from '../lib/game-data.js'

const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))

function countInv(inventory, itemId) {
  return inventory.filter(id => id === itemId).length
}

function cookStatus(recipe, inventory, solars) {
  const missing = []
  for (const { itemId, qty } of recipe.materials) {
    const have = countInv(inventory, itemId)
    if (have < qty) missing.push(`${itemMap[itemId]?.name ?? itemId} ×${qty - have}`)
  }
  if (solars < recipe.solarsCost) missing.push(`${recipe.solarsCost - solars} more ☀️`)
  return missing
}

export default {
  name:           'cookbook',
  aliases:        ['recipes', 'dishes'],
  category:       'town',
  requiresPlayer: true,
  description:    'Open the cookbook — every dish you can cook',

  async run(ctx) {
    const { player } = ctx
    const pr = config.prefix

    const inv    = player.inventory ?? []
    const solars = player.wallet?.solars ?? 0

    // Cheapest / lightest dishes first, so the early-game options lead.
    const sorted = [...foodRecipes].sort((a, b) => {
      const ha = itemMap[a.output]?.hunger ?? 0
      const hb = itemMap[b.output]?.hunger ?? 0
      return ha - hb
    })

    const lines = []
    for (const recipe of sorted) {
      const item = itemMap[recipe.output]
      if (!item) continue
      const rar  = rarityStars(item.rarity)
      const mats = recipe.materials.map(m => {
        const have = countInv(inv, m.itemId)
        return `${itemMap[m.itemId]?.name ?? m.itemId} ${have}/${m.qty}`
      }).join(', ')
      const missing = cookStatus(recipe, inv, solars)
      const status  = missing.length === 0 ? '✅' : '❌'
      lines.push(`${status} ${rar} *${item.name}* — 🍖 +${item.hunger} hunger`)
      lines.push(`      ${mats} + ${recipe.solarsCost}☀️`)
      if (missing.length) lines.push(`      _Missing: ${missing.join(', ')}_`)
    }

    const header =
      `📖 *COOKBOOK*\n` +
      `💰 Your solars: *${solars} ☀️*\n` +
      `_Buy ingredients at the *${pr}cookshop*, then *${pr}cook <dish>* in Astral Town._\n`
    const footer =
      `\n🍎 _The *Golden Apple* can't be cooked — buy it at the *${pr}cookshop*._\n` +
      `🍽️ _When hungry, *${pr}eat <dish>* to refill your hunger bar._`

    return ctx.reply(header + '\n' + lines.join('\n') + footer)
  },
}
