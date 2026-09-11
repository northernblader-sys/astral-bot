/**
 * inventory-limits.js — shared inventory slot cap logic.
 *
 * `inventory` is a flat string[] of item ids, duplicates allowed (each
 * stackable copy is its own entry) — so the cap is a length check, not a
 * distinct-id check. One item instance = one slot.
 *
 * Every call site that pushes/adds to player.inventory should check
 * hasInventoryRoom() BEFORE granting, and reject/trim accordingly rather
 * than pushing past the cap. See getInventoryCap() for the standard vs
 * premium limits.
 *
 * Does NOT apply to `equipped` (separate 6-slot gear system) or
 * `abilityInventory`/`abilitySlots` (separate ability system) — both are
 * explicitly out of scope for this cap.
 */
import { isPremiumActive } from './premium.js'
import { formatTimeLeft } from './time-format.js'

export const STANDARD_INVENTORY_CAP = 30
export const PREMIUM_INVENTORY_CAP  = 50

/** Returns the player's max inventory slots based on active premium status. */
export function getInventoryCap(player) {
  return isPremiumActive(player) ? PREMIUM_INVENTORY_CAP : STANDARD_INVENTORY_CAP
}

/** True if the player has room for `count` more item instances without exceeding their cap. */
export function hasInventoryRoom(player, count = 1) {
  return (player.inventory?.length ?? 0) + count <= getInventoryCap(player)
}

/**
 * Standard "inventory full" rejection message, using the player's actual
 * cap (not a hardcoded number). Use this for any reject-the-whole-action
 * site so the wording stays consistent bot-wide.
 */
export function inventoryFullMessage(player) {
  const cap = getInventoryCap(player)
  return `🎒 Inventory full (${player.inventory?.length ?? 0}/${cap}). Sell or discard items to make room.`
}

// ── Premium lapse overflow ───────────────────────────────────────────────────
//
// The cap is not a constant per player: it drops from 50 to 30 the moment
// premium lapses, which can leave a bag ABOVE its own limit with no command
// having done anything wrong. Left alone that state is permanently broken —
// every `hasInventoryRoom` check fails, so the player can never loot, craft or
// buy again, and no amount of selling helps until they happen to sell 20 items.
//
// So the overflow is resolved on a clock, and the player is always warned
// before anything moves:
//
//   1. First sweep that sees a lapsed player over cap stamps a grace deadline
//      and notifies them. Nothing is touched.
//   2. While the grace runs they can sell, gift or store freely, and the
//      warning repeats on their own commands so it is impossible to miss.
//   3. When the deadline passes, the overflow is SHED: cheapest items first,
//      into their house storage if it has room, otherwise sold at the same
//      sellPrice `.shop sell` would have paid, and only destroyed when it can
//      be neither stored nor sold. Equipped gear is never involved, it lives in
//      `equipped` and was never subject to this cap.
//
// Cheapest-first is the fair rule: rarity ladder ascending, then sellPrice, so
// stacked ore goes before a legendary. All of this is pure and synchronous, so
// the sweep and the command handler can both call it inside their own mutators.

/** How long a lapsed player gets to sort their own bag out before it is shed. */
export const OVERFLOW_GRACE_MS = 48 * 60 * 60_000

/** Ascending value order. */
const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 }

/**
 * Where an id with NO catalog entry sorts: dead last, above mythic.
 *
 * Some monster drop tables in data/monsters.json name items that were never
 * added to the item catalog (trickster_vest, astral_core, eternity_shard and a
 * handful more), so a real bag can hold something this module cannot price.
 * Ranking those as `common` junk would have shed a player's rarest, most
 * unreplaceable pieces FIRST and, with no house to catch them, destroyed them.
 * Unknown means "do not touch unless there is nothing else left".
 */
const UNKNOWN_RANK = 99

/** How many slots over cap this player is right now, and the numbers behind it. */
export function inventoryOverflow(player) {
  const cap = getInventoryCap(player)
  const held = player.inventory?.length ?? 0
  return { over: Math.max(0, held - cap), held, cap }
}

/**
 * The grace state for a lapsed, over-cap player, stamping one if it is due.
 * Returns `{ phase, until, over, cap, held }` where phase is:
 *   'clear'   nothing wrong, and any stale stamp has been cleared
 *   'warned'  a deadline was just stamped by this call (warn them now)
 *   'grace'   a deadline is already running and has not passed
 *   'due'     the deadline has passed, call planOverflowShed next
 * Mutates `player.inventoryGrace`. Safe to call on every command.
 */
