/**
 * combat-engine.js — pure combat formulas, no I/O, no DB access.
 *
 * Primary-stat map (from design decisions):
 *   PHY/STR: warrior, samurai, knight, berserker
 *   PHY/AGI: rogue, duelist, assassin
 *   MAG/INT: mage, cleric
 */

const PRIMARY_STAT = {
  warrior:   'str',
  samurai:   'str',
  knight:    'str',
  berserker: 'str',
  rogue:     'agi',
  duelist:   'agi',
  assassin:  'agi',
  mage:      'int',
  cleric:    'int',
}

/** Returns the combat-primary stat value for a player. */
export function getPrimaryStat(player) {
  const key = PRIMARY_STAT[player.classId] ?? 'str'
  return getEffectiveStat(player, key)
}

import { regulateMonsterXp, expectedLevelAtFloor } from './xp-regulator.js'
import { getTotalStats, locations } from './game-data.js'
import { getEffectiveStat, hasEffect, consumeWarcry } from './effects.js'
import { getRankForLevel } from './rank-engine.js'
import { ensureStatPoints, grantLevelStatPoints } from './stat-progression.js'
import { statPackBonus } from './stat-packs.js'
import {
  playerLevelCap,
  rebornStatBonus,
  rebornWeaponMultiplier,
} from './reborn-engine.js'

/**
 * Regular encounters are balanced against the player the floor expects, not
 * against the raw numbers in monsters.json.
 *
 * WHY THIS WAS REWRITTEN. The previous version tuned every monster to a
 * synthetic naked character, `weakestPlayerHp = 80 + (level - 1) * 10`, and
 * asked it to survive a fixed ten hits. Two things followed from that, and both
 * were measured before this change (scripts/check-monster-power.mjs):
 *
 *   1. Depth could not create danger. Gambit's Dungeon went from 19 monster
 *      hits to kill on floor 1 to 13 on floor 89. A whole climb, and the fight
 *      never changed.
 *   2. Equipment bought immunity. The same floor 89 monster needed 40 hits to
 *      kill a best in slot player, and the Entry Tower's needed 250. A geared
 *      player could not lose to a regular monster at any depth, which is why the
 *      climb was a formality and one big ultimate was the whole strategy.
 *
 * The fight is now pinned to the two numbers that actually describe it, and
 * both move with depth:
 *
 *   survival turns  monster attacks the reference player can absorb, and this
 *                   FALLS as you descend, so deeper genuinely means deadlier
 *   clear turns     player attacks one monster costs, held low and near flat so
 *                   a floor can hold several monsters without becoming a chore
 *
 * The reference player is equipped, because a dungeon that only threatens naked
 * characters threatens nobody. A player with no gear is meant to struggle here.
 */
const REGULAR_MONSTER_BALANCE = {
  // Monster attacks the reference player survives, floor 1 to the last floor.
  survivalTurnsShallow: 9,
  survivalTurnsDeep: 3.5,
  // Player attacks one monster costs. Rises slightly with depth so deep
  // monsters have presence, but stays small: this number multiplies by pack
  // size, and the old 14 to 37 was already tedious against a single monster.
  clearTurnsShallow: 4,
  clearTurnsDeep: 6,
  // The reference player is a naked character of the expected level PLUS the
  // gear a player at that stage plausibly owns. It has to be additive, not a
  // multiplier, because equipment in this game does not scale with level at all:
  // measured best in slot is a flat +600 maxHp, +240 str, +220 def whether you
  // are level 1 or level 100 (nothing worth wearing has a real levelRequirement).
  // That flat bonus is +53% HP at level 100 and +400% at level 1, which is the
  // whole reason the Entry Tower needed 250 hits to kill a geared newcomer while
  // These are three fifths of best in slot, not all of it. Measured, the item
  // table has no middle: the median item in a slot is worth about +50 maxHp and
  // the best is worth +600, and nothing gates the best behind a level. So no
  // single reference can suit both ends, and this one deliberately favours the
  // equipped player, because an equipped player strolling through the climb
  // untouched is the thing being fixed. A player carrying median items is under
  // geared for depth and is meant to feel it.
  gearHpAllowance: 360,
  gearDamageAllowance: 144,
  gearDefAllowance: 132,
  // ...and it is only fully owned once the player has had time to earn it. A
  // level 1 character in the Entry Tower is genuinely naked and is tuned as such.
  gearMaturityLevel: 40,
  // Elites are the spike in the pool, not a 15% reskin.
  eliteAttackMultiplier: 1.15,
  eliteHpMultiplier: 1.6,
  // How far a monster's own data may pull it from the target, as an archetype.
  archetypeSpread: 0.25,
  // Raw DEF is kept for flavour and for everything that reads or bypasses it,
  // but bounded: at the 97% ceiling in applyDefense a monster's balanced HP
  // would collapse to a two digit number and the encounter line would look
  // broken. 0.6 is a heavy but readable armour.
  maxMitigation: 0.6,
}

