/**
 * reconnect-policy.js — one place that decides how long the bot stays deaf
 * after a WhatsApp socket closes, and whether a human needs to be told.
 *
 * WHY THIS EXISTS (2026-09: "the bot slows down, then stops responding, while
 * pm2 says it is online")
 *
 * main.js's `connection === 'close'` branch handled the four codes it had been
 * burned by (515 → reconnect now, 440 → 10s, 401 → 60s with auth-preservation,
 * "never paired" → 60s then give up after 5 tries) and sent EVERYTHING ELSE to
 * a flat `scheduleReconnect(db, 60_000, ...)`. Sixty seconds is the right
 * answer for a logout and the wrong answer for a hiccup, and the most common
 * hiccups are the ones this bot causes itself:
 *
 *   • Baileys' keepalive (`Socket/socket.js`) runs on `keepAliveIntervalMs` and
 *     calls `end(new Boom('Connection was lost', { statusCode: 408 }))` the
 *     moment `Date.now() - lastDateRecv > keepAliveIntervalMs + 5000`.
 *     `lastDateRecv` is stamped inside the websocket's own message handler, so
 *     a saturated event loop — a busy group minute, a big `db.write()`
 *     stringify, a media command — delays frames and looks, from inside that
 *     interval, EXACTLY like a dead network. This repo already widened
 *     `keepAliveIntervalMs` to 60s to tolerate that; widening also widens the
 *     false-positive window it can still catch.
 *   • 428 (`connectionClosed`) and 503 (`unavailableService`) are WhatsApp
 *     briefly refusing or dropping a linked device, typically self-correcting
 *     in a second or two.
 *
 * For all of those, sixty silent seconds per occurrence is the outage. Worse,
 * the close path also calls `inboundScheduler.close()`, which deliberately
 * drops every queued command, so anything players typed during that minute is
 * gone. The visible result — slow, then mute for a minute, then fine again,
 * repeatedly in a busy hour, with PM2 reporting `online` the whole time — is
 * the symptom being reported. The reconnect itself was never the problem;
 * waiting a fixed minute to start it was.
 *
 * So: transient closes come back fast (3s, doubling to a 30s ceiling), and the
 * ceiling plus an alert is what stops a genuine outage from turning the bot
 * into a reconnect machine hammering WhatsApp — which is how a number gets
 * banned. Codes that need a human (ban 403, app mismatch 411, dead session
 * 500) never enter the fast lane and always raise `alert`, because silent
 * retrying is what made those outages take hours to notice.
 *
 * `consecutiveFast` is the only memory this needs: main.js resets it on
 * `connection === 'open'`, the same place it resets the other per-socket
 * counters. The policy is a pure function so both halves can be tested without
 * a socket, a database, or network access.
 */

/** Disconnect reasons as spelled by Baileys 6.7.x (`lib/Types/index.js`). */
export const CLOSE_CODE = {
  connectionLost: 408,      // also `timedOut` — includes our own keepalive self-kill
  loggedOut: 401,
  multideviceMismatch: 411,
  connectionClosed: 428,
  connectionReplaced: 440,
  badSession: 500,
  restartRequired: 515,
  forbidden: 403,
  unavailableService: 503,
}

/**
 * Closes that cost players nothing to retry immediately-ish: the transport
 * blinked, not the account. `undefined` belongs here — a close with no status
 * code at all (a socket torn down without a server reason) is the same case,
 * and treating it as fatal is how a bot stays down on a shrug.
 */
const TRANSIENT = new Set([CLOSE_CODE.connectionLost, CLOSE_CODE.connectionClosed, CLOSE_CODE.unavailableService])

/**
 * Closes where retrying harder cannot help: the phone has to be re-paired, the
 * WhatsApp build is wrong, or the account is restricted. These wait the long
 * way AND alert, and they must not be counted as fast attempts (a 403 in
 * particular gets worse the more you knock).
 */
const NEEDS_HUMAN = new Map([
  [CLOSE_CODE.forbidden, 'account restricted by WhatsApp (403) — check the number before resuming'],
  [CLOSE_CODE.multideviceMismatch, 'WhatsApp build mismatch (411) — update WhatsApp or bump the pinned Baileys version'],
  [CLOSE_CODE.badSession, 'session rejected (500) — may need a fresh pairing code'],
  [CLOSE_CODE.loggedOut, 'logged out (401) — main.js owns this case; a null delay means "caller decides"'],
])

