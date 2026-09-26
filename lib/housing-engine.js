/**
 * lib/housing-engine.js — the housing / farming / fishing pillar's rules.
 *
 * Everything stateful about a player's home lives in `player.home`, and every
 * mutation of it goes through updatePlayer() in the plugins. This module is
 * deliberately pure: it reads a player object and returns descriptions,
 * costs and outcomes. That split is what makes the whole pillar testable
 * without a WhatsApp socket (see scripts/housing-check.mjs).
 *
 * Player schema addition (mirrors lib/player-repo.js's top-of-file doc):
 *   home: {
 *     tier:      string,        // housing.json tier id — 'tent' on first claim
 *     rooms:     string[],      // built room ids, no duplicates
 *     decor:     string[],      // placed decor ids, no duplicates
 *     storage:   string[],      // item ids kept at home (flat, like chest.items)
 *     plots: Array<{            // one entry per planted plot; harvest empties it
 *       cropId:  string,
 *       plantedAt: number,      // epoch ms
 *       readyAt:   number,      // epoch ms — precomputed so a later greenhouse
 *                               // build can't retroactively speed up a crop
 *                               // already in the ground
 *     }>,
 *     visitors:  string[],      // jids allowed in via .homeinvite
 *     harvest:   { [cropId]: number },  // picked produce, unsold
 *     bucket:    { [fishId]: number },  // landed fish, unsold
 *     lastRest:  number|null,   // epoch ms of last .home rest
 *     lastFish:  number|null,   // epoch ms of last .fish
 *     lastParty: number|null,   // epoch ms of last .homeparty
 *     founded:   number,        // epoch ms of first claim
 *   }
 *
 * TIME IS REAL, NOT TICKED. Crop readiness is `Date.now() >= readyAt`, so
 * growth continues while the bot is offline and survives restarts without a
 * scheduler. There is no cron, no interval, nothing to lose — which is the
 * whole reason readyAt is stored rather than a remaining-minutes counter.
 */
import housing from '../data/housing.json' with { type: 'json' }

export const TIERS = housing.tiers
export const ROOMS = housing.rooms
export const DECOR = housing.decor
export const CROPS = housing.crops
export const FISH  = housing.fish

export const tierMap = Object.fromEntries(TIERS.map(t => [t.id, t]))
export const roomMap = Object.fromEntries(ROOMS.map(r => [r.id, r]))
export const decorMap = Object.fromEntries(DECOR.map(d => [d.id, d]))
export const cropMap = Object.fromEntries(CROPS.map(c => [c.id, c]))
export const fishMap = Object.fromEntries(FISH.map(f => [f.id, f]))

/** Tiers in rank order — the upgrade ladder. */
export const TIER_ORDER = [...TIERS].sort((a, b) => a.rank - b.rank)

export const REST_COOLDOWN_MS = 30 * 60 * 1000
export const FISH_COOLDOWN_MS = 8 * 60 * 1000

/**
 * Ensures player.home exists in the expected shape. Backfills accounts that
 * predate this feature *without* granting them a house: `tier` stays null
 * until .home claim, so the absence of a home is representable. Every other
 * field is initialised so callers never have to null-check them.
 */
export function ensureHome(player) {
  const home = player.home ?? (player.home = {})
  if (typeof home.tier !== 'string') home.tier = null
  if (!Array.isArray(home.rooms)) home.rooms = []
  if (!Array.isArray(home.decor)) home.decor = []
  if (!Array.isArray(home.storage)) home.storage = []
  if (!Array.isArray(home.plots)) home.plots = []
  if (!Array.isArray(home.visitors)) home.visitors = []
  // Produce and catches are keyed maps rather than flat arrays: they only ever
  // hold counts, and .farm sell / .fish sell zero an entry instead of splicing.
  if (!home.harvest || typeof home.harvest !== 'object') home.harvest = {}
  if (!home.bucket || typeof home.bucket !== 'object') home.bucket = {}
  if (typeof home.lastRest !== 'number') home.lastRest = null
  if (typeof home.lastFish !== 'number') home.lastFish = null
  if (typeof home.lastParty !== 'number') home.lastParty = null
  if (typeof home.founded !== 'number') home.founded = null
  return home
}

/** True once the player has claimed any home at all. */
export function hasHome(player) {
  return typeof player?.home?.tier === 'string' && !!tierMap[player.home.tier]
}

export function tierOf(player) {
  return tierMap[player?.home?.tier] ?? null
}

/** The next tier up, or null at the top of the ladder. */
export function nextTier(tierId) {
  const cur = tierMap[tierId]
  if (!cur) return TIER_ORDER[0] ?? null
  return TIER_ORDER.find(t => t.rank === cur.rank + 1) ?? null
}

