/**
 * message-cache.js — in-memory, per-message state for antidelete and
 * antispam.
 *
 * Explicitly NOT persisted (unlike lib/moderation-state.js): both structures
 * are written on literally every inbound group message and are worthless
 * after a restart. Persisting them would mean a disk write per message.
 *
 * Both are bounded. An unbounded Map keyed by message id in a busy group is
 * a memory leak with a slow fuse, so the cache evicts oldest-first at a hard
 * cap and the spam windows drop entries that fall out of the time window.
 */

// ── Antidelete: recent messages, so a deletion can be reposted ───────────
const MAX_CACHED = 800          // ~a few hours of a busy group
const CACHE_TTL_MS = 60 * 60 * 1000

/** id -> { sender, from, body, at, media } */
const messages = new Map()

/**
 * Remembers a message so antidelete can repost it. Insertion order in a Map
 * is stable, so evicting the first key evicts the oldest.
 */
export function rememberMessage(id, record) {
  if (!id) return
  messages.set(id, { ...record, at: Date.now() })
  while (messages.size > MAX_CACHED) {
    const oldest = messages.keys().next().value
    messages.delete(oldest)
  }
}

/**
 * Finds every currently-cached message id from `userJid` in `groupJid`.
 * Used by antichannel's kick action to clean up more than just the single
 * triggering forward — a Channel spammer rarely sends just one. Does not
 * remove entries from the cache itself (that's takeMessage's job, called
 * per-id by the caller once each delete actually goes through); this is a
 * read-only lookup over the same Map antidelete already maintains, so it
 * only ever finds messages still within antidelete's own MAX_CACHED/
 * CACHE_TTL_MS window, never a full account history.
 */
export function findMessagesFrom(groupJid, userJid) {
  const ids = []
  for (const [id, rec] of messages) {
    if (rec.sender === groupJid && rec.from === userJid) ids.push(id)
  }
  return ids
}

/** Pulls a remembered message and removes it — a delete only fires once. */
export function takeMessage(id) {
  if (!id) return null
  const rec = messages.get(id)
  if (!rec) return null
  messages.delete(id)
  if (Date.now() - rec.at > CACHE_TTL_MS) return null
  return rec
}

// ── Antispam: rolling per-user, per-group message windows ────────────────
/** `${group}|${user}` -> [{ at, text }] */
const windows = new Map()

/**
 * Records a message and reports whether it breaches the group's spam rule.
 *
 * Two separate breaches count, because they are two different behaviours:
 *   - flood     — `count` messages of any content inside `windowSec`
 *   - duplicate — the same text sent `count` times inside `windowSec`
 *
 * Returns { spam, kind, hits } — `spam` false when nothing tripped.
 */
export function recordForSpam(groupJid, userJid, text, { count = 5, windowSec = 10 } = {}) {
  const key = `${groupJid}|${userJid}`
  const now = Date.now()
  const cutoff = now - windowSec * 1000

  const list = (windows.get(key) ?? []).filter(e => e.at > cutoff)
  list.push({ at: now, text: String(text ?? '').trim().toLowerCase() })
  windows.set(key, list)

  // Keep the map from growing forever in a group where thousands of people
  // each send one message: prune whole entries that are fully stale.
  if (windows.size > 5000) {
    for (const [k, v] of windows) {
      if (!v.length || v[v.length - 1].at < now - 60_000) windows.delete(k)
    }
  }

  if (list.length >= count) {
    return { spam: true, kind: 'flood', hits: list.length }
  }

  // Duplicates trip at a flat 3, independent of `count`. Scaling this with
  // the flood count (count/2) meant a group that loosened the flood rule to
  // 30 needed 15 identical messages before anything happened — by then it's
  // not detection. Repeating yourself three times is spam at any setting.
  // Capped by `count` so the duplicate rule can never be stricter than the
  // flood rule an admin deliberately set.
  const last = list[list.length - 1].text
  if (last) {
    const dupes = list.filter(e => e.text === last).length
    if (dupes >= Math.min(3, count)) {
      return { spam: true, kind: 'duplicate', hits: dupes }
    }
  }

  return { spam: false }
}

/** Wipes a user's window — called after a spam action so they start clean. */
export function resetSpamWindow(groupJid, userJid) {
  windows.delete(`${groupJid}|${userJid}`)
}

// ── Antispam rate-limit ban (hard "N messages in T seconds" rule) ─────────
// A SEPARATE, deliberately un-tunable window from the flood/duplicate one
// above. This one counts EVERY message (text, sticker, media — whatever
// reaches the scan), not just text, and trips the auto-ban in
// moderation-scan.js. Kept in its own Map so its per-message push can't
// corrupt the flood window's counts (both are keyed `${group}|${user}` and
// the scan touches them on the same message).
/** `${group}|${user}` -> [at, at, ...] timestamps */
const rateWindows = new Map()

/**
 * Records one message from a user and reports whether they've now sent
 * `count` messages within the last `windowSec` seconds — the burst rule that
 * triggers the antispam auto-ban.
 *
 * Returns true on the message that breaches the limit (e.g. the 2nd message
 * inside 2 seconds), false otherwise.
 */
export function recordForRateBan(groupJid, userJid, { count = 2, windowSec = 2 } = {}) {
  const key = `${groupJid}|${userJid}`
  const now = Date.now()
  const cutoff = now - windowSec * 1000

  const list = (rateWindows.get(key) ?? []).filter(at => at > cutoff)
  list.push(now)
  rateWindows.set(key, list)

  // Same unbounded-growth guard as the flood window: in a huge group where
  // thousands each send one message, prune whole entries that are fully stale.
  if (rateWindows.size > 5000) {
    for (const [k, v] of rateWindows) {
      if (!v.length || v[v.length - 1] < now - 60_000) rateWindows.delete(k)
    }
  }

  return list.length >= count
}

/** Wipes a user's rate window — called right after an auto-ban fires. */
export function resetRateBan(groupJid, userJid) {
  rateWindows.delete(`${groupJid}|${userJid}`)
}

// ── Antispam strike counter (for the optional kick) ──────────────────────
/** `${group}|${user}` -> { strikes, at } */
const strikes = new Map()
const STRIKE_TTL_MS = 10 * 60 * 1000

export function addStrike(groupJid, userJid) {
  const key = `${groupJid}|${userJid}`
  const rec = strikes.get(key)
  if (!rec || Date.now() - rec.at > STRIKE_TTL_MS) {
    strikes.set(key, { strikes: 1, at: Date.now() })
    return 1
  }
  rec.strikes += 1
  rec.at = Date.now()
  return rec.strikes
}

export function clearStrikes(groupJid, userJid) {
  strikes.delete(`${groupJid}|${userJid}`)
}
