/**
 * otp-store.js — short-lived login codes for the website, held in memory.
 *
 * Deliberately NOT persisted to db.json:
 *   • A login code is worthless 5 minutes after it's issued, so durability
 *     buys nothing — but writing one to disk on every login attempt would
 *     put a whole-file db.write() (lowdb rewrites everything, see
 *     lib/player-repo.js) in front of a rate-limited public endpoint. That's
 *     a free amplification lever for anyone spamming /api/auth/request-otp.
 *   • Losing every pending code on restart is the correct behaviour: the
 *     user just taps "resend".
 *
 * Codes are stored HASHED (HMAC-SHA256 with the JWT secret), so a heap dump
 * or an accidental log of this map can't be replayed into a login. Only the
 * digest is kept — the plaintext exists just long enough to be DM'd.
 *
 * Everything is keyed by a normalized phone (digits only, no +).
 */
import { createHmac, randomInt, timingSafeEqual } from 'crypto'

const CODE_LENGTH = 6

/** Wrong-code guesses allowed before the code is burned. */
const MAX_ATTEMPTS = 5

/** A phone must wait this long between requesting codes. */
const RESEND_COOLDOWN_MS = 45_000

/** Rolling window + ceiling for how many codes one phone may request. */
const REQUEST_WINDOW_MS = 60 * 60_000
const MAX_REQUESTS_PER_WINDOW = 6

/** Same, per source IP — stops one host farming codes for many numbers. */
const IP_WINDOW_MS = 15 * 60_000
const MAX_REQUESTS_PER_IP = 20

/** phone -> { hash, expiresAt, attempts, createdAt, jid } */
const pending = new Map()

/** phone -> number[] of request timestamps within REQUEST_WINDOW_MS */
const requestLog = new Map()

/** ip -> number[] of request timestamps within IP_WINDOW_MS */
const ipLog = new Map()

let secret = null

/** Called once by the API server at boot. Required before any other call. */
export function initOtpStore(hmacSecret) {
  if (!hmacSecret) throw new Error('otp-store: a secret is required')
  secret = hmacSecret
}

function hash(phone, code) {
  return createHmac('sha256', secret).update(`${phone}:${code}`).digest('hex')
}

