/**
 * pokeshop.js — Pokémon item shop (Pokémon overhaul §4.2).
 *
 * Mirrors plugins/shop.js's structure closely: browse by category, buy,
 * sell, and inspect. Pokémon items live in data/pokemon-items.json (§4.1)
 * and share the player's regular `inventory` array — they're tagged by the
 * `poke_` id prefix (see lib/game-data.js's convention note on how
 * weapons/items/tools/materials already coexist in one array) rather than
 * getting a second parallel inventory system. That means the shared
 * inventory cap (lib/inventory-limits.js) and .inventory listing both
 * already work for Pokémon items with zero extra plumbing.
 *
 * `.p-shop` (no args) shows a category picker, same UX shape as `.shop`.
 * Solars-priced and Gems-priced items are always shown in clearly separated
 * sections within a category — never interleaved — so the currency split
 * is obvious at a glance (§4.2's explicit requirement).
 *
 * Applying an item's effect to a Pokémon (mid-battle or out of battle) is
 * `.p-use <item> <mon>`, its own standalone plugin (plugins/p-use.js) —
 * short form since it gets called constantly under a 60s battle-turn
 * clock, same reasoning as `.move` being standalone instead of
 * `.pokemon move`. This file is buy/sell/browse/info only, matching how
 * plugins/shop.js never itself applies an item's effect either
 * (plugins/use.js does that for the general item system).
 *
 * Registered as `.p-shop` (short form — every Pokémon-system command uses
 * a `.p-<short>` primary name; `.pokeshop`/`.pshop`/`.pokestore` still work
 * as aliases).
 *
 * Commands:
 *   .p-shop                       — category picker + balance
 *   .p-shop battle [all]          — browse battle items
 *   .p-shop cosmetic [all]        — browse cosmetic items
 *   .p-shop buy <item> [qty]      — buy one or more items
 *   .p-shop sell <item> [qty]     — sell items from your inventory
 *   .p-shop info <item>           — view full details for any shop item
 */
import { config } from '../config.js'
import { fmtGems } from '../lib/format.js'
import { updatePlayer } from '../lib/player-repo.js'
import { createRequire } from 'module'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import { sendImage } from '../lib/image.js'
import { rarityStars, rarityLabel } from '../lib/rarity.js'

const require = createRequire(import.meta.url)
const pokemonItems = require('../data/pokemon-items.json')

// Banner shown behind every .p-shop reply — reuses the same image
// fallback contract sendImage() already provides (falls back to plain text
// if the file/remote source isn't found), same as plugins/shop.js's
// SHOP_BANNER. Drop pokeshop.jpg into ./images/ (or lib/image.js's IMAGES
// map) whenever it's ready; no code change needed either way.
const POKESHOP_BANNER = 'pokeshop.jpg'

const pokeItemMap = new Map(pokemonItems.map((i) => [i.id, i]))

function rarityEmoji(r) { return rarityStars(r) }

/** Find a Pokémon-shop item by exact id or case-insensitive partial name. */
function findPokeItem(query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return undefined
  if (pokeItemMap.has(q)) return pokeItemMap.get(q)
  // Also allow the query without the poke_ prefix, since players will
  // naturally type "oran_berry" or "oran berry", not "poke_oran_berry".
  const withPrefix = q.startsWith('poke_') ? q : `poke_${q.replace(/\s+/g, '_')}`
  if (pokeItemMap.has(withPrefix)) return pokeItemMap.get(withPrefix)
  for (const item of pokeItemMap.values()) {
    if (item.name.toLowerCase().includes(q)) return item
  }
  return undefined
}

// ── Category grouping ──────────────────────────────────────────────────
const CATEGORY_ORDER = ['battle', 'cosmetic']
const CATEGORY_LABEL = {
  battle:   '⚔️ *Battle Items*',
  cosmetic: '🎀 *Cosmetic Items*',
}

