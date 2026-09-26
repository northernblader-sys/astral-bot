/**
 * lib/gogeta.js — Gogeta's kit: Fusion of Equals, Instant Transmission,
 * Soul Punisher and Big Bang Kamehameha.
 *
 * Split into its own module for the same reason lib/megumi.js and
 * lib/yoriichi.js are: four moving parts, two of them stateful across a whole
 * battle, is more than a section of lib/character-abilities.js can carry
 * without that file becoming unreadable. character-abilities.js re-exports
 * this whole surface, so every combat file keeps importing Gogeta's helpers
 * from the same place it imports everyone else's. No import cycle: this
 * module depends only on lib/effects.js and lib/image.js.
 *
 * ── Fusion of Equals (passive, armed at the opening bell) ────────────────
 * +45% STR and +45% AGI as a plain 'strengthen' effect, plus a clock. The
 * clock is the whole character: FUSION_TURNS turns after arming, the fusion
 * breaks, both buffs are stripped, and Big Bang Kamehameha stops working for
 * the rest of the fight. Soul Punisher and Instant Transmission survive the
 * split, because those belong to the halves as much as to the whole.
 *
 * The strengthen entries are written with duration 999 so effects.js's
 * tickEffects() never expires them, and tickFusion() below is the single
 * owner of the fusion lifetime. Two independent clocks (an effect duration
 * and a turn counter) would drift the moment one battle engine ticked
 * effects on a turn the other did not, and a fusion reading "4 turns left"
 * with no buff attached is worse than either behaviour on its own.
 *
 * ── Instant Transmission (passive proc, never a command) ─────────────────
 * Three faces of one technique, all rolled, none of them asked for:
 *   1. Dodge — rolled inside applyIncomingDamage(), the one funnel every
 *      struck hit in the game passes through, so it covers PvE, bosses and
 *      duels from a single place. The blow arrives at empty air.
 *   2. Cooldown skip — when one of his moves would go on cooldown, there is
 *      a chance it simply does not, because he is back before the recoil is.
 *   3. Opening move — if a duel would have started on the other side, he may
 *      take the first turn instead (see the accept path in plugins/pvp.js).
 */
import { addStatusEffect, getEffectiveStat } from './effects.js'
import { sendImageTo } from './image.js'

export const GOGETA_CHARACTER_ID = 'gogeta'

/** Standing art: profile card, spin result, idle state. */
export const GOGETA_IMAGE = 'https://i.ibb.co/20J4NGM7/Una-vittoria-stellata.jpg'
/** Swapped in ONLY on the turn Big Bang Kamehameha actually fires. */
export const KAMEHAMEHA_IMAGE = 'https://i.ibb.co/271TStQZ/image.jpg'

export function hasGogeta(player) {
  return player?.equippedCharacter === GOGETA_CHARACTER_ID
}

// ── Fusion of Equals ─────────────────────────────────────────────────────
/** Turns the fusion holds, counted from the turn it was armed. */
export const FUSION_TURNS = 12
/** Turns left at which the warning starts printing every turn. */
export const FUSION_WARN_AT = 3
const FUSION_SOURCE = 'fusion_of_equals'
// Flat deltas, computed off base stats at arm time (the same shape Mei's
// Final Form uses): strengthen stores a number, not a percentage.
const FUSION_BUFFS = [
  { stat: 'str', pct: 0.45, label: 'STR' },
  { stat: 'agi', pct: 0.45, label: 'AGI' },
]

/**
 * armFusion(player) → string
 *
 * Called at the opening bell of every fight, right beside armHypnosis() and
 * armLovestruck(). No-op for anyone who does not have him equipped, and
 * idempotent: a second call inside the same battle is ignored, so a plugin
 * that arms defensively cannot hand out the buff twice.
 *
 * Returns the narration line, or '' when nothing happened.
 */
export function armFusion(player) {
  if (!hasGogeta(player)) return ''
  const bs = player?.battleState
  if (!bs) return ''
  if (bs.fusionArmedAtTurn != null) return ''

  bs.fusionArmedAtTurn = bs.turn ?? 1
  bs.fusionBroken = false

  const gained = []
  for (const buff of FUSION_BUFFS) {
    const base = player?.stats?.[buff.stat] ?? 0
    const value = Math.round(base * buff.pct)
    if (value <= 0) continue
    // duration 999: tickFusion() owns the clock, not tickEffects(). See the
    // file header for why there is exactly one owner.
    addStatusEffect(player, {
      type: 'strengthen', stat: buff.stat, value, duration: 999, sourceId: FUSION_SOURCE,
    })
    gained.push(`+${value} ${buff.label}`)
  }
  if (!gained.length) return ''

  return (
    `🔵 *FUSION OF EQUALS:* ${gained.join(' · ')}\n` +
    `_Two fighters, one body, ${FUSION_TURNS} turns on the clock._`
  )
}

