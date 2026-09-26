/**
 * cookshop — The Astral Town food market.
 * Sells raw cooking ingredients (and the premium Golden Apple) for solars.
 * Cooked dishes are NOT sold here — you cook those yourself with <prefix>cook.
 *
 * Mirrors plugins/shop.js's handleBuy race-guarded purchase flow, but its
 * shelves are built from data/food.json entries that carry a `cookShopPrice`
 * (ingredients + the Golden Apple). Those entries deliberately have NO
 * `buyPrice`, so they never appear in the general `.shop`. Town-gated like
 * the blacksmith.
 *
 * Usage:
 *   <prefix>cookshop                 — browse ingredients + your solars
 *   <prefix>cookshop buy <item> [qty] — buy ingredients into your inventory
 */
import { config } from '../config.js'
import { food } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { rarityStars } from '../lib/rarity.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'

// Everything with a cookShopPrice is for sale here: raw ingredients + the
// Golden Apple. Cooked dishes have no cookShopPrice, so they're excluded.
const catalog      = food.filter(f => f.cookShopPrice != null)
const catalogById  = Object.fromEntries(catalog.map(f => [f.id, f]))

function findInCatalog(query) {
  const q = query.toLowerCase()
  if (catalogById[q]) return catalogById[q]
  return catalog.find(f => f.name.toLowerCase().includes(q)) ?? null
}

function inTown(ctx) {
  const { player } = ctx
  const pr = config.prefix
  if (player.inBattle)  return `⚔️ You can't visit the market mid-battle!`
  if (player.inDungeon) return `🗺️ Exit the dungeon first. Use *${pr}dungeon leave*.`
  if (player.location !== 'astral_town') {
    return `🍅 The food market is in *Astral Town*. You are in *${player.location ?? 'unknown'}*.`
  }
  return null
}

async function handleBuy(ctx, args) {
  const pr = config.prefix

  if (!args[1]) {
    return ctx.reply(
      `❌ *Usage:* *${pr}cookshop buy <item name or id> [quantity]*\n` +
      `_Example:_ *${pr}cookshop buy wheat 3*`,
    )
  }

  const lastArg = args[args.length - 1]
  let qty        = 1
  let queryParts = args.slice(1)
  if (/^\d+$/.test(lastArg) && args.length > 2) {
    qty        = Math.max(1, Math.min(99, parseInt(lastArg, 10)))
    queryParts = args.slice(1, -1)
  }
  const query = queryParts.join(' ')

  const entry = findInCatalog(query)
  if (!entry) {
    return ctx.reply(
      `❌ *"${queryParts.join(' ')}"* isn't sold at the food market.\n` +
      `🔎 Browse with *${pr}cookshop*.`,
    )
  }

  const totalCost = entry.cookShopPrice * qty
  let outcome = null

  await updatePlayer(ctx.db, ctx.from, (player) => {
    const solars = player.wallet?.solars ?? 0
    if (solars < totalCost) {
      outcome = { reason: 'solars', solars }
      return
    }
    if (!hasInventoryRoom(player, qty)) {
      outcome = { reason: 'full', player }
      return
    }
    player.wallet.solars -= totalCost
    for (let i = 0; i < qty; i++) player.inventory.push(entry.id)
    outcome = { reason: 'ok', remaining: player.wallet.solars }
  })

  if (outcome.reason === 'solars') {
    const short = totalCost - outcome.solars
    return ctx.reply(
      `❌ *Not enough Solars!*\n` +
      `*${entry.name}* × ${qty} costs ☀️ *${totalCost}*.\n` +
      `You have ☀️ *${outcome.solars}* — need ☀️ *${short}* more.`,
    )
  }
  if (outcome.reason === 'full') {
    return ctx.reply(
      `❌ ${inventoryFullMessage(outcome.player)}\n` +
      `_Can't buy_ *${entry.name} × ${qty}* _— not enough room._`,
    )
  }

  const qtyLine = qty > 1 ? ` × ${qty}` : ''
  const hint = entry.immunity
    ? `\n🍎 _Eat it with *${pr}eat ${entry.id}* — you won't get hungry again until you die._`
    : `\n🍳 _Now *${pr}cook* a dish with it. See *${pr}cookbook*._`
  return ctx.reply(
    `🛒 *Purchase complete!*\n\n` +
    `${rarityStars(entry.rarity)} *${entry.name}*${qtyLine}\n` +
    `💰 Paid: ☀️ *${totalCost}*\n` +
    `💰 Remaining: ☀️ *${outcome.remaining}*` +
    hint,
  )
}

function renderShop(ctx) {
  const pr = config.prefix
  const solars = ctx.player.wallet?.solars ?? 0

  const ingredients = catalog.filter(f => f.type === 'ingredient')
  const specials    = catalog.filter(f => f.type !== 'ingredient')

  const lines = [`🥕 *${'Ingredients'}*`]
  for (const f of ingredients) {
    lines.push(`  ${rarityStars(f.rarity)} *${f.name}* — ☀️ ${f.cookShopPrice}  \`${f.id}\``)
  }
  if (specials.length) {
    lines.push('', `✨ *Specials*`)
    for (const f of specials) {
      lines.push(`  ${rarityStars(f.rarity)} *${f.name}* — ☀️ ${f.cookShopPrice}  \`${f.id}\``)
      if (f.description) lines.push(`      _${f.description}_`)
    }
  }

  const header =
    `🍅 *COOKSHOP — Astral Town*\n` +
    `💰 Your solars: *${solars} ☀️*\n` +
    `_Buy with *${pr}cookshop buy <item> [qty]*_\n`
  const footer =
    `\n📖 _See what you can make: *${pr}cookbook*_\n` +
    `🍳 _Then *${pr}cook <dish>* and *${pr}eat <dish>*._`

  return ctx.reply(header + '\n' + lines.join('\n') + footer)
}

export default {
  name:           'cookshop',
  aliases:        ['foodshop'],
  category:       'town',
  requiresPlayer: true,
  description:    `${config.prefix}cookshop — buy cooking ingredients in Astral Town`,

  async run(ctx) {
    const gate = inTown(ctx)
    if (gate) return ctx.reply(gate)

    const sub = ctx.args[0]?.toLowerCase()
    if (sub === 'buy') return handleBuy(ctx, ctx.args)
    return renderShop(ctx)
  },
}
