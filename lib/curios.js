/**
 * lib/curios.js — the registry of "misc" items and what each one is FOR.
 *
 * An item whose type is `misc` has no equip slot and no consumable effect, so
 * before this module existed it fell through plugins/inventory.js's TYPE_ORDER
 * into the "❔ Other" catch-all, where it was printed as a raw id with zero
 * stars and no hint that it did anything at all. Two of the three shipped misc
 * items DO have a use (.setpearl); one is a deliberately inert lore drop.
 *
 * CURIO_USES is the single source of truth for that distinction, shared by
 * plugins/inventory.js (to print the right hint) and plugins/salvage.js (to
 * decide what is safe to destroy). Registering a new misc item here is what
 * makes it show a use instead of becoming salvage fodder, so ANY new curio with
 * a command behind it MUST be added to this map or players will scrap it.
 */

/** misc item id -> the command that uses it, without the prefix. */
export const CURIO_USES = {
  ender_pearl:          'setpearl',
  cracked_ender_shard:  'setpearl',
}

/** Solars floor for salvaging a recognized but inert curio. */
export const SALVAGE_FLOOR = 120

/** Flat solars for salvaging an id that no longer exists in the item data. */
export const JUNK_VALUE = 60

/** The command that consumes this curio, or null if it has no use yet. */
export function curioUse(id) {
  return CURIO_USES[id] ?? null
}

/** True for a real misc item that nothing consumes, i.e. safe salvage fodder. */
export function isInertCurio(item) {
  return item?.type === 'misc' && !CURIO_USES[item.id]
}

/**
 * Salvage value of a recognized item. Never below SALVAGE_FLOOR, because the
 * inert curios ship with token sellPrices (a Bar Tab Receipt sells for 1 solar)
 * and scrapping one should be worth the inventory slot it frees.
 */
export function salvageValue(item) {
  return Math.max(Number(item?.sellPrice) || 0, SALVAGE_FLOOR)
}

/** Turns a raw id into a readable label, for ids missing from the item data. */
export function humanizeId(id) {
  return String(id).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
