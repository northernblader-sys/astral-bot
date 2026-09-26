/**
 * aizen-flavor.js — narration pools for Aizen Sosuke (Kyōka Suigetsu).
 *
 * The generic monster fight has lib/battle-flavor.js, bosses have their
 * scripted cinematic voice, and Aizen has this: every moment his kit touches
 * a fight in ANY of the four battle forms (classic 1v1, swarm floor, boss
 * fight, PvP duel) reads through these pools instead of one hard-coded line
 * repeating forever. Three voices, deliberately distinct:
 *
 *   1. THE HYPNOSIS ITSELF (KYOKA_*, KUROHITSUGI_*) — cold, present tense,
 *      reality quietly edited mid-sentence. His misdirects are not dodges:
 *      the enemy's own senses lie to them, and the copy says so.
 *   2. THE ENEMY REACTION (ENEMY_REACTION_*, LANDED_*) — the other side of
 *      the exchange. Fighting Aizen is watching your own perception fail:
 *      doubt, recalibration, then panic. This is the pool that makes the
 *      ENEMY a character instead of a damage source.
 *   3. HIS OWN BLADES (PLAYER_HIT/CRIT/MISS/ABSORB, ENEMY_HIT/MISS) — used
 *      by the classic fight's swing narration (plugins/attack.js) whenever
 *      he is the equipped character. Aizen does not swing hard, he swings
 *      exactly, and the world around the swing has already been arranged.
 *
 * NO-DASH RULE: this file is player-facing copy. Commas, colons, periods,
 * never an em or en dash anywhere (same rule lib/battle-flavor.js keeps).
 * A regression test (test/aizen-four-battles.test.mjs) enforces it on every
 * pool in this file, so do not "fix" a line by putting a dash in it.
 *
 * Everything here is pure: no imports, no state. Builders take what they
 * need and return one string. The me() helper keeps the art URL in one
 * place so the plugins' caption fallbacks can share it.
 */

const pick = (a) => a[Math.floor(Math.random() * a.length)]

/** His art, one constant. Used as the caption image by both actives. */
export const AIZEN_ART = 'https://i.ibb.co/jvwH2Qfj/Aizen-Sosuke-The-One-Above-All.jpg'

// ── Kyōka Suigetsu: the blow aimed at a phantom ─────────────────────────────
// Fired when an incoming struck hit is misdirected. The enemy swung at an
// edited battlefield and connected with nothing.
const MISDIRECT_LINES = [
  `👁️ The blow lands perfectly. On nothing. The him you struck was never standing there.`,
  `👁️ Steel passes through a shape that was never him, and finds no one home.`,
  `👁️ Your eyes watched it connect. Your hands report otherwise.`,
  `👁️ He is three steps left of the fight your senses are showing you.`,
  `👁️ The impact feels real, right up until it happens.`,
  `👁️ Whatever you hit, it was the part of the battlefield he was done with.`,
  `👁️ Your weapon stops on empty air that remembers being him a moment ago.`,
  `👁️ You struck where certainty said he was. Certainty was his.`,
  `👁️ The hit lands clean on a memory of him that he left there on purpose.`,
  `👁️ Your arms complete the swing. Somewhere behind you, he notes one more sense.`,
  `👁️ Nothing was there. Nothing was ever going to be there.`,
  `👁️ You feel the contact dissolve the moment you commit to it.`,
  `👁️ He was never where your eyes agreed he was, and the blow knows it first.`,
  `👁️ The target your senses picked was a guest he invited. It leaves when struck.`,
  `👁️ Your swing closes on him, and him turns out to be the light bending wrong.`,
  `👁️ A perfect blow against a man made of the wrong information.`,
  `👁️ The him you could see was standing in a place he had already left.`,
  `👁️ Contact, then correction: there was nobody inside that outline.`,
  `👁️ Your strike arrives exactly on time to the wrong man.`,
  `👁️ The battlefield you are fighting in is the one he is letting you keep.`,
]

// ── The sense steal (with the running count) ────────────────────────────────
// One line per stolen sense, sense-name aware: losing Sight must not read
// like losing Smell. count is the new total (1..5), max is AIZEN_MAX_SENSES.
const SENSE_LINES = {
  Sight: [
    `Their *Sight* goes quiet. The battlefield dims to what he permits.`,
    `Their *Sight* folds first. Shapes now arrive pre-arranged by him.`,
    `Their eyes report for duty and file everything directly with him.`,
  ],
  Hearing: [
    `Their *Hearing* turns traitor. Even the sound of the fight belongs to him now.`,
    `Their *Hearing* goes: silence where there was steel, steel where there was nothing.`,
    `They stop hearing the room and start hearing the room he prefers.`,
  ],
  Touch: [
    `Their *Touch* empties out. Impact becomes a rumour passed to their arm.`,
    `Their *Touch* is his. Blows land where he says they landed.`,
    `Their hands can no longer file complaints about what is real.`,
  ],
  Smell: [
    `Their *Smell* goes next. Even the air they breathe was edited.`,
    `Their *Smell* surrenders. Blood, smoke, iron: all of it optional now.`,
    `The last honest air in their lungs stops being honest.`,
  ],
  Taste: [
    `Their *Taste* closes the ledger. Their whole sensory world files under him.`,
    `Their *Taste* goes over without a fight. Five for five.`,
    `The fifth sense signs off. Their world is now a room he maintains.`,
  ],
}

