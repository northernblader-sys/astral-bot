/**
 * pokemon-weather.js — battle weather (overhaul addendum §13).
 *
 * Weather is rolled ONCE per battle, at accept time, and is not
 * player-controlled or move-triggered in v1 (§13.1 — Rain Dance/Sunny Day
 * etc. as castable moves are an explicit non-goal for this pass). Stored on
 * both sides' `pokemonBattleState.weather`, same duplication convention the
 * base prompt already uses for hp/maxHp.
 */

export const WEATHER_TABLE = ['clear', 'rain', 'sun', 'sandstorm', 'hail']

// 40% clear / 15% each for the other 4, per addendum §13.1.
const WEATHER_WEIGHTS = { clear: 0.40, rain: 0.15, sun: 0.15, sandstorm: 0.15, hail: 0.15 }

/** Rolls the battle's weather once, at accept time. */
export function rollWeather() {
  const roll = Math.random()
  let cumulative = 0
  for (const w of WEATHER_TABLE) {
    cumulative += WEATHER_WEIGHTS[w]
    if (roll < cumulative) return w
  }
  return 'clear'
}

/** Battle-start announcement line. Silent (null) if weather is clear, per §13.1. */
export function weatherAnnounceLine(weather) {
  switch (weather) {
    case 'rain':      return '🌧️ It started to rain!'
    case 'sun':       return '☀️ The weather is harsh sunlight!'
    case 'sandstorm': return '🌪️ A sandstorm is raging!'
    case 'hail':      return '❄️ It started to hail!'
    default:          return null
  }
}

/**
 * weatherPowerMultiplier(weather, moveType) — applied in the same
 * damage-calc step as STAB/type-effectiveness (§13.2, order: base → STAB →
 * type-eff → weather → crit → random).
 */
export function weatherPowerMultiplier(weather, moveType) {
  if (weather === 'rain') {
    if (moveType === 'water') return 1.5
    if (moveType === 'fire') return 0.5
  }
  if (weather === 'sun') {
    if (moveType === 'fire') return 1.5
    if (moveType === 'water') return 0.5
  }
  return 1
}

const SANDSTORM_IMMUNE_TYPES = new Set(['rock', 'ground', 'steel'])
const HAIL_IMMUNE_TYPES = new Set(['ice'])

/**
 * weatherChipDamage(weather, monTypes, maxHp) — end-of-turn chip damage for
 * sandstorm/hail (§13.2), applied in the same status-tick step the base
 * prompt's §3.3 step 4 already runs for burn/poison. Returns 0 for
 * clear/rain/sun, or for a Pokémon whose type(s) are immune to the active
 * weather's chip damage.
 */
export function weatherChipDamage(weather, monTypes, maxHp) {
  const types = monTypes ?? []
  if (weather === 'sandstorm' && !types.some(t => SANDSTORM_IMMUNE_TYPES.has(t))) {
    return Math.max(1, Math.floor(maxHp * 0.0625))
  }
  if (weather === 'hail' && !types.some(t => HAIL_IMMUNE_TYPES.has(t))) {
    return Math.max(1, Math.floor(maxHp * 0.0625))
  }
  return 0
}
