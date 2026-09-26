/**
 * lib/dragon-engine.js — the standalone dragon companion granted alongside
 * Nisha on her exclusive spin (plugins/ni-spin.js). Deliberately NOT part of
 * the pets system (lib/pet-bond.js) or the Summon Beasts system
 * (lib/beast-engine.js) — those are covered separately (Miyashi's spin grants
 * a real pet, data/pets.json's 'rime_kit'). The dragon is a fourth, much
 * smaller parallel system with exactly one behavior: a player-triggered,
 * once-per-battle, PvP-only ultimate. It has no passive intervention chance
 * and does nothing at all in PvE/dungeons — see the task brief this was built
 * from: "only work in pvp not dungeons."
 *
 * OWNERSHIP
 * ─────────
 *   player.hasDragon — boolean, set true the moment Nisha's spin succeeds
 *     (plugins/ni-spin.js). There is only ever one dragon per player and it
 *     is never sold, fed, leveled, or equipped/unequipped — owning it IS
 *     having it available every PvP duel, for free, forever.
 *
 * GATE
 * ────
 *   Usable once per battle (bs.dragonUltimateUsed, same battleState-flag
 *   pattern as activateCinderVerdict/activateFinalForm in
 *   character-abilities.js — resets for free when the fight ends).
 *   Also requires the duel to have reached turn 4 (bs.turn >= 4) — early
 *   copy-paste requests for "make it stronger, faster" were resolved as: no
 *   scaling knob, just a flat unlock turn. Before turn 4 the gate refuses
 *   with a clear reason so plugins/ultimate.js can just relay gate.message.
 *
 * POWER
 * ─────
 *   True damage — NOT run through calcPlayerDamage()/applyDefense() the way
 *   Cinder Verdict's 8x multiplier is. This sets the opponent's HP straight
 *   to 0. It cannot be dodged (Nisha's own Serpent's Grace explicitly
 *   exempts trueDamage hits — see rollSerpentsGrace()'s ctx.trueDamage check
 *   in character-abilities.js) and is not mitigated by DEF, shields, or
 *   Mei's sustain-heal (that only intercepts damage BEFORE it's subtracted;
 *   this function subtracts nothing — it sets hp directly, same convention
 *   tickFrostbindAura/applyAbsoluteOneSiphon use for ambient effects that
 *   bypass the normal hit pipeline entirely).
 */

const ULTIMATE_UNLOCK_TURN = 4 // bs.turn must be >= this

function _fail(message) {
  return { ok: false, message }
}

/** True once the player has ever obtained the dragon (Nisha's spin, ni-spin.js). */
export function hasDragon(player) {
  return !!player?.hasDragon
}

/**
 * activateDragonUltimate(player) -> { ok, message }
 * Call from the PvP turn engine (plugins/pvp.js) the same place
 * activateCinderVerdict() is called — validates and burns the once-per-battle
 * charge only. Does NOT touch either player's HP; the caller applies the
 * true-damage kill itself via resolveDragonUltimateDamage() below, mirroring
 * how activateCinderVerdict() only returns a multiplier for the caller to
 * run through the normal pipeline.
 */
export function activateDragonUltimate(player, bsOverride = null) {
  const bs = bsOverride ?? player?.battleState
  if (!hasDragon(player)) {
    return _fail(`❌ You don't have a dragon. Nisha's spin is the only way to obtain one.`)
  }
  if (!player?.inBattle || !bs) {
    return _fail(`❌ Not in battle.`)
  }
  if (bs.type !== 'pvp') {
    return _fail(`❌ The dragon only answers in PvP duels.`)
  }
  const turn = bs.turn ?? 1
  if (turn < ULTIMATE_UNLOCK_TURN) {
    return _fail(`⏳ The dragon isn't close enough yet — available from turn *${ULTIMATE_UNLOCK_TURN}* (currently turn ${turn}).`)
  }
  if (bs.dragonUltimateUsed) {
    return _fail(`⚠️ The dragon has already answered this battle.`)
  }

  bs.dragonUltimateUsed = true
  return { ok: true, message: null }
}

/**
 * resolveDragonUltimateDamage(opponent) -> { damage }
 * Call after activateDragonUltimate() returns ok:true. True damage — sets
 * opponent.hp to 0 outright and returns the amount that was actually removed
 * (their HP going into the hit) purely for the narrative line's number.
 */
export function resolveDragonUltimateDamage(opponent) {
  const damage = Math.max(0, opponent?.hp ?? 0)
  if (opponent) opponent.hp = 0
  return { damage }
}

/**
 * buildDragonUltimateSequence(actorName, opponentName, damage) -> string[]
 * Returns the cinematic beats as separate strings, in send order, for the
 * caller to post as a short-delay message sequence. The LAST element is the
 * finishing damage line — the caller sends THAT one specifically via
 * sendImageTo(ctx, 'dragon-ultimate', ...) (lib/image.js) instead of a plain
 * reply, so it lands with art once a URL is registered there; missing art
 * safely falls back to plain text, same as every other sendImageTo call in
 * this codebase. Everything before it in the array is a plain-text beat.
 * The caller appends its own dragon-rest note + normal battle-status footer
 * after this — see buildDragonRestFooter() below.
 */