const COMPLETE_LINES = [
  `🔮✨ *COMPLETE HYPNOSIS.* _All five senses are his. Every blow for the rest of this fight lands on nothing._`,
  `🔮✨ *COMPLETE HYPNOSIS.* _Their world is his now, and they will keep swinging at whatever he puts in it._`,
  `🔮✨ *COMPLETE HYPNOSIS.* _Five for five. From here, they fight a battlefield he draws by hand._`,
  `🔮✨ *COMPLETE HYPNOSIS.* _The last sense left standing reports to him too. Nothing they perceive can hurt him again._`,
  `🔮✨ *COMPLETE HYPNOSIS.* _It is done. They will never aim at him again, only at what he allows._`,
]

// ── The blow that DOES find him ─────────────────────────────────────────────
// The hypnosis is a coin-flip until complete (his honest trade: no reduction
// layer at all). When the enemy pierces it, both sides react: the enemy's
// relief, his total lack of concern.
const LANDED_LINES = [
  `👁️ The hypnosis slips once. The blow finds his real body. He notes the inconvenience.`,
  `👁️ This one saw through the edit. The hit lands, and he catalogues the moment.`,
  `👁️ For one swing their senses report true. It will not be encouraged.`,
  `👁️ The blow lands honest. He allows it, the way one allows weather.`,
  `👁️ Their aim finally touches him. He looks at the contact with mild interest.`,
  `👁️ Reality and their senses briefly agree, and the blow lands in the gap.`,
  `👁️ This swing found the real him. The correction is already underway.`,
  `👁️ A clean hit on the man himself. A rare citation in their favour.`,
  `👁️ They struck him through sheer fluke of perception. He files the fluke.`,
  `👁️ The veil parts for exactly one blow. He lets them have it.`,
  `👁️ Their senses win one. He treats it as data.`,
  `👁️ One real hit. The price of owning only four of their senses so far.`,
]

// ── Enemy reaction to the failing fight ─────────────────────────────────────
// Shown occasionally alongside the events above: the emotional beat of
// fighting someone you cannot perceive. Short, reactive, never mechanical.
export const ENEMY_REACTION_LINES = [
  `💬 _They reset their stance, blink hard, and try to trust their eyes again._`,
  `💬 _They check their weapon for blood and find the question no longer makes sense._`,
  `💬 _A pause: they re-aim at the shape that seems most him, knowing the odds._`,
  `💬 _They are starting to swing at where he was, not where he is._`,
  `💬 _Their breathing shortens. The battlefield keeps disagreeing with them._`,
  `💬 _They mutter a count under their breath: what they see, what they trust, the shrinking overlap._`,
  `💬 _The calm on his face is doing more damage than the miss did._`,
  `💬 _They laugh once, without humour, and re-grip their weapon._`,
  `💬 _Their eyes dart for a silhouette that matches the one they keep missing._`,
  `💬 _They have begun to doubt the doubt, which is exactly the loop he wants._`,
  `💬 _Their stance widens: if the eyes lie, then guess, and guess wide._`,
  `💬 _A visible flinch. The fight is now mostly against their own senses._`,
]

/** A one-in-three chance the enemy's reaction rides along with a moment. */
export function maybeEnemyReaction() {
  return Math.random() < 0.34 ? `\n${pick(ENEMY_REACTION_LINES)}` : ''
}

// ── Builders: Kyōka Suigetsu ────────────────────────────────────────────────

/** The misdirect moment: phantom struck, one more sense owed. */
export function kyokaMisdirectLine() {
  return pick(MISDIRECT_LINES)
}

/** The steal itself. senseName is Sight/Hearing/Touch/Smell/Taste. */
export function kyokaSenseLine(senseName, count, max = 5) {
  const pool = SENSE_LINES[senseName] ?? [`Their *${senseName}* goes quiet. He keeps it.`]
  return `🌀 _Kyōka Suigetsu takes their *${senseName}.*_ _(${count}/${max} senses)_\n${pick(pool)}`
}

/** The5/5 moment. */
export function kyokaCompleteLine() {
  return pick(COMPLETE_LINES)
}

/** The blow that pierced the hypnosis and found his real body. */
export function kyokaLandedLine() {
  return pick(LANDED_LINES)
}

