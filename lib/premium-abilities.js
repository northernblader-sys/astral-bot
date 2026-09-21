/**
 * premium-abilities.js — engine for the 5 one-of-one premium abilities and the
 * 7 season-pack signature effects.
 *
 * Two clean families, wired at two kinds of site:
 *
 *  1. Defender-side pack signatures (dodge / phase / dread incoming-cut) do NOT
 *     live here — they sit inside lib/effects.js absorbDamage(), the single
 *     pre-hp funnel, reading player.activePackSignature. See that function.
 *
 *  2. Everything that needs the ATTACKER in scope lives here and is called from
 *     the combat hit-sites:
 *       - applyAbilityOnStruck / applyPackThornsOnStruck  (owner was hit → punish attacker)
 *       - applyPackLifestealOnDeal                        (owner dealt damage → heal owner)
 *       - packOutgoingMultiplier                          (owner attacking → rage scaling)
 *       - applyAbilityActive                              (the .freezeup/.heatwave/... buttons)
 *
 * Nothing here assumes a combat loop — every function takes plain entity objects
 * (player or monster) exactly like lib/effects.js, so the same calls work in PvE,
 * boss, swarm, PvP and wager fights.
 *
 * The weekly one-of-one spin (attemptWeeklyAbilitySpin) is the only stateful
 * piece: it claims through the shared exclusive-spin registry so a given ability
 * can only ever be won once, bot-wide.
 */
import {
  addStatusEffect, getEffectiveStat, hasEffect,
} from './effects.js'
import { premiumAbilityMap, premiumAbilities } from './game-data.js'
import { getExclusiveSpinWinner, claimExclusiveSpinForPlayer } from './season-engine.js'

// ── Ability catalogue + claim-registry keying ──────────────────────────────

export const ABILITY_IDS = premiumAbilities.abilities.map((a) => a.id)

// The shared claim registry (db.data.seasonRuntime.exclusiveSpinWinners) is
// keyed by arbitrary id and is ALSO used for one-of-one characters, so ability
// ids are namespaced to guarantee they can never collide with a character id.
export const abilityRegistryKey = (id) => `ability:${id}`

/** The ability def a player currently holds, or null. */
export function getPlayerAbility(player) {
  if (!player?.premiumAbility) return null
  return premiumAbilityMap[player.premiumAbility] ?? null
}

// ── Strength scoring (duration scaling + daylight dominance) ───────────────

/**
 * powerScore(entity) — a single coarse strength number that works for both a
 * full player (real core stats) and a sparse monster (mostly hp + atk). Used
 * only for relative comparisons, never shown to players, so precision doesn't
 * matter — only that "who is stronger" comes out right most of the time.
 */
export function powerScore(entity) {
  if (!entity) return 1
  const core = ['str', 'agi', 'int', 'def', 'lck']
    .reduce((sum, k) => sum + getEffectiveStat(entity, k), 0)
  const hp  = (entity.maxHp ?? 0) / 10
  const atk = entity.atk ?? 0 // monsters carry a flat atk instead of core stats
  return core + hp + atk
}

/**
 * scaleDurationByStrength(owner, opp, minTurns, maxTurns) → int
 *
 * Weaker opponent → the long end (maxTurns); stronger opponent → the short end
 * (minTurns); roughly even → the middle. Matches the design: a debuff bites
 * longer on someone you outclass, shorter on someone who outclasses you.
 */
export function scaleDurationByStrength(owner, opp, minTurns, maxTurns) {
  const lo = Math.min(minTurns, maxTurns)
  const hi = Math.max(minTurns, maxTurns)
  const mid = Math.round((lo + hi) / 2)
  const op = powerScore(opp)
  if (op <= 0) return hi
  const ratio = powerScore(owner) / op
  if (ratio >= 1.2) return hi        // opponent is clearly weaker
  if (ratio <= 0.85) return lo       // opponent is clearly stronger
  return mid
}

// ── Passive: owner was struck → punish the attacker ────────────────────────