/** Splits a category's items into Solars vs Gems sections, each sorted by rarity (low→high, so browsing feels like a natural progression). */
const RARITY_SORT_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary']
function sortByRarityAsc(list) {
  return [...list].sort(
    (a, b) => RARITY_SORT_ORDER.indexOf(a.rarity) - RARITY_SORT_ORDER.indexOf(b.rarity),
  )
}

function splitByCurrency(list) {
  return {
    solars: sortByRarityAsc(list.filter((i) => i.currency === 'solars')),
    gems:   sortByRarityAsc(list.filter((i) => i.currency === 'gems')),
  }
}

// ── Formatters ────────────────────────────────────────────────────────

/**
 * One-line effect summary shown inline next to each item, mirroring
 * shop.js's potionBlurb() — including its array-of-effects handling, which
 * poke_battle_crown (the legendary combo-boost item) needs.
 */
function effectBlurb(item) {
  const e = item.effect
  if (!e) return item.description ?? ''
  const effects = Array.isArray(e) ? e : [e]
  const parts = effects.map((eff) => {
    if (eff.type === 'heal')       return eff.stat === 'pp' ? `restores PP` : `+${eff.amount} ${String(eff.stat ?? 'hp').toUpperCase()}`
    if (eff.type === 'cure')       return eff.targets === 'all' ? `cures all status` : `cures ${(eff.targets ?? []).join('/')}`
    if (eff.type === 'strengthen') return `+${eff.value} ${String(eff.stat ?? '?').toUpperCase()}`
    return eff.type
  })
  return parts.join(', ')
}

function priceTag(item) {
  return item.currency === 'gems' ? `💎 ${item.buyPrice}` : `☀️ ${item.buyPrice}`
}

function fmtItemLine(item) {
  return `${rarityEmoji(item.rarity)} *${item.name}* — ${effectBlurb(item)}\n     _${priceTag(item)}_`
}

function fmtCurrencySection(label, items) {
  if (!items.length) return ''
  return `${label}\n` + items.map(fmtItemLine).join('\n') + `\n`
}

// ── Browse ────────────────────────────────────────────────────────────

function handleCategory(categoryKey) {
  const list = pokemonItems.filter((i) => i.category === categoryKey)
  const { solars, gems } = splitByCurrency(list)
  const p = config.prefix

  const body =
    `${CATEGORY_LABEL[categoryKey] ?? categoryKey}\n\n` +
    fmtCurrencySection('☀️ *Solars*', solars) +
    (solars.length && gems.length ? `\n` : '') +
    fmtCurrencySection('💎 *Gems*', gems) +
    `\n🛒 *${p}p-shop buy <item> [qty]* — purchase\n` +
    `🔍 *${p}p-shop info <item>* — full details`

  return body
}

// ── Buy ───────────────────────────────────────────────────────────────

/** Pulls a trailing quantity off args (same convention as shop.js's handleSell). */
function extractQty(args) {
  const lastArg = args[args.length - 1]
  if (/^\d+$/.test(lastArg) && args.length > 2) {
    return { qty: Math.max(1, Math.min(99, parseInt(lastArg, 10))), queryParts: args.slice(1, -1) }
  }
  return { qty: 1, queryParts: args.slice(1) }
}

