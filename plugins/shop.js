/**
 * shop.js — Item and weapon shop.
 *
 * Every browse/info screen is sent with the shop.jpg banner image
 * (see lib/image.js's sendImage) — drop shop.jpg into ./images/.
 * Falls back to plain text automatically if the file isn't there.
 *
 * Commands:
 *   .shop                        — show categories + your balance
 *   .shop weapons [all]          — browse weapons (filtered to your level by default)
 *   .shop armor [all]            — browse armor (helmets, chestplates, boots)
 *   .shop potions                — browse consumables
 *   .shop buy <item> [qty]       — buy one or more items
 *   .shop sell <item> [qty]      — sell items from your inventory
 *   .shop info <item>            — view full details for any shop item
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import { getModValue } from '../lib/mods.js'
import { sendImage } from '../lib/image.js'
import { rarityStars, rarityLabel } from '../lib/rarity.js'
import { findPack } from '../lib/skill-pack-engine.js'
// The End event's old woman — `.shop buy blue band` is a riddle, not a sale
// (blue_band has no buyPrice, so it can never reach the catalog path below).
import {
  isEventActive, hasBlueBand, BLUE_BAND_ID, ASTRAL_TOWN_ID,
  RIDDLE_QUESTION, RIDDLE_WRONG, RIDDLE_ALREADY_BANDED,
} from '../lib/end-event.js'
// What's for sale and how the shelves are divided — shared with the website's
// Shop page (lib/api-server.js's /api/shop) so the two can't drift.
import {
  shopWeapons, shopItems, shopTools, findInCatalog,
  groupByRarity, groupBySlot, groupPotions, potionBlurb,
  RARITY_GROUP_ORDER, ARMOR_SLOT_ORDER,
  ABILITY_SLOT_GEM_PRICE, ABILITY_SLOT_ALIASES,
} from '../lib/shop-catalog.js'

// Banner shown behind every .shop reply — direct URL now (previously a
// filename resolved via lib/image.js's map).
const SHOP_BANNER = 'https://i.ibb.co/CpS1wXM9/astral-shop.jpg'
// Dedicated art for the ARMOR shelf — `.shop armor` is the one category that
// gets its own image (see the 2026-09-21 art drop, lib/image.js).
const ARMOR_SHOP_BANNER = 'https://i.ibb.co/6RgWqj7f/armor-shop.jpg'

// ── Rarity display ────────────────────────────────────────────────────

function rarityEmoji(r) { return rarityStars(r) }

// ── Shelf labels ──────────────────────────────────────────────────────
// The grouping itself lives in lib/shop-catalog.js (shared with the site);
// only the WhatsApp-markup labels are local.

const POTION_GROUP_DISPLAY = {
  healing:  { label: '❤️ *Healing & Mana*',   emoji: '🧪' },
  mana:     { label: '💙 *Mana Restore*',     emoji: '🔮' },
  stamina:  { label: '🏃 *Stamina Restore*',  emoji: '🏃' },
  elixirs:  { label: '✨ *Elixirs & Revival*', emoji: '🌟' },
  cures:    { label: '💚 *Status Cures*',     emoji: '🩹' },
  buffs:    { label: '⚡ *Buffs & Shields*',  emoji: '🛡️' },
  other:    { label: '📦 *Other*',            emoji: '📦' },
}

const RARITY_LABEL = Object.fromEntries(
  RARITY_GROUP_ORDER.map((r) => [r, `${rarityStars(r)} *${rarityLabel(r)}*`]),
)

const ARMOR_SLOT_LABEL = {
  helmet:     '🪖 *Helmets*',
  chestplate: '👕 *Chestplates*',
  boots:      '👢 *Boots*',
  offhand:    '🎗️ *Offhand*',
}

/** Attaches the WhatsApp label/emoji to each shelf returned by the shared grouper. */
function labelled(groups, labels, fallbackEmoji) {
  return groups.map(g => {
    const display = labels[g.key]
    return {
      ...g,
      label: typeof display === 'string' ? display : (display?.label ?? `📦 *${g.key}*`),
      emoji: display?.emoji ?? fallbackEmoji,
    }
  })
}

// ── Pagination ──────────────────────────────────────────────────────────
const PAGE_SIZE = 10

function paginate(list, page) {
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
  const clamped    = Math.min(Math.max(1, page), totalPages)
  const start      = (clamped - 1) * PAGE_SIZE
  return { pageItems: list.slice(start, start + PAGE_SIZE), page: clamped, totalPages }
}

