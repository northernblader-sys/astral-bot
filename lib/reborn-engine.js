/**
 * reborn-engine.js — the Reborn ritual: rules, maths and relic effects.
 *
 * Reborn is the endgame ceremony for a Level 100 player. A god releases his
 * Aura, the Aura chips the player's HP, and if the player is still standing
 * 30 seconds later the god acknowledges them: their level ceiling rises from
 * 100 to 150, every stat gains +100, max HP gains +300, and they choose one
 * of three divine relics. If the Aura empties them they are rejected and
 * lose 5 levels.
 *
 * Everything here is pure (no DB, no I/O) so plugins/reborn.js owns all the
 * writes and the combat funnels can call the relic helpers freely.
 *
 * WHY THE TRIAL MATHS IS DETERMINISTIC
 * The Aura deals a fixed 90 HP every 4 seconds for 30 seconds. There is no
 * variance, no DEF mitigation and no crit. That means the outcome is fully
 * decided the instant the player accepts (hpAtStart vs AURA_TOTAL), so the
 * live ticker is a dramatisation of an already-known result. If the process
 * dies mid-trial we can resolve the exact same outcome later from the stored
 * snapshot instead of leaving the player stuck. See resolveTrial().
 */
import { levelsData } from './game-data.js'
import { statPackBonus } from './stat-packs.js'

// ── Aura trial constants ──────────────────────────────────────────────────
/** HP removed per tick. */
export const AURA_CHIP = 90
/** Milliseconds between ticks. */
export const AURA_TICK_MS = 4000
/** How long the player must survive, in milliseconds. */
export const AURA_DURATION_MS = 30000
/** Full ticks that land inside the window: 4s, 8s ... 28s = 7 of them. */
export const AURA_TICKS = Math.floor(AURA_DURATION_MS / AURA_TICK_MS)
/**
 * Total HP the Aura costs across the full 30 seconds. 30s is 7.5 ticks, so
 * the seventh full tick at 28s is followed by a half chip as the window
 * closes: 7 x 90 + 45 = 675.
 */
export const AURA_TOTAL = Math.round((AURA_DURATION_MS / AURA_TICK_MS) * AURA_CHIP)
/** Levels lost when the Aura wins. */
export const REBORN_FAIL_LEVELS = 5
/** Level required to attempt the ritual. */
export const REBORN_REQ_LEVEL = 100
/** Flat bonus applied to every stat on success. */
export const REBORN_STAT_BONUS = 100
/** Flat bonus applied to max HP on success. */
export const REBORN_HP_BONUS = 300
/** How long an unaccepted invitation stays open, in milliseconds. */
export const REBORN_OFFER_TTL_MS = 5 * 60 * 1000

/**
 * auraDamageAt(elapsedMs) — cumulative Aura damage after `elapsedMs`.
 * Chips land at 4s, 8s ... 28s for 90 each, then the closing half chip at
 * 30s brings the total to AURA_TOTAL.
 */
export function auraDamageAt(elapsedMs) {
  const clamped = Math.min(AURA_DURATION_MS, Math.max(0, elapsedMs))
  return Math.round((clamped / AURA_TICK_MS) * AURA_CHIP)
}

// ── Reborn state ──────────────────────────────────────────────────────────
/** True once the player has completed the ritual. */
export function isReborn(player) {
  return player?.reborn?.done === true
}

/** The player's personal level ceiling: 100 normally, 150 once reborn. */
export function playerLevelCap(player) {
  const base = levelsData.levelCap ?? 100
  if (!isReborn(player)) return base
  return Math.max(base, levelsData.rebornLevelCap ?? 150)
}

/** The player's lifetime stat-point ceiling. */
export function playerMaxStatPoints(player) {
  const base = levelsData.maxStatPoints ?? 1500
  if (!isReborn(player)) return base
  return Math.max(base, levelsData.rebornMaxStatPoints ?? 2250)
}