export function checkOverflowGrace(player, now = Date.now()) {
  const { over, held, cap } = inventoryOverflow(player)
  if (over <= 0) {
    // Back under the cap on their own. Drop the stamp so a future lapse starts
    // a fresh grace period rather than shedding instantly.
    if (player.inventoryGrace) delete player.inventoryGrace
    return { phase: 'clear', until: 0, over: 0, held, cap }
  }
  const stamp = player.inventoryGrace
  if (!stamp?.until) {
    player.inventoryGrace = { until: now + OVERFLOW_GRACE_MS, stampedAt: now, warnedAt: now, cap }
    return { phase: 'warned', until: player.inventoryGrace.until, over, held, cap }
  }
  if (now >= stamp.until) return { phase: 'due', until: stamp.until, over, held, cap }
  return { phase: 'grace', until: stamp.until, over, held, cap }
}

/**
 * Decides exactly which item ids leave the bag, without touching anything.
 * `allItems` is the array from lib/game-data.js. `storageCap` is the player's
 * house storage limit (0 when they have no house worth the name), so the plan
 * can prefer relocation over destruction.
 *
 * Three destinations, in descending order of kindness:
 *   toStorage  moved into the house, nothing lost at all
 *   toSell     converted to solars at `sellPrice`, exactly what `.shop sell`
 *              would have paid, so the value survives even if the item doesn't
 *   toDrop     destroyed, and only for items that are neither storable (house
 *              full or absent) nor sellable (no sellPrice in the catalog)
 */
export function planOverflowShed(player, allItems = [], storageCap = 0) {
  const { over, held, cap } = inventoryOverflow(player)
  if (over <= 0) return { over: 0, held, cap, toStorage: [], toSell: [], toDrop: [], solars: 0, slots: [] }

  const defs = new Map((allItems ?? []).map(it => [it.id, it]))
  const priceOf = (id) => {
    const p = defs.get(id)?.sellPrice
    return Number.isFinite(p) && p > 0 ? p : 0
  }
  const valueOf = (id) => {
    const def = defs.get(id)
    if (!def) return [UNKNOWN_RANK, 0]
    return [RARITY_RANK[def.rarity] ?? UNKNOWN_RANK, priceOf(id)]
  }

  // Index-tagged so the pick is stable and we can remove exact slots later.
  const ranked = (player.inventory ?? []).map((id, i) => ({ id, i, v: valueOf(id) }))
  ranked.sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.i - b.i)
  const shed = ranked.slice(0, over)

  const storeRoom = Math.max(0, storageCap - (player.home?.storage?.length ?? 0))
  const toStorage = shed.slice(0, storeRoom).map(s => s.id)
  const toSell = []
  const toDrop = []
  let solars = 0
  for (const s of shed.slice(storeRoom)) {
    const price = priceOf(s.id)
    if (price > 0) { toSell.push(s.id); solars += price } else toDrop.push(s.id)
  }
  return { over, held, cap, toStorage, toSell, toDrop, solars, slots: shed.map(s => s.i) }
}

/**
 * Applies a plan from planOverflowShed and clears the grace stamp. Removes by
 * slot index, highest first, so duplicate ids can never remove the wrong copy.
 */
export function applyOverflowShed(player, plan) {
  if (!plan || plan.over <= 0) return { moved: [], sold: [], dropped: [], solars: 0 }
  if (!Array.isArray(player.inventory)) player.inventory = []
  for (const i of [...(plan.slots ?? [])].sort((a, b) => b - a)) player.inventory.splice(i, 1)
  if (plan.toStorage.length) {
    if (!player.home) player.home = {}
    if (!Array.isArray(player.home.storage)) player.home.storage = []
    player.home.storage.push(...plan.toStorage)
  }
  if (plan.solars > 0) {
    if (!player.wallet || typeof player.wallet !== 'object') player.wallet = {}
    player.wallet.solars = (player.wallet.solars ?? 0) + plan.solars
  }
  delete player.inventoryGrace
  return { moved: plan.toStorage, sold: plan.toSell, dropped: plan.toDrop, solars: plan.solars }
}

/**
 * "3 iron ore, 1 rough shield" from a list of ids, for player-facing copy.
 * An id with no catalog entry is title-cased from its slug rather than printed
 * raw, so a receipt never shows a player the string `trickster_vest`.
 */
export function summarizeItemIds(ids, allItems = []) {
  const defs = new Map((allItems ?? []).map(it => [it.id, it]))
  const nameOf = (id) => defs.get(id)?.name
    ?? String(id).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const counts = {}
  for (const id of ids ?? []) counts[id] = (counts[id] ?? 0) + 1
  return Object.entries(counts)
    .map(([id, n]) => `${n > 1 ? n + ' ' : ''}${nameOf(id)}`)
    .join(', ')
}

