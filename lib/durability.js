/**
 * durability.js — shared wear/break logic for equipped gear.
 *
 * Durability is tracked in a parallel map, player.equippedDurability =
 * { [slot]: currentDurability }, keyed the same as player.equipped. This
 * is additive — it does NOT change player.equipped[slot] (still a bare
 * item id string), so every existing read site (pet.js, combat-handlers,
 * named-passives, profile, etc.) keeps working untouched.
 *
 * Only items with a maxDurability field wear out. Weapons/armor/tools all
 * carry maxDurability (see data/weapons.json, data/items.json armor
 * entries, data/tools.json). Consumables, materials, and relics don't
 * have the field and never enter this map.
 */
import { allItems } from './game-data.js'
import { applyEquipmentBonus } from './combat-engine.js'
import { hasMod } from './mods.js'

const itemMap = Object.fromEntries(allItems.map((i) => [i.id, i]))

/** Slots that can carry durability-tracked gear. */
export const DURABILITY_SLOTS = ['weapon', 'offhand', 'helmet', 'chestplate', 'boots', 'tool']

/**
 * Start tracking durability for a freshly equipped item, if it has
 * maxDurability. No-op for items without the field (relics, etc.).
 */
export function initDurability(player, slot, itemId) {
  const item = itemMap[itemId]
  if (!item || !item.maxDurability) return
  player.equippedDurability = player.equippedDurability ?? {}
  player.equippedDurability[slot] = item.maxDurability
}

/** Stop tracking durability for a slot (on unequip, or after it breaks). */
export function clearDurability(player, slot) {
  if (player.equippedDurability) delete player.equippedDurability[slot]
}

/**
 * Wear down the item in a slot by `amount` (default 1). If it drops to 0
 * or below, the item breaks: its stat bonuses are stripped, it's removed
 * from player.equipped entirely (does NOT return to inventory — it's
 * destroyed), and durability tracking for the slot is cleared.
 *
 * Returns { broke: boolean, itemName: string|null, remaining: number|null }
 * so callers can report what happened. No-op (broke: false) if the slot
 * is empty or the equipped item has no durability tracked.
 */
export function wearItem(player, slot, amount = 1) {
  // Cheat mod: Unbreaking Grip (no_durability_loss). Checked here rather
  // than at each call site so weapon/armor/tool wear are all covered by
  // one gate. See lib/mods.js.
  if (hasMod(player, 'no_durability_loss')) {
    return { broke: false, itemName: null, remaining: null }
  }

  const eq = player.equipped ?? {}
  const itemId = eq[slot]
  if (!itemId) return { broke: false, itemName: null, remaining: null }

  const dur = player.equippedDurability ?? {}
  if (dur[slot] == null) return { broke: false, itemName: null, remaining: null }

  dur[slot] = Math.max(0, dur[slot] - amount)
  player.equippedDurability = dur

  if (dur[slot] <= 0) {
    const item = itemMap[itemId]
    const itemName = item?.name ?? itemId
    if (item) applyEquipmentBonus(player, item, -1)
    eq[slot] = null
    player.equipped = eq
    clearDurability(player, slot)
    return { broke: true, itemName, remaining: 0 }
  }

  return { broke: false, itemName: itemMap[itemId]?.name ?? itemId, remaining: dur[slot] }
}

/**
 * Wear the equipped weapon by a small random amount (2-4) — called once
 * per completed combat turn (attack/skill/defend). Returns the wearItem()
 * result, or null if no weapon is equipped/tracked.
 *
 * Rate note: this used to be 1-2. It was raised so gear is a resource you
 * actually feel spending, and so the repair items (Honed Whetstone / Cracked
 * Warplate) have a reason to exist. At 2-4 the cheapest 60-durability weapon
 * survives ~20 turns and a 420-durability divine piece ~140, which is several
 * full duels rather than one.
 */
export function wearWeaponOnTurn(player) {
  if (!player.equipped?.weapon) return null
  const amount = 2 + Math.floor(Math.random() * 3) // 2-4
  return wearItem(player, 'weapon', amount)
}

/**
 * Two mechanics in one call:
 *
 *   WEAR — durability loss = 15% of the hit (floored at 1). Big hits
 *          destroy armor fast; chip damage barely scratches it. Because
 *          maxDurability already scales by rarity, the tier ladder falls
 *          out of the math automatically (at ~100 dmg/hit):
 *
 *            common   (60 dur)  → ~6-7  hits
 *            uncommon (100 dur) → ~11-14 hits
 *            rare     (160 dur) → ~18-26 hits
 *            epic     (260 dur) → ~29-43 hits
 *            legendary(420 dur) → ~47-70 hits
 *
 *   ABSORB — after wear, armor heals back a share of the hit based on
 *            rarity and the durability fraction it had BEFORE the blow
 *            (full = full rate; nearly broken = nearly nothing).
 *
 *            common 8%  uncommon 12%  rare 16%  epic 20%  legendary 25%
 *
 *          Broken armor (remaining=0 after this hit) absorbs 0 — the
 *          piece is gone.
 *
 * Picks one occupied slot at random; returns wearItem() result + `absorbed`.
 */
