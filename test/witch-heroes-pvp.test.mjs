import test from 'node:test'
import assert from 'node:assert/strict'
import maidenActions from '../plugins/witch-heroes-actions.js'
import pvp from '../plugins/pvp.js'
import { state } from '../lib/witch-heroes.js'

function fighter(id, { equippedCharacter = null, myTurn = false, hp = 900, maxHp = 900 } = {}) {
  return {
    id,
    name: id,
    level: 50,
    equippedCharacter,
    inBattle: true,
    hp,
    maxHp,
    mp: 100,
    maxMp: 100,
    atk: 20,
    stats: { str: 20, agi: 20, int: 20, def: 10, lck: 10 },
    skills: [],
    equippedAbilities: [],
    pvp: {},
    battleState: {
      type: 'pvp',
      opponentJid: null,
      myTurn,
      defending: false,
      turn: 1,
      startedAt: Date.now(),
      lastMoveAt: Date.now(),
    },
  }
}

function context(me, them, cmd = 'sword', args = ['sever']) {
  const db = {
    data: { users: { [me.id]: me, [them.id]: them } },
    write: async () => {},
  }
  const replies = []
  return {
    db,
    from: me.id,
    sender: me.id,
    cmd,
    args,
    prefix: '.',
    player: me,
    reply: async text => { replies.push(String(text)); return {} },
    replyImage: async (_image, text) => { replies.push(String(text ?? '')); return {} },
    replies,
  }
}

test('Sword Maiden spends both resources in PvP and cannot self-recharge a technique', async () => {
  const maiden = fighter('maiden', { equippedCharacter: 'sword_maiden', myTurn: true })
  const rival = fighter('rival')
  maiden.battleState.opponentJid = rival.id
  rival.battleState.opponentJid = maiden.id
  const ctx = context(maiden, rival)

  // A sword command cannot bypass the charge requirement or burn MP early.
  await maidenActions.run(ctx)
  assert.match(ctx.replies.at(-1), /needs 1 charge and 25 MP/)
  assert.equal(maiden.mp, 100)
  assert.equal(maiden.battleState.myTurn, true)

  // A prior ordinary PvP turn charged the blade. The sword technique itself
  // consumes charge and does not refill it.
  state(maiden).charge = 1
  ctx.replies.length = 0
  await maidenActions.run(ctx)
  assert.equal(maiden.mp, 75)
  assert.equal(state(maiden).charge, 0, 'the sword technique must spend charge and cannot refill itself')
  assert.equal(maiden.battleState.myTurn, false)
  assert.equal(maiden.battleState.turn, 2)
  assert.equal(rival.battleState.myTurn, true)
  assert.ok(rival.hp < 900)

  // The same holder cannot repeat the move before the opponent takes a turn.
  const mpAfterMove = maiden.mp
  const chargeAfterMove = state(maiden).charge
  await maidenActions.run(ctx)
  assert.match(ctx.replies.at(-1), /not your turn/i)
  assert.equal(maiden.mp, mpAfterMove)
  assert.equal(state(maiden).charge, chargeAfterMove)
})

test('ordinary PvP turns build charge and the move list explains Maiden costs', async () => {
  const maiden = fighter('maiden', { equippedCharacter: 'sword_maiden', myTurn: true, hp: 500, maxHp: 500 })
  const rival = fighter('rival', { hp: 10000, maxHp: 10000 })
  maiden.battleState.opponentJid = rival.id
  rival.battleState.opponentJid = maiden.id
  const board = context(maiden, rival, 'pvp', ['moves'])
  await pvp.run(board)
  assert.match(board.replies[0], /\+1 after each completed non-sword PvP turn/i)
  assert.match(board.replies[0], /Sever.*1 charge · 25 MP/)
  assert.match(board.replies[0], /\.sword sever/)

  const turn = context(maiden, rival, 'pvp', ['attack'])
  await pvp.run(turn)
  assert.equal(state(maiden).charge, 1)
  assert.equal(maiden.battleState.turn, 2)
  assert.equal(maiden.battleState.myTurn, false)
  assert.equal(rival.battleState.myTurn, true)
})