/** Pulls a trailing "page N" or bare number off args, returns { page, rest }. */
function extractPage(args) {
  const parts = [...args]
  let page = 1
  const pageIdx = parts.findIndex((a) => a?.toLowerCase() === 'page')
  if (pageIdx !== -1 && parts[pageIdx + 1] && /^\d+$/.test(parts[pageIdx + 1])) {
    page = parseInt(parts[pageIdx + 1], 10)
    parts.splice(pageIdx, 2)
  } else if (/^\d+$/.test(parts[parts.length - 1] ?? '')) {
    page = parseInt(parts[parts.length - 1], 10)
    parts.pop()
  }
  return { page, rest: parts }
}

// ── Catalog helpers ───────────────────────────────────────────────────
// shopWeapons / shopItems / shopTools / findInCatalog now come from
// lib/shop-catalog.js — see the import block at the top.

/** Returns items available for a player's level, with optional overflow. */
function filteredByLevel(list, playerLevel, showAll = false) {
  if (showAll) return list
  const LEVEL_BUFFER = 10
  return list.filter(i => i.levelReq <= playerLevel + LEVEL_BUFFER)
}

// ── Formatters ────────────────────────────────────────────────────────

function fmtWeaponLine(w) {
  const lvl = w.levelReq > 1 ? `Lv.${w.levelReq}` : `Lv.1`
  return `${rarityEmoji(w.rarity)} *${w.name}*\n     _${lvl} · ☀️ ${w.buyPrice} Solars_`
}

function fmtItemLine(i) {
  const lvl = i.levelReq > 1 ? `Lv.${i.levelReq}` : `Lv.1`
  return `${rarityEmoji(i.rarity)} *${i.name}*\n     _${lvl} · ☀️ ${i.buyPrice} Solars_`
}

function fmtPotionLine(i) {
  const lvl = i.levelReq > 1 ? `Lv.${i.levelReq}` : `Lv.1`
  const blurb = potionBlurb(i)
  return `${rarityEmoji(i.rarity)} *${i.name}* — ${blurb}\n     _${lvl} · ☀️ ${i.buyPrice}_`
}

/** One-line effect summary shown inline next to each potion in the shop list.
 *  (potionBlurb itself is shared — see lib/shop-catalog.js.) */

function pageFooter(p, page, totalPages, cmd) {
  if (totalPages <= 1) return ''
  const nav = []
  if (page > 1) nav.push(`*${p}shop ${cmd} page ${page - 1}* ◀️`)
  if (page < totalPages) nav.push(`▶️ *${p}shop ${cmd} page ${page + 1}*`)
  return `\n\n📄 _Page ${page}/${totalPages}_${nav.length ? '   ' + nav.join('   ') : ''}`
}

