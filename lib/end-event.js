/**
 * end-event.js — "The End" limited-time event (the Blue Band arc).
 *
 * LORE
 *   Two weeks after the End was loosed on the world it begins its rampage,
 *   flooding the atmosphere with a concentrated magical air. The air weakens
 *   everyone and drags the weak (level ≤ 50) into a deep sleep. The only
 *   defense is a Blue Band worn in the offhand slot: banded players are
 *   untouched. The air covers Astral Town and every dungeon. After two weeks
 *   the End's own location opens and can be fought; the first server-wide kill
 *   lifts the air for everyone.
 *
 * SHAPE
 *   Pure module (no DB, no I/O) exactly like lib/reborn-engine.js. Every state
 *   change mutates an object handed in; the plugins own the updatePlayer /
 *   updateAllPlayers wrapping that serializes and flushes those mutations (see
 *   lib/player-repo.js). Global event state lives on db.data.endEvent, mirroring
 *   db.data.seasonRuntime (lib/season-engine.js) — ensureEndEvent() lazily
 *   creates it, so no startup migration or main.js change is needed.
 *
 * WHY A CACHED PER-PLAYER WEAKEN FLAG
 *   getEffectiveStat() (lib/effects.js) is the single funnel every combat stat
 *   read passes through, but it takes only an entity — it has no db handle and
 *   so cannot ask "is the event active?". So the weaken is delivered as a plain
 *   per-player boolean, player.endWeakened, that getEffectiveStat multiplies by.
 *   applyEndEventTick() keeps that flag fresh once per command (like the hunger
 *   tick), and it's also refreshed on equip and on event start/end. Monsters
 *   never carry the flag, so the stat engine stays a monster-agnostic no-op.
 */

// ── Tunables ────────────────────────────────────────────────────────────────
/** Multiplicative stat cut applied to every stat while unbanded during the event. */
export const END_WEAKEN_PCT = 0.40
/** Players at or below this level fall asleep; above it they are only weakened. */
export const SLEEP_MAX_LEVEL = 50
/** How long the aura reigns before the End's location opens (2 weeks). */
export const EVENT_DURATION_MS = 14 * 24 * 60 * 60 * 1000
/** How long a Luna drink keeps a sleeping player awake to go get a band. */
export const LUNA_GRACE_MS = 10 * 60 * 1000
/** Per-(giver→target) cooldown between Luna drinks, so it can't be spammed. */
export const LUNA_COOLDOWN_MS = 30 * 60 * 1000
/** The offhand relic that resists the aura. */
export const BLUE_BAND_ID = 'blue_band'
/** The End boss / location ids. */
export const THE_END_BOSS_ID = 'the_end'
export const THE_END_LOCATION_ID = 'the_end'
/** Where the old woman keeps her stall (data/locations.json). */
export const ASTRAL_TOWN_ID = 'astral_town'

// ── Old-lady riddle flavor (shared by plugins/shop.js and plugins/answer.js) ──
export const RIDDLE_QUESTION =
  '👵 The old woman leans close, her eyes clouded but knowing.\n\n' +
  '_"I hear your cry for the band, child. But first — answer me true."_\n\n' +
  '❓ *Are you from this world, young boy?*\n\n' +
  `_Answer honestly with_ *${'{prefix}'}answer <your reply>*.`
export const RIDDLE_CORRECT =
  '👵 _"Souka... your magical energy told me. hohoho."_\n\n' +
  '🧿 She presses a *Blue Band* into your hands.\n' +
  '_Equip it to your offhand with_ *{prefix}equip blue band* _to resist the aura._'
export const RIDDLE_WRONG =
  '👵 _"...is that so. Then you have no need of my band."_ She turns away.\n\n' +
  '🚪 _Her door is closed to you. Travel to a dungeon and return to Astral Town before you ask again._'
export const RIDDLE_ALREADY_BANDED =
  '👵 _"You already carry one, child. Go — others need me more."_'

