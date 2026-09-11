/**
 * Season engine — lifecycle and player state for the time-boxed content
 * system. Content-specific rewards are layered on top of this foundation by
 * the battle pass, shop, spin, and dungeon plugins.
 */
import { createRequire } from 'module'
import { updateAllPlayers } from './player-repo.js'
import { allItems, characterMap, petMap, beastMap } from './game-data.js'
// BEAST_MAX_OWNED is used by addOwnedSeasonContent's beast branch below. It
// was referenced there without ever being imported, so buying ANY beast from
// the Season Shop threw a ReferenceError after the points had already been
// deducted inside the updatePlayer mutator.
import { BEAST_MAX_OWNED } from './beast-engine.js'
import { artworkUrl, addPokemonToPlayer } from './pokemon-engine.js'
import { applySeasonDecay } from './empire-engine.js'

const require = createRequire(import.meta.url)
export const seasons = require('../data/seasons.json')
export const seasonRewards = require('../data/season-01-rewards.json')
export const pokemonItems = require('../data/pokemon-items.json')
export const megaForms = require('../data/mega-forms.json')
export const seasonMap = Object.fromEntries(seasons.map((season) => [season.id, season]))
export const seasonContentMap = Object.fromEntries(
  allItems.filter((item) => item.seasonId).map((item) => [item.id, item]),
)

/**
 * Every item/weapon in the game keyed by id — NOT just season-exclusive ones.
 * The Season Shop stocks ordinary bot content too (named weapons, relics,
 * consumables), and those have no `seasonId`, so seasonContentMap above can't
 * see them and a shop entry for one would render as a bare id with no name,
 * price context, or artwork. Season-exclusive lookups still go through
 * seasonContentMap where the narrower set is what's wanted.
 */
export const allItemMap = Object.fromEntries(allItems.map((item) => [item.id, item]))

/** Pokémon-shop items (mega stones, held items, evolution stones) by id. */
export const pokemonItemMap = Object.fromEntries(pokemonItems.map((item) => [item.id, item]))

/**
 * Mega stone id -> the mega form it unlocks. mega-forms.json keys its stones
 * as bare PokéAPI names ("mewtwonite-x"), while pokemon-items.json ids are
 * prefixed and underscored ("poke_mewtwonite_x"), so this bridges the two
 * naming conventions once instead of at every call site.
 */
export const megaFormByStoneId = Object.fromEntries(
  megaForms.map((form) => [`poke_${String(form.megaStoneItemId).replace(/-/g, '_')}`, form]),
)

const RUNTIME_DEFAULTS = {
  activeSeasonId: null,
  startedAt: null,
  endsAt: null,
  lastEndedSeasonId: null,
  lastEndedAt: null,
  // Global (bot-wide, not per-player) exclusivity lock for the Mei Spin
  // system (plugins/season.js's `.mei-spin`) — the Major character can only
  // ever be won by ONE player across the whole bot, not owned independently
  // per player the way other season content is. Holds the winning player's
  // id, or null if she hasn't been claimed yet. See getMeiWinner()/
  // claimMeiForPlayer() below.
  meiWonBy: null,
  // Generic version of the above for every exclusive-spin character after
  // Mei (Miyashi, Nisha, ...). Mei keeps her own dedicated meiWonBy field
  // for backward compatibility with existing saves; every character after
  // her is keyed here by character id instead of getting its own field.
  // See getExclusiveSpinWinner()/claimExclusiveSpinForPlayer() below.
  exclusiveSpinWinners: {},
  // Bot-wide, finite-STOCK spin characters (Yoriichi via plugins/yo-spin.js,
  // and any future character sold as "N total copies" rather than a single
  // one-winner lock). Unlike exclusiveSpinWinners (exactly one winner ever),
  // a stock character can be won by up to `total` distinct players; each win
  // decrements the remaining count. Keyed by character id ->
  // { total, remaining, wonBy: [playerId, ...] }. See
  // getStockSpinState()/claimStockSpinUnit() below.
  stockSpinState: {},
}

/**
 * A default value that is safe to install into a db.
 *
 * Two of the RUNTIME_DEFAULTS entries are containers (`exclusiveSpinWinners`,
 * `stockSpinState`), and handing out the constant's own object would make every
 * db that took the default share ONE winners map with the module — and with
 * each other. The live bot only ever holds one db so it never showed, but any
 * script that opens two (a repair pass reading db.json alongside a
 * db.json.bak-*, which is exactly how the one-of-one records get reconciled)
 * would silently copy one save's claims into the other. Copy per db instead.
 */
function runtimeDefault(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value
}

function ensureRuntime(db) {
  if (!db.data.seasonRuntime) {
    db.data.seasonRuntime = Object.fromEntries(
      Object.entries(RUNTIME_DEFAULTS).map(([key, value]) => [key, runtimeDefault(value)]),
    )
  } else {
    for (const [key, value] of Object.entries(RUNTIME_DEFAULTS)) {
      if (!(key in db.data.seasonRuntime)) db.data.seasonRuntime[key] = runtimeDefault(value)
    }
  }
  return db.data.seasonRuntime
}

export function getSeasonById(id) {
  return seasonMap[id] ?? null
}

export function getActiveSeason(db) {
  const runtime = ensureRuntime(db)
  return runtime.activeSeasonId ? getSeasonById(runtime.activeSeasonId) : null
}

export function getSeasonRuntime(db) {
  return { ...ensureRuntime(db) }
}

/**
 * getMeiWinner(db) -> playerId | null — the bot-wide winner of the Mei
 * Spin, or null if she hasn't been claimed by anyone yet. Read-only; call
 * this before letting a player spin so a second winner can never happen.
 */
export function getMeiWinner(db) {
  return ensureRuntime(db).meiWonBy ?? null
}

