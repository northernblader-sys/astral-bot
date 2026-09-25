// test/decrypt-forensics.test.mjs
//
// Regressions this file exists to prevent (2026-09 outage):
//   1. libsignal's reason line ("Session error:Error: Bad MAC …", printed as
//      ONE console.error with the stack) being recognised at all — it used to
//      be swallowed by SPAM_PATTERNS before anyone could read it.
//   2. The aggregate alert re-firing the same "#50" on every window prune
//      (it fired at 50, the window slid below 50, the next failure re-fired
//      it — hours of duplicates with no new information).
//   3. The watchdog's trigger being unreachable because a CIPHERTEXT stub
//      refreshed the "inbound is alive" clock. The ledger must therefore
//      report 0 failures after a successful decrypt, and plaintext must be
//      what clears it.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  captureLibsignalLine,
  classifyDecryptKind,
  classifyDecryptReason,
  createDecryptLedger,
  createReasonStash,
  decryptFailureHint,
  extractDecryptContext,
  formatDecryptLog,
  senderLabel,
} from '../lib/decrypt-forensics.js'

const BAD_MAC_CHUNK = [
  'Session error:Error: Bad MAC Error: Bad MAC',
  '    at Object.verifyMAC (/app/node_modules/libsignal/src/crypto.js:87:15)',
  '    at SessionCipher.doDecryptWhisperMessage (/app/node_modules/libsignal/src/session_cipher.js:250:16)',
  '    at async SessionCipher.decryptWithSessions (/app/node_modules/libsignal/src/session_cipher.js:147:29)',
  '    at async 223472198410327.0 [as awaitable] (/app/node_modules/libsignal/src/session_cipher.js:171:28)',
].join('\n')

test('libsignal reason line is captured (not silently dropped)', () => {
  const cap = captureLibsignalLine(BAD_MAC_CHUNK)
  assert.ok(cap, 'expected the Bad MAC line to be recognised')
  assert.equal(cap.placeholder, false)
  assert.match(cap.reason, /Bad MAC/i)
  assert.equal(cap.kind, 'mac')
})

test('the "any known session" header is recognised even without a reason line', () => {
  const cap = captureLibsignalLine('Failed to decrypt message with any known session...')
  assert.ok(cap)
  assert.equal(cap.placeholder, true)
})

test('ordinary app logs are not captured', () => {
  assert.equal(captureLibsignalLine('✅ Astral of the Sun is online'), null)
  assert.equal(captureLibsignalLine('player-repo queue: something took 4s'), null)
  assert.equal(captureLibsignalLine({}, 'nothing to see'), null)
})

test('reasons are classified, unknown ones keep their text', () => {
  assert.equal(classifyDecryptKind('Error: Bad MAC'), 'mac')
  assert.equal(classifyDecryptKind('MessageCounterError: Key used already or never filled'), 'counter')
  assert.equal(classifyDecryptKind('SessionError: No matching sessions found for message'), 'nosession')
  assert.match(classifyDecryptReason('Error: Bad MAC'), /Bad MAC/)
  const unknown = classifyDecryptReason('SomeBrandNewLibsignalError: whatever happened')
  assert.match(unknown, /SomeBrandNewLibsignalError/)
})

test('sender + device come out of the Baileys key first, the stack second', () => {
  const fromKey = extractDecryptContext({
    args: [{ key: { remoteJid: '123-456@g.us', participant: '223472198410327@lid', fromMe: false }, err: new Error('x') }, 'failed to decrypt message'],
    text: 'failed to decrypt message',
    pendingText: BAD_MAC_CHUNK,
  })
  assert.equal(fromKey.jid, '223472198410327@lid')
  assert.equal(fromKey.group, '123-456@g.us')
  assert.equal(fromKey.device, '0', 'device should come from the libsignal stack frame')

  // libsignal's console output carries the bare protocol address only — no
  // jid suffix — so it is reported as an address rather than guessed, and the
  // Baileys logger call that follows supplies the jid (recordSignalFailure
  // merges both).
  const fromText = extractDecryptContext({ text: BAD_MAC_CHUNK })
  assert.equal(fromText.jid, null)
  assert.equal(fromText.address, '223472198410327')
  assert.equal(fromText.device, '0')
  assert.equal(senderLabel('223472198410327@lid'), '223472198410327')
})