export const DEFAULT_RECONNECT_POLICY = {
  /** First retry after a transient close. Short enough that nobody notices. */
  fastBaseMs: 3_000,
  /** How fast the wait doubles while the close keeps repeating. */
  fastFactor: 2,
  /** Ceiling for the fast lane before the situation is called a flap. */
  fastMaxMs: 30_000,
  /**
   * Consecutive transient closes tolerated before giving up on the fast lane.
   * Four covers a rough minute of flapping and stops there, so a real outage
   * costs the bot one alert instead of an endless reconnect loop.
   */
  fastMaxAttempts: 4,
  /** What a flapping or human-needed close falls back to. */
  slowMs: 60_000,
  /** How long the bot waits for codes it handles itself. */
  restartMs: 0,
  conflictMs: 10_000,
  /** main.js's forced in-process reconnect (watchdog) — fast, deliberate. */
  forcedMs: 5_000,
  /** Unknown-but-unspecified closes with no status code get this instead of the slow path. */
  unknownMs: 5_000,
}

function clampNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/**
 * Decide the next reconnect.
 *
 * @param {object} input
 * @param {number|null|undefined} input.statusCode  DisconnectReason from lastDisconnect
 * @param {boolean} [input.forced]   true when our own watchdog ended the socket
 * @param {number} [input.consecutiveFast] transient closes since the last successful 'open'
 * @param {object} [input.policy]    overrides over DEFAULT_RECONNECT_POLICY
 * @returns {{delayMs: number|null, kind: string, alert: boolean, label: string, escalate: boolean}}
 *
 * `delayMs: null` means "this code is not mine to answer" (401 — main.js has
 * pairing-state logic here that must not be duplicated). `escalate` means the
 * fast lane gave up and the caller should say so loudly.
 */
export function planReconnect({ statusCode = null, forced = false, consecutiveFast = 0, policy } = {}) {
  const p = { ...DEFAULT_RECONNECT_POLICY, ...(policy ?? {}) }
  const streak = Math.max(0, clampNumber(consecutiveFast, 0))

  if (forced) {
    return {
      delayMs: p.forcedMs,
      kind: 'forced',
      alert: false,
      escalate: false,
      label: `forced reconnect (our own watchdog) after ${p.forcedMs / 1000}s`,
    }
  }

  if (NEEDS_HUMAN.has(statusCode)) {
    const note = NEEDS_HUMAN.get(statusCode)
    if (statusCode === CLOSE_CODE.loggedOut) {
      return { delayMs: null, kind: 'auth', alert: false, escalate: false, label: note }
    }
    return {
      delayMs: p.slowMs,
      kind: 'needs-human',
      alert: true,
      escalate: false,
      label: note,
    }
  }

  if (statusCode === CLOSE_CODE.restartRequired) {
    return {
      delayMs: p.restartMs,
      kind: 'restart',
      alert: false,
      escalate: false,
      label: 'restart required (515) — expected right after pairing',
    }
  }

  if (statusCode === CLOSE_CODE.connectionReplaced) {
    return {
      delayMs: p.conflictMs,
      kind: 'conflict',
      alert: false,
      escalate: false,
      label: `session conflict (440) — another process has this auth folder? retrying after ${p.conflictMs / 1000}s`,
    }
  }

  const transient = statusCode == null || TRANSIENT.has(statusCode)

  if (!transient) {
    // Something we have no theory about. Wait the long way and alert, because
    // guessing "transient" for an unknown code is how a ban looks like a bug.
    return {
      delayMs: p.slowMs,
      kind: 'unknown',
      alert: true,
      escalate: false,
      label: `connection closed (${statusCode ?? 'unknown'}) — no fast path for this code`,
    }
  }

  if (streak >= p.fastMaxAttempts) {
    return {
      delayMs: p.slowMs,
      kind: 'flapping',
      alert: true,
      escalate: true,
      label: `connection keeps dropping (${streak} transient closes in a row) — backing off to ${p.slowMs / 1000}s`,
    }
  }

  const delayMs = Math.min(p.fastMaxMs, p.fastBaseMs * (p.fastFactor ** streak))
  return {
    delayMs: statusCode == null ? Math.min(delayMs, p.unknownMs) : delayMs,
    kind: 'transient',
    alert: false,
    escalate: false,
    label: `connection dropped (${statusCode ?? 'no code'}) — retrying in ${delayMs / 1000}s`,
  }
}

/**
 * Should this close count toward the flap streak? Only transient ones: a bot
 * that reconnects happily for an hour and then blinks must not start the next
 * hour already in the 60s lane.
 */
export function countsTowardFlap(plan) {
  return plan?.kind === 'transient' || plan?.kind === 'forced'
}