/**
 * applyAbilityOnStruck(owner, attacker) → string[]
 *
 * Fires from every hit-site the moment `attacker` lands a blow on `owner`,
 * when `owner` holds a premium ability with a passive. Applies the passive's
 * on-hit effect to the attacker. Silent (returns []) when nothing procs or the
 * attacker is status-immune — passives fire on every hit, so narrating a miss
 * or an immunity every time would drown the log.
 */
export function applyAbilityOnStruck(owner, attacker) {
  const def = getPlayerAbility(owner)?.passive
  if (!def || !attacker) return []
  const lines = []

  const tryFreeze = (turns) => {
    const r = addStatusEffect(attacker, { type: 'freeze', duration: turns, sourceId: 'freeze_touch' })
    if (!r?.immune) lines.push(`❄️ *${attacker.name ?? 'The attacker'}* freezes over and loses their momentum!`)
  }
  const tryBurn = (pct, turns) => {
    const amount = Math.max(1, Math.round((attacker.maxHp ?? 0) * pct))
    const r = addStatusEffect(attacker, { type: 'burn', amount, duration: turns, sourceId: 'heat_blaze' })
    if (!r?.immune) lines.push(`🔥 *${attacker.name ?? 'The attacker'}* is set alight! _(${amount}/turn)_`)
  }
  const trySleep = (turns) => {
    const r = addStatusEffect(attacker, { type: 'sleep', duration: turns, sourceId: 'night_eyes' })
    if (!r?.immune) lines.push(`😴 *${attacker.name ?? 'The attacker'}* is dragged under and falls asleep!`)
  }

  switch (def.type) {
    case 'chill_attacker':
      if (Math.random() < (def.freezeChance ?? 0)) tryFreeze(def.freezeTurns ?? 1)
      break
    case 'burn_attacker':
      tryBurn(def.dotPercent ?? 0.05, def.burnTurns ?? 2)
      break
    case 'drowse_attacker':
      if (Math.random() < (def.drowseChance ?? 0)) trySleep(def.sleepTurns ?? 1)
      break
    case 'jack':
      // Weak versions of everything, rolled independently. At most one line each.
      if (Math.random() < (def.freezeChance ?? 0)) tryFreeze(def.procTurns ?? 1)
      else if (Math.random() < (def.burnChance ?? 0)) tryBurn(def.dotPercent ?? 0.03, def.procTurns ?? 1)
      else if (Math.random() < (def.sleepChance ?? 0)) trySleep(def.procTurns ?? 1)
      break
    default:
      break
  }
  return lines
}

// ── Pack signature: owner was struck (attacker in scope) ───────────────────

/**
 * applyPackThornsOnStruck(owner, attacker, damageToOwner)
 *   → { lines: string[], counterDamage: number }
 *
 * The two attacker-facing pack signatures:
 *   flame_thorns (Gemstone) — burn the attacker for a couple of turns.
 *   riposte (Knights of the Sicilian) — reflect a share of the damage taken
 *     straight back. counterDamage is returned for the caller to subtract from
 *     the attacker's hp (this module never assumes which hp field / write path
 *     a given combat site uses).
 */
export function applyPackThornsOnStruck(owner, attacker, damageToOwner) {
  const sig = owner?.activePackSignature
  const out = { lines: [], counterDamage: 0 }
  if (!sig || !attacker) return out

  if (sig.type === 'flame_thorns') {
    const amount = Math.max(1, Math.round((attacker.maxHp ?? 0) * (sig.dotPercent ?? 0.05)))
    const r = addStatusEffect(attacker, { type: 'burn', amount, duration: sig.turns ?? 2, sourceId: 'gemstone_flame' })
    if (!r?.immune) out.lines.push(`💠 Blue flame licks back — *${attacker.name ?? 'the attacker'}* burns for ${amount}/turn!`)
  } else if (sig.type === 'riposte' && damageToOwner > 0) {
    out.counterDamage = Math.max(1, Math.round(damageToOwner * (sig.counterPercent ?? 0.5)))
    out.lines.push(`⚔️ *Riposte!* ${out.counterDamage} damage returned to *${attacker.name ?? 'the attacker'}*.`)
  }
  return out
}

