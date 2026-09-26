/**
 * lib/empire-engine.js — the Empire pillar's rules, kept pure.
 *
 * Everything stateful about an empire lives in a record on db.data.empires
 * (keyed by empire id), and everything about a player's membership lives in
 * three fields on the player (empireId / empireRole / empireJoinedAt). This
 * module never touches a socket and never writes the db: it reads a record or
 * a player and returns tiers, costs, production summaries and upkeep math.
 * That split is what makes the whole pillar testable from scripts/empire-check.mjs.
 *
 * Empire record shape (Phase 1 subset — later phases add army/market/war):
 *   {
 *     id, name, ownerId,
 *     foundedAt, lastActiveAt,     // ms; lastActiveAt drives later dormancy sweeps
 *     fame,                        // empire prestige; seeded from owner fame at founding
 *     tierId,                      // cached, always recomputed from fame on read
 *     treasury,                    // solars the empire owns. The ONLY thing a raid loots.
 *     warehouse: { [materialId]: count },   // keyed integer counts, never an array
 *     buildings: [ { type, level, lastCollectedAt } ],
 *   }
 *
 * TIME IS REAL, NOT TICKED. Production is `Date.now() - lastCollectedAt`
 * clamped to an offline cap, computed only when the owner runs `.empire
 * collect`. There is no cron and no interval: an empire left alone for a week
 * and an empire collected hourly earn the same, up to the cap. This is the
 * same claim-based model as the housing pillar, chosen for the same reason:
 * it survives restarts and offline stretches with nothing to lose.
 */
import empireData from '../data/empire.json' with { type: 'json' }
import { shortSolars } from './guild-engine.js'
// Pure, dependency-free name pools, so importing them here cannot create a cycle.
import { townsfolkName } from './soldier-names.js'

export const EMPIRE_CONFIG = empireData.config
export const TIERS = empireData.tiers
export const BUILDING_DEFS = empireData.buildings
export const SHOP_PRICES = empireData.shop
export const RAID_CONFIG = empireData.raid
export const ASSIGN_CONFIG = empireData.assignments
export const MARKET_CONFIG = empireData.market
export const WAR_CONFIG = empireData.war
export const SELL_CONFIG = empireData.sell
export const LIFECYCLE_CONFIG = empireData.lifecycle
export const POP_CONFIG = empireData.population
export const BLACKSMITH_CONFIG = empireData.blacksmith
export const BANK_CONFIG = empireData.bank
export const COFFEE_CONFIG = empireData.coffee
export const PREMIUM_SHOP_CONFIG = empireData.premiumShop
export const REGIONS_CONFIG = empireData.regions

export const tierMap = Object.fromEntries(TIERS.map(t => [t.id, t]))
export const buildingDefMap = Object.fromEntries(BUILDING_DEFS.map(b => [b.type, b]))
export const TIER_ORDER = [...TIERS].sort((a, b) => a.rank - b.rank)

/**
 * The 8 compass regions every empire's buildings are placed into. This is a
 * PLACEMENT layer only, not new capacity: the tier's buildingCap (see TIERS)
 * remains the one real ceiling on how many buildings an empire can ever have.
 * REGION_CAP just forces buildings to spread across regions before hitting
 * that ceiling, so "south is full, build east instead" is a real, enforced
 * statement rather than a cosmetic tag. REGIONS is in a fixed compass order
 * (north round to northwest) — every region-list render and the auto-pick in
 * `.empire build` both rely on that order.
 */
export const REGIONS = REGIONS_CONFIG.list
export const regionMap = Object.fromEntries(REGIONS.map(r => [r.id, r]))
export const REGION_CAP = REGIONS_CONFIG.capPerRegion ?? 3

export const OFFLINE_CAP_MS = EMPIRE_CONFIG.offlineCapHours * 3600 * 1000
export const HOUR_MS = 3600 * 1000
export const DAY_MS = 24 * HOUR_MS

/** Hard ceiling on how much treasury the vault can shield, however many you stack. */
export const VAULT_PROTECT_CAP = 0.75

/** Material ids the empire warehouse and build-shop deal in, in display order. */
export const MATERIAL_IDS = ['wood', 'stone', 'iron', 'plank', 'brick', 'ingot', 'hardwood', 'granite', 'steel']

// ── Shape / backfill ───────────────────────────────────────────────────────

/**
 * Guarantees an empire record has every Phase 1 field in the right type.
 * Idempotent, so it is safe to run over an already-shaped record on every
 * read (mirrors ensureGuildProgress / ensureHome). Does NOT create a record
 * for a player who has no empire — that only happens at `.empire found`.
 */
export function ensureEmpireShape(record) {
  if (!record || typeof record !== 'object') return record
  if (typeof record.treasury !== 'number' || !Number.isFinite(record.treasury)) record.treasury = 0
  if (!record.warehouse || typeof record.warehouse !== 'object') record.warehouse = {}
  for (const id of MATERIAL_IDS) {
    if (typeof record.warehouse[id] !== 'number' || !Number.isFinite(record.warehouse[id])) record.warehouse[id] = 0
  }
  if (!Array.isArray(record.buildings)) record.buildings = []
  // region backfill: buildings from before regions existed (or with a bad/
  // stale id) get assigned to whichever region currently holds the fewest
  // buildings, so old empires spread out automatically the first time they're
  // touched — no manual migration script needed. counts are tracked locally
  // and updated as we go, so buildings backfilled in the same pass still
  // spread across each other rather than all landing on region #1.
  const regionCounts = Object.fromEntries(REGIONS.map(r => [r.id, 0]))
  for (const b of record.buildings) {
    if (regionMap[b.region]) regionCounts[b.region] = (regionCounts[b.region] ?? 0) + 1
  }
  for (const b of record.buildings) {
    if (typeof b.level !== 'number' || b.level < 1) b.level = 1
    if (typeof b.lastCollectedAt !== 'number') b.lastCollectedAt = record.foundedAt ?? null
    if (typeof b.damagedUntil !== 'number' || !Number.isFinite(b.damagedUntil)) b.damagedUntil = 0
    if (!regionMap[b.region]) {
      const pick = REGIONS.reduce((least, r) =>
        regionCounts[r.id] < regionCounts[least.id] ? r : least, REGIONS[0])
      b.region = pick.id
      regionCounts[pick.id] += 1
    }
  }
  if (typeof record.foundedAt !== 'number') record.foundedAt = null
  if (typeof record.lastActiveAt !== 'number') record.lastActiveAt = record.foundedAt ?? null
  // Population is the heart of Phase 5: fame is DERIVED headcount, never stored
  // on its own. citizenCount is the player members (owner + citizens), kept
  // authoritative by reconcileCitizenCount on init; npcs are auto-immigrating
  // residents that only move in when housing has room for them. lastPopAt is the
  // arrival clock, lastCivicAt the NPC income/wage clock, both stamped on collect.
  if (typeof record.citizenCount !== 'number' || !Number.isFinite(record.citizenCount)) record.citizenCount = 1
  record.citizenCount = Math.max(0, Math.floor(record.citizenCount))
  if (typeof record.npcs !== 'number' || !Number.isFinite(record.npcs)) record.npcs = 0
  record.npcs = Math.max(0, Math.floor(record.npcs))
  if (typeof record.lastPopAt !== 'number' || !Number.isFinite(record.lastPopAt)) record.lastPopAt = record.foundedAt ?? null
  if (typeof record.lastCivicAt !== 'number' || !Number.isFinite(record.lastCivicAt)) record.lastCivicAt = record.foundedAt ?? null
  // Premium shop: count of Warehouse Permits stacked (see warehouseBonusFromPermits).
  if (typeof record.premiumPermits !== 'number' || !Number.isFinite(record.premiumPermits)) record.premiumPermits = 0
  record.premiumPermits = Math.max(0, Math.floor(record.premiumPermits))
  // Fame follows headcount, always overwritten so a stale stored value can never
  // drift from the true population; tierId is derived from fame in turn.
  record.fame = populationOf(record)
  record.tierId = tierForFame(record.fame).id
  ensureArmy(record)
  ensureConflictShape(record)
  ensureWarShape(record)
  ensureFolkShape(record)
  return record
}

/**
 * Backfills the Phase 3 conflict + economy-funnel fields: the raid shield and
 * troop-deploy clocks, the cooldown stamp, the capped raid log, the owner's
 * storefront, and the character-assignment slots. Kept separate from
 * ensureEmpireShape only for readability; it runs on every read too, so an
 * empire founded in Phase 1 gets these fields the first time it is touched.
 * Idempotent. Never creates a record.
 */
