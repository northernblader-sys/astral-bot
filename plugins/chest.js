/**
 * chest.js — Personal storage chest, immune to death loss.
 *
 * Death (see lib/combat-handlers.js's handleDeath) now wipes the player's
 * ENTIRE `inventory` array, not just equipped gear. The chest is the
 * player's only way to protect items from that: anything moved into
 * `player.chest.items` sits outside `inventory` entirely, so a death wipe
 * never touches it. Put things in before a risky dungeon run, take them
 * back out anytime — including right after a death, to gear back up.
 *
 * Purchase: one-time unlock, 50,000 Solars OR 10 Gems (either currency,
 * not both — see handleBuy). Deliberately its own command rather than a
 * `.shop buy chest` catalog entry, since it isn't an inventory item and
 * has no id in allItems — same reasoning as shop.js's ability_slot.
 *
 * Player schema addition (see lib/player-repo.js's top-of-file doc):
 *   chest: {
 *     unlocked: boolean,   // false until bought
 *     items:    string[],  // item ids stored here — flat array, same
 *                          // stacking convention as player.inventory
 *                          // (duplicates allowed, one entry per copy)
 *   }
 *
 * Commands:
 *   .chest                      — show status / contents
 *   .chest buy solars|gems      — unlock the chest
 *   .chest put <item> [qty]     — move item(s) from inventory into chest
 *   .chest take <item> [qty]    — move item(s) from chest back into inventory
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { roundGems } from '../lib/format.js'
import { allItems } from '../lib/game-data.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import { rarityStars } from '../lib/rarity.js'

const CHEST_PRICE_SOLARS = 50_000
const CHEST_PRICE_GEMS   = 10

const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))

/** Ensures player.chest exists with the expected shape (backfill for accounts predating this feature). */
function ensureChest(player) {
  if (!player.chest) player.chest = { unlocked: false, items: [] }
  if (!Array.isArray(player.chest.items)) player.chest.items = []
  return player.chest
}

/** Finds an item by exact id or case-insensitive partial name, same lookup style as shop.js. */
function findItem(query) {
  const q = query.toLowerCase().trim()
  if (itemMap[q]) return itemMap[q]
  for (const item of Object.values(itemMap)) {
    if (item.name.toLowerCase().includes(q)) return item
  }
  return undefined
}

/** Groups a flat id[] into "Name x3" lines, sorted by rarity then name — shared by inventory/chest views. */
function summarize(ids) {
  const counts = new Map()
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  return [...counts.entries()]
    .map(([id, count]) => {
      const item = itemMap[id]
      const name = item?.name ?? id
      const stars = item ? rarityStars(item.rarity) : ''
      return { line: `${stars} *${name}*${count > 1 ? ` x${count}` : ''}`, name }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => e.line)
}

// ── Status / contents ────────────────────────────────────────────────

function statusView(ctx) {
  const p = config.prefix
  const chest = ensureChest(ctx.player)

  if (!chest.unlocked) {
    return (
      `🧰 *YOUR CHEST*\n\n` +
      `🔒 _You haven't unlocked a chest yet._\n\n` +
      `Items stored in your chest are *never lost on death* — only your ` +
      `equipped gear and loose inventory are at risk when you fall.\n\n` +
      `💰 *Price:* ☀️ *${CHEST_PRICE_SOLARS.toLocaleString()} Solars* _or_ 💎 *${CHEST_PRICE_GEMS} Gems*\n\n` +
      `🛒 *${p}chest buy solars* — pay with Solars\n` +
      `🛒 *${p}chest buy gems* — pay with Gems`
    )
  }

  if (!chest.items.length) {
    return (
      `🧰 *YOUR CHEST*\n\n` +
      `_Empty._\n\n` +
      `*${p}chest put <item> [qty]* — store something safely\n` +
      `*${p}chest take <item> [qty]* — take something back out`
    )
  }

  return (
    `🧰 *YOUR CHEST*  _(${chest.items.length} item${chest.items.length === 1 ? '' : 's'} · safe from death)_\n\n` +
    summarize(chest.items).join('\n') +
    `\n\n*${p}chest put <item> [qty]* — store more\n` +
    `*${p}chest take <item> [qty]* — take something out`
  )
}

// ── Buy ───────────────────────────────────────────────────────────────

async function handleBuy(ctx, args) {
  const p = config.prefix
  const currency = args[1]?.toLowerCase()

  if (currency !== 'solars' && currency !== 'gems') {
    return ctx.reply(
      `❌ *Choose a currency:*\n` +
      `*${p}chest buy solars* — ☀️ ${CHEST_PRICE_SOLARS.toLocaleString()}\n` +
      `*${p}chest buy gems* — 💎 ${CHEST_PRICE_GEMS}`,
    )
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const chest = ensureChest(player)
    if (chest.unlocked) { outcome = { reason: 'already' }; return player }

    const wallet = player.wallet ?? (player.wallet = {})
    if (currency === 'solars') {
      const solars = wallet.solars ?? 0
      if (solars < CHEST_PRICE_SOLARS) { outcome = { reason: 'solars', have: solars }; return player }
      wallet.solars = solars - CHEST_PRICE_SOLARS
    } else {
      const gems = wallet.gems ?? 0
      if (gems < CHEST_PRICE_GEMS) { outcome = { reason: 'gems', have: gems }; return player }
      wallet.gems = roundGems(gems - CHEST_PRICE_GEMS)
    }

    chest.unlocked = true
    outcome = { reason: 'ok', currency }
    return player
  })

  if (outcome.reason === 'already') {
    return ctx.reply(`❌ You already have a chest unlocked. Use *${p}chest* to view it.`)
  }
  if (outcome.reason === 'solars') {
    return ctx.reply(
      `❌ *Not enough Solars!*\n` +
      `Chest costs ☀️ *${CHEST_PRICE_SOLARS.toLocaleString()}*. You have ☀️ *${outcome.have.toLocaleString()}*.\n` +
      `_Or try_ *${p}chest buy gems* _(💎${CHEST_PRICE_GEMS})._`,
    )
  }
  if (outcome.reason === 'gems') {
    return ctx.reply(
      `❌ *Not enough Gems!*\n` +
      `Chest costs 💎 *${CHEST_PRICE_GEMS}*. You have 💎 *${outcome.have}*.\n` +
      `_Or try_ *${p}chest buy solars* _(☀️${CHEST_PRICE_SOLARS.toLocaleString()})._`,
    )
  }

  return ctx.reply(
    `🧰 *Chest unlocked!*\n\n` +
    `Paid: ${outcome.currency === 'solars' ? `☀️ ${CHEST_PRICE_SOLARS.toLocaleString()} Solars` : `💎 ${CHEST_PRICE_GEMS} Gems`}\n\n` +
    `Anything you store here survives death. Use *${p}chest put <item>* to start.`,
  )
}