export function wearArmorOnHit(player, damageTaken = 0) {
  const eq = player.equipped ?? {}
  const armorSlots = ['offhand', 'helmet', 'chestplate', 'boots'].filter((s) => eq[s])
  if (!armorSlots.length) return null

  const slot = armorSlots[Math.floor(Math.random() * armorSlots.length)]
  const item = itemMap[eq[slot]]

  // Capture durability BEFORE the hit so absorption uses the pre-damage value.
  const durBefore = (player.equippedDurability ?? {})[slot] ?? (item?.maxDurability ?? 0)

  // Wear: 15% of damage, minimum 1 so any hit registers.
  const wearAmount = Math.max(1, Math.round(damageTaken * 0.15))
  const result = wearItem(player, slot, wearAmount)

  // Absorb: broken pieces give nothing back.
  const absorptionByRarity = { common: 0.08, uncommon: 0.12, rare: 0.16, epic: 0.20, legendary: 0.25 }
  const rate = absorptionByRarity[item?.rarity] ?? 0.08
  const durFrac = Math.min(1, durBefore / Math.max(1, item?.maxDurability ?? 1))
  // No absorb if the piece broke on this hit, or if the blow already
  // dropped the wearer to 0: a lethal or armor-shattering hit shouldn't
  // heal HP back and revive a fighter who should be dead (the death check
  // at several call sites runs AFTER this).
  const absorbed = (result.broke || player.hp <= 0) ? 0 : Math.floor(damageTaken * rate * durFrac)
  if (absorbed > 0) player.hp = Math.min(player.maxHp ?? player.hp, player.hp + absorbed)

  return { ...result, absorbed }
}

/**
 * Wear the equipped tool (pickaxe) by 1 — called once per successful
 * .mine action.
 */
export function wearToolOnUse(player) {
  if (!player.equipped?.tool) return null
  return wearItem(player, 'tool', 1)
}

/** Format a "broke" result into a chat-ready line, or '' if nothing broke. */
export function breakMessage(result) {
  if (!result?.broke) return ''
  return `\n💥 Your *${result.itemName}* wore out and broke!`
}

/**
 * repairItem(player, slot, percentOfLoss) → { repaired, itemName, restored, remaining, max }
 *
 * Restores `percentOfLoss` percent of the durability the item has ALREADY LOST
 * (not a percentage of its maximum). Used by the mend consumables: Honed
 * Whetstone → weapon, Cracked Warplate → armor. A barely-scratched item gets a
 * tiny top-up, a nearly-broken one gets a big one, which is what makes mending
 * a mid-fight decision rather than something you spam at full durability.
 *
 * Refuses an empty, untracked, or already-full slot so the caller can decline
 * to consume the item.
 */
export function repairItem(player, slot, percentOfLoss = 50) {
  const eq = player.equipped ?? {}
  const itemId = eq[slot]
  if (!itemId) return { repaired: false, reason: 'empty', itemName: null }

  const item = itemMap[itemId]
  const max = item?.maxDurability
  if (!max) return { repaired: false, reason: 'untracked', itemName: item?.name ?? itemId }

  const dur = player.equippedDurability ?? {}
  const current = dur[slot] ?? max
  if (current >= max) {
    return { repaired: false, reason: 'full', itemName: item?.name ?? itemId, remaining: current, max }
  }

  const lost = max - current
  const restored = Math.min(lost, Math.max(1, Math.floor(lost * (percentOfLoss / 100))))
  dur[slot] = current + restored
  player.equippedDurability = dur

  return { repaired: true, slot, itemName: item?.name ?? itemId, restored, remaining: dur[slot], max }
}

/**
 * repairArmor(player, percentOfLoss) → repairItem result for the most damaged
 * occupied armor slot. The Cracked Warplate mends where it's needed most
 * rather than making the player name a slot mid-duel.
 */
export function repairArmor(player, percentOfLoss = 50) {
  const eq = player.equipped ?? {}
  const dur = player.equippedDurability ?? {}
  const candidates = ['offhand', 'helmet', 'chestplate', 'boots']
    .filter((s) => eq[s] && itemMap[eq[s]]?.maxDurability)
    .map((s) => {
      const max = itemMap[eq[s]].maxDurability
      return { slot: s, frac: (dur[s] ?? max) / max }
    })
    .sort((a, b) => a.frac - b.frac)

  if (!candidates.length) return { repaired: false, reason: 'empty', itemName: null }
  if (candidates[0].frac >= 1) {
    return { repaired: false, reason: 'full', itemName: itemMap[eq[candidates[0].slot]]?.name ?? null }
  }
  return repairItem(player, candidates[0].slot, percentOfLoss)
}

/**
 * durabilityReadout(player) → array of { slot, itemName, current, max, frac }
 * for every occupied, tracked slot. Powers the kit/gear panels.
 */
export function durabilityReadout(player) {
  const eq = player.equipped ?? {}
  const dur = player.equippedDurability ?? {}
  const out = []
  for (const slot of DURABILITY_SLOTS) {
    const id = eq[slot]
    if (!id) continue
    const item = itemMap[id]
    const max = item?.maxDurability
    if (!max) continue
    const current = dur[slot] ?? max
    out.push({ slot, itemName: item?.name ?? id, current, max, frac: current / max })
  }
  return out
}