function fmtDetails(entry) {
  const lines = [
    `${rarityEmoji(entry.rarity)} *${entry.name}* _(${entry.rarity})_`,
    `📖 ${entry.description}`,
    `⚔️ Type: ${entry.type}${entry.slot ? ` · Slot: ${entry.slot}` : ''}`,
    `📊 Level Req: ${entry.levelReq}`,
    `💰 Buy: ☀️ ${entry.buyPrice}  · Sell: ☀️ ${entry.sellPrice}`,
  ]
  if (entry.damage) lines.push(`⚔️ Damage: ${entry.damage}`)
  if (entry.statBonuses) {
    const bonuses = Object.entries(entry.statBonuses)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${k.toUpperCase()} +${v}`)
      .join('  ')
    if (bonuses) lines.push(`✨ Bonuses: ${bonuses}`)
  }
  if (entry.effect) {
    const effects = Array.isArray(entry.effect) ? entry.effect : [entry.effect]
    for (const e of effects) {
      if (e.type === 'heal') {
        const amt = e.amount >= 99999 ? 'FULL' : `+${e.amount ?? ''}`
        lines.push(`💊 Effect: heal ${e.stat?.toUpperCase() ?? ''} ${amt}`)
      } else if (e.type === 'cure') {
        const targets = e.targets === 'all' ? 'all ailments' : (e.targets ?? []).join(', ')
        lines.push(`💊 Effect: cures ${targets}`)
      } else if (e.type === 'regen') {
        lines.push(`💊 Effect: regen ${e.stat?.toUpperCase() ?? ''} +${e.amount} for ${e.duration} turns`)
      } else if (e.type === 'strengthen') {
        lines.push(`💊 Effect: +${e.value} ${e.stat?.toUpperCase() ?? ''} for ${e.duration} turns`)
      } else if (e.type === 'shield') {
        lines.push(`💊 Effect: shield ${e.amount} for ${e.duration} turns`)
      } else {
        lines.push(`💊 Effect: ${e.type}`)
      }
    }
  }
  return lines.join('\n')
}

// ── Sub-command handlers ──────────────────────────────────────────────

function handleWeapons(player, args) {
  const showAll = args.includes('all')
  const filteredArgs = args.filter((a) => a.toLowerCase() !== 'all')
  const { page: reqPage, rest } = extractPage(filteredArgs)
  const groupFilter = rest[1]?.toLowerCase() // .shop weapons legendary / epic / rare / uncommon / common

  const list = filteredByLevel(shopWeapons, player.level, showAll)
    .sort((a, b) => a.levelReq - b.levelReq)

  if (!list.length) return `❌ *No weapons available for your level yet.*`

  const groups = labelled(groupByRarity(list), RARITY_LABEL, '⚔️')
  const cmdBase = showAll ? 'weapons all' : 'weapons'

  // ── Single rarity drill-down: .shop weapons epic ─────────────────────
  if (groupFilter) {
    const g = groups.find((gr) => gr.key === groupFilter || gr.label.toLowerCase().includes(groupFilter))
    if (!g) {
      return `❌ *No weapon rarity* "_${groupFilter}_" *found.*\n` +
        `✨ Try: ${groups.map((gr) => `*${gr.key}*`).join(', ')}`
    }
    const { pageItems, page, totalPages } = paginate(g.items, reqPage)
    return (
      `┏━━━━━━━━━━━━━━┓\n` +
      `┃  ⚔️ *${g.label.replace(/\*/g, '').trim().toUpperCase()} WEAPONS* ⚔️\n` +
      `┗━━━━━━━━━━━━━━┛\n\n` +
      pageItems.map(fmtWeaponLine).join('\n\n') +
      pageFooter(config.prefix, page, totalPages, `${cmdBase} ${g.key}`) +
      `\n\n🛒 _Buy with_ *${config.prefix}shop buy <name> [qty]*`
    )
  }

  // ── Grouped overview — preview per rarity tier, drill in for the full list ──
  const lines = [
    `┏━━━━━━━━━━━━━━┓`,
    `┃  🗡️ *WEAPONS SHOP* 🗡️`,
    `┗━━━━━━━━━━━━━━┛`,
    `${showAll ? '_✨ Full catalog ✨_' : `_📊 Levels 1–${player.level + 10}_`}`,
    '',
  ]

  for (const g of groups) {
    lines.push(`${g.label}`)
    const preview = g.items.slice(0, 3)
    for (const item of preview) {
      const lvl = item.levelReq > 1 ? `Lv.${item.levelReq}` : `Lv.1`
      lines.push(`   *${item.name}* — _${lvl} · ☀️${item.buyPrice}_`)
    }
    if (g.items.length > preview.length) {
      lines.push(`   _…and ${g.items.length - preview.length} more — *${config.prefix}shop ${cmdBase} ${g.key}*_`)
    }
    lines.push('')
  }

  lines.push(`🔎 _Drill into a rarity:_ *${config.prefix}shop weapons <rarity>*`)
  if (!showAll) lines.push(`🌐 _Type_ *${config.prefix}shop weapons all* _to see the full catalog._`)
  lines.push(`🛒 _Buy with_ *${config.prefix}shop buy <name> [qty]*`)
  return lines.join('\n')
}

// Relics (type: 'relic') previously had no browsing category anywhere in
// the shop — handleArmor only ever matched type === 'armor', so relics
// like Totem of Undying and Gambler's Relic were buyable via `.shop buy
// <name>` if you already knew the id, but invisible in every menu. This
// fixes that gap and also surfaces the Chest here, since thematically
// it's the closest fit — the Chest itself is NOT bought through
// `.shop buy` (see plugins/chest.js), it has its own `.chest buy` command.
function handleRelics(player, args) {
  const showAll = args.includes('all')
  const filteredArgs = args.filter((a) => a.toLowerCase() !== 'all')
  const { page: reqPage, rest } = extractPage(filteredArgs)

  const relicItems = shopItems.filter(i => i.type === 'relic')
  const list = filteredByLevel(relicItems, player.level, showAll)
    .sort((a, b) => a.levelReq - b.levelReq)

  const { pageItems, page, totalPages } = paginate(list, reqPage)
  const p = config.prefix

  const chestLine =
    `\n🧰 *Chest* — safe storage immune to death loss\n` +
    `     _☀️ 50,000 Solars or 💎 10 Gems · buy with *${p}chest buy solars|gems*_\n`

  if (!list.length) {
    return (
      `┏━━━━━━━━━━━━━━┓\n` +
      `┃  🔮 *RELICS* 🔮\n` +
      `┗━━━━━━━━━━━━━━┓\n\n` +
      `_No relics available for your level yet._\n` +
      chestLine
    )
  }

  return (
    `┏━━━━━━━━━━━━━━┓\n` +
    `┃  🔮 *RELICS SHOP* 🔮\n` +
    `┗━━━━━━━━━━━━━━┛\n` +
    `${showAll ? '_✨ Full catalog ✨_' : `_📊 Levels 1–${player.level + 10}_`}\n\n` +
    pageItems.map(fmtItemLine).join('\n\n') +
    pageFooter(p, page, totalPages, showAll ? 'relics all' : 'relics') +
    `\n\n🛒 _Buy with_ *${p}shop buy <name> [qty]*\n` +
    chestLine
  )
}

function handleArmor(player, args) {
  const showAll = args.includes('all')
  const filteredArgs = args.filter((a) => a.toLowerCase() !== 'all')
  const { page: reqPage, rest } = extractPage(filteredArgs)
  const groupFilter = rest[1]?.toLowerCase() // .shop armor helmets / chestplates / boots / offhand

  const armorItems = shopItems.filter(i => i.type === 'armor')
  const list = filteredByLevel(armorItems, player.level, showAll)
    .sort((a, b) => a.levelReq - b.levelReq)

  if (!list.length) return `❌ *No armor available for your level yet.*`

  const groups = labelled(groupBySlot(list), ARMOR_SLOT_LABEL, '🛡️')
  const cmdBase = showAll ? 'armor all' : 'armor'

  // ── Single slot drill-down: .shop armor boots ────────────────────────
  if (groupFilter) {
    const g = groups.find((gr) => gr.key === groupFilter || gr.label.toLowerCase().includes(groupFilter))
    if (!g) {
      return `❌ *No armor slot* "_${groupFilter}_" *found.*\n` +
        `✨ Try: ${groups.map((gr) => `*${gr.key}*`).join(', ')}`
    }
    const { pageItems, page, totalPages } = paginate(g.items, reqPage)
    return (
      `┏━━━━━━━━━━━━━━┓\n` +
      `┃  🛡️ *${g.label.replace(/\*/g, '').trim().toUpperCase()}* 🛡️\n` +
      `┗━━━━━━━━━━━━━━┛\n\n` +
      pageItems.map(fmtItemLine).join('\n\n') +
      pageFooter(config.prefix, page, totalPages, `${cmdBase} ${g.key}`) +
      `\n\n🛒 _Buy with_ *${config.prefix}shop buy <name> [qty]*`
    )
  }

  // ── Grouped overview — preview per slot, drill in for the full list ──
  const lines = [
    `┏━━━━━━━━━━━━━━┓`,
    `┃  🛡️ *ARMOR SHOP* 🛡️`,
    `┗━━━━━━━━━━━━━━┛`,
    `${showAll ? '_✨ Full catalog ✨_' : `_📊 Levels 1–${player.level + 10}_`}`,
    '',
  ]

  for (const g of groups) {
    lines.push(`${g.label}`)
    const preview = g.items.slice(0, 3)
    for (const item of preview) {
      const lvl = item.levelReq > 1 ? `Lv.${item.levelReq}` : `Lv.1`
      lines.push(`   ${rarityEmoji(item.rarity)} *${item.name}* — _${lvl} · ☀️${item.buyPrice}_`)
    }
    if (g.items.length > preview.length) {
      lines.push(`   _…and ${g.items.length - preview.length} more — *${config.prefix}shop ${cmdBase} ${g.key}*_`)
    }
    lines.push('')
  }

  lines.push(`🔎 _Drill into a slot:_ *${config.prefix}shop armor <slot>*`)
  if (!showAll) lines.push(`🌐 _Type_ *${config.prefix}shop armor all* _to see the full catalog._`)
  lines.push(`🛒 _Buy with_ *${config.prefix}shop buy <name> [qty]*`)
  return lines.join('\n')
}

function handleTools(player, args) {
  const showAll = args.includes('all')
  const filteredArgs = args.filter((a) => a.toLowerCase() !== 'all')
  const { page: reqPage } = extractPage(filteredArgs)

  const list = filteredByLevel(shopTools, player.level, showAll)
    .sort((a, b) => a.levelReq - b.levelReq)

  if (!list.length) return `❌ *No tools available for your level yet.*`

  const { pageItems, page, totalPages } = paginate(list, reqPage)
  const allLine = !showAll
    ? `\n🌐 _Type_ *${config.prefix}shop tools all* _to see the full catalog._`
    : ''

  return (
    `┏━━━━━━━━━━━━━━┓\n` +
    `┃  ⛏️ *TOOLS SHOP* ⛏️\n` +
    `┗━━━━━━━━━━━━━━┛\n` +
    `${showAll ? '_✨ Full catalog ✨_' : `_📊 Levels 1–${player.level + 10}_`}\n\n` +
    pageItems.map(fmtItemLine).join('\n\n') +
    pageFooter(config.prefix, page, totalPages, showAll ? 'tools all' : 'tools') +
    allLine +
    `\n\n⛏️ _A pickaxe is required to_ *${config.prefix}mine* _— only works inside dungeons._\n` +
    `🛒 _Buy with_ *${config.prefix}shop buy <name> [qty]*`
  )
}

function handlePotions(args) {
  const { page: reqPage, rest } = extractPage(args ?? [])
  const groupFilter = rest[1]?.toLowerCase() // .shop potions healing / cures / buffs / elixirs / mana

  const list = shopItems
    .filter(i => i.type === 'consumable')
    .sort((a, b) => a.levelReq - b.levelReq)

  if (!list.length) return `❌ *No potions in stock.*`

  const groups = labelled(groupPotions(list), POTION_GROUP_DISPLAY, '🧪')

  // ── Single group drill-down: .shop potions cures ─────────────────────
  if (groupFilter) {
    const g = groups.find((gr) => gr.key === groupFilter || gr.label.toLowerCase().includes(groupFilter))
    if (!g) {
      return `❌ *No potion category* "_${groupFilter}_" *found.*\n` +
        `✨ Try: ${groups.map((gr) => `*${gr.key}*`).join(', ')}`
    }
    const { pageItems, page, totalPages } = paginate(g.items, reqPage)
    return (
      `┏━━━━━━━━━━━━━━┓\n` +
      `┃  ${g.emoji} *${g.label.replace(/\*/g, '').replace(/^[^\s]+\s/, '').trim().toUpperCase()}* ${g.emoji}\n` +
      `┗━━━━━━━━━━━━━━┛\n\n` +
      pageItems.map(fmtPotionLine).join('\n\n') +
      pageFooter(config.prefix, page, totalPages, `potions ${g.key}`) +
      `\n\n🧪 _Buy with_ *${config.prefix}shop buy <name> [qty]*`
    )
  }

  // ── Grouped overview — preview per section, drill in for the full list ──
  const lines = [
    `┏━━━━━━━━━━━━━━┓`,
    `┃  🧪 *POTIONS SHOP* 🧪`,
    `┗━━━━━━━━━━━━━━┛`,
    '',
  ]

  for (const g of groups) {
    lines.push(`${g.label}`)
    const preview = g.items.slice(0, 3)
    for (const item of preview) {
      lines.push(`   ${rarityEmoji(item.rarity)} *${item.name}* — _${potionBlurb(item)}_ · ☀️${item.buyPrice}`)
    }
    if (g.items.length > preview.length) {
      lines.push(`   _…and ${g.items.length - preview.length} more — *${config.prefix}shop potions ${g.key}*_`)
    }
    lines.push('')
  }

  lines.push(`🔎 _Drill into a category:_ *${config.prefix}shop potions <category>*`)
  lines.push(`🛒 _Buy with_ *${config.prefix}shop buy <name> [qty]*`)
  return lines.join('\n')
}

// ── Buy ───────────────────────────────────────────────────────────────

async function handleBuy(ctx, args) {
  const p = config.prefix
  if (!args[1]) {
    return ctx.reply(
      `❌ *Usage:* *${p}shop buy <item name or id> [quantity]*\n` +
      `_Example:_ *${p}shop buy health_potion 5*`,
    )
  }

  // Last arg is quantity if it's a number; everything before is the item query
  const lastArg = args[args.length - 1]
  let qty       = 1
  let queryParts = args.slice(1)
  if (/^\d+$/.test(lastArg) && args.length > 2) {
    qty        = Math.max(1, Math.min(99, parseInt(lastArg, 10)))
    queryParts = args.slice(1, -1)
  }
  const query = queryParts.join(' ').toLowerCase()

  // Ability Slot — gem-only, not part of the weapons/items catalog.
  if (ABILITY_SLOT_ALIASES.includes(query) || ABILITY_SLOT_ALIASES.includes(queryParts.join(' ').toLowerCase())) {
    return handleBuyAbilitySlot(ctx, qty)
  }

  // Skill Pack — gem-only gacha pull, also not part of the weapons/items
  // catalog. Delegates to plugins/skillpack.js so both `.shop buy <pack>`
  // and the dedicated `.skillpack buy <pack>` command share one purchase
  // path. Quantity is ignored here — a pack purchase is always
  // `pullsPerPurchase` pulls, there's no "buy N packs at once" concept.
  if (findPack(query)) {
    const { handleBuy: handleBuySkillPack } = await import('./skillpack.js')
    return handleBuySkillPack(ctx, args)
  }

  // Blue Band — the old woman's, not the shop's. She hands one over for an
  // honest answer, never for Solars, so this must intercept before
  // findInCatalog()/the buyPrice==null guard below.
  if (BLUE_BAND_QUERIES.has(query)) {
    return startBlueBandRiddle(ctx)
  }

  const entry = findInCatalog(query)
  if (!entry) {
    return ctx.reply(
      `❌ *Item* "_${queryParts.join(' ')}_" *not found in the shop.*\n` +
      `🔎 Browse with *${p}shop weapons*, *${p}shop armor*, *${p}shop tools*, or *${p}shop potions*.`,
    )
  }

  // Materials (ores, scraps, etc.) share the catalog for .shop sell but have
  // no buyPrice — they're gathered via .mine, not purchased. Block buying
  // them here so totalCost never computes as NaN (buyPrice undefined).
  if (entry.buyPrice == null) {
    return ctx.reply(`❌ *${entry.name}* isn't sold in the shop — gather it with *${p}mine* instead.`)
  }

  // Mid-battle: only consumables (potions) can be bought. Gear purchases
  // are blocked so a player can't shop for a full new loadout mid-fight,
  // but they can still restock health/mana potions to keep fighting.
  if (ctx.player?.inBattle && entry.type !== 'consumable') {
    return ctx.reply(
      `⚔️ *You're mid-battle* — only potions can be bought right now.\n` +
      `🧪 Browse with *${p}shop potions*.`,
    )
  }

  // Cheat mod: Merchant's Favor (shop_discount). Applied here rather than
  // inside updatePlayer's mutator since the discount is a flat % off
  // list price, not something that needs the mutator's atomicity — but
  // it still reads ctx.player, which is the pre-write snapshot (fine,
  // since the mod itself isn't being changed by this purchase).
  const discount = getModValue(ctx.player, 'shop_discount') ?? 0
  const totalCost = Math.max(0, Math.round(entry.buyPrice * qty * (1 - discount)))
  let outcome = null

  await updatePlayer(ctx.db, ctx.from, player => {
    if (player.level < entry.levelReq) {
      outcome = { ok: false, reason: 'level' }
      return player
    }

    const solars = player.wallet?.solars ?? 0
    if (solars < totalCost) {
      outcome = { ok: false, reason: 'solars', solars }
      return player
    }

    if (!hasInventoryRoom(player, qty)) {
      outcome = { ok: false, reason: 'full', player }
      return player
    }

    player.wallet.solars -= totalCost
    for (let i = 0; i < qty; i++) {
      player.inventory.push(entry.id)
    }

    outcome = { ok: true, remaining: player.wallet.solars }
    return player
  })

  // Reply only after updatePlayer's write has actually landed — replying
  // from inside the mutator (the old behaviour) could tell the player
  // "purchase complete" before the write finished, which under a race
  // with another concurrent command could silently lose the write and
  // leave the player with a "successful" purchase that never actually
  // appears in their inventory.
  if (outcome.reason === 'level') {
    return ctx.reply(`❌ *${entry.name}* requires Level *${entry.levelReq}*. You are Level ${ctx.player?.level ?? '?'}.`)
  }
  if (outcome.reason === 'solars') {
    const short = totalCost - outcome.solars
    return ctx.reply(
      `❌ *Not enough Solars!*\n` +
      `*${entry.name}* × ${qty} costs ☀️ *${totalCost}*.\n` +
      `You have ☀️ *${outcome.solars}*. You need ☀️ *${short}* more.`,
    )
  }
  if (outcome.reason === 'full') {
    return ctx.reply(
      `❌ ${inventoryFullMessage(outcome.player)}\n` +
      `_Can't buy_ *${entry.name} x${qty}* _— not enough room._`,
    )
  }

  const qtyLine = qty > 1 ? ` × ${qty}` : ''
  return ctx.reply(
    `🛒 *Purchase complete!*\n\n` +
    `${rarityEmoji(entry.rarity)} *${entry.name}*${qtyLine}\n` +
    `💰 Paid: ☀️ *${totalCost}*\n` +
    `💰 Remaining: ☀️ *${outcome.remaining}*\n\n` +
    `_Added to your inventory. Use *${p}inventory* to view._`,
  )
}

// ── The old woman's Blue Band (The End event) ─────────────────────────────
// What players might type for it. The bare "band" is in here on purpose: it's
// the only band in the game, and a sleeping player typing it deserves an
// answer rather than "not found in the shop".
const BLUE_BAND_QUERIES = new Set([
  'blue band', 'blue_band', 'blueband', 'blue-band', 'band', 'bluband',
])

/**
 * `.shop buy blue band` — start (or re-ask) the old woman's riddle.
 *
 * She costs nothing but honesty: asking only sets
 * `blueBandRiddle.state='awaiting_answer'`, and plugins/answer.js resolves it.
 * A wrong answer locks her door (`state:'locked'`); the lock is cleared by
 * applyEndEventTick() the moment the player is seen outside Astral Town, which
 * is how "travel to a dungeon and come back" is enforced.
 */
async function startBlueBandRiddle(ctx) {
  const p = config.prefix

  // Off-event she's just a bewildered old lady — no spoilers, no band.
  if (!isEventActive(ctx.db)) {
    return ctx.reply(
      `👵 _"A blue band? Whatever for, child? The air is clean today."_\n\n` +
      `_The old woman waves you off._`,
    )
  }

  // A null location means "never left town" (see plugins/profile.js's default).
  const here = ctx.player?.location ?? ASTRAL_TOWN_ID
  if (here !== ASTRAL_TOWN_ID) {
    return ctx.reply(
      `👵 *The old woman keeps her stall in Astral Town.*\n` +
      `🚪 _Head back with_ *${p}travel town* _and ask her there._`,
    )
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    if (hasBlueBand(player) || (player.inventory ?? []).includes(BLUE_BAND_ID)) {
      outcome = 'already'
      return player
    }
    if (player.blueBandRiddle?.state === 'locked') {
      outcome = 'locked'
      return player
    }
    player.blueBandRiddle = { state: 'awaiting_answer', askedAt: Date.now() }
    outcome = 'asked'
    return player
  })

  if (outcome === 'already') return ctx.reply(RIDDLE_ALREADY_BANDED)
  if (outcome === 'locked')  return ctx.reply(RIDDLE_WRONG)
  return ctx.reply(RIDDLE_QUESTION.replaceAll('{prefix}', p))
}

/**
 * Ability Slot — flat 5 gems, repeatable, no scaling cost, no cap.
 * Directly increments player.abilitySlots (not an inventory item).
 * `qty` lets a player buy several slots in one command, same as any
 * other shop purchase.
 */
async function handleBuyAbilitySlot(ctx, qty) {
  const p          = config.prefix
  const totalCost  = ABILITY_SLOT_GEM_PRICE * qty

  let raceAborted = false
  let newSlotCount = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    const gems = player.wallet?.gems ?? 0
    if (gems < totalCost) { raceAborted = true; return }
    player.wallet.gems = roundGems(gems - totalCost)
    player.abilitySlots = (player.abilitySlots ?? 1) + qty
    newSlotCount = player.abilitySlots
  })

  if (raceAborted) {
    return ctx.reply(
      `❌ *Not enough Gems!*\n` +
      `*Ability Slot*${qty > 1 ? ` × ${qty}` : ''} costs 💎 *${totalCost}*.\n` +
      `_Use_ *${p}profile* _to check your balance._`,
    )
  }

  return ctx.reply(
    `🛒 *Purchase complete!*\n\n` +
    `✨ *Ability Slot*${qty > 1 ? ` × ${qty}` : ''}\n` +
    `💰 Paid: 💎 *${totalCost}*\n` +
    `✨ You now have *${newSlotCount}* ability slot(s).\n\n` +
    `_Equip an owned ability with *${p}ability equip <name>*._`,
  )
}

