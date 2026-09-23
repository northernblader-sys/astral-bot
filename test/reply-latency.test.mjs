/**
 * reply-latency.test.mjs — the "commands answer instantly" guarantees.
 *
 * Reported symptom: "the tracking works fine, but when a player uses a command
 * their response has a huge delay." Two independent causes were measured and
 * fixed; this file pins both down.
 *
 *   1. lib/player-repo.js — every updatePlayer() ran its debounced whole-file
 *      flush INSIDE the player's own lane, so the next task for that player
 *      waited out the full 150ms debounce + write. handler.js runs up to four
 *      updatePlayer hops per command (inn-sleep gate, hunger tick, The End
 *      tick, pet payout), so every command paid that tax before the plugin even
 *      ran. Measured before: ~158ms per command. The flush is now scheduled,
 *      not awaited — the lane is free the moment the mutation is in RAM.
 *
 *   2. lib/send-rate-limiter.js — real sends were one FIFO, so a reply queued
 *      behind spawn announcements, and one chat's backlog (ten commands from
 *      one player) delayed every other chat's answer. Replies are now picked
 *      ahead of unquoted bulk traffic, round-robin between chats, and may use
 *      a small burst allowance — while the per-minute ceiling is unchanged.
 *
 * Run:  node --test test/reply-latency.test.mjs
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Low } from 'lowdb'

import { wrapSendWithRateLimit } from '../lib/send-rate-limiter.js'
import { FastJSONFile } from '../lib/fast-json-adapter.js'
import { updatePlayer, getPlayer, flushPendingWrites, installReadGuard } from '../lib/player-repo.js'

// The per-minute-ceiling test deliberately leaves jobs queued for the next
// 60s window; nothing after that point needs them, so count failures and end
// the file rather than waiting out a timer that exists to be waited out.
let failures = 0
const t = (name, fn) => test(name, async (...args) => {
  try {
    return await fn(...args)
  } catch (err) {
    failures++
    throw err
  }
})
after(() => { setTimeout(() => process.exit(failures ? 1 : 0), 25).unref() })

/** A fake sock that records when each send actually fired. */
function makeFakeSock() {
  const fired = []
  const sock = {
    fired,
    async sendMessage(...args) {
      fired.push({ at: Date.now(), args })
      return { key: {} }
    },
  }
  return sock
}

/** The quoted shape every ctx.reply() in the codebase produces. */
const reply = (text) => [{ text }, { quoted: { key: { id: 'cmd' } } }]
/** The unquoted shape spawn sweeps / hourly cards / mass DMs use. */
const bulk = (text) => [{ text }]

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ─────────────────────────────────────────────────────────────────────────────
t('a reply is not stuck behind queued bulk sends', async () => {
  const sock = makeFakeSock()
  wrapSendWithRateLimit(sock, { botName: 'T', minGapMs: 400, maxPerMinute: 40, burstGapMs: 60 })

  const t0 = Date.now()
  sock.sendMessage('g@g.us', ...bulk('spawn 1'))
  sock.sendMessage('g@g.us', ...bulk('spawn 2'))
  const answer = sock.sendMessage('p@s.whatsapp.net', ...reply('your turn'))
  await answer

  const replyAt = sock.fired.find(f => f.args[1]?.text === 'your turn')?.at - t0
  assert.ok(replyAt < 300, `reply took ${replyAt}ms — it queued behind the bulk sends (3 gaps would be 1200ms)`)
})

t('one chat cannot starve the others (round-robin, not FIFO)', async () => {
  const sock = makeFakeSock()
  wrapSendWithRateLimit(sock, {
    botName: 'T', minGapMs: 60, maxPerMinute: 100, burstMax: 1, burstGapMs: 20,
  })

  const spammer = Array.from({ length: 6 }, (_, i) =>
    sock.sendMessage('spam@s.whatsapp.net', ...reply(`cmd ${i}`)))
  const other = sock.sendMessage('other@s.whatsapp.net', ...reply('other player'))
  const third = sock.sendMessage('third@s.whatsapp.net', ...reply('third player'))

  await Promise.all([...spammer, other, third])

  const order = sock.fired.map(f => f.args[1].text)
  const otherIdx = order.indexOf('other player')
  const thirdIdx = order.indexOf('third player')
  assert.ok(otherIdx >= 0 && otherIdx <= 3, `other player's reply went out at position ${otherIdx}/7 (expected a slot within the first few)`)
  assert.ok(thirdIdx >= 0 && thirdIdx <= 4, `third player's reply went out at position ${thirdIdx}/7`)
  assert.ok(order.indexOf('cmd 5') > otherIdx, 'the spammer\'s 6th command should not beat another chat\'s first')
})