/**
 * rebornStatBonus(player) — the permanent reward, as a delta to re-apply
 * whenever baseStats is rebuilt from canonical class/race/level values.
 *
 * applyLevelUps() and ensureStatPoints() both recompute baseStats from
 * getTotalStats() + allocations. Without this the +100/+300 would silently
 * evaporate the first time a reborn player levelled up, so both call sites
 * add this back in.
 */
export function rebornStatBonus(player) {
  if (!isReborn(player)) return { stat: 0, maxHp: 0 }
  return { stat: REBORN_STAT_BONUS, maxHp: REBORN_HP_BONUS }
}

// ── Relics ────────────────────────────────────────────────────────────────
export const RELIC_ARMOR = 'armor_of_existence'
export const RELIC_FISTS = 'fists_of_glory'
export const RELIC_ROBE  = 'robe_of_the_dragons'
export const RELIC_BLADE = 'blade_of_the_dragons'

/** Every item id the ritual can hand out. */
export const REBORN_RELIC_IDS = [RELIC_ARMOR, RELIC_FISTS, RELIC_ROBE, RELIC_BLADE]

/**
 * The three choices, in menu order. Choice 3 grants two items (the robe and
 * the blade), which is why `items` is an array rather than a single id.
 */
export const REBORN_CHOICES = [
  {
    n: 1,
    name: 'Armor of Existence',
    items: [RELIC_ARMOR],
    image: 'https://i.ibb.co/BV02cp2B/Armor-of-Existence.jpg',
    blurb: 'Armor so absolute that enemy attacks barely register. Incoming damage is cut to a quarter. Never wears out.',
  },
  {
    n: 2,
    name: 'Fists of Glory',
    items: [RELIC_FISTS],
    image: 'https://i.ibb.co/Xf7Qz1hb/Fists-of-Glory.jpg',
    blurb: 'Gauntlets that multiply what you already are. Every strike you land deals 15 percent more of your actual attack damage.',
  },
  {
    n: 3,
    name: 'Robe and Blade of the Dragons',
    items: [RELIC_ROBE, RELIC_BLADE],
    image: 'https://i.ibb.co/CN5MtBL/Robe-and-Blade-of-the-dragons.jpg',
    blurb: 'Both halves. The Robe caps any single hit at 35 percent of your max HP, so one tap skills like Cinder Verdict stop being one taps. The Blade swings 30 percent harder.',
  },
]

/** True if `itemId` is one of the ritual relics. */
export function isRebornRelic(itemId) {
  return REBORN_RELIC_IDS.includes(itemId)
}

/** Every slot a relic can occupy, for equipped-gear scans. */
const RELIC_SLOTS = ['weapon', 'offhand', 'helmet', 'chestplate', 'boots', 'relic', 'tool']

/** True if the player currently has `itemId` equipped in any slot. */
function hasEquipped(player, itemId) {
  const eq = player?.equipped ?? {}
  return RELIC_SLOTS.some((s) => eq[s] === itemId)
}

/** Fraction of a single hit the Armor of Existence lets through. */
export const ARMOR_DAMAGE_TAKEN = 0.25
/** Hard ceiling the Robe of the Dragons puts on any single hit, as %maxHp. */
export const ROBE_HIT_CAP_PCT = 0.35
/** Outgoing damage multiplier from the Fists of Glory. */
export const FISTS_DAMAGE_MULT = 1.15
/** Outgoing damage multiplier from the Blade of the Dragons. */
export const BLADE_DAMAGE_MULT = 1.30

/**
 * rebornWeaponMultiplier(player) — outgoing damage multiplier from an
 * equipped reborn weapon, or 1 if none. Folded into calcPlayerDamage() so it
 * covers basic attacks, skills, abilities, boss fights and PvP in one place
 * rather than only the two call sites lib/named-passives.js reaches.
 */
export function rebornWeaponMultiplier(player) {
  if (hasEquipped(player, RELIC_FISTS)) return FISTS_DAMAGE_MULT
  if (hasEquipped(player, RELIC_BLADE)) return BLADE_DAMAGE_MULT
  return 1
}