// ── Sell ──────────────────────────────────────────────────────────────

async function handleSell(ctx, args) {
  const p = config.prefix
  if (!args[1]) {
    return ctx.reply(
      `❌ *Usage:* *${p}shop sell <item name or id> [quantity]*\n` +
      `_Example:_ *${p}shop sell health_potion 3*`,
    )
  }

  const lastArg = args[args.length - 1]
  let qty       = 1
  let queryParts = args.slice(1)
  if (/^\d+$/.test(lastArg) && args.length > 2) {
    qty        = Math.max(1, Math.min(99, parseInt(lastArg, 10)))
    queryParts = args.slice(1, -1)
  }
  const query = queryParts.join(' ').toLowerCase()

  // Search catalog for price info
  const entry = findInCatalog(query)
  if (!entry) {
    return ctx.reply(`❌ *Item* "_${queryParts.join(' ')}_" *is not a known sellable item.*`)
  }

  await updatePlayer(ctx.db, ctx.from, async player => {
    // Count how many the player has
    const owned = player.inventory.filter(id => id === entry.id).length
    if (owned === 0) {
      await ctx.reply(`❌ *You don't have any* *${entry.name}* _in your inventory._`)
      return player
    }

    const actualQty = Math.min(qty, owned)
    const earnings  = entry.sellPrice * actualQty

    // Remove items from inventory
    let removed = 0
    player.inventory = player.inventory.filter(id => {
      if (id === entry.id && removed < actualQty) { removed++; return false }
      return true
    })
    player.wallet.solars = (player.wallet.solars ?? 0) + earnings

    const qtyLine = actualQty > 1 ? ` × ${actualQty}` : ''
    const shortLine = actualQty < qty
      ? `\n⚠️ _You only had ${owned}, sold ${actualQty}._`
      : ''

    await ctx.reply(
      `💰 *Sold!*\n\n` +
      `${rarityEmoji(entry.rarity)} *${entry.name}*${qtyLine}\n` +
      `💰 Earned: ☀️ *${earnings}*\n` +
      `💰 Balance: ☀️ *${player.wallet.solars}*` +
      shortLine,
    )
    return player
  })
}