export function ensureConflictShape(record) {
  if (!record || typeof record !== 'object') return record
  if (typeof record.shieldUntil !== 'number' || !Number.isFinite(record.shieldUntil)) record.shieldUntil = 0
  if (typeof record.deployedUntil !== 'number' || !Number.isFinite(record.deployedUntil)) record.deployedUntil = 0
  if (typeof record.lastRaidAt !== 'number' || !Number.isFinite(record.lastRaidAt)) record.lastRaidAt = 0
  if (!Array.isArray(record.raidLog)) record.raidLog = []
  // The stash: where NPC-mined raw materials and crafted goods accumulate,
  // separate from the build warehouse (which is capped construction stock).
  // Materials is an id->qty map; items is a list of stacks, each optionally
  // tagged with the NPC that made it. Deposits and the blacksmith both land
  // here. Sanitized every read so a bad write can never wedge a stash.
  if (!record.stash || typeof record.stash !== 'object') record.stash = {}
  if (!record.stash.materials || typeof record.stash.materials !== 'object') record.stash.materials = {}
  for (const id of Object.keys(record.stash.materials)) {
    const q = Math.floor(Number(record.stash.materials[id]))
    if (!Number.isFinite(q) || q <= 0) delete record.stash.materials[id]
    else record.stash.materials[id] = q
  }
  if (!Array.isArray(record.stash.items)) record.stash.items = []
  record.stash.items = record.stash.items.filter(it =>
    it && typeof it === 'object' && typeof it.id === 'string'
    && Number.isFinite(Number(it.qty)) && Number(it.qty) > 0)
  for (const it of record.stash.items) {
    it.qty = Math.max(1, Math.floor(Number(it.qty)))
    if (typeof it.name !== 'string') it.name = it.id
    if (typeof it.madeBy !== 'string') it.madeBy = it.madeBy ?? null
  }
  // The stash invite list: jids the ruler has granted drop/take rights via .tp,
  // so a trusted friend from outside the empire can use the stash like a shared
  // chest. Deduped non-empty strings; nothing else can wedge it.
  if (!Array.isArray(record.stash.invited)) record.stash.invited = []
  record.stash.invited = [...new Set(record.stash.invited.filter(j => typeof j === 'string' && j))]
  // The blacksmith: one named NPC smith per empire, minted on the first forge and
  // kept thereafter so every piece it makes carries the same maker's name, plus a
  // capped newest-first log of what it has forged. Sanitized every read.
  if (!record.blacksmith || typeof record.blacksmith !== 'object') record.blacksmith = {}
  if (typeof record.blacksmith.smithName !== 'string') record.blacksmith.smithName = record.blacksmith.smithName ?? null
  if (!Array.isArray(record.blacksmith.forgeLog)) record.blacksmith.forgeLog = []
  const forgeLogCap = Math.max(1, Math.floor(Number(BLACKSMITH_CONFIG?.forgeLogCap) || 8))
  record.blacksmith.forgeLog = record.blacksmith.forgeLog
    .filter(e => e && typeof e === 'object' && typeof e.item === 'string')
    .slice(0, forgeLogCap)
  // The empire bank: player deposits held in the realm's coffers, keyed by jid.
  // Each account is { balance, lastTaxAt }; AstralPay levies a daily maintenance
  // tax on the balance that is swept into the treasury (see accrueBankAccount).
  // taxCollected is a lifetime tally for flavor. An emptied account is dropped so
  // the ledger never accumulates dead zero-balance entries. Sanitized every read
  // so a bad write can never wedge an account or mint a negative balance.
  if (!record.bank || typeof record.bank !== 'object') record.bank = {}
  if (!record.bank.accounts || typeof record.bank.accounts !== 'object') record.bank.accounts = {}
  for (const jid of Object.keys(record.bank.accounts)) {
    const acct = record.bank.accounts[jid]
    if (!acct || typeof acct !== 'object') { delete record.bank.accounts[jid]; continue }
    acct.balance = Math.max(0, Math.floor(Number(acct.balance) || 0))
    if (typeof acct.lastTaxAt !== 'number' || !Number.isFinite(acct.lastTaxAt)) acct.lastTaxAt = acct.lastTaxAt ?? null
    if (acct.balance <= 0) delete record.bank.accounts[jid]
  }
  if (typeof record.bank.taxCollected !== 'number' || !Number.isFinite(record.bank.taxCollected)) record.bank.taxCollected = 0
  record.bank.taxCollected = Math.max(0, Math.floor(record.bank.taxCollected))
  if (!record.market || typeof record.market !== 'object') record.market = {}
  if (!Array.isArray(record.market.stock)) record.market.stock = []
  // A malformed listing would let a buyer pay for nothing, so drop anything
  // that isn't a positive-integer price and quantity on a real item id.
  record.market.stock = record.market.stock.filter(s =>
    s && typeof s === 'object' && typeof s.itemId === 'string'
    && Number.isFinite(Number(s.price)) && Number(s.price) > 0
    && Number.isFinite(Number(s.qty)) && Number(s.qty) > 0)
  for (const s of record.market.stock) {
    s.price = Math.max(1, Math.floor(Number(s.price)))
    s.qty = Math.max(1, Math.floor(Number(s.qty)))
  }
  if (typeof record.market.revenue !== 'number' || !Number.isFinite(record.market.revenue)) record.market.revenue = 0
  if (!record.assignments || typeof record.assignments !== 'object') record.assignments = {}
  if (!Array.isArray(record.assignments.workers)) record.assignments.workers = []
  if (!Array.isArray(record.assignments.generals)) record.assignments.generals = []
  // Star ratings are denormalized onto the assignment at assign time so the
  // production and army math stays a pure function of the record alone (no
  // character-data import in this module, and so no import cycle). Character
  // defs never change stars at runtime, so the copy cannot drift.
  record.assignments.workers = record.assignments.workers.filter(a =>
    a && typeof a === 'object' && typeof a.charId === 'string' && typeof a.buildingType === 'string')
  record.assignments.generals = record.assignments.generals.filter(a =>
    a && typeof a === 'object' && typeof a.charId === 'string')
  for (const a of [...record.assignments.workers, ...record.assignments.generals]) {
    a.stars = Math.min(6, Math.max(1, Math.floor(Number(a.stars) || 1)))
    if (typeof a.ownerJid !== 'string') a.ownerJid = a.ownerJid ?? null
    if (typeof a.at !== 'number') a.at = a.at ?? null
  }
  // The siege: the timed form of a raid, stored ONLY on the ATTACKER. The
  // defender discovers it via a scan (siegeAgainst in empire-repo, like
  // pendingAgainst for wars), so there is no second mirror to drift. Present
  // only while status is 'active'; anything malformed drops back to null so a
  // half-written siege can never wedge an empire. The repo advances it tick by
  // tick, settle-on-read, and clears it to null on conclusion.
  const sg = record.siege
  if (sg && typeof sg === 'object' && sg.status === 'active' && typeof sg.targetId === 'string') {
    sg.targetName = typeof sg.targetName === 'string' && sg.targetName.trim() ? sg.targetName : 'an empire'
    for (const k of ['startedAt', 'endsAt', 'nextTickAt', 'tickMs']) {
      sg[k] = Math.max(0, Math.floor(Number(sg[k]) || 0))
    }
    sg.ticksTotal = Math.max(1, Math.floor(Number(sg.ticksTotal) || 1))
    sg.ticksDone = Math.min(sg.ticksTotal, Math.max(0, Math.floor(Number(sg.ticksDone) || 0)))
    sg.attackerTickWins = Math.max(0, Math.floor(Number(sg.attackerTickWins) || 0))
    sg.defenderTickWins = Math.max(0, Math.floor(Number(sg.defenderTickWins) || 0))
    sg.loot = Math.max(0, Math.floor(Number(sg.loot) || 0))
    sg.lootPerTick = Math.max(0, Math.floor(Number(sg.lootPerTick) || 0))
    if (!sg.attackerLosses || typeof sg.attackerLosses !== 'object') sg.attackerLosses = {}
    if (!sg.defenderLosses || typeof sg.defenderLosses !== 'object') sg.defenderLosses = {}
    for (const side of [sg.attackerLosses, sg.defenderLosses]) {
      side.recruit = Math.max(0, Math.floor(Number(side.recruit) || 0))
      side.soldier = Math.max(0, Math.floor(Number(side.soldier) || 0))
    }
    if (!Array.isArray(sg.log)) sg.log = []
    const siegeLogCap = Math.max(1, Math.floor(Number(RAID_CONFIG?.siegeLogCap) || 10))
    sg.log = sg.log.filter(e => e && typeof e === 'object').slice(0, siegeLogCap)
  } else {
    record.siege = null
  }
  return record
}

/**
 * Backfills the Phase 4 conflict-endgame fields: the active-war mirror, the
 * vassalage status, the sell listing, the dormancy flag, and the war log.
 *
 * A war is stored as a small mirror on BOTH empires (record.war), never as its
 * own container: every war transition goes through a two-party write that
 * updates both mirrors in the same pass, so they cannot drift (the duel
 * pattern). The mirror is present only while a war is 'declared' or 'active';
 * anything malformed is dropped back to null so a half-written war can never
 * wedge an empire. Vassalage is a status flag with a timer, cleared lazily
 * wherever `now` is in hand (see expireVassalage). Idempotent; never creates a
 * record; runs on every read via ensureEmpireShape.
 */
export function ensureWarShape(record) {
  if (!record || typeof record !== 'object') return record
  const w = record.war
  if (w && typeof w === 'object' && typeof w.opponentId === 'string'
      && (w.status === 'declared' || w.status === 'active')) {
    w.opponentName = typeof w.opponentName === 'string' && w.opponentName.trim() ? w.opponentName : 'a rival'
    w.role = (w.role === 'aggressor' || w.role === 'defender') ? w.role : 'aggressor'
    w.myWins = Math.max(0, Math.floor(Number(w.myWins) || 0))
    w.theirWins = Math.max(0, Math.floor(Number(w.theirWins) || 0))
    w.roundsFought = Math.max(0, Math.floor(Number(w.roundsFought) || 0))
    for (const k of ['declaredAt', 'acceptWindowUntil', 'startedAt', 'lastAttackAt', 'endsAt', 'nextRoundAt', 'durationMs']) {
      if (typeof w[k] !== 'number' || !Number.isFinite(w[k])) w[k] = w[k] ?? null
    }
    // Cumulative levy casualties on each side across every round fought so far,
    // so .war status can show the war's blood cost without replaying it.
    // myLosses is THIS empire's dead; theirLosses is the opponent's. Written to
    // both mirrors in the same atomic pair as the round result.
    if (!w.myLosses || typeof w.myLosses !== 'object') w.myLosses = {}
    if (!w.theirLosses || typeof w.theirLosses !== 'object') w.theirLosses = {}
    for (const side of [w.myLosses, w.theirLosses]) {
      side.recruit = Math.max(0, Math.floor(Number(side.recruit) || 0))
      side.soldier = Math.max(0, Math.floor(Number(side.soldier) || 0))
    }
  } else {
    record.war = null
  }
  if (typeof record.lastWarAt !== 'number' || !Number.isFinite(record.lastWarAt)) record.lastWarAt = 0
  // Vassalage: subjugation to another empire until vassalUntil. Cleared lazily.
  if (typeof record.vassalOf !== 'string') record.vassalOf = record.vassalOf ?? null
  if (record.vassalOf === undefined) record.vassalOf = null
  if (typeof record.vassalOfName !== 'string') record.vassalOfName = record.vassalOfName ?? null
  if (typeof record.vassalUntil !== 'number' || !Number.isFinite(record.vassalUntil)) record.vassalUntil = 0
  // Sell listing: an owner-set asking price, or null. A malformed one is dropped
  // so a buyer can never pay for a listing that is not really a positive price.
  const sl = record.sellListing
  if (sl && typeof sl === 'object' && Number.isFinite(Number(sl.price)) && Number(sl.price) > 0) {
    sl.price = Math.max(1, Math.floor(Number(sl.price)))
    if (typeof sl.at !== 'number') sl.at = sl.at ?? null
  } else {
    record.sellListing = null
  }
  // Dormancy: set by the lifecycle sweep, cleared the moment the owner acts.
  if (typeof record.dormant !== 'boolean') record.dormant = false
  if (!Array.isArray(record.warLog)) record.warLog = []
  return record
}

/**
 * Clears an expired vassalage in place and returns true if it freed the empire.
 * Kept out of the shape backfill because expiry needs `now`, which the ensure*
 * functions deliberately do not take. Call it wherever a war/sell gate runs.
 */
export function expireVassalage(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return false
  if (record.vassalOf && (record.vassalUntil ?? 0) <= now) {
    record.vassalOf = null
    record.vassalOfName = null
    record.vassalUntil = 0
    return true
  }
  return false
}

/** True if the record is a vassal of another empire right now. */
export function isVassal(record, now = Date.now()) {
  return !!(record?.vassalOf && (record?.vassalUntil ?? 0) > now)
}

/**
 * Backfills the three empire fields on a player. Mirrors ensureHome: accounts
 * that predate the feature get null fields (no empire) rather than a free one.
 * Safe to call inside an updatePlayer mutator.
 */
export function ensureEmpirePlayer(player) {
  if (!player || typeof player !== 'object') return player
  if (typeof player.empireId !== 'string') player.empireId = player.empireId ?? null
  if (player.empireId === undefined) player.empireId = null
  if (player.empireRole !== 'owner' && player.empireRole !== 'citizen') player.empireRole = player.empireRole ?? null
  if (player.empireRole === undefined) player.empireRole = null
  if (typeof player.empireJoinedAt !== 'number') player.empireJoinedAt = player.empireJoinedAt ?? null
  if (player.empireJoinedAt === undefined) player.empireJoinedAt = null
  // Where the player is standing for shopping purposes. Deliberately NOT
  // player.location: a visitor stays in town as far as every existing map and
  // location reader is concerned, so nothing outside the empire pillar has to
  // learn about empire ids.
  if (typeof player.visitingEmpire !== 'string') player.visitingEmpire = player.visitingEmpire ?? null
  if (player.visitingEmpire === undefined) player.visitingEmpire = null
  if (typeof player.visitingSince !== 'number') player.visitingSince = player.visitingSince ?? null
  if (player.visitingSince === undefined) player.visitingSince = null
  return player
}

// ── Tiers ────────────────────────────────────────────────────────────────

/** The tier an empire sits in for a given fame total. */
export function tierForFame(fame) {
  const f = Math.max(0, Number(fame) || 0)
  let current = TIER_ORDER[0]
  for (const tier of TIER_ORDER) if (f >= tier.fame) current = tier
  return current
}

export function tierOf(record) {
  return tierForFame(record?.fame ?? 0)
}

/** The next tier up, or null at the top of the ladder. */
export function nextTier(tierId) {
  const cur = tierMap[tierId]
  if (!cur) return TIER_ORDER[0] ?? null
  return TIER_ORDER.find(t => t.rank === cur.rank + 1) ?? null
}

/** Fame still needed to reach the next tier, or 0 at the top. */
export function fameToNextTier(record) {
  const tier = tierOf(record)
  const next = nextTier(tier.id)
  if (!next) return 0
  return Math.max(0, next.fame - (record?.fame ?? 0))
}

// ── Buildings ──────────────────────────────────────────────────────────────

export function buildingCount(record) {
  return record?.buildings?.length ?? 0
}

export function buildingSlotsLeft(record) {
  const cap = tierOf(record).buildingCap ?? 0
  return Math.max(0, cap - buildingCount(record))
}

export function findBuilding(record, type) {
  return record?.buildings?.find(b => b.type === type) ?? null
}

/** Every building currently sitting in one region (ensureEmpireShape guarantees region is always set). */
export function buildingsInRegion(record, regionId) {
  return (record?.buildings ?? []).filter(b => b.region === regionId)
}

/** How many more buildings a region can hold before REGION_CAP, floored at 0. */
export function regionSlotsLeft(record, regionId) {
  return Math.max(0, REGION_CAP - buildingsInRegion(record, regionId).length)
}

