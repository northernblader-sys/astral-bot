/**
 * pvp-engine.js — the helper layer around duels. No I/O, no db access.
 *
 * plugins/pvp.js owns the turn loop and the win/loss resolution; this module
 * owns everything *around* it: the win/loss record, the rating ladder, the
 * pre-fight scouting read, and the "what should I press right now" hint.
 *
 * DESIGN LINE, DELIBERATE: nothing in here feeds back into damage. Every
 * export either reads state (record, rating, matchup) or produces advice
 * (suggestMove, threatLines). Guild perks in lib/guild-engine.js are the
 * same — they change payouts and slots, never the combat math. That keeps
 * lib/combat-engine.js the single source of truth for how hard a hit lands,
 * so a duel between two players is decided by build and by the turn they
 * take, not by who has read more of the codebase.
 *
 * RATING: Elo, K=32, floored at 100 so a losing streak can't drive anyone
 * negative and make the leaderboard nonsense. Provisional players (fewer
 * than PLACEMENT_DUELS duels) are marked rather than hidden — being new is
 * information the leaderboard should show, not suppress.
 */

import { getPrimaryStat, applyDefense, calcPlayerHitChance, hpBar } from './combat-engine.js'
import { getEffectiveStat } from './effects.js'

/** Everyone starts here. A duel against an equal is worth ±16 from this. */
export const BASE_RATING = 1000
export const RATING_FLOOR = 100
export const K_FACTOR = 32
export const PLACEMENT_DUELS = 5

/** Rating bands, purely for display — the number itself is the truth. */
export const RANKS = [
  { id: 'unranked', name: 'Unranked', emoji: '⬜', min: -Infinity },
  { id: 'bronze',   name: 'Bronze',   emoji: '🥉', min: 0 },
  { id: 'silver',   name: 'Silver',   emoji: '🥈', min: 950 },
  { id: 'gold',     name: 'Gold',     emoji: '🥇', min: 1100 },
  { id: 'platinum', name: 'Platinum', emoji: '💠', min: 1250 },
  { id: 'diamond',  name: 'Diamond',  emoji: '💎', min: 1400 },
  { id: 'astral',   name: 'Astral',   emoji: '🌟', min: 1600 },
]

/**
 * Backfills player.pvp onto accounts that predate the ladder. Same contract
 * as ensureHome() in lib/housing-engine.js — shape only, no invented
 * history: rating starts at BASE_RATING because that is the ladder's
 * definition of "no result yet", not because we're crediting them wins.
 */
export function ensurePvp(player) {
  const pvp = player.pvp ?? (player.pvp = {})
  if (typeof pvp.wins !== 'number') pvp.wins = 0
  if (typeof pvp.losses !== 'number') pvp.losses = 0
  if (typeof pvp.rating !== 'number') pvp.rating = BASE_RATING
  if (typeof pvp.peak !== 'number') pvp.peak = pvp.rating
  if (typeof pvp.streak !== 'number') pvp.streak = 0
  if (typeof pvp.bestStreak !== 'number') pvp.bestStreak = 0
  if (typeof pvp.solarsWon !== 'number') pvp.solarsWon = 0
  if (typeof pvp.solarsLost !== 'number') pvp.solarsLost = 0
  if (typeof pvp.lastOpponent !== 'string') pvp.lastOpponent = null
  if (typeof pvp.lastResult !== 'string') pvp.lastResult = null
  if (typeof pvp.lastAt !== 'number') pvp.lastAt = null
  return pvp
}

export function duelsPlayed(player) {
  const pvp = player?.pvp
  return (pvp?.wins ?? 0) + (pvp?.losses ?? 0)
}

export function isProvisional(player) {
  return duelsPlayed(player) < PLACEMENT_DUELS
}

export function ratingOf(player) {
  return player?.pvp?.rating ?? BASE_RATING
}

/** The band a rating sits in. Provisional players show as Unranked. */
export function rankFor(player) {
  if (isProvisional(player)) return RANKS[0]
  const rating = ratingOf(player)
  let band = RANKS[1]
  for (const r of RANKS) if (r.min !== -Infinity && rating >= r.min) band = r
  return band
}

