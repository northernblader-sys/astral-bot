/**
 * gm.js — Game Shop. A separate, gem-only storefront from .shop (which
 * sells weapons/armor/potions for Solars). Two sections:
 *
 *   Relics     — offhand relics (Totem of Undying + 5 new ones) from
 *                data/items.json, added to inventory like any other item.
 *   Stat Packs — three tiers of one-time permanent stat boosts, rolled at
 *                purchase and scattered randomly across STR/AGI/INT/DEF/LCK.
 *                Rules and maths live in lib/stat-packs.js.
 *   Offers     — Naira-priced gem bundles, distinct from the permanent
 *                data/topup-packages.json list. Reuses topup.js's existing
 *                player.topupPending + screenshot-confirmation flow, so
 *                .topup confirm/reject (owner-only) work on these too.
 *
 * Abilities used to be sold here too, but the standalone ability system
 * (.ability/.useability/data/abilities.json) was removed — abilities now
 * come from equipping a character (see plugins/character.js).
 *
 * Usage:
 *   .gm                          — section overview
 *   .gm relics                   — browse relics
 *   .gm statpacks                — browse Stat Pack Boosts
 *   .gm offers                   — browse Naira gem bundles
 *   .gm buy <name>                — buy a relic or a stat pack (gems)
 *   .gm buy offer <offer id>     — start a Naira offer purchase (DM only)
 *   .gm info <name>               — full detail view for any listing
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
import { config } from '../config.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { updatePlayer } from '../lib/player-repo.js'
import { allItems, topupPackages } from '../lib/game-data.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import { rarityStars } from '../lib/rarity.js'
import { sendImage } from '../lib/image.js'
import { ensureStatPoints } from '../lib/stat-progression.js'
import {
  statPacks, findStatPack, ownsStatPack, applyStatPack, formatStatPackGains,
} from '../lib/stat-packs.js'
const gameShop = require('../data/game-shop.json')

const relicItemMap = Object.fromEntries(
  gameShop.relics.map(r => [r.id, { ...allItems.find(i => i.id === r.id), gemPrice: r.gemPrice }]),
)

function findRelic(query) {
  const q = query.toLowerCase().trim().replace(/\s+/g, '_')
  return relicItemMap[q] ?? Object.values(relicItemMap).find(r => r.name.toLowerCase() === query.toLowerCase().trim())
}

function findOffer(query) {
  const q = query.toLowerCase().trim()
  return topupPackages.gemPackages.find(o => o.id === q)
}

// ── Overview ─────────────────────────────────────────────────────────────

function overview(pr) {
  return (
    `🏪 *Game Shop* — gem-only storefront\n\n` +
    `🗿 *Relics* — offhand relics (${pr}gm relics)\n` +
    `📊 *Stat Packs* — one-time permanent stat boosts (${pr}gm statpacks)\n` +
    `💎 *Offers* — Naira gem bundles (${pr}gm offers)\n\n` +
    `Buy with *${pr}gm buy <name>* · Details with *${pr}gm info <name>*.`
  )
}

// ── Section listings ────────────────────────────────────────────────────

function listRelics(pr) {
  const lines = Object.values(relicItemMap).map(r =>
    `  • ${rarityStars(r.rarity)} *${r.name}* — 💎${r.gemPrice}`,
  )
  return (
    `🗿 *Relics* — offhand slot\n\n${lines.join('\n')}\n\n` +
    `Buy with *${pr}gm buy <relic name>*. Details with *${pr}gm info <relic name>*.`
  )
}

/**
 * Stat Packs listing. Shows the tier band rather than a fixed number because
 * the roll happens at purchase, and marks the tiers this player has already
 * used up — each is a once-per-player buy.
 */
function listStatPacks(pr, player) {
  const lines = statPacks.map((p) => {
    const owned = ownsStatPack(player, p.id)
    return (
      `  • ${owned ? '✅' : '📊'} *${p.name}* — 💎${p.gemPrice}\n` +
      `      _${p.min}–${p.max} stat points, split randomly_${owned ? ' · *already owned*' : ''}`
    )
  })
  return (
    `📊 *Stat Pack Boosts* — permanent, one purchase each\n\n${lines.join('\n')}\n\n` +
    `Opening a pack rolls a total inside its band and scatters it across your stats — ` +
    `a 50 roll might land as 💪+30 🏃+10 🍀+10.\n\n` +
    `Buy with *${pr}gm buy <pack name>* _(e.g. *${pr}gm buy stat pack low*)_. ` +
    `Details with *${pr}gm info <pack name>*.`
  )
}

