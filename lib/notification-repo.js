/**
 * notification-repo.js — persistent per-player notifications, the backing
 * store for the website's notification box (the bell in the top-right nav).
 *
 * Lives at db.data.notifications, NOT on the player record, for two reasons:
 *   1. Notifications churn constantly and would bloat every player object
 *      that plugins read on every single command.
 *   2. They are capped and pruned independently of player data (see
 *      MAX_PER_PLAYER / MAX_AGE_MS below) — losing an old "you levelled up"
 *      must never risk touching the record that holds someone's inventory.
 *
 * CONCURRENCY: db.data.notifications is not db.data.users, so updatePlayer()
 * can't be used. Every mutation here goes through updateAllPlayers()'s
 * mutator instead — that's the same shared runExclusive write queue every
 * other db mutation uses (see lib/player-repo.js's long comment), so a push
 * can never interleave with, or be clobbered by, a sweep. This mirrors how
 * lib/season-engine.js's claimMeiForPlayer() mutates db.data.seasonRuntime.
 *
 * Anything in the bot can call pushNotification(db, jid, {...}) and it shows
 * up in the player's bell on the site within one poll (~30s).
 */
import { updateAllPlayers } from './player-repo.js'

/** Hard cap per player — oldest are dropped first. */
const MAX_PER_PLAYER = 50

/** Anything older than this is pruned on the next write for that player. */
const MAX_AGE_MS = 30 * 24 * 60 * 60_000 // 30 days

/**
 * Known notification kinds. `kind` drives the icon + accent colour on the
 * site; an unknown kind falls back to the neutral 'system' styling rather
 * than breaking the render, so adding one here is optional.
 */
export const KINDS = [
  'system',   // generic bot/site announcements
  'security', // new sign-in, session revoked
  'season',   // battle pass tier, season start/end
  'premium',  // subscription granted / expiring / expired
  'reward',   // gems, solars, items credited
  'battle',   // pvp result, boss kill, death, war/raid events
  'social',   // guild, trade, fame milestone
  'empire',   // citizenship, empire shop sales, empire sold
]

function ensureStore(db) {
  if (!db.data.notifications || typeof db.data.notifications !== 'object') {
    db.data.notifications = {}
  }
  return db.data.notifications
}

function prune(list, now) {
  const fresh = list.filter(n => now - (n.at ?? 0) < MAX_AGE_MS)
  fresh.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return fresh.slice(0, MAX_PER_PLAYER)
}

let idCounter = 0
function nextId(now) {
  idCounter = (idCounter + 1) % 100000
  return `n_${now.toString(36)}_${idCounter.toString(36)}`
}

/**
 * Pushes one notification for `playerId` (a WhatsApp JID). Resolves to the
 * created notification. Safe to call from anywhere — never throws on a
 * missing store, never rejects on a disk-write failure (updateAllPlayers
 * swallows those by design and logs instead).
 *
 *   await pushNotification(db, player.id, {
 *     kind: 'season', title: 'Tier 12 unlocked', body: 'Claim it with .season claim',
 *   })
 */
export async function pushNotification(db, playerId, { kind = 'system', title, body = '', meta = null } = {}) {
  if (!playerId || !title) return null
  const now = Date.now()
  const entry = buildNotification({ kind, title, body, meta }, now)

  await updateAllPlayers(db, () => {
    writeNotification(db, playerId, entry, now)
    return true
  })

  return entry
}

/** The entry shape, in one place, so sync and async writers can't drift. */
function buildNotification({ kind = 'system', title, body = '', meta = null } = {}, now = Date.now()) {
  return {
    id:    nextId(now),
    kind:  KINDS.includes(kind) ? kind : 'system',
    title: String(title).slice(0, 120),
    body:  String(body ?? '').slice(0, 400),
    meta:  meta ?? null,
    at:    now,
    read:  false,
  }
}