/** Turns of fusion remaining. 0 once it has broken, or if it was never armed. */
export function fusionTurnsLeft(player, bsOverride = null) {
  const bs = bsOverride ?? player?.battleState
  if (!bs || bs.fusionArmedAtTurn == null || bs.fusionBroken) return 0
  const elapsed = (bs.turn ?? 1) - bs.fusionArmedAtTurn
  return Math.max(0, FUSION_TURNS - elapsed)
}

export function isFusionActive(player, bsOverride = null) {
  return fusionTurnsLeft(player, bsOverride) > 0
}

/** Strips both strengthen entries this module put on the record. */
function stripFusionBuffs(player) {
  if (!Array.isArray(player?.activeEffects)) return
  player.activeEffects = player.activeEffects.filter(
    (e) => !(e?.type === 'strengthen' && e?.sourceId === FUSION_SOURCE),
  )
}

/**
 * tickFusion(player, bsOverride) → string
 *
 * Called once per turn at the same checkpoint processStatusTurn() runs from.
 * Prints the countdown as it gets short, and when the clock runs out it
 * breaks the fusion for good: buffs stripped, Big Bang Kamehameha locked out
 * for the rest of the fight (activateBigBangKamehameha() reads the same
 * flag). Nothing here re-arms, so the split is permanent within a battle.
 */
export function tickFusion(player, bsOverride = null) {
  if (!hasGogeta(player)) return ''
  const bs = bsOverride ?? player?.battleState
  if (!bs || bs.fusionArmedAtTurn == null || bs.fusionBroken) return ''

  const left = fusionTurnsLeft(player, bs)
  if (left > 0) {
    if (left > FUSION_WARN_AT) return ''
    return `⏳ _Fusion of Equals: *${left}* turn${left === 1 ? '' : 's'} left._`
  }

  bs.fusionBroken = true
  stripFusionBuffs(player)
  return (
    `💨 *THE FUSION BREAKS*\n` +
    `_Time is up. Gogeta comes apart in a flash of light, and the strength and speed ` +
    `that were never one fighter's to begin with go with him. Big Bang Kamehameha is gone ` +
    `for the rest of this fight._`
  )
}

// ── Instant Transmission ─────────────────────────────────────────────────
/** Floor chance to vanish out of an incoming hit. */
export const INSTANT_TRANSMISSION_BASE = 0.16
/** AGI divisor for the scaling half. Effective AGI, so fusion feeds it. */
const INSTANT_TRANSMISSION_AGI_DIVISOR = 1600
/** Hard ceiling. A dodge that reads as "sometimes nothing lands" is not fun
 *  to duel into, and Circe's Final Dash is the bot's dedicated evasion kit. */
export const INSTANT_TRANSMISSION_CAP = 0.30
/** Chance a move that should go on cooldown simply does not. */
export const INSTANT_TRANSMISSION_REFUND = 0.25
/** Chance he takes the opening turn of a duel he did not start. */
export const INSTANT_TRANSMISSION_OPENER = 0.30

const VANISH_LINES = [
  'gone before it lands, and standing somewhere else entirely',
  'two fingers to the forehead, and the strike closes on nothing',
  'the air where he was still moving, and he is already behind it',
  'he does not block it. He simply is not there for it',
]

/** Live dodge chance, base plus effective AGI, capped. */
export function instantTransmissionChance(player) {
  if (!hasGogeta(player)) return 0
  const agi = getEffectiveStat(player, 'agi')
  return Math.min(INSTANT_TRANSMISSION_CAP, INSTANT_TRANSMISSION_BASE + agi / INSTANT_TRANSMISSION_AGI_DIVISOR)
}

/**
 * rollInstantTransmission(player) → { dodged, message }
 *
 * The dodge half. Called from the very front of applyIncomingDamage(): a hit
 * he was not there for did not happen, so it must not heal Mei, spend a
 * clone, chip a cat-form pool or burn Yato's tear. Costs nothing and is
 * limited only by the roll, which is why the cap above is where it is.
 */
