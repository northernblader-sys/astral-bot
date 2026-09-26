/**
 * newbie-dungeon.js — the newcomer lane: Newcomer's Hollow.
 *
 * The problem this exists for: a fresh level-1 character in this game is naked,
 * has no Solars, and the Entry Tower's first floors are tuned against a player
 * who already owns gear (see REGULAR_MONSTER_BALANCE's gearHpAllowance in
 * lib/combat-engine.js). New players therefore died, stalled, or went and did
 * something else — the "some feel weak" report. Nothing in the game paid them
 * enough XP to fix that quickly, because a single kill is worth a few percent of
 * a level by design.
 *
 * So this is a genuinely different lane, not a reskin of Entry Tower:
 *
 *   • LEVEL-GATED, 1 to 30. At 31 the door closes (maxLevel in
 *     data/locations.json). It is a starter lane, not a farm: leaving it open
 *     would make it the best XP-per-effort in the game for anyone under the
 *     cap, and it would stop being a place new players can actually get a floor.
 *   • ITS OWN ALLOWANCE, measured in FLOORS. 50 floors a day — exactly one full
 *     lap of the Hollow's 50 floors. This is separate from lib/dungeon-limits.js's
 *     run counter on purpose: an Entry Tower run is 100 floors, so charging a
 *     newcomer one of their 7 runs to climb 50 easy floors would be a worse deal
 *     than the dungeon they were just told to leave. The floor allowance resets
 *     at the same midnight, so players still have one clock to remember.
 *   • NO STAMINA COST. Stamina is the game's pacing currency: 30 a day, one per
 *     encounter. Charging it here would cap a newcomer at 30 of their promised
 *     50 floors and make the allowance above unreachable — and the players this
 *     lane exists for would run dry on the one route built for them. The floor
 *     allowance is the pacing instead. Every other dungeon still charges.
 *   • NO GROUP SLOT, NO TRAVEL COST. The shared 2-players-per-group dungeon
 *     slot exists so a few accounts can't hold a *shared* room all day; the
 *     Hollow isn't shared, it's the tutorial, and gating it behind that cap
 *     would lock newcomers out of the one place built for them while other
 *     people climb. Travel is free because they have no money.
 *   • PAID FOR REAL (lib/xp-regulator.js LOCATION_REWARD_MULT.newbie_hollow):
 *     boosted XP and Solars per kill so ~50 floors is a real evening of levels,
 *     plus ordinary item drops and ordinary kill fame — no special currency, no
 *     hand-outs, nothing that has to be taken away later.
 *
 * Tunable without a code change:
 *   NEWBIE_DUNGEON_FLOORS_PER_DAY   (default 50)
 *   NEWBIE_DUNGEON_MAX_LEVEL        (default 30)
 */
import { locations as allLocations } from './game-data.js'

export const NEWBIE_LOCATION_ID = 'newbie_hollow'

