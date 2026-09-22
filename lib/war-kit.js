/**
 * war-kit.js — Guild War loadout isolation: "Preset 5".
 *
 * A Guild War 1v1 does NOT fight on whatever the duelist happened to be
 * carrying. The moment a war pairing actually starts (plugins/pvp.js hooks
 * the accept path), the fighter's REAL inventory, equipped gear and durability
 * map are moved into `player.warStash` — a space nothing else reads — and the
 * war preset fills the character instead:
 *
 *   1. the player's own War Preset (loadouts named `war` or `5`, saved with
 *      `.loadout save war`) supplies any slot it defines, then
 *   2. the bot-generated tier kit (WAR_KIT_TIERS[1..5]) tops up whatever is
 *      still empty, so nobody ever walks into a war naked.
 *
 * The moment the duel concludes the kit items are stripped (stat bonuses
 * reversed, durability dropped — kit items are never persisted as owned) and
 * the stashed inventory/equipped/durability come back verbatim. A fighter's
 * own belongings therefore never participate in a war duel, can never break or
 * be consumed inside one, and are exactly as they left them afterwards.
 *
 * WHY A SNAPSHOT + REVERSAL RATHER THAN A FULL PLAYER SNAPSHOT RESTORE:
 * reversing equipment bonuses with the same applyEquipmentBonus(player, item,
 * ±1) call every equip path uses keeps level-ups, XP and anything else that
 * moved during the war intact — a whole-record restore would erase them.
 *
 * The kit is applied only when a war duel actually begins and stripped on
 * every ending (victory, forfeit, timeout claim, void, war cancel). If a
 * strip is somehow missed, removeWarKit() is idempotent and the war sweep
 * will call it again, so a stranded stash cannot outlive its war.
 *
 * PURE — no db, no I/O. Both mutators take a player object and edit it in
 * place, same contract as loadout equip in plugins/loadout.js.
 */
import { allItems } from './game-data.js'
import { applyEquipmentBonus } from './combat-engine.js'
import { initDurability, clearDurability } from './durability.js'

const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))

/** The six equipment slots a war preset can occupy (same set as loadouts). */
export const WAR_KIT_SLOTS = ['weapon', 'offhand', 'helmet', 'chestplate', 'boots', 'relic']

/** Player loadout names accepted as the personal half of a war preset. */
export const WAR_PRESET_NAMES = ['war', '5', 'preset 5', 'preset5']

/**
 * The five bot-generated preset tiers. Progression is a straight gear ladder
 * (iron → steel → titanium → gemstone → endgame) plus a growing consumable
 * pouch, so a higher war declares a visibly nastier fight without ever being
 * paid for — the kit is stamped by the BOT when the war is declared, identical
 * on both sides, exactly like the prize pool.
 *
 * `totem` entries are only issued when the war's format allows totems
 * (WAR_FORMATS[*].totemAllowed), so a No-Totem war really has none on the field.
 */
export const WAR_KIT_TIERS = {
  1: {
    tier: 1, name: 'Scrap-Iron', emoji: '🪖',
    blurb: 'Salvage plate and a sharpened stick. Wars have been won with less.',
    equipped: {
      weapon: 'iron_sword', offhand: 'rough_shield', helmet: 'iron_helmet',
      chestplate: 'leather_armor', boots: 'iron_boots', relic: null,
    },
    bag: ['health_potion', 'health_potion', 'health_potion', 'mana_potion', 'mana_potion'],
    totem: null,
  },
  2: {
    tier: 2, name: 'Steel Vanguard', emoji: '⚔️',
    blurb: 'Tempered steel, drilled discipline. The line that does not break.',
    equipped: {
      weapon: 'steel_sword', offhand: 'iron_shield', helmet: 'steel_helmet',
      chestplate: 'steel_chestplate', boots: 'steel_boots', relic: null,
    },
    bag: ['health_potion', 'health_potion', 'hi_mana_potion', 'hi_mana_potion', 'mana_potion'],
    totem: null,
  },
  3: {
    tier: 3, name: 'Royal Guard', emoji: '🛡️',
    blurb: 'Titanium and a guardian\'s oaths. The wall rivals talk about.',
    equipped: {
      weapon: 'katana', offhand: 'guardian_shield', helmet: 'titanium_helmet',
      chestplate: 'titanium_chestplate', boots: 'titanium_boots', relic: null,
    },
    bag: ['hi_health_potion', 'hi_health_potion', 'hi_mana_potion', 'focus_vial', 'elixir'],
    totem: null,
  },
  4: {
    tier: 4, name: 'Mythic Warplate', emoji: '🔥',
    blurb: 'Gemstone plate over warlord bone. The ground steps back.',
    equipped: {
      weapon: 'astral_sword', offhand: 'sentinels_bulwark', helmet: 'gemstone_helm',
      chestplate: 'gemstone_warplate', boots: 'arlnord_greaves', relic: null,
    },
    bag: ['hi_health_potion', 'hi_health_potion', 'mega_mana_potion', 'focus_vial', 'elixir'],
    totem: 'totem_of_undying',
  },
  5: {
    tier: 5, name: 'Astral Ascendant', emoji: '🌟',
    blurb: 'Endgame steel and a heart of living sun. Preset 5 at full throttle.',
    equipped: {
      weapon: 'eternal_blade', offhand: 'divine_protection_aegis', helmet: 'crown_of_the_forgotten_king',
      chestplate: 'armor_of_existence', boots: 'tread_of_the_wandering_god', relic: 'heart_of_the_astral_sun',
    },
    bag: ['mega_health_potion', 'mega_health_potion', 'mega_mana_potion', 'focus_vial', 'elixir'],
    totem: 'totem_of_undying',
  },
}