// ── Kurohitsugi (Hadō #90) ─────────────────────────────────────────────────
// Two beats: the coffin arriving, then what it did. senses (0..5) tightens
// the copy the same way it tightens the multiplier; execute is the death's-
// door tier where the seal bites hardest.

const KURO_OPEN_LINES = (senses) => senses > 0
  ? [
      `⬛ _Hadō #90. Black coffin. It descends through a sky that was edited to let it in._`,
      `⬛ _Hadō #90. The coffin closes over the space time keeps its receipts in._`,
      `⬛ _Hadō #90. Gravity, time and distance sign off on the paperwork of their death._`,
      `⬛ _Hadō #90. The air itself kneels as the coffin settles over them._`,
    ]
  : [
      `⬛ _Hadō #90. Black coffin. Their senses still mostly work: it will not matter._`,
      `⬛ _Hadō #90. A coffin of folded time drops over the battlefield._`,
      `⬛ _Hadō #90. He gestures once, and something enormous consents to arrive._`,
    ]

const KURO_CLOSE_LINES = (execute) => execute
  ? [
      `⬛ _What was already breaking inside is finished by the distortion._`,
      `⬛ _The seal reads their wounds like a combination, and opens on ruin._`,
      `⬛ _Closer to death means a tighter seal. It closes like a verdict._`,
    ]
  : [
      `⬛ _Time inside the coffin disagrees with time outside it, and wins._`,
      `⬛ _The coffin tidies the battlefield around its edges._`,
      `⬛ _Inside, the arithmetic of their survival is quietly revised._`,
    ]

const KURO_EXECUTE_LINES = [
  `⬛☠️ _There is no version of this where they walk out of the coffin._`,
  `⬛☠️ _The seal completes its sentence._`,
  `⬛☠️ _Nothing escapes the shape of that ending._`,
]

/** The coffin arriving. senses tightens the voice (he owns most of them). */
export function kurohitsugiCastLine(senses = 0) {
  return pick(KURO_OPEN_LINES(senses))
}

/** The crush. execute is true at the death's-door tier (or on a kill). */
export function kurohitsugiImpactLine({ execute = false, kill = false } = {}) {
  if (kill) return pick(KURO_EXECUTE_LINES)
  return pick(KURO_CLOSE_LINES(execute))
}

// ── Hōgyoku (The One Above All) ────────────────────────────────────────────
// The once-per-battle evolution. The awaken line speaks of him; the reaction
// line is the enemy watching the ceiling of the fight leave.

const HOUGYOKU_AWAKEN_LINES = [
  `🔮 _He stops holding the ceiling away from him and simply lets go of it._`,
  `🔮 _Something in his chest agrees to the terms, and the terms are: no more limits._`,
  `🔮 _The Hōgyoku reads the wish he never had to say out loud and grants it anyway._`,
  `🔮 _He relaxes into a shape the fight has no numbers for._`,
  `🔮 _Whatever bound him was a habit, and the habit ends now._`,
  `🔮 _A sound like a bell struck once in a room that is no longer there._`,
]

const HOUGYOKU_ENEMY_REACTION_LINES = [
  `💬 _They take a full step back, and for the first time they measure the fight from underneath it._`,
  `💬 _Their weapon comes up on pure reflex. Reflex will not be enough and they know it._`,
  `💬 _They watched the ceiling of this fight move, and it moved away from them._`,
  `💬 _Whatever he became, their senses refuse to file it under 'enemy' and file it under 'weather'._`,
  `💬 _They look at their own hands, then at him, and the comparison goes badly._`,
  `💬 _Every instinct they own votes to leave. The vote is not binding._`,
  `💬 _They set their stance anyway. It costs them something to do it._`,
]

export function hougyokuAwakenLine() {
  return pick(HOUGYOKU_AWAKEN_LINES)
}

export function hougyokuEnemyReactionLine() {
  return pick(HOUGYOKU_ENEMY_REACTION_LINES)
}

// ── His own swings (classic fight, plugins/attack.js) ──────────────────────
// Used whenever Aizen is the equipped character and the generic pools would
// otherwise narrate. Same signature contract as lib/battle-flavor.js: names
// bolded, damage bolded, no dashes.