export function winRate(player) {
  const played = duelsPlayed(player)
  if (!played) return 0
  return Math.round(((player.pvp?.wins ?? 0) / played) * 100)
}

/** Standard Elo expectation — the odds `a` beats `b` on rating alone. */
export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400))
}

/**
 * The rating swing a result produces, from the winner's point of view.
 * Always at least 1 so beating someone far below you still registers —
 * a zero-point win reads as a bug to players even when the math is right.
 */
export function ratingDelta(winnerRating, loserRating) {
  const expected = expectedScore(winnerRating, loserRating)
  return Math.max(1, Math.round(K_FACTOR * (1 - expected)))
}

/**
 * Applies a win in place. `delta` comes from ratingDelta() and is computed by
 * the caller from BOTH ratings *before* either side is written — otherwise
 * whichever player is updated first would skew the other's swing.
 */
export function recordWin(player, opponentName, delta, solars = 0) {
  const pvp = ensurePvp(player)
  pvp.wins += 1
  pvp.rating = Math.max(RATING_FLOOR, pvp.rating + delta)
  pvp.peak = Math.max(pvp.peak, pvp.rating)
  pvp.streak = pvp.streak > 0 ? pvp.streak + 1 : 1
  pvp.bestStreak = Math.max(pvp.bestStreak, pvp.streak)
  pvp.solarsWon += Math.max(0, solars)
  pvp.lastOpponent = opponentName ?? null
  pvp.lastResult = 'win'
  pvp.lastAt = Date.now()
  return pvp
}

/** Applies a loss in place. Negative streaks count losses in a row. */
export function recordLoss(player, opponentName, delta, solars = 0) {
  const pvp = ensurePvp(player)
  pvp.losses += 1
  pvp.rating = Math.max(RATING_FLOOR, pvp.rating - delta)
  pvp.streak = pvp.streak < 0 ? pvp.streak - 1 : -1
  pvp.solarsLost += Math.max(0, solars)
  pvp.lastOpponent = opponentName ?? null
  pvp.lastResult = 'loss'
  pvp.lastAt = Date.now()
  return pvp
}

/** "W3" / "L2" / "—" — compact streak label for cards and leaderboards. */
export function streakLabel(player) {
  const streak = player?.pvp?.streak ?? 0
  if (streak > 0) return `W${streak}`
  if (streak < 0) return `L${Math.abs(streak)}`
  return '—'
}

// ── Scouting ──────────────────────────────────────────────────────────────

/**
 * A single comparable number for a fighter. NOT used by combat — it exists
 * so `.scout` can say "you're behind" in one figure. Weighted toward the
 * things that actually decide a duel: how hard you hit, how long you last.
 */
export function powerScore(player) {
  const atk = getPrimaryStat(player)
  const def = getEffectiveStat(player, 'def')
  const hp = player.maxHp ?? 0
  const mp = player.maxMp ?? 0
  return Math.round(atk * 6 + def * 3 + hp * 1.2 + mp * 0.4 + (player.level ?? 1) * 5)
}

/**
 * One side of a matchup: the average damage `attacker` lands on `defender`
 * with a basic attack, and how many of those it takes to finish them.
 *
 * Uses the real applyDefense() and calcPlayerHitChance() rather than a
 * parallel estimate, so the numbers `.scout` prints are the numbers the duel
 * will actually produce. Crit is folded in as its expected value instead of
 * being rolled — a scouting report should be the average case, not one
 * sample. Rounds turns UP: a defender left on 1 HP still needs another hit.
 */
export function offenseAgainst(attacker, defender) {
  const raw = getPrimaryStat(attacker)
  const critChance = Math.min(0.95, 0.05 + (attacker.stats?.lck ?? 0) * 0.002)
  const expectedRaw = raw * (1 + critChance * 0.5)
  const perHit = applyDefense(Math.floor(expectedRaw), getEffectiveStat(defender, 'def'))
  const hitChance = calcPlayerHitChance(attacker, defender)
  const perTurn = Math.max(1, Math.round(perHit * hitChance))
  const turnsToKill = Math.max(1, Math.ceil((defender.hp ?? defender.maxHp ?? 1) / perTurn))
  return { perHit, hitChance, perTurn, turnsToKill }
}

