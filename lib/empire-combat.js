/**
 * lib/empire-combat.js — pure raid, scout and war resolution.
 *
 * Everything here is a pure function of a read-only *snapshot* plus an
 * injectable rng, so scripts/empire-check.mjs can simulate 10,000 raids with
 * zero db and zero socket. The plugins (plugins/raid.js, later plugins/war.js)
 * build the snapshots, call these resolvers, then apply the returned plan
 * through the serialized write queue. This module never mutates a record, never
 * touches a socket, and never reads a player's baseStats: army power arrives
 * pre-computed in the snapshot (with any general bonus already folded in).
 *
 * Two power notions are kept deliberately distinct:
 *   - might  = empireScore, a stable measure of overall empire size. Used ONLY
 *              for weight matching, so you cannot dodge it by disbanding troops.
 *   - power  = army power, the fighting strength. Used ONLY for who wins a raid.
 * That split closes the "hoard treasury, field no army, stay unraidable" hole:
 * a rich empire keeps a high might and stays a valid target for its peers.
 */
import {
  RAID_CONFIG, WAR_CONFIG, HOUR_MS, armyPower, empireScore, tierOf, buildingDefMap,
} from './empire-engine.js'

// ── Snapshots ────────────────────────────────────────────────────────────────

/**
 * A flat, read-only picture of an empire for combat. generalBonus (0 and up,
 * from an assigned character general in Phase 3c) is folded into power here so
 * the resolvers never need to know characters exist. Never mutates the record.
 */
export function buildSnapshot(record, { generalBonus = 0 } = {}) {
  const producingTypes = (record?.buildings ?? [])
    .filter(b => buildingDefMap[b.type]?.produces)
    .map(b => b.type)
  return {
    id: record?.id ?? null,
    name: record?.name ?? 'an empire',
    ownerId: record?.ownerId ?? null,
    might: empireScore(record),
    power: armyPower(record, generalBonus),
    tierRank: tierOf(record).rank,
    treasury: Math.max(0, Math.floor(record?.treasury ?? 0)),
    levies: {
      recruit: Math.max(0, Math.floor(record?.army?.levies?.recruit ?? 0)),
      soldier: Math.max(0, Math.floor(record?.army?.levies?.soldier ?? 0)),
    },
    officerCount: record?.army?.officers?.length ?? 0,
    headcount: (record?.army?.levies?.recruit ?? 0) + (record?.army?.levies?.soldier ?? 0) + (record?.army?.officers?.length ?? 0),
    producingTypes,
    shieldUntil: record?.shieldUntil ?? 0,
    deployedUntil: record?.deployedUntil ?? 0,
    lastRaidAt: record?.lastRaidAt ?? 0,
  }
}

// ── Weight matching ──────────────────────────────────────────────────────────

/**
 * Anti-bully rule: reject raiding an empire far weaker than you overall.
 * Compares MIGHT (empireScore), not army power, so a rich empire that disbands
 * its troops is still a valid target for peers, while a genuinely small empire
 * is protected from being farmed by a giant. Attacking UP is always allowed:
 * a small raider may bloody a giant's nose (and will usually just lose troops),
 * so there is no upper bound to grief-guard.
 */
export function weightMatchOk(attacker, defender, floorPct = RAID_CONFIG.weightFloorPct ?? 0.5) {
  if ((attacker?.might ?? 0) <= 0) return true
  return (defender?.might ?? 0) >= (attacker?.might ?? 0) * floorPct
}

// ── Raid resolution ──────────────────────────────────────────────────────────

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** Levy casualties: a fraction of each rank-and-file pool, floored to integers. */
function levyLosses(snap, frac) {
  const f = clamp01(frac)
  return {
    recruit: Math.floor((snap.levies.recruit ?? 0) * f),
    soldier: Math.floor((snap.levies.soldier ?? 0) * f),
  }
}

