/**
 * pvp-kit.js — bounded, pre-packed loadout stores.
 *
 * This is NOT a view over player.inventory. Per the spec's §4.1 this is a
 * deliberate second store with its own capacity, and the whole point is the
 * packing decision: you decide what you bring BEFORE the fight, the way a
 * Minecraft PvP kit is packed in advance rather than fought out of a full
 * survival inventory. Mid-battle commands (drink / swap / mend / refill) read
 * and consume from HERE and never from the main inventory.
 *
 * Shape: player.pvpKit = ['second_wind_draught', 'second_wind_draught', ...]
 * A flat array of item id strings, exactly like player.inventory, so every
 * existing helper that walks an id list works on it unchanged.
 *
 * Capacity is 15 slots, flat. That number is not arbitrary: the kit image
 * (lib/pvp-kit-render.mjs) is a 5x3 grid, so the cap and the picture are the
 * same fact and can never drift apart.
 *
 * ── STORE-AGNOSTIC BY DESIGN ─────────────────────────────────────────────────
 * Everything below is written against a store key rather than a hard-coded
 * player.pvpKit, and exported twice over:
 *
 *   ensureKit / kitSpace / kitContents / moveToKit / takeFromKit /
 *   consumeFromKit / findKitItem      → hard-bound to 'pvpKit', byte-identical
 *                                       behaviour to before this split
 *   ...Store variants                 → take the store key and capacity
 *
 * so a second bag could reuse the same primitives without ever sharing slots
 * with the duel kit. Every pre-existing caller keeps calling the first set.
 */

import { allItems } from './game-data.js'

/** Kit capacity. 5 columns x 3 rows, matching the rendered grid exactly. */
export const PVP_KIT_SLOTS = 15

/** Kit grid shape, shared with the renderer so the two cannot disagree. */
export const PVP_KIT_COLS = 5
export const PVP_KIT_ROWS = 3

const itemMap = Object.fromEntries(allItems.map((i) => [i.id, i]))

/**
 * Item types a kit accepts. Materials, quest junk and cosmetics are refused at
 * the door so nobody wastes a packing slot on wood planks.
 */
const KIT_ALLOWED_TYPES = new Set(['consumable', 'relic', 'armor', 'weapon', 'tool'])

/* ── store-agnostic core ─────────────────────────────────────────────────── */

/** Normalise and return one of the player's bounded stores, creating it if absent. */
export function ensureStore(player, key) {
  if (!Array.isArray(player[key])) player[key] = []
  return player[key]
}

/** Free slots left in a store. */
export function storeSpace(player, key, slots) {
  return Math.max(0, slots - ensureStore(player, key).length)
}

/** Look an item up by exact id, then by partial name, within a given id list. */
export function findInList(list, query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return null
  if (list.includes(q)) return q
  const byId = list.find((id) => id.toLowerCase() === q)
  if (byId) return byId
  for (const id of list) {
    const item = itemMap[id]
    if (item && item.name.toLowerCase().includes(q)) return id
  }
  return null
}

/** True if this item is allowed in a kit at all. */
export function kitAccepts(itemId) {
  const item = itemMap[itemId]
  if (!item) return false
  return KIT_ALLOWED_TYPES.has(item.type)
}

/**
 * Counts of each id in a store, in a stable display order: relics first (the
 * life-savers you want to see at a glance), then consumables, then gear.
 */
export function storeContents(player, key) {
  const kit = ensureStore(player, key)
  const counts = new Map()
  for (const id of kit) counts.set(id, (counts.get(id) ?? 0) + 1)

  const order = { relic: 0, consumable: 1, weapon: 2, armor: 3, tool: 4 }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count, item: itemMap[id] ?? null }))
    .sort((a, b) => {
      const ta = order[a.item?.type] ?? 9
      const tb = order[b.item?.type] ?? 9
      if (ta !== tb) return ta - tb
      return (a.item?.name ?? a.id).localeCompare(b.item?.name ?? b.id)
    })
}

/**
 * moveIntoStore(player, query, amount, key, slots)
 *   → { moved, itemId, itemName, count, reason }
 *
 * The deliberate transfer step: pulls copies out of the main inventory (or the
 * chest, which is a genuinely separate store) and into the kit. Mutates the
 * player object; the caller persists it. Never a purchase, never automatic.
 */