// Median raw hp/atk across all 921 regular monsters is about 3.9 to 1, so this
// is the divisor that puts an average monster's archetype bias at 0.5.
const BULK_PER_ATTACK = 4
// The measured bias band is narrow. Across the whole roster raw hp/atk spans
// about 3.1 to 5.1, and inside one location's pool on one floor it is tighter
// still, so at a small amplification every monster collapses to average: the
// Centurion's floor 60 pool came out 863 to 962 HP, which no player could tell
// apart. Amplified hard on purpose, and `shape` is clamped to [-1, 1] below, so
// the extremes saturate at archetypeSpread instead of running away.
const BIAS_AMPLIFY = 16

// Name keyword archetype. A monster's name is the only thing a player reads
// before deciding how to fight it, so the name has to agree with the numbers.
// Left to the authored data alone it did not: the Centurion's floor 60 pool put
// "Armoured Juggernaut" at the lowest HP and highest attack in the whole pool,
// and made "Relentless Bulwark" the wall it sounds like only by luck, because
// the roster's names were generated from per location word pools and never
// correlated with its stat shape. The name decides the direction here and the
// data still decides how far, so two walls are not identical walls.
const WALL_WORDS = new Set([
  'sentinel', 'bastion', 'shield', 'warden', 'colossus', 'praetor', 'phalanx',
  'vanguard', 'ironclad', 'reinforced', 'tempered', 'bulwark', 'rampart',
  'juggernaut', 'armoured', 'armored', 'gargoyle', 'scaled', 'bloated', 'bound',
  'unbound', 'still', 'paragon', 'legion', 'veteran', 'heavy', 'guardian',
  'golem', 'stone', 'obsidian', 'anchor', 'monolith', 'titan',
])
const HITTER_WORDS = new Set([
  'specter', 'spectre', 'phantom', 'wraith', 'shade', 'echo', 'drifter',
  'drifting', 'elusive', 'swift', 'lancer', 'gladiator', 'cunning', 'jester',
  'trickster', 'decoy', 'illusion', 'doppel', 'unseen', 'veiled', 'silent',
  'creeper', 'bat', 'fang', 'blade', 'claw', 'deceptive', 'bluff', 'lure',
  'uncanny', 'mirror', 'marionette', 'fading', 'faded', 'wail', 'scourge',
  'harbinger', 'dread', 'flux', 'reaper', 'stalker',
])

/**
 * Which way a monster's name pulls it, or null when the name says nothing and
 * the authored numbers should decide. Returns -1 for a wall, +1 for a hitter.
 */
function archetypeFromName(name) {
  let wall = 0
  let hitter = 0
  for (const w of String(name ?? '').toLowerCase().split(/[^a-z]+/)) {
    if (!w) continue
    if (WALL_WORDS.has(w))   wall   += 1
    if (HITTER_WORDS.has(w)) hitter += 1
  }
  if (wall === hitter) return null
  return wall > hitter ? -1 : 1
}

const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t))

/** floors per dungeon, read once, so depth is a ratio and not a magic number. */
const locationFloors = Object.fromEntries(locations.map((l) => [l.id, l.floors ?? 1]))

/**
 * The player a floor is tuned against: the expected level's naked growth curve
 * plus the share of a gear set someone at that level has plausibly earned.
 * Read through getTotalStats so it can never drift from data/levels.json.
 * warrior and human is the yardstick on purpose, a strength primary with no
 * racial modifiers is the neutral middle of the roster.
 */
function referencePlayer(expectedLevel) {
  const B = REGULAR_MONSTER_BALANCE
  const naked = getTotalStats('warrior', 'human', expectedLevel)
  const owned = Math.max(0, Math.min(1, expectedLevel / B.gearMaturityLevel))
  return {
    hp:  naked.maxHp + B.gearHpAllowance     * owned,
    dmg: naked.str   + B.gearDamageAllowance * owned,
    def: naked.def   + B.gearDefAllowance    * owned,
  }
}

// Locations that should never feel "shallow" regardless of the actual
// floor number. caged_dimension has 9999 floors (an arbitrary endless
// ceiling — the real number no player will ever reach) but its depth
// formula would otherwise start near zero at floor 1, making the first
// few hundred floors easy rather than immediately brutal. Pinning its
// minimum depth to 0.7 means floor 1 feels like the deep end of
// eternal_dungeon, and it gets progressively harder from there.
const LOCATION_MIN_DEPTH = {
  caged_dimension: 0.7,
}

/** How far into its dungeon a floor sits, 0 on floor 1 and 1 on the last floor. */
function depthRatio(locationId, floor) {
  const total = locationFloors[locationId] ?? 100
  const raw = total <= 1 ? 1 : (floor - 1) / (total - 1)
  const minDepth = LOCATION_MIN_DEPTH[locationId] ?? 0
  return Math.max(minDepth, Math.min(1, raw))
}

