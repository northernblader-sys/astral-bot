/**
 * inbound-scheduler-stall.test.mjs — proves the "bot goes deaf" outage is
 * impossible to sustain from one hung command.
 *
 * The bug: the scheduler's concurrency counter only drops when a handler's
 * promise SETTLES. A handler that hangs forever (untimed API call, stuck db
 * flush, a Baileys send that never resolves) holds its slot forever. Once
 * `concurrency` such jobs accumulate, no new message is ever dispatched:
 * the bot stops answering EVERYONE while its background sweeps (card spawns,
 * dungeon tags, …) keep firing on timers. Outbound healthy, inbound dead.
 *
 * The fix under test: every job gets a timeout (jobTimeoutMs). When it
 * fires, the job is detached — the slot is taken back, the sender's lane is
 * released, and the rest of the stream keeps working. The detached count
 * (scheduler.stuck) is the signal main.js's stall watchdog acts on.
 *
 * Run:  node --test test/inbound-scheduler-stall.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createInboundScheduler } from '../lib/inbound-scheduler.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// The hang: a handler that never settles. `release` lets a test settle it
// late, AFTER the detach, to prove the late settle can't corrupt accounting.
function makeHang() {
  let release
  const p = new Promise(resolve => { release = resolve })
  return { promise: p, release }
}

test('a hung handler cannot hold other senders hostage', async () => {
  const started = []
  const hang = makeHang()
  const scheduler = createInboundScheduler({
    concurrency: 1, // the worst case: ONE slot, and it gets hung
    jobTimeoutMs: 200,
    handle: async ({ id }) => {
      started.push(id)
      if (id === 'hang') await hang.promise
      return id
    },
  })

  const hung = scheduler.enqueue({ id: 'hang' }, 'player-a')
  const other = scheduler.enqueue({ id: 'other' }, 'player-b')
  await wait(10)
  // While the hang is inside its timeout window, the other sender waits —
  // that is correct, the slot is legitimately occupied.
  assert.equal(scheduler.active, 1)
  assert.equal(scheduler.pending, 1)

  // After the timeout the hang is detached and the other sender runs.
  const otherResult = await Promise.race([
    other,
    wait(2000).then(() => 'TIMEOUT-WAIT'),
  ])
  assert.equal(otherResult, 'other', 'another sender must run after the hung job detaches')
  await wait(5) // let the just-finished job's release microtask run
  assert.equal(scheduler.active, 0, 'the detached job must not keep occupying the slot')
  assert.ok(started.includes('other'))

  // Let the abandoned hang settle late; accounting must stay clean.
  hang.release()
  await wait(10)
  assert.equal(scheduler.active, 0)
  assert.equal(scheduler.stuck, 0, 'the late settle must clear the detached tracking')
  scheduler.close()
})

test('the same sender keeps working after their own job detaches', async () => {
  const hang = makeHang()
  const order = []
  const scheduler = createInboundScheduler({
    concurrency: 1,
    jobTimeoutMs: 150,
    handle: async ({ id }) => {
      order.push(id)
      if (id === 'hang') await hang.promise
      return id
    },
  })

  const hung = scheduler.enqueue({ id: 'hang' }, 'same-player')
  const followUp = scheduler.enqueue({ id: 'follow-up' }, 'same-player')

  const result = await Promise.race([followUp, wait(2000).then(() => 'TIMEOUT-WAIT')])
  assert.equal(result, 'follow-up', 'the player\'s NEXT command must run after their stuck one detaches')
  assert.deepEqual(order, ['hang', 'follow-up'])
  assert.equal(scheduler.stuck, 1, 'the abandoned job is still tracked until it settles')
  assert.equal(await hung, undefined, 'the detached job resolves undefined for its caller')

  hang.release()
  await wait(10)
  assert.equal(scheduler.stuck, 0)
  scheduler.close()
})

test('stats and limits expose the timeout for the watchdog/health readout', async () => {
  const hang = makeHang()
  const detached = []
  const scheduler = createInboundScheduler({
    concurrency: 2,
    jobTimeoutMs: 120,
    log: (_fields, message) => { if (message.includes('timeout')) detached.push({ ..._fields }) },
    handle: async ({ id }) => {
      if (id === 'hang') await hang.promise
      return id
    },
  })

  scheduler.enqueue({ id: 'hang' }, 'a')
  const t = await Promise.race([
    wait(1000).then(() => 'waited'),
    wait(300).then(() => scheduler.stuck >= 1 ? 'detached' : 'pending'),
  ])
  assert.equal(t, 'detached', 'the job must be detached within its timeout')
  assert.equal(scheduler.stuck, 1)
  assert.ok(scheduler.stats.stuck >= 1, 'stats.stuck counts detached jobs')
  assert.equal(scheduler.limits.jobTimeoutMs, 120)
  assert.equal(detached.length, 1, 'the detach is logged with its lane key')
  assert.equal(detached[0].laneKey, 'a')

  hang.release()
  await wait(10)
  assert.equal(scheduler.stuck, 0)
  scheduler.close()
})

test('a fast stream is unaffected: normal jobs finish before any timeout', async () => {
  const ids = []
  const scheduler = createInboundScheduler({
    concurrency: 4,
    jobTimeoutMs: 1000,
    handle: async ({ id }) => {
      ids.push(id)
      await wait(5)
      return id
    },
  })

  const expected = []
  for (let i = 0; i < 10; i++) {
    assert.equal(await scheduler.enqueue({ id: `m${i}` }, `s${i % 3}`), `m${i}`)
    expected.push(`m${i}`)
  }
  assert.equal(scheduler.stuck, 0)
  assert.equal(scheduler.stats.stuck, 0)
  assert.equal(scheduler.stats.completed, 10)
  assert.deepEqual(ids, expected, 'every message ran exactly once, in enqueue order')
  scheduler.close()
})