/**
 * claimMeiForPlayer(db, playerId) -> boolean — atomically claims the
 * global Mei Spin lock for `playerId`. Returns true if this call is the one
 * that claimed it (i.e. no one held the lock yet), false if someone already
 * won her (including, harmlessly, the same player racing itself). Must be
 * called from inside an updatePlayer/updateAllPlayers mutator so it runs on
 * the same serialized write queue as every other db.data mutation — see
 * lib/player-repo.js's runExclusive comment. Mirrors the activeSeasonId
 * mutation pattern in startSeason()/endSeason() above: read+write
 * db.data.seasonRuntime directly via ensureRuntime(db), no separate store.
 */
export function claimMeiForPlayer(db, playerId) {
  const runtime = ensureRuntime(db)
  if (runtime.meiWonBy) return false
  runtime.meiWonBy = playerId
  return true
}

/**
 * getExclusiveSpinWinner(db, characterId) -> playerId | null — generic
 * version of getMeiWinner() for every exclusive-spin character after Mei
 * (Miyashi via plugins/miya-spin.js, Nisha via plugins/ni-spin.js, ...).
 * Read-only; call this before letting a player spin so a second winner can
 * never happen for that character.
 */
export function getExclusiveSpinWinner(db, characterId) {
  const runtime = ensureRuntime(db)
  if (!runtime.exclusiveSpinWinners || typeof runtime.exclusiveSpinWinners !== 'object') {
    runtime.exclusiveSpinWinners = {}
  }
  return runtime.exclusiveSpinWinners[characterId] ?? null
}

/**
 * claimExclusiveSpinForPlayer(db, characterId, playerId) -> boolean —
 * atomically claims the bot-wide exclusive-spin lock for `characterId` in
 * favor of `playerId`. Returns true if this call is the one that claimed
 * it, false if someone already won that character. Must be called from
 * inside an updatePlayer/updateAllPlayers mutator, same as
 * claimMeiForPlayer() above, so it runs on the same serialized write queue
 * as every other db.data mutation.
 */
export function claimExclusiveSpinForPlayer(db, characterId, playerId) {
  const runtime = ensureRuntime(db)
  if (!runtime.exclusiveSpinWinners || typeof runtime.exclusiveSpinWinners !== 'object') {
    runtime.exclusiveSpinWinners = {}
  }
  if (runtime.exclusiveSpinWinners[characterId]) return false
  runtime.exclusiveSpinWinners[characterId] = playerId
  return true
}

/**
 * releaseExclusiveSpinLock(db, characterId) -> string|null — frees the bot-wide
 * one-of-one lock and returns the playerId that held it, or null if nobody did.
 *
 * Only the owner-only revoke path (`.admin takecharacter`) calls this. Without
 * it a mis-aimed grant of a one-of-one is permanent: claimExclusiveSpinForPlayer
 * refuses once the slot is taken, so the character could never be reassigned to
 * the player who was supposed to get it. Must be called from inside an
 * updatePlayer mutator, same as claimExclusiveSpinForPlayer.
 */
export function releaseExclusiveSpinLock(db, characterId) {
  const runtime = ensureRuntime(db)
  if (!runtime.exclusiveSpinWinners || typeof runtime.exclusiveSpinWinners !== 'object') {
    runtime.exclusiveSpinWinners = {}
    return null
  }
  const held = runtime.exclusiveSpinWinners[characterId] ?? null
  delete runtime.exclusiveSpinWinners[characterId]
  return held
}

/**
 * getStockSpinState(db, characterId, total) -> { total, remaining, wonBy }
 * Generic finite-stock spin state, for characters sold as "N total copies"
 * (Yoriichi: 200) rather than exclusiveSpinWinners' single bot-wide winner.
 * Lazily initializes the pool to `total` on first read so plugins/yo-spin.js
 * doesn't need its own separate setup step. Read-only — does not mutate
 * remaining/wonBy; use claimStockSpinUnit() for that.
 */
export function getStockSpinState(db, characterId, total) {
  const runtime = ensureRuntime(db)
  if (!runtime.stockSpinState || typeof runtime.stockSpinState !== 'object') {
    runtime.stockSpinState = {}
  }
  if (!runtime.stockSpinState[characterId]) {
    runtime.stockSpinState[characterId] = { total, remaining: total, wonBy: [] }
  }
  return runtime.stockSpinState[characterId]
}

/**
 * hasClaimedStockSpin(db, characterId, playerId) -> boolean
 * A player who already owns a stock-spin character (e.g. already won one of
 * the 200 Yoriichi copies) cannot win a second copy — mirrors how
 * exclusiveSpinWinners naturally can't double-win since there's only one
 * winner; here there could be many winners, so this needs an explicit check.
 */
export function hasClaimedStockSpin(db, characterId, playerId) {
  const state = getStockSpinState(db, characterId, 0)
  return state.wonBy.includes(playerId)
}

/**
 * claimStockSpinUnit(db, characterId, playerId, total) -> boolean
 * Atomically takes one unit from the finite stock pool for `playerId`.
 * Returns false (no unit taken) if the pool is exhausted or this player
 * already holds a copy. Must be called from inside an updatePlayer/
 * updateAllPlayers mutator, same serialized-write-queue requirement as
 * claimMeiForPlayer()/claimExclusiveSpinForPlayer() above.
 */
export function claimStockSpinUnit(db, characterId, playerId, total) {
  const state = getStockSpinState(db, characterId, total)
  if (state.remaining <= 0) return false
  if (state.wonBy.includes(playerId)) return false
  state.remaining -= 1
  state.wonBy.push(playerId)
  return true
}

/**
 * chanceForExclusiveSpin(spinNumber, overrides?) -> 0..1
 *
 * Flat-plateau odds shape used by miya-spin.js/ni-spin.js: a true 0% dead
 * zone through `deadZoneUntil`, then a flat `plateauChance` per spin up to
 * (but not including) `pityAt`, then guaranteed at `pityAt`. This is
 * deliberately NOT the same shape as chanceForMajorSpin() (linear ramp) —
 * see miya-spin.js's doc comment for the full rationale. Odds from this
 * function are never shown to the player; only the pity bar is.
 */
