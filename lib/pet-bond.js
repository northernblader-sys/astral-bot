/**
 * lib/pet-bond.js — Pet growth via feeding.
 *
 * Pets used to be static: adopt once, get a fixed statBonuses forever, never
 * touch them again. This gives them the same "grows with attention" shape
 * beast-engine.js already gives Summon Beasts, sized down for a passive
 * companion instead of a combat unit — feeding (spending Solars) raises a
 * per-pet bond level, which scales that pet's statBonuses multiplicatively.
 * Stats are always derived from (pet definition, stored bondXp) — never
 * stored redundantly — same principle as getBeastStats() in beast-engine.js.
 *
 * STORAGE
 * ───────
 *   player.petBonds — { [petId]: { bondXp, lastFedAt } }, one entry created
 *   lazily the first time a pet is fed. A pet never fed simply has no entry
 *   (equivalent to bondXp 0 / bond level 1) — see getBondXp/getBondLevel.
 *
 * BOND LEVEL CURVE
 * ─────────────────
 *   Level 1 → 10, XP_FOR_LEVEL apart (linear — pets are a slow, ambient
 *   system, not something to min-max, so no need for a steepening curve).
 *   Each level above 1 adds STAT_BONUS_PER_LEVEL (5%) to every one of the
 *   pet's statBonuses, capped at MAX_BOND_LEVEL (10 → +45% at max bond).
 *
 * FEEDING
 * ───────
 *   Cost scales with the pet's rarity (rarer pet = pricier treats) via
 *   rarityRank from lib/rarity.js. A short cooldown (FEED_COOLDOWN_MS)
 *   stops a single feed-spam-to-max — bonding is meant to take real time,
 *   mirroring the game's other slow-trickle systems (jobs, mining streaks).
 */
import { rarityRank } from './rarity.js'

export const MAX_BOND_LEVEL       = 10
export const XP_FOR_LEVEL         = 100   // bondXp needed per level, flat
export const STAT_BONUS_PER_LEVEL = 0.05  // +5% statBonuses per bond level above 1
export const FEED_COOLDOWN_MS     = 30 * 60 * 1000 // 30 minutes, same cadence as .work
export const FEED_XP_PER_USE      = 20

/** Solars cost to feed a pet once, scaled by rarity (common cheapest). */
export function feedCost(pet) {
  const rank = Math.max(1, rarityRank(pet.rarity))
  return rank * 15
}

/** Raw stored bondXp for a pet, 0 if never fed. */
export function getBondXp(player, petId) {
  return player.petBonds?.[petId]?.bondXp ?? 0
}

/** Derived bond level (1-MAX_BOND_LEVEL) from stored bondXp. */
export function getBondLevel(player, petId) {
  const xp = getBondXp(player, petId)
  return Math.min(MAX_BOND_LEVEL, 1 + Math.floor(xp / XP_FOR_LEVEL))
}

/** XP progress within the current level, and the XP needed for the next one. */
export function getBondProgress(player, petId) {
  const xp    = getBondXp(player, petId)
  const level = getBondLevel(player, petId)
  if (level >= MAX_BOND_LEVEL) return { into: 0, needed: 0, maxed: true }
  const into = xp % XP_FOR_LEVEL
  return { into, needed: XP_FOR_LEVEL, maxed: false }
}

/**
 * A pet's statBonuses scaled by its current bond level. Always derive
 * through this rather than reading pet.statBonuses directly anywhere
 * gameplay-facing (equip, unequip, shop preview at level 1, profile display).
 */
export function scaledStatBonuses(pet, player) {
  const level = getBondLevel(player, pet.id)
  const mult  = 1 + (level - 1) * STAT_BONUS_PER_LEVEL
  const out   = {}
  for (const [k, v] of Object.entries(pet.statBonuses ?? {})) {
    out[k] = Math.round(v * mult)
  }
  return out
}

/** Ms remaining before this pet can be fed again, 0 if available now. */
export function feedCooldownRemaining(player, petId) {
  const last = player.petBonds?.[petId]?.lastFedAt ?? 0
  return Math.max(0, FEED_COOLDOWN_MS - (Date.now() - last))
}

/**
 * Mutates player.petBonds in place — grants FEED_XP_PER_USE and stamps
 * lastFedAt. Caller (plugins/pet.js) is responsible for deducting the
 * Solars cost and running this inside updatePlayer() for the usual
 * re-validate-against-fresh-state race safety.
 */