function sweep(now) {
  for (const [phone, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(phone)
  }
  for (const [phone, times] of requestLog) {
    const kept = times.filter(t => now - t < REQUEST_WINDOW_MS)
    if (kept.length) requestLog.set(phone, kept)
    else requestLog.delete(phone)
  }
  for (const [ip, times] of ipLog) {
    const kept = times.filter(t => now - t < IP_WINDOW_MS)
    if (kept.length) ipLog.set(ip, kept)
    else ipLog.delete(ip)
  }
}

/**
 * Normalizes user-typed phone input to bare digits (E.164 without the +).
 * Accepts "+234 706 230 1848", "0706 230 1848", "2347062301848".
 *
 * A single leading 0 means a LOCAL number, so it's swapped for
 * `defaultCountryCode` — the caller passes config.defaultCountryCode, which
 * must match the country your players actually dial from. This rewrite is
 * the one dangerous step in the whole login flow: guess the wrong country
 * and the code is delivered to a real person in another country who never
 * asked for it. Anything already in international form (leading 00, or a
 * plain number long enough to carry its own country code) is left alone.
 *
 * Returns null for input that can't be a phone number.
 */
export function normalizePhone(input, defaultCountryCode = '234') {
  let digits = String(input ?? '').replace(/\D+/g, '')
  if (!digits) return null
  if (digits.startsWith('00')) digits = digits.slice(2)
  else if (digits.startsWith('0')) {
    digits = String(defaultCountryCode).replace(/\D+/g, '') + digits.replace(/^0+/, '')
  }
  if (digits.length < 8 || digits.length > 15) return null
  return digits
}

/**
 * Rate-limit gate. Returns { ok: true } or
 * { ok: false, retryAfterMs, reason }.
 */
export function checkRateLimit(phone, ip, now = Date.now()) {
  sweep(now)

  const existing = pending.get(phone)
  if (existing && now - existing.createdAt < RESEND_COOLDOWN_MS) {
    return {
      ok: false,
      reason: 'cooldown',
      retryAfterMs: RESEND_COOLDOWN_MS - (now - existing.createdAt),
    }
  }

  const phoneTimes = requestLog.get(phone) ?? []
  if (phoneTimes.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldest = Math.min(...phoneTimes)
    return {
      ok: false,
      reason: 'phone_quota',
      retryAfterMs: REQUEST_WINDOW_MS - (now - oldest),
    }
  }

  if (ip) {
    const ipTimes = ipLog.get(ip) ?? []
    if (ipTimes.length >= MAX_REQUESTS_PER_IP) {
      const oldest = Math.min(...ipTimes)
      return {
        ok: false,
        reason: 'ip_quota',
        retryAfterMs: IP_WINDOW_MS - (now - oldest),
      }
    }
  }

  return { ok: true }
}

/**
 * Issues a code for `phone` and returns { code, expiresAt, ttlMs }.
 * The plaintext `code` is returned exactly once, for the DM — it is never
 * recoverable afterwards. Call checkRateLimit() first.
 *
 * `jid` is the WhatsApp JID the DM is being sent to; it's remembered so
 * verify() can hand back the same JID the code was actually delivered to
 * rather than re-deriving it. `lid` is the account's Linked ID (if WhatsApp
 * reported one), remembered for the same reason — it's how verify() lets the
 * caller find a LID-keyed character instead of minting a duplicate.
 */
export function issue(phone, { ttlMs, ip = null, jid = null, lid = null } = {}) {
  if (!secret) throw new Error('otp-store: initOtpStore() was never called')
  const now = Date.now()
  sweep(now)

  // randomInt is cryptographically strong; the padStart keeps leading zeros
  // so every code is exactly CODE_LENGTH digits.
  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
  const expiresAt = now + ttlMs

  pending.set(phone, {
    hash: hash(phone, code),
    expiresAt,
    attempts: 0,
    createdAt: now,
    jid,
    lid,
  })

  requestLog.set(phone, [...(requestLog.get(phone) ?? []), now])
  if (ip) ipLog.set(ip, [...(ipLog.get(ip) ?? []), now])

  return { code, expiresAt, ttlMs }
}

/** Drops a pending code — used when the DM fails to send. */
export function discard(phone) {
  pending.delete(phone)
}

/**
 * Verifies a submitted code. Returns one of:
 *   { ok: true, jid, lid }
 *   { ok: false, reason: 'expired' | 'not_found' | 'too_many_attempts' | 'mismatch', attemptsLeft }
 *
 * A correct code is consumed immediately (single use).
 */
export function verify(phone, submitted) {
  const now = Date.now()

  // Read the entry BEFORE sweeping. sweep() drops expired codes, and if it
  // ran first an expired code would come back as 'not_found' — so the user
  // gets "no pending code for that number" when the truthful (and more
  // useful) answer is "that code expired, request a new one".
  const entry = pending.get(phone)
  sweep(now)

  if (!entry) return { ok: false, reason: 'not_found' }
  if (entry.expiresAt <= now) {
    pending.delete(phone)
    return { ok: false, reason: 'expired' }
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    // Deliberately NOT deleted: the entry is kept (unusable) until its
    // natural expiry so repeat submissions keep reporting the real reason
    // instead of decaying into 'not_found'. No further guess is ever
    // checked against it, so leaving it costs nothing.
    return { ok: false, reason: 'too_many_attempts', attemptsLeft: 0 }
  }

  const clean = String(submitted ?? '').replace(/\D+/g, '')
  entry.attempts++

  const expected = Buffer.from(entry.hash, 'hex')
  const actual = Buffer.from(hash(phone, clean), 'hex')
  const match = expected.length === actual.length && timingSafeEqual(expected, actual)

  if (!match) {
    return { ok: false, reason: 'mismatch', attemptsLeft: Math.max(0, MAX_ATTEMPTS - entry.attempts) }
  }

  pending.delete(phone)
  return { ok: true, jid: entry.jid, lid: entry.lid ?? null }
}

/** Introspection for the health endpoint — counts only, never contents. */
export function stats() {
  return {
    pending: pending.size,
    throttledPhones: requestLog.size,
    throttledIps: ipLog.size,
    codeLength: CODE_LENGTH,
    maxAttempts: MAX_ATTEMPTS,
    resendCooldownMs: RESEND_COOLDOWN_MS,
  }
}