test('reason stash pairs the header with its reason, in order', () => {
  const stash = createReasonStash({ ttlMs: 5_000 })
  let t = 1_000
  // Failure A: header + reason (libsignal's real order).
  stash.remember('Failed to decrypt message with any known session...', true, t)
  stash.remember(BAD_MAC_CHUNK, false, t + 3)
  // Failure B: header + reason for a different cause.
  stash.remember('Failed to decrypt message with any known session...', true, t + 40)
  stash.remember('Session error:Error: MessageCounterError: Key used already or never filled\n at x', false, t + 45)

  assert.match(stash.take(t + 50).text, /Bad MAC/, 'first failure keeps its own reason')
  assert.match(stash.take(t + 50).text, /MessageCounterError/, 'second failure must not inherit the first reason')
  assert.equal(stash.take(t + 50), null)
})

test('reason stash expires stale entries', () => {
  const stash = createReasonStash({ ttlMs: 5_000 })
  stash.remember('Session error:Error: Bad MAC', false, 1_000)
  assert.equal(stash.take(1_000 + 5_001), null)
})

test('alert fires on crossing the limit, not on every multiple', () => {
  const ledger = createDecryptLedger({ windowMs: 600_000, limit: 10, logEveryN: 25 })
  let now = 1_000_000
  const alerts = []
  // 60 failures, 1s apart, all from one sender.
  for (let i = 0; i < 60; i++) {
    now += 1_000
    const out = ledger.record({ text: 'Bad MAC', jid: '111@lid', now })
    if (out.alert) alerts.push(out.alert.n)
  }
  // The old code produced 10, 25, 50, 50, 50… — each repeat a window prune.
  assert.deepEqual(alerts, [10, 35, 60])
})

test('the same count is never alerted twice while the window slides', () => {
  const ledger = createDecryptLedger({ windowMs: 60_000, limit: 10, logEveryN: 25 })
  let now = 1_000_000
  const alerts = []
  for (let i = 0; i < 400; i++) {
    now += 1_000 // one per second → 60 in any window, so it hovers at 59-60
    const out = ledger.record({ text: 'Bad MAC', jid: `sender${i % 5}@lid`, now })
    if (out.alert) alerts.push(out.alert.n)
  }
  const dupes = alerts.filter((n, i) => alerts.indexOf(n) !== i)
  assert.deepEqual(dupes, [], `alert counts repeated: ${alerts.join(', ')}`)
})

test('forensic lines are deduped per sender but a new sender still reports', () => {
  const ledger = createDecryptLedger({ windowMs: 600_000, logFirst: 3, maxDistinctSenderLogs: 8 })
  let now = 2_000_000
  const logged = []
  for (let i = 0; i < 30; i++) {
    now += 1_000
    const out = ledger.record({ text: 'Bad MAC', jid: 'repeat@lid', now })
    if (out.logForensic) logged.push(`repeat#${i}`)
  }
  // First 3 (the logFirst budget), then silence for the same wedged sender.
  assert.equal(logged.length, 3)
  const fresh = ledger.record({ text: 'Bad MAC', jid: 'newcomer@lid', now: now + 1_000 })
  assert.equal(fresh.logForensic, true, 'a different sender is a different incident')
  assert.equal(fresh.distinctSenders, 2)
})

test('a decrypted message clears the ledger and refreshes the plaintext clock', () => {
  const ledger = createDecryptLedger({ windowMs: 60_000, limit: 10 })
  let now = 3_000_000
  for (let i = 0; i < 14; i++) ledger.record({ text: 'Bad MAC', jid: 'x@lid', now: now + i })
  assert.equal(ledger.total, 14)
  const res = ledger.noteSuccess(now + 20)
  assert.equal(res.cleared, 14)
  assert.equal(ledger.total, 0)
  assert.equal(ledger.lastSuccessAt, now + 20)
  // And the alert budget resets, so a later incident alarms again.
  let alert = null
  for (let i = 0; i < 10; i++) {
    const out = ledger.record({ text: 'Bad MAC', jid: 'x@lid', now: now + 100 + i })
    if (out.alert) alert = out.alert
  }
  assert.ok(alert, 'a new incident must alarm')
  assert.equal(alert.n, 10)
})