/** { regionId: count } for every region, always all 8 keys present even at 0. */
export function regionCountsOf(record) {
  const counts = Object.fromEntries(REGIONS.map(r => [r.id, 0]))
  for (const b of record?.buildings ?? []) {
    if (counts[b.region] !== undefined) counts[b.region] += 1
  }
  return counts
}

/** First region (in compass order) with room left, or null if every region is at REGION_CAP. */
export function firstOpenRegion(record) {
  return REGIONS.find(r => regionSlotsLeft(record, r.id) > 0) ?? null
}

/** Building types this empire's tier unlocks (buildable or upgradeable). */
export function unlockedBuildingDefs(record) {
  const rank = tierOf(record).rank
  return BUILDING_DEFS.filter(d => d.minRank <= rank)
}

/**
 * Solars + materials to take a building from (targetLevel - 1) to targetLevel.
 * Cost scales linearly with the target level, so each level costs more than
 * the last and a level-N building has cost base*(1+2+...+N) sunk into it.
 */
export function buildingCostFor(def, targetLevel) {
  const lvl = Math.max(1, targetLevel)
  const materials = {}
  for (const [id, qty] of Object.entries(def.baseCostMaterials ?? {})) {
    materials[id] = Math.ceil(qty * lvl)
  }
  return { solars: Math.ceil((def.baseCostSolars ?? 0) * lvl), materials }
}

/** Per-hour yield of one building at its current level. */
export function buildingYieldPerHour(def, level) {
  return Math.floor((def.baseYieldPerHour ?? 0) * Math.max(1, level))
}

/** Per-hour maintenance drawn from the treasury for one building. */
export function buildingMaintPerHour(def, level) {
  return Math.floor((def.maintPerHour ?? 0) * Math.max(1, level))
}

// ── Warehouse ────────────────────────────────────────────────────────────

/** Total material capacity: tier base plus every warehouse building's bonus. */
export function warehouseCap(record) {
  let cap = tierOf(record).warehouseBase ?? 0
  for (const b of record?.buildings ?? []) {
    const def = buildingDefMap[b.type]
    if (def?.storageBonus) cap += def.storageBonus * b.level
  }
  // Premium Warehouse Permits (lib bought with gems, see premiumShopItems
  // above): a flat, stacking bonus on top of tier + building storage. Zero
  // permits owned adds zero, so this is a no-op for every empire that never
  // touches the premium shop.
  cap += warehouseBonusFromPermits(record)
  return cap
}

/** Sum of every material currently stockpiled. */
export function warehouseUsed(record) {
  return Object.values(record?.warehouse ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0)
}

export function warehouseRoom(record) {
  return Math.max(0, warehouseCap(record) - warehouseUsed(record))
}

// ── Affordability ──────────────────────────────────────────────────────────

/**
 * Checks a { solars, materials } cost against an empire's treasury and
 * warehouse. Returns { ok, missingSolars, missingMaterials: {id: qty} } so a
 * caller can print exactly what is short in one message.
 */
export function canAfford(record, cost) {
  const missingMaterials = {}
  const have = record?.treasury ?? 0
  const missingSolars = Math.max(0, (cost.solars ?? 0) - have)
  for (const [id, qty] of Object.entries(cost.materials ?? {})) {
    const stock = record?.warehouse?.[id] ?? 0
    if (stock < qty) missingMaterials[id] = qty - stock
  }
  return {
    ok: missingSolars === 0 && Object.keys(missingMaterials).length === 0,
    missingSolars,
    missingMaterials,
  }
}

/** Applies a { solars, materials } cost to a record in place. Assumes canAfford passed. */
export function payCost(record, cost) {
  record.treasury -= (cost.solars ?? 0)
  for (const [id, qty] of Object.entries(cost.materials ?? {})) {
    record.warehouse[id] = (record.warehouse[id] ?? 0) - qty
  }
}

// ── Assignments (pure record reads, no character data) ───────────────────────

/**
 * How many citizens an empire may hold at its current tier. The owner does not
 * count against it: a Hamlet with citizenCap 2 is the ruler plus two.
 */
export function citizenCap(record) {
  return tierOf(record).citizenCap ?? 0
}

/** The worker assignment sitting on one building type, or null. */
export function workerOnBuilding(record, buildingType) {
  return (record?.assignments?.workers ?? []).find(a => a.buildingType === buildingType) ?? null
}

/**
 * The production multiplier a building earns from its assigned worker: 1 with
 * nobody on it, more with a higher-starred character. Only the yield is scaled;
 * maintenance is untouched, so a worker always widens the margin.
 */
export function workerMultFor(record, buildingType) {
  const a = workerOnBuilding(record, buildingType)
  if (!a) return 1
  const per = ASSIGN_CONFIG?.workerPctPerStar ?? 0
  return 1 + Math.max(0, per * (a.stars ?? 1))
}

/**
 * The additive army-power bonus from assigned generals, summed. Fed to
 * armyPower / buildSnapshot, so it moves fighting POWER only and never MIGHT
 * (empireScore), keeping weight matching honest.
 */
export function generalBonusOf(record) {
  const per = ASSIGN_CONFIG?.generalPctPerStar ?? 0
  return (record?.assignments?.generals ?? [])
    .reduce((sum, a) => sum + Math.max(0, per * (a.stars ?? 1)), 0)
}

// ── Special buildings (Phase 6: siege defense, war power, vault, prestige) ────

/**
 * Sums a per-level numeric field across every building def, times each
 * building's level. The generic accumulator behind the "special" buildings:
 * each such stat lives as a flat per-level number on exactly ONE building def
 * (watchtower siegeDefensePct, war_college warPowerPct, treasury_vault
 * vaultProtectPct, monument prestige), so summing def[field] * level over the
 * whole build order is precisely its contribution, and any building lacking the
 * field simply adds nothing. Mirrors popCap / warehouseCap / armyCap exactly.
 */
export function sumBuildingPct(record, field) {
  let total = 0
  for (const b of record?.buildings ?? []) {
    const def = buildingDefMap[b.type]
    const v = Number(def?.[field])
    if (Number.isFinite(v) && v) total += v * (b.level ?? 0)
  }
  return total
}

/** Watchtower bonus to fighting POWER, added ONLY when defending an assault. */
export function siegeDefenseBonus(record) {
  return Math.max(0, sumBuildingPct(record, 'siegeDefensePct'))
}

/** War College bonus to fighting POWER, in every siege and war, attack or defense. */
export function warCollegeBonus(record) {
  return Math.max(0, sumBuildingPct(record, 'warPowerPct'))
}

/**
 * The total additive POWER bonus an empire brings to a conflict tick or round:
 * assigned generals plus the war college, plus the watchtower walls when it is
 * DEFENDING. Fed to armyPower / buildSnapshot exactly like generalBonusOf, so it
 * moves fighting POWER only and never MIGHT (empireScore): weight matching stays
 * honest and you cannot dodge it by razing your own towers.
 */
export function conflictPowerBonus(record, { defending = false } = {}) {
  let bonus = generalBonusOf(record) + warCollegeBonus(record)
  if (defending) bonus += siegeDefenseBonus(record)
  return Math.max(0, bonus)
}

/** Fraction of the treasury the vault shields from loot and tribute, hard-capped. */
export function vaultProtectPct(record) {
  return Math.min(VAULT_PROTECT_CAP, Math.max(0, sumBuildingPct(record, 'vaultProtectPct')))
}

/** Coin the vault keeps beyond a raider's reach: never looted, never tributed. */
export function protectedTreasury(record) {
  const t = Math.max(0, Math.floor(record?.treasury ?? 0))
  return Math.floor(t * vaultProtectPct(record))
}

/** Coin actually exposed to loot and tribute: treasury minus what the vault shields. */
export function lootableTreasury(record) {
  const t = Math.max(0, Math.floor(record?.treasury ?? 0))
  return Math.max(0, t - protectedTreasury(record))
}

/** Monument standing folded into MIGHT (empireScore): a stable prestige bump. */
export function prestigeBonus(record) {
  return Math.max(0, sumBuildingPct(record, 'prestige'))
}

// ── Population (fame = headcount, capacity-gated) ─────────────────────────────

/**
 * Total residents: the player members (owner + citizens, kept in citizenCount)
 * plus the NPCs that have immigrated. This IS the empire's fame, derived on
 * every read from ensureEmpireShape, never stored on its own.
 */
export function populationOf(record) {
  return Math.max(0, Math.floor(record?.citizenCount ?? 0)) + Math.max(0, Math.floor(record?.npcs ?? 0))
}

/**
 * How many residents the empire can house: a small base plus every building's
 * housing contribution (housing per level, times its level). Housing is what
 * gates NPC immigration, so raising more space is the only way to grow the
 * population, and thus the fame, and thus the tier that unlocks more building
 * slots. That self-reinforcing loop is the whole point of Phase 5.
 */
export function popCap(record) {
  let cap = POP_CONFIG?.baseCap ?? 0
  for (const b of record?.buildings ?? []) {
    const def = buildingDefMap[b.type]
    if (def?.housing) cap += def.housing * b.level
  }
  return cap
}

/** Housing room left for new residents, floored at zero. */
export function popRoom(record) {
  return Math.max(0, popCap(record) - populationOf(record))
}

/**
 * Computes population growth and the NPC civic economy for a collect window,
 * WITHOUT mutating the record. Two clocks, both clamped to the offline cap:
 *
 *  - Arrivals: one NPC moves in per hoursPerArrival of elapsed time on lastPopAt,
 *    but never more than the housing room left. The clock advances only by the
 *    intervals actually consumed, so a room-blocked arrival waits for space
 *    rather than burning its timer, and partial progress toward the next arrival
 *    is preserved (bounded by the 24h clamp).
 *  - Civic: the PRE-growth NPCs pay a per-head tax and draw a per-head wage over
 *    the time on lastCivicAt (this window's fresh arrivals have not lived here
 *    yet, so they neither earn nor cost this pass).
 *
 * Returns plain numbers so applyCollect and the info preview share one path.
 */
export function previewPopulation(record, now = Date.now()) {
  const cfg = POP_CONFIG ?? {}
  const npcs = Math.max(0, Math.floor(record?.npcs ?? 0))

  const perMs = Math.max(1, Number(cfg.hoursPerArrival) || 2) * HOUR_MS
  const lastPop = typeof record?.lastPopAt === 'number' ? record.lastPopAt : now
  const elapsedPop = now > lastPop ? Math.min(now - lastPop, OFFLINE_CAP_MS) : 0
  const timeArrivals = Math.floor(elapsedPop / perMs)
  const room = popRoom(record)
  const arrivals = Math.max(0, Math.min(timeArrivals, room))
  const nextPopAt = arrivals > 0 ? lastPop + arrivals * perMs : lastPop
  const npcsAfter = npcs + arrivals

  const lastCivic = typeof record?.lastCivicAt === 'number' ? record.lastCivicAt : now
  const civicMs = now > lastCivic ? Math.min(now - lastCivic, OFFLINE_CAP_MS) : 0
  const civicHours = civicMs / HOUR_MS
  const civicIncome = Math.floor(npcs * (Number(cfg.npcIncomePerHour) || 0) * civicHours)
  const civicWage = Math.floor(npcs * (Number(cfg.npcWagePerHour) || 0) * civicHours)

  return { npcs, arrivals, npcsAfter, nextPopAt, room, civicIncome, civicWage, civicHours }
}

// ── Production, upkeep, collect (claim-based) ────────────────────────────────

/**
 * Computes what a collect right now would yield, WITHOUT mutating the record.
 * Every building's elapsed time is measured from its own lastCollectedAt and
 * clamped to the offline cap. Solars go to the treasury; materials go to the
 * warehouse, clamped to remaining room (the surplus is reported as `waste`).
 * Maintenance is drawn from the treasury over the same clamped window, so you
 * can never dodge upkeep by never collecting.
 *
 * Returns the whole summary as plain numbers so the plugin can both preview it
 * (.empire info) and apply it (.empire collect) from one code path.
 */
