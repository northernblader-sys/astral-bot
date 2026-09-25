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
