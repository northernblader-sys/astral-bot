/**
 * loop-lag.test.mjs — the metric that separates "Baileys is broken" from "this
 * process is too busy to service Baileys".
 *
 * Context: the recurring report is a slow bot that eventually stops answering
 * everyone while PM2 still says it is online. Both a dead socket and a
 * saturated event loop look exactly the same from the outside, and one of them
 * is fixed by reconnecting (which, for the other, only throws the queued
 * commands away). lib/loop-lag.js measures real scheduling delay so `.health`
 * can say which one it is. These tests prove the meter responds to a blocked
 * loop and costs nothing when it isn't.
 *
 * Run:  node --test test/loop-lag.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createLoopLagMonitor, startLoopLagMonitor, getLoopLagSnapshot, stopLoopLagMonitor } from '../lib/loop-lag.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function blockSyncFor(ms) {
  const until = Date.now() + ms
  // Burn CPU, don't sleep: sleeping yields the loop and proves nothing.
  while (Date.now() < until) Math.sqrt(Math.random() * 1e8)
}

test('snapshot is always readable and numerically shaped', async () => {
  const monitor = createLoopLagMonitor({ windowMs: 300 })
  try {
    const snap = monitor.snapshot()
    for (const key of ['meanMs', 'p99Ms', 'maxMs', 'driftMaxMs', 'worstMs']) {
      assert.ok(Number.isFinite(snap[key]), `${key} must be a number, got ${snap[key]}`)
      assert.ok(snap[key] >= 0, `${key} must not be negative`)
    }
    assert.equal(typeof snap.starved, 'boolean')
    assert.ok(snap.starveThresholdMs > 0)
    assert.ok(['histogram', 'drift'].includes(snap.source))
    assert.ok(snap.p99Ms <= 50, `an idle loop must not read as starved (${snap.p99Ms}ms)`)
  } finally {
    monitor.stop()
  }
})

test('a blocked event loop is detected, and stays visible after the loop recovers', async () => {
  // Threshold and block are deliberately far apart (200ms vs 500ms) rather than
  // tight: node's own startup jitter can put a few tens of ms on a sub-second
  // window, so a "must read as clean before the block" precondition would be a
  // coin flip. What must be guaranteed is that a 500ms stall is NEVER invisible;
  // test 1 covers the idle side.
  const monitor = createLoopLagMonitor({ windowMs: 250, starveMs: 200 })
  try {
    blockSyncFor(500)
    await wait(400) // let the sampler close one window across the block

    const snap = monitor.snapshot()
    assert.ok(snap.worstMs >= 200, `a 500ms synchronous block must show up as delay, got worstMs=${snap.worstMs}ms (p99=${snap.p99Ms}ms)`)
    assert.equal(snap.starvedRecently, true)
    // NOT `snap.starved` — that is the CURRENT window only, and the waits above
    // may already have produced a quiet one. `starvedWindows` is the durable
    // counter, and the recency flag is what readers are meant to act on.
    assert.equal(typeof snap.starved, 'boolean')
    assert.ok(snap.starvedWindows >= 1, 'the starve must be counted, not just flagged')
    assert.ok(snap.windows >= 1)

    // THE POINT OF THIS TEST. The first version of the module exposed only the
    // current window, so by the time a 60-second watchdog tick (or a human
    // typing `.health`) looked, the quiet window AFTER the stall had
    // overwritten it and the evidence was gone. A starve must age out on a
    // recency clock, not on the sampling window.
    await wait(500)
    const later = monitor.snapshot()
    assert.ok(later.worstMs >= 200, 'worstMs must remember the block after the loop recovers')
    assert.equal(later.starvedRecently, true, 'the recent-starve flag must outlast the window')
    assert.ok(later.lastStarvedAgoMs >= 400, 'and say how long ago it was')
  } finally {
    monitor.stop()
  }
})

test('reading the snapshot does not clear it for the next reader', async () => {
  const monitor = createLoopLagMonitor({ windowMs: 250, starveMs: 150 })
  try {
    blockSyncFor(400)
    await wait(300)
    const first = monitor.snapshot()
    const second = monitor.snapshot()
    assert.ok(first.worstMs > 0, 'need a non-zero window to test retention')
    assert.equal(second.worstMs, first.worstMs, '.health and the watchdog must not race each other for one window')
    assert.equal(second.windows, first.windows)
  } finally {
    monitor.stop()
  }
})

test('stop() ends the sampling so the process can exit cleanly', async () => {
  const monitor = createLoopLagMonitor({ windowMs: 250 })
  await wait(300)
  const before = monitor.snapshot().windows
  monitor.stop()
  await wait(600)
  assert.equal(monitor.snapshot().windows, before, 'no sampling after stop()')
  monitor.stop() // idempotent
})

test('window and threshold inputs are clamped, never NaN or zero', () => {
  for (const opts of [{ windowMs: 0 }, { windowMs: 'x' }, { windowMs: -5 }, { starveMs: 0 }, { starveMs: NaN }]) {
    const monitor = createLoopLagMonitor(opts)
    try {
      const snap = monitor.snapshot()
      assert.ok(Number.isFinite(snap.p99Ms))
      assert.ok(snap.starveThresholdMs >= 1, 'a zero threshold would call everything starved')
    } finally {
      monitor.stop()
    }
  }
})

test('the process-wide singleton is idempotent and readable by anyone', async () => {
  stopLoopLagMonitor()
  assert.equal(getLoopLagSnapshot(), null, 'nothing started yet → null, not a crash')

  const first = startLoopLagMonitor({ windowMs: 250 })
  const again = startLoopLagMonitor({ windowMs: 250 })
  assert.equal(again, first, 'a second start must not create a second sampler')

  await wait(320)
  assert.ok(first.snapshot().windows >= 1, 'the singleton samples on its own')
  assert.ok(Number.isFinite(getLoopLagSnapshot().p99Ms))

  stopLoopLagMonitor()
  assert.equal(getLoopLagSnapshot(), null)
  stopLoopLagMonitor() // idempotent
})
