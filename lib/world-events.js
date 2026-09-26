/**
 * lib/world-events.js — the registry `.event` reads to decide what to show.
 *
 * ADDING A NEW EVENT: append one entry to WORLD_EVENTS below. Order matters —
 * the LAST entry is treated as the newest event. `.event` then:
 *
 *   1. shows whichever event is live right now (newest start wins if several);
 *   2. otherwise shows the NEWEST registered event, whatever its state —
 *      "not started yet", "running", or "ended". An older finished event (The
 *      End) never hides a newer one just because the newer one hasn't been
 *      started yet.
 *
 * Each entry only needs:
 *   key        stable id, also accepted as a name in `.event start <name>`
 *   name       display name
 *   aliases    extra names the owner can type
 *   state(db)  → { startedAt: number|null, active: boolean }
 *
 * Rendering and owner controls stay in plugins/event.js so this file has no
 * plugin imports and stays trivially testable.
 */
import { getGuardianEvent, isGuardianActive, GUARDIAN } from './guardian-event.js'
import { getEndEvent, isEventActive } from './end-event.js'

export const WORLD_EVENTS = [
  {
    key: 'end',
    name: 'The End',
    aliases: ['theend', 'the end', 'endevent', 'blueband', 'blue band'],
    state(db) {
      const e = getEndEvent(db)
      return { startedAt: e.startedAt ?? null, active: isEventActive(db) }
    },
  },
  {
    key: 'guardian',
    name: GUARDIAN.name ?? 'Guardian of the Innocent',
    aliases: ['goti', 'guardian of the innocent', 'guardianevent', GUARDIAN.id].filter(Boolean),
    state(db, now = Date.now()) {
      const e = getGuardianEvent(db)
      return { startedAt: e.startedAt ?? null, active: isGuardianActive(db, now) }
    },
  },
  // ↑ newest event goes LAST.
]

export const WORLD_EVENT_MAP = Object.fromEntries(WORLD_EVENTS.map(ev => [ev.key, ev]))

/** Resolve a typed name ("guardian", "the end", "goti"...) to a registry key. */
export function findWorldEvent(query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return null
  return WORLD_EVENTS.find(ev =>
    ev.key === q ||
    ev.name.toLowerCase() === q ||
    ev.aliases.some(a => a.toLowerCase() === q),
  )?.key ?? null
}

/** The newest event in the registry — the default target for owner controls. */
export function newestWorldEventKey() {
  return WORLD_EVENTS[WORLD_EVENTS.length - 1]?.key ?? null
}

/**
 * Which event `.event` should show right now.
 * Live events first (newest start wins), otherwise the newest registered one.
 */
export function featuredWorldEventKey(db, now = Date.now()) {
  const live = WORLD_EVENTS
    .map((ev, order) => ({ key: ev.key, order, ...ev.state(db, now) }))
    .filter(ev => ev.active)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.order - a.order)
  if (live.length) return live[0].key
  return newestWorldEventKey()
}