async function handleBuy(ctx, args) {
  const p = config.prefix
  if (!args[1]) {
    return ctx.reply(
      `❌ *Usage:* *${p}p-shop buy <item name or id> [quantity]*\n` +
      `_Example:_ *${p}p-shop buy oran_berry 3*`,
    )
  }

  const { qty, queryParts } = extractQty(args)
  const query = queryParts.join(' ')
  const item = findPokeItem(query)
  if (!item) {
    return ctx.reply(`❌ *Item* "_${query}_" *is not a known Pokémon-shop item.*`)
  }

  const totalCost = item.buyPrice * qty
  const currencyKey = item.currency === 'gems' ? 'gems' : 'solars'
  const currencyEmoji = item.currency === 'gems' ? '💎' : '☀️'

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    player.wallet = player.wallet ?? {}
    const balance = player.wallet[currencyKey] ?? 0
    if (balance < totalCost) { outcome = { ok: false, reason: 'funds', balance }; return }
    if (!hasInventoryRoom(player, qty)) { outcome = { ok: false, reason: 'full', player }; return }

    player.wallet[currencyKey] = balance - totalCost
    player.inventory = player.inventory ?? []
    for (let i = 0; i < qty; i++) player.inventory.push(item.id)

    outcome = { ok: true, remaining: player.wallet[currencyKey] }
  })

  if (!outcome?.ok) {
    if (outcome?.reason === 'funds') {
      const short = totalCost - outcome.balance
      return ctx.reply(
        `❌ *Not enough ${currencyKey === 'gems' ? 'Gems' : 'Solars'}!*\n` +
        `*${item.name}* × ${qty} costs ${currencyEmoji} *${totalCost}*.\n` +
        `You have ${currencyEmoji} *${outcome.balance}*. You need ${currencyEmoji} *${short}* more.`,
      )
    }
    if (outcome?.reason === 'full') {
      return ctx.reply(
        `❌ ${inventoryFullMessage(outcome.player)}\n` +
        `_Can't buy_ *${item.name} x${qty}* _— not enough room._`,
      )
    }
    return ctx.reply(`❌ Something went wrong with that purchase.`)
  }

  const qtyLine = qty > 1 ? ` × ${qty}` : ''
  return ctx.reply(
    `🛒 *Purchase complete!*\n\n` +
    `${rarityEmoji(item.rarity)} *${item.name}*${qtyLine}\n` +
    `💰 Paid: ${currencyEmoji} *${totalCost}*\n` +
    `💰 Remaining: ${currencyEmoji} *${outcome.remaining}*\n\n` +
    `_Added to your inventory. Use *${p}inventory* to view, or_ *${p}p-use ${item.id} <mon>* _to use it._`,
  )
}

// ── Sell ──────────────────────────────────────────────────────────────

async function handleSell(ctx, args) {
  const p = config.prefix
  if (!args[1]) {
    return ctx.reply(
      `❌ *Usage:* *${p}p-shop sell <item name or id> [quantity]*\n` +
      `_Example:_ *${p}p-shop sell oran_berry 3*`,
    )
  }

  const { qty, queryParts } = extractQty(args)
  const query = queryParts.join(' ')
  const item = findPokeItem(query)
  if (!item) {
    return ctx.reply(`❌ *Item* "_${query}_" *is not a known Pokémon-shop item.*`)
  }
  if (item.sellPrice == null) {
    return ctx.reply(`❌ *${item.name}* can't be sold back.`)
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    player.inventory = player.inventory ?? []
    const owned = player.inventory.filter((id) => id === item.id).length
    if (owned === 0) { outcome = { ok: false, reason: 'none' }; return }

    const actualQty = Math.min(qty, owned)
    const earnings = item.sellPrice * actualQty

    let removed = 0
    player.inventory = player.inventory.filter((id) => {
      if (id === item.id && removed < actualQty) { removed++; return false }
      return true
    })
    player.wallet = player.wallet ?? {}
    player.wallet.solars = (player.wallet.solars ?? 0) + earnings

    outcome = { ok: true, actualQty, owned, earnings, balance: player.wallet.solars }
  })

  if (!outcome?.ok) {
    return ctx.reply(`❌ *You don't have any* *${item.name}* _in your inventory._`)
  }

  const qtyLine = outcome.actualQty > 1 ? ` × ${outcome.actualQty}` : ''
  const shortLine = outcome.actualQty < qty
    ? `\n⚠️ _You only had ${outcome.owned}, sold ${outcome.actualQty}._`
    : ''

  return ctx.reply(
    `💰 *Sold!*\n\n` +
    `${rarityEmoji(item.rarity)} *${item.name}*${qtyLine}\n` +
    `💰 Earned: ☀️ *${outcome.earnings}*\n` +
    `💰 Balance: ☀️ *${outcome.balance}*` +
    shortLine,
  )
}

// ── Info ──────────────────────────────────────────────────────────────