// ── Put / Take ───────────────────────────────────────────────────────

/** Parses "<item name...> [qty]" the same way shop.js's sell handler does. */
function parseItemAndQty(args) {
  const lastArg = args[args.length - 1]
  let qty = 1
  let queryParts = args
  if (/^\d+$/.test(lastArg) && args.length > 1) {
    qty = Math.max(1, Math.min(99, parseInt(lastArg, 10)))
    queryParts = args.slice(0, -1)
  }
  return { query: queryParts.join(' '), qty }
}

async function handlePut(ctx, args) {
  const p = config.prefix
  if (!args[1]) {
    return ctx.reply(`❌ *Usage:* *${p}chest put <item name or id> [qty]*`)
  }
  const { query, qty } = parseItemAndQty(args.slice(1))
  const item = findItem(query)
  if (!item) return ctx.reply(`❌ *Item* "_${query}_" *not recognized.*`)

  await updatePlayer(ctx.db, ctx.from, player => {
    const chest = ensureChest(player)
    if (!chest.unlocked) {
      ctx.reply(`🔒 You don't have a chest yet. Use *${p}chest* to see how to unlock one.`).catch(() => {})
      return player
    }

    const owned = player.inventory.filter(id => id === item.id).length
    if (owned === 0) {
      ctx.reply(`❌ *You don't have any* *${item.name}* _in your inventory._`).catch(() => {})
      return player
    }

    const actualQty = Math.min(qty, owned)
    let removed = 0
    player.inventory = player.inventory.filter(id => {
      if (id === item.id && removed < actualQty) { removed++; return false }
      return true
    })
    for (let i = 0; i < actualQty; i++) chest.items.push(item.id)

    const shortLine = actualQty < qty ? `\n⚠️ _You only had ${owned}, stored ${actualQty}._` : ''
    ctx.reply(
      `🧰 *Stored!*\n\n` +
      `${rarityStars(item.rarity)} *${item.name}*${actualQty > 1 ? ` x${actualQty}` : ''}\n` +
      `_Safe from death until you take it back out._` +
      shortLine,
    ).catch(() => {})
    return player
  })
}

async function handleTake(ctx, args) {
  const p = config.prefix
  if (!args[1]) {
    return ctx.reply(`❌ *Usage:* *${p}chest take <item name or id> [qty]*`)
  }
  const { query, qty } = parseItemAndQty(args.slice(1))
  const item = findItem(query)
  if (!item) return ctx.reply(`❌ *Item* "_${query}_" *not recognized.*`)

  await updatePlayer(ctx.db, ctx.from, player => {
    const chest = ensureChest(player)
    if (!chest.unlocked) {
      ctx.reply(`🔒 You don't have a chest yet. Use *${p}chest* to see how to unlock one.`).catch(() => {})
      return player
    }

    const owned = chest.items.filter(id => id === item.id).length
    if (owned === 0) {
      ctx.reply(`❌ *You don't have any* *${item.name}* _in your chest._`).catch(() => {})
      return player
    }

    const actualQty = Math.min(qty, owned)
    if (!hasInventoryRoom(player, actualQty)) {
      ctx.reply(`❌ ${inventoryFullMessage(player)}\n_Can't take_ *${item.name} x${actualQty}* _— not enough room._`).catch(() => {})
      return player
    }

    let removed = 0
    chest.items = chest.items.filter(id => {
      if (id === item.id && removed < actualQty) { removed++; return false }
      return true
    })
    for (let i = 0; i < actualQty; i++) player.inventory.push(item.id)

    const shortLine = actualQty < qty ? `\n⚠️ _Chest only had ${owned}, took ${actualQty}._` : ''
    ctx.reply(
      `🎒 *Retrieved!*\n\n` +
      `${rarityStars(item.rarity)} *${item.name}*${actualQty > 1 ? ` x${actualQty}` : ''}\n` +
      `_Back in your inventory — at risk again if you die._` +
      shortLine,
    ).catch(() => {})
    return player
  })
}

// ── Plugin export ─────────────────────────────────────────────────────

export default {
  name:           'chest',
  aliases:        [],
  category:       'inventory',
  requiresPlayer: true,
  description:    `${config.prefix}chest — safe storage immune to death loss. ${config.prefix}chest buy solars|gems to unlock.`,

  async run(ctx) {
    const sub = ctx.args[0]?.toLowerCase()

    if (sub === 'buy')  return handleBuy(ctx, ctx.args)
    if (sub === 'put')  return handlePut(ctx, ctx.args)
    if (sub === 'take') return handleTake(ctx, ctx.args)

    return ctx.reply(statusView(ctx))
  },
}