export function chanceForExclusiveSpin(spinNumber, overrides = {}) {
  const spin = Math.max(1, Number(spinNumber) || 1)
  const pityAt = Math.max(1, Number(overrides.pityAt ?? 150))
  const deadZoneUntil = Math.max(0, Number(overrides.deadZoneUntil ?? 79))
  const plateauChance = Math.min(1, Math.max(0, Number(overrides.plateauChance ?? 0.8)))
  if (spin >= pityAt) return 1
  if (spin <= deadZoneUntil) return 0
  return plateauChance
}

export function ensurePlayerSeasonState(player, seasonId = null) {
  if (!player.seasonOwned || typeof player.seasonOwned !== 'object') {
    player.seasonOwned = {
      characters: [],
      items: [],
      weapons: [],
      titles: [],
      pokemon: [],
      pokemonItems: [],
    }
  }
  if (!player.seasonProgress || typeof player.seasonProgress !== 'object') {
    player.seasonProgress = {
      seasonId,
      battlePassTier: 0,
      seasonLevel: 0,
      currentFloor: 1,
      premiumPass: false,
      claimedTiers: [],
      spins: 0,
      majorCharacter: null,
      pointsEarned: 0,
    }
  }
  if (!Array.isArray(player.seasonProgress.claimedTiers)) {
    player.seasonProgress.claimedTiers = []
  }
  if (typeof player.seasonProgress.battlePassTier !== 'number') {
    player.seasonProgress.battlePassTier = 0
  }
  if (typeof player.seasonProgress.seasonLevel !== 'number') {
    player.seasonProgress.seasonLevel = 0
  }
  if (typeof player.seasonProgress.currentFloor !== 'number') {
    player.seasonProgress.currentFloor = 1
  }
  if (typeof player.seasonProgress.premiumPass !== 'boolean') {
    player.seasonProgress.premiumPass = false
  }
  if (typeof player.seasonProgress.pointsEarned !== 'number') {
    player.seasonProgress.pointsEarned = 0
  }
  if (typeof player.seasonPoints !== 'number') player.seasonPoints = 0
  if (seasonId && player.seasonProgress.seasonId !== seasonId) {
    player.seasonProgress.seasonId = seasonId
    player.seasonProgress.battlePassTier = 0
    player.seasonProgress.seasonLevel = 0
    player.seasonProgress.currentFloor = 1
    player.seasonProgress.premiumPass = false
    player.seasonProgress.claimedTiers = []
    player.seasonProgress.spins = 0
    player.seasonProgress.majorCharacter = null
    player.seasonProgress.pointsEarned = 0
    player.seasonPoints = 0
  }
  return player
}

export function seasonPointsForTier(season, tier) {
  const pointsPerTier = Math.max(1, Number(season?.battlePass?.pointsPerTier ?? 100))
  return Math.max(1, Math.floor(Number(tier) || 0) * pointsPerTier)
}

/* ─────────────────────────── Battle Pass curve ───────────────────────────
 *
 * A season runs 90 days, so the pass deliberately cannot be finished by one
 * sitting in the season dungeon. Both tracks — free and premium — advance on
 * the SAME curve; premium buys the second reward column at each tier, never a
 * faster climb.
 *
 * Everything funnels into one Season XP number:
 *   • a Season Level (one per cleared season-dungeon floor) is worth
 *     `xpPerSeasonLevel`
 *   • every Season Point the player has EVER earned is worth 1 — this is
 *     `seasonProgress.pointsEarned`, which only ever grows, so spending points
 *     in the shop never costs pass progress
 *
 * Tier n costs `tierBaseCost + tierCostStep * (n - 1)`, so the climb gets
 * steeper the further up it goes. With the shipped numbers, clearing all 50
 * floors lands a player around tier 23 and the back half of the pass is paid
 * for by playing the season out.
 */
export function battlePassCurve(season) {
  const bp = season?.battlePass ?? {}
  return {
    tierCount: Math.max(1, Math.floor(Number(bp.tierCount ?? 50))),
    base: Math.max(1, Number(bp.tierBaseCost ?? 120)),
    step: Math.max(0, Number(bp.tierCostStep ?? 8)),
    xpPerLevel: Math.max(0, Number(bp.xpPerSeasonLevel ?? 100)),
  }
}

/** Season XP needed to have *reached* `tier`. Tier 0 costs nothing. */
export function seasonXpForTier(season, tier) {
  const { base, step } = battlePassCurve(season)
  const n = Math.max(0, Math.floor(Number(tier) || 0))
  return Math.round(n * base + (step * n * (n - 1)) / 2)
}

/** Every source of pass progress a player holds, as one number. */
export function seasonXpOf(player, season) {
  const { xpPerLevel } = battlePassCurve(season)
  const level = Math.max(0, Number(player?.seasonProgress?.seasonLevel ?? 0))
  const earned = Math.max(0, Number(player?.seasonProgress?.pointsEarned ?? 0))
  return Math.floor(level * xpPerLevel + earned)
}

/**
 * Inverts seasonXpForTier: the highest tier fully paid for by `xp`.
 * Solves base*n + step*n*(n-1)/2 ≤ xp for n, then clamps to the tier count.
 */
export function tierForSeasonXp(season, xp) {
  const { tierCount, base, step } = battlePassCurve(season)
  const total = Math.max(0, Number(xp) || 0)
  if (step === 0) return Math.min(tierCount, Math.floor(total / base))
  const a = step / 2
  const b = base - step / 2
  const n = Math.floor((-b + Math.sqrt(b * b + 4 * a * total)) / (2 * a))
  // Guard the float: nudge back down if rounding overshot the real cost.
  const safe = Math.max(0, n)
  const settled = seasonXpForTier(season, safe) > total ? safe - 1 : safe
  return Math.min(tierCount, Math.max(0, settled))
}

