/**
 * battle-flavor.js — narration pools for the GENERIC 1v1 monster fight.
 *
 * The vanilla dungeon/monster fight in plugins/attack.js used to print the exact
 * same four lines every turn ("X attacks Y!", "X strikes back!", the two misses).
 * Boss fights have their own scripted cinematic voice (lib/boss-cinematic.js) and
 * swarm floors have their own pools (lib/swarm-combat.js); this fills the gap in
 * between so a plain monster fight reads like a fight you are living through
 * instead of a ledger of numbers.
 *
 * Every pool is a set of template functions picked at random. The mechanical
 * numbers (damage, crit, absorb) are computed in attack.js and passed in here
 * unchanged, this file only wraps them in words. Keep the *bold* on names and
 * damage so WhatsApp still highlights them, and keep the no-dash rule (commas,
 * colons, periods, never an em or en dash) per the player-facing copy rule.
 */

const pick = (a) => a[Math.floor(Math.random() * a.length)]
const em = (e) => e.emoji ?? '👾'

import {
  aizenPlayerHit, aizenPlayerCrit, aizenPlayerMiss, aizenPlayerAbsorbed,
  aizenEnemyHit, aizenEnemyMiss,
} from './aizen-flavor.js'

// ── Player's swing landing (non-crit). (name, enemy, dmg) ────────────────────
const PLAYER_HIT = [
  (n, e, d) => `⚔️ *${n}* steps in and cuts ${em(e)} *${e.name}* for *${d}*.`,
  (n, e, d) => `⚔️ *${n}* lands a clean blow on ${em(e)} *${e.name}*, *${d}* damage.`,
  (n, e, d) => `🗡️ *${n}* opens up ${em(e)} *${e.name}* for *${d}*.`,
  (n, e, d) => `⚔️ Steel meets flesh, ${em(e)} *${e.name}* takes *${d}* from *${n}*.`,
  (n, e, d) => `⚔️ *${n}* drives the strike home for *${d}*.`,
  (n, e, d) => `🗡️ *${n}* carves into ${em(e)} *${e.name}*, *${d}* damage.`,
  (n, e, d) => `⚔️ *${n}* catches ${em(e)} *${e.name}* flush for *${d}*.`,
  (n, e, d) => `💢 *${n}* hammers ${em(e)} *${e.name}* back a step, *${d}* damage.`,
  (n, e, d) => `⚔️ A measured swing, ${em(e)} *${e.name}* wears *${d}* of it.`,
  (n, e, d) => `🗡️ *${n}* slips past the guard and bites deep, *${d}* damage.`,
  (n, e, d) => `⚔️ *${n}* presses the attack, *${d}* off ${em(e)} *${e.name}*.`,
  (n, e, d) => `💥 *${n}* rocks ${em(e)} *${e.name}* for *${d}*.`,
  (n, e, d) => `⚔️ *${n}* works the opening and lands *${d}* on ${em(e)} *${e.name}*.`,
]

// ── Player's swing landing as a CRIT. (name, enemy, dmg) ─────────────────────
const PLAYER_CRIT = [
  (n, e, d) => `⚡ *CRIT!* *${n}* finds the gap and drives clean through ${em(e)} *${e.name}* for *${d}*.`,
  (n, e, d) => `⚡ *CRIT!* A perfect line, ${em(e)} *${e.name}* folds around *${d}* damage.`,
  (n, e, d) => `💥 *CRIT!* *${n}* puts everything into it, *${d}* tears through ${em(e)} *${e.name}*.`,
  (n, e, d) => `⚡ *CRIT!* Right where it hurts, *${d}* on ${em(e)} *${e.name}*.`,
  (n, e, d) => `💥 *CRIT!* *${n}* lands the one that counts, *${d}* damage.`,
  (n, e, d) => `⚡ *CRIT!* The strike bites to the bone, ${em(e)} *${e.name}* takes *${d}*.`,
  (n, e, d) => `💥 *CRIT!* *${n}* breaks the guard wide open for *${d}*.`,
  (n, e, d) => `⚡ *CRIT!* Clean through, *${d}* off ${em(e)} *${e.name}*.`,
  (n, e, d) => `💥 *CRIT!* *${n}* makes it count, ${em(e)} *${e.name}* reels from *${d}*.`,
  (n, e, d) => `⚡ *CRIT!* A savage, precise hit for *${d}* damage.`,
]

// ── Player's swing missing. (name, enemy) ────────────────────────────────────
const PLAYER_MISS = [
  (n, e) => `💨 *${n}* commits early and ${em(e)} *${e.name}* is not there.`,
  (n, e) => `💨 *${n}* swings, and ${em(e)} *${e.name}* slips it.`,
  (n, e) => `💨 The blade whistles past ${em(e)} *${e.name}* by a hair.`,
  (n, e) => `💨 *${n}* over-reaches and finds only air.`,
  (n, e) => `💨 ${em(e)} *${e.name}* reads it and steps clear of *${n}*.`,
  (n, e) => `💨 *${n}* misjudges the range, the strike falls short.`,
  (n, e) => `💨 A wild swing from *${n}*, ${em(e)} *${e.name}* leans out of it.`,
  (n, e) => `💨 *${n}* telegraphs it and ${em(e)} *${e.name}* is already gone.`,
  (n, e) => `💨 Close, but *${n}* cuts nothing but the wind.`,
  (n, e) => `💨 ${em(e)} *${e.name}* ducks under *${n}*'s guard-breaker.`,
]