/**
 * applyStruckReactions(owner, attacker, damageToOwner) → { lines, counterDamage }
 *
 * The one call each combat hit-site makes when `owner` is struck: it merges the
 * premium-ability passive (freeze/burn/sleep the attacker) with the attacker-
 * facing pack signatures (flame_thorns burn, riposte reflect). counterDamage is
 * riposte's reflected damage for the caller to subtract from the attacker's hp
 * (and, since callers run this before their own victory check, to KO on).
 */
export function applyStruckReactions(owner, attacker, damageToOwner = 0) {
  const abilityLines = applyAbilityOnStruck(owner, attacker)
  const thorns = applyPackThornsOnStruck(owner, attacker, damageToOwner)
  return { lines: [...abilityLines, ...thorns.lines], counterDamage: thorns.counterDamage }
}

/**
 * applyPackLifestealOnDeal(owner, damageDealt) → { heal: number, lines: string[] }
 *
 * Dread Sovereign (Dark Monarch) heals the owner for a share of the damage they
 * just dealt. `heal` is returned for the caller to add onto owner.hp (capped to
 * maxHp), for the same reason counterDamage is returned above.
 */
export function applyPackLifestealOnDeal(owner, damageDealt) {
  const sig = owner?.activePackSignature
  const out = { heal: 0, lines: [] }
  if (!sig || sig.type !== 'dread' || !sig.lifesteal || !(damageDealt > 0)) return out
  const heal = Math.round(damageDealt * sig.lifesteal)
  if (heal <= 0) return out
  out.heal = heal
  out.lines.push(`🖤 The Dark Monarch drinks it in — *+${heal} HP*.`)
  return out
}

/**
 * packOutgoingMultiplier(owner) → number
 *
 * Bloodrage (Red Monster): outgoing damage scales up as the owner's HP drops,
 * to a maximum of (1 + maxBonus) near death. Returns 1 for everyone else, so
 * this can be folded unconditionally into an outgoing-damage calc.
 */
export function packOutgoingMultiplier(owner) {
  const sig = owner?.activePackSignature
  if (!sig || sig.type !== 'rage') return 1
  const maxHp = owner.maxHp ?? 0
  if (maxHp <= 0) return 1
  const missing = Math.max(0, Math.min(1, 1 - (owner.hp ?? maxHp) / maxHp))
  return 1 + (sig.maxBonus ?? 0.5) * missing
}

// ── Actives (the .freezeup / .heatwave / .nighteyes / .daylight buttons) ────
//
// Split into a self-part and an opponent-part because PvP mutates the two
// fighters in two separate updatePlayer() calls (pvp.js never nests them),
// while PvE has both the player and bs.enemy live in one handler. Callers run
// whichever parts they need in the right mutator; scaling/dominance reads on
// `owner` are read-only, so an owner SNAPSHOT is fine for the opponent-part.

/**
 * applyActiveSelf(owner, abilityId) → { lines }
 * The part of an active that mutates the OWNER (currently only Daylight's
 * all-stat surge). No-op for the target-only actives.
 */
export function applyActiveSelf(owner, abilityId) {
  const active = premiumAbilityMap[abilityId]?.active
  const lines = []
  if (!active || !owner) return { lines }
  if (active.effect === 'daylight') {
    const turns = active.turns ?? 5
    const boost = active.statBoost ?? 50
    for (const stat of ['str', 'agi', 'int', 'def', 'lck']) {
      addStatusEffect(owner, { type: 'strengthen', stat, value: boost, duration: turns, sourceId: 'daylight_ring' })
    }
    lines.push(`☀️ *DAYLIGHT.* The sun rises for *${owner.name ?? 'you'}* — every stat surges *+${boost}* for *${turns}* turns.`)
  }
  return { lines }
}

/**
 * applyActiveOnOpponent(owner, opp, abilityId) → { ok, lines, error }
 * The part of an active that mutates the OPPONENT. `owner` is read-only here
 * (used for duration scaling and Daylight's dominance check), so a snapshot is
 * safe. Daylight's "if already stronger, decide BEFORE the self-buff" ordering
 * is the caller's job: run this before applyActiveSelf so the compare is on
 * base power, per the design ("if the enemy was ALREADY the weaker one").
 */