/**
 * The single place `battlePassTier` is written. Call it after anything that
 * moves Season Levels or lifetime Season Points; it can only ever agree with
 * seasonXpOf(), so the two can't drift apart.
 */
export function recomputeBattlePassTier(player, season) {
  const before = player.seasonProgress.battlePassTier ?? 0
  const tier = tierForSeasonXp(season, seasonXpOf(player, season))
  player.seasonProgress.battlePassTier = tier
  return { tier, tieredUp: Math.max(0, tier - before) }
}

/**
 * Display helper: where the player sits inside their current tier.
 * `span` is 0 once the pass is maxed, so callers should guard division.
 */
export function seasonTierProgress(player, season) {
  const { tierCount } = battlePassCurve(season)
  const xp = seasonXpOf(player, season)
  const tier = tierForSeasonXp(season, xp)
  const floorXp = seasonXpForTier(season, tier)
  const nextXp = tier >= tierCount ? floorXp : seasonXpForTier(season, tier + 1)
  const span = Math.max(0, nextXp - floorXp)
  return {
    xp,
    tier,
    tierCount,
    into: Math.max(0, xp - floorXp),
    span,
    toNext: Math.max(0, nextXp - xp),
    pct: span > 0 ? Math.min(100, Math.round(((xp - floorXp) / span) * 100)) : 100,
  }
}

/** Whole-pass completion, 0-100 — moves between tiers, not just on tier-ups. */
export function seasonProgressPercent(player, season) {
  const { tierCount } = battlePassCurve(season)
  const total = seasonXpForTier(season, tierCount)
  if (total <= 0) return 0
  return Math.min(100, Math.round((seasonXpOf(player, season) / total) * 100))
}

/**
 * Season Level is deliberately separate from Season Points: cleared season
 * dungeon floors drive it, while points remain spendable currency. Both feed
 * the same pass curve above — see battlePassCurve for the pacing rationale.
 */
export function applySeasonLevel(player, season, amount = 1) {
  ensurePlayerSeasonState(player, season?.id ?? null)
  const gained = Math.max(0, Math.floor(Number(amount) || 0))
  const oldLevel = player.seasonProgress.seasonLevel
  player.seasonProgress.seasonLevel += gained
  const { tier, tieredUp } = recomputeBattlePassTier(player, season)
  return {
    oldLevel,
    seasonLevel: player.seasonProgress.seasonLevel,
    tier,
    gained,
    tieredUp,
    progress: seasonTierProgress(player, season),
  }
}

export function getSeasonReward(seasonId, tier) {
  if (seasonId !== 'season_01') return null
  return seasonRewards.find((reward) => reward.tier === Number(tier)) ?? null
}

export function getSeasonCatalog(season) {
  return (season?.shop?.catalog ?? []).map((entry) => ({
    ...entry,
    character: entry.rewardType === 'character' ? characterMap[entry.id] : null,
    pet: entry.rewardType === 'pet' ? petMap[entry.id] : null,
    beast: entry.rewardType === 'beast' ? beastMap[entry.id] : null,
    // allItemMap, not seasonContentMap — the shop stocks ordinary bot gear
    // (named weapons, relics, potions) alongside season exclusives.
    item: entry.rewardType === 'item' || entry.rewardType === 'weapon'
      ? allItemMap[entry.id]
      : null,
    pokemonItem: entry.rewardType === 'pokemonItem' ? pokemonItemMap[entry.id] : null,
    megaForm: entry.rewardType === 'pokemonItem' ? megaFormByStoneId[entry.id] ?? null : null,
  }))
}

/**
 * Display labels for shop pages. A catalog entry's `category` (see
 * data/seasons.json) decides which page it lands on; page ORDER follows each
 * category's first appearance in the catalog, so reordering the JSON reorders
 * the shop with no code change. An entry with no category, or one whose
 * category isn't listed here, still gets a page — it just falls back to the
 * raw category string (or "Other").
 */
export const SHOP_CATEGORY_LABEL = {
  exclusive: 'Season 1 Exclusives',
  arsenal: 'Legendary Arsenal',
  relic: 'Relics & Totems',
  companion: 'Pets & Beasts',
  mega: 'Mega Stones',
  legend: 'Legendary Pokémon',
  supply: 'Supplies & Essence',
}

export const SHOP_CATEGORY_EMOJI = {
  exclusive: '🌞',
  arsenal: '⚔️',
  relic: '🗿',
  companion: '🐾',
  mega: '💠',
  legend: '🔱',
  supply: '🧪',
}

/**
 * Splits a decorated catalog into shop pages, one page per `category`, in
 * first-appearance order. Returns
 *   [{ category, label, emoji, entries }, ...]
 *
 * Pages rather than fixed-size slices: a page is a themed shelf players can
 * be pointed at ("mega stones are on page 5"), and the 2×2 shop render shows
 * a page's top four, which only reads as a set if the page IS a set.
 */
export function getSeasonShopPages(catalog) {
  const order = []
  const groups = new Map()
  for (const entry of catalog ?? []) {
    const category = entry.category ?? 'other'
    if (!groups.has(category)) {
      groups.set(category, [])
      order.push(category)
    }
    groups.get(category).push(entry)
  }
  return order.map((category) => ({
    category,
    label: SHOP_CATEGORY_LABEL[category] ?? (category === 'other' ? 'Other' : category),
    emoji: SHOP_CATEGORY_EMOJI[category] ?? '•',
    entries: groups.get(category),
  }))
}

