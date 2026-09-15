/**
 * pack.js — Season Packs. A gem-only storefront for the themed loadout packs
 * in data/season-packs.json. Each pack grants:
 *
 *   • its armor set (items[]) and, for some, a matching weapon
 *   • a title shown next to your name (player.title)
 *   • ONE signature combat effect, live only while the pack is equipped
 *
 * The signature is a snapshot on player.activePackSignature, read by the combat
 * hit-sites and absorbDamage/calcPlayerDamage (lib/premium-abilities.js +
 * lib/combat-engine.js) and by the death-save path (lib/combat-handlers.js,
 * undying_flourish). Owned packs live in player.ownedPacks[]; player.activePack
 * holds the currently equipped one. Buying is repeatable: it re-grants the gear
 * and re-equips the signature.
 *
 * The Totem Pack is the one exception that "adds NO new gear" — it bundles the
 * existing death-save relics as flavor and only hands over the title + the
 * Undying Flourish signature. Its items[] point at relics that live in the main
 * items catalog, not the season-pack catalog, so the grant filter below skips
 * them automatically.
 *
 * Usage:
 *   .pack                     — browse every season pack
 *   .pack info <name|id>      — full detail for one pack
 *   .pack buy <name|id>       — buy it with gems (grants gear + title, equips signature)
 *   .pack equip <name|id>     — switch to a pack you already own
 *   .pack unequip             — put the active signature and title away
 */
import { config } from '../config.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { updatePlayer } from '../lib/player-repo.js'
import { seasonPacks, seasonPackItems, allItems } from '../lib/game-data.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import { rarityStars } from '../lib/rarity.js'
import { sendImage } from '../lib/image.js'

// Defensive: every real entry has an id; the leading _comment-only shapes (if
// any) are filtered out so lookups never trip over them.
const SEASON_PACKS = seasonPacks.filter((p) => p && p.id)
const PACK_BY_ID = Object.fromEntries(SEASON_PACKS.map((p) => [p.id, p]))

// Only ids that live in the season-pack catalog are grantable gear. The Totem
// Pack's relics aren't here, so buying it grants no items — exactly as intended.
const SEASON_ITEM_IDS = new Set(seasonPackItems.map((i) => i.id))
const ITEM_BY_ID = new Map(allItems.map((i) => [i.id, i]))

const itemName = (id) => ITEM_BY_ID.get(id)?.name ?? id
const grantableItems = (pack) => (pack.items ?? []).filter((id) => SEASON_ITEM_IDS.has(id))

function findPack(query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return null
  const kebab = q.replace(/\s+/g, '_')
  return (
    PACK_BY_ID[kebab] ??
    SEASON_PACKS.find((p) => p.name.toLowerCase() === q) ??
    SEASON_PACKS.find((p) => p.name.toLowerCase().includes(q))
  )
}

function isBusyInBattle(player) {
  return !!(player.inBattle || player.battleState?.type === 'pvp')
}

// ── Listings ──────────────────────────────────────────────────────────────

function overview(pr, player) {
  const owned = new Set(player.ownedPacks ?? [])
  const active = player.activePack
  const lines = SEASON_PACKS.map((p) => {
    const mark = p.id === active ? '🟢' : owned.has(p.id) ? '✅' : '🔹'
    return (
      `${mark} ${p.title} · 💎${p.gemPrice}\n` +
      `      _${p.signatureDesc}_`
    )
  })
  return (
    `🎁 *Season Packs* — gem-only loadouts\n\n${lines.join('\n')}\n\n` +
    `🟢 equipped · ✅ owned\n` +
    `Detail with *${pr}pack info <name>* · buy with *${pr}pack buy <name>*.\n` +
    `Switch a pack you own with *${pr}pack equip <name>*.`
  )
}

async function handleInfo(ctx, query) {
  const pr = config.prefix
  if (!query) return ctx.reply(`❌ *Usage:* *${pr}pack info <name>*`)

  const pack = findPack(query)
  if (!pack) {
    return ctx.reply(`❌ *"${query}"* is not a season pack. Browse them with *${pr}pack*.`)
  }

  const owned = (ctx.player.ownedPacks ?? []).includes(pack.id)
  const active = ctx.player.activePack === pack.id

  const gearIds = grantableItems(pack)
  const gearLines = gearIds.length
    ? gearIds
        .map((id) => {
          const it = ITEM_BY_ID.get(id)
          const tag = pack.weapon === id ? ' _(weapon)_' : ''
          return `  • ${rarityStars(it?.rarity ?? 'legendary')} *${itemName(id)}*${tag}`
        })
        .join('\n')
    : `  • _No new gear. This pack is the title and its signature._`

  const state = active
    ? `🟢 *Equipped now.*`
    : owned
      ? `✅ *Owned.* Equip it with *${pr}pack equip ${pack.id}*.`
      : `Buy it with *${pr}pack buy ${pack.id}*.`

  const caption =
    `${pack.title}\n\n` +
    `_${pack.flavor}_\n\n` +
    `✨ *Signature*\n${pack.signatureDesc}\n\n` +
    `🎽 *Set*\n${gearLines}\n\n` +
    `🏷️ *Title:* ${pack.title}\n` +
    `💎 *${pack.gemPrice}* Gems\n\n` +
    `${state}`

  return sendImage(ctx, pack.image, caption)
}

// ── Buy / equip / unequip ───────────────────────────────────────────────────

function equipSignatureOnto(player, pack) {
  player.ownedPacks = Array.isArray(player.ownedPacks) ? player.ownedPacks : []
  if (!player.ownedPacks.includes(pack.id)) player.ownedPacks.push(pack.id)
  player.activePack = pack.id
  player.activePackSignature = { ...pack.signature }
  player.title = pack.title
}