export function buildDragonUltimateSequence(actorName, opponentName, damage) {
  return [
    `🐉 A shadow falls over the arena — the dragon descends and closes its claws around *${actorName}*.`,
    `_${actorName} is carried into the sky. Higher. Higher._\n\nAt the top, they look at each other — and smile.`,
    `_The dragon lets go..._`,
    `📉 *${actorName}* is falling.\n\n_200 feet..._`,
    `_100 feet..._\n\n🐉 *A ROAR splits the sky.*`,
    `_The dragon swoops in and catches ${actorName} mid-fall — unleashing its breath directly onto ${opponentName}._`,
    `🔥☄️ *THE BREATH OF ONE*\n─────────────\n_${opponentName} is engulfed — evaporated where they stood._\n\n🩸 *${damage}* damage!`,
  ]
}

/**
 * buildDragonRestFooter(actorName) -> string
 * The line the caller (plugins/pvp.js) uses IN PLACE OF the normal
 * "TURN PASSES TO ..." battle-status footer whenever the dragon ultimate
 * just ended the duel — the fight is already over (opponentDefeated), so
 * there is no next turn to pass to; showing that footer would be wrong.
 * Also puts the dragon to sleep (see markDragonAsleep()) so `.dragon`
 * reflects it immediately afterward.
 */
export function buildDragonRestFooter(actorName) {
  return (
    `\n\n😴🐉 _Its hunger answered, the dragon carries ${actorName} back down, circles once, and settles at their side — eyes already closing. It will sleep for a while now._`
  )
}

// ── .dragon status command support ──────────────────────────────────────
//
// player.dragonSleepUntil — epoch ms. Set by markDragonAsleep() the moment
// the ultimate resolves (buildDragonRestFooter's narration and this flag are
// applied together from the same call site in pvp.js, so they can never go
// out of sync). While Date.now() < dragonSleepUntil, `.dragon` reports it as
// asleep; once that passes, it's awake again and free to use the ultimate
// in a future duel (sleep is flavor only — it does NOT gate
// activateDragonUltimate(); the once-per-battle flag already does that job).
const SLEEP_DURATION_MS = 2 * 60 * 60 * 1000 // 2 hours of in-fiction rest after an ultimate

/** Call right after resolveDragonUltimateDamage() — puts the dragon to sleep. */
export function markDragonAsleep(player) {
  if (!player) return
  player.dragonSleepUntil = Date.now() + SLEEP_DURATION_MS
}

/** True while the dragon is still resting off its last ultimate. */
export function isDragonAsleep(player) {
  return Date.now() < (player?.dragonSleepUntil ?? 0)
}

const AWAKE_ACTIVITY_LINES = [
  'circling high over the eastern peaks, hunting for nothing in particular.',
  'bouncing boulders down a ravine just to hear them crack.',
  'terrorizing a village on the coast — smoke on the horizon, nothing lethal, just noise.',
  'sunning itself flat on a cliff edge, one eye cracked open, watching the clouds.',
  'chasing its own shadow across a lake, scattering fish with every pass.',
  'gnawing on a boulder like it owes the dragon money.',
  'diving through a waterfall over and over, apparently for fun.',
  'perched on a bell tower somewhere, judging the local architecture.',
  'racing a storm front across the horizon and winning.',
  'curled around a hilltop, half-asleep but still watching everything.',
]

const SLEEP_FLAVOR_LINES = [
  'Curled tail to snout, breathing slow. Smoke rings drift off its nostrils every few seconds.',
  'Flat on its back in a scorched clearing, wings splayed, snoring loud enough to strip leaves off nearby trees.',
  'Coiled around a sun-warmed boulder, one eye twitching mid-dream.',
  `Wedged into the mouth of a cave, tail still twitching from whatever it's dreaming about.`,
]

/**
 * dragonStatusLine(player) -> string
 * Full flavor readout for plugins/dragon.js. Sleep uses a fixed remaining-
 * time readout; awake picks a random "what it's up to" line each call, by
 * design — the point is that it feels alive and inconsistent, not that the
 * activity is tracked state.
 */
export function dragonStatusLine(player) {
  if (isDragonAsleep(player)) {
    const remainingMs = Math.max(0, (player.dragonSleepUntil ?? 0) - Date.now())
    const mins = Math.ceil(remainingMs / 60000)
    const flavor = SLEEP_FLAVOR_LINES[Math.floor(Math.random() * SLEEP_FLAVOR_LINES.length)]
    return (
      `😴🐉 *Asleep.*\n_${flavor}_\n\n` +
      `Wakes in about *${mins} min* — though honestly, it wakes up fine either way. ` +
      `Sleep is just flavor; the ultimate is ready again as soon as you're in a new duel.`
    )
  }
  const activity = AWAKE_ACTIVITY_LINES[Math.floor(Math.random() * AWAKE_ACTIVITY_LINES.length)]
  return `🐉 *Awake.*\n_Right now, it's ${activity}_`
}