/**
 * Finds one catalog entry from free-typed player input. Matches, in order:
 * exact id, id with spaces normalised to underscores, exact name, then a
 * name/id substring. Used by `.season shop buy` and `.season info` so both
 * accept "urahara", "Mewtwonite X", "mewtwonite_x", or "legend_mewtwo".
 */
export function findSeasonCatalogEntry(catalog, query) {
  const raw = String(query ?? '').trim().toLowerCase()
  if (!raw) return null
  const underscored = raw.replace(/\s+/g, '_')
  const name = (entry) => describeSeasonEntry(entry).name.toLowerCase()
  return (
    catalog.find((entry) => entry.id.toLowerCase() === raw) ??
    catalog.find((entry) => entry.id.toLowerCase() === underscored) ??
    catalog.find((entry) => entry.id.toLowerCase() === `poke_${underscored}`) ??
    catalog.find((entry) => name(entry) === raw) ??
    catalog.find((entry) => name(entry).includes(raw)) ??
    catalog.find((entry) => entry.id.toLowerCase().includes(underscored)) ??
    null
  )
}

/**
 * describeSeasonEntry(entry) — one shape every consumer (text listings, the
 * 2×2 shop render, `.season info`, the battle pass render) can display
 * without re-deriving per-rewardType details:
 *
 *   { name, emoji, rarity, kind, image, description, stats, extra }
 *
 * `image` is a best-effort artwork URL and may be null; renders fall back to
 * a drawn emblem. Two of the sources are worth knowing about:
 *   • Pokémon → PokéAPI official artwork, keyed off the entry's dexId.
 *   • Mega stones → PokéAPI's item sprite folder. pokemon-items.json has no
 *     image field at all, and these sprites are the only artwork the bot can
 *     reach for them. Rayquazite has no sprite there (Rayquaza mega-evolves
 *     via a move, not a stone, so PokéAPI never had one) — that one entry
 *     falls through to the drawn emblem, by design.
 */
export function describeSeasonEntry(entry) {
  if (!entry) return { name: 'Unknown', emoji: '❔', rarity: null, kind: 'unknown', image: null, description: '', stats: null, extra: [] }
  const { rewardType } = entry

  if (rewardType === 'character' && entry.character) {
    const c = entry.character
    return {
      name: c.name, emoji: c.emoji ?? '🧙', rarity: c.rarity, kind: 'Character',
      image: entry.image ?? c.image ?? null,
      description: c.description ?? '',
      stats: null,
      extra: c.ability ? [`Ability: ${c.ability.name}`, c.ability.flavor] : [],
    }
  }
  if (rewardType === 'pet' && entry.pet) {
    const p = entry.pet
    return {
      name: p.name, emoji: p.emoji ?? '🐾', rarity: p.rarity, kind: 'Pet',
      image: entry.image ?? p.image ?? null,
      description: p.description ?? '',
      stats: p.statBonuses ?? null,
      extra: [`Requires level ${p.levelReq ?? 1}`],
    }
  }
  if (rewardType === 'beast' && entry.beast) {
    const b = entry.beast
    const s = b.baseStats ?? {}
    return {
      name: b.name, emoji: b.emoji ?? '🐲', rarity: b.rarity, kind: 'Beast',
      image: entry.image ?? b.image ?? null,
      description: b.description ?? '',
      stats: { str: s.atk, def: s.def, maxHp: s.maxHp },
      extra: [`Starting CP ${b.startingCp ?? 0}`, `Requires level ${b.levelReq ?? 1}`],
    }
  }
  if (rewardType === 'pokemonItem' && entry.pokemonItem) {
    const i = entry.pokemonItem
    const stone = String(i.id).replace(/^poke_/, '').replace(/_/g, '-')
    const mega = entry.megaForm
    return {
      name: i.name, emoji: '💠', rarity: i.rarity, kind: 'Mega Stone',
      image: entry.image ?? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/${stone}.png`,
      description: i.description ?? '',
      stats: null,
      extra: mega
        ? [`Unlocks ${mega.megaName}`, `Type ${(mega.type ?? []).join(' / ')}`, `Ability ${mega.ability}`]
        : ['Held item — equip it to a Pokémon to use it'],
    }
  }
  if (rewardType === 'pokemon') {
    const label = entry.name ?? String(entry.id).replace(/^legend_/, '').replace(/_/g, ' ')
    return {
      name: label.replace(/\b\w/g, (ch) => ch.toUpperCase()), emoji: '🔱', rarity: 'legendary', kind: 'Legendary Pokémon',
      image: entry.image ?? (entry.dexId ? artworkUrl(entry.dexId) : null),
      description: entry.description ?? `A legendary Pokémon, delivered at level ${entry.level ?? 5} with a rolled nature, IVs and moveset — exactly like a wild catch.`,
      stats: null,
      extra: [`Arrives at level ${entry.level ?? 5}`, `National dex #${entry.dexId ?? '???'}`],
    }
  }
  if (rewardType === 'title') {
    return {
      name: entry.name ?? String(entry.id).replace(/^title:/, ''), emoji: '🏷️', rarity: 'epic', kind: 'Title',
      image: entry.image ?? null,
      description: 'A season title shown on your profile.',
      stats: null, extra: [],
    }
  }
  if (rewardType === 'gems' || rewardType === 'solars' || rewardType === 'seasonPoints' || rewardType === 'xp') {
    const label = { gems: 'Gems', solars: 'Solars', seasonPoints: 'Season Points', xp: 'XP' }[rewardType]
    const emoji = { gems: '💎', solars: '☀️', seasonPoints: '✨', xp: '📈' }[rewardType]
    return {
      name: `${entry.amount ?? 0} ${label}`, emoji, rarity: 'rare', kind: 'Currency',
      image: entry.image ?? null,
      description: `Adds ${entry.amount ?? 0} ${label} straight to your wallet.`,
      stats: null, extra: [],
    }
  }
  // item / weapon
  const i = entry.item
  if (i) {
    return {
      name: i.name, emoji: i.type === 'weapon' ? '⚔️' : i.type === 'relic' ? '🗿' : i.type === 'consumable' ? '🧪' : '🛡️',
      rarity: i.rarity, kind: i.type === 'weapon' ? 'Weapon' : i.type === 'armor' ? 'Armor' : i.type === 'relic' ? 'Relic' : i.type === 'consumable' ? 'Consumable' : 'Item',
      image: entry.image ?? i.image ?? null,
      description: i.description ?? '',
      stats: i.statBonuses ?? null,
      extra: [
        i.levelReq ? `Requires level ${i.levelReq}` : null,
        i.slot ? `Slot: ${i.slot}` : null,
        i.maxDurability ? `Durability ${i.maxDurability}` : null,
        i.passiveId ? `Passive: ${String(i.passiveId).replace(/_/g, ' ')}` : null,
      ].filter(Boolean),
    }
  }
  return {
    name: entry.name ?? entry.id, emoji: '📦', rarity: null, kind: rewardType ?? 'Item',
    image: entry.image ?? null, description: '', stats: null, extra: [],
  }
}