export function applyActiveOnOpponent(owner, opp, abilityId) {
  const active = premiumAbilityMap[abilityId]?.active
  if (!active) return { ok: false, lines: [], error: `That ability has no active move.` }
  if (!opp)    return { ok: false, lines: [], error: `No opponent to target right now.` }

  const lines = []
  const oppName = opp.name ?? 'The enemy'

  switch (active.effect) {
    case 'freeze': {
      const turns = scaleDurationByStrength(owner, opp, active.minTurns ?? 3, active.maxTurns ?? 5)
      const r = addStatusEffect(opp, { type: 'freeze', duration: turns, sourceId: 'freeze_touch_active' })
      if (r?.immune) return { ok: true, lines: [`⭕ *${oppName}* is beyond status — the frost finds nothing to hold.`] }
      lines.push(`❄️ *FREEZE-UP!* *${oppName}* is frozen solid and will skip the next *${turns}* turn(s).`)
      break
    }
    case 'burn': {
      const turns  = scaleDurationByStrength(owner, opp, active.minTurns ?? 3, active.maxTurns ?? 5)
      const amount = Math.max(1, Math.round((opp.maxHp ?? 0) * (active.dotPercent ?? 0.09)))
      const r = addStatusEffect(opp, { type: 'burn', amount, duration: turns, sourceId: 'heat_blaze_active' })
      if (r?.immune) return { ok: true, lines: [`⭕ *${oppName}* is beyond status — the fire finds nothing to catch.`] }
      lines.push(`🔥 *HEAT WAVE!* *${oppName}* is engulfed — *${amount}* burn damage/turn for *${turns}* turns.`)
      break
    }
    case 'sleep': {
      const turns = active.turns ?? 3
      const r = addStatusEffect(opp, { type: 'sleep', duration: turns, sourceId: 'night_eyes_active' })
      if (r?.immune) return { ok: true, lines: [`⭕ *${oppName}* is beyond status — your gaze slides off.`] }
      lines.push(`🌑 *NIGHT EYES.* *${oppName}* falls asleep and will skip the next *${turns}* turns.`)
      break
    }
    case 'daylight': {
      // "If the enemy was already the weaker one, their attacks do nothing."
      if (powerScore(owner) >= powerScore(opp)) {
        const turns = active.turns ?? 5
        const r = addStatusEffect(opp, { type: 'freeze', duration: turns, sourceId: 'daylight_ring' })
        if (!r?.immune) lines.push(`🌟 *${oppName}* was already the lesser — pinned in the light, their attacks do nothing for *${turns}* turns.`)
      }
      break
    }
    default:
      return { ok: false, lines: [], error: `Unknown active effect.` }
  }
  return { ok: true, lines }
}

/**
 * applyAbilityActive(owner, opp, abilityId) — convenience combiner for the PvE
 * path, where both the owner and bs.enemy are live in the same handler. Runs
 * the opponent-part first so Daylight's dominance check sees base power, then
 * the self-buff. Returns merged lines.
 */
export function applyAbilityActive(owner, opp, abilityId) {
  const oppR  = applyActiveOnOpponent(owner, opp, abilityId)
  if (oppR.error) return { ok: false, lines: [], error: oppR.error }
  const selfR = applyActiveSelf(owner, abilityId)
  return { ok: true, lines: [...selfR.lines, ...oppR.lines] }
}

// ── Standard premium ability (every plan, every buyer) ────────────────────
//
// The one-of-one spin is the *chance* at a legendary; this is the *guarantee*.
// The player-reported bug: someone bought Premium, checked their equipped
// ability slot, and saw nothing — monthly/yearly buyers get no spin at all,
// and weekly spin *losers* still walked away empty-handed. Every premium
// buyer should leave with an ability in their equipped slot, so each grant
// (any plan, spin win or miss) routes through grantPremiumAbility() below.
//
// 'premium_favor' is a NORMAL generic-ability entry in data/abilities.json
// (Crown's Favor — a small all-stat passive for the whole battle), which is
// what makes it real instead of decorative: lib/ability-engine.js's
// applyPassiveAbilities() applies it when the buyer's next battle starts, and
// .profile renders it in the equipped slot list. It is deliberately NOT
// one-of-one: the 5 spin abilities stay the exclusive legendaries.
export const PREMIUM_ABILITY_ID = 'premium_favor'