/** The lockout line shown when a sleeping player tries a blocked command. */
export const END_SLEEP_MSG =
  '😴 *You are lost in the End\'s deep sleep.*\n\n' +
  'The magical air has dragged you under. You can still crawl toward salvation:\n' +
  `• *{prefix}shop buy blue band* — beg the old woman in Astral Town\n` +
  `• *{prefix}answer <reply>* — answer her riddle\n` +
  `• *{prefix}equip blue band* — wake for good once you hold one\n` +
  `• *{prefix}travel* / *{prefix}enter* — stagger elsewhere\n\n` +
  '_Or wait for a Blue Band bearer to give you a Luna drink._'

// ── Server-wide announcements (consumers replace {prefix} / {name}) ──────────
export const END_START_BROADCAST =
  '🌑 *THE SKY HAS TURNED* 🌑\n\n' +
  '_Two weeks ago an Ender Pearl cracked open and something stepped through._\n' +
  '_It has been waiting. It is done waiting._\n\n' +
  '🌫️ *The End has begun its rampage.* A concentrated magical air now floods ' +
  'Astral Town and every dungeon in the world.\n' +
  `• Everyone caught in it is *weakened by ${Math.round(END_WEAKEN_PCT * 100)}%*.\n` +
  `• Anyone *Level ${SLEEP_MAX_LEVEL} or below* is dragged into a *deep sleep*.\n\n` +
  '🧿 *There is one defense: the Blue Band.*\n' +
  'An old woman in Astral Town still keeps a few. She gives them only to those ' +
  'who answer her honestly.\n' +
  '👵 *{prefix}shop buy blue band*\n\n' +
  '🍶 Band-bearers can rouse the sleeping with *{prefix}give-drink luna @player* — ' +
  'ten minutes to run for a band of their own.\n\n' +
  '⏳ In *14 days* the rift where the world sleeps will open, and the End can finally be fought.\n' +
  '☠️ _Set foot in it before then and the aura will kill you where you stand._\n\n' +
  '_{prefix}event — for everything you need to know._'

export const END_DEFEAT_BROADCAST =
  '🌅 *THE AIR IS CLEAR* 🌅\n\n' +
  '🗡️ *{name}* has slain *The End*.\n\n' +
  '_The pressure lifts. The weight goes out of the air. All across Astral, ' +
  'sleepers open their eyes at the same moment and find their strength back in ' +
  'their hands._\n\n' +
  '✅ The aura is gone — no more weakening, no more sleep.\n' +
  '🧿 _Keep your Blue Band. Something else may come through._'

export const END_FORCE_END_BROADCAST =
  '🌅 *THE AIR IS CLEAR* 🌅\n\n' +
  '_Without warning the pressure lifts. The magical air thins to nothing and the ' +
  'rift closes on itself._\n\n' +
  '✅ The End\'s aura is gone — no more weakening, no more sleep.'

const EVENT_DEFAULTS = {
  startedAt: null,   // epoch ms the aura began, or null when the event is off
  defeated: false,   // true once the End has been killed server-wide
  defeatedBy: null,  // player id of the first killer
  defeatedAt: null,  // epoch ms of the first kill
}

// ── Global state (db.data.endEvent) ──────────────────────────────────────────
/** Lazily create + backfill db.data.endEvent, mirroring ensureRuntime(). */
export function ensureEndEvent(db) {
  if (!db.data.endEvent) {
    db.data.endEvent = { ...EVENT_DEFAULTS }
  } else {
    for (const [key, value] of Object.entries(EVENT_DEFAULTS)) {
      if (!(key in db.data.endEvent)) db.data.endEvent[key] = value
    }
  }
  return db.data.endEvent
}

/** Read-only snapshot of the event state. */
export function getEndEvent(db) {
  return { ...ensureEndEvent(db) }
}

