/**
 * lib/echidna.js - Echidna, the Witch of Greed: everything her kit needs in
 * one standalone module, same split precedent as lib/yoriichi.js and
 * lib/megumi.js. lib/character-abilities.js re-publishes these exports so
 * combat files that already import everything else from there keep working;
 * the spin plugin, the .greed plugin, pvp.js and the .echidna AI command
 * import straight from here. No import cycles: this file depends only on
 * game-data.js, format.js and echidna-child.js.
 *
 * ── The kit ──────────────────────────────────────────────────────────────
 *   Gospel of Greed (.greed) - once per battle, no MP. Her mood decides the
 *   size of the theft, and the theft is NEVER zero damage-wise (she always
 *   distracts the enemy for a turn), but the money she walks out with is
 *   entirely up to her:
 *
 *     😌 AMUSED      (45%)  half the enemy's money + a strong shot at gems
 *     🤨 CAPRICIOUS  (35%)  half the money; gems bore her today
 *     😒 DISPLEASED  (20%)  a quarter of the money; not worth her effort
 *
 *   PvE: "the enemy's money" is the wealth the enemy carries (enemy.solars,
 *   the same base number handleVictory() rewards). Gems are plundered from
 *   the enemy's hoard on a mood-based chance, one at a time.
 *   PvP: half the OPPONENT'S wallet.solars is transferred outright, and gems
 *   are stolen from the opponent's own wallet ("she can steal gems from
 *   other players to give to you") - floored at zero, never pushing either
 *   wallet negative.
 *
 *   The Child - Echidna grants her holder ONE child through the sanctuary
 *   rite (plugins/echidna.js). The child lives in the holder's house and
 *   grows on visits (lib/echidna-child.js). In battle the child steals
 *   beside her: a stage-scaled bonus on top of whatever the tithe took, and
 *   from 'child' stage up, a chance at an extra gem. See childBattleBonus().
 *
 *   Book of Wisdom - her card ability and the .wisdom readout
 *   (plugins/wisdom.js): the world's memory, read for information - and, in
 *   her hands, for knowing exactly how much the other side of the fight is
 *   carrying.
 */
import { characterMap } from './game-data.js'
import { roundGems } from './format.js'
import { childBattleBonus } from './echidna-child.js'

export const ECHIDNA_CHARACTER_ID = 'echidna'

// The enemy spends its next turn patting its empty pockets. One turn, the
// same discipline Puppet Strings' tangle uses.
export const GREED_TANGLE_TURNS = 1

/** True when `player` has Echidna equipped. */
export function hasEchidna(player) {
  return player?.equippedCharacter === ECHIDNA_CHARACTER_ID
}

/** True when `player` OWNS Echidna (regardless of equip). */
export function ownsEchidna(player) {
  return (player?.ownedCharacters ?? []).includes(ECHIDNA_CHARACTER_ID)
}

/**
 * The three moods. `tithePct` is the share of the enemy's money she takes;
 * `gemChance`/`gemMax` drive the gem plunder. The weights double as the roll
 * thresholds: 0-0.45 amused, 0.45-0.80 capricious, the rest displeased.
 */
export const ECHIDNA_MOODS = {
  amused: {
    emoji: '😌',
    label: 'AMUSED',
    weight: 0.45,
    tithePct: 0.5,
    gemChance: 0.65,
    gemMax: 1,
    line: (enemy) => `_😌 "What a delightful purse ${enemy} is carrying. I will take half - consider it tuition." _`,
  },
  capricious: {
    emoji: '🤨',
    label: 'CAPRICIOUS',
    weight: 0.35,
    tithePct: 0.5,
    gemChance: 0.25,
    gemMax: 1,
    line: (enemy) => `_🤨 "Half of it. And keep your gems, ${enemy} - they bore me today." _`,
  },
  displeased: {
    emoji: '😒',
    label: 'DISPLEASED',
    weight: 0.20,
    tithePct: 0.25,
    gemChance: 0,
    gemMax: 0,
    line: (enemy) => `_😒 "Tch. A quarter. ${enemy} is not worth the effort of a proper theft." _`,
  },
}

/**
 * rollEchidnaMood(rand?) -> 'amused' | 'capricious' | 'displeased'
 * Accepts an injectable random source so the curve is unit-testable.
 */
export function rollEchidnaMood(rand = Math.random()) {
  const r = Number(rand)
  if (r < ECHIDNA_MOODS.amused.weight) return 'amused'
  if (r < ECHIDNA_MOODS.amused.weight + ECHIDNA_MOODS.capricious.weight) return 'capricious'
  return 'displeased'
}

/**
 * echidnaTitheAmounts(carry, mood) -> { solars }
 * The pure money math, shared by PvE and PvP: a mood-shaped share of what
 * the other side of the fight is carrying, floored at zero.
 */
export function echidnaTitheAmounts(carrySolars, mood) {
  const rec = ECHIDNA_MOODS[mood] ?? ECHIDNA_MOODS.displeased
  const solars = Math.max(0, Math.floor((Number(carrySolars) || 0) * rec.tithePct))
  return { solars }
}

/**
 * echidnaGemPlunder(mood, { rand, available }) -> number of gems plundered.
 * PvE: gems found in the enemy's hoard. PvP: gems lifted from the opponent's
 * wallet. Never more than the mood allows and never more than exists.
 */
export function echidnaGemPlunder(mood, { rand = Math.random(), available = 0 } = {}) {
  const rec = ECHIDNA_MOODS[mood] ?? ECHIDNA_MOODS.displeased
  if (rec.gemMax <= 0) return 0
  if (rand >= rec.gemChance) return 0
  return Math.min(rec.gemMax, Math.max(0, Math.floor(Number(available) || 0)))
}