/**
 * grantPremiumAbility(player, spinResult) →
 *   { granted: 'spin'|'new'|'already', id, equipped }
 *
 * MUST run INSIDE the updatePlayer(db, playerId, ...) mutator that is already
 * granting the premium, so the inventory/equipped writes persist atomically
 * with player.premium (same rule as attemptWeeklyAbilitySpin).
 *
 *  - 'spin'    — the buyer just won a one-of-one; that ability IS their
 *                equipped ability (rendered from player.premiumAbility), no
 *                standard grant on top.
 *  - 'new'     — Crown's Favor added to abilityInventory and, when a slot was
 *                free, equipped into equippedAbilities.
 *  - 'already' — they hold Crown's Favor from a previous purchase; nothing
 *                written (no duplicates, no double-equip).
 */
export function grantPremiumAbility(player, spinResult) {
  if (spinResult?.outcome === 'won') {
    return { granted: 'spin', id: spinResult.abilityId, equipped: true }
  }

  const held = (player.abilityInventory ?? []).includes(PREMIUM_ABILITY_ID)
    || (player.equippedAbilities ?? []).includes(PREMIUM_ABILITY_ID)
  if (held) {
    return { granted: 'already', id: PREMIUM_ABILITY_ID, equipped: (player.equippedAbilities ?? []).includes(PREMIUM_ABILITY_ID) }
  }

  player.abilityInventory = player.abilityInventory ?? []
  player.equippedAbilities = player.equippedAbilities ?? []
  player.abilityInventory.push(PREMIUM_ABILITY_ID)

  const slots = player.abilitySlots ?? 1
  if (player.equippedAbilities.length < slots) {
    player.equippedAbilities.push(PREMIUM_ABILITY_ID)
    return { granted: 'new', id: PREMIUM_ABILITY_ID, equipped: true }
  }
  // Slots full — it's owned and usable in any slot the owner frees up.
  return { granted: 'new', id: PREMIUM_ABILITY_ID, equipped: false }
}

// ── Weekly one-of-one spin ─────────────────────────────────────────────────

function shuffled(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * attemptWeeklyAbilitySpin(db, playerId, player)
 *   → { outcome, abilityId?, ability?, winChance? }
 *
 * MUST be called INSIDE an updatePlayer(db, playerId, ...) mutator so the
 * registry claim (claimExclusiveSpinForPlayer) is persisted atomically with the
 * player mutation — the loser of a race pays nothing and wins nothing.
 *
 * Outcomes:
 *   'already'  — the player already holds an ability (at most one per player).
 *   'sold_out' — all 5 abilities are claimed bot-wide; nothing left to win.
 *   'no_win'   — the luck roll missed; premium still granted, no ability.
 *   'won'      — abilityId/ability set on the player and claimed in the registry.
 *
 * The spin is deliberately NOT a guaranteed grant: these are the 5 rarest
 * things in the game, so a weekly buyer only sometimes walks away with one.
 * Luck nudges the odds a little.
 */
export function attemptWeeklyAbilitySpin(db, playerId, player) {
  if (player.premiumAbility) {
    return { outcome: 'already', abilityId: player.premiumAbility, ability: getPlayerAbility(player) }
  }

  const unclaimed = ABILITY_IDS.filter((id) => getExclusiveSpinWinner(db, abilityRegistryKey(id)) == null)
  if (unclaimed.length === 0) return { outcome: 'sold_out' }

  const lck = player.stats?.lck ?? 0
  const winChance = Math.min(0.55, 0.30 + lck * 0.004)
  if (Math.random() >= winChance) return { outcome: 'no_win', winChance }

  for (const id of shuffled(unclaimed)) {
    if (claimExclusiveSpinForPlayer(db, abilityRegistryKey(id), playerId)) {
      player.premiumAbility = id
      return { outcome: 'won', abilityId: id, ability: premiumAbilityMap[id], winChance }
    }
  }
  // Every remaining ability was claimed by a concurrent write between the
  // pre-check and here — treat as a miss, player keeps premium.
  return { outcome: 'no_win', winChance }
}