test('a recent 440 sharpens the alert into "you are logged in twice"', () => {
  const ledger = createDecryptLedger({ windowMs: 600_000, limit: 10 })
  let now = 9_000_000
  let alert = null
  for (let i = 0; i < 10; i++) {
    const out = ledger.record({ text: 'Bad MAC', jid: 'only-one@lid', now: now + i, sawSessionConflict: true })
    if (out.alert) alert = out.alert
  }
  assert.ok(alert, 'expected an alert at the limit')
  assert.match(alert.hint, /logged in|440|other instance/i)
})

test('snapshot reports senders, sample and a double-login hint', () => {
  const ledger = createDecryptLedger({ windowMs: 600_000, limit: 10, sampleSize: 3 })
  let now = 4_000_000
  // Many distinct senders failing at once = the double-login signature.
  for (let i = 0; i < 12; i++) ledger.record({ text: 'Bad MAC', jid: `sender${i}@lid`, now: now + i })
  const snap = ledger.snapshot(now + 12)
  assert.equal(snap.total, 12)
  assert.equal(snap.distinctSenders, 12)
  assert.equal(snap.sample.length, 3)
  assert.ok(snap.sample.every(s => s.reason && typeof s.agoMs === 'number'))
  assert.match(snap.hint ?? '', /logged in twice|second deployment|exactly one instance/i)
})

test('hints: session conflict outranks everything, 440 is called out', () => {
  const hint = decryptFailureHint({ distinctSenders: 1, dominantKind: 'mac', sawSessionConflict: true })
  assert.match(hint, /440/)
  assert.match(decryptFailureHint({ distinctSenders: 1, dominantKind: 'mac' }) ?? '', /stale sessions|reconnect/i)
  assert.equal(decryptFailureHint({ distinctSenders: 0 }), null)
})

test('end-to-end: the real Bad-MAC sequence produces actionable log lines', () => {
  // Exactly what happens in production, in order:
  //   1. libsignal console.error()s the header + reason (captured by the bridge)
  //   2. libsignal throws; Baileys catches and logger.error()s { key, err }
  //   3. main.js records it and logs formatDecryptLog()'s lines
  const stash = createReasonStash({ ttlMs: 5_000 })
  const ledger = createDecryptLedger({ windowMs: 60_000, limit: 2, logFirst: 3 })
  const lines = []
  let now = 10_000_000

  function failure({ key, now: t }) {
    // step 1 — what installSignalConsoleBridge() does with libsignal's output
    for (const arg of ['Failed to decrypt message with any known session...', BAD_MAC_CHUNK]) {
      const cap = captureLibsignalLine(arg)
      assert.ok(cap, `expected libsignal line to be captured: ${arg.slice(0, 40)}`)
      stash.remember(arg, cap.placeholder, t)
    }
    // step 2/3 — what recordSignalFailure() does with Baileys' logger call
    const args = [{ key, err: new Error('No matching sessions found for message') }, 'failed to decrypt message']
    const text = args.map(a => (typeof a === 'string' ? a : `${a.err?.message ?? ''} ${JSON.stringify(a)}`)).join(' ')
    const pending = stash.take(t)
    const ctx = extractDecryptContext({ args, text, pendingText: pending?.text ?? '' })
    const out = ledger.record({ text: `${text}\n${pending?.text ?? ''}`, jid: ctx.jid, device: ctx.device, now: t })
    lines.push(...formatDecryptLog({ botName: 'Astral of the Sun', outcome: out, context: ctx, windowMs: 60_000 }))
  }

  failure({ key: { remoteJid: '120363000000000000@g.us', participant: '223472198410327@lid', fromMe: false }, now: (now += 1_000) })
  failure({ key: { remoteJid: '120363000000000000@g.us', participant: '223472198410327@lid', fromMe: false }, now: (now += 1_000) })
  failure({ key: { remoteJid: '223472198410327@lid', fromMe: false }, now: (now += 1_000) })

  const first = lines[0]
  assert.match(first, /\[Astral of the Sun\]/, 'the line names the bot')
  assert.match(first, /223472198410327/, 'the line names the sender')
  assert.match(first, /Bad MAC/, 'the line names the real reason (not the generic wrapper)')
  assert.match(first, /group 120363000000000000@g\.us/, 'group failures say which group')
  assert.match(first, /DROPPED/, 'it says the message was dropped')
  // The aggregate alert crosses the limit on the second failure (limit 2),
  // then stays quiet for the repeat counts — one alert, not one per failure.
  assert.ok(lines.some(l => l.startsWith('🚨') && /2 in 60s/.test(l)), `expected an alert line, got:\n${lines.join('\n')}`)
  assert.equal(lines.filter(l => l.startsWith('🚨')).length, 1, 'the alert must not repeat for every failure')
  // And the reason must not be the previous failure's — the ordering bug.
  assert.doesNotMatch(lines[1], /MessageCounterError/)
})

