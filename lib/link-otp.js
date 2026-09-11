/**
 * link-otp.js — short-lived codes that prove a Discord/Telegram user owns the
 * Astral character they're trying to link to. Held in memory.
 *
 * Same reasoning as lib/otp-store.js: a code is worthless minutes after it's
 * issued, so persisting it would put a whole-file db.write() in front of a
 * user-triggerable command for no durability benefit. Codes are stored HMAC
 * hashed so a heap dump or stray log can't be replayed into a link.
 *
 * Keyed by the *platform* id (`dc:123`), not the target character — that way
 * one Discord user can only ever have one challenge open, and requesting a
 * second one for a different username silently replaces the first instead of
 * leaving two valid codes alive.
 *
 * Separate from otp-store.js on purpose: that store is keyed by phone and its
 * verify() hands back a JID for the login flow. Overloading it would couple
 * the website's session security to a game command.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import { config } from '../config.js'

const CODE_LENGTH = 6

/** Wrong guesses allowed before the code is burned. */
const MAX_ATTEMPTS = 5

/** How long a code stays valid. Reuses the site's OTP TTL (default 5 min). */
const TTL_MS = config.otpTtlMs

/** A platform id must wait this long between requesting codes. */
const RESEND_COOLDOWN_MS = 60_000

/** Rolling window + ceiling per platform id. */
const REQUEST_WINDOW_MS = 60 * 60_000
const MAX_REQUESTS_PER_WINDOW = 6

/** platformId -> { hash, masterId, username, expiresAt, attempts, createdAt } */
const pending = new Map()

/** platformId -> number[] request timestamps within REQUEST_WINDOW_MS */
const requestLog = new Map()

/**
 * Falls back to a random per-process secret when JWT_SECRET isn't set. These
 * codes never leave this process and never outlive it, so a per-boot secret is
 * sufficient — it means linking still works on a bot-only deploy that has no
 * website configured, instead of throwing on first use.
 */
const secret = config.jwtSecret || randomBytes(32).toString('hex')

function hash(platformId, code) {
  return createHmac('sha256', secret).update(`${platformId}:${code}`).digest('hex')
}

function sweep(now) {
  for (const [key, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(key)
  }
  for (const [key, times] of requestLog) {
    const kept = times.filter(t => now - t < REQUEST_WINDOW_MS)
    if (kept.length) requestLog.set(key, kept)
    else requestLog.delete(key)
  }
}

/** True when a code is currently outstanding for this platform id. */
export function hasPending(platformId) {
  sweep(Date.now())
  return pending.has(String(platformId ?? ''))
}

/** The open challenge's target, for display. Never exposes the code. */
export function peek(platformId) {
  sweep(Date.now())
  const entry = pending.get(String(platformId ?? ''))
  if (!entry) return null
  return {
    username: entry.username,
    masterId: entry.masterId,
    expiresAt: entry.expiresAt,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - entry.attempts),
  }
}

/**
 * Rate-limit gate. Returns { ok: true } or { ok: false, reason, retryAfterMs }
 * with reason 'cooldown' | 'quota'.
 */
export function checkRateLimit(platformId, now = Date.now()) {
  const key = String(platformId ?? '')
  sweep(now)

  const existing = pending.get(key)
  if (existing && now - existing.createdAt < RESEND_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', retryAfterMs: RESEND_COOLDOWN_MS - (now - existing.createdAt) }
  }

  const times = requestLog.get(key) ?? []
  if (times.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldest = Math.min(...times)
    return { ok: false, reason: 'quota', retryAfterMs: REQUEST_WINDOW_MS - (now - oldest) }
  }

  return { ok: true }
}

/**
 * Issues a code binding `platformId` to `masterId`. Returns
 * { code, expiresAt, ttlMs }. The plaintext is returned exactly once — only
 * the digest is kept. Call checkRateLimit() first.
 */
export function issue(platformId, { masterId, username } = {}) {
  const key = String(platformId ?? '')
  if (!key) throw new Error('link-otp: a platform id is required')
  if (!masterId) throw new Error('link-otp: a masterId is required')

  const now = Date.now()
  sweep(now)

  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
  const expiresAt = now + TTL_MS

  pending.set(key, {
    hash: hash(key, code),
    masterId,
    username: username ?? null,
    expiresAt,
    attempts: 0,
    createdAt: now,
  })

  requestLog.set(key, [...(requestLog.get(key) ?? []), now])

  return { code, expiresAt, ttlMs: TTL_MS }
}

/** Drops a pending challenge — used when the notification fails to deliver. */
export function discard(platformId) {
  pending.delete(String(platformId ?? ''))
}

/**
 * Verifies a submitted code. Returns one of:
 *   { ok: true, masterId, username }
 *   { ok: false, reason: 'not_found' | 'expired' | 'too_many_attempts' | 'mismatch', attemptsLeft }
 *
 * A correct code is consumed immediately (single use).
 */
export function verify(platformId, submitted) {
  const key = String(platformId ?? '')
  const now = Date.now()

  // Read before sweeping, so an expired code reports 'expired' rather than
  // decaying into the less useful 'not_found'.
  const entry = pending.get(key)
  sweep(now)

  if (!entry) return { ok: false, reason: 'not_found' }
  if (entry.expiresAt <= now) {
    pending.delete(key)
    return { ok: false, reason: 'expired' }
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts', attemptsLeft: 0 }
  }

  const clean = String(submitted ?? '').replace(/\D+/g, '')
  entry.attempts++

  const expected = Buffer.from(entry.hash, 'hex')
  const actual = Buffer.from(hash(key, clean), 'hex')
  const match = expected.length === actual.length && timingSafeEqual(expected, actual)

  if (!match) {
    return { ok: false, reason: 'mismatch', attemptsLeft: Math.max(0, MAX_ATTEMPTS - entry.attempts) }
  }

  pending.delete(key)
  return { ok: true, masterId: entry.masterId, username: entry.username }
}

/** Introspection for health output — counts only, never contents. */
export function stats() {
  return { pending: pending.size, throttled: requestLog.size, codeLength: CODE_LENGTH, ttlMs: TTL_MS }
}