async function handleBuy(ctx, query) {
  const pr = config.prefix
  const pack = findPack(query)
  if (!pack) {
    return ctx.reply(`❌ *"${query}"* is not a season pack. Browse them with *${pr}pack*.`)
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    if (isBusyInBattle(player)) {
      outcome = { reason: 'battle' }
      return
    }
    const gems = player.wallet?.gems ?? 0
    if (gems < pack.gemPrice) {
      outcome = { reason: 'gems', gems }
      return
    }
    const gearIds = grantableItems(pack)
    if (gearIds.length && !hasInventoryRoom(player, gearIds.length)) {
      outcome = { reason: 'full', player }
      return
    }

    player.wallet = player.wallet ?? {}
    player.wallet.gems = roundGems(gems - pack.gemPrice)
    player.inventory = player.inventory ?? []
    for (const id of gearIds) player.inventory.push(id)
    equipSignatureOnto(player, pack)

    outcome = { reason: 'ok', remaining: player.wallet.gems, gearIds }
  })

  if (outcome.reason === 'battle') {
    return ctx.reply(`⚔️ *Finish your battle first.* You can't change packs mid-fight.`)
  }
  if (outcome.reason === 'gems') {
    return ctx.reply(
      `❌ *Not enough Gems!*\n${pack.title} costs 💎*${pack.gemPrice}*.\nYou have 💎*${fmtGems(outcome.gems)}*.`,
    )
  }
  if (outcome.reason === 'full') {
    return ctx.reply(`❌ ${inventoryFullMessage(outcome.player)}\n_Can't buy_ ${pack.title} _right now._`)
  }

  const gearLine = outcome.gearIds.length
    ? `🎽 Added to your bag: ${outcome.gearIds.map(itemName).join(', ')}.\n` +
      `_Equip the set with *${pr}equip <item>*` +
      (pack.weapon ? ` and *${pr}equip ${itemName(pack.weapon)}*` : '') + `._\n`
    : `🗿 No new gear, this pack is its title and signature.\n`

  return ctx.reply(
    `🛒 *Purchase complete!*\n\n${pack.title}\n` +
    `💰 Paid: 💎*${pack.gemPrice}*  ·  Remaining: 💎*${fmtGems(outcome.remaining)}*\n\n` +
    gearLine +
    `✨ *${pack.signatureDesc}*\n` +
    `🏷️ Title set to ${pack.title}. Signature is live now.`,
  )
}

async function handleEquip(ctx, query) {
  const pr = config.prefix
  const pack = findPack(query)
  if (!pack) {
    return ctx.reply(`❌ *"${query}"* is not a season pack. Browse them with *${pr}pack*.`)
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    if (isBusyInBattle(player)) {
      outcome = { reason: 'battle' }
      return
    }
    if (!(player.ownedPacks ?? []).includes(pack.id)) {
      outcome = { reason: 'unowned' }
      return
    }
    if (player.activePack === pack.id) {
      outcome = { reason: 'already' }
      return
    }
    equipSignatureOnto(player, pack)
    outcome = { reason: 'ok' }
  })

  if (outcome.reason === 'battle') {
    return ctx.reply(`⚔️ *Finish your battle first.* You can't change packs mid-fight.`)
  }
  if (outcome.reason === 'unowned') {
    return ctx.reply(`❌ You don't own ${pack.title} yet. Buy it with *${pr}pack buy ${pack.id}*.`)
  }
  if (outcome.reason === 'already') {
    return ctx.reply(`🟢 ${pack.title} is already your active pack.`)
  }
  return ctx.reply(
    `🟢 *${pack.title} equipped.*\n` +
    `✨ *${pack.signatureDesc}*\n` +
    `🏷️ Title set to ${pack.title}.`,
  )
}

async function handleUnequip(ctx) {
  const pr = config.prefix
  let outcome = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    if (isBusyInBattle(player)) {
      outcome = { reason: 'battle' }
      return
    }
    if (!player.activePack) {
      outcome = { reason: 'none' }
      return
    }
    const pack = PACK_BY_ID[player.activePack]
    // Only clear the title if it's still the one this pack set, so we never
    // wipe a title the player picked up somewhere else in the meantime.
    if (pack && player.title === pack.title) player.title = null
    player.activePack = null
    player.activePackSignature = null
    outcome = { reason: 'ok', name: pack?.title ?? 'Your pack' }
  })

  if (outcome.reason === 'battle') {
    return ctx.reply(`⚔️ *Finish your battle first.* You can't change packs mid-fight.`)
  }
  if (outcome.reason === 'none') {
    return ctx.reply(`ℹ️ You have no season pack equipped. Equip one with *${pr}pack equip <name>*.`)
  }
  return ctx.reply(`⚪ *${outcome.name} put away.* Its signature and title are off.`)
}

// ── Main plugin export ──────────────────────────────────────────────────────

export default {
  name: 'pack',
  category: 'packs',
  requiresPlayer: true,
  description: `${config.prefix}pack — Season Packs: gem loadouts with a signature effect`,

  async run(ctx) {
    const { args } = ctx
    const pr = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    if (sub === 'buy') return handleBuy(ctx, args.slice(1).join(' '))
    if (sub === 'info') return handleInfo(ctx, args.slice(1).join(' '))
    if (sub === 'equip' || sub === 'use' || sub === 'wear') return handleEquip(ctx, args.slice(1).join(' '))
    if (sub === 'unequip' || sub === 'remove' || sub === 'off') return handleUnequip(ctx)

    // Browse view: the general Season Packs banner over the full list. Each
    // pack's own art shows on `.pack info <id>` (handleInfo).
    return sendImage(ctx, 'pack-overview.jpg', overview(pr, ctx.player))
  },
}