/**
 * The warning shown before anything is touched, both as a bell notification the
 * moment the grace is stamped and as a throttled nudge on their own commands
 * while it runs. `grace` is the object from checkOverflowGrace.
 */
export function overflowWarnMessage(player, grace, prefix = '.') {
  const left = formatTimeLeft((grace?.until ?? 0) - Date.now())
  return [
    `⚠️ *Bag over the limit* (${grace.held}/${grace.cap})`,
    ``,
    `Premium ended, so your inventory cap dropped from ${PREMIUM_INVENTORY_CAP} back to ${STANDARD_INVENTORY_CAP}. Until you are back under it you cannot pick up, craft or buy anything.`,
    ``,
    `You have *${left}* to sort it out yourself. After that the *${grace.over}* cheapest items are cleared for you: moved into your house storage if it has room, sold at shop price if it does not, destroyed only if they can be neither stored nor sold.`,
    ``,
    `*${prefix}shop sell <item>* to sell · *${prefix}home store <item>* to store · *${prefix}premium buy <plan>* to keep all ${PREMIUM_INVENTORY_CAP} slots.`,
  ].join('\n')
}

/** The receipt after a shed, from the object applyOverflowShed returned. */
export function overflowShedMessage(result, allItems = [], prefix = '.') {
  const lines = [`🎒 *Bag trimmed to the ${STANDARD_INVENTORY_CAP} slot limit*`, ``]
  if (result.moved?.length) lines.push(`📦 Moved to home storage (${result.moved.length}): ${summarizeItemIds(result.moved, allItems)}`)
  if (result.sold?.length) lines.push(`💰 Sold (${result.sold.length}) for *☀️ ${result.solars.toLocaleString()}*: ${summarizeItemIds(result.sold, allItems)}`)
  if (result.dropped?.length) lines.push(`🗑️ Discarded (${result.dropped.length}): ${summarizeItemIds(result.dropped, allItems)}`)
  lines.push(``, `Nothing equipped was touched. Renew premium for ${PREMIUM_INVENTORY_CAP} slots, then check *${prefix}home storage*.`)
  return lines.join('\n')
}

/**
 * The whole player-facing state machine in one call, for the command handler:
 * decides what (if anything) to say to a lapsed player about their bag, and
 * carries out the shed once the grace has run out.
 *
 *   { notice, phase, changed }
 *
 * `notice` is the message to send, or null to stay quiet. `changed` is true when
 * the player object was mutated. Never blocks a command and never throws; the
 * caller sends `notice` and then lets the command run as normal, so the very
 * message that triggers the warning can be the `.shop sell` that fixes it.
 *
 * A `player.inventoryShed` receipt parked by the periodic sweep is delivered
 * first and consumed, which is how a shed that happened while the player was
 * offline still reaches them in chat without the sweep touching a socket.
 *
 * `cooldownMs` throttles the repeat warning during grace: 0 warns on every
 * command, which is only useful in tests.
 */
export function resolveOverflowNotice(player, {
  allItems = [], storageCap = 0, prefix = '.', cooldownMs = 0, now = Date.now(),
} = {}) {
  if (!player) return { notice: null, phase: 'clear', changed: false }

  if (player.inventoryShed) {
    const notice = overflowShedMessage(player.inventoryShed, allItems, prefix)
    delete player.inventoryShed
    return { notice, phase: 'receipt', changed: true }
  }

  // Read before the call: checkOverflowGrace drops a stale stamp itself, so
  // afterwards there is no way to tell "was already fine" (the overwhelmingly
  // common case, which must not cost a write) from "just cleared a deadline".
  const hadStamp = !!player.inventoryGrace
  const grace = checkOverflowGrace(player, now)
  if (grace.phase === 'due') {
    const plan = planOverflowShed(player, allItems, storageCap)
    const result = applyOverflowShed(player, plan)
    return { notice: overflowShedMessage(result, allItems, prefix), phase: 'due', changed: true, result }
  }
  if (grace.phase === 'warned') {
    return { notice: overflowWarnMessage(player, grace, prefix), phase: 'warned', changed: true }
  }
  if (grace.phase === 'grace') {
    // Repeat the warning periodically so a 48h deadline cannot be missed,
    // without putting it on every single command.
    if (now - (player.inventoryGrace?.warnedAt ?? 0) >= cooldownMs) {
      player.inventoryGrace.warnedAt = now
      return { notice: overflowWarnMessage(player, grace, prefix), phase: 'grace', changed: true }
    }
    return { notice: null, phase: 'grace', changed: false }
  }
  // 'clear' only counts as changed when it dropped a stale deadline.
  return { notice: null, phase: 'clear', changed: hadStamp }
}