function envInt(name, fallback) {
  const raw = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** Floors a newcomer may climb in the Hollow per day. One full lap by default. */
export const NEWBIE_FLOORS_PER_DAY = envInt('NEWBIE_DUNGEON_FLOORS_PER_DAY', 50)

/**
 * Level ceiling for the Hollow. Read from data/locations.json when the dungeon
 * declares one (`maxLevel`), so the gate and the dungeon list can never
 * disagree; the env var overrides it for testing/tuning.
 */
export const NEWBIE_MAX_LEVEL = envInt(
  'NEWBIE_DUNGEON_MAX_LEVEL',
  allLocations.find(l => l.id === NEWBIE_LOCATION_ID)?.maxLevel ?? 30,
)

/** Midnight tonight, local time — the same boundary stamina and runs reset on. */
export function nextResetAt(now = Date.now()) {
  const d = new Date(now)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

export function isNewbieLocation(locId) {
  return locId === NEWBIE_LOCATION_ID
}

/** True when this player has outgrown the Hollow and can no longer enter. */
export function isNewbieGraduated(player, maxLevel = NEWBIE_MAX_LEVEL) {
  return (player?.level ?? 1) > maxLevel
}

/**
 * Returns the player's Hollow floor counter, rolling it over if the reset time
 * has passed. Mutates in place (call inside an updatePlayer mutator) and is safe
 * on every account that predates the field.
 */
export function refreshNewbieFloors(player, now = Date.now()) {
  const state = player.newbieHollow ?? { used: 0, resetAt: 0 }
  if (!state.resetAt || now >= state.resetAt) {
    state.used = 0
    state.resetAt = nextResetAt(now)
  }
  player.newbieHollow = state
  return state
}

/**
 * Read-only view of the counter: same numbers as refreshNewbieFloors, without
 * writing to the player. Display paths (the dungeon list, `.enter`'s header)
 * run outside an updatePlayer mutator and must not edit the record they were
 * handed — a stale-looking 0 is impossible here because an expired window is
 * reported as a fresh one.
 */
export function peekNewbieFloors(player, now = Date.now()) {
  const state = player?.newbieHollow
  if (!state?.resetAt || now >= state.resetAt) {
    return { used: 0, resetAt: nextResetAt(now) }
  }
  return state
}

export function newbieFloorsRemaining(player, now = Date.now()) {
  const state = refreshNewbieFloors(player, now)
  return Math.max(0, NEWBIE_FLOORS_PER_DAY - state.used)
}

/** Call once a floor in the Hollow has actually been granted. */
export function consumeNewbieFloor(player, now = Date.now()) {
  const state = refreshNewbieFloors(player, now)
  state.used += 1
  return state
}

function formatResetIn(resetAt, now = Date.now()) {
  const ms = Math.max(0, resetAt - now)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.ceil((ms % 3_600_000) / 60_000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** Shown when the day's 50 floors are gone. */
export function newbieFloorLimitMessage(player, prefix = '.', now = Date.now()) {
  const state = peekNewbieFloors(player, now)
  return (
    `🕯️ *That's your fifty for today.*\n` +
    `─────────────────────\n` +
    `You've climbed *${state.used}/${NEWBIE_FLOORS_PER_DAY}* floors of the Hollow today.\n` +
    `⏳ The stairs reset in *${formatResetIn(state.resetAt, now)}* _(midnight)_.\n\n` +
    `_Rest. Come back tomorrow — or try *${prefix}quest*, *${prefix}work* and *${prefix}daily* ` +
    `meanwhile. None of those use Hollow floors._`
  )
}

/** Short status line, so the count is never a surprise. */
export function newbieFloorsLine(player, prefix = '.', now = Date.now()) {
  const state = peekNewbieFloors(player, now)
  const left = Math.max(0, NEWBIE_FLOORS_PER_DAY - state.used)
  return `🕯️ Hollow floors today: *${state.used}/${NEWBIE_FLOORS_PER_DAY}* · *${left}* left`
}

/**
 * Shown to a level-31+ player who tries to go back in — the graduation message.
 * Points them at the dungeon they should be on rather than just refusing: the
 * next dungeon whose band their level actually falls into.
 */
export function newbieGraduatedMessage(player, prefix = '.') {
  const level = player?.level ?? 1
  // The End is excluded deliberately: it is a world-event finale that appears in
  // the map only while the rift is open (lib/end-event.js), so pointing a
  // graduate at it would hand them a command that usually answers "there is
  // nothing there".
  const candidates = allLocations.filter(l =>
    l.type === 'dungeon' && l.id !== NEWBIE_LOCATION_ID && l.id !== 'the_end' && l.levelRange)
  const next =
    // The band their level actually falls in, lowest first (several overlap).
    candidates
      .filter(l => level >= l.levelRange[0] && level <= l.levelRange[1])
      .sort((a, b) => a.levelRange[0] - b.levelRange[0])[0]
    // Past every band: the hardest one they are still eligible for.
    ?? candidates
      .filter(l => l.levelRange[0] <= level)
      .sort((a, b) => b.levelRange[0] - a.levelRange[0])[0]
    ?? null

  return (
    `🎓 *You've outgrown the Hollow.*\n` +
    `─────────────────────\n` +
    `The Hollow only takes adventurers up to *Level ${NEWBIE_MAX_LEVEL}* — you're *Level ${level}* now, ` +
    `and the things down there are past being a challenge for you.\n\n` +
    (next
      ? `👉 Next stop: *${next.name}* — *${prefix}enter ${next.id}*\n`
      : `👉 Try *${prefix}travel* for the full map.\n`) +
    `_Everything the Hollow dropped is still yours. You just can't go back for seconds._`
  )
}