function listOffers(pr) {
  const lines = topupPackages.gemPackages.map(o =>
    `  • *${o.id}* — 💎${o.gems} for ₦${o.priceNaira.toLocaleString()}`,
  )
  return (
    `💎 *Offers* — Naira gem bundles _(same catalog as ${pr}topup)_\n\n${lines.join('\n')}\n\n` +
    `Buy with *${pr}gm buy offer <offer id>* _(DM only)_. Same flow as *${pr}topup buy* — either command works.`
  )
}

// ── Info ─────────────────────────────────────────────────────────────────

async function handleInfo(ctx, query) {
  const pr = config.prefix
  if (!query) return ctx.reply(`❌ *Usage:* *${pr}gm info <name>*`)

  const relic = findRelic(query)
  if (relic) {
    return ctx.reply(
      `${rarityStars(relic.rarity)} *${relic.name}*\n\n${relic.description}\n\n` +
      `💎 *${relic.gemPrice}* Gems · Slot: ${relic.slot}\n` +
      `Buy with *${pr}gm buy ${relic.name}*.`,
    )
  }

  const pack = findStatPack(query)
  if (pack) {
    const owned = ownsStatPack(ctx.player, pack.id)
    return ctx.reply(
      `📊 *${pack.name}*\n\n` +
      `Rolls *${pack.min}–${pack.max}* stat points and splits them randomly across ` +
      `💪 STR · 🏃 AGI · 🧠 INT · 🛡️ DEF · 🍀 LCK.\n` +
      `The boost is permanent and does not use your level-up stat points.\n\n` +
      `💎 *${pack.gemPrice}* Gems · *one purchase per player*\n` +
      (owned
        ? `✅ _You already opened this pack._`
        : `Buy with *${pr}gm buy ${pack.tier}*.`),
    )
  }

  const offer = findOffer(query)
  if (offer) {
    return ctx.reply(
      `💎 *${offer.id}*\n\n` +
      `💎${offer.gems} Gems for ₦${offer.priceNaira.toLocaleString()}\n` +
      `Buy with *${pr}gm buy offer ${offer.id}* _(DM only)_.`,
    )
  }

  return ctx.reply(`❌ *"${query}"* not found in the Game Shop. Browse with *${pr}gm*.`)
}

// ── Buy ──────────────────────────────────────────────────────────────────

async function buyRelic(ctx, relic) {
  const pr = config.prefix
  let outcome = null

  await updatePlayer(ctx.db, ctx.from, player => {
    const gems = player.wallet?.gems ?? 0
    if (gems < relic.gemPrice) {
      outcome = { ok: false, reason: 'gems', gems }
      return
    }
    if (!hasInventoryRoom(player, 1)) {
      outcome = { ok: false, reason: 'full', player }
      return
    }
    player.wallet.gems = roundGems(gems - relic.gemPrice)
    player.inventory = player.inventory ?? []
    player.inventory.push(relic.id)
    outcome = { ok: true, remaining: player.wallet.gems }
  })

  if (outcome.reason === 'gems') {
    return ctx.reply(
      `❌ *Not enough Gems!*\n*${relic.name}* costs 💎*${relic.gemPrice}*.\nYou have 💎*${fmtGems(outcome.gems)}*.`,
    )
  }
  if (outcome.reason === 'full') {
    return ctx.reply(`❌ ${inventoryFullMessage(outcome.player)}\n_Can't buy_ *${relic.name}* _— not enough room._`)
  }
  return ctx.reply(
    `🛒 *Purchase complete!*\n\n${rarityStars(relic.rarity)} *${relic.name}*\n💰 Paid: 💎*${relic.gemPrice}*\n💰 Remaining: 💎*${outcome.remaining}*\n\n` +
    `_Added to your inventory. Equip with *${pr}equip ${relic.name}*._`,
  )
}

/**
 * Stat Pack Boost — gems for a permanent, randomly-split stat gain. Once per
 * pack per player, so the ownership check has to live inside the updatePlayer()
 * mutator alongside the gem check: two .gm buy commands racing each other must
 * not both see "not owned yet" and hand out the boost twice.
 */