export function previewCollect(record, now = Date.now()) {
  let solarsGain = 0
  let maintenance = 0
  const matGain = {}
  const gathered = {}
  const perBuilding = []

  for (const b of record?.buildings ?? []) {
    const def = buildingDefMap[b.type]
    if (!def) continue
    const last = typeof b.lastCollectedAt === 'number' ? b.lastCollectedAt : now
    const damagedUntil = typeof b.damagedUntil === 'number' ? b.damagedUntil : 0
    const damaged = damagedUntil > now
    // A damaged building is offline: it neither yields nor draws maintenance
    // until damagedUntil passes, and the downtime itself never counts as
    // production (its clock effectively resumes when it comes back online).
    const online = Math.max(last, damagedUntil)
    const cappedMs = now > online ? Math.min(now - online, OFFLINE_CAP_MS) : 0
    const hours = cappedMs / HOUR_MS
    // An assigned character worker scales the yield only, never the upkeep.
    const boost = workerMultFor(record, b.type)
    const yielded = Math.floor(buildingYieldPerHour(def, b.level) * boost * hours)
    const maint = Math.floor(buildingMaintPerHour(def, b.level) * hours)
    maintenance += maint
    if (def.produces === 'solars') {
      solarsGain += yielded
    } else if (def.produces) {
      matGain[def.produces] = (matGain[def.produces] ?? 0) + yielded
    }
    // Some buildings also send workers out to gather a CRAFTING material into the
    // stash (separate from the construction material they warehouse). It scales
    // with level and the same worker boost, over the same clamped window, and is
    // reported per-building so the collect summary can call it out.
    let gatheredId = null
    let gatheredQty = 0
    if (def.gathers && def.gathers.material) {
      const perHr = Math.max(0, Math.floor(Number(def.gathers.perHour) || 0)) * Math.max(1, b.level)
      gatheredQty = Math.floor(perHr * boost * hours)
      if (gatheredQty > 0) {
        gatheredId = def.gathers.material
        gathered[gatheredId] = (gathered[gatheredId] ?? 0) + gatheredQty
      }
    }
    perBuilding.push({ type: b.type, level: b.level, produces: def.produces, yielded, maint, cappedMs, damaged, boost, gatheredId, gatheredQty })
  }

  // Materials share one warehouse cap. Fill in MATERIAL_IDS order and report
  // whatever spilled over as waste so the player knows to build a warehouse.
  let room = warehouseRoom(record)
  const matStored = {}
  const waste = {}
  for (const id of MATERIAL_IDS) {
    const g = matGain[id] ?? 0
    if (g <= 0) continue
    const stored = Math.min(g, room)
    matStored[id] = stored
    room -= stored
    if (g > stored) waste[id] = g - stored
  }

  const treasuryBefore = record?.treasury ?? 0
  // Population: NPC tax is income, NPC wages are upkeep. Fold both into this
  // window before army payroll, so residents draw from the same treasury as
  // buildings and troops. previewPopulation also tells us who moves in.
  const pop = previewPopulation(record, now)
  maintenance += pop.civicWage
  const inflow = solarsGain + pop.civicIncome
  const maintPaid = Math.min(maintenance, treasuryBefore + inflow)
  const afterMaint = Math.max(0, treasuryBefore + inflow - maintenance)

  // Payroll is charged over the same clamped window as production, drawn from
  // whatever the treasury holds after maintenance. A shortfall triggers
  // desertion (see previewPayroll): you cannot dodge wages by never collecting.
  const payroll = previewPayroll(record, now, afterMaint)
  const treasuryAfter = afterMaint - payroll.wagesPaid
  const netSolars = inflow - maintPaid - payroll.wagesPaid

  // Bank maintenance tax is reported (and gates hasSomething) but is NOT folded
  // into treasuryAfter here: the real sweep happens in applyCollect via
  // accrueBankAll, which moves it account-by-account. Folding it in twice would
  // double-count, and leaving it out of preview would let a bank-tax-only
  // collect short-circuit before the sweep ever runs.
  const bankTax = previewBankTax(record, now)

  return {
    solarsGain, maintenance, maintPaid, netSolars,
    treasuryBefore, treasuryAfter,
    matStored, waste, perBuilding,
    gathered,
    bankTax,
    payroll,
    civicIncome: pop.civicIncome, civicWage: pop.civicWage,
    arrivals: pop.arrivals, npcsAfter: pop.npcsAfter, nextPopAt: pop.nextPopAt,
    hasSomething: solarsGain > 0 || maintenance > 0 || Object.keys(matStored).length > 0
      || Object.keys(gathered).length > 0
      || payroll.hasPayroll || pop.civicIncome > 0 || pop.arrivals > 0 || bankTax > 0,
  }
}

/**
 * Applies a collect to the record in place and returns the same summary
 * previewCollect produced. Every building's lastCollectedAt is stamped to
 * `now`, treasury and warehouse are updated, treasury floored at 0.
 *
 * If maintenance outruns income the treasury floors at 0. Payroll is charged
 * next: any wage shortfall deserts rank and file first (recruits and soldiers,
 * proportionally), then the lowest officer, exactly as previewPayroll planned.
 * The payroll clock (army.lastPaidAt) is stamped to `now` alongside the
 * building timers, so wages and production always settle over the same window.
 */
export function applyCollect(record, now = Date.now()) {
  ensureArmy(record)
  const summary = previewCollect(record, now)
  record.treasury = summary.treasuryAfter
  // Sweep the bank maintenance tax account-by-account (the single tax-crediting
  // path: each account is debited and the treasury credited), then re-read the
  // treasury so the summary reflects the coin that just landed in the coffers.
  summary.bankTax = accrueBankAll(record, now)
  summary.treasuryAfter = record.treasury
  for (const [id, qty] of Object.entries(summary.matStored)) {
    record.warehouse[id] = (record.warehouse[id] ?? 0) + qty
  }
  // Gathered crafting materials go into the STASH, not the warehouse. The stash
  // is the empire's loot pile (uncapped by warehouse storage) and the sole
  // source the blacksmith forges from, so worker output lands where the smith
  // can reach it.
  if (summary.gathered && Object.keys(summary.gathered).length) {
    if (!record.stash || typeof record.stash !== 'object') record.stash = {}
    if (!record.stash.materials || typeof record.stash.materials !== 'object') record.stash.materials = {}
    for (const [id, qty] of Object.entries(summary.gathered)) {
      if (qty > 0) record.stash.materials[id] = (record.stash.materials[id] ?? 0) + qty
    }
  }
  for (const b of record.buildings ?? []) b.lastCollectedAt = now
  // Apply any desertion the payroll shortfall caused, then stamp the wage clock.
  const army = record.army
  const d = summary.payroll.deserters
  army.levies.recruit = Math.max(0, (army.levies.recruit ?? 0) - (d.recruit ?? 0))
  army.levies.soldier = Math.max(0, (army.levies.soldier ?? 0) - (d.soldier ?? 0))
  for (const name of summary.payroll.officersLost) {
    const idx = army.officers.findIndex(o => o.name === name)
    if (idx >= 0) army.officers.splice(idx, 1)
  }
  army.lastPaidAt = now
  // Population: move in the new arrivals, advance the arrival clock by the
  // intervals actually consumed (never past now, so banked progress survives),
  // stamp the civic clock to now, and refresh the derived fame + tier so a
  // returning ruler sees a headcount and rank that are already current.
  record.npcs = summary.npcsAfter
  record.lastPopAt = summary.nextPopAt
  record.lastCivicAt = now
  record.fame = populationOf(record)
  record.tierId = tierForFame(record.fame).id
  // Townsfolk run LAST, after npcs has been updated, so a resident who moved in
  // during this very collect can be named on the same pass. accrueFolk also
  // banks residence favor, which is why nothing else in the pillar needs a folk
  // clock: the collect the ruler already runs is the clock.
  const folkRun = accrueFolk(record, now)
  summary.newFolk = folkRun.newFolk
  summary.folkFavor = folkRun.favorGain
  summary.folkGiftsReady = record.folk.filter(f => !f.gifted && f.favor >= folkGiftFavor()).length
  record.lastActiveAt = now
  return summary
}

/**
 * Per-hour economy snapshot for `.empire upkeep`: gross solars, total
 * maintenance, and the net margin, plus a per-building breakdown. This is the
 * anti-runaway brake made legible: as the empire grows, maintenance grows with
 * it and the margin thins.
 */
export function computeUpkeep(record) {
  let grossSolarsPerHour = 0
  let maintPerHour = 0
  const perBuilding = []
  for (const b of record?.buildings ?? []) {
    const def = buildingDefMap[b.type]
    if (!def) continue
    const boost = workerMultFor(record, b.type)
    const y = Math.floor(buildingYieldPerHour(def, b.level) * boost)
    const m = buildingMaintPerHour(def, b.level)
    maintPerHour += m
    if (def.produces === 'solars') grossSolarsPerHour += y
    perBuilding.push({ type: b.type, level: b.level, produces: def.produces, yieldPerHour: y, maintPerHour: m, boost })
  }
  // NPC residents: their tax adds to gross income, their wages to upkeep. With
  // no residents (npcs=0) both terms are zero, so the building-only economy is
  // unchanged.
  const npcs = Math.max(0, Math.floor(record?.npcs ?? 0))
  grossSolarsPerHour += npcs * (POP_CONFIG?.npcIncomePerHour ?? 0)
  maintPerHour += npcs * (POP_CONFIG?.npcWagePerHour ?? 0)
  const wagePerHr = wagePerHour(record)
  return {
    grossSolarsPerHour, maintPerHour, wagePerHour: wagePerHr,
    netSolarsPerHour: grossSolarsPerHour - maintPerHour - wagePerHr,
    perBuilding,
  }
}

/**
 * A single rough power number for an empire, used by info and the
 * leaderboards. Folds treasury, buildings, fame and army power together.
 * Never reads player baseStats.
 */
export function empireScore(record) {
  const treasuryScore = Math.floor((record?.treasury ?? 0) / 5000)
  const buildScore = (record?.buildings ?? []).reduce((s, b) => s + b.level * 5, 0)
  // Fame is headcount now (small numbers), so it is weighted UP into MIGHT
  // rather than divided down. A big, well-peopled empire reads as mightier,
  // which keeps weight matching honest without letting a hermit hide.
  const fameScore = Math.max(0, Math.floor(record?.fame ?? 0)) * 3
  const armyScore = Math.floor(armyPower(record) / 8)
  // Monument prestige is a stable, built structure, so it belongs in MIGHT
  // (never in POWER): it makes a monument-crowned empire read as a weightier
  // target for its peers rather than a stronger fighter in a single battle.
  const prestige = Math.floor(prestigeBonus(record))
  return treasuryScore + buildScore + fameScore + armyScore + prestige
}

/**
 * Season-roll decay valve. Trims a fixed fraction of an empire's fame and
 * treasury so an abandoned or coasting giant slides gently back toward the pack
 * each season instead of towering over the map forever. Fame here is empire
 * prestige, NOT a player's locked stat, so trimming it is fully in-bounds.
 * Pure: mutates the passed record in place and returns the deltas for logging.
 * Called once per empire from inside endSeason's existing updateAllPlayers pass.
 */
export function applySeasonDecay(record, cfg = LIFECYCLE_CONFIG) {
  if (!record || typeof record !== 'object') return { fameLost: 0, treasuryLost: 0 }
  const famePct = Math.max(0, Number(cfg?.decayFamePct) || 0)
  const treasPct = Math.max(0, Number(cfg?.decayTreasuryPct) || 0)
  // Fame is derived headcount now, so the season valve trims the NPC population
  // (never the player citizens, and never a locked player stat); fame then
  // follows. The returned key stays `fameLost` so season logging is unchanged.
  const npcsBefore = Math.max(0, Math.floor(record.npcs ?? 0))
  const npcsLost = Math.floor(npcsBefore * famePct)
  const treasuryLost = Math.floor(Math.max(0, record.treasury ?? 0) * treasPct)
  record.npcs = Math.max(0, npcsBefore - npcsLost)
  record.treasury = Math.max(0, (record.treasury ?? 0) - treasuryLost)
  record.fame = populationOf(record)
  record.tierId = tierForFame(record.fame).id
  return { fameLost: npcsLost, treasuryLost }
}

/**
 * War-loss catastrophe: razes an empire back to its founding state IN PLACE.
 * The empire is NOT dissolved (the id, name, owner and sworn citizens all
 * survive) so the loser keeps their realm and their people, but every built
 * thing is gone: no buildings, no army, no stash, no market, treasury and
 * warehouse reset to a fresh founder's, tier back to Hamlet. This is what the
 * loser of a war suffers, once, resolved by the repo. Deliberately brutal, but
 * bounded: it never touches another player's property nor anything paid for
 * with gems or real money.
 *
 * PRESERVED on purpose:
 *   - id, name, ownerId, foundedAt          (the empire still exists)
 *   - citizenCount and the player members    (citizens stay sworn; recomputed on boot)
 *   - premiumPermits                          (gem / real-money goods are not war spoils)
 *   - bank.accounts                           (citizens' own deposited coin, not the realm's)
 *
 * A generous raze shield is stamped so the freshly gutted empire cannot be
 * farmed while it rebuilds. Runs ensureEmpireShape at the end to re-derive fame,
 * tier and every backfilled field from the reset state.
 */