export function applyFeed(player, petId) {
  const bonds = player.petBonds ?? {}
  const entry = bonds[petId] ?? { bondXp: 0, lastFedAt: 0 }
  entry.bondXp    += FEED_XP_PER_USE
  entry.lastFedAt  = Date.now()
  bonds[petId] = entry
  player.petBonds = bonds
  return getBondLevel(player, petId)
}

/**
 * awardPetCommandSolars(player, petMap) -> number (whole Solars credited now)
 *
 * Per-command passive income for pets whose definition carries a
 * `solarsPerCommand` value (data/pets.json — Emberpaw, the Season 1
 * firewood cat, is the first). Called once per successfully dispatched
 * command from handler.js.
 *
 * WHY AN ACCUMULATOR, NOT `wallet.solars += 0.1`
 * ───────────────────────────────────────────────
 * Every other Solars path in the codebase treats the balance as a whole
 * number (data/currency.json startingAmount 100, pvp.js's
 * Math.floor(wallet.solars * pct), every shop price). Adding 0.1 directly
 * would put values like 100.30000000000000004 into the wallet and leak
 * decimals into every balance readout. So the fraction accrues in
 * player.petSolarDust and only whole Solars ever cross into the wallet —
 * the remainder stays banked for the next command, so nothing is lost to
 * rounding.
 *
 * Requires petMap passed in by the caller rather than imported, same as
 * checkEvolution() below, to keep this file free of a game-data.js import.
 */
export function awardPetCommandSolars(player, petMap) {
  const petId = player?.equipped?.pet
  if (!petId) return 0

  const rate = Number(petMap?.[petId]?.solarsPerCommand)
  if (!Number.isFinite(rate) || rate <= 0) return 0

  const dust = (Number(player.petSolarDust) || 0) + rate
  const whole = Math.floor(dust)

  player.petSolarDust = Number((dust - whole).toFixed(4))
  if (whole > 0) {
    player.wallet = player.wallet ?? {}
    player.wallet.solars = (player.wallet.solars ?? 0) + whole
  }
  return whole
}

/**
 * Check if petId should evolve after XP was granted, mutate player in place
 * if so, and return the result so the plugin can send the evolution message.
 *
 * Call this immediately after applyFeed() inside an updatePlayer() callback.
 *
 * Requires petMap ({ [petId]: petDef }) from lib/game-data.js, passed in by
 * the caller to avoid importing game-data.js here (circular-dep risk).
 *
 * Pet definitions opt into evolution via two optional fields in data/pets.json:
 *   evolvesInto:       string   — petId of the evolved form
 *   evolvesAtBondLevel: number  — bond level that triggers the evolution
 *
 * Returns:
 *   { evolved: false }
 *   { evolved: true, fromPet, toPet, wasEquipped, oldScaled, newScaled }
 *     wasEquipped        — whether this pet was the active equipped pet
 *     oldScaled/newScaled — stat bonus maps before/after the swap; caller
 *                           applies the delta via applyEquipmentBonus if needed
 */
export function checkEvolution(player, petId, petMap) {
  const fromPet = petMap[petId]
  if (!fromPet?.evolvesInto || !fromPet?.evolvesAtBondLevel) return { evolved: false }

  const currentLevel = getBondLevel(player, petId)
  if (currentLevel < fromPet.evolvesAtBondLevel) return { evolved: false }

  const toPet = petMap[fromPet.evolvesInto]
  if (!toPet) return { evolved: false }

  const wasEquipped = player.equipped?.pet === petId

  // Capture old scaled stats before the swap so the caller can unapply them.
  const oldScaled = wasEquipped ? scaledStatBonuses(fromPet, player) : null

  // Swap petId everywhere it's referenced on the player.
  const idx = (player.pets ?? []).indexOf(petId)
  if (idx !== -1) player.pets[idx] = fromPet.evolvesInto

  if (wasEquipped) player.equipped.pet = fromPet.evolvesInto

  // Transfer bond data to the new id, preserving XP and lastFedAt exactly.
  const bonds = player.petBonds ?? {}
  if (bonds[petId]) {
    bonds[fromPet.evolvesInto] = { ...bonds[petId] }
    delete bonds[petId]
    player.petBonds = bonds
  }

  // New scaled stats after the swap (same bond XP, new pet's base statBonuses).
  const newScaled = wasEquipped ? scaledStatBonuses(toPet, player) : null

  return { evolved: true, fromPet, toPet, wasEquipped, oldScaled, newScaled }
}