/**
 * Sums a perk across built rooms. Rooms with the same perk stack (a study
 * and a library both give XP) — that's intentional, it's what makes the
 * late-tier room list worth filling rather than picking one of each kind.
 */
export function perkTotal(player, perk) {
  const home = player?.home
  if (!home?.rooms?.length) return 0
  return home.rooms.reduce((sum, id) => {
    const room = roomMap[id]
    return room?.perk === perk ? sum + (room.value ?? 0) : sum
  }, 0)
}

/** Comfort = sum of placed decor. Drives the neighborhood map's ranking. */
export function comfortOf(player) {
  const decor = player?.home?.decor ?? []
  return decor.reduce((sum, id) => sum + (decorMap[id]?.comfort ?? 0), 0)
}

/** Total home storage capacity: tier base plus any cellar. */
export function storageCap(player) {
  const tier = tierOf(player)
  if (!tier) return 0
  return (tier.storage ?? 0) + perkTotal(player, 'storage')
}

/** How many plots the player can have in the ground at once. */
export function plotCap(player) {
  const tier = tierOf(player)
  return tier ? (tier.plots ?? 0) : 0
}

/** Rooms buildable right now: tier rank allows it, not already built, room slots left. */
export function availableRooms(player) {
  const tier = tierOf(player)
  if (!tier) return []
  const built = new Set(player.home.rooms)
  return ROOMS.filter(r => r.minRank <= tier.rank && !built.has(r.id))
}

export function roomSlotsLeft(player) {
  const tier = tierOf(player)
  if (!tier) return 0
  return Math.max(0, (tier.rooms ?? 0) - (player.home.rooms?.length ?? 0))
}

export function decorSlotsLeft(player) {
  const tier = tierOf(player)
  if (!tier) return 0
  return Math.max(0, (tier.decorSlots ?? 0) - (player.home.decor?.length ?? 0))
}

/** Crops the player's tier unlocks. */
export function availableCrops(player) {
  const tier = tierOf(player)
  if (!tier) return []
  return CROPS.filter(c => c.minRank <= tier.rank)
}

/**
 * Growth time for a crop *at plant time*, after the greenhouse discount.
 * Called once and baked into the plot's readyAt — see the module header for
 * why this is not recomputed on read.
 */
export function growthMsFor(player, crop) {
  const speedup = perkTotal(player, 'growth')          // percent
  const factor = Math.max(0.25, 1 - speedup / 100)     // floor so stacking can't hit zero
  return Math.round(crop.minutes * 60 * 1000 * factor)
}

export function plotReady(plot, now = Date.now()) {
  return now >= (plot?.readyAt ?? Infinity)
}

/** Splits plots into ready / growing, preserving their original index. */
export function splitPlots(player, now = Date.now()) {
  const plots = player?.home?.plots ?? []
  const ready = []
  const growing = []
  plots.forEach((plot, index) => {
    ;(plotReady(plot, now) ? ready : growing).push({ ...plot, index })
  })
  return { ready, growing }
}

/** "2h 14m" / "45m" / "under a minute" — used in every farm view. */
export function formatRemaining(ms) {
  if (ms <= 0) return 'ready'
  const mins = Math.ceil(ms / 60000)
  if (mins < 1) return 'under a minute'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${m}m`
}

/**
 * Rolls a fish using the weight table. Higher-tier homes don't bias the
 * roll — fishing is deliberately the one part of the pillar that stays
 * level with everyone, so a new player at a tent can still land a Void Koi.
 * `rng` is injectable so the check script can assert distribution instead
 * of hoping.
 */
export function rollFish(rng = Math.random) {
  const total = FISH.reduce((sum, f) => sum + f.weight, 0)
  let roll = rng() * total
  for (const fish of FISH) {
    roll -= fish.weight
    if (roll <= 0) return fish
  }
  return FISH[0]
}

/** Yield roll for a harvested crop, inclusive of both bounds. */
export function rollYield(crop, rng = Math.random) {
  const min = crop.yieldMin ?? 1
  const max = Math.max(min, crop.yieldMax ?? min)
  return min + Math.floor(rng() * (max - min + 1))
}

/**
 * The fishing minigame: a cast lands in one of `slots` positions and the
 * player has to name it. Difficulty scales the slot count, so a Void Koi is
 * a 1-in-8 guess while a minnow is a coin flip — the rarity table already
 * decides *what* bites, this decides whether you keep it.
 */
export function castSlots(difficulty) {
  return Math.min(8, Math.max(2, Number(difficulty) || 2))
}

/** Cooldown helper shared by rest and fish. Returns remaining ms, 0 if ready. */
export function cooldownLeft(last, windowMs, now = Date.now()) {
  if (typeof last !== 'number') return 0
  return Math.max(0, last + windowMs - now)
}