export const WAR_KIT_TIER_ORDER = [1, 2, 3, 4, 5]

/** Clamp any kit-tier input onto a real tier. Never returns null. */
export function normalizeKitTier(t) {
  const n = Math.floor(Number(t))
  return WAR_KIT_TIER_ORDER.includes(n) ? n : 3
}

/** "🔥 Mythic Warplate" — label for announcements and boards. */
export function warKitLabel(tier) {
  const t = WAR_KIT_TIERS[normalizeKitTier(tier)]
  return `${t.emoji} *${t.name}* (Tier ${t.tier})`
}

/** True when this player is currently carrying an isolated war preset. */
export function hasWarKit(player) {
  return !!(player?.warStash && typeof player.warStash === 'object')
}

/**
 * The personal half of the preset: the player's own War loadout, if they
 * prepared one. Both `war` and `5` (Preset 5) are accepted, case-insensitive.
 */
function personalWarPreset(player) {
  const loadouts = player?.loadouts
  if (!loadouts || typeof loadouts !== 'object') return null
  for (const name of WAR_PRESET_NAMES) {
    const hit = loadouts[name] ?? loadouts[name.toLowerCase()] ?? loadouts[name.toUpperCase()]
    if (hit && hit.equipped && typeof hit.equipped === 'object') return hit
  }
  return null
}

/**
 * applyWarKit(player, { tier, totemAllowed, warId }) — move the player's own
 * belongings into player.warStash and fill them with the war preset.
 *
 * Returns a read-only summary: { tier, fromPreset, slotsFilled, items }.
 * Idempotent: a player already holding a kit is returned unchanged (and is
 * re-stashed only if the stash itself is somehow missing, which would mean a
 * prior strip already ran — in that case nothing is done).
 */