/**
 * describePassReward(reward) — the same descriptor shape as
 * describeSeasonEntry(), for a Battle Pass reward.
 *
 * The two data files disagree on field names: shop entries in seasons.json key
 * the thing by `id`, while season-01-rewards.json keys it by `itemId` and puts
 * a stack size in `amount`. Rather than teach every renderer both shapes, this
 * normalises a pass reward into a catalog-entry-like object and hands it to the
 * one describer. `amount` is returned separately (as `count`) because a pass
 * reward can be "3× Astral Dust" while a shop entry never is.
 */
export function describePassReward(reward) {
  if (!reward) return { ...describeSeasonEntry(null), count: 0 }
  const { rewardType, itemId, amount } = reward
  const asEntry = {
    ...reward,
    id: itemId ?? reward.id ?? rewardType,
    character: rewardType === 'character' ? characterMap[itemId] : null,
    pet: rewardType === 'pet' ? petMap[itemId] : null,
    beast: rewardType === 'beast' ? beastMap[itemId] : null,
    item: rewardType === 'item' || rewardType === 'weapon'
      ? seasonContentMap[itemId] ?? allItemMap[itemId]
      : null,
    pokemonItem: rewardType === 'pokemonItem' ? pokemonItemMap[itemId] : null,
    megaForm: rewardType === 'pokemonItem' ? megaFormByStoneId[itemId] ?? null : null,
  }
  const info = describeSeasonEntry(asEntry)
  const count = Math.max(1, Math.floor(Number(amount) || 1))
  return { ...info, count }
}

/**
 * chanceForMajorSpin(spinNumber, season, overrides?) -> 0..1
 *
 * `overrides` lets a caller reuse this exact ramp shape (flat 1% floor,
 * linear ramp from rampStart to pityAt, guaranteed at pityAt) with
 * different numbers than season.gemSpin — e.g. plugins/season.js's
 * `.mei-spin` reuses this with { rampStart: 50 } instead of season.json's
 * gemSpin.rampStart (80), since Mei Spin is now a fully separate system
 * from the old per-player gemSpin block. Falls back to season.gemSpin's
 * values (then the hardcoded defaults) when no override is given, so
 * every existing caller is unaffected.
 */
export function chanceForMajorSpin(spinNumber, season, overrides = {}) {
  const spin = Math.max(1, Number(spinNumber) || 1)
  const pityAt = Math.max(1, Number(overrides.pityAt ?? season?.gemSpin?.pityAt ?? 100))
  const rampStart = Math.max(1, Number(overrides.rampStart ?? season?.gemSpin?.rampStart ?? 80))
  if (spin >= pityAt) return 1
  if (spin < rampStart) return 0.01
  const span = Math.max(1, pityAt - rampStart - 1)
  const progress = Math.min(1, Math.max(0, (spin - rampStart) / span))
  return 0.01 + progress * 0.94
}