/**
 * Resolves one raid from pre-built snapshots. Pure: same snapshots + same rng
 * sequence always yield the same plan. The plugin applies the returned deltas.
 *
 * Model:
 *   - Each side rolls an effective power within +/- variancePct of its army
 *     power, so an underdog can upset a stronger but unlucky foe.
 *   - The higher roll wins. Loot (attacker win only) is a margin-scaled slice of
 *     the defender treasury, hard-capped, never exceeding what is actually there.
 *   - Both sides lose rank-and-file levies; the winner always loses SOME, the
 *     loser loses more, both scaled by how decisive the margin was. Officers are
 *     never lost in a raid (that is reserved for wars) so raids stay light.
 *   - On an attacker win, exactly one of the defender's producing buildings is
 *     knocked offline (damaged, never destroyed) until damagedUntil passes.
 *   - The beaten defender gets a recovery shield so they cannot be farmed. A
 *     repelled attacker gets no shield: they chose the fight and just eat the
 *     losses plus the deploy-exposure window.
 */
export function resolveRaid(attacker, defender, rng = Math.random, now = Date.now()) {
  const variance = RAID_CONFIG.variancePct ?? 0.25
  const aRoll = 1 + (rng() * 2 - 1) * variance
  const dRoll = 1 + (rng() * 2 - 1) * variance
  const aEff = Math.max(0, (attacker?.power ?? 0) * aRoll)
  const dEff = Math.max(0, (defender?.power ?? 0) * dRoll)
  const attackerWins = aEff >= dEff

  const total = aEff + dEff
  const margin = total > 0 ? Math.abs(aEff - dEff) / total : 0

  // Loot: only the winner-attacker takes it, from the defender treasury.
  let loot = 0
  if (attackerWins) {
    const pct = (RAID_CONFIG.lootTreasuryPct ?? 0.15) * (0.5 + 0.5 * margin)
    loot = Math.floor(Math.min((defender?.treasury ?? 0) * pct, RAID_CONFIG.lootHardCap ?? Infinity))
    loot = Math.max(0, Math.min(loot, defender?.treasury ?? 0))
  }

  // Casualties. Winner always bleeds a little; the loser bleeds more, and a
  // decisive margin spares the winner while punishing the loser further.
  const winnerBase = RAID_CONFIG.winnerLossPct ?? 0.06
  const loserBase = RAID_CONFIG.loserLossPct ?? 0.20
  const winnerFrac = winnerBase * (1 - 0.5 * margin)
  const loserFrac = loserBase * (1 + 0.5 * margin)
  const attackerLosses = levyLosses(attacker, attackerWins ? winnerFrac : loserFrac)
  const defenderLosses = levyLosses(defender, attackerWins ? loserFrac : winnerFrac)

  // Building damage: attacker win only, one random producing building offline.
  let damaged = null
  if (attackerWins && (defender?.producingTypes?.length ?? 0) > 0) {
    const types = defender.producingTypes
    const pick = types[Math.min(types.length - 1, Math.floor(rng() * types.length))]
    damaged = { type: pick, until: now + (RAID_CONFIG.buildingDamageHours ?? 6) * HOUR_MS }
  }

  const shieldHours = RAID_CONFIG.shieldHours ?? 12
  const deployHours = RAID_CONFIG.deployHours ?? 3

  return {
    attackerWins,
    margin,
    aEff: Math.round(aEff),
    dEff: Math.round(dEff),
    loot,
    attackerLosses,
    defenderLosses,
    damaged,
    // The beaten defender is shielded; a repelled attacker is not.
    defenderShieldUntil: attackerWins ? now + shieldHours * HOUR_MS : 0,
    // The attacker's troops are committed and exposed regardless of outcome.
    attackerDeployedUntil: now + deployHours * HOUR_MS,
    now,
  }
}

// ── Siege resolution ─────────────────────────────────────────────────────────

/**
 * Resolves ONE tick of a siege from pre-built snapshots. A siege is the timed
 * form of a raid: instead of resolving instantly it grinds out over several
 * ticks (RAID_CONFIG.siegeTicks), each one an assault that either presses the
 * walls or is thrown back. Ticks bleed FAR less than a whole raid so a siege of
 * many ticks nets out near a single raid, only spread across real time with a
 * status you can poll between ticks.
 *
 * Model per tick, mirroring resolveRaid's roll:
 *   - Each side rolls effective power within +/- variancePct of its army power.
 *   - The higher roll takes the tick; the plugin tallies tick wins each side.
 *   - Both sides lose rank-and-file levies, the tick loser more, scaled by the
 *     margin. No officer loss and no building damage per tick: those belong to
 *     the siege's conclusion, resolved once by the repo, not every fifteen
 *     minutes. No loot here either; the repo accrues loot on attacker-win ticks.
 */
