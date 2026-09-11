/**
 * ability-engine.js — applies equipped abilities (data/abilities.json) to
 * combat. Two entry points:
 *
 *   applyPassiveAbilities(player) — call once when a battle starts. Applies
 *   every effect of every equipped *passive* ability to the player via
 *   lib/effects.js, exactly once per battle.
 *
 *   resolveActiveAbility(...) — used by plugins/useability.js to turn an
 *   *active* ability's effects into damage + status-effect application,
 *   mirroring how plugins/skill.js resolves a skill.
 *
 * Ability effect objects are written in data/abilities.json using the exact
 * field shapes lib/effects.js's addStatusEffect()/applyEffect() expect
 * (duration, amount, value, stat) — no translation layer needed, so adding
 * a new ability is pure data, zero code.
 */
import { abilities as abilityDefs } from './game-data.js'
import { addStatusEffect, applyEffect, getEffectiveStat } from './effects.js'
import { calcPlayerDamage, applyDefense } from './combat-engine.js'
import { getModValue, applyHighDefenseCatchup } from './mods.js'

const abilityMap = Object.fromEntries(abilityDefs.map(a => [a.id, a]))

export function getAbilityDef(id) {
  return abilityMap[id] ?? null
}

/** Resolve an ability by 1-based equipped slot index, id, or name. */
export function findEquippedAbility(player, query) {
  const equippedIds = player.equippedAbilities ?? []
  const equipped    = equippedIds.map(id => abilityMap[id]).filter(Boolean)

  if (/^\d+$/.test(query)) {
    return equipped[parseInt(query, 10) - 1] ?? null
  }
  const q = query.toLowerCase().trim().replace(/\s+/g, '_')
  return equipped.find(a => a.id === q || a.name.toLowerCase().replace(/\s+/g, '_') === q)
    ?? equipped.find(a => a.name.toLowerCase().includes(query.toLowerCase().trim()))
    ?? null
}

/**
 * Apply all equipped passive abilities' effects to `player` — called once
 * when a battle begins. Each effect is a duration-based effect.js shape
 * (strengthen/regen/shield/etc.), applied via addStatusEffect exactly as
 * authored in data/abilities.json.
 */
export function applyPassiveAbilities(player) {
  const equippedIds = player.equippedAbilities ?? []
  for (const id of equippedIds) {
    const ability = abilityMap[id]
    if (!ability || ability.type !== 'passive') continue
    for (const effect of ability.effects ?? []) {
      const target = effect.target === 'enemy' ? null : player // passives only ever target self
      if (!target) continue
      addStatusEffect(target, effect)
    }
  }
}

/**
 * Resolve an active ability's damage + secondary effects for one use.
 * Mirrors plugins/skill.js's damage/effect resolution, generalized for the
 * ability effect shape (attack effects support `hits` for multi-strike).
 *
 * applyCheatMods: pass true ONLY from PvE call sites. Defaults to false so
 * pvp.js (which shares this function) never applies damage_multiplier/
 * crit_chance_boost cheats against another player by accident — the
 * default has to be the safe one here since this function is shared.
 *
 * Returns { lines: string[], defeated: boolean } — `lines` are human-
 * readable battle-log lines to append to the reply; `defeated` is true if
 * the enemy's hp reached 0 as a result.
 */
export function resolveActiveAbility(ability, player, enemy, applyCheatMods = false) {
  const lines = []
  const [primary, ...secondary] = ability.effects ?? []

  if (primary?.type === 'attack') {
    const hits = Math.max(1, primary.hits ?? 1)
    let total = 0
    let anyCrit = false
    const cheatDamageMult = applyCheatMods ? (getModValue(player, 'damage_multiplier') ?? 1) : 1
    const cheatCritBonus  = applyCheatMods ? (getModValue(player, 'crit_chance_boost') ?? 0) : 0
    for (let i = 0; i < hits; i++) {
      const { rawDmg, isCrit } = calcPlayerDamage(player, { multiplier: primary.multiplier }, cheatDamageMult, cheatCritBonus)
      const defended = applyDefense(rawDmg, getEffectiveStat(enemy, 'def'))
      total += applyCheatMods
        ? applyHighDefenseCatchup(player, enemy, defended)
        : defended
      anyCrit = anyCrit || isCrit
    }
    enemy.hp = Math.max(0, enemy.hp - total)
    lines.push(
      hits > 1
        ? `💥 *${hits}* hits for *${total}* total damage!${anyCrit ? ' ⚡ *CRIT!*' : ''}`
        : `💥 *${total}* damage!${anyCrit ? ' ⚡ *CRIT!*' : ''}`,
    )
  } else if (primary) {
    lines.push(applyOneEffect(primary, player, enemy))
  }

  for (const effect of secondary) lines.push(applyOneEffect(effect, player, enemy))

  return { lines: lines.filter(Boolean), defeated: enemy.hp <= 0 }
}

function applyOneEffect(effect, player, enemy) {
  const target     = effect.target === 'self' ? player : enemy
  const targetName = effect.target === 'self' ? player.name : enemy.name

  // 'heal' and 'cure' are instant effects (see effects.js INSTANT_HANDLERS)
  // and must go through applyEffect(), not addStatusEffect() — the latter
  // throws for any effect type that isn't duration-based.
  if (effect.type === 'heal' || effect.type === 'cure') {
    return applyEffect(target, effect)
  }

  addStatusEffect(target, effect)
  const line = {
    stun:       () => `⚡ *${targetName}* is stunned!`,
    freeze:     () => `❄️ *${targetName}* is frozen!`,
    blind:      () => `🌑 *${targetName}* is blinded!`,
    burn:       () => `🔥 *${targetName}* is set ablaze!`,
    poison:     () => `☠️ *${targetName}* is poisoned!`,
    weaken:     () => `💔 *${targetName}*'s ${effect.stat?.toUpperCase()} is weakened!`,
    strengthen: () => `✨ *${targetName}*'s ${effect.stat?.toUpperCase()} is strengthened!`,
    shield:     () => `🛡️ *${targetName}* gains a shield!`,
    regen:      () => `💚 *${targetName}* begins regenerating!`,
  }[effect.type]
  return line ? line() : `✨ ${effect.type} applied to *${targetName}*.`
}