export function applyWarKit(player, { tier = 3, totemAllowed = true, warId = null } = {}) {
  if (!player || typeof player !== 'object') return null
  if (hasWarKit(player)) {
    const existing = player.warStash
    return { tier: existing.kitTier ?? normalizeKitTier(tier), fromPreset: existing.fromPreset ?? false, slotsFilled: existing.slotsFilled ?? 0, items: existing.kitItems ?? [], alreadyApplied: true }
  }

  const tierDef = WAR_KIT_TIERS[normalizeKitTier(tier)]
  const preset = personalWarPreset(player)

  // ── Stash the real belongings ──────────────────────────────────────────
  const stash = {
    warId,
    kitTier: tierDef.tier,
    at: Date.now(),
    inventory: Array.isArray(player.inventory) ? [...player.inventory] : [],
    equipped: { ...(player.equipped ?? {}) },
    durability: { ...(player.equippedDurability ?? {}) },
    fromPreset: false,
    slotsFilled: 0,
    kitItems: [],
  }

  // Reverse every currently equipped bonus BEFORE we touch the slots, so the
  // character is back to base stats while the kit is being built.
  const eq = { ...(player.equipped ?? {}) }
  for (const slot of WAR_KIT_SLOTS) {
    const id = eq[slot]
    if (!id) continue
    const item = itemMap[id]
    if (item) applyEquipmentBonus(player, item, -1)
    clearDurability(player, slot)
    eq[slot] = null
  }
  player.equipped = eq
  player.equippedDurability = {}

  // ── Build the kit: personal preset first, bot tier tops up ─────────────
  const kitEq = {}
  for (const slot of WAR_KIT_SLOTS) {
    const presetId = preset?.equipped?.[slot]
    if (presetId && itemMap[presetId]) {
      kitEq[slot] = presetId
      stash.fromPreset = true
      continue
    }
    const tierId = tierDef.equipped[slot]
    if (tierId && itemMap[tierId]) kitEq[slot] = tierId
    else kitEq[slot] = null
  }

  // Totems only when the war's format permits them.
  if (!totemAllowed && kitEq.offhand === 'totem_of_undying') {
    kitEq.offhand = tierDef.equipped.offhand && kitEq.offhand !== tierDef.equipped.offhand
      ? tierDef.equipped.offhand
      : 'iron_shield'
  }

  const bag = []
  for (const slot of WAR_KIT_SLOTS) {
    const id = kitEq[slot]
    if (!id) continue
    eq[slot] = id
    const item = itemMap[id]
    if (item) applyEquipmentBonus(player, item, 1)
    initDurability(player, slot, id)
    stash.kitItems.push(id)
    stash.slotsFilled += 1
  }

  // The pouch. Only real, existing consumable ids are handed out; duplicates
  // are fine — inventory is a flat id array by convention (see loadout equip).
  for (const id of tierDef.bag) {
    if (itemMap[id]) { bag.push(id); stash.kitItems.push(id) }
  }
  if (totemAllowed && tierDef.totem && itemMap[tierDef.totem]) {
    // Spare totem in the pouch so `.pvp tot`/swaps can use it if the format
    // allows; never duplicated into a slot that already holds one.
    if (!Object.values(kitEq).includes(tierDef.totem)) bag.push(tierDef.totem)
  }

  player.inventory = bag
  player.warStash = stash

  // Open the fight fresh — the duelist should meet the preset at full strength.
  player.hp = player.maxHp
  player.mp = player.maxMp

  return {
    tier: tierDef.tier,
    fromPreset: stash.fromPreset,
    slotsFilled: stash.slotsFilled,
    items: [...stash.kitItems],
  }
}

/**
 * removeWarKit(player) — strip the preset and hand the stash back.
 *
 * Idempotent: a player with no stash is returned unchanged (already restored).
 * Returns { restored: boolean, items: number }.
 */
export function removeWarKit(player) {
  if (!player || typeof player !== 'object') return { restored: false, items: 0 }
  const stash = player.warStash
  if (!stash || typeof stash !== 'object') return { restored: false, items: 0 }

  // 1. Reverse the KIT's stat bonuses and drop its durability tracking — read
  //    off what is equipped right now (i.e. the preset) before anything moves.
  const kitEq = { ...(player.equipped ?? {}) }
  for (const slot of WAR_KIT_SLOTS) {
    const id = kitEq[slot]
    if (!id) continue
    const item = itemMap[id]
    if (item) applyEquipmentBonus(player, item, -1)
    clearDurability(player, slot)
  }

  // 2. Rebuild equipped DIRECTLY from the stash, so the restored object is
  //    exactly the stashed one — same keys, same values, no kit leftovers and
  //    no slot the player never had. Bonuses and durability are re-applied on
  //    the way through.
  const eq = { ...(stash.equipped ?? {}) }
  for (const slot of WAR_KIT_SLOTS) {
    const id = eq[slot]
    if (!id) continue
    const item = itemMap[id]
    if (item) applyEquipmentBonus(player, item, 1)
    initDurability(player, slot, id)
  }
  player.equipped = eq

  // 3. Inventory comes back verbatim; durability map is the stashed one.
  player.inventory = Array.isArray(stash.inventory) ? stash.inventory : []
  player.equippedDurability = { ...(stash.durability ?? {}) }

  // 4. Full strength with their OWN gear again.
  player.hp = player.maxHp
  player.mp = player.maxMp

  delete player.warStash
  return { restored: true, items: (stash.kitItems ?? []).length }
}

/** One-line readout for boards: "🔥 Mythic Warplate (preset 5)" or "". */
export function warKitStatusLine(player) {
  if (!hasWarKit(player)) return ''
  const t = WAR_KIT_TIERS[normalizeKitTier(player.warStash.kitTier)]
  return `${t.emoji} ${t.name} preset loaded`
}