function balanceRegularMonsterStats(def, floor, rawHp, rawAtk, rawDef) {
  const B = REGULAR_MONSTER_BALANCE
  const expectedLevel = expectedLevelAtFloor(def.locationId, floor)
  const depth = depthRatio(def.locationId, floor)
  const ref = referencePlayer(expectedLevel)
  const isElite = def.tier === 'elite'

  // Archetype. A monster's own numbers no longer set its power, they set its
  // shape: the ratio of its raw attack to its raw bulk says whether it is a
  // hitter or a wall, and that is preserved while total power is pinned to the
  // target. Reference free on purpose. The old atk / 350 comparison broke the
  // moment the floor axis was rescaled from 1000 floors to 100, because 350
  // meant "a thousand floor monster" and every monster then pinned to the cap.
  const bias  = rawAtk / Math.max(1, rawAtk + rawHp / BULK_PER_ATTACK)
  const dataShape = Math.max(-1, Math.min(1, (bias - 0.5) * BIAS_AMPLIFY))
  const named = archetypeFromName(def.name)
  // A named archetype keeps at least 40% of the spread so it always reads as
  // what it is called, and takes the rest of its distance from its own numbers.
  const shape = named === null
    ? dataShape
    : named * Math.max(0.4, Math.abs(dataShape))
  const atkMult = 1 + shape * B.archetypeSpread
  const hpMult  = 1 - shape * B.archetypeSpread

  // DEF stays the roster's own, bounded so a deep monster cannot sit against
  // applyDefense's 97% ceiling. Everything that reads or bypasses DEF still
  // sees a real number, it just can no longer erase the fight.
  const defCap = Math.round(500 * B.maxMitigation / (1 - B.maxMitigation))
  const monsterDef = Math.max(0, Math.min(rawDef, defCap))

  // ATK: solve for the raw value that LANDS ref.hp / survivalTurns after the
  // reference player's own mitigation, so the survival target is a true count
  // of hits taken rather than a pre mitigation guess.
  const survival = lerp(B.survivalTurnsShallow, B.survivalTurnsDeep, depth)
  const playerMitigation = ref.def / (ref.def + 500)
  const balancedAtk = Math.max(1, Math.round(
    (ref.hp / survival) / Math.max(0.05, 1 - playerMitigation) *
    atkMult * (isElite ? B.eliteAttackMultiplier : 1),
  ))

  // HP: pinned to the damage the reference player actually lands, so the pace
  // of a floor is guaranteed and an armoured monster reads as armoured instead
  // of turning into a slog.
  const clear = lerp(B.clearTurnsShallow, B.clearTurnsDeep, depth)
  const landedPerHit = applyDefense(Math.round(ref.dmg), monsterDef)
  const balancedHp = Math.max(1, Math.round(
    landedPerHit * clear * hpMult * (isElite ? B.eliteHpMultiplier : 1),
  ))

  return { hp: balancedHp, atk: balancedAtk, def: monsterDef }
}

/**
 * Compute monster stats at a given floor.
 * Bosses are authored by hand and pass through untouched. Regular monsters and
 * elites are normalised by balanceRegularMonsterStats above, which uses their
 * raw curve for archetype and depth only.
 */
export function monsterStatsAtFloor(def, floor) {
  const { baseStats: b, scaling: s } = def
  const rawHp  = Math.round(b.hp  + s.hpPerFloor  * floor)
  const rawDef = Math.round(b.def + s.defPerFloor * floor)
  const rawAtk = Math.round(b.atk + s.atkPerFloor * floor)
  if (def.tier === 'boss') {
    return { hp: rawHp, maxHp: rawHp, def: rawDef, atk: rawAtk }
  }
  const balanced = balanceRegularMonsterStats(def, floor, rawHp, rawAtk, rawDef)
  return { hp: balanced.hp, maxHp: balanced.hp, def: balanced.def, atk: balanced.atk }
}

/**
 * Pick a random monster for `locationId` at `floor`.
 * Elites spawn at 15% chance when available.
 * Returns a full instantiated monster ready for battle, or null.
 *
 * XP/solars come from the centralized xp-regulator, NOT from this
 * monster's own rewards.xpBase/xpPerFloor (data/monsters.json values are
 * ignored for reward purposes — kept only for legacy/reference).
 */