export function rollInstantTransmission(player, bsOverride = null) {
  if (!hasGogeta(player)) return { dodged: false, message: '' }
  const bs = bsOverride ?? player?.battleState
  if (!bs) return { dodged: false, message: '' }
  if (Math.random() >= instantTransmissionChance(player)) return { dodged: false, message: '' }

  bs.instantTransmissionDodges = (bs.instantTransmissionDodges ?? 0) + 1
  const line = VANISH_LINES[bs.instantTransmissionDodges % VANISH_LINES.length]
  return { dodged: true, message: `✨ *INSTANT TRANSMISSION:* _${line}._` }
}

/**
 * rollInstantTransmissionOpener(player) → boolean
 *
 * The turn-order half, and the only place "may let Gogeta act first" has any
 * meaning: PvE has no initiative roll (the player always acts, the enemy
 * counters), and a duel alternates strictly, so the one turn that can be
 * seized is the opening one. Rolled only for the ACCEPTER, because the
 * challenger already moves first by default and has nothing to win here.
 */
export function rollInstantTransmissionOpener(player) {
  if (!hasGogeta(player)) return false
  return Math.random() < INSTANT_TRANSMISSION_OPENER
}

// ── Cooldowns ────────────────────────────────────────────────────────────
// Both of his actives ride the existing bs.abilityCooldowns map (readyAtTurn
// keyed by move id, cleared with battleState at the end of every fight), the
// same model plugins/useability.js and the duel engine use for equipped
// abilities. Gojo's once-per-battle latches would not do: the user asked for
// "low cooldown" and "long cooldown", which is a number of turns, not a
// single charge.
export const SOUL_PUNISHER_ID = 'gogeta_soul_punisher'
export const BIG_BANG_KAMEHAMEHA_ID = 'gogeta_big_bang_kamehameha'

function cooldownLeft(bs, id) {
  const readyAt = bs?.abilityCooldowns?.[id] ?? 0
  return Math.max(0, readyAt - (bs?.turn ?? 1))
}

/**
 * Puts a move on cooldown, unless Instant Transmission refunds it. The
 * refund is announced by the caller through the returned line, because a
 * cooldown that silently failed to apply reads as a bug.
 */
function setCooldown(player, bs, id, turns) {
  bs.abilityCooldowns = bs.abilityCooldowns ?? {}
  if (Math.random() < INSTANT_TRANSMISSION_REFUND) {
    delete bs.abilityCooldowns[id]
    return `✨ _Instant Transmission: he is back before the recoil is. No cooldown._`
  }
  bs.abilityCooldowns[id] = (bs.turn ?? 1) + turns
  return ''
}

/** Both cooldowns at a glance, for the move list and the profile panel. */
export function gogetaCooldowns(player, bsOverride = null) {
  const bs = bsOverride ?? player?.battleState
  return {
    soulPunisher: cooldownLeft(bs, SOUL_PUNISHER_ID),
    kamehameha: cooldownLeft(bs, BIG_BANG_KAMEHAMEHA_ID),
  }
}

// ── Soul Punisher ────────────────────────────────────────────────────────
/** Medium damage. Sits between Fool's Gambit (2.5) and Thief's Eye (3.2). */
export const SOUL_PUNISHER_MULT = 2.8
export const SOUL_PUNISHER_COOLDOWN = 2

/**
 * activateSoulPunisher(player, bsOverride) → { ok, multiplier, message, extra }
 *
 * Gate only. The CALLER rolls and applies the damage, the same contract
 * activateHollowPurple() and activateCinderVerdict() use. Committing the
 * cooldown here (rather than in the caller) is deliberate: the gate is the
 * one place that can see whether the move was legal, so it is the one place
 * that should be allowed to spend the charge.
 *
 * `extra` carries the Instant Transmission cooldown-refund line when it
 * fires, for the caller to append to its turn text.
 */
