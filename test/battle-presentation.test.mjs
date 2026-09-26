import test from 'node:test'
import assert from 'node:assert/strict'
import {
  withBattleCinematic, isBattleCinematicActive, battleOutputTicket, suppressBattleOutput,
} from '../lib/battle-presentation.js'
import { showEndworldClash, showCoordinate } from '../lib/witch-heroes-cinematic.js'

function setup() {
  const db = {}, events = []
  const make = (id, opp) => ({ db, from: id, sender: 'same-group', player: { battleState: { type: 'pvp', opponentJid: opp } },
    reply: async text => { events.push(['text', text]); return { key: { id: 'result' } } },
    replyImage: async (url, text) => events.push(['image', url, text]),
    editReply: async (sent, text) => events.push(['edit', sent.key.id, text]),
  })
  return { events, actor: make('a', 'b'), opponent: make('b', 'a'), unrelated: make('c', 'd'), make }
}
function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
test('both fighters are locked, other duels in the same group are independent', async () => {
  const { actor, opponent, unrelated } = setup(), hold = deferred()
  const scene = withBattleCinematic(actor, () => hold.promise)
  assert.equal(isBattleCinematicActive(actor), true)
  assert.equal(isBattleCinematicActive(opponent), true)
  assert.equal(isBattleCinematicActive(unrelated), false)
  assert.equal(isBattleCinematicActive({ ...actor, db: {} }), false)
  hold.resolve(); await scene
  assert.equal(isBattleCinematicActive(actor), false)
  assert.equal(isBattleCinematicActive(opponent), false)
})
test('simultaneous scenes cannot interleave; duplicate same-context delivery is suppressed', async () => {
  const { actor, opponent, events } = setup(), hold = deferred()
  const scene = withBattleCinematic(actor, () => hold.promise)
  assert.deepEqual(await showEndworldClash(opponent, 'forbidden', { sleep: async () => {} }), { suppressed: true })
  assert.equal(events.length, 0)
  hold.resolve(); await scene
  assert.deepEqual(await showCoordinate(actor, [{ damage: 1 }], 'duplicate'), { suppressed: true })
  assert.equal(events.length, 0)
})
test('stale generic renders remain suppressed even after the scene finishes', async () => {
  const { actor, opponent, unrelated } = setup()
  const old = battleOutputTicket(opponent), unaffected = battleOutputTicket(unrelated)
  await withBattleCinematic(actor, async () => {})
  assert.equal(suppressBattleOutput(opponent, old), true)
  assert.equal(suppressBattleOutput(unrelated, unaffected), false)
  assert.equal(suppressBattleOutput(actor), true) // trailing generic from the same action
  assert.equal(suppressBattleOutput(opponent, battleOutputTicket(opponent)), false)
})
test('settlement-cleared battle states still lock both explicitly supplied participants', async () => {
  const { actor, opponent } = setup(), hold = deferred()
  actor.player.battleState = opponent.player.battleState = null
  const scene = withBattleCinematic(actor, () => hold.promise, { participants: ['a', 'b'] })
  assert.equal(isBattleCinematicActive(opponent), true)
  hold.resolve(); await scene
  assert.equal(isBattleCinematicActive(opponent), false)
})
test('failed media and failed fallback release both locks; next command can render', async () => {
  const { actor, opponent, make } = setup()
  actor.replyImage = actor.reply = async () => { throw new Error('offline') }
  await assert.rejects(showEndworldClash(actor, 'result', { sleep: async () => {} }), /offline/)
  assert.equal(isBattleCinematicActive(actor), false)
  assert.equal(isBattleCinematicActive(opponent), false)
  const next = make('a', 'b')
  assert.equal(suppressBattleOutput(next, battleOutputTicket(next)), false)
})
test('100 varied delivery schedules preserve scene order and never unlock early', async () => {
  for (let round = 0; round < 100; round++) {
    const { actor, opponent, events } = setup()
    const sleep = async () => {
      assert.equal(isBattleCinematicActive(opponent), true)
      if (round % 2) await new Promise(resolve => setImmediate(resolve))
      else await Promise.resolve()
    }
    await showEndworldClash(actor, 'FINAL RESULT', { sleep })
    assert.deepEqual(events.map(e => e[0]), ['image', 'image', 'text', 'edit', 'edit'])
    assert.equal(events[3][1], events[4][1])
    assert.equal(events.at(-1)[2], 'FINAL RESULT')
    assert.equal(isBattleCinematicActive(opponent), false)
  }
})
test('200 seeded media/edit failure schedules never strand the presentation lock', async () => {
  let seed = 0xdeadbeef
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  for (let i = 0; i < 200; i++) {
    const { actor, opponent } = setup()
    const originalImage = actor.replyImage, originalEdit = actor.editReply
    actor.replyImage = async (...args) => { if (random() < 0.4) throw new Error('image'); return originalImage(...args) }
    actor.editReply = async (...args) => { if (random() < 0.4) throw new Error('edit'); return originalEdit(...args) }
    await showEndworldClash(actor, 'FINAL RESULT', { sleep: async () => {} })
    assert.equal(isBattleCinematicActive(actor), false)
    assert.equal(isBattleCinematicActive(opponent), false)
  }
})