export function pickMonsterForFloor(locationId, floor, regularByLoc) {
  const pool = (regularByLoc[locationId] ?? []).filter(
    m => floor >= m.floorRange[0] && floor <= m.floorRange[1]
  )
  if (!pool.length) return null

  const regulars = pool.filter(m => m.tier === 'regular')
  const elites   = pool.filter(m => m.tier === 'elite')
  let chosen
  let isElite = false
  if (elites.length && Math.random() < 0.15) {
    chosen = elites[Math.floor(Math.random() * elites.length)]
    isElite = true
  } else {
    chosen = regulars[Math.floor(Math.random() * regulars.length)] ?? pool[0]
  }

  const stats = monsterStatsAtFloor(chosen, floor)
  const { xp, solars } = regulateMonsterXp(locationId, floor, isElite)
  // Season 1 stone floors are enemy-side typing only. The player does not
  // gain a new stat; Willow's existing readout consumes this type normally.
  const stoneFloor = locationId === 'season_01_ruins' &&
    [6, 13, 21, 29, 37, 44].includes(floor)
  return {
    ...chosen,
    ...stats,
    ...(stoneFloor ? {
      type: 'stone',
      weakTo: ['magic'],
      resistTo: ['physical'],
    } : {}),
    xp,
    solars,
    isBoss: false,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Player-power enemy scaling
// ─────────────────────────────────────────────────────────────────────────────
// The floor curve (balanceRegularMonsterStats / BOSS_BALANCE) tunes every enemy
// to the EXPECTED geared player at that floor. A player who has outgrown that
// curve — 1000+ primary stat where the floor expects a couple hundred — one
// shots bosses and strolls through swarms, which is exactly the "bosses die in
// 3 hits, monsters weak asf" complaint from the strongest accounts. This scales
// an enemy up by how far the ACTUAL player outpaces the expected player at that
// floor, and does NOTHING to an on curve or weak player (ratio floored at 1).
// Because the player's own damage scales with primary stat, matching enemy HP
// to that ratio keeps "hits to kill" roughly constant across the whole power
// band instead of collapsing at the top: a fair fight for a fresh climber and a
// whale alike, with no flat buff that would wall a newcomer.

// ratio = actual primary stat / the expected geared player's offence at this
// floor. referencePlayer().dmg is the denominator so it self calibrates per
// floor and per dungeon, with no magic per floor constant to keep in sync.
export function enemyPowerRatio(player, locationId, floor) {
  const stat = getPrimaryStat(player) || 0
  const expectedLevel = expectedLevelAtFloor(locationId, floor)
  const expected = referencePlayer(expectedLevel).dmg || 1
  return Math.max(1, stat / expected)
}

// Scale one enemy's combat stats in place. Exponents < 1 give diminishing
// returns so a 12x-power whale faces a hard fight, not a 12x brick wall. HP is
// the primary fight-length lever (it keeps the hit count honest without
// touching the damage math); ATK climbs gently so incoming stings without a
// one-shot; DEF climbs the LEAST and is hard-capped, because applyDefense's
// curve means a high DEF collapses player damage to nothing and turns the fight
// into a slog — the boss should read as armored, not invincible. atkCap bounds
// the incoming hit and defCap bounds mitigation (DEF 2000 ~= 80% cut) so even
// the widest power gap stays survivable and never walls the player out.
export function scaleEnemyToPlayer(
  enemy,
  ratio,
  { hpExp = 0.85, atkExp = 0.5, defExp = 0.3, atkCap = Infinity, defCap = Infinity } = {},
) {
  if (!enemy || !(ratio > 1)) return enemy
  const hpMul  = Math.pow(ratio, hpExp)
  const atkMul = Math.pow(ratio, atkExp)
  const defMul = Math.pow(ratio, defExp)
  if (enemy.maxHp   != null) enemy.maxHp   = Math.max(1, Math.round(enemy.maxHp * hpMul))
  if (enemy.hp      != null) enemy.hp      = Math.max(1, Math.round(enemy.hp * hpMul))
  if (enemy.atk     != null) enemy.atk     = Math.min(atkCap, Math.max(1, Math.round(enemy.atk * atkMul)))
  if (enemy.baseAtk != null) enemy.baseAtk = Math.min(atkCap, Math.max(1, Math.round(enemy.baseAtk * atkMul)))
  if (enemy.def     != null) enemy.def     = Math.min(defCap, Math.max(0, Math.round(enemy.def * defMul)))
  if (enemy.baseDef != null) enemy.baseDef = Math.min(defCap, Math.max(0, Math.round(enemy.baseDef * defMul)))
  return enemy
}

// A deterministic estimate of what `player` LANDS with one strong skill hit on
// an enemy whose defense is `enemyDef`, crit chance folded in. It deliberately
// leaves out transient boosts (warcry, pack rage, reborn-weapon multipliers,
// buff effects), which only make the real fight END SOONER — so this reads a
// little low, biasing any HP target it feeds toward slightly-easier and never a
// slog. skillMult 3.0 mirrors the roster's strongest routines (top skills cap
// ~3.3x); dmgMult 1.3 is the common skill-path multiplier. Used to size a boss
// to a hit count instead of a blind exponent.
export function estimatePlayerHit(player, enemyDef = 0, skillMult = 3.0, dmgMult = 1.3) {
  const primary    = getPrimaryStat(player) || 1
  const lck        = getEffectiveStat(player, 'lck') || 0
  const critChance = Math.min(0.95, 0.05 + lck * 0.002)
  const critFactor = 1 + critChance * 0.5          // a crit is x1.5, so +0.5 on crit
  const raw        = primary * skillMult * dmgMult * critFactor
  return applyDefense(Math.round(raw), enemyDef)
}

// Size a solo boss to the ACTUAL player in front of it, not a blind exponent.
// The floor-100 masters span 18k HP (Syclila) to 55k HP (Esteria): a flat HP
// multiplier either leaves the weak ones a 3-hit blitz or turns the strong ones
// into a hundred-hit slog. Instead we aim for a HIT COUNT. If the boss already
// survives at least `target` of THIS player's strong hits, it is left exactly as
// authored — an on-curve climber, or a whale meeting a boss that is genuinely
// their equal, sees no change and no nerf. Only a boss the player would burst in
// fewer than `target` hits is raised (HP only ever goes up), with a modest capped
// armor bump so it reads as the wall the strongest accounts asked for and a
// gentle capped attack bump so it hits like one. The target itself creeps up
// with the power gap (ratio), so the further a player has outgrown the floor the
// harder the wall, bounded by `maxHits` so it can never become a war of attrition.
export function scaleBossToPlayer(enemy, player, ratio, {
  baseHits = 12, hitsRatioExp = 0.16, maxHits = 20,
  defExp = 0.14, defMitigationCap = 0.85,
  atkExp = 0.25, atkCapMult = 2,
} = {}) {
  if (!enemy || !player || !(ratio > 1)) return enemy

  const target   = Math.max(baseHits, Math.min(maxHits, Math.round(baseHits * Math.pow(ratio, hitsRatioExp))))
  const baseDef  = enemy.def ?? 0
  const landed0  = estimatePlayerHit(player, baseDef)
  const hitsNow  = landed0 > 0 ? (enemy.maxHp ?? enemy.hp ?? 0) / landed0 : Infinity
  // Already a real fight for this player: don't touch it (no HP, DEF or ATK
  // change), so an authored wall like Esteria never turns into a slog.
  if (hitsNow >= target) return enemy

  // Modest, capped armor bump FIRST, so the HP target reflects post-armor
  // landing and the hit count lands on `target` rather than overshooting it.
  const defCap    = Math.round(500 * defMitigationCap / (1 - defMitigationCap))
  const bumpedDef = Math.min(defCap, Math.max(baseDef, Math.round(baseDef * Math.pow(ratio, defExp))))
  if (enemy.def     != null) enemy.def     = bumpedDef
  if (enemy.baseDef != null) enemy.baseDef = bumpedDef

  // HP: raise to exactly `target` of this player's landed hits (never lower).
  const landed   = estimatePlayerHit(player, bumpedDef)
  const targetHp = Math.max(1, landed * target)
  if (targetHp > (enemy.maxHp ?? 0)) { enemy.maxHp = targetHp; enemy.hp = targetHp }
  else if (targetHp > (enemy.hp ?? 0)) { enemy.hp = targetHp }

  // Gentle, capped attack bump so a longer fight also hits harder per turn,
  // bounded at atkCapMult x the curve so it stings without one-shotting a tank.
  const atkMul  = Math.pow(ratio, atkExp)
  const atkCeil = (enemy.atk ?? 0) * atkCapMult
  if (enemy.atk     != null) enemy.atk     = Math.round(Math.min(atkCeil, enemy.atk * atkMul))
  if (enemy.baseAtk != null) enemy.baseAtk = enemy.atk

  return enemy
}

/**
 * Compute raw player damage.
 * Basic attack: primaryStat × 1.0
 * Skill attack:  primaryStat × skill's own multiplier (see below)
 * Returns { rawDmg, isCrit, critMult }
 */
export function calcPlayerDamage(
  player,
  skill = null,
  damageMultiplier = 1,
  critChanceBoost = 0,
  { consumeBuffs = true } = {},
) {
  const base = getPrimaryStat(player)
  // Skill objects from data/skills.json don't carry a top-level
  // `multiplier` — the real number lives at effects[0].multiplier (see
  // that file's attack/heal/shield/regen entries). Reading skill.multiplier
  // directly was always undefined, so every skill silently fell back to the
  // `?? 1.0` default below regardless of tier — a legendary skill with
  // effects[0].multiplier: 3.0 hit exactly as hard as a common one at 0.98.
  // lib/ability-engine.js already worked around this correctly by manually
  // reshaping `{ multiplier: primary.multiplier }` before calling in; this
  // checks both shapes here instead, once, so every caller (skill.js,
  // pvp.js's skill branch, cinderverdict's null-skill basic-attack path,
  // etc.) benefits without needing its own workaround.
  const mult = skill?.multiplier ?? skill?.effects?.[0]?.multiplier ?? 1.0

  // Crit: base 5% + LCK * 0.2%
  const critChance = Math.min(
    0.95,
    0.05 + (player.stats.lck ?? 0) * 0.002 + critChanceBoost,
  )
  const isCrit     = Math.random() < critChance
  const critMult   = isCrit ? 1.5 : 1.0

  // player.stats already includes equipped-item bonuses — equip.js/unequip.js
  // fold statBonuses in/out of player.stats directly on (un)equip.
  //
  // The reborn relic multiplier is folded in HERE rather than in
  // lib/named-passives.js because applyAllNamedPassives() is only invoked from
  // plugins/attack.js and plugins/defend.js. calcPlayerDamage() is the single
  // funnel every outgoing hit passes through — basic attacks, skills,
  // abilities, boss fights, PvP — so the Fists of Glory's +15% and the Blade
  // of the Dragons' +30% apply everywhere from one line.
  //
  // The Warcry Tonic's buff rides in the same way, and for the same reason: it
  // is spent per hit LANDED, and this function only runs after the caller's
  // accuracy roll has already decided the hit connects (see plugins/attack.js's
  // "── HIT ──" branch), so one charge here is exactly one landed hit. Callers
  // that only want to preview damage without burning a charge pass
  // { consumeBuffs: false }.
  const warcryMult = consumeBuffs ? consumeWarcry(player) : 1

  // Red Monster pack — Bloodrage: outgoing damage scales up as the wielder's HP
  // drops, to +maxBonus near death. Mirrors packOutgoingMultiplier() in
  // lib/premium-abilities.js (kept inline here to avoid a combat-engine ->
  // premium-abilities import cycle); the two must stay in sync. Folded into the
  // single outgoing funnel so rage applies in PvE, boss, swarm and PvP alike.
  let packRageMult = 1
  const sig = player.activePackSignature
  if (sig?.type === 'rage' && (player.maxHp ?? 0) > 0) {
    const missing = Math.max(0, Math.min(1, 1 - (player.hp ?? player.maxHp) / player.maxHp))
    packRageMult = 1 + (sig.maxBonus ?? 0.5) * missing
  }

  const rawDmg = Math.floor(
    base * mult * critMult * damageMultiplier * rebornWeaponMultiplier(player) * warcryMult * packRageMult,
  )
  return { rawDmg, isCrit, critMult, warcryMult }
}

/**
 * Apply monster DEF and return final damage.
 * Percentage-based mitigation uses a softer high-defense curve. The old
 * denominator/cap combination made every boss above roughly 1,700 DEF
 * identical. A 500 denominator keeps early defenses readable while the 97%
 * safety cap still prevents an unwinnable zero-damage fight.
 */
export function applyDefense(rawDmg, monsterDef) {
  const safeDef = Math.max(0, Number(monsterDef) || 0)
  const mitigation = safeDef / (safeDef + 500)
  const capped = Math.min(mitigation, 0.97)
  return Math.max(1, Math.floor(rawDmg * (1 - capped)))
}

// Flat evasion baked in per monster tier — none of the monster data carries
// an explicit evasion/agi stat, so tier stands in as a simple proxy: elites
// are that much harder to land a hit on, bosses are deliberately easier to
// hit (they're meant to be damage checks, not accuracy checks).
const EVASION_BY_TIER = { regular: 0.05, elite: 0.10 }

function monsterEvasion(enemy) {
  if (enemy?.isBoss) return 0.02
  return EVASION_BY_TIER[enemy?.tier] ?? 0.05
}

/**
 * Chance (0–1) that the player's attack lands on `enemy`.
 * base 90% + AGI * 0.15%, minus the enemy's evasion, clamped to [60%, 99%]
 * so nobody is ever a guaranteed hit or a guaranteed miss.
 */
export function calcPlayerHitChance(player, enemy) {
  const agi  = player?.stats?.agi ?? 0
  const base = 0.90 + agi * 0.0015
  const blindPenalty = hasEffect(player, 'blind') ? 0.30 : 0
  return Math.min(0.99, Math.max(0.60, base - monsterEvasion(enemy) - blindPenalty))
}

/**
 * Second Transcendance (The Transcendent) — one INDEPENDENT extra attack.
 *
 * Rolls its own accuracy + damage exactly like a fresh basic hit, at the SAME
 * power as the primary (multiplier 1.0), and returns the PRE-defense result
 * for the CALLER to finish: apply the enemy's effective DEF, run any boss
 * ENEMY_TAKE_DAMAGE hook, then subtract from enemy.hp. The caller owns those
 * steps so the echo is mitigated / nullified by the same rules its site
 * already applies to the primary hit (Alya's DEF-break, Gojo/Kaido/Mahoraga).
 *
 * Deliberately damage-ONLY: no MP, no durability tick, no named-passive
 * pipeline, no re-applied skill status effects — it is the character's innate
 * second swing, not a second full move, so it can't double-stack side effects.
 * It also never touches bs.turn and never triggers a second enemy retaliation,
 * which is what keeps every turn-counter-keyed mechanic (Alya's every-3rd-turn,
 * Dance of the Rain at turn 10, boss phases, cooldowns, durability) in lockstep.
 *
 * Pass `skill` on a skill hit so the echo scales off that skill; null for a
 * basic attack. Returns null if the enemy is already down, { missed:true } on
 * a whiff, or { missed:false, rawDmg, isCrit } on a landed swing.
 */
export function rollEchoStrike(player, enemy, skill = null) {
  if (!enemy || enemy.hp <= 0) return null
  if (Math.random() > calcPlayerHitChance(player, enemy)) {
    return { missed: true, rawDmg: 0, isCrit: false }
  }
  const { rawDmg, isCrit } = calcPlayerDamage(player, skill, 1.0)
  return { missed: false, rawDmg, isCrit }
}

/**
 * Chance (0–1) that a monster's attack lands on the player.
 * base 92%, reduced by the player's AGI-based dodge (capped at 30%),
 * clamped to [55%, 99%]. If the monster is blinded, its own accuracy
 * is further cut by 30 percentage points.
 */
export function calcMonsterHitChance(enemy, player) {
  const agi   = player?.stats?.agi ?? 0
  const dodge = Math.min(0.30, agi * 0.001)
  const blindPenalty = hasEffect(enemy, 'blind') ? 0.30 : 0
  return Math.min(0.99, Math.max(0.55, 0.92 - dodge - blindPenalty))
}

/**
 * Compute monster attack damage against the player.
 * Percentage-based mitigation, mirroring applyDefense: mitigation =
 * effectiveDef / (effectiveDef + 500), capped at 97%. defending=true doubles
 * DEF effectiveness. This keeps huge-ATK bosses (scaled for high floors)
 * from one-shotting the player every turn, the same failure mode
 * applyDefense fixes in the player->monster direction.
 */
export function calcMonsterDamage(monsterAtk, playerDef, defending = false) {
  const variance = 0.80 + Math.random() * 0.40   // 0.80–1.20
  const defMult  = defending ? 2.0 : 1.0
  const effectiveDef = playerDef * defMult
  const mitigation = effectiveDef / (effectiveDef + 500)
  const capped = Math.min(mitigation, 0.97)
  return Math.max(1, Math.floor(monsterAtk * variance * (1 - capped)))
}

/**
 * Roll for item drops from a monster's drops array.
 * Returns array of itemIds that dropped.
 */
export function rollDrops(drops = []) {
  return drops.filter(d => Math.random() < d.chance).map(d => d.itemId)
}

/**
 * Check and reset daily stamina if past midnight.
 * Returns fresh stamina object.
 */
export function refreshStamina(stamina) {
  const now = Date.now()
  if (!stamina || now >= (stamina.resetAt ?? 0)) {
    const tom = new Date(); tom.setHours(24, 0, 0, 0)
    return { current: stamina?.max ?? 30, max: stamina?.max ?? 30, resetAt: tom.getTime() }
  }
  return stamina
}

/**
 * Check if a player should level up, apply it, and return the new player.
 * Mutates the player object in place and returns it.
 * Also returns an array of level-up messages.
 */
export function applyLevelUps(player, levelsData, classes, races, getTotalStats) {
  const msgs = []
  // Per-player ceiling: 100 normally, 200 once the player has been reborn
  // (see plugins/reborn.js and lib/reborn-engine.js). data/levels.json's
  // xpTable runs all the way to 200, so nothing else here needs to change.
  const cap  = playerLevelCap(player)
  let levelled = false
  const rankBefore = getRankForLevel(player.level)
  ensureStatPoints(player)
  // The reborn reward (+100 every stat, +300 max HP) is not derivable from
  // class/race/level, so it has to be re-added every time baseStats is
  // rebuilt from getTotalStats() below. Without this it would silently
  // evaporate on the reborn player's very next level up.
  const rb = rebornStatBonus(player)
  // Same story for Stat Pack Boosts bought in the Game Shop (lib/stat-packs.js):
  // a flat per-stat bonus with no formula behind it, so it has to be re-added
  // to the rebuilt baseStats below too.
  const sp = statPackBonus(player)

  while (player.level < cap) {
    const next   = player.level + 1
    const needed = levelsData.xpTable[String(next)]
    if (needed == null || player.xp < needed) break

    // Compute stat delta
    const oldStats = getTotalStats(player.classId, player.raceId, player.level)
    const newStats = getTotalStats(player.classId, player.raceId, next)
    for (const k of ['str', 'agi', 'int', 'def', 'lck']) {
      player.stats[k] = (player.stats[k] ?? 0) + (newStats[k] - oldStats[k])
    }
    player.maxHp += newStats.maxHp - oldStats.maxHp
    player.maxMp += newStats.maxMp - oldStats.maxMp
    player.hp = player.maxHp   // full heal on level up
    player.mp = player.maxMp

    // ── Stat pin: keep baseStats in sync with the new level's base values
    // (class + race + level growth, NO equipment). This is the anchor that
    // handleDeath snaps stats back to after stripping gear, preventing the
    // doubling bug from ever accumulating again.
    player.baseStats = {
      str:   newStats.str + (player.statPoints.allocations.str ?? 0) + rb.stat + sp.str,
      agi:   newStats.agi + (player.statPoints.allocations.agi ?? 0) + rb.stat + sp.agi,
      int:   newStats.int + (player.statPoints.allocations.int ?? 0) + rb.stat + sp.int,
      def:   newStats.def + (player.statPoints.allocations.def ?? 0) + rb.stat + sp.def,
      lck:   newStats.lck + (player.statPoints.allocations.lck ?? 0) + rb.stat + sp.lck,
      maxHp: newStats.maxHp + rb.maxHp,
      maxMp: newStats.maxMp,
    }

    player.level = next
    const granted = grantLevelStatPoints(player, next - 1, next)
    levelled = true
    msgs.push(
      `🎉 *LEVEL UP!* ${player.name} is now *Level ${next}*!\n` +
      `✨ +${granted} stat points available (${player.statPoints.unallocated} unallocated)\n` +
      `❤️ HP: ${player.maxHp}  💧 MP: ${player.maxMp}\n` +
      `💪 STR ${player.stats.str}  🏃 AGI ${player.stats.agi}  🧠 INT ${player.stats.int}  🛡️ DEF ${player.stats.def}`
    )
  }
  const rankAfter  = getRankForLevel(player.level)
  const rankChange = levelled && rankAfter.title !== rankBefore.title
    ? { from: rankBefore, to: rankAfter }
    : null
  return { player, msgs, levelled, rankChange }
}

/**
 * Get the skill object from skills array by name or id (case-insensitive).
 * Returns null if not found or player doesn't own it.
 */
export function findSkill(skillId_or_name, playerSkillIds, allSkills) {
  const query = skillId_or_name.toLowerCase().replace(/\s+/g, '_')
  const skill = allSkills.find(s =>
    (s.id.toLowerCase() === query || s.name.toLowerCase().replace(/\s+/g, '_') === query) &&
    playerSkillIds.includes(s.id)
  )
  return skill ?? null
}

/**
 * Get skills unlocked at the player's current level for their class.
 * Returns newly unlocked skills not yet in player.skills.
 */
export function getNewlyUnlockedSkills(player, allSkills) {
  return allSkills.filter(s =>
    s.classId === player.classId &&
    s.unlockLevel <= player.level &&
    !player.skills.includes(s.id)
  )
}

/** HP bar display */
export function hpBar(current, max, length = 10) {
  const filled = Math.max(0, Math.round((current / max) * length))
  return `[${'█'.repeat(filled)}${'░'.repeat(length - filled)}] ${current}/${max}`
}

/**
 * Generic 0–1 progress bar, same visual style as hpBar but without the
 * "current/max" suffix baked in (callers append their own label — e.g. an
 * XP count — since not every bar is a "current out of max" quantity in the
 * same units). Used by .rank's XP-to-next-level bar; reusable anywhere else
 * a bot-wide-consistent progress bar is needed.
 */
export function progressBar(pct, length = 10) {
  const clamped = Math.max(0, Math.min(1, pct))
  const filled  = Math.round(clamped * length)
  return `[${'█'.repeat(filled)}${'░'.repeat(length - filled)}]`
}

/**
 * Convert a skill's secondary-effect spec (from skills.json) into the
 * effectDef shape expected by lib/effects.js `addStatusEffect()`.
 * `target` supplies current stat/HP values used to compute magnitude.
 *
 * `bleed` and `slow` have no dedicated handler in effects.js — they are
 * mapped onto the closest existing mechanic (burn / weaken-agi respectively).
 * Returns null for unknown/unsupported effect types.
 */
export function buildEffectDef(effectSpec, target, sourceId) {
  if (!effectSpec?.type) return null
  const duration = effectSpec.turns ?? 2
  const maxHp    = target.maxHp ?? target.hp ?? 0

  switch (effectSpec.type) {
    case 'stun':
      return { type: 'stun', duration: effectSpec.turns ?? 1, sourceId }
    case 'freeze':
      return { type: 'freeze', duration: effectSpec.turns ?? 1, sourceId }
    case 'blind':
      return { type: 'blind', duration, sourceId }
    case 'burn':
      return { type: 'burn', duration, amount: Math.max(1, Math.round(maxHp * (effectSpec.dmgPct ?? 0.05))), sourceId }
    case 'poison':
      return { type: 'poison', duration, amount: Math.max(1, Math.round(maxHp * (effectSpec.dmgPct ?? 0.04))), sourceId }
    case 'bleed':
      return { type: 'burn', duration, amount: Math.max(1, Math.round(maxHp * (effectSpec.dmgPct ?? 0.03))), sourceId }
    case 'weaken': {
      const base = target.stats?.[effectSpec.stat] ?? target[effectSpec.stat] ?? 0
      return { type: 'weaken', duration, stat: effectSpec.stat, value: Math.max(1, Math.round(base * (effectSpec.pct ?? 0.15))), sourceId }
    }
    case 'slow': {
      const base = target.stats?.agi ?? target.agi ?? 0
      return { type: 'weaken', duration, stat: 'agi', value: Math.max(1, Math.round(base * 0.15)), sourceId }
    }
    case 'shield': {
      // effectSpec.pct is a fraction of the target's maxHp, e.g. 0.20 = a
      // shield pool worth 20% of max HP. Self-targeted (cast on the caster).
      return { type: 'shield', duration, amount: Math.max(1, Math.round(maxHp * (effectSpec.pct ?? 0.20))), sourceId }
    }
    case 'regen': {
      // effectSpec.pct is a fraction of the target's maxHp healed per tick.
      // Self-targeted (cast on the caster).
      return { type: 'regen', duration, stat: 'hp', amount: Math.max(1, Math.round(maxHp * (effectSpec.pct ?? 0.06))), sourceId }
    }
    default:
      return null
  }
}

/**
 * Apply (sign=+1) or remove (sign=-1) an item's statBonuses to/from a player.
 * Mutates player.stats / player.maxHp / player.maxMp in place, clamping
 * current hp/mp to the new max when a bonus is removed.
 */
export function applyEquipmentBonus(player, item, sign) {
  const b = item.statBonuses ?? {}
  player.stats = player.stats ?? {}

  for (const key of ['str', 'agi', 'int', 'def', 'lck']) {
    if (b[key]) player.stats[key] = Math.max(0, (player.stats[key] ?? 0) + sign * b[key])
  }
  if (b.maxHp) {
    player.maxHp = Math.max(1, (player.maxHp ?? 0) + sign * b.maxHp)
    player.hp    = Math.min(player.hp ?? player.maxHp, player.maxHp)
  }
  if (b.maxMp) {
    player.maxMp = Math.max(0, (player.maxMp ?? 0) + sign * b.maxMp)
    player.mp    = Math.min(player.mp ?? player.maxMp, player.maxMp)
  }
}
