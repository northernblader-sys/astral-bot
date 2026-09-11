/**
 * react-no-delay.test.mjs — proves the auto-react no longer paces the reply.
 *
 * The bug: every command fired a ⚔️ react before its reply. The rate limiter
 * counted that react as a real send, resetting the inter-send gap, so the
 * reply that followed a few ms later was forced to wait out almost the whole
 * gap. Symptom: "the bot reacts, then the response is delayed."
 *
 * The fix: reactions are decoration — they send immediately and are invisible
 * to the pacer. Only real replies are spaced (the ban-safety we keep).
 *
 * Run:  node test/react-no-delay.test.mjs
 */

import assert from 'node:assert/strict'
import { wrapSendWithRateLimit } from '../lib/send-rate-limiter.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (err) { failures.push({ name, err }); console.log(`FAIL  ${name}\n      ${err.message}`) }
}

/** A fake sock whose sendMessage records when each send actually fired. */
function makeFakeSock() {
  const fired = []
  return {
    fired,
    async sendMessage(...args) {
      fired.push({ at: Date.now(), args })
      return { key: {} }
    },
  }
}

const GAP = 1000

console.log('react-no-delay unit tests\n')

// ─────────────────────────────────────────────────────────────────────────
await test('a react fired just before a reply does NOT delay the reply', async () => {
  const sock = makeFakeSock()
  wrapSendWithRateLimit(sock, { botName: 'T', minGapMs: GAP, maxPerMinute: 40 })

  const t0 = Date.now()
  // Exactly what handler.js does: react (fire-and-forget) then reply.
  sock.sendMessage('user@x', { react: { text: '⚔️', key: {} } })
  const reply = sock.sendMessage('user@x', { text: 'hello' })
  await reply

  const replyFiredAt = sock.fired.find(f => f.args[1].text)?.at
  const elapsed = replyFiredAt - t0
  // Before the fix this was ~GAP (the react reset the gap timer). It should
  // now be near-instant — allow generous slack for CI scheduling jitter.
  assert.ok(elapsed < GAP / 2, `reply fired after ${elapsed}ms, expected well under ${GAP / 2}ms`)
})

// ─────────────────────────────────────────────────────────────────────────
await test('two real replies ARE still spaced by the gap (ban-safety intact)', async () => {
  const sock = makeFakeSock()
  wrapSendWithRateLimit(sock, { botName: 'T', minGapMs: GAP, maxPerMinute: 40 })

  const a = sock.sendMessage('user@x', { text: 'first' })
  const b = sock.sendMessage('user@x', { text: 'second' })
  await Promise.all([a, b])

  const [first, second] = sock.fired.filter(f => f.args[1].text).map(f => f.at)
  const spacing = second - first
  assert.ok(spacing >= GAP * 0.7, `two replies were ${spacing}ms apart, expected ~${GAP}ms of pacing`)
})

// ─────────────────────────────────────────────────────────────────────────
await test('a react does not consume the per-minute reply budget', async () => {
  const sock = makeFakeSock()
  wrapSendWithRateLimit(sock, { botName: 'T', minGapMs: 1, maxPerMinute: 40 })

  sock.sendMessage('user@x', { react: { text: '⚔️', key: {} } })
  await sock.sendMessage('user@x', { text: 'reply' })
  // The limiter only counts real sends toward the trailing-minute window.
  assert.equal(sock.__rateLimiter.sentLastMinute, 1, 'only the reply should count, not the react')
})

// ── summary ─────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