export function razeEmpireToFounding(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return record
  // Preserve the citizens' own bank deposits (their property, not war spoils).
  const savedAccounts = (record.bank && typeof record.bank === 'object' && record.bank.accounts) || {}
  record.buildings = []
  record.treasury = Math.max(0, Math.floor(Number(EMPIRE_CONFIG.starterTreasury) || 0))
  record.warehouse = { ...(EMPIRE_CONFIG.starterWarehouse ?? {}) }
  record.npcs = 0
  record.lastPopAt = now
  record.lastCivicAt = now
  record.army = { levies: { recruit: 0, soldier: 0 }, officers: [], lastPaidAt: now }
  record.stash = { materials: {}, items: [], invited: [] }
  record.blacksmith = { smithName: null, forgeLog: [] }
  record.market = { stock: [], revenue: 0 }
  record.assignments = { workers: [], generals: [] }
  record.folk = []
  record.lastFolkAt = now
  record.bank = { accounts: savedAccounts, taxCollected: 0 }
  record.sellListing = null
  record.war = null
  record.siege = null
  record.vassalOf = null
  record.vassalOfName = null
  record.vassalUntil = 0
  record.deployedUntil = 0
  record.lastActiveAt = now
  record.dormant = false
  record.shieldUntil = Math.max(record.shieldUntil ?? 0, now + (WAR_CONFIG.razeShieldHours ?? 72) * HOUR_MS)
  return ensureEmpireShape(record)
}

// ── Blacksmith ───────────────────────────────────────────────────────────

/**
 * The empire's forge level, or 0 if no blacksmith has been built. Drives which
 * rarities the resident smith can take on (see maxForgeRank).
 */
export function blacksmithLevel(record) {
  return findBuilding(record, 'blacksmith')?.level ?? 0
}

/**
 * The highest rarity rank this forge level may produce, read straight from the
 * maxForgeRankByLevel ladder in data/empire.json (index level-1, clamped). A
 * level-0 forge (no blacksmith) can make nothing, so this returns 0.
 */
export function maxForgeRank(level) {
  const lvl = Math.max(0, Math.floor(Number(level) || 0))
  if (lvl <= 0) return 0
  const ladder = BLACKSMITH_CONFIG?.maxForgeRankByLevel ?? []
  if (!ladder.length) return 0
  const idx = Math.min(lvl - 1, ladder.length - 1)
  return Math.max(0, Math.floor(Number(ladder[idx]) || 0))
}

/**
 * Pure feasibility check for a forge order. The engine never imports game data,
 * so the caller passes the recipe (plain {materials:[{itemId,qty}], solarsCost})
 * and the output's rarity RANK as a primitive. Returns everything the plugin
 * needs to render a precise refusal: the blocking reason, the shortfall of each
 * missing stash material, the treasury shortfall, and the level/maxRank context.
 * Reasons in priority order: no_blacksmith, rank, materials, solars, or null (ok).
 */
export function forgeCheck(record, recipe, outputRank) {
  const level = blacksmithLevel(record)
  const maxRank = maxForgeRank(level)
  if (level <= 0) {
    return { ok: false, reason: 'no_blacksmith', missing: [], shortSolars: 0, level: 0, maxRank: 0 }
  }
  const rank = Math.max(0, Math.floor(Number(outputRank) || 0))
  if (rank > maxRank) {
    return { ok: false, reason: 'rank', missing: [], shortSolars: 0, level, maxRank }
  }
  const stashMats = (record?.stash && typeof record.stash.materials === 'object') ? record.stash.materials : {}
  const missing = []
  for (const m of recipe?.materials ?? []) {
    const need = Math.max(0, Math.floor(Number(m.qty) || 0))
    if (need <= 0) continue
    const have = Math.max(0, Math.floor(Number(stashMats[m.itemId]) || 0))
    if (have < need) missing.push({ itemId: m.itemId, need, have })
  }
  const cost = Math.max(0, Math.floor(Number(recipe?.solarsCost) || 0))
  const shortSolars = Math.max(0, cost - Math.max(0, Math.floor(Number(record?.treasury) || 0)))
  const reason = missing.length ? 'materials' : (shortSolars > 0 ? 'solars' : null)
  return { ok: reason === null, reason, missing, shortSolars, level, maxRank }
}

/**
 * Applies a forge in place: consumes the recipe's materials from the stash and
 * its solars cost from the treasury, then stacks the finished piece onto the
 * stash's item pile tagged with the smith who made it. Provenance (madeBy) lives
 * only here on the empire stash: the game has no per-instance item state, so a
 * `.stash take` later deposits the item's bare id into a bag and the maker's
 * name stays behind as a stash-side record plus a line in the forge log.
 * Assumes forgeCheck already passed; still floors everything defensively.
 * Returns the finished-stack entry for the caller to render.
 */
export function applyForge(record, recipe, outputItem, smithName, now = Date.now()) {
  if (!record.stash || typeof record.stash !== 'object') record.stash = {}
  if (!record.stash.materials || typeof record.stash.materials !== 'object') record.stash.materials = {}
  if (!Array.isArray(record.stash.items)) record.stash.items = []
  // Consume materials from the stash, clearing any stack that hits zero.
  for (const m of recipe?.materials ?? []) {
    const need = Math.max(0, Math.floor(Number(m.qty) || 0))
    if (need <= 0) continue
    const have = Math.max(0, Math.floor(Number(record.stash.materials[m.itemId]) || 0))
    const left = Math.max(0, have - need)
    if (left > 0) record.stash.materials[m.itemId] = left
    else delete record.stash.materials[m.itemId]
  }
  // Pay the forge fee from the treasury.
  const cost = Math.max(0, Math.floor(Number(recipe?.solarsCost) || 0))
  record.treasury = Math.max(0, Math.floor(Number(record.treasury) || 0) - cost)
  // Stack onto an identical finished piece by the same smith, else start a stack.
  const maker = (typeof smithName === 'string' && smithName.trim()) ? smithName.trim() : null
  const outId = outputItem?.id
  const outName = outputItem?.name ?? outId
  let entry = record.stash.items.find(it => it && it.id === outId && (it.madeBy ?? null) === maker)
  if (entry) {
    entry.qty = Math.max(1, Math.floor(Number(entry.qty) || 0)) + 1
  } else {
    entry = { id: outId, name: outName, qty: 1, madeBy: maker }
    record.stash.items.push(entry)
  }
  // Newest-first forge log, capped. ensureConflictShape re-trims on every read.
  if (!record.blacksmith || typeof record.blacksmith !== 'object') record.blacksmith = {}
  if (!Array.isArray(record.blacksmith.forgeLog)) record.blacksmith.forgeLog = []
  const cap = Math.max(1, Math.floor(Number(BLACKSMITH_CONFIG?.forgeLogCap) || 8))
  record.blacksmith.forgeLog.unshift({ item: outName, by: maker, at: now })
  record.blacksmith.forgeLog = record.blacksmith.forgeLog.slice(0, cap)
  return entry
}

// ── Empire bank (player deposits, AstralPay maintenance tax) ────────────────

/** True if the empire has a Bank building (deposits are only possible then). */
export function bankBuilt(record) {
  return !!findBuilding(record, 'bank')
}

/** The daily maintenance-tax rate on banked balances (fraction, e.g. 0.01 = 1%/day). */
export function bankTaxRatePerDay() {
  return Math.max(0, Number(BANK_CONFIG?.taxRatePerDay) || 0)
}

/**
 * One account's accrued maintenance tax over the elapsed window, clamped to the
 * offline cap so a long absence never wipes a balance out (at most one cap's
 * worth of tax is owed at a time). Never exceeds the balance. Pure, no mutation.
 */
function accountTaxDue(acct, now) {
  const bal = Math.max(0, Math.floor(Number(acct?.balance) || 0))
  if (bal <= 0) return 0
  const last = typeof acct?.lastTaxAt === 'number' ? acct.lastTaxAt : now
  const ms = now > last ? Math.min(now - last, OFFLINE_CAP_MS) : 0
  const days = ms / DAY_MS
  return Math.min(bal, Math.floor(bal * bankTaxRatePerDay() * days))
}

/** The account record for a jid, or null. Read-only (does not create one). */
export function bankAccountOf(record, jid) {
  const acct = record?.bank?.accounts?.[jid]
  return acct && typeof acct === 'object' ? acct : null
}

/** A jid's live bank position without mutating: { balance, pendingTax, net }. */
export function previewBankAccount(record, jid, now = Date.now()) {
  const acct = bankAccountOf(record, jid)
  const balance = acct ? Math.max(0, Math.floor(Number(acct.balance) || 0)) : 0
  const pendingTax = acct ? accountTaxDue(acct, now) : 0
  return { balance, pendingTax, net: Math.max(0, balance - pendingTax) }
}

/** Total maintenance tax a sweep would take across all accounts right now, no mutation. */
export function previewBankTax(record, now = Date.now()) {
  const accts = record?.bank?.accounts ?? {}
  let total = 0
  for (const jid of Object.keys(accts)) total += accountTaxDue(accts[jid], now)
  return total
}

/** Total solars banked across every account (the deposits the realm is holding). */
export function bankHeld(record) {
  const accts = record?.bank?.accounts ?? {}
  return Object.values(accts).reduce((s, a) => s + Math.max(0, Math.floor(Number(a?.balance) || 0)), 0)
}

/**
 * Settles ONE account's accrued maintenance tax in place: deducts it from the
 * balance, CREDITS it to the treasury (the ruler's cut), tallies it, and stamps
 * the clock to `now`. Returns the tax taken. This is the single tax-crediting
 * path, called on every deposit/withdraw of that account and, for all accounts,
 * from the collect sweep (accrueBankAll).
 */
export function accrueBankAccount(record, jid, now = Date.now()) {
  const acct = bankAccountOf(record, jid)
  if (!acct) return 0
  const tax = accountTaxDue(acct, now)
  if (tax > 0) {
    acct.balance = Math.max(0, acct.balance - tax)
    record.treasury = Math.max(0, Math.floor(Number(record.treasury) || 0)) + tax
    record.bank.taxCollected = Math.max(0, Math.floor(Number(record.bank?.taxCollected) || 0)) + tax
  }
  acct.lastTaxAt = now
  return tax
}

/** Sweeps every account's maintenance tax into the treasury; returns the total. */
export function accrueBankAll(record, now = Date.now()) {
  const accts = record?.bank?.accounts ?? {}
  let total = 0
  for (const jid of Object.keys(accts)) total += accrueBankAccount(record, jid, now)
  return total
}

/**
 * Moves `amount` solars INTO a jid's account (creating it if new), after settling
 * any tax due first. The caller has already validated the amount and debited the
 * player's wallet in the SAME mutator; this only touches the record. Returns
 * { balance, taxTaken }. Assumes amount is a positive integer.
 */
export function bankDeposit(record, jid, amount, now = Date.now()) {
  if (!record.bank || typeof record.bank !== 'object') record.bank = { accounts: {}, taxCollected: 0 }
  if (!record.bank.accounts || typeof record.bank.accounts !== 'object') record.bank.accounts = {}
  const amt = Math.max(0, Math.floor(Number(amount) || 0))
  let taxTaken = 0
  let acct = record.bank.accounts[jid]
  if (!acct || typeof acct !== 'object') {
    acct = { balance: 0, lastTaxAt: now }
    record.bank.accounts[jid] = acct
  } else {
    taxTaken = accrueBankAccount(record, jid, now) // settle before changing the balance
  }
  acct.balance = Math.max(0, Math.floor(Number(acct.balance) || 0)) + amt
  acct.lastTaxAt = now
  return { balance: acct.balance, taxTaken }
}

/**
 * Moves up to `amount` solars OUT of a jid's account, after settling any tax due.
 * Pass Infinity for "all". Returns { ok:true, paid, balance, taxTaken } or
 * { ok:false, reason:'noaccount'|'empty'|'short', paid:0, balance }. The caller
 * credits the player's wallet by `paid` in the SAME mutator.
 */