export function resolveSiegeTick(attacker, defender, rng = Math.random, now = Date.now()) {
  const variance = RAID_CONFIG.variancePct ?? 0.25
  const aRoll = 1 + (rng() * 2 - 1) * variance
  const dRoll = 1 + (rng() * 2 - 1) * variance
  const aEff = Math.max(0, (attacker?.power ?? 0) * aRoll)
  const dEff = Math.max(0, (defender?.power ?? 0) * dRoll)
  const attackerWins = aEff >= dEff

  const total = aEff + dEff
  const margin = total > 0 ? Math.abs(aEff - dEff) / total : 0

  const winnerBase = RAID_CONFIG.siegeTickWinnerLossPct ?? 0.03
  const loserBase = RAID_CONFIG.siegeTickLoserLossPct ?? 0.08
  const winnerFrac = winnerBase * (1 - 0.5 * margin)
  const loserFrac = loserBase * (1 + 0.5 * margin)
  const attackerLosses = levyLosses(attacker, attackerWins ? winnerFrac : loserFrac)
  const defenderLosses = levyLosses(defender, attackerWins ? loserFrac : winnerFrac)

  return {
    attackerWins,
    margin,
    aEff: Math.round(aEff),
    dEff: Math.round(dEff),
    attackerLosses,
    defenderLosses,
    now,
  }
}

// ── War resolution ─────────────────────────────────────────────────────────

/**
 * Resolves ONE round of a war from pre-built snapshots. Wars are the heavy
 * conflict layer: fought over several rounds (first to WAR_CONFIG.roundsToWin
 * takes the war), each round bleeding troops far harder than a whole raid, and
 * with the losing side liable to lose a named officer. Pure and seeded exactly
 * like resolveRaid; the plugin tallies rounds and applies the deltas.
 *
 * Model per round:
 *   - Each side rolls effective power within +/- variancePct of its army power.
 *   - The higher roll wins the round; a tie goes to the attacker (they pressed).
 *   - Both sides lose rank-and-file levies; the round loser bleeds far more, and
 *     a decisive margin spares the winner while punishing the loser further.
 *   - The round loser MAY lose their lowest officer (a coin flip). This is
 *     returned as a boolean, not applied here: the plugin holds the record and
 *     calls removeLowestOfficer, mirroring how resolveRaid returns damaged.type.
 *
 * No loot, shields, building damage or vassalage here: the war ENDS those, once,
 * via resolveWarSpoils and the plugin, not per round.
 */
export function resolveWarRound(attacker, defender, rng = Math.random, now = Date.now()) {
  const variance = WAR_CONFIG.variancePct ?? 0.2
  const aRoll = 1 + (rng() * 2 - 1) * variance
  const dRoll = 1 + (rng() * 2 - 1) * variance
  const aEff = Math.max(0, (attacker?.power ?? 0) * aRoll)
  const dEff = Math.max(0, (defender?.power ?? 0) * dRoll)
  const attackerWins = aEff >= dEff

  const total = aEff + dEff
  const margin = total > 0 ? Math.abs(aEff - dEff) / total : 0

  const winnerBase = WAR_CONFIG.roundWinnerLossPct ?? 0.08
  const loserBase = WAR_CONFIG.roundLoserLossPct ?? 0.25
  const winnerFrac = winnerBase * (1 - 0.5 * margin)
  const loserFrac = loserBase * (1 + 0.5 * margin)
  const attackerLosses = levyLosses(attacker, attackerWins ? winnerFrac : loserFrac)
  const defenderLosses = levyLosses(defender, attackerWins ? loserFrac : winnerFrac)

  // The round loser may forfeit their lowest officer. One shared roll decides
  // it; since only the loser is ever eligible, sharing is exact, not a shortcut.
  const chance = WAR_CONFIG.officerLossChance ?? 0.5
  const officerRoll = rng()
  const attackerOfficerLost = !attackerWins && officerRoll < chance && (attacker?.officerCount ?? 0) > 0
  const defenderOfficerLost = attackerWins && officerRoll < chance && (defender?.officerCount ?? 0) > 0

  return {
    attackerWins,
    margin,
    aEff: Math.round(aEff),
    dEff: Math.round(dEff),
    attackerLosses,
    defenderLosses,
    attackerOfficerLost,
    defenderOfficerLost,
    now,
  }
}

