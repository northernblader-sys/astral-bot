/**
 * lib/echidna-child.js - the state machine for Echidna's one granted child.
 *
 * Echidna grants her holder ONE child via the sanctuary rite
 * (plugins/echidna.js's `.echidna ritual`). The child lives in the holder's
 * house/empire as `player.echidnaChild`:
 *
 *   { name: string|null, bornAt: epoch ms, visits: number, lastVisitAt: epoch ms }
 *
 * Growth is age + attention: every visit (`.echidna child`) adds a chunk of
 * effective age on top of real time, on a cooldown so it can't be spammed.
 * Stages:
 *
 *   newborn  ->  infant (12h effective age)  ->  child (36h)  ->  grown (72h)
 *
 * In battle the child steals beside its mother - see childBattleBonus():
 * a stage-scaled bonus on top of the Gospel tithe, plus a gem chance from
 * 'child' stage up. The AI (plugins/echidna.js) reads the same record so
 * Echidna always knows whether she is a mother, of whom, and how tall they
 * are getting.
 *
 * No dependencies on purpose - everything here is plain math on plain
 * objects, which is what makes it unit-testable headlessly.
 */

export const CHILD_STAGES = ['newborn', 'infant', 'child', 'grown']

// Effective-age thresholds, in HOURS, for each stage transition.
export const CHILD_STAGE_HOURS = {
  infant: 12,
  child: 36,
  grown: 72,
}

// Each visit counts as this many hours of effective growth.
export const VISIT_BOOST_HOURS = 6

// Visits closer together than this do nothing (the child needs to miss you).
export const VISIT_COOLDOWN_MS = 30 * 60 * 1000

// The small gift the child presses into the holder's hand on a visit, per
// stage. Newborns have nothing to give but noise.
export const VISIT_GIFT_SOLARS = {
  newborn: 0,
  infant: 100,
  child: 250,
  grown: 500,
}

// Stage emojis for copy.
export const CHILD_STAGE_EMOJI = {
  newborn: '👶',
  infant: '🍼',
  child: '🧒',
  grown: '🧑‍🎓',
}

/** True when the player record carries a child of Echidna. */
export function hasChild(player) {
  return Boolean(player?.echidnaChild?.bornAt)
}

/**
 * childEffectiveAgeHours(child, now?) - real age plus VISIT_BOOST_HOURS per
 * visit. Pure; used by the stage computation and the status readouts.
 */
export function childEffectiveAgeHours(child, now = Date.now()) {
  if (!child?.bornAt) return 0
  const realHours = Math.max(0, (now - child.bornAt) / 3_600_000)
  return realHours + (Number(child.visits) || 0) * VISIT_BOOST_HOURS
}

/**
 * getChildStage(child, now?) -> 'newborn'|'infant'|'child'|'grown'
 * Falls back to null for a missing record rather than throwing - a malformed
 * save must never take a battle turn down.
 */
export function getChildStage(child, now = Date.now()) {
  if (!child?.bornAt) return null
  const hours = childEffectiveAgeHours(child, now)
  if (hours >= CHILD_STAGE_HOURS.grown) return 'grown'
  if (hours >= CHILD_STAGE_HOURS.child) return 'child'
  if (hours >= CHILD_STAGE_HOURS.infant) return 'infant'
  return 'newborn'
}

/** Hours of effective age left until the NEXT stage (0 when grown). */
export function hoursToNextStage(child, now = Date.now()) {
  const stage = getChildStage(child, now)
  if (!stage || stage === 'grown') return 0
  const next = stage === 'newborn' ? CHILD_STAGE_HOURS.infant
    : stage === 'infant' ? CHILD_STAGE_HOURS.child
    : CHILD_STAGE_HOURS.grown
  return Math.max(0, next - childEffectiveAgeHours(child, now))
}

/** The child's name, or a soft default until the holder names them. */
export function childName(child) {
  const n = String(child?.name ?? '').trim()
  return n || 'the little one'
}

/**
 * childBattleBonus(child, now?) -> { hasChild, stage, solarsPct, gemChance, line }
 * What the child adds when Echidna's Gospel lands in battle. Scales with
 * stage; a missing child returns an inert record so callers never branch.
 * The line is only set when the child actually adds something, so callers
 * can render it unconditionally.
 */
