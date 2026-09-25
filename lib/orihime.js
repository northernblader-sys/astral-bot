/**
 * lib/orihime.js — Orihime Inoue's passive: Shun Shun Rikka (Sōten Kisshun).
 *
 * She never attacks. Her six flowers only ever do one thing: reject what has
 * happened to the person she stands behind. Everything here is a PASSIVE — no
 * command, no MP — and it is the only healing-on-a-clock character in the bot.
 *
 *   • Sōten Kisshun (every turn): at the start of each of the owner's turns she
 *     restores ORIHIME_HEAL_PCT of max HP, or ORIHIME_LOW_HEAL_PCT when the
 *     owner has fallen below ORIHIME_LOW_HP_PCT.
 *   • Rejection (once per battle): the first time a poison, burn, bleed or
 *     sever is found on the owner at turn start, the flowers reject it and it
 *     is simply gone.
 *   • After a won fight she mends ORIHIME_WIN_HEAL_PCT more.
 *   • PvP: every number above is halved (ORIHIME_PVP_SCALE) so a duel against
 *     her can still end.
 *
 * State lives on the battle-state object (bs.orihimeRejectUsed), so it resets
 * for free when the fight ends, the same once-per-battle latch every other
 * character in lib/character-abilities.js uses. Callers that have no
 * battleState on the player (party fights, PvP proxies) pass their own stand-in
 * object as `bs`.
 *
 * Pure: mutates only the player (hp, activeEffects) and the given bs. No I/O.
 */
export const ORIHIME_CHARACTER_ID = 'orihime'
export const ORIHIME_HEAL_PCT = 0.05
export const ORIHIME_LOW_HEAL_PCT = 0.10
export const ORIHIME_LOW_HP_PCT = 0.35
export const ORIHIME_WIN_HEAL_PCT = 0.15
export const ORIHIME_PVP_SCALE = 0.5

/** Negative-over-time effects the Rejection wipes. */
const REJECTABLE = new Set(['poison', 'burn', 'tear', 'sever', 'bleed'])

export function hasOrihime(player) {
  return player?.equippedCharacter === ORIHIME_CHARACTER_ID
}

/**
 * Turn-start tick. Returns { healed, rejected, message } or null when she is
 * not equipped / the owner is already down.
 */
export function tickShunShunRikka(player, bs = null, { pvp = false } = {}) {
  if (!hasOrihime(player)) return null
  const maxHp = Number(player.maxHp ?? 0)
  const hp = Number(player.hp ?? 0)
  if (maxHp <= 0 || hp <= 0) return null

  const scale = pvp ? ORIHIME_PVP_SCALE : 1
  const lines = []

  // Rejection first: a wound that is rejected never has to be healed.
  let rejected = null
  const state = bs ?? player.battleState ?? null
  if (state && !state.orihimeRejectUsed && Array.isArray(player.activeEffects)) {
    const idx = player.activeEffects.findIndex(e => REJECTABLE.has(e?.type))
    if (idx !== -1) {
      rejected = player.activeEffects[idx].type
      player.activeEffects = player.activeEffects.filter(e => !REJECTABLE.has(e?.type))
      state.orihimeRejectUsed = true
      lines.push(`🌸 *Shiten Kōshun: I reject.* _The ${rejected === 'tear' ? 'bleed' : rejected} is simply gone, as if it never happened._`)
    }
  }

  const low = hp / maxHp < ORIHIME_LOW_HP_PCT
  const pct = (low ? ORIHIME_LOW_HEAL_PCT : ORIHIME_HEAL_PCT) * scale
  const heal = Math.min(maxHp - hp, Math.max(1, Math.floor(maxHp * pct)))
  if (heal > 0) {
    player.hp = hp + heal
    lines.push(low
      ? `🌸 *Sōten Kisshun!* _The golden dome closes tight around the worst of it._ ❤️ *+${heal}* HP`
      : `🌸 _Soft gold light: Orihime's flowers mend you._ ❤️ *+${heal}* HP`)
  }

  if (!lines.length) return null
  return { healed: Math.max(0, heal), rejected, message: lines.join('\n') }
}

/** After a won fight. Returns the line to append, or ''. */
export function orihimeVictoryHeal(player, { pvp = false } = {}) {
  if (!hasOrihime(player)) return ''
  const maxHp = Number(player.maxHp ?? 0)
  const hp = Number(player.hp ?? 0)
  if (maxHp <= 0 || hp <= 0 || hp >= maxHp) return ''
  const heal = Math.min(maxHp - hp, Math.max(1, Math.floor(maxHp * ORIHIME_WIN_HEAL_PCT * (pvp ? ORIHIME_PVP_SCALE : 1))))
  player.hp = hp + heal
  return `\n🌸 _Orihime kneels beside you when it is over._ ❤️ *+${heal}* HP`
}