t('the burst allowance is spent, then the configured gap takes over', async () => {
  const sock = makeFakeSock()
  wrapSendWithRateLimit(sock, {
    botName: 'T', minGapMs: 300, maxPerMinute: 40, burstMax: 2, burstGapMs: 30,
  })

  const jobs = Array.from({ length: 4 }, (_, i) =>
    sock.sendMessage('a@s.whatsapp.net', ...reply(`r${i}`)))
  await Promise.all(jobs)

  const times = sock.fired.map(f => f.at)
  const g1 = times[1] - times[0]
  const g3 = times[3] - times[2]
  assert.ok(g1 < 200, `first two replies were ${g1}ms apart — the burst allowance should have covered them`)
  assert.ok(g3 >= 200, `cadence after the burst was ${g3}ms apart — it must fall back to the configured 300ms gap`)
})

t('the per-minute ceiling still binds (burst is not extra budget)', async () => {
  const sock = makeFakeSock()
  wrapSendWithRateLimit(sock, {
    botName: 'T', minGapMs: 1, maxPerMinute: 5, burstMax: 5, burstGapMs: 1,
  })

  const jobs = Array.from({ length: 8 }, (_, i) =>
    sock.sendMessage('a@s.whatsapp.net', ...reply(`x${i}`)))
  await sleep(400)

  assert.equal(sock.__rateLimiter.sentLastMinute, 5, 'no more than maxPerMinute real sends may leave in a minute')
  assert.equal(sock.fired.length, 5, 'the 6th send must still be waiting for the window to slide')
  // The rest are still queued (or in the drain loop's hands) — nothing dropped.
  assert.ok(sock.__rateLimiter.pending >= 2, `expected the remaining jobs to still be queued, ${sock.__rateLimiter.pending} pending`)
  assert.equal(sock.__rateLimiter.counters.dropStale + sock.__rateLimiter.counters.dropOverflow, 0)
  jobs.forEach(j => j.catch(() => {}))
})

t('bulk traffic is not starved forever by a deep reply queue', async () => {
  const sock = makeFakeSock()
  wrapSendWithRateLimit(sock, {
    botName: 'T', minGapMs: 200, maxPerMinute: 40, burstMax: 0, bulkStarvationMs: 100,
  })

  const replies = Array.from({ length: 5 }, (_, i) =>
    sock.sendMessage('a@s.whatsapp.net', ...reply(`r${i}`)))
  const announcement = sock.sendMessage('g@g.us', ...bulk('spawn'))
  announcement.catch(() => {})

  // Bulk yields to replies, but not forever: past bulkStarvationMs it gets the
  // next slot, so one busy chat cannot hold a spawn announcement hostage.
  await sleep(500)
  assert.ok(sock.fired.some(f => f.args[1]?.text === 'spawn'), 'the spawn announcement must still get out')
  replies.forEach(j => j.catch(() => {}))
})

// ─────────────────────────────────────────────────────────────────────────────
// lib/player-repo.js: the debounced flush must not sit on the player's lane.
// ─────────────────────────────────────────────────────────────────────────────