// ── Player's hit landing but fully mitigated to 0 damage. (name, enemy) ──────
const PLAYER_ABSORBED = [
  (n, e) => `🛡️ *${n}* lands it, but ${em(e)} *${e.name}* shrugs the blow off, no damage.`,
  (n, e) => `🛡️ The strike glances off ${em(e)} *${e.name}* for nothing.`,
  (n, e) => `🛡️ ${em(e)} *${e.name}* soaks *${n}*'s hit clean, no damage dealt.`,
  (n, e) => `🛡️ *${n}* connects, but the blow is turned aside, no damage.`,
  (n, e) => `🛡️ Not a scratch, ${em(e)} *${e.name}* absorbs it whole.`,
]

// ── Enemy's blow landing. (enemy, dmg) ───────────────────────────────────────
const ENEMY_HIT = [
  (e, d) => `🩸 ${em(e)} *${e.name}* crashes into you for *${d}*.`,
  (e, d) => `🩸 ${em(e)} *${e.name}* catches you clean, *${d}* damage.`,
  (e, d) => `🩸 ${em(e)} *${e.name}* answers, and it lands for *${d}*.`,
  (e, d) => `🩸 You take ${em(e)} *${e.name}*'s full weight, *${d}*.`,
  (e, d) => `🩸 ${em(e)} *${e.name}* rakes you for *${d}* before you recover.`,
  (e, d) => `🩸 ${em(e)} *${e.name}* strikes back and bites for *${d}*.`,
  (e, d) => `🩸 A heavy blow from ${em(e)} *${e.name}*, *${d}* damage.`,
  (e, d) => `🩸 ${em(e)} *${e.name}* slips inside your guard for *${d}*.`,
  (e, d) => `🩸 ${em(e)} *${e.name}* lands it hard, *${d}* off your health.`,
  (e, d) => `🩸 ${em(e)} *${e.name}* hits you where it hurts, *${d}*.`,
  (e, d) => `🩸 ${em(e)} *${e.name}* drives you back with *${d}* damage.`,
  (e, d) => `🩸 ${em(e)} *${e.name}* counters clean, you wear *${d}*.`,
]

// ── Enemy's attack missing. (enemy) ──────────────────────────────────────────
const ENEMY_MISS = [
  (e) => `💨 ${em(e)} *${e.name}* lunges, and you are already gone.`,
  (e) => `💨 ${em(e)} *${e.name}* strikes back and misses.`,
  (e) => `💨 You slip ${em(e)} *${e.name}*'s counter by a breath.`,
  (e) => `💨 ${em(e)} *${e.name}* swings wide, nothing but air.`,
  (e) => `💨 ${em(e)} *${e.name}* overcommits and you step clear.`,
  (e) => `💨 ${em(e)} *${e.name}*'s blow carries past you.`,
  (e) => `💨 You read ${em(e)} *${e.name}* and drift out of reach.`,
  (e) => `💨 ${em(e)} *${e.name}* reaches for you and grasps nothing.`,
  (e) => `💨 Too slow, ${em(e)} *${e.name}* finds only the space you left.`,
  (e) => `💨 ${em(e)} *${e.name}* misses, thrown off by your footwork.`,
]

// ── Public helpers (called from plugins/attack.js's non-boss branches) ───────
// The optional trailing `character` is the fighter's equippedCharacter id.
// When it names Aizen, the line comes from his own voice (lib/aizen-flavor.js)
// instead of the generic pools: flavoured battle text whenever he is the one
// being used, and the ENEMY's reaction to fighting him rides along with it.
// Everyone else (and nobody) keeps the generic pools exactly as before.
export function playerHitLine(playerName, enemy, dmg, isCrit, character = null) {
  if (character === 'aizen') {
    return isCrit ? aizenPlayerCrit(playerName, enemy, dmg) : aizenPlayerHit(playerName, enemy, dmg)
  }
  return pick(isCrit ? PLAYER_CRIT : PLAYER_HIT)(playerName, enemy, dmg)
}
export function playerMissLine(playerName, enemy, character = null) {
  if (character === 'aizen') return aizenPlayerMiss(playerName, enemy)
  return pick(PLAYER_MISS)(playerName, enemy)
}
export function playerAbsorbedLine(playerName, enemy, character = null) {
  if (character === 'aizen') return aizenPlayerAbsorbed(playerName, enemy)
  return pick(PLAYER_ABSORBED)(playerName, enemy)
}
export function enemyHitLine(enemy, dmg, character = null) {
  if (character === 'aizen') return aizenEnemyHit(enemy, dmg)
  return pick(ENEMY_HIT)(enemy, dmg)
}
export function enemyMissLine(enemy, character = null) {
  if (character === 'aizen') return aizenEnemyMiss(enemy)
  return pick(ENEMY_MISS)(enemy)
}
