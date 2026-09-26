/**
 * game-data.js — boots the static game data layer.
 *
 * All JSON data files are loaded once at module import time and exported
 * as named constants. No plugin reads JSON files directly — they import from here.
 */

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
import { ALL_BOSSES, getBossById as getAnimeBossById } from '../bosses/index.js'

export const weapons      = require('../data/weapons.json')
export const items        = require('../data/items.json')
export const tools        = require('../data/tools.json')
export const materials    = require('../data/materials.json')
export const bossTrophies = require('../data/boss-trophies.json')
export const namedWeapons = require('../data/named-weapons.json')
/**
 * heirlooms — the empire townsfolk gifts (data/empire-heirlooms.json). Same
 * shape as namedWeapons (named: true + passiveId, so lib/named-passives.js
 * dispatches them), kept in their own file because they are empire content
 * with a different acquisition path: no shop, no craft recipe, no monster drop
 * table lists them. The only way one enters a player's inventory is a resident
 * of their realm handing it over at full favor (see plugins/folk.js).
 */
export const heirlooms = require('../data/empire-heirlooms.json')
export const animeBossSlots = require('../data/anime-boss-slots.json')
export const recipes      = require('../data/recipes.json')
export const skills       = require('../data/skills.json')
export const skillPacks   = require('../data/skill-packs.json')
export const levelsData   = require('../data/levels.json')
export const currency     = require('../data/currency.json')
export const classes      = require('../data/classes.json')
export const races        = require('../data/races.json')
export const locations    = require('../data/locations.json')
export const monsters     = require('../data/monsters.json')
export const pets         = require('../data/pets.json')
export const guilds       = require('../data/guilds.json')
export const ranks        = require('../data/ranks.json')
export const auctionItems = require('../data/auction.json')
export const abilities     = require('../data/abilities.json')
export const premiumPlans   = require('../data/premium-plans.json')
export const topupPackages  = require('../data/topup-packages.json')
/**
 * mondPackages — the Naira packs that sell Monds (data/mond-packages.json).
 * Kept separate from topupPackages because the two currencies buy different
 * things and must never share a catalog: gems spin for a character, Monds buy
 * one outright (see lib/monds.js and plugins/monds.js).
 */
export const mondPackages   = require('../data/mond-packages.json')
export const seasonOffers   = require('../data/season-offers.json')
export const beasts         = require('../data/beasts.json')
export const skillTiers     = require('../data/skill-tiers.json')
export const seasonItems     = require('../data/season-01-content.json')
export const seasonWeapons   = require('../data/season-01-weapons.json')
/**
 * seasonPacks / seasonPackItems — the gem-bought "season packs" (see
 * plugins/pack.js). seasonPacks holds the 7 bundle definitions (armor set +
 * optional weapon + title + one signature combat effect); seasonPackItems
 * holds the individual gear pieces those bundles grant. Pack items carry
 * buyPrice:null so they never appear in the ordinary shop — the only way to
 * own one is to buy its pack. Both are spread into allItems below so their ids
 * resolve everywhere (equip, inventory, sell, craft lookups).
 *
 * premiumAbilities — the 5 one-of-one premium-only abilities (data shape and
 * claim model documented in the file's _comment; engine in
 * lib/premium-abilities.js).
 */
export const seasonPacks      = require('../data/season-packs.json')
export const seasonPackItems  = require('../data/season-pack-items.json')
export const premiumAbilities = require('../data/premium-abilities.json')
export const seasonPackMap     = Object.fromEntries(seasonPacks.map((p) => [p.id, p]))
export const premiumAbilityMap = Object.fromEntries(premiumAbilities.abilities.map((a) => [a.id, a]))

/**
 * food — ingredients (type:"ingredient") and cooked dishes (type:"food"),
 * plus the Golden Apple. See lib/hunger-engine.js and plugins/cook.js.
 * foodRecipes — cooking recipes, same shape as `recipes` but category:"food".
 * Kept separate from `recipes` so the blacksmith forge (plugins/craft.js,
 * plugins/table.js) and the kitchen (plugins/cook.js, plugins/cookbook.js)
 * each see only their own recipe set.
 */
export const food         = require('../data/food.json')
export const foodRecipes  = require('../data/food-recipes.json')

/**
 * storyVolumes — Story Mode volumes (see plugins/story.js, lib/story-engine.js,
 * story/json-schema-spec.md). Each volume is its own data/story-<id>.json
 * file, listed here explicitly rather than glob-loaded so adding a new
 * volume is a one-line change, same convention as everything else above.
 *
 * Loaded defensively: a volume file that doesn't exist yet (still being
 * written) or fails to parse must never crash the bot on boot — it's just
 * silently absent from storyVolumes until the file is added, and
 * plugins/story.js reports "no volumes available" rather than throwing.
 */
function tryLoadStoryVolume(path) {
  try {
    return require(path)
  } catch {
    return null
  }
}
export const storyVolumes = [
  tryLoadStoryVolume('../data/story-beyond-the-astral.json'),
  // Future volumes: tryLoadStoryVolume('../data/story-book-two.json'),
].filter(Boolean)

// Characters — Free Fire-style equippable characters. Each has exactly one
// ability (see data/characters.json). Active character hooks are dispatched by
// the combat plugins; passive/stat handling is owned by character.js and the
// shared combat engines.
export const characters = require('../data/characters.json')
export const characterMap = Object.fromEntries(characters.map((c) => [c.id, c]))


/**
 * Indexed lookups built at load time for O(1) access in combat.
 *
 * locationsMap  — { [locationId]: locationObject }
 * regularByLoc  — { [locationId]: Monster[] }  (regular + elite)
 * bossMap       — { [bossId]: bossObject }
 * bossByLocFloor— { [locationId]: { [floor]: bossObject } }
 */