export function moveIntoStore(player, query, amount, key, slots) {
  ensureStore(player, key)
  player.inventory = Array.isArray(player.inventory) ? player.inventory : []
  const chestItems = Array.isArray(player.chest?.items) ? player.chest.items : []

  let source = 'inventory'
  let itemId = findInList(player.inventory, query)
  if (!itemId) {
    itemId = findInList(chestItems, query)
    if (itemId) source = 'chest'
  }
  if (!itemId) return { moved: 0, reason: 'not-found' }

  const item = itemMap[itemId]
  if (!kitAccepts(itemId)) {
    return { moved: 0, reason: 'type', itemName: item?.name ?? itemId, itemType: item?.type }
  }

  const pool = source === 'chest' ? chestItems : player.inventory
  const have = pool.filter((id) => id === itemId).length
  const want = Math.max(1, Math.min(Number(amount) || 1, have))
  const room = storeSpace(player, key, slots)
  if (room <= 0) return { moved: 0, reason: 'full', itemName: item?.name ?? itemId }

  const moved = Math.min(want, room)
  for (let i = 0; i < moved; i++) {
    pool.splice(pool.indexOf(itemId), 1)
    player[key].push(itemId)
  }
  if (source === 'chest') player.chest.items = pool
  else player.inventory = pool

  return {
    moved, itemId, source,
    itemName: item?.name ?? itemId,
    count: player[key].filter((id) => id === itemId).length,
    partial: moved < want,
  }
}

/**
 * takeOutOfStore(player, query, amount, invCap, key) → { moved, ... } — the
 * reverse trip, back into the main inventory. Respects the main inventory cap by
 * refusing rather than silently overflowing it.
 */
export function takeOutOfStore(player, query, amount, invCap, key) {
  const kit = ensureStore(player, key)
  player.inventory = Array.isArray(player.inventory) ? player.inventory : []

  const itemId = findInList(kit, query)
  if (!itemId) return { moved: 0, reason: 'not-found' }

  const item = itemMap[itemId]
  const have = kit.filter((id) => id === itemId).length
  const want = Math.max(1, Math.min(Number(amount) || 1, have))
  const room = Math.max(0, invCap - player.inventory.length)
  if (room <= 0) return { moved: 0, reason: 'inv-full', itemName: item?.name ?? itemId }

  const moved = Math.min(want, room)
  for (let i = 0; i < moved; i++) {
    kit.splice(kit.indexOf(itemId), 1)
    player.inventory.push(itemId)
  }
  return { moved, itemId, itemName: item?.name ?? itemId, partial: moved < want }
}

/**
 * consumeFromStore(player, itemId, key) → boolean — removes exactly one copy.
 * Every mid-battle item command routes through this so there is one place that
 * owns "battle items come from the kit".
 */
export function consumeFromStore(player, itemId, key) {
  const kit = ensureStore(player, key)
  const idx = kit.indexOf(itemId)
  if (idx === -1) return false
  kit.splice(idx, 1)
  return true
}

/** Resolve an item in a store, optionally restricted by a predicate. */
export function findStoreItem(player, query, predicate, key) {
  const kit = ensureStore(player, key)
  const pool = predicate ? kit.filter((id) => predicate(itemMap[id], id)) : kit
  const id = findInList(pool, query)
  return id ? { id, item: itemMap[id] ?? null } : null
}

/** The item catalog entry for an id, or null. */
export function kitItemInfo(itemId) {
  return itemMap[itemId] ?? null
}

/* ── the PvP kit: original API, hard-bound to player.pvpKit ──────────────── */

export function ensureKit(player) {
  return ensureStore(player, 'pvpKit')
}

export function kitSpace(player) {
  return storeSpace(player, 'pvpKit', PVP_KIT_SLOTS)
}

export function kitContents(player) {
  return storeContents(player, 'pvpKit')
}

export function moveToKit(player, query, amount = 1) {
  return moveIntoStore(player, query, amount, 'pvpKit', PVP_KIT_SLOTS)
}

export function takeFromKit(player, query, amount = 1, invCap = Infinity) {
  return takeOutOfStore(player, query, amount, invCap, 'pvpKit')
}

export function consumeFromKit(player, itemId) {
  return consumeFromStore(player, itemId, 'pvpKit')
}

export function findKitItem(player, query, predicate = null) {
  return findStoreItem(player, query, predicate, 'pvpKit')
}