/** True while the aura is live (started and the End not yet killed). */
export function isEventActive(db) {
  const e = ensureEndEvent(db)
  return !!e.startedAt && !e.defeated
}

/**
 * endPhase(db) → 'off' | 'longsleep' | 'reckoning'
 *   off       — no event running
 *   longsleep — the first 2 weeks; the End's location is lethal to enter
 *   reckoning — 2 weeks elapsed; the End can finally be fought
 */
export function endPhase(db, now = Date.now()) {
  const e = ensureEndEvent(db)
  if (!e.startedAt || e.defeated) return 'off'
  return now >= e.startedAt + EVENT_DURATION_MS ? 'reckoning' : 'longsleep'
}

/** Epoch ms the End's location opens, or null when the event is off. */
export function endOpensAt(db) {
  const e = ensureEndEvent(db)
  return e.startedAt ? e.startedAt + EVENT_DURATION_MS : null
}

// ── Per-player predicates ─────────────────────────────────────────────────────
/** True if the player has a Blue Band equipped in the offhand slot. */
export function hasBlueBand(player) {
  return player?.equipped?.offhand === BLUE_BAND_ID
}

/** Weakened iff the event is live and the player is unbanded. */
export function isWeakenedByEnd(db, player) {
  return isEventActive(db) && !hasBlueBand(player)
}

/**
 * Asleep iff weakened, weak (level ≤ 50), and not inside a Luna grace window.
 * No stored sleep timer: this is fully derived, so ending the event (flipping
 * db.data.endEvent.defeated) instantly wakes every sleeper with no per-player
 * write.
 */
export function isAsleepByEnd(db, player, now = Date.now()) {
  if (!isWeakenedByEnd(db, player)) return false
  if ((player?.level ?? 1) > SLEEP_MAX_LEVEL) return false
  return now > (player?.endLunaUntil ?? 0)
}

/**
 * applyEndEventTick(db, player) → { asleep, weakened }
 * Refresh the cached weaken flag and report sleep. Call once per command from
 * handler.js inside its updatePlayer, exactly like the hunger tick. Idempotent.
 */
export function applyEndEventTick(db, player, now = Date.now()) {
  const weakened = isWeakenedByEnd(db, player)
  if (player.endWeakened !== weakened) player.endWeakened = weakened
  // Drop a stale grace stamp once it can no longer matter (banded up, or event
  // over), so it never lingers on the save.
  if (!weakened && player.endLunaUntil) player.endLunaUntil = null
  // "Travel to a dungeon and return before you ask again" — enforced here, on
  // the one hook that sees every command: the old woman's door unlocks the
  // moment the player is observed outside Astral Town.
  if (player.blueBandRiddle?.state === 'locked' && player.location && player.location !== ASTRAL_TOWN_ID) {
    player.blueBandRiddle = null
  }
  const asleep =
    weakened && (player.level ?? 1) <= SLEEP_MAX_LEVEL && now > (player.endLunaUntil ?? 0)
  return { asleep, weakened }
}

/**
 * endStatusBadge(db, player) → string | null
 * The one profile/stats status line, so both screens agree. Null when the
 * event is off (nothing to show).
 */
export function endStatusBadge(db, player, now = Date.now()) {
  if (!isEventActive(db)) return null
  if (hasBlueBand(player)) return "🧿 _Blue Band equipped — the End's aura can't touch you._"
  if (isAsleepByEnd(db, player, now)) {
    return '😴 _Asleep — the End\'s aura has you. A Blue Band bearer must wake you._'
  }
  return `⚠️ _Weakened by the End's aura (−${Math.round(END_WEAKEN_PCT * 100)}%). Equip a Blue Band._`
}

// ── Luna rescue ───────────────────────────────────────────────────────────────
/**
 * giveLuna(db, giver, target) → { ok, reason?, wakeUntil?, retryAt? }
 * A Blue Band bearer wakes a sleeper for LUNA_GRACE_MS. Mutates BOTH the giver
 * (per-target cooldown stamp) and the target (grace window), so the caller must
 * wrap this in updateAllPlayers and look both players up from the users map.
 */