/**
 * allItems — combined weapons + items + materials + auctionItems + bossTrophies + namedWeapons,
 * keyed by id, for lookups that don't care what category an item belongs to
 * (craft, equip, inventory, sell, etc.). Named weapons are appended last so any
 * id collision with regular items causes an obvious duplicate rather than a silent
 * override.
 */
export const allItems = [
  ...weapons,
  ...items,
  ...seasonWeapons,
  ...seasonItems,
  ...seasonPackItems,
  ...tools,
  ...materials,
  ...auctionItems,
  ...bossTrophies,
  ...namedWeapons,
  ...heirlooms,
  ...food,
]

/**
 * skillTierMap — { [tierId]: { id, multiplier, emoji } } for O(1) lookups.
 * skillTierOrder — tier ids sorted from highest to lowest impact (by
 * multiplier, descending), used to group/sort skill listings by rarity.
 */
export const skillTierMap = Object.fromEntries(skillTiers.tiers.map((t) => [t.id, t]))
export const skillTierOrder = [...skillTiers.tiers]
  .sort((a, b) => b.multiplier - a.multiplier)
  .map((t) => t.id)

/** auctionItemMap — { [itemId]: itemObject } for O(1) lookups in the auction house. */
export const auctionItemMap = Object.fromEntries(auctionItems.map((i) => [i.id, i]))

export const locationsMap = Object.fromEntries(locations.map((l) => [l.id, l]))

export const regularByLoc = monsters.regular.reduce((acc, m) => {
  if (!acc[m.locationId]) acc[m.locationId] = []
  acc[m.locationId].push(m)
  return acc
}, {})

export const bossMap = Object.fromEntries(monsters.bosses.map((b) => [b.id, b]))

export const bossByLocFloor = monsters.bosses.reduce((acc, b) => {
  if (!acc[b.locationId]) acc[b.locationId] = {}
  acc[b.locationId][b.floor] = b
  return acc
}, {})

/**
 * animeBossByLocFloor — { [locationId]: { [floor]: bossId } }
 *
 * Maps every existing boss slot across the 5 dungeons (entry_tower,
 * gambits_dungeon, centurions_dungeon, astral_tower, eternal_dungeon) to one
 * of the 41 anime boss definitions in bosses/, replacing the generic bosses
 * from monsters.json 1:1. The mapping was built once by zipping the 41 real
 * boss slots (in dungeon-progression + floor order) against the 41 anime
 * bosses (sorted weakest -> strongest by grade, then floor) and is stored
 * statically in data/anime-boss-slots.json so it doesn't need to be
 * recomputed — and stays stable — at every process start.
 *
 * Use getAnimeBossForSlot(locationId, floor) to look up a boss definition
 * (from bosses/index.js) for a given slot, or null if that slot has no
 * anime boss assigned (falls back to bossByLocFloor).
 */
export const animeBossByLocFloor = animeBossSlots.reduce((acc, { locationId, floor, bossId }) => {
  if (!acc[locationId]) acc[locationId] = {}
  acc[locationId][floor] = bossId
  return acc
}, {})

/**
 * getAnimeBossForSlot(locationId, floor)
 * Returns the full anime boss definition (from bosses/index.js) assigned to
 * a given dungeon boss slot, or null if none is mapped there.
 */
export function getAnimeBossForSlot(locationId, floor) {
  const bossId = animeBossByLocFloor[locationId]?.[floor]
  if (!bossId) return null
  return getAnimeBossById(bossId)
}

export { ALL_BOSSES as animeBosses, getAnimeBossById }

/** petMap — { [petId]: petObject } for O(1) lookups (pet store, equip/unequip). */
export const petMap = Object.fromEntries(pets.map((p) => [p.id, p]))

/** beastMap — { [beastId]: beastObject } for O(1) lookups (lib/beast-engine.js, plugins/summon.js). */
export const beastMap = Object.fromEntries(beasts.map((b) => [b.id, b]))

/**
 * Build a helper map of currency defaults keyed by id, e.g.
 * { solars: 100, gems: 0, bankGold: 0, loan: 0 }
 */
export const defaultWallet = Object.fromEntries(
  currency.currencies.map((c) => [c.id, c.startingAmount]),
)

/**
 * getTotalStats(classId, raceId, level)
 *
 * Combines:
 *  - class base stats
 *  - race stat modifiers
 *  - per-level growth * (level - 1)
 *
 * Returns { str, agi, int, def, lck, maxHp, maxMp }
 */
export function getTotalStats(classId, raceId, level) {
  const cls  = classes[classId]
  const race = races[raceId]

  if (!cls)  throw new Error(`Unknown classId: ${classId}`)
  if (!race) throw new Error(`Unknown raceId: ${raceId}`)

  const growth       = levelsData.statGrowthPerLevel
  const levelsGained = Math.max(0, level - 1)
  const primaryStat  = cls.primaryStat  // e.g. 'str', 'agi', 'int'

  const statKeys = ['str', 'agi', 'int', 'def', 'lck']
  const stats = {}

  for (const key of statKeys) {
    const rate = key === primaryStat ? growth.primaryStat : growth.secondaryStat
    stats[key] =
      (cls.baseStats[key]      ?? 0) +
      (race.statModifiers[key] ?? 0) +
      rate * levelsGained
  }

  stats.maxHp =
    (cls.baseStats.maxHp ?? 0) +
    growth.maxHp * levelsGained

  stats.maxMp =
    (cls.baseStats.maxMp ?? 0) +
    growth.maxMp * levelsGained

  return stats
}
