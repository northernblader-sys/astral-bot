/**
 * lib/beast-engine.js
 * ─────────────────────────────────────────────────────────────────────────
 * Summon Beasts: collectible companions owned per-player that gain CP
 * (combat power) from kills, level up over time, and randomly intervene
 * mid-fight — either redirecting an incoming hit onto themselves or
 * tacking a bonus attack onto the player's turn.
 *
 * OWNERSHIP MODEL
 * ────────────────
 *   player.beastInventory — every beast ever obtained (historical log,
 *     never shrinks): [{ beastId, obtainedAt }]
 *   player.summonedBeasts — the player's live roster, capped at 4 entries:
 *     [{ beastId, cp, obtainedAt }]. The 4-cap is enforced on ACQUISITION
 *     (see plugins/summon.js), not on equip — you simply can't obtain a
 *     5th beast while you already own 4.
 *   player.activeBeast — the beastId (string) of the one entry in
 *     summonedBeasts currently equipped, or null.
 *
 * CP / LEVEL MODEL
 * ────────────────
 * Like getTotalStats() in lib/game-data.js, beast stats are a pure
 * function of (beast definition, current CP) — never stored redundantly.
 * cpForLevel() defines a quadratic-ish CP curve; getBeastStats() derives
 * level + scaled atk/def/maxHp from a beast's baseStats + its owner's
 * accumulated CP for that instance.
 *
 * CP is awarded via awardBeastCp(), scaled the same way lib/xp-regulator.js
 * scales XP — a fraction of the XP reward from the kill that triggered it,
 * so beast growth pacing tracks player growth pacing automatically instead
 * of drifting.
 *
 * INTERVENTION HOOK
 * ─────────────────
 * beastIntervention(player, event, ctx) is a third parallel hook system,
 * called from attack.js / skill.js / defend.js at the exact same
 * checkpoints applyBossSpecial() (lib/boss-engine.js) and
 * applyAllNamedPassives() (lib/named-passives.js) are already called —
 * nothing beast-specific is hardcoded into those plugin files.
 *
 * Two events are handled:
 *   BEAST_EVENT.TURN_START        — chance to land a bonus attack on the
 *                                    enemy before the player's own action.
 *   BEAST_EVENT.ENEMY_DEAL_DAMAGE — chance to redirect the incoming hit
 *                                    onto the beast's own small HP pool
 *                                    instead of the player.
 *
 * The beast's transient in-fight HP pool lives at battleState.beastFight —
 * lazily initialized to the beast's derived maxHp the first time
 * beastIntervention() is called for a given fight (checked via the
 * beastId stamped on bs.beastFight, same one-shot spirit as
 * named-passives.js's npState.fightInitDone, but there's no separate
 * FIGHT_INIT call site — TURN_START/ENEMY_DEAL_DAMAGE both self-init on
 * first use). Once a beast's in-fight HP hits 0 it stops intervening for
 * the rest of that fight, but this never affects its persistent CP/level.
 */
import { beastMap } from './game-data.js'

export const BEAST_EVENT = {
  TURN_START:        'beast_turn_start',
  ENEMY_DEAL_DAMAGE:  'beast_enemy_deal_damage',
}

export const BEAST_MAX_OWNED = 4
// Default chance for any beast. A beast definition can override it with its
// own `interveneChance` (data/beasts.json) — the Tide Slimeling line is built
// around soaking hits, so it sits far above this baseline.
const INTERVENE_CHANCE = 0.20 // 20% — tuned per task brief's 15-25% range

/** This beast's intervention chance — its own override, else the default. */
function interveneChanceFor(beastDef) {
  const own = Number(beastDef?.interveneChance)
  return Number.isFinite(own) ? Math.min(0.95, Math.max(0, own)) : INTERVENE_CHANCE
}
const CP_BASE = 80
const CP_LEVEL_EXP = 1.65
const STAT_GROWTH_PER_LEVEL = 0.10 // +10% of base stats per level above 1
const BEAST_LEVEL_CAP = 60

// Fraction of a kill's XP reward converted into CP for the active beast.
// Mirrors xp-regulator.js's TIER_PCT approach: the beast's growth pace is
// pegged to the player's own pace rather than tuned independently.
const CP_PER_XP = 0.8

function _noop() {
  return { modified: false, lines: [] }
}