// ── Info ──────────────────────────────────────────────────────────────

function handleInfo(args) {
  const query = args.slice(1).join(' ').toLowerCase()
  const entry = findInCatalog(query)
  if (!entry) return { text: `❌ *Item* "_${args.slice(1).join(' ')}_" *not found in the shop.*`, entry: null }
  return { text: fmtDetails(entry), entry }
}

// ── Main menu ─────────────────────────────────────────────────────────

function mainMenu(player) {
  const p = config.prefix
  const solars = player.wallet?.solars ?? 0
  const gems   = player.wallet?.gems   ?? 0
  return (
    `┏━━━━━━━━━━━━━━┓\n` +
    `┃  🏪 *ASTRAL SHOP* 🏪\n` +
    `┗━━━━━━━━━━━━━━┛\n` +
    `_Hesta keeps the counter on Market Row. The bell over the door still works._\n` +
    `_Everything an adventurer needs, under one roof. Guild slips that ask for a potion mean this counter._\n\n` +
    `💰 ☀️ *${solars}* Solars   ·   💎 *${fmtGems(gems)}* Gems\n\n` +
    `📦 *Browse:*\n` +
    `   🗡️ *${p}shop weapons* — _blades, bows & more_\n` +
    `   🛡️ *${p}shop armor* — _helmets, chests, boots_\n` +
    `   🔮 *${p}shop relics* — _offhand trinkets & the Chest_\n` +
    `   ⛏️ *${p}shop tools* — _pickaxes for mining_\n` +
    `   🧪 *${p}shop potions* — _heals, cures & buffs_\n\n` +
    `✨ *${p}shop buy ability_slot* — 💎${ABILITY_SLOT_GEM_PRICE} for an extra ability slot\n` +
    `🎴 *${p}skillpack* — pull mythic-tier skills with Gems\n` +
    `🧰 *${p}chest* — safe storage immune to death loss\n\n` +
    `🛒 *${p}shop buy <item> [qty]* — _purchase_\n` +
    `💰 *${p}shop sell <item> [qty]* — _sell from bag_\n` +
    `🔍 *${p}shop info <item>* — _full item details_\n\n` +
    `_Tip: add_ *all* _after a category for the full catalog, or_ *page 2* _to flip pages._`
  )
}