/**
 * The full two-sided read used by `.scout`. `edge` is the honest headline:
 * whoever needs fewer turns to finish the other wins the race, and the
 * challenger acting first is what breaks a tie — that first-strike advantage
 * is real in plugins/pvp.js's turn model, so the report says so.
 */
export function matchup(viewer, target) {
  const yours = offenseAgainst(viewer, target)
  const theirs = offenseAgainst(target, viewer)
  const diff = theirs.turnsToKill - yours.turnsToKill
  let edge
  if (diff > 1) edge = 'strong'
  else if (diff === 1) edge = 'slight'
  else if (diff === 0) edge = 'even'
  else if (diff === -1) edge = 'against'
  else edge = 'heavy'
  return {
    yours, theirs, edge,
    powerYou: powerScore(viewer),
    powerThem: powerScore(target),
    ratingOdds: Math.round(expectedScore(ratingOf(viewer), ratingOf(target)) * 100),
  }
}

export const EDGE_LINE = {
  strong:  '🟢 *You have the edge* — you drop them well before they drop you.',
  slight:  '🟩 *Slightly in your favour* — you win the race by a turn.',
  even:    '🟨 *Dead even* — whoever moves first probably takes it.',
  against: '🟧 *Slightly against you* — they win the race by a turn.',
  heavy:   '🔴 *Badly against you* — you need skills, shields, or a level or two.',
}

// ── In-duel helpers ───────────────────────────────────────────────────────

/**
 * Every move the player could take this turn, each tagged usable or not and
 * why. This is the fix for the single worst thing about duelling by chat:
 * `.pvp skill <name>` needs a name you cannot see, so players guessed, ate
 * the "you don't know that skill" reply, and lost tempo for a typo.
 *
 * Takes resolved skill/ability lists rather than reaching for game-data
 * itself, keeping this module free of imports the check script would have
 * to stub.
 */
export function moveOptions(player, knownSkills, equippedAbilities, currentTurn) {
  const moves = [{ id: 'attack', kind: 'attack', name: 'Attack', cost: 0, usable: true, note: 'always available' }]

  for (const skill of knownSkills ?? []) {
    const cost = skill.mpCost ?? 0
    const affordable = (player.mp ?? 0) >= cost
    moves.push({
      id: skill.id, kind: 'skill', name: skill.name, cost,
      usable: affordable,
      note: affordable ? `${cost} MP` : `needs ${cost} MP, you have ${player.mp ?? 0}`,
      // See lib/combat-engine.js's calcPlayerDamage() doc comment: skill
      // objects don't carry a top-level `multiplier` — it lives at
      // effects[0].multiplier. Reading skill.multiplier here was always
      // undefined, so every skill tied at the `?? 1` fallback and
      // suggestMove()'s "best skill" sort below was effectively picking
      // array order, not the actual strongest option.
      multiplier: skill.multiplier ?? skill.effects?.[0]?.multiplier ?? 1,
    })
  }

  const cooldowns = player.battleState?.abilityCooldowns ?? {}
  for (const ability of equippedAbilities ?? []) {
    if (ability.type !== 'active') {
      moves.push({ id: ability.id, kind: 'passive', name: ability.name, cost: 0, usable: false, note: 'passive — already applying' })
      continue
    }
    const readyAt = cooldowns[ability.id] ?? 0
    const ready = (currentTurn ?? 1) >= readyAt
    moves.push({
      id: ability.id, kind: 'ability', name: ability.name, cost: 0,
      usable: ready,
      note: ready ? 'ready' : `${readyAt - (currentTurn ?? 1)} turn(s) cooldown`,
    })
  }

  moves.push({ id: 'defend', kind: 'defend', name: 'Defend', cost: 0, usable: true, note: '+MP, next hit halved' })
  return moves
}

/**
 * A one-line recommendation. Reads the board the way a player would rather
 * than optimising it: nearly dead means brace, capped MP means spend it, an
 * opponent one hit from death means swing. Advice only — nothing here is
 * enforced, and ignoring it is a legitimate way to play.
 */
