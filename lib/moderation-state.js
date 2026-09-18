/**
 * moderation-state.js — persistent state for the moderation features that
 * need to outlive a restart: mutes, AFK, and polls.
 *
 * Same read→mutate→write shape as lib/group-settings.js (flat JSON, no
 * lowdb) because this data is small, per-group, and unrelated to player
 * records. Backed by data/moderation.json.
 *
 * Deliberately NOT in here: the antispam sliding windows and the antidelete
 * message cache. Both are hot-path, per-message, and only meaningful for a
 * few seconds — writing them to disk on every inbound message would turn a
 * chatty group into a write storm for data that is worthless after a
 * restart anyway. Those live in memory in lib/message-cache.js.
 */
import { runtimeUrl } from './runtime-paths.js'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'

const STATE_PATH = runtimeUrl('moderation.json')

const EMPTY = { mutes: {}, afk: {}, polls: {}, storySlots: {} }

let cache = null          // in-memory mirror, so hot reads don't hit disk
let writeChain = Promise.resolve()

async function readAll() {
  if (cache) return cache
  if (!existsSync(STATE_PATH)) {
    await mkdir(dirname(STATE_PATH.pathname ?? STATE_PATH), { recursive: true }).catch(() => {})
    await writeFile(STATE_PATH, JSON.stringify(EMPTY, null, 2) + '\n', 'utf8')
    cache = structuredClone(EMPTY)
    return cache
  }
  try {
    const raw = await readFile(STATE_PATH, 'utf8')
    const parsed = raw.trim() ? JSON.parse(raw) : {}
    cache = { ...structuredClone(EMPTY), ...parsed }
  } catch {
    // Corrupt file — fail safe with empty state rather than crashing the
    // handler on every single message.
    cache = structuredClone(EMPTY)
  }
  return cache
}

/**
 * Mutations are serialised through a promise chain. Every one of these is
 * triggered by an inbound message, and two admins muting people in the same
 * tick would otherwise read the same snapshot and one write would clobber
 * the other.
 */