export function activateSoulPunisher(player, bsOverride = null) {
  const bs = bsOverride ?? player?.battleState
  if (!hasGogeta(player)) {
    return { ok: false, message: `❌ You need *Gogeta* equipped to fire *Soul Punisher*.` }
  }
  if (!player.inBattle || !bs) {
    return { ok: false, message: `❌ Not in battle.` }
  }
  const left = cooldownLeft(bs, SOUL_PUNISHER_ID)
  if (left > 0) {
    return { ok: false, message: `⏳ *Soul Punisher* is recharging. Ready in *${left}* turn${left === 1 ? '' : 's'}.` }
  }

  const extra = setCooldown(player, bs, SOUL_PUNISHER_ID, SOUL_PUNISHER_COOLDOWN)
  return { ok: true, multiplier: SOUL_PUNISHER_MULT, message: null, extra }
}

// ── Big Bang Kamehameha ──────────────────────────────────────────────────
// Very high, and deliberately under Hollow Purple's 18: that one is a single
// charge per battle, this one is repeatable in principle. In practice the
// full-bar requirement means most fights only ever see it once, which is
// what the long cooldown is there to underline rather than enforce alone.
export const BIG_BANG_KAMEHAMEHA_MULT = 15
export const BIG_BANG_KAMEHAMEHA_COOLDOWN = 8
/** "Requires full energy": the whole MP bar, and it spends the whole bar. */
export const BIG_BANG_KAMEHAMEHA_ENERGY_PCT = 1.0

/**
 * activateBigBangKamehameha(player, bsOverride) → { ok, multiplier, message, extra }
 *
 * Same gate-only contract as above, with three extra walls:
 *   • the fusion must still be holding (tickFusion() sets bs.fusionBroken)
 *   • the energy bar must be FULL, and firing empties it
 *   • an 8-turn cooldown on top, which the fusion clock usually outlives
 * Ignores DEF and never misses, both of which are the caller's job; this
 * function only decides whether it is allowed to happen.
 */
export function activateBigBangKamehameha(player, bsOverride = null) {
  const bs = bsOverride ?? player?.battleState
  if (!hasGogeta(player)) {
    return { ok: false, message: `❌ You need *Gogeta* equipped to fire *Big Bang Kamehameha*.` }
  }
  if (!player.inBattle || !bs) {
    return { ok: false, message: `❌ Not in battle.` }
  }
  if (bs.fusionArmedAtTurn != null && !isFusionActive(player, bs)) {
    return {
      ok: false,
      message: `💨 *The fusion has already broken.* _Big Bang Kamehameha needed both halves. ` +
        `It is gone for the rest of this fight._`,
    }
  }
  const left = cooldownLeft(bs, BIG_BANG_KAMEHAMEHA_ID)
  if (left > 0) {
    return { ok: false, message: `⏳ *Big Bang Kamehameha* is charging. Ready in *${left}* turn${left === 1 ? '' : 's'}.` }
  }

  const needed = Math.max(1, Math.ceil((player.maxMp ?? 0) * BIG_BANG_KAMEHAMEHA_ENERGY_PCT))
  if ((player.mp ?? 0) < needed) {
    return {
      ok: false,
      message: `💧 *Not enough energy.* _Big Bang Kamehameha needs a full bar: ` +
        `*${needed}* MP. You are holding *${player.mp ?? 0}*._`,
    }
  }

  player.mp = 0
  const extra = setCooldown(player, bs, BIG_BANG_KAMEHAMEHA_ID, BIG_BANG_KAMEHAMEHA_COOLDOWN)
  return { ok: true, multiplier: BIG_BANG_KAMEHAMEHA_MULT, message: null, extra }
}

// ── Asset senders ────────────────────────────────────────────────────────
// Separate messages, so media never blocks the turn text (same shape as
// lib/megumi.js's domain splash). Errors are swallowed on purpose: by the
// time either of these is called the energy bar is already spent and the
// cooldown already written, so a dead URL must never swallow the turn the
// player paid for.

/**
 * The Big Bang Kamehameha splash. The ONLY thing in the bot that sends
 * KAMEHAMEHA_IMAGE, and only on the turn the beam actually fires: every
 * refusal (no energy, cooldown, fusion broken, wrong character) is plain
 * text, because art on a "no" reads as if the move went off.
 */
export function sendKamehamehaImage(ctx, caption = '', recipient = ctx.sender) {
  return sendImageTo(ctx, KAMEHAMEHA_IMAGE, caption, recipient).catch(() => {})
}

/** Gogeta's standing art, for every ordinary display (profile, spin, idle). */
export function sendGogetaImage(ctx, caption = '', recipient = ctx.sender) {
  return sendImageTo(ctx, GOGETA_IMAGE, caption, recipient).catch(() => {})
}