export function bankWithdraw(record, jid, amount, now = Date.now()) {
  const acct = bankAccountOf(record, jid)
  if (!acct) return { ok: false, reason: 'noaccount', paid: 0, balance: 0, taxTaken: 0 }
  const taxTaken = accrueBankAccount(record, jid, now)
  const bal = Math.max(0, Math.floor(Number(acct.balance) || 0))
  if (bal <= 0) return { ok: false, reason: 'empty', paid: 0, balance: 0, taxTaken }
  const want = amount === Infinity ? bal : Math.max(0, Math.floor(Number(amount) || 0))
  if (want <= 0) return { ok: false, reason: 'short', paid: 0, balance: bal, taxTaken }
  const paid = Math.min(want, bal)
  acct.balance = bal - paid
  acct.lastTaxAt = now
  return { ok: true, paid, balance: acct.balance, taxTaken }
}

// ── Coffee house (a walkable social spot; orders fund the treasury) ──────────
// The coffee house is pure sink-to-treasury: a visitor spends wallet solars on a
// cup and the coin lands in the owner's coffers. No production, no stats (stats
// are locked), no collect hook. These helpers just read the data-driven menu; the
// wallet debit and treasury credit happen in ONE plugin mutator at order time.

/** True when this empire has raised a coffee house. */
export function coffeeHouseBuilt(record) { return !!findBuilding(record, 'coffee_house') }

/** The sanitized drink board: [{ id, name, price, line }], prices floored >= 0. */
export function coffeeMenu() {
  const menu = Array.isArray(COFFEE_CONFIG?.menu) ? COFFEE_CONFIG.menu : []
  return menu
    .filter(d => d && typeof d === 'object' && d.id != null)
    .map(d => ({
      id: String(d.id).toLowerCase(),
      name: String(d.name ?? d.id),
      price: Math.max(0, Math.floor(Number(d.price) || 0)),
      line: String(d.line ?? ''),
    }))
}

/** Resolve a query to a menu drink by id, then exact name, then loose contains. */
export function coffeeDrink(query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return null
  const menu = coffeeMenu()
  return menu.find(d => d.id === q)
    ?? menu.find(d => d.name.toLowerCase() === q)
    ?? menu.find(d => d.name.toLowerCase().includes(q) || d.id.includes(q))
    ?? null
}

// ── Premium shop (gem-bought empire perks) ────────────────────────────────
// Pure catalog helpers only. Gems live on the PLAYER (player.wallet.gems),
// not the empire record, so the debit and the once-per-day claim cooldown
// are owned by plugins/empire-premium.js, the same split coffee.js uses for
// solars/treasury. warehouseBonusFromPermits below is the one place this
// system reaches into empire math, and it is purely additive: a record with
// zero permits computes an identical warehouseCap() to before this shop
// existed.

/** The sanitized premium catalog: [{ id, name, emoji, kind, priceGems, ... }]. */
export function premiumShopItems() {
  const items = Array.isArray(PREMIUM_SHOP_CONFIG?.items) ? PREMIUM_SHOP_CONFIG.items : []
  return items
    .filter(i => i && typeof i === 'object' && i.id != null)
    .map(i => ({
      id: String(i.id).toLowerCase(),
      name: String(i.name ?? i.id),
      emoji: String(i.emoji ?? '💎'),
      kind: i.kind === 'passive' ? 'passive' : 'consumable',
      priceGems: Math.max(0, Math.floor(Number(i.priceGems) || 0)),
      warehouseBonus: Number.isFinite(Number(i.warehouseBonus)) ? Math.floor(Number(i.warehouseBonus)) : 0,
      blurb: String(i.blurb ?? ''),
      detail: String(i.detail ?? ''),
    }))
}

/** Resolve a query to a premium item by id, then exact name, then loose contains. */
export function findPremiumItem(query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return null
  const items = premiumShopItems()
  return items.find(i => i.id === q)
    ?? items.find(i => i.name.toLowerCase() === q)
    ?? items.find(i => i.name.toLowerCase().includes(q) || i.id.includes(q))
    ?? null
}

/** How many Warehouse Permits this empire has stacked, from record.premiumPermits. */
export function warehousePermitCount(record) {
  const n = Math.floor(Number(record?.premiumPermits) || 0)
  return Math.max(0, n)
}

/** Flat capacity bonus every stacked Warehouse Permit is worth, read from the catalog. */
export function warehouseBonusFromPermits(record) {
  const permitDef = findPremiumItem('warehouse_permit')
  return warehousePermitCount(record) * (permitDef?.warehouseBonus ?? 0)
}

// ── Townsfolk (named residents, their kit, their favor, their gifts) ─────────
// Phase 9. record.npcs stays the anonymous HEADCOUNT it has always been; this
// section names a bounded subset of those residents, exactly the way the army
// keeps recruits/soldiers as levy counts and only names veterans and above. A
// named resident carries a trade, one weapon and one armor design rolled from
// that trade's own pools (so no two look or fight alike), and a favor score.
//
// Favor has two sources: time lived in the realm, and the ruler paying them
// attention (a greeting, a round bought at the coffee house). At full favor the
// resident hands over their trade's heirloom armor, once, and one of the ten
// heirlooms in data/empire-heirlooms.json is the ONLY thing that comes out of
// this system. No stats are touched here, so nothing about it can move a
// player's sheet: the armor does that the ordinary way, through equip.
//
// Preview/accrue is split the same way the bank's is: previewFolk() projects
// favor for display and mutates nothing, accrueFolk() banks it and stamps the
// clock. Both clamp elapsed time to OFFLINE_CAP_MS like every other clock here.

export const FOLK_CONFIG = empireData.folk ?? {}
export const FOLK_TRADES = Array.isArray(FOLK_CONFIG.trades) ? FOLK_CONFIG.trades : []
export const folkTradeMap = Object.fromEntries(FOLK_TRADES.map(t => [t.id, t]))

/** How many residents can be named at once (the rest stay a headcount). */
export function folkCap() {
  return Math.max(0, Math.floor(Number(FOLK_CONFIG.namedCap) || 0))
}

/** Favor a resident needs before their heirloom is handed over. */
export function folkGiftFavor() {
  return Math.max(1, Math.floor(Number(FOLK_CONFIG.giftFavor) || 100))
}

/** Backfills record.folk, dropping anything that no longer resolves to a trade. */
export function ensureFolkShape(record) {
  if (!record || typeof record !== 'object') return record
  if (!Array.isArray(record.folk)) record.folk = []
  record.folk = record.folk.filter(f => f && typeof f === 'object' && f.name && folkTradeMap[f.trade])
  for (const f of record.folk) {
    f.name = String(f.name)
    if (typeof f.favor !== 'number' || !Number.isFinite(f.favor)) f.favor = 0
    f.favor = Math.max(0, Math.floor(f.favor))
    if (typeof f.joinedAt !== 'number' || !Number.isFinite(f.joinedAt)) f.joinedAt = record.foundedAt ?? null
    if (typeof f.lastGreetAt !== 'number' || !Number.isFinite(f.lastGreetAt)) f.lastGreetAt = 0
    f.gifted = !!f.gifted
    const trade = folkTradeMap[f.trade]
    if (typeof f.weapon !== 'string' || !f.weapon) f.weapon = trade.weapons?.[0] ?? 'a work worn tool'
    if (!f.armor || typeof f.armor !== 'object' || !f.armor.name) f.armor = trade.armors?.[0] ?? { name: 'Plain Workwear', look: 'undyed cloth, much mended' }
  }
  if (record.folk.length > folkCap()) record.folk.length = folkCap()
  if (typeof record.lastFolkAt !== 'number' || !Number.isFinite(record.lastFolkAt)) record.lastFolkAt = record.foundedAt ?? null
  return record
}

/** The heirloom item id a trade's resident eventually gives up. */
export function heirloomForTrade(tradeId) {
  return folkTradeMap[tradeId]?.heirloom ?? null
}

/**
 * Mints one named resident. Trades already living here are skipped first, so a
 * realm collects distinct heirlooms instead of three coifs, and only falls back
 * to a repeat once all ten trades are represented.
 *
 * Names retry until the GIVEN name is free, not just the full name: every folk
 * command takes a loose query (`.folk greet bram`), so two Brams in one village
 * would silently send the ruler to whichever sat earlier in the list. There are
 * 50 given names against a cap of 10 residents, so a clean draw is easy, and
 * finding none in 12 tries just means no arrival this pass.
 */
export function rollFolkMember(record, now = Date.now(), rng = Math.random) {
  if (!FOLK_TRADES.length) return null
  const taken = new Set((record.folk ?? []).map(f => f.trade))
  const open = FOLK_TRADES.filter(t => !taken.has(t.id))
  const pool = open.length ? open : FOLK_TRADES
  const trade = pool[Math.floor(rng() * pool.length)] ?? pool[0]
  const weapons = trade.weapons?.length ? trade.weapons : ['a work worn tool']
  const armors = trade.armors?.length ? trade.armors : [{ name: 'Plain Workwear', look: 'undyed cloth, much mended' }]

  const givenOf = n => String(n ?? '').split(' ')[0].toLowerCase()
  const used = new Set((record.folk ?? []).map(f => givenOf(f.name)))
  let name = townsfolkName(rng)
  for (let i = 0; i < 12 && used.has(givenOf(name)); i++) name = townsfolkName(rng)
  if (used.has(givenOf(name))) return null

  return {
    name,
    trade: trade.id,
    weapon: weapons[Math.floor(rng() * weapons.length)] ?? weapons[0],
    armor: { ...(armors[Math.floor(rng() * armors.length)] ?? armors[0]) },
    favor: 0,
    joinedAt: now,
    lastGreetAt: 0,
    gifted: false,
  }
}

/** Favor a resident would have gained from residence time since the last stamp. */
function residenceFavor(record, now) {
  const last = typeof record?.lastFolkAt === 'number' ? record.lastFolkAt : now
  const elapsed = now > last ? Math.min(now - last, OFFLINE_CAP_MS) : 0
  const perHour = Math.max(0, Number(FOLK_CONFIG.favorPerHour) || 0)
  return { gain: Math.floor((elapsed / HOUR_MS) * perHour), stamp: now }
}

/**
 * Banks everything the townsfolk earned: names any resident the headcount now
 * supports, then adds residence favor to everyone already living here. Returns
 * the new arrivals (so a collect can introduce them by name) and how much favor
 * each existing resident gained. Mutates; call it inside a write path only.
 */
export function accrueFolk(record, now = Date.now(), rng = Math.random) {
  ensureFolkShape(record)
  const { gain } = residenceFavor(record, now)
  if (gain > 0) {
    for (const f of record.folk) {
      if (!f.gifted) f.favor = Math.min(folkGiftFavor(), f.favor + gain)
    }
  }
  const npcs = Math.max(0, Math.floor(record?.npcs ?? 0))
  const want = Math.min(npcs, folkCap())
  const newFolk = []
  while (record.folk.length < want) {
    const member = rollFolkMember(record, now, rng)
    if (!member) break
    record.folk.push(member)
    newFolk.push(member)
  }
  record.lastFolkAt = now
  return { newFolk, favorGain: gain }
}

/**
 * Display view: every resident with the favor they WOULD have right now, plus
 * whether their heirloom is ready. Mutates nothing, so `.folk` can be a pure
 * read and a player who has not collected in a while still sees the truth.
 */
export function previewFolk(record, now = Date.now()) {
  ensureFolkShape(record)
  const { gain } = residenceFavor(record, now)
  const target = folkGiftFavor()
  return record.folk.map(f => {
    const favor = f.gifted ? target : Math.min(target, f.favor + gain)
    return {
      ...f,
      favor,
      target,
      ready: !f.gifted && favor >= target,
      trade: f.trade,
      tradeDef: folkTradeMap[f.trade],
      heirloom: heirloomForTrade(f.trade),
    }
  })
}

/** Residents holding a gift the ruler has not taken yet. */
export function pendingFolkGifts(record, now = Date.now()) {
  return previewFolk(record, now).filter(f => f.ready)
}

/** Match a free-text query to one resident: exact name, then given name, then loose. */
export function findFolkMember(record, query) {
  ensureFolkShape(record)
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return null
  const folk = record.folk
  return folk.find(f => f.name.toLowerCase() === q)
    ?? folk.find(f => f.name.toLowerCase().split(' ')[0] === q)
    ?? folk.find(f => f.trade === q)
    ?? folk.find(f => f.name.toLowerCase().includes(q) || f.trade.includes(q))
    ?? null
}

