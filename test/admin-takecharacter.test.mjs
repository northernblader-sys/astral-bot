import test from 'node:test'
import assert from 'node:assert/strict'

import { clearCharacter, takeCharacter, takeMonds } from '../plugins/admin.js'
import { getExclusiveSpinWinner } from '../lib/season-engine.js'
import { characterMap } from '../lib/game-data.js'

const TARGET = 'jasyne-test'
const OTHER = 'other-test'
const SCARLETT = characterMap.scarlett

function makeDb({ ownedCharacters = [], winner = TARGET } = {}) {
  const player = {
    id: TARGET,
    name: 'Jasyne',
    ownedCharacters,
    equippedCharacter: null,
  }
  return {
    data: {
      users: { [TARGET]: player },
      seasonRuntime: { exclusiveSpinWinners: { [SCARLETT.id]: winner } },
    },
    write: async () => {},
  }
}

async function invoke(db) {
  const replies = []
  await takeCharacter({
    args: [null, SCARLETT.id],
    db,
    from: TARGET,
    platform: 'test',
    reply: async (text) => { replies.push(text); return text },
  })
  return replies.join('\n')
}

test('takecharacter clears a stale exclusive winner claim when ownership entry is missing', async () => {
  const db = makeDb({ ownedCharacters: [], winner: TARGET })

  const reply = await invoke(db)

  assert.match(reply, /Cleared the stale one-of-one claim/)
  assert.equal(getExclusiveSpinWinner(db, SCARLETT.id), null)
  assert.deepEqual(db.data.users[TARGET].ownedCharacters, [])
})

test('takecharacter does not clear another player’s exclusive lock', async () => {
  const db = makeDb({ ownedCharacters: [SCARLETT.id], winner: OTHER })

  const reply = await invoke(db)

  assert.match(reply, /Removed/)
  assert.deepEqual(db.data.users[TARGET].ownedCharacters, [])
  assert.equal(getExclusiveSpinWinner(db, SCARLETT.id), OTHER)
})

test('clearcharacter removes the prior owner and reopens the exclusive claim', async () => {
  const db = makeDb({ ownedCharacters: [SCARLETT.id], winner: TARGET })
  const replies = []
  await clearCharacter({
    args: [null, SCARLETT.id], db, from: TARGET, platform: 'test',
    reply: async (text) => { replies.push(text); return text },
  })

  assert.match(replies.join('\n'), /claim is open again/)
  assert.deepEqual(db.data.users[TARGET].ownedCharacters, [])
  assert.equal(getExclusiveSpinWinner(db, SCARLETT.id), null)
})

test('takemond collects the requested amount and leaves the remaining balance', async () => {
  const db = makeDb({ ownedCharacters: [] })
  db.data.users[TARGET].wallet = { monds: 8 }
  const replies = []
  await takeMonds({
    args: [null, '3'], db, from: TARGET, platform: 'test',
    reply: async (text) => { replies.push(text); return text },
  })

  assert.match(replies.join('\n'), /Collected \*3 🪙 Monds\*/)
  assert.equal(db.data.users[TARGET].wallet.monds, 5)
})