// The pure logic above is only useful if main.js is actually wired to it, and
// main.js cannot be imported by a test (it boots sockets and the db). So this
// is a source contract: the wiring lines must exist, and the two shapes that
// caused the outage must not come back.
test('main.js is wired to the forensics module', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../main.js', import.meta.url), 'utf8')

  assert.match(src, /from '\.\/lib\/decrypt-forensics\.js'/, 'imports the forensics module')
  assert.match(src, /installSignalConsoleBridge\(\)/, 'installs the libsignal console bridge')
  assert.match(src, /createDecryptLedger\(/, 'creates a per-instance ledger')
  assert.match(src, /signalReasons\.remember\(|signalReasons\.take\(/, 'uses the reason stash')
  assert.match(src, /inst\.lastDecryptOkAt = Date\.now\(\)/, 'stamps the plaintext clock')
  assert.match(src, /lastDecryptOkAt/, 'watchdog reads the plaintext clock')
  assert.match(src, /noteSuccess\(\)/, 'successful decrypts clear the ledger')

  // (1) the watchdog must not measure decrypt failures against an
  //     always-refreshed inbound clock again.
  assert.doesNotMatch(
    src,
    /recentFailures\.length >= DECRYPT_FAIL_LIMIT[^\n]*lastInboundAt/,
    'watchdog must measure plaintext, not raw delivery',
  )
  // (2) the old alert test that re-fired the same count on every window prune.
  assert.doesNotMatch(src, /if \(n % 25 === 0\)/, 'the repeated-alert bug must not return')
  // (3) the removed per-instance array of timestamps.
  assert.doesNotMatch(src, /inst\.decryptFailures\.push/, 'the timestamp-only ledger was replaced')
})

test('regression: a ~5/min drip (the reported outage) must still cross the limit', () => {
  // 50 failures spread over 10 minutes, exactly what the production log showed.
  // This is why the window is 10 minutes and not 60 seconds: against a 60s
  // window this rate never reaches the limit, so neither the alert nor the
  // forced reconnect would ever fire on the real incident.
  const ledger = createDecryptLedger({ windowMs: 600_000, limit: 10, logEveryN: 25 })
  const start = 20_000_000
  let alertedAt = null
  let alerts = 0
  for (let i = 0; i < 50; i++) {
    const now = start + i * 12_000 // 12s apart = 5/min
    const out = ledger.record({ text: 'Bad MAC', jid: 'slow-drip@lid', now })
    if (out.alert) {
      alerts++
      if (alertedAt === null) alertedAt = { i, n: out.alert.n }
    }
  }
  assert.ok(alertedAt, 'the drip must alert')
  assert.ok(alertedAt.n >= 10, `alerted too early: ${JSON.stringify(alertedAt)}`)
  assert.ok(alerts <= 3, `50 failures must not produce ${alerts} alert lines`)
})

test('window pruning bounds memory on a long wedge', () => {
  const ledger = createDecryptLedger({ windowMs: 60_000, limit: 10, maxEntries: 50 })
  let now = 5_000_000
  for (let i = 0; i < 500; i++) ledger.record({ text: 'Bad MAC', jid: 'x@lid', now: now + i * 100 })
  assert.ok(ledger.total <= 50, `ledger grew to ${ledger.total}`)
  const snap = ledger.snapshot(now + 500 * 100 + 120_000)
  assert.equal(snap.total, 0, 'everything ages out once the window passes')
})