/**
 * resolveEchidnaTithePvE(player, enemy, mood, opts?) -> { solars, gems, child }
 *
 * Writes NOTHING except `player.wallet` - the caller owns the enemy record
 * (the tithe never damages it). The child bonus rides on top of the base
 * tithe; `child` in the result carries the stage line for the reveal.
 */
export function resolveEchidnaTithePvE(player, enemy, mood, { rand = Math.random() } = {}) {
  const base = echidnaTitheAmounts(enemy?.solars ?? 0, mood)
  let gems = echidnaGemPlunder(mood, { rand, available: 1 }) // a hoard yields at most one

  const child = childBattleBonus(player?.echidnaChild)
  const bonusSolars = Math.floor(base.solars * child.solarsPct)
  if (child.gemChance > 0 && rand < child.gemChance) gems += 1

  const solars = base.solars + bonusSolars
  player.wallet = player.wallet ?? { solars: 0, gems: 0 }
  player.wallet.solars = Math.max(0, Math.floor(player.wallet.solars ?? 0) + solars)
  player.wallet.gems = roundGems((player.wallet.gems ?? 0) + gems)

  return { solars, gems, bonusSolars, child }
}

// PvP gem caps per mood - deliberately a notch above the PvE hoard plunder
// (one gem): stealing from a PLAYER is the fantasy of this kit, so amused
// can lift two. Still tiny in absolute terms - gems are premium currency and
// this is once per battle, so the economy stays intact.
const PVP_GEM_CAP = { amused: 2, capricious: 1, displeased: 0 }

/**
 * echidnaPvpTithe(oppWallet, mood, opts?) -> { solarsTaken, gemsTaken }
 * Pure math against the OPPONENT's wallet, run inside the opponent's own
 * updatePlayer in pvp.js so the write is atomic with their record. Both
 * amounts are floored at zero and capped at what actually exists - she can
 * never push a wallet negative. The holder's side is credited by a separate
 * actor write right after (same opponent-then-actor split hollowexchange
 * uses).
 */
export function echidnaPvpTithe(oppWallet, mood, { rand = Math.random(), child = null } = {}) {
  const rec = ECHIDNA_MOODS[mood] ?? ECHIDNA_MOODS.displeased
  const oppSolars = Math.max(0, Math.floor(oppWallet?.solars ?? 0))
  const oppGems = Math.max(0, oppWallet?.gems ?? 0)

  let solarsTaken = Math.min(oppSolars, Math.floor(oppSolars * rec.tithePct))
  const cap = PVP_GEM_CAP[mood] ?? 0
  let gemsTaken = cap > 0 && rand < rec.gemChance
    ? Math.min(cap, Math.floor(oppGems))
    : 0

  const cb = childBattleBonus(child)
  const bonus = Math.floor(solarsTaken * cb.solarsPct)
  solarsTaken = Math.min(oppSolars, solarsTaken + bonus)
  if (cb.gemChance > 0 && rand < cb.gemChance) gemsTaken = Math.min(Math.floor(oppGems), gemsTaken + 1)

  return { solarsTaken, gemsTaken, childBonus: bonus, child: cb }
}

/**
 * buildGreedTitheReveal({...}) - the shared reveal copy for PvE, swarm, boss
 * and PvP. Flavour is the forbidden technique turned to money: she slips her
 * shadow into the enemy - for a heartbeat it wears their face - and walks it
 * back out through their pockets.
 */
export function buildGreedTitheReveal({ ownerName, enemyName, mood, solars, gems, context = 'dungeon', childRec = null, immune = false }) {
  const rec = ECHIDNA_MOODS[mood] ?? ECHIDNA_MOODS.displeased
  const gemLine = gems > 0
    ? `💎 _…and ${gems} gem${gems === 1 ? '' : 's'}${context === 'pvp' ? ', lifted straight from their wallet' : ', pried out of the hoard'}._`
    : (mood === 'capricious' ? `💎 _The gems she left where they were. They did not interest her._` : '')

  const childLine = childRec?.hasChild
    ? `\n🍼 _${childRec.line}_`
    : ''

  const distract = immune
    ? `\n⭕ _It shakes the intrusion off a heartbeat early - distracted, but not for long._`
    : `\n🪙 _It stops mid-swing to pat its suddenly lighter pockets. The next move is lost to the counting._`

  return (
    `🍵📖 *GOSPEL OF GREED*\n` +
    `─────────────\n` +
    `_${ownerName} opens the Gospel, and Echidna's shadow slips across the floor and into *${enemyName}* - for one heartbeat it wears their face, their hands, their pockets - then walks back out, heavier._\n\n` +
    `${rec.line(enemyName)}\n` +
    `☀️ *+${solars} Solars* taken${context === 'pvp' ? ' from them' : ''} and handed to *${ownerName}*.` +
    (gemLine ? `\n${gemLine}` : '') +
    childLine +
    distract
  )
}

/**
 * activateGreedTithe lives on the character-abilities side (it needs
 * ultimateGate/burnUltimate, which are private to that file) - see
 * lib/character-abilities.js's ── Echidna ── marker. This constant is the
 * battleState latch key it uses, exported so pvp.js and tests can read it.
 */
export const GREED_TITHE_LATCH = 'greedTitheUsed'

/** The character record, defensively read. */
export function echidnaCharacter() {
  return characterMap[ECHIDNA_CHARACTER_ID] ?? null
}