// ── Plugin export ─────────────────────────────────────────────────────

export default {
  name:           'shop',
  aliases:        ['store', 'market'],
  category:       'economy',
  requiresPlayer: true,
  description:    'Browse and buy weapons, armor, and potions',

  async run(ctx) {
    const { args, player } = ctx
    const sub = args[0]?.toLowerCase()

    if (!sub)                                    return sendImage(ctx, SHOP_BANNER, mainMenu(player))
    if (sub === 'weapons' || sub === 'weapon')   return sendImage(ctx, SHOP_BANNER, handleWeapons(player, args))
    if (sub === 'armor'   || sub === 'armour')   return sendImage(ctx, ARMOR_SHOP_BANNER, handleArmor(player, args))
    if (sub === 'relics'  || sub === 'relic')    return sendImage(ctx, SHOP_BANNER, handleRelics(player, args))
    if (sub === 'tools'   || sub === 'tool')     return sendImage(ctx, SHOP_BANNER, handleTools(player, args))
    if (sub === 'potions' || sub === 'potion')   return sendImage(ctx, SHOP_BANNER, handlePotions(args))
    if (sub === 'buy'     || sub === 'purchase') return handleBuy(ctx, args)
    if (sub === 'sell')                          return handleSell(ctx, args)
    if (sub === 'info'    || sub === 'inspect') {
      const { text, entry } = handleInfo(args)
      if (!entry) return sendImage(ctx, SHOP_BANNER, text)
      // entry.image points at this bot's own /assets/items/<id>.png. That art is
      // rendered on demand from vendor/game-icons (lib/item-art-cache.mjs) or
      // read off lib/assets/items/ — but when NEITHER is present on the host,
      // the URL is fetched from our public origin, and that origin being down
      // used to throw out of sendImage and swallow the whole reply: no picture
      // AND no details. Naming the banner as the fallback keeps the item
      // details arriving with a usable image either way (and sendImage still
      // degrades to plain text if even the banner can't be fetched).
      //
      // fmtDetails already opens with name · rarity · level · prices, so no
      // header is prepended here — doing so printed all of it twice.
      return sendImage(ctx, entry.image || SHOP_BANNER, text, { fallbackImage: SHOP_BANNER })
    }

    return sendImage(
      ctx, SHOP_BANNER,
      `❌ *Unknown shop command* "_${sub}_".\n\n` + mainMenu(player),
    )
  },
}