/**
 * The ruler stops to talk. Banks pending favor first (so the greeting lands on
 * a current number), then adds greetFavor if this resident's cooldown is up.
 * Returns { ok, folk, gained, waitMs } and mutates only on ok.
 */
export function greetFolkMember(record, query, now = Date.now()) {
  accrueFolk(record, now)
  const folk = findFolkMember(record, query)
  if (!folk) return { ok: false, reason: 'missing' }
  const cooldown = Math.max(0, Number(FOLK_CONFIG.greetCooldownHours) || 0) * HOUR_MS
  const since = now - (folk.lastGreetAt ?? 0)
  if (cooldown > 0 && since < cooldown) {
    return { ok: false, reason: 'cooldown', folk, waitMs: cooldown - since }
  }
  if (folk.gifted) return { ok: false, reason: 'gifted', folk }
  const gain = Math.max(0, Math.floor(Number(FOLK_CONFIG.greetFavor) || 0))
  folk.favor = Math.min(folkGiftFavor(), folk.favor + gain)
  folk.lastGreetAt = now
  return { ok: true, folk, gained: gain, ready: folk.favor >= folkGiftFavor() }
}

/**
 * A round bought at the coffee house lifts the favor of everyone drinking. Used
 * by plugins/coffee.js when the RULER orders, which is the one moment the whole
 * room sees them. Returns how many residents were lifted.
 */
export function cupFavorForFolk(record, now = Date.now()) {
  accrueFolk(record, now)
  const gain = Math.max(0, Math.floor(Number(FOLK_CONFIG.cupFavor) || 0))
  if (gain <= 0) return 0
  let lifted = 0
  for (const f of record.folk) {
    if (f.gifted) continue
    f.favor = Math.min(folkGiftFavor(), f.favor + gain)
    lifted++
  }
  return lifted
}

/**
 * Reports the heirloom a resident is willing to hand over, returning the live
 * folk object and the item id. It deliberately does NOT mark them gifted: the
 * caller sets folk.gifted only once the armor is actually in the bag, so a full
 * inventory leaves the heirloom with its owner instead of burning it. The
 * inventory-room check is the caller's too (see plugins/folk.js).
 */
export function claimFolkGift(record, query, now = Date.now()) {
  accrueFolk(record, now)
  const folk = findFolkMember(record, query)
  if (!folk) return { ok: false, reason: 'missing' }
  if (folk.gifted) return { ok: false, reason: 'already', folk }
  const target = folkGiftFavor()
  if (folk.favor < target) return { ok: false, reason: 'notyet', folk, need: target - folk.favor }
  const itemId = heirloomForTrade(folk.trade)
  if (!itemId) return { ok: false, reason: 'noitem', folk }
  return { ok: true, folk, itemId, target }
}

// ── Army ─────────────────────────────────────────────────────────────────

export const ARMY_CONFIG = empireData.army
export const ARMY_RANKS = ARMY_CONFIG.ranks
export const RANK_ORDER = ARMY_RANKS.map(r => r.id)
export const rankMap = Object.fromEntries(ARMY_RANKS.map(r => [r.id, r]))
export const OFFICER_CAP = ARMY_CONFIG.officerCap ?? 40
export const RECRUIT_COST_SOLARS = ARMY_CONFIG.recruitCostSolars ?? 0

/**
 * Backfills the army sub-record. Rank and file are integer counts
 * (levies.recruit / levies.soldier); veterans and above are named officer
 * records { name, rank, xp } whose power is derived on read, never stored.
 * lastPaidAt is the payroll clock, stamped every collect. Idempotent, called
 * from ensureEmpireShape on every read.
 */
export function ensureArmy(record) {
  if (!record || typeof record !== 'object') return record
  if (!record.army || typeof record.army !== 'object') record.army = {}
  const a = record.army
  if (!a.levies || typeof a.levies !== 'object') a.levies = {}
  a.levies.recruit = Math.max(0, Math.floor(Number(a.levies.recruit) || 0))
  a.levies.soldier = Math.max(0, Math.floor(Number(a.levies.soldier) || 0))
  if (!Array.isArray(a.officers)) a.officers = []
  a.officers = a.officers.filter(o => o && typeof o === 'object')
  for (const o of a.officers) {
    if (!rankMap[o.rank] || !rankMap[o.rank].named) o.rank = 'veteran'
    if (typeof o.name !== 'string' || !o.name.trim()) o.name = 'Unknown Officer'
    if (typeof o.xp !== 'number' || !Number.isFinite(o.xp) || o.xp < 0) o.xp = 0
  }
  if (typeof a.lastPaidAt !== 'number') a.lastPaidAt = a.lastPaidAt ?? null
  return record
}

export function rankIndex(rankId) {
  return RANK_ORDER.indexOf(rankId)
}

/** The rank one step above `rankId`, or null at the top (warlord). */
export function nextRankId(rankId) {
  const i = rankIndex(rankId)
  return i >= 0 && i < RANK_ORDER.length - 1 ? RANK_ORDER[i + 1] : null
}

export function officerCount(record, rankId) {
  return (record?.army?.officers ?? []).filter(o => o.rank === rankId).length
}

/** Units the empire has at one rank: a levy count for recruit/soldier, else an officer count. */
export function rankCount(record, rankId) {
  const a = record?.army
  if (!a) return 0
  if (rankId === 'recruit' || rankId === 'soldier') return a.levies?.[rankId] ?? 0
  return officerCount(record, rankId)
}

/** Total bodies in the army: levies plus named officers. */
export function armyHeadcount(record) {
  const a = record?.army
  if (!a) return 0
  return (a.levies?.recruit ?? 0) + (a.levies?.soldier ?? 0) + (a.officers?.length ?? 0)
}

/** How many troops the empire can field: tier base plus every Barracks bonus. */
export function armyCap(record) {
  let cap = tierOf(record).armyBase ?? 0
  for (const b of record?.buildings ?? []) {
    const def = buildingDefMap[b.type]
    if (def?.armyCapBonus) cap += def.armyCapBonus * b.level
  }
  return cap
}

export function armySlotsLeft(record) {
  return Math.max(0, armyCap(record) - armyHeadcount(record))
}

/** Power of one named officer: rank power scaled gently by xp. Derived, never stored. */
export function soldierPowerOf(officer) {
  const def = rankMap[officer?.rank]
  if (!def) return 0
  const xp = Math.max(0, Number(officer?.xp) || 0)
  return Math.round(def.power * (1 + xp / 200))
}

/**
 * Total army power. Levies contribute count times rank power; officers each
 * contribute soldierPowerOf. An optional generalBonus (0 and up, from an
 * assigned character in Phase 3) multiplies the whole thing.
 */
export function armyPower(record, generalBonus = 0) {
  const a = record?.army
  if (!a) return 0
  let power = 0
  power += (a.levies?.recruit ?? 0) * (rankMap.recruit?.power ?? 0)
  power += (a.levies?.soldier ?? 0) * (rankMap.soldier?.power ?? 0)
  for (const o of a.officers ?? []) power += soldierPowerOf(o)
  return Math.round(power * (1 + Math.max(0, generalBonus)))
}

/** Total wages the army costs per hour, drawn from the treasury on collect. */
export function wagePerHour(record) {
  const a = record?.army
  if (!a) return 0
  let w = 0
  w += (a.levies?.recruit ?? 0) * (rankMap.recruit?.wagePerHour ?? 0)
  w += (a.levies?.soldier ?? 0) * (rankMap.soldier?.wagePerHour ?? 0)
  for (const o of a.officers ?? []) w += rankMap[o.rank]?.wagePerHour ?? 0
  return w
}

/** The lowest-standing officer (lowest rank, then lowest xp): first to walk when unpaid. */
function lowestOfficer(record) {
  const officers = record?.army?.officers ?? []
  if (!officers.length) return null
  return [...officers].sort((x, y) =>
    (rankIndex(x.rank) - rankIndex(y.rank)) || ((x.xp ?? 0) - (y.xp ?? 0)))[0]
}

/**
 * Removes and returns the lowest-standing officer, or null if the corps is
 * empty. Used by war round casualties: the pure resolver returns a boolean, and
 * the plugin calls this with the live record in hand so the engine stays the
 * single source of truth for which officer walks. Mutates the record.
 */
export function removeLowestOfficer(record) {
  ensureArmy(record)
  const walk = lowestOfficer(record)
  if (!walk) return null
  const idx = record.army.officers.indexOf(walk)
  if (idx < 0) return null
  return record.army.officers.splice(idx, 1)[0]
}

/**
 * Pure payroll math for a collect window. wagesDue accrues over the elapsed
 * time since army.lastPaidAt, clamped to the offline cap. wagesPaid is whatever
 * the given treasury can cover; the unpaid fraction deserts rank and file
 * proportionally. Only when no rank and file remain and nothing at all was paid
 * does the lowest officer walk. Never mutates the record.
 */
export function previewPayroll(record, now = Date.now(), treasuryAvailable = 0) {
  ensureArmy(record)
  const a = record.army
  const perHour = wagePerHour(record)
  const last = typeof a.lastPaidAt === 'number' ? a.lastPaidAt : now
  const hours = Math.min(Math.max(0, now - last), OFFLINE_CAP_MS) / HOUR_MS
  const wagesDue = Math.floor(perHour * hours)
  const wagesPaid = Math.min(wagesDue, Math.max(0, treasuryAvailable))
  const deficit = wagesDue - wagesPaid
  const desertFraction = wagesDue > 0 ? deficit / wagesDue : 0

  const deserters = { recruit: 0, soldier: 0 }
  const officersLost = []
  if (desertFraction > 0) {
    deserters.recruit = Math.floor(desertFraction * (a.levies.recruit ?? 0))
    deserters.soldier = Math.floor(desertFraction * (a.levies.soldier ?? 0))
    const rankFileLeft =
      (a.levies.recruit ?? 0) - deserters.recruit + (a.levies.soldier ?? 0) - deserters.soldier
    if (wagesPaid === 0 && rankFileLeft === 0 && (a.officers?.length ?? 0) > 0) {
      const walk = lowestOfficer(record)
      if (walk) officersLost.push(walk.name)
    }
  }

  return {
    perHour, hours, wagesDue, wagesPaid, deficit,
    deserters, officersLost,
    hasPayroll: wagesDue > 0 || deserters.recruit > 0 || deserters.soldier > 0 || officersLost.length > 0,
  }
}

// ── Recruitment ────────────────────────────────────────────────────────────

export function recruitCostSolars(n) {
  return RECRUIT_COST_SOLARS * Math.max(0, Math.floor(Number(n) || 0))
}

/** Checks a recruit of n bodies against the army cap and treasury. */
export function canRecruit(record, n) {
  ensureArmy(record)
  const count = Math.floor(Number(n))
  if (!Number.isInteger(count) || count <= 0) return { ok: false, reason: 'count' }
  const slots = armySlotsLeft(record)
  if (count > slots) return { ok: false, reason: 'cap', slots, cap: armyCap(record) }
  const cost = recruitCostSolars(count)
  if ((record.treasury ?? 0) < cost) return { ok: false, reason: 'poor', cost, have: record.treasury ?? 0 }
  return { ok: true, count, cost }
}

/** Adds n recruits, drawing the cost from the treasury. Assumes canRecruit passed. */
export function applyRecruit(record, n) {
  const chk = canRecruit(record, n)
  if (!chk.ok) return chk
  record.treasury -= chk.cost
  record.army.levies.recruit += chk.count
  return { ok: true, count: chk.count, cost: chk.cost, head: armyHeadcount(record), cap: armyCap(record) }
}

// ── Promotion (.train soldier) ───────────────────────────────────────────────

/** The lowest rank that has any units and is not already the top rank, or null. */
export function lowestPromotableRank(record) {
  ensureArmy(record)
  const top = RANK_ORDER[RANK_ORDER.length - 1]
  for (const rankId of RANK_ORDER) {
    if (rankId === top) break
    if (rankCount(record, rankId) > 0) return rankId
  }
  return null
}

/** Per-unit cost to promote INTO a target rank. */
export function promoteUnitCost(toRankId) {
  const c = ARMY_CONFIG.promoteCost?.[toRankId] ?? { solars: 0, materials: {} }
  return { solars: c.solars ?? 0, materials: { ...(c.materials ?? {}) } }
}

