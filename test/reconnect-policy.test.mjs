/**
 * reconnect-policy.test.mjs — the "bot goes deaf for a minute, then recovers"
 * fix, measured as a pure function.
 *
 * Context: every WhatsApp socket close that wasn't 515/440/401 used to wait a
 * flat 60_000ms before reconnecting — including the two closes this bot causes
 * itself under load (Baileys' keepalive self-kill, 408 `Connection was lost`,
 * fired whenever the event loop is too busy to service frames in time). Each
 * occurrence therefore cost sixty silent seconds, and the close path also drops
 * the inbound queue, so players' commands during that minute vanished. lib/
 * reconnect-policy.js puts transient closes on a fast lane (3s, doubling to a
 * 30s ceiling) with a flap guard, and keeps the codes that need a human slow
 * AND loud.
 *
 * Run:  node --test test/reconnect-policy.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  planReconnect,
  countsTowardFlap,
  CLOSE_CODE,
  DEFAULT_RECONNECT_POLICY,
} from '../lib/reconnect-policy.js'
import { config } from '../config.js'

const at = (streak, extra = {}) => planReconnect({ statusCode: CLOSE_CODE.connectionLost, consecutiveFast: streak, ...extra })

test('the keepalive self-kill (408) comes back in seconds, not a minute', () => {
  const plan = at(0)
  assert.equal(plan.kind, 'transient')
  assert.equal(plan.alert, false)
  assert.ok(plan.delayMs <= 5_000, `expected a fast retry, got ${plan.delayMs}ms`)
  assert.ok(plan.delayMs > 0, 'but not zero — reconnecting instantly on a flapping link is how you get banned')
})

test('a sustained flap backs off instead of hammering WhatsApp', () => {
  const delays = []
  const kinds = []
  for (let streak = 0; streak <= 8; streak++) {
    const plan = at(streak)
    delays.push(plan.delayMs)
    kinds.push(plan.kind)
  }
  // Monotonic non-decreasing while in the fast lane...
  for (let i = 1; i < DEFAULT_RECONNECT_POLICY.fastMaxAttempts; i++) {
    assert.ok(delays[i] >= delays[i - 1], `delay must grow with the streak: ${delays.join(',')}`)
  }
  // ...never above the fast ceiling in the fast lane...
  const inFast = delays.slice(0, DEFAULT_RECONNECT_POLICY.fastMaxAttempts)
  for (const d of inFast) assert.ok(d <= DEFAULT_RECONNECT_POLICY.fastMaxMs, `${d}ms exceeds the fast ceiling`)
  // ...and it escalates to the slow lane, loudly, once the streak is hopeless.
  const last = at(DEFAULT_RECONNECT_POLICY.fastMaxAttempts)
  assert.equal(last.kind, 'flapping')
  assert.equal(last.alert, true)
  assert.equal(last.escalate, true)
  assert.ok(last.delayMs >= 30_000, `the escalated wait must be a real cooldown, got ${last.delayMs}ms`)
  assert.ok(kinds.slice(0, 4).every(k => k === 'transient'))
})

test('every transient close code is treated as transient', () => {
  for (const code of [CLOSE_CODE.connectionLost, CLOSE_CODE.connectionClosed, CLOSE_CODE.unavailableService]) {
    const plan = planReconnect({ statusCode: code })
    assert.equal(plan.kind, 'transient', `code ${code} was ${plan.kind}`)
    assert.equal(plan.alert, false)
  }
})

test('a close with no status code at all is retried, not treated as fatal', () => {
  for (const code of [null, undefined]) {
    const plan = planReconnect({ statusCode: code })
    assert.ok(['transient', 'unknown'].includes(plan.kind), `code ${code} → ${plan.kind}`)
    assert.ok(plan.delayMs > 0 && plan.delayMs <= 15_000, `must still retry soon, got ${plan.delayMs}ms`)
  }
})

test('401 is handed back to main.js rather than answered here', () => {
  // main.js owns the soft-logout vs. never-paired distinction (wasEverConnected,
  // unpairedRetryCount, pairing-code expiry). Duplicating that here would let
  // the two drift — so the policy declines to answer.
  const plan = planReconnect({ statusCode: CLOSE_CODE.loggedOut, consecutiveFast: 3 })
  assert.equal(plan.delayMs, null)
  assert.equal(plan.kind, 'auth')
  assert.equal(countsTowardFlap(plan), false)
})

test('the codes that need a human are slow AND loud', () => {
  for (const code of [CLOSE_CODE.forbidden, CLOSE_CODE.multideviceMismatch, CLOSE_CODE.badSession]) {
    const plan = planReconnect({ statusCode: code, consecutiveFast: 0 })
    assert.equal(plan.kind, 'needs-human', `code ${code} was ${plan.kind}`)
    assert.equal(plan.alert, true, 'a 403/411/500 must never retry in silence')
    assert.ok(plan.delayMs >= 30_000, `must not reconnect-loop on ${code}: ${plan.delayMs}ms`)
    assert.equal(countsTowardFlap(plan), false, 'a ban is not a flap')
  }
})

test('an unrecognised close code is not guessed at as transient', () => {
  const plan = planReconnect({ statusCode: 1337 })
  assert.equal(plan.kind, 'unknown')
  assert.equal(plan.alert, true)
  assert.ok(plan.delayMs >= 30_000)
})

test('the codes main.js already special-cases keep their existing timing', () => {
  assert.equal(planReconnect({ statusCode: CLOSE_CODE.restartRequired }).delayMs, 0, '515 must reconnect immediately — it fires right after pairing')
  assert.equal(planReconnect({ statusCode: CLOSE_CODE.connectionReplaced }).delayMs, DEFAULT_RECONNECT_POLICY.conflictMs, '440 waits for the other process to retire')
})

test('our own watchdog-driven reconnect stays fast', () => {
  const plan = planReconnect({ forced: true, statusCode: CLOSE_CODE.badSession })
  assert.equal(plan.kind, 'forced')
  assert.equal(plan.alert, false)
  assert.equal(plan.delayMs, DEFAULT_RECONNECT_POLICY.forcedMs)
})

test('the policy is tunable from config without touching the code', () => {
  const plan = planReconnect({
    statusCode: CLOSE_CODE.connectionLost,
    consecutiveFast: 1,
    policy: { fastBaseMs: 1_000, fastFactor: 3, fastMaxMs: 4_000 },
  })
  assert.equal(plan.delayMs, 3_000)

  const clamped = planReconnect({ statusCode: CLOSE_CODE.connectionLost, consecutiveFast: 12, policy: { fastBaseMs: 1_000, fastFactor: 3, fastMaxMs: 4_000, fastMaxAttempts: 50 } })
  assert.equal(clamped.delayMs, 4_000, 'the fast ceiling must hold for arbitrarily long streaks')
})

test('garbage streak input cannot produce a negative or NaN delay', () => {
  for (const streak of [-5, NaN, 'abc', null, undefined, 1.9]) {
    const plan = planReconnect({ statusCode: CLOSE_CODE.connectionLost, consecutiveFast: streak })
    assert.ok(Number.isFinite(plan.delayMs) && plan.delayMs >= 0, `streak ${streak} → ${plan.delayMs}`)
  }
})

test('countsTowardFlap only credits the fast lane', () => {
  assert.equal(countsTowardFlap(at(0)), true)
  assert.equal(countsTowardFlap(at(9)), false, 'the escalated plan must not extend the streak forever')
  assert.equal(countsTowardFlap(planReconnect({ forced: true })), true)
  assert.equal(countsTowardFlap(undefined), false)
})

// ── the wiring main.js actually builds, not just the defaults ──────────────
// The policy is only as good as the numbers config.js hands it. These are the
// lines a typo in .env would break, and they are exactly what makes the fast
// lane either useless (base ≥ slow) or dangerous (base 0 = a reconnect loop).

const CONFIG_POLICY = {
  fastBaseMs: config.reconnectFastBaseMs,
  fastMaxMs: config.reconnectFastMaxMs,
  fastMaxAttempts: config.reconnectFastMaxAttempts,
  slowMs: config.reconnectSlowMs,
  forcedMs: config.reconnectForcedMs,
}

test('config.js exposes every knob the policy reads, as sane numbers', () => {
  for (const [key, value] of Object.entries(CONFIG_POLICY)) {
    assert.ok(Number.isFinite(value) && value >= 0, `config.${key} = ${value} is not a usable duration`)
  }
  assert.ok(CONFIG_POLICY.fastBaseMs >= 250, 'a sub-250ms reconnect base is a reconnect loop against WhatsApp')
  assert.ok(CONFIG_POLICY.fastBaseMs <= CONFIG_POLICY.fastMaxMs, 'the ladder must not start above its own ceiling')
  assert.ok(CONFIG_POLICY.fastMaxMs <= CONFIG_POLICY.slowMs, 'the cooldown must be the longest wait')
  assert.ok(CONFIG_POLICY.fastMaxAttempts >= 1 && CONFIG_POLICY.fastMaxAttempts <= 20, 'the flap guard must exist and must not be absurd')
  assert.ok(CONFIG_POLICY.forcedMs <= CONFIG_POLICY.slowMs, 'the watchdog reconnect must stay quicker than an ordinary wait')
})

test('the ladder built from live config reaches the ceiling and then escalates', () => {
  let streak = 0
  const seen = []
  for (let i = 0; i <= CONFIG_POLICY.fastMaxAttempts; i++) {
    const plan = planReconnect({ statusCode: CLOSE_CODE.connectionLost, consecutiveFast: streak, policy: CONFIG_POLICY })
    seen.push(plan.delayMs)
    assert.ok(plan.delayMs > 0 || plan.kind === 'restart', 'no wait in the fast lane may be zero')
    assert.ok(plan.delayMs <= CONFIG_POLICY.slowMs, `${plan.delayMs}ms exceeds the configured cooldown`)
    streak = countsTowardFlap(plan) ? streak + 1 : 0
  }
  assert.equal(seen[0], CONFIG_POLICY.fastBaseMs, 'the first transient close must be the configured fast base')
  assert.equal(seen.at(-1), CONFIG_POLICY.slowMs, 'the last must be the escalation')
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    seen,
    `waits must never shrink as the flap streak grows: ${seen.join(',')}`,
  )
})

test('the whole point: a 408 is answered in seconds, not the old flat minute', () => {
  const plan = planReconnect({ statusCode: CLOSE_CODE.connectionLost, consecutiveFast: 0, policy: CONFIG_POLICY })
  assert.ok(plan.delayMs < 60_000, `expected a sub-minute retry, got ${plan.delayMs}ms`)
})
