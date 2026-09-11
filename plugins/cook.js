/**
 * cook — Prepare a dish in the Astral Town kitchen.
 * Consumes the recipe's ingredients + a small solars cooking fee, and drops
 * the finished dish into your inventory to eat later with <prefix>eat.
 *
 * This is the kitchen twin of plugins/craft.js (the blacksmith forge): same
 * race-guarded updatePlayer consume-then-produce pattern, but it reads the
 * separate `foodRecipes` set and its outputs are food, not gear (so there's
 * no levelReq / slot / equip step). Town-gated like the forge.
 *
 * Usage: <prefix>cook <dish name or id>
 */
import { config } from '../config.js'
import { allItems, foodRecipes } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { rarityStars } from '../lib/rarity.js'

const itemMap        = Object.fromEntries(allItems.map(i => [i.id, i]))
const recipeByOutput = Object.fromEntries(foodRecipes.map(r => [r.output, r]))

function findRecipe(query) {
  const q = query.toLowerCase()
  if (recipeByOutput[q]) return recipeByOutput[q]
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
  name:           'cook',
  aliases:        ['cooking'],
  category:       'town',
  requiresPlayer: true,
  description:    `${config.prefix}cook <dish> — cook a dish in the Astral Town kitchen`,

  async run(ctx) {
    const { player, args } = ctx
    const pr = config.prefix

    if (player.inBattle)  return ctx.reply(`⚔️ You can't cook mid-battle!`)
    if (player.inDungeon) return ctx.reply(`🗺️ Exit the dungeon first. Use *${pr}dungeon leave*.`)
    if (player.location !== 'astral_town') {
      return ctx.reply(`🍳 The kitchen is in *Astral Town*. You are in *${player.location ?? 'unknown'}*.`)
    }

    if (!args || args.length === 0) {
      return ctx.reply(`Usage: *${pr}cook <dish name or id>*\nSee all recipes: *${pr}cookbook*`)
    }

    const query  = args.join(' ')
    const recipe = findRecipe(query)
    if (!recipe) {
      return ctx.reply(
        `❌ No recipe found for *"${query}"*.\n` +
        `Use *${pr}cookbook* to see everything you can cook.`,
      )
    }

    const item = itemMap[recipe.output]
    if (!item) return ctx.reply(`❌ Recipe data error: dish *${recipe.output}* not found.`)

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
    if (solars < recipe.solarsCost) {
      missing.push(`*${recipe.solarsCost - solars} more ☀️* (have ${solars})`)
    }
    if (missing.length) {
      return ctx.reply(
        `❌ Can't cook *${item.name}* — missing:\n` +
        missing.map(m => `  • ${m}`).join('\n') +
        `\n\n_Buy ingredients at the *${pr}cookshop*._`,
      )
    }

    // Atomically consume ingredients + fee, add the dish to inventory.
    let raceAborted = false
    let abortReason = ''

    await updatePlayer(ctx.db, ctx.from, (p) => {
      const pinv    = p.inventory ?? []
      const psolars = p.wallet?.solars ?? 0

      for (const { itemId, qty } of recipe.materials) {
        if (countInv(pinv, itemId) < qty) {
          raceAborted = true
          abortReason = `not enough *${itemMap[itemId]?.name ?? itemId}*`
          return
        }
      }
      if (psolars < recipe.solarsCost) {
        raceAborted = true
        abortReason = `not enough ☀️ (need ${recipe.solarsCost}, have ${psolars})`
        return
      }

      for (const { itemId, qty } of recipe.materials) {
        let remaining = qty
        for (let i = pinv.length - 1; i >= 0 && remaining > 0; i--) {
          if (pinv[i] === itemId) { pinv.splice(i, 1); remaining-- }
        }
      }
      p.wallet.solars -= recipe.solarsCost
      pinv.push(recipe.output)
      p.inventory = pinv
    })

    if (raceAborted) {
      return ctx.reply(`❌ Cooking failed — inventory changed: ${abortReason}. Try again.`)
    }

    const rar = rarityStars(item.rarity)
    return ctx.reply(
      `🍳 *Cooked!* ${rar} *${item.name}* [${item.rarity}]\n` +
      `🍖 Restores *${item.hunger}* hunger • _(-${recipe.solarsCost} ☀️ and ingredients used)_\n` +
      `Eat it with *${pr}eat ${recipe.output}* when you get hungry.`,
    )
  },
}