export function childBattleBonus(child, now = Date.now()) {
  const stage = getChildStage(child, now)
  const name = childName(child)
  if (!stage) return { hasChild: false, stage: null, solarsPct: 0, gemChance: 0, line: '' }

  const table = {
    newborn: { solarsPct: 0.04, gemChance: 0 },
    infant:  { solarsPct: 0.08, gemChance: 0 },
    child:   { solarsPct: 0.12, gemChance: 0.15 },
    grown:   { solarsPct: 0.18, gemChance: 0.30 },
  }
  const rec = table[stage]
  const lines = {
    newborn: `${CHILD_STAGE_EMOJI.newborn} _From the folds of her sleeve, a newborn's tiny hand closes around a stray coin and drags it over to you. ${name} cannot do much more yet - but that is a start._`,
    infant: `${CHILD_STAGE_EMOJI.infant} _${name} toddles across the battlefield, pockets already jingling, and dumps a handful of stolen coin at your feet before scampering back to Echidna._`,
    child: `${CHILD_STAGE_EMOJI.child} *Little Gospel awakens:* _${name} mirrors the mother - while Echidna's shadow works the front, the child works the linings._`,
    grown: `${CHILD_STAGE_EMOJI.grown} *Little Gospel, perfected:* _${name} moves like a second shadow. By the time the enemy feels the loss, the family has already split it._`,
  }
  return { hasChild: true, stage, solarsPct: rec.solarsPct, gemChance: rec.gemChance, line: lines[stage] }
}

/**
 * visitChild(player, now?) -> { ok, reason, stageBefore, stage, gift, grewUp }
 * Applies one growth visit: respects the cooldown, bumps visits, computes
 * any stage-up that happened, and reports the gift solars for the caller to
 * credit (this function only mutates the child record, never the wallet).
 */
export function visitChild(player, now = Date.now()) {
  const child = player?.echidnaChild
  if (!child?.bornAt) return { ok: false, reason: 'no_child' }
  if (child.lastVisitAt && now - child.lastVisitAt < VISIT_COOLDOWN_MS) {
    const mins = Math.ceil((VISIT_COOLDOWN_MS - (now - child.lastVisitAt)) / 60000)
    return { ok: false, reason: 'cooldown', mins }
  }
  const stageBefore = getChildStage(child, now)
  child.visits = (Number(child.visits) || 0) + 1
  child.lastVisitAt = now
  const stage = getChildStage(child, now)
  const gift = VISIT_GIFT_SOLARS[stage] ?? 0
  return { ok: true, stageBefore, stage, grewUp: stage !== stageBefore, gift }
}

// Characters that break WhatsApp markdown/layout when they sneak into a
// display name. Stripped, not rejected.
const CHILD_NAME_STRIP_RE = /[\u0000-\u001f|*_~`]/g

/**
 * nameChild(player, rawName) -> { ok, reason?, name? }
 * Validates and writes the child's name: 1-24 visible characters after the
 * markdown/control strip.
 */
export function nameChild(player, rawName) {
  if (!player?.echidnaChild?.bornAt) return { ok: false, reason: 'no_child' }
  const name = String(rawName ?? '').replace(CHILD_NAME_STRIP_RE, '').trim()
  if (!name) return { ok: false, reason: 'empty' }
  if (name.length > 24) return { ok: false, reason: 'too_long' }
  player.echidnaChild.name = name
  return { ok: true, name }
}

/**
 * describeChild(child, now?) - one-line status for cards and the AI prompt.
 */
export function describeChild(child, now = Date.now()) {
  if (!child?.bornAt) return null
  const stage = getChildStage(child, now)
  const ageH = childEffectiveAgeHours(child, now)
  return {
    name: childName(child),
    stage,
    emoji: CHILD_STAGE_EMOJI[stage],
    effectiveAgeHours: Math.floor(ageH),
    visits: Number(child.visits) || 0,
    hoursToNext: hoursToNextStage(child, now),
  }
}
