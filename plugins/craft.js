/**
 * craft — Forge an item at the blacksmith.
 * Consumes required materials + solars from inventory/wallet.
 * Must be in Astral Town (forge location gate).
 *
 * Usage: <prefix>craft <item name or id>
 */
import { config } from '../config.js'
import { allItems, recipes } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { rarityStars } from '../lib/rarity.js'
import { getModValue } from '../lib/mods.js'

const itemMap   = Object.fromEntries(allItems.map(i => [i.id, i]))
// Index recipes by output id for fast lookup
const recipeByOutput = Object.fromEntries(recipes.map(r => [r.output, r]))

function findRecipe(query) {
  const q = query.toLowerCase()
  // Exact id
  if (recipeByOutput[q]) return recipeByOutput[q]
  // Partial name match against output item name
  for (const [outputId, recipe] of Object.entries(recipeByOutput)) {
    const item = itemMap[outputId]
    if (item && item.name.toLowerCase().includes(q)) return recipe
  }
  return null
}

function countInv(inventory, itemId) {
  return inventory.filter(id => id === itemId).length
}

export default {
  name:           'craft',
  aliases:        ['forge', 'smith'],
  category:       'town',
  requiresPlayer: true,
  description:    `${config.prefix}craft <item> — forge an item at the blacksmith`,

  async run(ctx) {
    const { player, args } = ctx
    const pr = config.prefix

    if (player.inBattle)  return ctx.reply(`⚔️ You can't craft mid-battle!`)
    if (player.inDungeon) return ctx.reply(`🗺️ Exit the dungeon first. Use *${pr}dungeon leave*.`)
    if (player.location !== 'astral_town') {
      return ctx.reply(`🔨 Crafting requires the blacksmith in *Astral Town*. You are in *${player.location ?? 'unknown'}*.`)
    }

    if (!args || args.length === 0) {
      return ctx.reply(`Usage: *${pr}craft <item name or id>*\nSee all recipes: *${pr}table*`)
    }

    const query  = args.join(' ')
    const recipe = findRecipe(query)
    if (!recipe) {
      return ctx.reply(
        `❌ No recipe found for *"${query}"*.\n` +
        `Use *${pr}table* to see all craftable items.`,
      )
    }

    const item = itemMap[recipe.output]
    if (!item) return ctx.reply(`❌ Recipe data error: output item *${recipe.output}* not found.`)

    if (player.level < item.levelReq) {
      return ctx.reply(
        `❌ You need *level ${item.levelReq}* to craft *${item.name}*.\n` +
        `You are level ${player.level}.`,
      )
    }

    // Cheat mod: Efficient Hands (crafting_cost_reduction). Only reduces
    // the solars cost, not material quantities — material counts are
    // whole items and don't reduce cleanly by a percentage, so this cheat
    // deliberately only discounts the solars side of the recipe.
    const costReduction = getModValue(player, 'crafting_cost_reduction') ?? 0
    const effectiveSolarsCost = Math.max(0, Math.round(recipe.solarsCost * (1 - costReduction)))

    // Pre-check before entering the race-guard
    const inv    = player.inventory ?? []
    const solars = player.wallet?.solars ?? 0
    const missing = []
    for (const { itemId, qty } of recipe.materials) {
      const have = countInv(inv, itemId)
      if (have < qty) {
        missing.push(`*${itemMap[itemId]?.name ?? itemId}* ×${qty - have} (have ${have})`)
      }
    }
    if (solars < effectiveSolarsCost) {
      missing.push(`*${effectiveSolarsCost - solars} more ☀️* (have ${solars})`)
    }
    if (missing.length) {
      return ctx.reply(
        `❌ Can't craft *${item.name}* — missing:\n` +
        missing.map(m => `  • ${m}`).join('\n'),
      )
    }

    // Atomically consume materials + solars, add output to inventory
    let raceAborted = false
    let abortReason = ''

    await updatePlayer(ctx.db, ctx.from, (p) => {
      const pinv    = p.inventory ?? []
      const psolars = p.wallet?.solars ?? 0
      // Re-read the cheat inside the mutator too, in case mods changed
      // between the pre-check and now (e.g. deactivated mid-race).
      const freshReduction = getModValue(p, 'crafting_cost_reduction') ?? 0
      const freshSolarsCost = Math.max(0, Math.round(recipe.solarsCost * (1 - freshReduction)))

      // Re-validate on fresh state
      for (const { itemId, qty } of recipe.materials) {
        if (countInv(pinv, itemId) < qty) {
          raceAborted  = true
          abortReason  = `not enough *${itemMap[itemId]?.name ?? itemId}*`
          return
        }
      }
      if (psolars < freshSolarsCost) {
        raceAborted = true
        abortReason = `not enough ☀️ (need ${freshSolarsCost}, have ${psolars})`
        return
      }

      // Consume materials
      for (const { itemId, qty } of recipe.materials) {
        let remaining = qty
        for (let i = pinv.length - 1; i >= 0 && remaining > 0; i--) {
          if (pinv[i] === itemId) { pinv.splice(i, 1); remaining-- }
        }
      }
      p.wallet.solars -= freshSolarsCost
      pinv.push(recipe.output)
      p.inventory = pinv
    })

    if (raceAborted) {
      return ctx.reply(`❌ Crafting failed — inventory changed: ${abortReason}. Try again.`)
    }

    const rar = rarityStars(item.rarity)
    return ctx.reply(
      `🔨 *Crafted!* ${rar} *${item.name}* [${item.rarity}]\n` +
      `Slot: ${item.slot ?? 'weapon'} • Level req: ${item.levelReq}\n` +
      `_(-${effectiveSolarsCost} ☀️ and materials consumed)_\n` +
      `Use *${pr}equip ${recipe.output}* to equip it.`,
    )
  },
}