/** What the next `.train soldier` would promote, or null if the army is empty or all warlords. */
export function promoteInfo(record) {
  const from = lowestPromotableRank(record)
  if (!from) return null
  const to = nextRankId(from)
  return {
    fromRank: from,
    toRank: to,
    available: rankCount(record, from),
    unitCost: promoteUnitCost(to),
    toNamed: !!rankMap[to]?.named,
  }
}

/**
 * Promotes up to n units of the lowest promotable rank, one at a time, paying
 * the per-unit cost from treasury + warehouse until n is reached or the next
 * unit is unaffordable or the officer cap is hit. When a levy crosses into a
 * named rank, nameProvider() supplies the officer's name (kept injectable so
 * the engine stays pure and testable). Existing officers promote in place,
 * preserving their name and xp. Mutates the record.
 */
export function applyPromote(record, n, nameProvider) {
  ensureArmy(record)
  const want = Math.max(0, Math.floor(Number(n) || 0))
  const info = promoteInfo(record)
  if (!info) {
    return { ok: false, reason: armyHeadcount(record) === 0 ? 'empty' : 'maxed' }
  }
  const { fromRank, toRank } = info
  const unit = promoteUnitCost(toRank)
  const fromNamed = !!rankMap[fromRank]?.named
  const toNamed = !!rankMap[toRank]?.named
  const a = record.army

  let promoted = 0
  let hitCap = false
  const newOfficers = []
  let spentSolars = 0
  const spentMaterials = {}

  for (let i = 0; i < want; i++) {
    if (rankCount(record, fromRank) <= 0) break
    // Minting a brand new officer (levy into named) is the only case bounded by the cap.
    if (!fromNamed && toNamed && a.officers.length >= OFFICER_CAP) { hitCap = true; break }
    if (!canAfford(record, unit).ok) break

    payCost(record, unit)
    spentSolars += unit.solars
    for (const [id, qty] of Object.entries(unit.materials)) {
      spentMaterials[id] = (spentMaterials[id] ?? 0) + qty
    }

    if (fromNamed) {
      // Promote an existing officer in place, keeping the lowest-xp one's name and xp.
      const cand = a.officers.filter(o => o.rank === fromRank).sort((x, y) => (x.xp ?? 0) - (y.xp ?? 0))[0]
      cand.rank = toRank
    } else {
      a.levies[fromRank] -= 1
      if (toNamed) {
        const name = nameProvider ? nameProvider() : 'Officer'
        a.officers.push({ name, rank: toRank, xp: 0 })
        newOfficers.push(name)
      } else {
        a.levies[toRank] = (a.levies[toRank] ?? 0) + 1
      }
    }
    promoted++
  }

  if (promoted === 0) {
    if (hitCap) return { ok: false, reason: 'officercap', cap: OFFICER_CAP }
    return { ok: false, reason: 'poor', unitCost: unit, fromRank, toRank }
  }
  return {
    ok: true, promoted, fromRank, toRank, toNamed,
    spentSolars, spentMaterials, newOfficers, hitCap,
  }
}

/**
 * Promotes exactly ONE named officer up a single rank, identified by its
 * 1-based position in the roster as shown by `.army` (record.army.officers
 * order, matching plugins/army.js's rosterLines and doRename). Unlike
 * applyPromote's lowest-first bulk drill, this lets a ruler advance a specific
 * officer without waiting on the rest of the corps. Officers are veteran+ by
 * definition, so promoting one advances an existing record in place, never
 * mints a new officer, and is therefore never bounded by the officer cap.
 * Pays the per-unit cost from treasury + warehouse. Mutates the record.
 * Returns { ok:true, name, fromRank, toRank, unitCost } or { ok:false, reason }
 * with reason one of 'nooff' | 'maxed' | 'poor'.
 */
export function applyPromoteOfficer(record, index) {
  ensureArmy(record)
  const officers = record.army.officers ?? []
  const i = Math.floor(Number(index)) - 1
  if (!Number.isInteger(i) || i < 0 || i >= officers.length) return { ok: false, reason: 'nooff' }
  const officer = officers[i]
  const toRank = nextRankId(officer.rank)
  if (!toRank) return { ok: false, reason: 'maxed', name: officer.name, fromRank: officer.rank }
  const unit = promoteUnitCost(toRank)
  if (!canAfford(record, unit).ok) {
    return { ok: false, reason: 'poor', name: officer.name, fromRank: officer.rank, toRank, unitCost: unit }
  }
  payCost(record, unit)
  const fromRank = officer.rank
  officer.rank = toRank
  return { ok: true, name: officer.name, fromRank, toRank, unitCost: unit }
}

// ── Naming ───────────────────────────────────────────────────────────────

/** Turns an empire name into a lookup id: lowercase, alphanumerics to dashes. */
export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Validates a proposed empire name. Returns { ok, reason } where reason is a
 * short, player-facing sentence with no em dashes.
 */
export function validateName(name) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return { ok: false, reason: 'Give your empire a name.' }
  if (trimmed.length < EMPIRE_CONFIG.nameMinLen) {
    return { ok: false, reason: `That name is too short. Use at least ${EMPIRE_CONFIG.nameMinLen} characters.` }
  }
  if (trimmed.length > EMPIRE_CONFIG.nameMaxLen) {
    return { ok: false, reason: `That name is too long. Keep it under ${EMPIRE_CONFIG.nameMaxLen} characters.` }
  }
  const slug = slugify(trimmed)
  if (!slug) return { ok: false, reason: 'That name has no letters or numbers in it. Try another.' }
  return { ok: true, slug, name: trimmed }
}

// ── Small display helpers ────────────────────────────────────────────────

/** "2h 14m" / "45m" / "under a minute" / "0m". Local to avoid a cross-pillar import. */
export function fmtDuration(ms) {
  if (ms <= 0) return '0m'
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'under a minute'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${m}m`
}

export { shortSolars }

// ── Ready-to-assign presets ──────────────────────────────────────────────
/**
 * Pre-built empires an owner can hand to a player whose realm was lost, so a
 * restoration is one command instead of an hour of manual building. The data
 * lives in data/empire.json under `presets` (see its `_readme`); this section
 * is only the rules layer over it.
 *
 * Two invariants make a preset safe to hand over:
 *   1. Headcount goes to `npcs`, never `citizenCount`. citizenCount is
 *      recomputed from the player side on every boot (reconcileCitizenCount),
 *      so anything stored there is thrown away, and fame/tierId are derived by
 *      ensureEmpireShape from the two together.
 *   2. Every preset must fit its OWN derived tier: buildings within
 *      buildingCap, army within armyCap, officers within OFFICER_CAP,
 *      warehouse within warehouseCap, and net solars per hour positive. That
 *      last one matters most: an empire handed over already underwater would
 *      desert its army on the new owner's first `.empire collect`.
 * auditPreset() below is the executable form of that contract, and
 * scripts/empire-check.mjs runs it over all of them.
 */
export const PRESETS = empireData.presets?.list ?? []
export const PRESET_ORDER = [...PRESETS].sort((a, b) => (a.citizens ?? 0) - (b.citizens ?? 0))
export const presetMap = Object.fromEntries(PRESETS.map(p => [p.id, p]))

/** Resolve a preset by exact id, then by partial name or specialisation match. */
export function findPreset(query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return null
  if (presetMap[q]) return presetMap[q]
  return PRESET_ORDER.find(p =>
    p.name.toLowerCase().includes(q) ||
    p.specialisation.toLowerCase().includes(q)) ?? null
}

/**
 * The derived shape of a preset without writing it anywhere: what tier its
 * headcount lands in, what its buildings and army come to, and whether it pays
 * for itself. Everything here is computed through the same functions the live
 * dashboard uses, so a preview can never disagree with the assigned empire.
 */
export function presetPreview(preset) {
  if (!preset) return null
  const probe = ensureEmpireShape({
    id: `preview-${preset.id}`,
    name: preset.name,
    ownerId: null,
    foundedAt: 0,
    citizenCount: 1,
    npcs: preset.citizens ?? 0,
    treasury: preset.treasury ?? 0,
    warehouse: { ...(preset.warehouse ?? {}) },
    buildings: (preset.buildings ?? []).map(b => ({ ...b })),
    army: {
      levies: { ...(preset.army?.levies ?? {}) },
      officers: (preset.army?.officers ?? []).map(o => ({ ...o })),
      lastPaidAt: 0,
    },
  })
  const upkeep = computeUpkeep(probe)
  return {
    record: probe,
    tier: tierOf(probe),
    population: populationOf(probe),
    popCap: popCap(probe),
    buildingCount: probe.buildings.length,
    buildingCap: tierOf(probe).buildingCap ?? 0,
    armyHeadcount: armyHeadcount(probe),
    armyCap: armyCap(probe),
    armyPower: armyPower(probe),
    officers: probe.army.officers.length,
    warehouseUsed: warehouseUsed(probe),
    warehouseCap: warehouseCap(probe),
    score: empireScore(probe),
    ...upkeep,
  }
}

/**
 * Checks one preset against every cap it has to live inside. Returns
 * { ok, problems[] } rather than throwing, so the check script can print all
 * the failures of all the presets in one run.
 */
export function auditPreset(preset) {
  const problems = []
  if (!preset?.id) return { ok: false, problems: ['preset has no id'] }
  const view = presetPreview(preset)

  if (!Number.isFinite(preset.citizens) || preset.citizens < 1) problems.push('citizens must be a positive number')
  if (view.buildingCount > view.buildingCap) {
    problems.push(`${view.buildingCount} buildings over the ${view.tier.name} cap of ${view.buildingCap}`)
  }
  if (view.armyHeadcount > view.armyCap) {
    problems.push(`army of ${view.armyHeadcount} over the cap of ${view.armyCap}`)
  }
  if (view.officers > OFFICER_CAP) {
    problems.push(`${view.officers} officers over the cap of ${OFFICER_CAP}`)
  }
  if (view.warehouseUsed > view.warehouseCap) {
    problems.push(`warehouse holds ${view.warehouseUsed} over the cap of ${view.warehouseCap}`)
  }
  if (view.netSolarsPerHour <= 0) {
    problems.push(`net ${view.netSolarsPerHour}/h is not positive, the army would desert on first collect`)
  }
  for (const b of preset.buildings ?? []) {
    const def = buildingDefMap[b.type]
    if (!def) { problems.push(`unknown building "${b.type}"`); continue }
    if (b.level > def.maxLevel) problems.push(`${b.type} level ${b.level} over its max of ${def.maxLevel}`)
    if (def.minRank > view.tier.rank) problems.push(`${b.type} needs rank ${def.minRank}, tier is ${view.tier.rank}`)
    if (b.region && !regionMap[b.region]) problems.push(`${b.type} sits in unknown region "${b.region}"`)
  }
  for (const [region, count] of Object.entries(regionCountsOf(view.record))) {
    if (count > REGION_CAP) problems.push(`${region} holds ${count} buildings, over the ${REGION_CAP} per region`)
  }
  for (const o of preset.army?.officers ?? []) {
    if (!rankMap[o.rank]?.named) problems.push(`officer ${o.name} has non-officer rank "${o.rank}"`)
  }
  for (const id of Object.keys(preset.warehouse ?? {})) {
    if (!MATERIAL_IDS.includes(id)) problems.push(`warehouse names unknown material "${id}"`)
  }
  if (preset.soilerRank && !rankMap[preset.soilerRank]) problems.push(`unknown soilerRank "${preset.soilerRank}"`)

  return { ok: problems.length === 0, problems }
}

/**
 * Picks the preset that best fits a player, so a restoration does not have to
 * be eyeballed. Level is the yardstick (it is the one number that tracks how
 * far along a player is regardless of what they lost), with wallet plus banked
 * solars as a tiebreak nudge upward for someone visibly wealthy.
 */
export function suggestPreset(player) {
  if (!PRESET_ORDER.length) return null
  const level = Math.max(1, Number(player?.level) || 1)
  const purse = (player?.wallet?.solars ?? 0) + (player?.bank?.balance ?? 0) + (player?.vault?.solars ?? 0)
  // Level 1-19 the smallest, then one step up per 20 levels, capped at the top.
  let index = Math.floor((level - 1) / 20)
  if (purse >= 500_000) index += 2
  else if (purse >= 150_000) index += 1
  return PRESET_ORDER[Math.min(PRESET_ORDER.length - 1, Math.max(0, index))]
}