async function makeScratchDb() {
  const dir = await mkdtemp(join(tmpdir(), 'astral-latency-'))
  const file = join(dir, 'db.json')
  const id = 'p@s.whatsapp.net'
  const db = new Low(new FastJSONFile(file), {
    users: {
      [id]: {
        id, name: 'P', classId: 'warrior', raceId: 'human', level: 10, hp: 100, maxHp: 100, mp: 10, maxMp: 10,
        stats: { str: 10, agi: 10, int: 10, def: 10, lck: 10 },
        baseStats: { str: 10, agi: 10, int: 10, def: 10, lck: 10, maxHp: 100, maxMp: 10 },
        statPoints: { version: 2, earned: 0, spent: 0, unallocated: 0, allocations: {} },
        wallet: {}, inventory: [], equipped: {}, chest: { items: [] }, activeEffects: [],
      },
    },
  })
  installReadGuard(db)
  await db.write()
  const cleanup = async () => {
    await flushPendingWrites(db).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
  return { db, file, id, cleanup }
}

t('updatePlayer resolves without waiting out the 150ms debounce', async () => {
  const { db, id, cleanup } = await makeScratchDb()
  try {
    // Warm: first call also pays module/lane setup.
    await updatePlayer(db, id, p => { p.stats.str += 1 })

    const t0 = Date.now()
    await updatePlayer(db, id, p => { p.stats.str += 1 })
    const first = Date.now() - t0

    const t1 = Date.now()
    await updatePlayer(db, id, p => { p.stats.agi += 1 })
    const second = Date.now() - t1

    // Before the fix each of these was >= FLUSH_DEBOUNCE_MS (150ms) because the
    // lane awaited the whole-file flush before letting the next task in.
    assert.ok(first < 60, `a mutating updatePlayer took ${first}ms — the lane is waiting on the flush again`)
    assert.ok(second < 60, `the next updatePlayer for the same player took ${second}ms — the lane is blocked`)

    // The change is still durable: it is on disk once the debounce fires.
    await flushPendingWrites(db)
    const disk = JSON.parse(await readFile(join(db.adapter.filename), 'utf-8'))
    assert.equal(disk.users[id].stats.str, 12)
    assert.equal(disk.users[id].stats.agi, 11)
    assert.equal(getPlayer(db, id).stats.str, 12)
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// lib/group-helpers.js: the group-metadata cache must not put a WhatsApp
// round trip in front of a command.
// ─────────────────────────────────────────────────────────────────────────────

import { mock } from 'node:test'
import { getGroupMetadata, invalidateGroupMetadata, checkBotAdmin } from '../lib/group-helpers.js'

function makeGroupSock({ latencyMs = 0 } = {}) {
  const state = { calls: 0, fail: false }
  return {
    state,
    user: { id: 'bot@s.whatsapp.net' },
    async groupMetadata(jid) {
      state.calls++
      if (latencyMs) await sleep(latencyMs)
      if (state.fail) throw new Error('metadata unavailable')
      return {
        id: jid,
        participants: [
          { id: 'bot@s.whatsapp.net', admin: 'admin' },
          { id: 'player@s.whatsapp.net' },
        ],
      }
    },
  }
}

t('a warm group answers from cache and refreshes ahead of expiry', async () => {
  invalidateGroupMetadata('warm@g.us')
  mock.timers.enable({ apis: ['Date'] })
  try {
    const sock = makeGroupSock()
    const first = await getGroupMetadata(sock, 'warm@g.us')
    assert.equal(sock.state.calls, 1, 'first call fetches')
    assert.ok(first)

    // 25s later: inside the 30s TTL, past the warm-ahead threshold.
    mock.timers.setTime(Date.now() + 25_000)
    const cached = await getGroupMetadata(sock, 'warm@g.us')
    assert.equal(cached, first, 'the cached copy is served, not awaited')
    await sleep(10)
    assert.equal(sock.state.calls, 2, 'the refresh was kicked off in the background')
  } finally {
    mock.timers.reset()
    invalidateGroupMetadata('warm@g.us')
  }
})

t('a failed refresh falls back to the last known metadata', async () => {
  invalidateGroupMetadata('flaky@g.us')
  mock.timers.enable({ apis: ['Date'] })
  try {
    const sock = makeGroupSock()
    await getGroupMetadata(sock, 'flaky@g.us')

    mock.timers.setTime(Date.now() + 31_000)   // past the TTL
    sock.state.fail = true
    const stale = await getGroupMetadata(sock, 'flaky@g.us')
    assert.ok(stale, 'moderation keeps working on the stale copy instead of throwing')
    const { isAdmin } = await checkBotAdmin(sock, 'flaky@g.us')
    assert.equal(isAdmin, true)
  } finally {
    mock.timers.reset()
    invalidateGroupMetadata('flaky@g.us')
  }
})