function update(mutatorFn) {
  writeChain = writeChain.then(async () => {
    const all = await readAll()
    const result = (await mutatorFn(all)) ?? all
    cache = result
    await writeFile(STATE_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8')
    return result
  }).catch(() => readAll())
  return writeChain
}

// ── Mutes ────────────────────────────────────────────────────────────────
// Shape: mutes[groupJid][userJid] = { until: number|null, by, at }
// until === null means indefinite.

/**
 * Returns the live mute record for a user, or null. Expired mutes are
 * treated as absent here and swept lazily by clearExpiredMutes() rather
 * than being written back on every read — a read happens on every group
 * message, a write must not.
 */
export async function getMute(groupJid, userJid) {
  const all = await readAll()
  const rec = all.mutes?.[groupJid]?.[userJid]
  if (!rec) return null
  if (rec.until != null && Date.now() >= rec.until) return null
  return rec
}

export async function setMute(groupJid, userJid, { until = null, by = null } = {}) {
  return update(all => {
    all.mutes[groupJid] ??= {}
    all.mutes[groupJid][userJid] = { until, by, at: Date.now() }
    return all
  })
}

export async function clearMute(groupJid, userJid) {
  let existed = false
  await update(all => {
    if (all.mutes?.[groupJid]?.[userJid]) {
      delete all.mutes[groupJid][userJid]
      existed = true
      if (!Object.keys(all.mutes[groupJid]).length) delete all.mutes[groupJid]
    }
    return all
  })
  return existed
}

/** Every non-expired mute in a group, as [userJid, record] pairs. */
export async function listMutes(groupJid) {
  const all = await readAll()
  const group = all.mutes?.[groupJid] ?? {}
  return Object.entries(group).filter(([, r]) => r.until == null || Date.now() < r.until)
}

/** Drops expired mute records. Called from the mute list/unmute paths. */
export async function clearExpiredMutes() {
  return update(all => {
    for (const [gid, users] of Object.entries(all.mutes ?? {})) {
      for (const [uid, rec] of Object.entries(users)) {
        if (rec.until != null && Date.now() >= rec.until) delete users[uid]
      }
      if (!Object.keys(users).length) delete all.mutes[gid]
    }
    return all
  })
}

// ── AFK ──────────────────────────────────────────────────────────────────
// Shape: afk[userJid] = { reason, since }
// Keyed by user, not by group: being away is a property of the person, so
// an AFK set in one group answers on their behalf everywhere.

export async function getAfk(userJid) {
  const all = await readAll()
  return all.afk?.[userJid] ?? null
}

export async function setAfk(userJid, reason) {
  return update(all => {
    all.afk[userJid] = { reason: reason || null, since: Date.now() }
    return all
  })
}

/** Clears AFK and returns the record that was cleared, or null. */
export async function clearAfk(userJid) {
  const all = await readAll()
  const rec = all.afk?.[userJid]
  if (!rec) return null
  await update(a => { delete a.afk[userJid]; return a })
  return rec
}

// ── Polls ────────────────────────────────────────────────────────────────
// Shape: polls[groupJid] = { question, options: [string], votes: {userJid: idx},
//                            by, at, closed }
// One active poll per group — a second .poll replaces the first, which is
// what people actually expect from a chat poll.

export async function getPoll(groupJid) {
  const all = await readAll()
  return all.polls?.[groupJid] ?? null
}

export async function setPoll(groupJid, poll) {
  return update(all => { all.polls[groupJid] = poll; return all })
}

export async function castVote(groupJid, userJid, optionIndex) {
  let ok = false
  await update(all => {
    const poll = all.polls?.[groupJid]
    if (poll && !poll.closed && optionIndex >= 0 && optionIndex < poll.options.length) {
      poll.votes[userJid] = optionIndex
      ok = true
    }
    return all
  })
  return ok
}

export async function closePoll(groupJid) {
  let poll = null
  await update(all => {
    if (all.polls?.[groupJid]) {
      all.polls[groupJid].closed = true
      poll = all.polls[groupJid]
    }
    return all
  })
  return poll
}

// ── Story Mode slots ─────────────────────────────────────────────────────
// Shape: storySlots[groupJid] = { userJid, lastActivityAt }
// One slot per group — only the holder can run .story enter/start or answer
// a pending choice; everyone else is told to wait. Mirrors the "one active
// poll per group" shape above, except a second person does NOT replace the
// first here — see claimStorySlot()'s ok:false path. lastActivityAt is
// bumped on every .story enter/start and every resolved choice reply
// (plugins/story.js), and read by main.js's story-slot timeout sweep: no
// activity for STORY_SLOT_TIMEOUT_MS kicks the holder and frees the slot.

/** The live slot for a group, or null if empty. Doesn't check timeout — that's the sweep's job. */
export async function getStorySlot(groupJid) {
  const all = await readAll()
  return all.storySlots?.[groupJid] ?? null
}

/**
 * Claims the slot for userJid if it's empty or already theirs (refreshing
 * lastActivityAt either way); refuses if someone else holds it.
 * Returns { ok: true } on success, { ok: false, holderJid } on refusal.
 */
export async function claimStorySlot(groupJid, userJid) {
  let result = null
  await update(all => {
    const existing = all.storySlots[groupJid]
    if (existing && existing.userJid !== userJid) {
      result = { ok: false, holderJid: existing.userJid }
      return all
    }
    all.storySlots[groupJid] = { userJid, lastActivityAt: Date.now() }
    result = { ok: true }
    return all
  })
  return result
}

/**
 * Bumps lastActivityAt for the current holder — called after a choice reply
 * resolves, so answering in time keeps the slot alive without needing a
 * fresh .story start. No-ops (returns false) if userJid isn't the holder,
 * which shouldn't happen in practice since findPendingChoice already scopes
 * to that player, but keeps this function honest either way.
 */
export async function touchStorySlot(groupJid, userJid) {
  let touched = false
  await update(all => {
    const existing = all.storySlots?.[groupJid]
    if (existing && existing.userJid === userJid) {
      existing.lastActivityAt = Date.now()
      touched = true
    }
    return all
  })
  return touched
}

/** Frees the slot outright — called on volume completion and by the timeout sweep. Returns the record that was cleared, or null. */
export async function releaseStorySlot(groupJid) {
  const all = await readAll()
  const rec = all.storySlots?.[groupJid] ?? null
  if (!rec) return null
  await update(a => { delete a.storySlots[groupJid]; return a })
  return rec
}

/** Every group's slot, as [groupJid, record] pairs — read by the timeout sweep. */
export async function listStorySlots() {
  const all = await readAll()
  return Object.entries(all.storySlots ?? {})
}