/**
 * applyRebornDefense(player, damage) -> { damage, message }
 *
 * The defensive half of the relics, applied inside applyIncomingDamage() so
 * it covers every incoming hit in the game. Pure: does not touch player.hp.
 *
 * The Robe's promise is "protects you from any one tap based skill like
 * cinder". Rather than maintaining a list of which skills count as finishers,
 * it caps any single hit at a share of max HP. That self-detects every heavy
 * nuke (Cinder Verdict, Wishing Star, Dance of the Rain, boss ultimates)
 * with no per-skill plumbing, and leaves ordinary hits untouched.
 *
 * The Armor stays quiet: the shrunken damage number is its own proof, and a
 * line per hit would flood multi-hit turns. The Robe speaks up only when the
 * cap actually clips something, which is the dramatic save worth narrating.
 */
export function applyRebornDefense(player, damage) {
  let dmg = Math.max(0, Math.floor(damage))
  let message = ''

  if (hasEquipped(player, RELIC_ARMOR)) {
    dmg = Math.max(1, Math.floor(dmg * ARMOR_DAMAGE_TAKEN))
  }

  if (hasEquipped(player, RELIC_ROBE)) {
    const cap = Math.max(1, Math.floor((player.maxHp ?? 1) * ROBE_HIT_CAP_PCT))
    if (dmg > cap) {
      message = `🐉 *Robe of the Dragons* refuses the finisher. ${dmg} damage becomes ${cap}.`
      dmg = cap
    }
  }

  return { damage: dmg, message }
}

// ── Dispatch lock while the Aura is active ────────────────────────────────
/** True while the player is mid trial and should not be doing anything else. */
export function isInAuraTrial(player) {
  const t = player?.reborn?.trial
  if (!t) return false
  return Date.now() < (t.endsAt ?? 0) + 15000
}

export const AURA_LOCK_MSG =
  '🩸 The Aura is still on you. You cannot act until the trial ends.'

// ── Outcome resolution ────────────────────────────────────────────────────
/**
 * resolveTrial(hpAtStart) -> { survived, hpAfter, damage }
 * The whole trial in one pure function. Called live when the ticker finishes
 * and again on recovery if a trial was interrupted, so both paths agree.
 */
export function resolveTrial(hpAtStart) {
  const hp = Math.max(0, Math.floor(hpAtStart))
  const survived = hp > AURA_TOTAL
  return {
    survived,
    hpAfter: survived ? hp - AURA_TOTAL : 0,
    damage: survived ? AURA_TOTAL : hp,
  }
}

/**
 * applyRebornSuccess(player) — mutates the player into their reborn form.
 * Caller must be inside updatePlayer(). Returns a summary for the message.
 */
export function applyRebornSuccess(player) {
  const before = {
    str: player.stats.str ?? 0,
    agi: player.stats.agi ?? 0,
    int: player.stats.int ?? 0,
    def: player.stats.def ?? 0,
    lck: player.stats.lck ?? 0,
    maxHp: player.maxHp ?? 0,
  }

  // Mark reborn FIRST: playerLevelCap(), playerMaxStatPoints() and
  // rebornStatBonus() all read this flag.
  player.reborn = {
    ...(player.reborn ?? {}),
    done: true,
    at: Date.now(),
    attempts: (player.reborn?.attempts ?? 0) + 1,
    fails: player.reborn?.fails ?? 0,
    pendingPick: true,
    pick: null,
  }
  delete player.reborn.trial
  delete player.reborn.offer

  for (const k of ['str', 'agi', 'int', 'def', 'lck']) {
    player.stats[k] = (player.stats[k] ?? 0) + REBORN_STAT_BONUS
    if (player.baseStats) {
      player.baseStats[k] = (player.baseStats[k] ?? 0) + REBORN_STAT_BONUS
    }
  }
  player.maxHp = (player.maxHp ?? 0) + REBORN_HP_BONUS
  if (player.baseStats) {
    player.baseStats.maxHp = (player.baseStats.maxHp ?? 0) + REBORN_HP_BONUS
  }

  // The god puts them back together before letting them go.
  player.hp = player.maxHp
  player.mp = player.maxMp

  return { before, after: { ...player.stats, maxHp: player.maxHp } }
}