/** Unshift + prune, with no write-queue call of its own. */
function writeNotification(db, playerId, entry, now) {
  const store = ensureStore(db)
  const list = Array.isArray(store[playerId]) ? store[playerId] : []
  list.unshift(entry)
  store[playerId] = prune(list, now)
}

/**
 * The synchronous half of pushNotification, for use INSIDE an existing
 * updateAllPlayers / updatePlayer mutator, where awaiting pushNotification
 * would re-enter the same serialized write queue and deadlock. Same entry
 * shape, same prune, same ordering; the caller's own mutator carries the write.
 * Returns the entry, or null if there was nothing worth storing.
 */
export function pushNotificationSync(db, playerId, payload = {}, now = Date.now()) {
  if (!playerId || !payload?.title) return null
  const entry = buildNotification(payload, now)
  writeNotification(db, playerId, entry, now)
  return entry
}

/** Pushes the same notification to many players in ONE queued write. */
export async function pushNotificationToMany(db, playerIds, payload) {
  const ids = [...new Set((playerIds ?? []).filter(Boolean))]
  if (!ids.length) return 0
  const now = Date.now()

  await updateAllPlayers(db, () => {
    ensureStore(db)
    // Same `now` for every recipient so the batch sorts as one event.
    for (const playerId of ids) pushNotificationSync(db, playerId, payload, now)
    return true
  })

  return ids.length
}

/** Read-only: every stored notification for a player, newest first. */
export function listNotifications(db, playerId) {
  const store = db.data?.notifications
  const list = store && Array.isArray(store[playerId]) ? store[playerId] : []
  return [...list].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
}

/** Read-only: how many stored notifications are still unread. */
export function unreadCount(db, playerId) {
  return listNotifications(db, playerId).filter(n => !n.read).length
}

/** Marks one notification read. Returns true if it existed and changed. */
export async function markRead(db, playerId, notificationId) {
  let changed = false
  await updateAllPlayers(db, () => {
    const store = ensureStore(db)
    const list = store[playerId]
    if (!Array.isArray(list)) return false
    const hit = list.find(n => n.id === notificationId)
    if (!hit || hit.read) return false
    hit.read = true
    changed = true
    return true
  })
  return changed
}

/** Marks every notification for a player read. Returns how many changed. */
export async function markAllRead(db, playerId) {
  let count = 0
  await updateAllPlayers(db, () => {
    const store = ensureStore(db)
    const list = store[playerId]
    if (!Array.isArray(list)) return false
    for (const n of list) {
      if (!n.read) { n.read = true; count++ }
    }
    return count > 0
  })
  return count
}

/* ── derived-alert acknowledgement ────────────────────────────────────────
   Derived alerts (buildSelfAlerts) aren't stored — they're recomputed from
   player state on every GET /api/notifications with `read: false` hardcoded.
   That made "Mark read" a no-op for them: the client cleared the dot, the
   next 30s poll rebuilt them unread, and the dot came straight back.

   They can't just be stored, because the whole point is that they vanish on
   their own once the underlying thing is dealt with. So instead we remember
   the *signature* of what was acknowledged. A signature is kind + title +
   body, which means:
     - acknowledging "Stamina full" silences that alert,
     - but if it later reads "Stamina full (32)" the text changed, so it's
       genuinely new information and surfaces again.

   Stored under db.data.notificationAcks[playerId] as {sig: ackedAtMs}. Acks
   are swept whenever they outlive MAX_AGE_MS so this can't grow forever. */

function ensureAckStore(db) {
  if (!db.data.notificationAcks || typeof db.data.notificationAcks !== 'object') {
    db.data.notificationAcks = {}
  }
  return db.data.notificationAcks
}

function ensureDismissStore(db) {
  if (!db.data.notificationDismissals || typeof db.data.notificationDismissals !== 'object') {
    db.data.notificationDismissals = {}
  }
  return db.data.notificationDismissals
}

/** Stable identity for a derived alert — see the block comment above. */
export function derivedSignature(alert) {
  return [alert?.kind ?? '', alert?.title ?? '', alert?.body ?? ''].join(' ')
}

