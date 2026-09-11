/**
 * shop-catalog.js — what the general store actually sells, and how its shelves
 * are divided.
 *
 * Extracted from plugins/shop.js when the website grew its own Shop page. Both
 * surfaces now read the same catalog and the same grouping predicates, so an
 * item can never be buyable in chat and invisible on the site (or land in
 * "Buffs & Shields" in one place and "Other" in the other).
 *
 * Deliberately display-free: this module exports keys and predicates, never
 * labels. plugins/shop.js renders WhatsApp markup (`🧪 *Healing & Mana*`) and
 * the website renders HTML, and neither wants the other's strings.
 *
 * Purchase RULES are not here — those live in the single mutator inside
 * plugins/shop.js's handleBuy() and api-server.js's POST /api/shop/buy, both of
 * which resolve their entry through findInCatalog()/catalogById below.
 */
import {
  weapons as weaponsData,
  items as itemsData,
  tools as toolsData,
  materials as materialsData,
} from './game-data.js'

/** All weapons that have a buyPrice (craft-only and season weapons excluded). */
export const shopWeapons = weaponsData.filter(w => w.buyPrice != null && !w.seasonId)

/** All items that have a buyPrice. */
export const shopItems = itemsData.filter(i => i.buyPrice != null && !i.seasonId)

/** All tools (pickaxes) that have a buyPrice. */
export const shopTools = toolsData.filter(t => t.buyPrice != null)

/**
 * Combined catalog: weapons + items + tools + materials. Keyed by id for fast
 * lookup. Materials (ores, scraps, etc.) are sell-only — they have no buyPrice,
 * only sellPrice — so they're included unconditionally rather than filtered
 * like the buyable categories above. Without this, `.shop sell` could never
 * find mined materials at all; the buy paths reject `buyPrice == null`
 * explicitly instead.
 */
export const catalogById = new Map([
  ...shopWeapons.map(w => [w.id, w]),
  ...shopItems.map(i => [i.id, i]),
  ...shopTools.map(t => [t.id, t]),
  ...materialsData.map(m => [m.id, m]),
])

/**
 * Find an item in the catalog by exact id or case-insensitive partial name.
 * Returns the first match or undefined.
 */
export function findInCatalog(query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return undefined
  if (catalogById.has(q)) return catalogById.get(q)
  for (const entry of catalogById.values()) {
    if (entry.name.toLowerCase().includes(q)) return entry
  }
  return undefined
}

/* ── shelf grouping ─────────────────────────────────────────────────────── */

/** Weapon rarity groups — 85 weapons is far too long for one list. */
export const RARITY_GROUP_ORDER = ['legendary', 'epic', 'rare', 'uncommon', 'common']

export function groupByRarity(list) {
  const groups = []
  for (const rarity of RARITY_GROUP_ORDER) {
    const items = list.filter(i => (i.rarity ?? 'common') === rarity)
    if (items.length) groups.push({ key: rarity, items })
  }
  return groups
}

/** Armor slots, in the order they're worn top to bottom. */
export const ARMOR_SLOT_ORDER = ['helmet', 'chestplate', 'boots', 'offhand']

export function groupBySlot(list) {
  const groups = []
  for (const slot of ARMOR_SLOT_ORDER) {
    const items = list.filter(i => i.slot === slot)
    if (items.length) groups.push({ key: slot, items })
  }
  const known = new Set(ARMOR_SLOT_ORDER)
  const leftover = list.filter(i => !known.has(i.slot))
  if (leftover.length) groups.push({ key: 'other', items: leftover })
  return groups
}

/**
 * Potion shelves, matched by effect shape rather than by a tag on the item —
 * so a new potion lands on the right shelf the moment it's added to
 * data/items.json, with no second list to update. Order matters: the first
 * matching group wins, and each item is consumed once.
 */
export const POTION_GROUPS = [
  {
    key: 'healing',
    match: i => i.effect && !Array.isArray(i.effect) && i.effect.type === 'heal'
      && i.effect.stat === 'hp' && i.id !== 'phoenix_down',
  },
  {
    key: 'mana',
    match: i => i.effect && !Array.isArray(i.effect) && i.effect.type === 'heal'
      && i.effect.stat === 'mp',
  },
  {
    key: 'stamina',
    match: i => i.effect && !Array.isArray(i.effect) && i.effect.type === 'heal'
      && i.effect.stat === 'stamina',
  },
  { key: 'elixirs', match: i => Array.isArray(i.effect) || i.id === 'phoenix_down' },
  { key: 'cures',   match: i => i.effect && !Array.isArray(i.effect) && i.effect.type === 'cure' },
  {
    key: 'buffs',
    match: i => i.effect && !Array.isArray(i.effect)
      && ['strengthen', 'shield', 'regen'].includes(i.effect.type),
  },
]

export function groupPotions(list) {
  const groups = []
  const used = new Set()
  for (const g of POTION_GROUPS) {
    const items = list.filter(i => !used.has(i.id) && g.match(i))
    items.forEach(i => used.add(i.id))
    if (items.length) groups.push({ key: g.key, items })
  }
  const leftover = list.filter(i => !used.has(i.id))
  if (leftover.length) groups.push({ key: 'other', items: leftover })
  return groups
}

/**
 * One-line effect summary — "+150 HP", "cures all", "shield 40". Shared so the
 * blurb under a potion reads the same in chat and on the site.
 */
export function potionBlurb(i) {
  if (!i?.effect) return ''
  const effects = Array.isArray(i.effect) ? i.effect : [i.effect]
  return effects.map(e => {
    if (e.type === 'heal')       return e.amount >= 99999 ? `full ${e.stat?.toUpperCase()}` : `+${e.amount} ${e.stat?.toUpperCase()}`
    if (e.type === 'cure')       return e.targets === 'all' ? 'cures all' : `cures ${(e.targets ?? []).join('/')}`
    if (e.type === 'regen')      return `+${e.amount}/turn ${e.stat?.toUpperCase()}`
    if (e.type === 'strengthen') return `+${e.value} ${e.stat?.toUpperCase()}`
    if (e.type === 'shield')     return `shield ${e.amount}`
    return e.type
  }).join(', ')
}

/**
 * Ability Slot — gem-only, repeatable, non-scaling. Not a real item (no
 * inventory entry, no id in allItems); buying one directly increments
 * player.abilitySlots.
 */
export const ABILITY_SLOT_GEM_PRICE = 5
export const ABILITY_SLOT_ALIASES = ['ability_slot', 'abilityslot', 'ability slot', 'ability-slot']