export function formatPercent(value) {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`
}

/**
 * Adds season points and advances the cumulative Battle Pass tier. This
 * mutates the player object so callers can use it inside updatePlayer's
 * atomic transaction.
 */
export function applySeasonPoints(player, season, amount, { fromPass = false } = {}) {
  ensurePlayerSeasonState(player, season?.id ?? null)
  const points = Math.max(0, Math.floor(Number(amount) || 0))
  if (!points) return { points: player.seasonPoints, tier: player.seasonProgress.battlePassTier, gained: 0, tieredUp: 0 }
  player.seasonPoints += points
  // Points handed out BY the pass are spendable but don't count as earned —
  // otherwise a tier reward would pay for part of the next tier and the pass
  // would partly climb itself.
  if (!fromPass) player.seasonProgress.pointsEarned += points
  // Lifetime earned points are half the pass curve (see battlePassCurve), so
  // the tier has to be recomputed here as well as on a Season Level.
  const { tier, tieredUp } = recomputeBattlePassTier(player, season)
  return {
    points: player.seasonPoints,
    tier,
    gained: points,
    tieredUp,
  }
}

export function addOwnedSeasonContent(player, rewardType, itemId, amount = 1) {
  ensurePlayerSeasonState(player)
  const count = Math.max(1, Math.floor(Number(amount) || 1))
  if (rewardType === 'character') {
    player.ownedCharacters = player.ownedCharacters ?? []
    if (!player.ownedCharacters.includes(itemId)) player.ownedCharacters.push(itemId)
    if (!player.seasonOwned.characters.includes(itemId)) player.seasonOwned.characters.push(itemId)
    return
  }
  // Pets and beasts are granted into the systems that already own them
  // (plugins/pet.js's player.pets, lib/beast-engine.js's summonedBeasts +
  // beastInventory) rather than into inventory — buying one here is exactly
  // equivalent to adopting/summoning it, so every downstream command
  // (.pet equip, .pet feed, .equipbeast, evolution) works untouched.
  if (rewardType === 'pet') {
    player.pets = player.pets ?? []
    if (!player.pets.includes(itemId)) player.pets.push(itemId)
    return
  }
  if (rewardType === 'beast') {
    // The 4-beast cap is enforced on ACQUISITION (see beast-engine.js's
    // ownership-model doc comment; plugins/mine.js gates its random find the
    // same way), so a shop grant has to respect it too. plugins/season.js's
    // buyShopEntry checks summonedBeasts.length against BEAST_MAX_OWNED and
    // refuses the sale BEFORE charging — this guard only stops the roster
    // being overfilled if some other caller skips that check.
    const def = beastMap[itemId]
    player.summonedBeasts = player.summonedBeasts ?? []
    player.beastInventory = player.beastInventory ?? []
    if (
      !player.summonedBeasts.some((b) => b.beastId === itemId) &&
      player.summonedBeasts.length < BEAST_MAX_OWNED
    ) {
      player.summonedBeasts.push({ beastId: itemId, cp: def?.startingCp ?? 0, obtainedAt: Date.now() })
    }
    if (!player.beastInventory.some((b) => b.beastId === itemId)) {
      player.beastInventory.push({ beastId: itemId, obtainedAt: Date.now() })
    }
    return
  }
  if (rewardType === 'title') {
    if (!player.seasonOwned.titles.includes(itemId)) player.seasonOwned.titles.push(itemId)
    player.title = player.title ?? itemId
    return
  }
  // Pokémon-shop items (mega stones, held items) live in the SAME
  // player.inventory array as regular gear, tagged by their poke_ id prefix —
  // see plugins/pokeshop.js's header note. So this is the ordinary item path
  // with a separate seasonOwned bucket for "what did the season give me".
  if (rewardType === 'pokemonItem') {
    player.seasonOwned.pokemonItems = player.seasonOwned.pokemonItems ?? []
    if (!player.seasonOwned.pokemonItems.includes(itemId)) player.seasonOwned.pokemonItems.push(itemId)
    player.inventory = player.inventory ?? []
    for (let i = 0; i < count; i++) player.inventory.push(itemId)
    return
  }
  // A live Pokémon can't be granted from here: building one needs a PokéAPI
  // fetch (species stats + movepool), and this function is synchronous
  // because it runs inside updatePlayer's mutator. The caller fetches first
  // and then calls addSeasonPokemon() below with the result.
  if (rewardType === 'pokemon') {
    throw new Error('addOwnedSeasonContent: use addSeasonPokemon() for rewardType "pokemon"')
  }
  const key = rewardType === 'weapon' ? 'weapons' : 'items'
  if (!player.seasonOwned[key].includes(itemId)) player.seasonOwned[key].push(itemId)
  player.inventory = player.inventory ?? []
  for (let i = 0; i < count; i++) player.inventory.push(itemId)
}

export function hasOwnedSeasonContent(player, rewardType, itemId) {
  ensurePlayerSeasonState(player)
  if (rewardType === 'character') return (player.ownedCharacters ?? []).includes(itemId)
  if (rewardType === 'pet') return (player.pets ?? []).includes(itemId)
  if (rewardType === 'beast') {
    // The evolved form counts as owning the line — otherwise a player whose
    // Slimeling has already evolved could re-buy the pre-evolved form.
    const evolved = beastMap[itemId]?.evolvesInto
    return (player.summonedBeasts ?? []).some(
      (b) => b.beastId === itemId || (evolved && b.beastId === evolved),
    )
  }
  if (rewardType === 'title') return player.seasonOwned.titles.includes(itemId.replace(/^title:/, ''))
  if (rewardType === 'pokemonItem') {
    // Held items leave the inventory while equipped (plugins/equip.js's
    // convention, mirrored by .p-poke hold), so a stone attached to a Pokémon
    // is still owned — check both places or a player could buy a second copy
    // of a one-per-season stone just by holding the first.
    return (player.inventory ?? []).includes(itemId) ||
      (player.pokemon ?? []).some((mon) => mon?.heldItem === itemId)
  }
  if (rewardType === 'pokemon') return false
  const key = rewardType === 'weapon' ? 'weapons' : 'items'
  return (player.seasonOwned[key] ?? []).includes(itemId)
}

/**
 * Ownership check for a live Pokémon shop entry — by species (dexId), not by
 * the owned-instance id, since a player who already bought Mewtwo owns that
 * species however many other Pokémon they've caught since.
 */
export function hasOwnedSeasonPokemon(player, dexId) {
  return (player?.pokemon ?? []).some((mon) => mon?.dexId === Number(dexId))
}

export function rewardLabel(reward) {
  if (!reward) return 'Unknown reward'
  if (reward.rewardType === 'character') return characterMap[reward.itemId]?.name ?? reward.itemId
  if (reward.rewardType === 'pet') return petMap[reward.itemId]?.name ?? reward.itemId
  if (reward.rewardType === 'beast') return beastMap[reward.itemId]?.name ?? reward.itemId
  if (reward.rewardType === 'title') return reward.name ?? reward.itemId
  if (reward.rewardType === 'pokemonItem') return pokemonItemMap[reward.itemId]?.name ?? reward.itemId
  if (reward.rewardType === 'item' || reward.rewardType === 'weapon') {
    // seasonContentMap first (season exclusives keep their own naming), then
    // the full item map so ordinary bot gear used as a reward still resolves.
    const found = seasonContentMap[reward.itemId] ?? allItemMap[reward.itemId]
    return found?.name ?? reward.itemId
  }
  return `${reward.amount ?? 0} ${reward.rewardType}`
}

/**
 * Grants a live Pokémon bought from the Season Shop. Mutates `player` in
 * place, so it runs inside updatePlayer's mutator like every other grant —
 * but `rawPokemon` must be fetched BEFORE the transaction opens
 * (fetchPokemonById), because the mutator itself is synchronous.
 *
 * The Pokémon is built by the same addPokemonToPlayer() a wild catch uses,
 * so it gets a rolled nature, IVs, EVs and a real movepool-derived moveset —
 * a bought legendary is a normal member of the collection, not a special
 * case every downstream command would have to know about.
 */
export function addSeasonPokemon(player, rawPokemon, { level = 5 } = {}) {
  ensurePlayerSeasonState(player)
  const owned = addPokemonToPlayer(player, rawPokemon, { level })
  player.seasonOwned.pokemon = player.seasonOwned.pokemon ?? []
  if (!player.seasonOwned.pokemon.includes(owned.id)) player.seasonOwned.pokemon.push(owned.id)
  return owned
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'ended'
  const totalMinutes = Math.ceil(ms / 60_000)
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60
  const parts = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (minutes || !parts.length) parts.push(`${minutes}m`)
  return parts.join(' ')
}

export async function startSeason(db, seasonId, now = Date.now()) {
  const season = getSeasonById(seasonId)
  if (!season) throw new Error(`Unknown season: ${seasonId}`)

  const runtime = ensureRuntime(db)
  if (runtime.activeSeasonId && runtime.activeSeasonId !== seasonId) {
    throw new Error(`Season ${runtime.activeSeasonId} is already active`)
  }

  const startedAt = runtime.startedAt ?? now
  const endsAt = runtime.endsAt ?? startedAt + (season.durationDays ?? 90) * 86_400_000
  await updateAllPlayers(db, (users) => {
    const live = ensureRuntime(db)
    live.activeSeasonId = seasonId
    live.startedAt = startedAt
    live.endsAt = endsAt
    let changed = true
    for (const player of Object.values(users)) {
      const before = JSON.stringify(player.seasonProgress)
      ensurePlayerSeasonState(player, seasonId)
      if (JSON.stringify(player.seasonProgress) !== before) changed = true
    }
    return changed
  })
  return getSeasonRuntime(db)
}

export async function endSeason(db, now = Date.now()) {
  const runtime = ensureRuntime(db)
  const season = getActiveSeason(db)
  if (!season) return { ended: false, season: null, converted: 0 }

  let converted = 0
  let empiresDecayed = 0, fameDecayed = 0, treasuryDecayed = 0
  const conversionRate = Math.max(0, Number(season.endOfSeason?.seasonPointsToSolars ?? 10))
  await updateAllPlayers(db, (users) => {
    for (const player of Object.values(users)) {
      ensurePlayerSeasonState(player, season.id)
      const points = Math.max(0, Math.floor(player.seasonPoints ?? 0))
      converted += points
      player.wallet = player.wallet ?? {}
      player.wallet.solars = (player.wallet.solars ?? 0) + points * conversionRate
      player.seasonPoints = 0
      player.seasonProgress.endedAt = now
      player.seasonProgress.convertedPoints = points
    }
    // Empire prestige decays on every season roll so no empire towers over the
    // map forever. Fame here is empire prestige, NOT a player's locked stat, so
    // trimming it is in-bounds. Done in the same atomic pass as the conversion.
    for (const rec of Object.values(db.data.empires ?? {})) {
      if (!rec) continue
      const d = applySeasonDecay(rec)
      if (d.fameLost || d.treasuryLost) {
        empiresDecayed++
        fameDecayed += d.fameLost
        treasuryDecayed += d.treasuryLost
      }
    }
    runtime.activeSeasonId = null
    runtime.startedAt = null
    runtime.endsAt = null
    runtime.lastEndedSeasonId = season.id
    runtime.lastEndedAt = now
    db.data.seasonHistory = db.data.seasonHistory ?? []
    db.data.seasonHistory.push({
      seasonId: season.id,
      endedAt: now,
      convertedPoints: converted,
      conversionRate,
      empiresDecayed,
      fameDecayed,
      treasuryDecayed,
    })
    return true
  })
  return { ended: true, season, converted, conversionRate, empiresDecayed, fameDecayed, treasuryDecayed }
}

/**
 * Starts the first auto-start season when the bot has no active season and
 * closes an expired season. Safe to call from a periodic process sweep.
 */
export async function syncSeasonLifecycle(db, now = Date.now()) {
  const runtime = ensureRuntime(db)
  if (runtime.activeSeasonId && runtime.endsAt && now >= runtime.endsAt) {
    const ended = await endSeason(db, now)
    return { action: 'ended', ...ended }
  }
  if (!runtime.activeSeasonId) {
    const next = seasons.find((season) => season.autoStart && season.id !== runtime.lastEndedSeasonId)
    if (next) {
      const started = await startSeason(db, next.id, now)
      return { action: 'started', season: next, runtime: started }
    }
  }
  return { action: 'none', season: getActiveSeason(db), runtime: getSeasonRuntime(db) }
}

export function seasonStatus(db, player = null, now = Date.now()) {
  const runtime = getSeasonRuntime(db)
  const season = getActiveSeason(db)
  if (!season) return { active: false, runtime, season: null, player: null }
  if (player) ensurePlayerSeasonState(player, season.id)
  return {
    active: true,
    runtime,
    season,
    remainingMs: Math.max(0, (runtime.endsAt ?? now) - now),
    player: player
      ? {
          points: player.seasonPoints,
          seasonLevel: player.seasonProgress.seasonLevel,
          currentFloor: player.seasonProgress.currentFloor,
          tier: player.seasonProgress.battlePassTier,
          tierCount: season.battlePass.tierCount,
          premiumPass: player.seasonProgress.premiumPass,
          spins: player.seasonProgress.spins,
          progressPercent: seasonProgressPercent(player, season),
        }
      : null,
  }
}