/** Read-only: the set of derived signatures this player has acknowledged. */
export function listDerivedAcks(db, playerId) {
  const store = db.data?.notificationAcks
  const acks = store && typeof store[playerId] === 'object' ? store[playerId] : null
  if (!acks) return new Set()
  const now = Date.now()
  return new Set(Object.keys(acks).filter(sig => now - (acks[sig] ?? 0) < MAX_AGE_MS))
}

/**
 * Marks the given derived alerts dismissed — the bell hides them entirely
 * until the underlying state changes the signature.
 *
 * Separate from ackDerived: acking only stops an alert lighting the bell, and
 * the alert stays visible because the work behind it is still outstanding.
 * "Clear" means "get these off my screen", and without this the panel could
 * only ever clear stored notifications — so a player whose bell was all
 * derived alerts pressed Clear, watched nothing happen, and reasonably
 * concluded the entries were hardcoded.
 *
 * Dismissals expire on the same MAX_AGE_MS sweep as acks.
 */
export async function dismissDerived(db, playerId, alerts) {
  if (!playerId || !Array.isArray(alerts) || !alerts.length) return 0
  let count = 0
  await updateAllPlayers(db, () => {
    const store = ensureDismissStore(db)
    const hidden = store[playerId] && typeof store[playerId] === 'object' ? store[playerId] : {}
    const now = Date.now()

    for (const alert of alerts) {
      const sig = derivedSignature(alert)
      if (!hidden[sig]) count++
      hidden[sig] = now
    }

    for (const [sig, at] of Object.entries(hidden)) {
      if (now - (at ?? 0) >= MAX_AGE_MS) delete hidden[sig]
    }

    store[playerId] = hidden
    return count > 0
  })
  return count
}

/** Read-only: the set of derived signatures this player has dismissed. */
export function listDerivedDismissals(db, playerId) {
  const store = db.data?.notificationDismissals
  const hidden = store && typeof store[playerId] === 'object' ? store[playerId] : null
  if (!hidden) return new Set()
  const now = Date.now()
  return new Set(Object.keys(hidden).filter(sig => now - (hidden[sig] ?? 0) < MAX_AGE_MS))
}

/**
 * Marks the given derived alerts acknowledged. `alerts` is the same array
 * buildSelfAlerts() returns. Returns how many were newly acknowledged.
 */
export async function ackDerived(db, playerId, alerts) {
  if (!playerId || !Array.isArray(alerts) || !alerts.length) return 0
  let count = 0
  await updateAllPlayers(db, () => {
    const store = ensureAckStore(db)
    const acks = store[playerId] && typeof store[playerId] === 'object' ? store[playerId] : {}
    const now = Date.now()

    for (const alert of alerts) {
      const sig = derivedSignature(alert)
      if (!acks[sig]) count++
      acks[sig] = now
    }

    // Sweep expired acks on write so a long-lived player doesn't accumulate
    // a signature for every phrasing an alert has ever had.
    for (const [sig, at] of Object.entries(acks)) {
      if (now - (at ?? 0) >= MAX_AGE_MS) delete acks[sig]
    }

    store[playerId] = acks
    return count > 0
  })
  return count
}

/** Deletes one notification. Returns true if it existed. */
export async function deleteNotification(db, playerId, notificationId) {
  let changed = false
  await updateAllPlayers(db, () => {
    const store = ensureStore(db)
    const list = store[playerId]
    if (!Array.isArray(list)) return false
    const next = list.filter(n => n.id !== notificationId)
    if (next.length === list.length) return false
    store[playerId] = next
    changed = true
    return true
  })
  return changed
}

/** Deletes every notification for a player. Returns how many were removed. */
export async function clearNotifications(db, playerId) {
  let count = 0
  await updateAllPlayers(db, () => {
    const store = ensureStore(db)
    const list = store[playerId]
    if (!Array.isArray(list) || !list.length) return false
    count = list.length
    store[playerId] = []
    return true
  })
  return count
}