/**
 * applyRebornFailure(player, levelsData_, getTotalStats) — the Aura wins.
 * Drops REBORN_FAIL_LEVELS levels, rebases XP onto the new level's floor,
 * rebuilds baseStats/stats/maxHp for that level, and leaves the player alive
 * on a sliver of HP. Caller must be inside updatePlayer().
 *
 * Gear bonuses are preserved by carrying the live stats-minus-baseStats gap
 * across the rebuild, the same trick ensureStatPoints() uses.
 */
export function applyRebornFailure(player, levels, getTotalStats) {
  const from = player.level
  const to = Math.max(1, from - REBORN_FAIL_LEVELS)

  const gearDelta = {}
  for (const k of ['str', 'agi', 'int', 'def', 'lck']) {
    gearDelta[k] = (player.stats?.[k] ?? 0) - (player.baseStats?.[k] ?? 0)
  }
  const hpGear = (player.maxHp ?? 0) - (player.baseStats?.maxHp ?? 0)
  const mpGear = (player.maxMp ?? 0) - (player.baseStats?.maxMp ?? 0)

  const canonical = getTotalStats(player.classId, player.raceId, to)
  const allocations = player.statPoints?.allocations ?? {}
  const bonus = rebornStatBonus(player)
  // Game Shop Stat Pack Boosts survive a failed ritual — they're a purchase,
  // not level-derived power, so they're re-added like the reborn bonus above.
  const sp = statPackBonus(player)

  player.baseStats = {
    str: canonical.str + (allocations.str ?? 0) + bonus.stat + sp.str,
    agi: canonical.agi + (allocations.agi ?? 0) + bonus.stat + sp.agi,
    int: canonical.int + (allocations.int ?? 0) + bonus.stat + sp.int,
    def: canonical.def + (allocations.def ?? 0) + bonus.stat + sp.def,
    lck: canonical.lck + (allocations.lck ?? 0) + bonus.stat + sp.lck,
    maxHp: canonical.maxHp + bonus.maxHp,
    maxMp: canonical.maxMp,
  }
  for (const k of ['str', 'agi', 'int', 'def', 'lck']) {
    player.stats[k] = player.baseStats[k] + gearDelta[k]
  }
  player.maxHp = player.baseStats.maxHp + hpGear
  player.maxMp = player.baseStats.maxMp + mpGear

  player.level = to
  // Sit them exactly on the new level's XP floor so they climb back honestly.
  player.xp = levels.xpTable?.[String(to)] ?? 0

  // Stat points shrink with the level, but never below what is already spent.
  if (player.statPoints) {
    const perLevel = levels.statPointsPerLevel ?? 15
    const newCap = Math.min(playerMaxStatPoints(player), to * perLevel)
    const spent = player.statPoints.spent ?? 0
    player.statPoints.earned = Math.max(spent, newCap)
    player.statPoints.unallocated = Math.max(0, player.statPoints.earned - spent)
  }

  // Left standing, barely. Not a death, so no gear is destroyed.
  player.hp = Math.max(1, Math.floor(player.maxHp * 0.25))
  player.mp = Math.min(player.mp ?? 0, player.maxMp)

  player.reborn = {
    ...(player.reborn ?? {}),
    done: false,
    attempts: (player.reborn?.attempts ?? 0) + 1,
    fails: (player.reborn?.fails ?? 0) + 1,
    lastFailAt: Date.now(),
  }
  delete player.reborn.trial
  delete player.reborn.offer

  return { from, to, lost: from - to }
}