/**
 * Spoils extracted at war's END, computed once from the final snapshots. The
 * victor takes a capped fraction of the loser's treasury as tribute and razes
 * one of the loser's producing buildings (permanent, not merely damaged: wars
 * are meant to be devastating). Pure; the plugin transfers the tribute, removes
 * the building, sets the shields and the vassalage. Never mutates a snapshot.
 */
export function resolveWarSpoils(victor, loser, rng = Math.random) {
  const pct = WAR_CONFIG.tributePct ?? 0.3
  const cap = WAR_CONFIG.tributeHardCap ?? Infinity
  let tribute = Math.floor(Math.min((loser?.treasury ?? 0) * pct, cap))
  tribute = Math.max(0, Math.min(tribute, loser?.treasury ?? 0))
  let razed = null
  const types = loser?.producingTypes ?? []
  if (types.length > 0) {
    razed = types[Math.min(types.length - 1, Math.floor(rng() * types.length))]
  }
  return { tribute, razed }
}

// ── Scouting ─────────────────────────────────────────────────────────────────

/**
 * Adds proportional noise to a figure so repeated scouts of the same target
 * land in different-but-close buckets, defeating perfect cherry-picking.
 */
function noised(value, rng, spread = 0.22) {
  const f = 1 + (rng() * 2 - 1) * spread
  return Math.max(0, (value ?? 0) * f)
}

function bandFor(value, table) {
  for (const [ceil, label] of table) if (value < ceil) return label
  return table[table.length - 1][1]
}

const ARMY_BANDS = [
  [20, 'little more than a town militia'],
  [100, 'a small warband'],
  [400, 'a standing company'],
  [1200, 'a seasoned army'],
  [Infinity, 'a fearsome host'],
]
const TREASURY_BANDS = [
  [2000, 'nearly empty coffers'],
  [15000, 'modest coffers'],
  [60000, 'a healthy treasury'],
  [200000, 'a rich treasury'],
  [Infinity, 'a vast fortune'],
]
const HEADCOUNT_BANDS = [
  [10, 'a skeleton guard'],
  [50, 'a couple dozen troops'],
  [150, 'a few score troops'],
  [500, 'several hundred troops'],
  [Infinity, 'a teeming barracks'],
]

/** All band labels a scout can return, exposed so the harness can assert coverage. */
export const SCOUT_BAND_LABELS = {
  army: ARMY_BANDS.map(b => b[1]),
  treasury: TREASURY_BANDS.map(b => b[1]),
  headcount: HEADCOUNT_BANDS.map(b => b[1]),
}

/**
 * Bucketed, noised intel on a target. Never reveals exact figures: army,
 * treasury and headcount come back as fuzzy bands, plus hard status flags a
 * raider genuinely needs (shielded / deployed / weight-legal for this attacker).
 */
export function scoutReport(attacker, defender, rng = Math.random, now = Date.now()) {
  return {
    name: defender?.name ?? 'an empire',
    tierRank: defender?.tierRank ?? 0,
    armyBand: bandFor(noised(defender?.power, rng), ARMY_BANDS),
    treasuryBand: bandFor(noised(defender?.treasury, rng), TREASURY_BANDS),
    headcountBand: bandFor(noised(defender?.headcount, rng), HEADCOUNT_BANDS),
    shielded: (defender?.shieldUntil ?? 0) > now,
    deployed: (defender?.deployedUntil ?? 0) > now,
    weightLegal: weightMatchOk(attacker, defender),
  }
}