/** CP required to reach `level` (level 1 = 0 CP). */
export function cpForLevel(level) {
  if (level <= 1) return 0
  return Math.round(CP_BASE * Math.pow(level - 1, CP_LEVEL_EXP))
}

/** Derives the current level for an accumulated CP total. */
export function beastLevelForCp(cp) {
  let level = 1
  while (level < BEAST_LEVEL_CAP && cpForLevel(level + 1) <= cp) level++
  return level
}

/**
 * getBeastStats(beastDef, cp) — pure function, mirrors getTotalStats() in
 * lib/game-data.js. Never store the result; always derive it fresh.
 * Returns { level, atk, def, maxHp, cpToNext, cpIntoLevel }.
 */
export function getBeastStats(beastDef, cp) {
  const level  = beastLevelForCp(cp)
  const growth = 1 + (level - 1) * STAT_GROWTH_PER_LEVEL
  const b      = beastDef.baseStats

  const nextLevelCp = level < BEAST_LEVEL_CAP ? cpForLevel(level + 1) : null
  const thisLevelCp = cpForLevel(level)

  return {
    level,
    atk:   Math.max(1, Math.round(b.atk * growth)),
    def:   Math.max(0, Math.round(b.def * growth)),
    maxHp: Math.max(1, Math.round(b.maxHp * growth)),
    cpIntoLevel: cp - thisLevelCp,
    cpToNext: nextLevelCp != null ? nextLevelCp - cp : null,
  }
}

/** Look up a summonedBeasts entry by beastId, or null. */
export function findOwnedBeast(player, beastId) {
  return (player.summonedBeasts ?? []).find((b) => b.beastId === beastId) ?? null
}

/** The player's active beast instance + definition, or null if none set. */
export function getActiveBeast(player) {
  const id = player.activeBeast
  if (!id) return null
  const def = beastMap[id]
  const owned = findOwnedBeast(player, id)
  if (!def || !owned) return null
  return { def, owned, stats: getBeastStats(def, owned.cp) }
}

/**
 * awardBeastCp(player, xp) — call after any kill (mob, boss, or PvP win)
 * the active beast was "out" for. `xp` is the same XP figure the kill
 * already awarded the player (regulateMonsterXp/regulateBossXp result, or
 * a PvP-appropriate flat figure — see plugins/pvp.js).
 * Mutates the owned beast's `cp` in place. Returns a narrative line
 * describing the CP gain + any level-up, or '' if no beast is active.
 */
export function awardBeastCp(player, xp) {
  const active = getActiveBeast(player)
  if (!active || xp <= 0) return ''

  const gain = Math.max(1, Math.round(xp * CP_PER_XP))
  const beforeLevel = active.stats.level
  active.owned.cp = (active.owned.cp ?? 0) + gain
  const afterStats = getBeastStats(active.def, active.owned.cp)

  let line = `${active.def.emoji} *${active.def.name}* gains *+${gain} CP*!`
  if (afterStats.level > beforeLevel) {
    line += `\n🌟 *${active.def.name}* leveled up to *Lv.${afterStats.level}*!`
  }

  // Evolution is checked here rather than at each call site so every path
  // that awards CP (mob kill, boss kill, PvP win) gets it for free.
  line += beastEvolutionMessage(checkBeastEvolution(player, active.def.id))

  return line
}

/**
 * checkBeastEvolution(player, beastId) -> { evolved, fromBeast, toBeast, level }
 *
 * The Beast twin of checkEvolution() in lib/pet-bond.js, using the same
 * two-field opt-in shape so both systems read the same way:
 *   evolvesInto:    string — beastId of the evolved form
 *   evolvesAtLevel: number — derived CP level that triggers it
 *
 * Pets trigger on bond level; beasts have no bond, so the trigger is the
 * CP-derived level from getBeastStats() — the growth axis beasts already
 * have. Evolution is therefore earned through play (CP from kills via
 * awardBeastCp), never bought.
 *
 * Call immediately after awardBeastCp() inside the same updatePlayer()
 * callback. Mutates player in place: rewrites the beastId in summonedBeasts
 * and activeBeast, preserving accumulated CP exactly, and logs the new form
 * in beastInventory. Stats are always derived, so the higher baseStats of
 * the evolved form apply from the next read onward with no stat surgery.
 */