function fmtDetails(item) {
  const currencyEmoji = item.currency === 'gems' ? '💎' : '☀️'
  const sellLine = item.sellPrice != null ? `\n💰 *Sells for:* ☀️ ${item.sellPrice}` : `\n💰 _Cannot be sold._`
  return (
    `${rarityEmoji(item.rarity)} *${item.name}*\n\n` +
    `${item.description}\n\n` +
    `📦 *Category:* ${item.category === 'battle' ? 'Battle Item' : 'Cosmetic'}\n` +
    `💵 *Price:* ${currencyEmoji} ${item.buyPrice}` +
    sellLine +
    (item.usableInBattle ? `\n⚔️ _Usable mid-battle via_ *${config.prefix}p-use*` : '')
  )
}

function handleInfo(args) {
  const query = args.slice(1).join(' ')
  const item = findPokeItem(query)
  if (!item) return { text: `❌ *Item* "_${query}_" *not found in the Pokémon shop.*`, item: null }
  return { text: fmtDetails(item), item }
}

// ── Main menu ─────────────────────────────────────────────────────────

function mainMenu(player) {
  const p = config.prefix
  const solars = player.wallet?.solars ?? 0
  const gems   = player.wallet?.gems   ?? 0
  return (
    `┏━━━━━━━━━━━━━━┓\n` +
    `┃  🐾 *POKÉ SHOP* 🐾\n` +
    `┗━━━━━━━━━━━━━━┛\n` +
    `_Berries, potions, and flair for your Pokémon._\n\n` +
    `💰 ☀️ *${solars}* Solars   ·   💎 *${fmtGems(gems)}* Gems\n\n` +
    `📦 *Browse:*\n` +
    `   ⚔️ *${p}p-shop battle* — _berries, potions, boosters_\n` +
    `   🎀 *${p}p-shop cosmetic* — _ribbons, titles, flair_\n\n` +
    `🛒 *${p}p-shop buy <item> [qty]* — _purchase_\n` +
    `💰 *${p}p-shop sell <item> [qty]* — _sell from bag_\n` +
    `🔍 *${p}p-shop info <item>* — _full item details_`
  )
}

// ── Plugin export ─────────────────────────────────────────────────────

export default {
  name:           'p-shop',
  aliases:        ['pokeshop', 'pshop', 'pokestore'],
  category:       'pokemon',
  requiresPlayer: true,
  description:    'Browse and buy Pokémon battle items and cosmetics',
  subcommands: [
    { cmd: '',                    desc: 'category picker + balance' },
    { cmd: 'battle',               desc: 'browse battle items' },
    { cmd: 'cosmetic',             desc: 'browse cosmetic items' },
    { cmd: 'buy <item> [qty]',     desc: 'purchase an item' },
    { cmd: 'sell <item> [qty]',    desc: 'sell an item from your inventory' },
    { cmd: 'info <item>',          desc: 'view full item details' },
  ],

  async run(ctx) {
    const { args, player } = ctx
    const sub = args[0]?.toLowerCase()

    if (!sub)                    return sendImage(ctx, POKESHOP_BANNER, mainMenu(player))
    if (sub === 'battle')        return sendImage(ctx, POKESHOP_BANNER, handleCategory('battle'))
    if (sub === 'cosmetic')      return sendImage(ctx, POKESHOP_BANNER, handleCategory('cosmetic'))
    if (sub === 'buy' || sub === 'purchase') return handleBuy(ctx, args)
    if (sub === 'sell')          return handleSell(ctx, args)
    if (sub === 'info' || sub === 'inspect') {
      const { text, item } = handleInfo(args)
      if (!item) return sendImage(ctx, POKESHOP_BANNER, text)
      return sendImage(ctx, item.image || `https://play.astral.qzz.io/assets/items/${item.id}.jpg`,
        `*${item.name}*\n${rarityEmoji(item.rarity)} ${rarityLabel(item.rarity)} · ${item.currency === 'gems' ? '💎' : '☀️'}${item.buyPrice}\n\n${text}`)
    }

    return sendImage(
      ctx, POKESHOP_BANNER,
      `❌ *Unknown p-shop command* "_${sub}_".\n\n` + mainMenu(player),
    )
  },
}