const PLAYER_HIT = [
  (n, e, d) => `⚔️ *${n}* steps in and edits the distance. ${e.emoji ?? '👾'} *${e.name}* takes *${d}* for believing it.`,
  (n, e, d) => `🗡️ *${n}* cuts exactly where *${e.name}* will be standing. *${d}* damage.`,
  (n, e, d) => `⚔️ A measured swing from *${n}*. *${e.name}* pays *${d}* for the lesson.`,
  (n, e, d) => `🗡️ The blade arrives before *${e.name}* finishes deciding to dodge. *${d}* damage.`,
  (n, e, d) => `⚔️ *${n}* opens *${e.name}* up for *${d}*, like checking notes in the margin.`,
  (n, e, d) => `⚔️ *${e.name}* blocks the swing *${n}* allowed them to see. The real one lands: *${d}* damage.`,
  (n, e, d) => `🗡️ *${n}* finds the seam in *${e.name}* and takes *${d}* out of it.`,
  (n, e, d) => `⚔️ *${n}* adjusts one small thing about the fight. *${e.name}* bleeds *${d}* for it.`,
  (n, e, d) => `💥 *${n}* drives the point home: *${d}* damage to *${e.name}*.`,
  (n, e, d) => `⚔️ *${e.name}* swings at the wrong him. *${n}* answers the right opening: *${d}* damage.`,
  (n, e, d) => `🗡️ *${n}* cuts *${e.name}* for *${d}*, then tidies the spacing.`,
  (n, e, d) => `⚔️ The exchange ends *${d}* damage in *${n}*'s favour, as exchanges tend to.`,
]

const PLAYER_CRIT = [
  (n, e, d) => `⚡ *CRIT!* *${n}* strikes the *${e.name}* their senses swore was safe. *${d}* damage.`,
  (n, e, d) => `⚡ *CRIT!* *${n}* opens with the true weight of the fight. *${e.name}* wears all *${d}* of it.`,
  (n, e, d) => `⚡ *CRIT!* The blade was always going here. *${e.name}* takes *${d}* for the timeline that didn't happen.`,
  (n, e, d) => `⚡ *CRIT!* *${n}* writes a correction into *${e.name}*, worth *${d}* damage.`,
  (n, e, d) => `⚡ *CRIT!* For one second *${e.name}* sees the real swing. Then *${d}* damage.`,
  (n, e, d) => `⚡ *CRIT!* *${n}* lands the version of this blow *${e.name}* will think about later. *${d}* damage.`,
]

const PLAYER_MISS = [
  (n, e) => `💨 *${n}* cuts where *${e.name}* used to be a second ago. He allows the miss.`,
  (n, e) => `💨 *${e.name}* blunders out of the path of a blow *${n}* hadn't committed to yet.`,
  (n, e) => `💨 The swing from *${n}* was a question. *${e.name}* answered it by accident.`,
  (n, e) => `💨 *${n}* tests the angle and files the result. Nothing lands.`,
  (n, e) => `💨 *${e.name}* dodges a probe. *${n}* measures the dodge.`,
]

const PLAYER_ABSORB = [
  (n, e) => `🛡️ *${e.name}* gets something between themselves and *${n}*'s blade. Temporary.`,
  (n, e) => `🛡️ *${n}* lets the guard spend itself on the obvious blow.`,
  (n, e) => `🛡️ *${e.name}* survives contact with *${n}* behind armour that will not repeat the favour.`,
]

const ENEMY_HIT = [
  (e, d) => `🩸 ${e.emoji ?? '👾'} *${e.name}* connects with a version of him and draws *${d}* for it.`,
  (e, d) => `🩸 ${e.emoji ?? '👾'} *${e.name}* lands *${d}* through sheer volume of swings.`,
  (e, d) => `🩸 *${e.name}* finds flesh on the third guess. *${d}* damage.`,
  (e, d) => `🩸 ${e.emoji ?? '👾'} *${e.name}* scrapes *${d}* off him and calls it progress.`,
  (e, d) => `🩸 *${e.name}* lands *${d}*. He looks at the wound like a note to self.`,
  (e, d) => `🩸 ${e.emoji ?? '👾'} *${e.name}* manages *${d}* damage against the real him. For now.`,
]

const ENEMY_MISS = [
  (e) => `💨 ${e.emoji ?? '👾'} *${e.name}* attacks the him that was standing there, on schedule.`,
  (e) => `💨 ${e.emoji ?? '👾'} *${e.name}* misses, and the battlefield does not say on whose orders.`,
  (e) => `💨 *${e.name}* swings at the wrong second of the same fight.`,
  (e) => `💨 ${e.emoji ?? '👾'} *${e.name}* whiffs at an appointment he kept elsewhere.`,
]

export function aizenPlayerHit(name, enemy, dmg) { return pick(PLAYER_HIT)(name, enemy, dmg) }
export function aizenPlayerCrit(name, enemy, dmg) { return pick(PLAYER_CRIT)(name, enemy, dmg) }
export function aizenPlayerMiss(name, enemy) { return pick(PLAYER_MISS)(name, enemy) }
export function aizenPlayerAbsorbed(name, enemy) { return pick(PLAYER_ABSORB)(name, enemy) }
export function aizenEnemyHit(enemy, dmg) { return pick(ENEMY_HIT)(enemy, dmg) }
export function aizenEnemyMiss(enemy) { return pick(ENEMY_MISS)(enemy) }