export function checkBeastEvolution(player, beastId) {
  const fromBeast = beastMap[beastId]
  if (!fromBeast?.evolvesInto || !fromBeast?.evolvesAtLevel) return { evolved: false }

  const owned = findOwnedBeast(player, beastId)
  if (!owned) return { evolved: false }

  const level = beastLevelForCp(owned.cp ?? 0)
  if (level < fromBeast.evolvesAtLevel) return { evolved: false }

  const toBeast = beastMap[fromBeast.evolvesInto]
  if (!toBeast) return { evolved: false }

  // Carry CP across untouched — the evolved form keeps its level and keeps
  // growing from where it was, same as pet-bond.js preserving bondXp.
  owned.beastId = toBeast.id

  if (player.activeBeast === beastId) player.activeBeast = toBeast.id

  player.beastInventory = player.beastInventory ?? []
  if (!player.beastInventory.some((b) => b.beastId === toBeast.id)) {
    player.beastInventory.push({ beastId: toBeast.id, obtainedAt: Date.now() })
  }

  return { evolved: true, fromBeast, toBeast, level }
}

/** Narrative block for a successful checkBeastEvolution() result. */
export function beastEvolutionMessage(evo) {
  if (!evo?.evolved) return ''
  return (
    `\n\n🌊✨ *EVOLUTION!* ✨🌊\n` +
    `─────────────\n` +
    `${evo.fromBeast.emoji} *${evo.fromBeast.name}* reshapes itself at *Lv.${evo.level}*...\n` +
    `${evo.toBeast.emoji} *${evo.toBeast.name}* stands in its place!\n` +
    `_Its CP carries over — it keeps every level it earned._`
  )
}

/**
 * beastIntervention(player, event, ctx) — the hook attack.js/skill.js/
 * defend.js call at the same checkpoints boss/named-passive hooks fire.
 *
 * ctx for TURN_START:        { enemy, bs }
 * ctx for ENEMY_DEAL_DAMAGE: { enemy, bs, damage }
 *
 * Returns:
 *   TURN_START        → { modified, lines, bonusDamage } — caller applies
 *                        bonusDamage to enemy.hp itself (same pattern as
 *                        named-passives.js's bonus_attack_per_turn).
 *   ENEMY_DEAL_DAMAGE  → { modified, lines, damage } — damage:0 means the
 *                        hit was fully redirected onto the beast.
 */
export function beastIntervention(player, event, ctx = {}) {
  const active = getActiveBeast(player)
  if (!active) return _noop()
  const bs = ctx.bs
  if (!bs) return _noop()

  // One-shot per-fight HP pool init, mirrors named-passives.js's fightInitDone.
  if (!bs.beastFight || bs.beastFight.beastId !== active.def.id) {
    bs.beastFight = {
      beastId: active.def.id,
      hp: active.stats.maxHp,
      maxHp: active.stats.maxHp,
    }
  }
  const bf = bs.beastFight
  if (bf.hp <= 0) return _noop() // downed for the rest of this fight

  if (event === BEAST_EVENT.TURN_START) {
    if (Math.random() >= interveneChanceFor(active.def)) return _noop()
    const bonus = Math.max(1, Math.round(active.stats.atk * 0.6))
    return {
      modified: true,
      bonusDamage: bonus,
      lines: [`${active.def.emoji} *${active.def.name}* lunges in with a bonus attack! _(+${bonus} dmg)_`],
    }
  }

  if (event === BEAST_EVENT.ENEMY_DEAL_DAMAGE) {
    if (Math.random() >= interveneChanceFor(active.def)) return _noop()
    const incoming = ctx.damage ?? 0
    if (incoming <= 0) return _noop()
    const mitigated = Math.max(1, incoming - Math.round(active.stats.def * 0.5))
    bf.hp = Math.max(0, bf.hp - mitigated)
    const downedLine = bf.hp <= 0
      ? `\n💫 *${active.def.name}* is knocked out for the rest of this fight!`
      : ''
    return {
      modified: true,
      damage: 0,
      lines: [`${active.def.emoji} *${active.def.name}* leaps in front of the attack! _(-${mitigated} beast HP, ${Math.max(0, bf.hp)}/${bf.maxHp} left)_${downedLine}`],
    }
  }

  return _noop()
}