export function giveLuna(db, giver, target, now = Date.now()) {
  if (!isEventActive(db)) return { ok: false, reason: 'inactive' }
  if (!giver) return { ok: false, reason: 'no_giver' }
  if (!hasBlueBand(giver)) return { ok: false, reason: 'no_band' }
  if (!target) return { ok: false, reason: 'no_target' }
  if (target.id === giver.id) return { ok: false, reason: 'self' }
  if (!isAsleepByEnd(db, target, now)) return { ok: false, reason: 'not_asleep' }

  giver.lunaGiven = giver.lunaGiven ?? {}
  const last = giver.lunaGiven[target.id] ?? 0
  if (now < last + LUNA_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', retryAt: last + LUNA_COOLDOWN_MS }
  }
  giver.lunaGiven[target.id] = now
  target.endLunaUntil = now + LUNA_GRACE_MS
  return { ok: true, wakeUntil: target.endLunaUntil }
}

// ── Lifecycle (mutate db.data.endEvent; call inside updateAllPlayers) ──────────
/** Owner start: stamp the clock and (re)arm the event. */
export function startEndEvent(db, now = Date.now()) {
  const e = ensureEndEvent(db)
  e.startedAt = now
  e.defeated = false
  e.defeatedBy = null
  e.defeatedAt = null
  return e
}

/**
 * claimEndDefeat(db, playerId) → boolean — atomic first-writer-wins, mirroring
 * claimMeiForPlayer(). Returns true for the ONE call that flips the event from
 * active to defeated (the server-wide first kill), false if already down or
 * never started. Must run inside an updatePlayer/updateAllPlayers mutator.
 */
export function claimEndDefeat(db, playerId, now = Date.now()) {
  const e = ensureEndEvent(db)
  if (!e.startedAt || e.defeated) return false
  e.defeated = true
  e.defeatedBy = playerId
  e.defeatedAt = now
  return true
}

/** Owner kill-switch: force the event down (lifts the aura for everyone). */
export function forceEndEvent(db, now = Date.now()) {
  const e = ensureEndEvent(db)
  if (!e.startedAt) return { ok: false, reason: 'not_started' }
  if (e.defeated) return { ok: false, reason: 'already_over' }
  e.defeated = true
  e.defeatedBy = e.defeatedBy ?? 'owner'
  e.defeatedAt = e.defeatedAt ?? now
  return { ok: true }
}

/**
 * Owner test hook: pull startedAt back so the End's location opens now.
 * Returns { ok, reason? } — 'not_started' if the event isn't running.
 */
export function skipEndEventWait(db, now = Date.now()) {
  const e = ensureEndEvent(db)
  if (!e.startedAt || e.defeated) return { ok: false, reason: 'not_started' }
  e.startedAt = now - EVENT_DURATION_MS
  return { ok: true }
}

/**
 * syncEndWeakenForAll(db, users) → boolean (true if anything changed)
 *
 * One-shot sweep of the cached weaken flag over every save. The per-command tick
 * keeps a player's own flag fresh, but a player who never types can still be
 * *read* by someone else (PvP, party combat) — so the start and the end of the
 * event sweep everyone at once instead of leaving a stale flag behind. Call
 * inside updateAllPlayers, after the lifecycle flip.
 */
export function syncEndWeakenForAll(db, users) {
  const active = isEventActive(db)
  let changed = false
  for (const player of Object.values(users ?? {})) {
    if (!player || typeof player !== 'object') continue
    const weakened = active && !hasBlueBand(player)
    if (player.endWeakened !== weakened) {
      player.endWeakened = weakened
      changed = true
    }
    if (!weakened && player.endLunaUntil) {
      player.endLunaUntil = null
      changed = true
    }
  }
  return changed
}