export function suggestMove(player, opponent, moves) {
  const hpPct = (player.hp ?? 0) / Math.max(1, player.maxHp ?? 1)
  const oppPct = (opponent.hp ?? 0) / Math.max(1, opponent.maxHp ?? 1)
  const readyAbility = moves.find(m => m.kind === 'ability' && m.usable)
  const bestSkill = moves
    .filter(m => m.kind === 'skill' && m.usable)
    .sort((a, b) => (b.multiplier ?? 1) - (a.multiplier ?? 1))[0]

  if (oppPct <= 0.2) {
    const finisher = readyAbility ?? bestSkill
    return finisher
      ? `🎯 *${opponent.name}* is nearly down — finish it with *${finisher.name}*.`
      : `🎯 *${opponent.name}* is nearly down — a plain attack should end it.`
  }
  if (hpPct <= 0.25) {
    return `🛡️ You're low. *Defend* halves the next hit and gives MP back — surviving a turn beats trading one.`
  }
  if (readyAbility) return `✨ *${readyAbility.name}* is off cooldown — best value you have this turn.`
  if (bestSkill && (player.mp ?? 0) >= (player.maxMp ?? 0) * 0.6) {
    return `⚔️ MP is healthy — spend it on *${bestSkill.name}*.`
  }
  if (!bestSkill && (player.mp ?? 0) < (player.maxMp ?? 0) * 0.3) {
    return `🔋 MP is low and nothing's affordable — *Defend* to bank some back.`
  }
  return `⚔️ Nothing special available — a basic *attack* is the efficient play.`
}

/** One side's line for statusBoard() below — swaps to Yoriichi's own HP
 * bar when her cat form is active, since the owner's own hp is
 * deliberately pinned at 0 for the rest of the fight while she's the one
 * actually still standing (see lib/character-abilities.js's cat-form doc
 * comment) — showing "0/maxHp" there would read as already-lost. */
function sideLine(entity, label) {
  const cat = entity.battleState?.yoriichiCatFormActive
  if (cat) {
    return (
      `${label} *${entity.name}*: 🐈‍⬛ _Yoriichi is fighting in their place_\n` +
      `   ${hpBar(cat.hp, cat.maxHp)} _(${cat.hp}/${cat.maxHp} cat-form HP)_\n` +
      `💧 MP: ${entity.mp}/${entity.maxMp}`
    )
  }
  return (
    `${label} *${entity.name}*: ${hpBar(entity.hp, entity.maxHp)} _(${entity.hp}/${entity.maxHp})_\n` +
    `💧 MP: ${entity.mp}/${entity.maxMp}`
  )
}

/** The shared HP/MP board both `.pvp status` and the scout card print. */
export function statusBoard(you, them) {
  return `${sideLine(you, '❤️')}\n\n${sideLine(them, '💙')}`
}

/** Active effects as a readable line, or '' when clean. */
export function effectLine(player) {
  const effects = player.activeEffects ?? []
  if (!effects.length) return ''
  return effects.map(e => `${e.type}(${e.remaining})`).join(' · ')
}

// ── Stale duels ───────────────────────────────────────────────────────────

/**
 * How long an opponent may sit on their turn before the waiting player can
 * claim the win with `.pvp claim`.
 *
 * This closes the pillar's one genuinely stuck state. A duel writes
 * `inBattle = true` to BOTH players, and only pvpConclude() clears it — so
 * if one side simply walks away mid-duel, the other is locked out of every
 * command that checks inBattle, permanently, with no command that can free
 * them. There is no sweep to add here on purpose: a timestamp compared on
 * read needs no scheduler, survives restarts, and can't fire against a
 * player who is mid-message. Same reasoning as the crop readyAt model in
 * lib/housing-engine.js.
 */
export const TURN_TIMEOUT_MS = 10 * 60 * 1000

/** Milliseconds since the last move in this duel (or since it started). */
export function idleMs(battleState, now = Date.now()) {
  const last = battleState?.lastMoveAt ?? battleState?.startedAt ?? now
  return Math.max(0, now - last)
}

/** True once the waiting player is entitled to claim the win. */
export function isStale(battleState, now = Date.now()) {
  return idleMs(battleState, now) >= TURN_TIMEOUT_MS
}

/** "4m" / "1h 2m" — used for both cooldowns and idle timers. */
export function formatDuration(ms) {
  if (ms <= 0) return 'now'
  const mins = Math.ceil(ms / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${m}m`
}



