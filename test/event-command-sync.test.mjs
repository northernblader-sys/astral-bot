import test from 'node:test'
import assert from 'node:assert/strict'

import { buildNewPlayer } from '../lib/player-factory.js'
import { claimEndDefeat, startEndEvent } from '../lib/end-event.js'
import { endGuardianEvent, startGuardianEvent } from '../lib/guardian-event.js'

const eventPlugin = (await import('../plugins/event.js')).default

const makeDb = (users = {}) => ({ data: { users }, write: async () => {}, read: async () => {} })

function newPlayer(id, name = 'Tester') {
  const p = buildNewPlayer({ id, name, classId: 'warrior', raceId: 'human' })
  p.level = 40
  return p
}

function makeCtx(db, from, args = []) {
  const replies = []
  return {
    db,
    from,
    args,
    sender: from,
    isGroup: false,
    platform: 'whatsapp',
    player: db.data.users[from] ?? null,
    reply: async (text) => { replies.push(String(text)); return {} },
    replies,
  }
}

async function run(db, from, args = []) {
  const ctx = makeCtx(db, from, args)
  await eventPlugin.run(ctx)
  return ctx.replies.join('\n')
}

test('.event prefers the live Guardian event over an older ended End event', async () => {
  const db = makeDb({ 'u@s': newPlayer('u@s', 'Guard') })
  const now = Date.now()
  const oldStart = now - (25 * 24 * 60 * 60 * 1000)
  const newStart = now - (2 * 24 * 60 * 60 * 1000)

  startEndEvent(db, oldStart)
  assert.equal(claimEndDefeat(db, 'u@s', oldStart + 1000), true)
  startGuardianEvent(db, { now: newStart })

  const out = await run(db, 'u@s')
  assert.match(out, /GUARDIAN OF THE INNOCENT/)
  assert.match(out, /Rescues left today/)
  assert.doesNotMatch(out, /THE END — over/i)
})

test('.event keeps following Guardian after that run ends if it is the latest event', async () => {
  const db = makeDb({ 'u@s': newPlayer('u@s', 'Guard') })
  const now = Date.now()
  const oldStart = now - (40 * 24 * 60 * 60 * 1000)
  const guardianStart = now - (10 * 24 * 60 * 60 * 1000)

  startEndEvent(db, oldStart)
  claimEndDefeat(db, 'u@s', oldStart + 1000)
  startGuardianEvent(db, { now: guardianStart })
  endGuardianEvent(db, { now: guardianStart + 1000 })

  const out = await run(db, 'u@s')
  assert.match(out, /GUARDIAN OF THE INNOCENT/)
  assert.match(out, /This run has ended/)
  assert.doesNotMatch(out, /THE END — over/i)
})

test('.event still shows The End when it is the active event', async () => {
  const db = makeDb({ 'u@s': newPlayer('u@s', 'Ender') })
  startEndEvent(db, Date.now())

  const out = await run(db, 'u@s')
  assert.match(out, /THE END — THE LONG SLEEP|THE END — THE RECKONING/)
  assert.match(out, /Blue Band/)
})

// ── Registry behaviour: new events show up without being started first ──────

const { config: _cfg } = await import('../config.js')
const OWNER = `${String((_cfg.ownerNumbers ?? [])[0] ?? '0').replace(/\D/g, '')}@s.whatsapp.net`

test('.event shows the newest event (Guardian, not started) instead of an old finished End', async () => {
  const db = makeDb({ 'u@s': newPlayer('u@s', 'Guard') })
  const oldStart = Date.now() - (25 * 24 * 60 * 60 * 1000)
  startEndEvent(db, oldStart)
  claimEndDefeat(db, 'u@s', oldStart + 1000)
  // Guardian never started — this is exactly what live players hit.

  const out = await run(db, 'u@s')
  assert.match(out, /GUARDIAN OF THE INNOCENT/)
  assert.match(out, /has not started yet/)
  assert.doesNotMatch(out, /THE END — over/i)
})

test('.event with no events ever started shows the newest registered event', async () => {
  const db = makeDb({ 'u@s': newPlayer('u@s', 'Fresh') })
  const out = await run(db, 'u@s')
  assert.match(out, /GUARDIAN OF THE INNOCENT/)
})

test('featuredWorldEventKey: a live older event beats an unstarted newer one', async () => {
  const { featuredWorldEventKey, newestWorldEventKey } = await import('../lib/world-events.js')
  const db = makeDb({})
  assert.equal(featuredWorldEventKey(db), newestWorldEventKey())
  startEndEvent(db, Date.now())
  assert.equal(featuredWorldEventKey(db), 'end')
})

test('.event theend / .event list still let players look at older events', async () => {
  const db = makeDb({ 'u@s': newPlayer('u@s', 'Peek') })
  const oldStart = Date.now() - (25 * 24 * 60 * 60 * 1000)
  startEndEvent(db, oldStart)
  claimEndDefeat(db, 'u@s', oldStart + 1000)

  assert.match(await run(db, 'u@s', ['theend']), /THE END — over/)
  const list = await run(db, 'u@s', ['list'])
  assert.match(list, /Guardian of the Innocent/)
  assert.match(list, /The End/)
})

test('owner .event start opens Guardian (newest), not The End; .event start theend still works', async () => {
  const { isGuardianActive, getGuardianEvent } = await import('../lib/guardian-event.js')
  const { isEventActive } = await import('../lib/end-event.js')
  const { isOwnerJid } = await import('../lib/group-helpers.js')
  assert.equal(isOwnerJid(OWNER), true, 'test needs config.ownerNumbers[0]')

  const db = makeDb({ [OWNER]: newPlayer(OWNER, 'Boss') })
  assert.match(await run(db, 'rando@s.whatsapp.net', ['start']), /Owner only/)
  assert.equal(isGuardianActive(db), false)

  await run(db, OWNER, ['start', '3'])
  assert.equal(isGuardianActive(db), true)
  assert.equal(isEventActive(db), false)
  const e = getGuardianEvent(db)
  assert.equal(Math.round((e.endsAt - e.startedAt) / 86400000), 3)

  await run(db, OWNER, ['end'])
  assert.equal(isGuardianActive(db), false)

  await run(db, OWNER, ['start', 'theend'])
  assert.equal(isEventActive(db), true)
})