async function buyStatPack(ctx, pack) {
  const pr = config.prefix
  let outcome = null

  await updatePlayer(ctx.db, ctx.from, player => {
    if (ownsStatPack(player, pack.id)) {
      outcome = { ok: false, reason: 'owned' }
      return
    }
    const gems = player.wallet?.gems ?? 0
    if (gems < pack.gemPrice) {
      outcome = { ok: false, reason: 'gems', gems }
      return
    }
    // An unmigrated save may have no baseStats for the boost to land in, and
    // the migration reads the pack bonus — so it has to run before the boost
    // is written, not after.
    ensureStatPoints(player)
    player.wallet.gems = roundGems(gems - pack.gemPrice)
    const roll = applyStatPack(player, pack)
    outcome = { ok: true, roll, remaining: player.wallet.gems, stats: { ...player.stats } }
  })

  if (outcome.reason === 'owned') {
    return ctx.reply(
      `❌ *You've already opened the ${pack.name}.*\n` +
      `_Each Stat Pack Boost can only be bought once._ Browse the others with *${pr}gm statpacks*.`,
    )
  }
  if (outcome.reason === 'gems') {
    return ctx.reply(
      `❌ *Not enough Gems!*\n*${pack.name}* costs 💎*${pack.gemPrice}*.\nYou have 💎*${fmtGems(outcome.gems)}*.`,
    )
  }

  const { roll, stats } = outcome
  return ctx.reply(
    `🎁 *${pack.name} opened!*\n\n` +
    `📊 Rolled *+${roll.total}* stat points:\n` +
    `${formatStatPackGains(roll.gains, '\n')}\n\n` +
    `💪 STR ${stats.str}  🏃 AGI ${stats.agi}  🧠 INT ${stats.int}  🛡️ DEF ${stats.def}  🍀 LCK ${stats.lck}\n\n` +
    `💰 Paid: 💎*${pack.gemPrice}*  ·  Remaining: 💎*${fmtGems(outcome.remaining)}*\n` +
    `_Permanent boost — it won't be lost on level up or death._`,
  )
}

async function buyOffer(ctx, offerId) {
  const pr = config.prefix
  if (ctx.isGroup) {
    return ctx.reply(`💬 DM me *${pr}gm buy offer ${offerId}* to see payment details.`)
  }
  const offer = findOffer(offerId)
  if (!offer) return ctx.reply(`❌ Unknown offer *"${offerId}"*. Browse with *${pr}gm offers*.`)

  // Same pending-purchase shape topup.js's handleBuy() writes — package id
  // matches a real entry in data/topup-packages.json, not a gm-prefixed
  // synthetic id. That's what lets .topup confirm / lib/pending-purchase.js's
  // screenshot flow treat a .gm-bought offer identically to a .topup one;
  // .gm offers is just a second doorway into the same catalog and flow.
  await updatePlayer(ctx.db, ctx.from, p => {
    p.topupPending = { packageId: offer.id, gems: offer.gems, state: 'awaiting_screenshot' }
  })

  const pay = config.payment
  return ctx.reply(
    `💎 *${offer.gems} Gems* — ₦${offer.priceNaira.toLocaleString()}\n\n` +
    `💳 *Payment Details:*\n` +
    `  🏦 Bank: *${pay.bankName || '(not configured)'}*\n` +
    `  🔢 Account: *${pay.accountNumber || '(not configured)'}*\n` +
    `  👤 Name: *${pay.accountName || '(not configured)'}*\n\n` +
    `📸 Once paid, send a screenshot of the transfer *right here in this DM* to confirm.`,
  )
}

async function handleBuy(ctx, args) {
  const pr = config.prefix
  if (!args[1]) return ctx.reply(`❌ *Usage:* *${pr}gm buy <name>*`)

  if (args[1].toLowerCase() === 'offer') {
    return buyOffer(ctx, args[2] ?? '')
  }

  const query = args.slice(1).join(' ')

  const pack = findStatPack(query)
  if (pack) return buyStatPack(ctx, pack)

  const relic = findRelic(query)
  if (relic) return buyRelic(ctx, relic)

  return ctx.reply(`❌ *"${query}"* not found in the Game Shop. Browse with *${pr}gm*.`)
}

// ── Main plugin export ──────────────────────────────────────────────────

export default {
  name: 'gm',
  aliases: ['gameshop'],
  category: 'town',
  requiresPlayer: true,
  description: `${config.prefix}gm — Game Shop: relics, stat packs and offers (gems)`,

  async run(ctx) {
    const { args } = ctx
    const pr = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    if (sub === 'buy')  return handleBuy(ctx, args)
    if (sub === 'info') return handleInfo(ctx, args.slice(1).join(' '))

    if (sub === 'relics'     || sub === 'relic')                        return ctx.reply(listRelics(pr))
    if (sub === 'statpacks'  || sub === 'statpack' || sub === 'packs'
                             || sub === 'pack'     || sub === 'stats')  return ctx.reply(listStatPacks(pr, ctx.player))
    if (sub === 'offers'     || sub === 'offer')                        return ctx.reply(listOffers(pr))

    return sendImage(ctx, gameShop.bannerImage, overview(pr))
  },
}
