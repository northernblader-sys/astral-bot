import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canEnterDungeon,
  recordDungeonEntry,
  touchDungeonActivity,
  releaseDungeonSlot,
  getActiveDungeonSlots,
  clearDungeonSlots,
  isSameIdentity,
  normalizeIdentityKey,
  runDungeonIdleSweep,
  DUNGEON_IDLE_TIMEOUT_MS,
  MAX_DUNGEON_OCCUPANCY
} from '../lib/dungeon-slots.js'

test('Dungeon Slots: Capacity, Permissions, and Matching', async (t) => {
  const groupJid = '123456789@g.us'
  clearDungeonSlots()

  // 1. Identity matching across all formats (phone, LID, device suffix)
  assert.equal(isSameIdentity('2348000000001:1@s.whatsapp.net', '2348000000001@s.whatsapp.net'), true)
  assert.equal(isSameIdentity('1234567890:5@lid', '1234567890@lid'), true)
  assert.equal(isSameIdentity('1234567890', '1234567890@lid'), true)
  assert.equal(isSameIdentity('2348000000001@s.whatsapp.net', '2348000000002@s.whatsapp.net'), false)

  const mockDb = {
    data: {
      users: {
        'user1@s.whatsapp.net': {
          id: 'user1@s.whatsapp.net',
          phone: '2348001111111',
          name: 'Player One',
          inDungeon: true,
          inBattle: false,
          premium: { plan: null }
        },
        'user2@s.whatsapp.net': {
          id: 'user2@s.whatsapp.net',
          phone: '2348002222222',
          name: 'Player Two',
          inDungeon: true,
          inBattle: false,
          premium: { plan: null }
        },
        'user3@s.whatsapp.net': {
          id: 'user3@s.whatsapp.net',
          phone: '2348003333333',
          name: 'Player Three',
          inDungeon: false,
          inBattle: false,
          premium: { plan: null }
        },
        'premium_user@s.whatsapp.net': {
          id: 'premium_user@s.whatsapp.net',
          phone: '2348004444444',
          name: 'Whale User',
          inDungeon: false,
          inBattle: false,
          premium: { active: true, expiresAt: Date.now() + 1000000, plan: "monthly" }
        }
      }
    }
  }

  const p1 = mockDb.data.users['user1@s.whatsapp.net']
  const p2 = mockDb.data.users['user2@s.whatsapp.net']
  const p3 = mockDb.data.users['user3@s.whatsapp.net']
  const pPrem = mockDb.data.users['premium_user@s.whatsapp.net']

  // Player 1 enters
  const check1 = canEnterDungeon(groupJid, p1, '2348001111111:1@s.whatsapp.net', mockDb)
  assert.equal(check1.allowed, true)
  recordDungeonEntry(groupJid, p1, '2348001111111:1@s.whatsapp.net')

  // Player 2 enters
  const check2 = canEnterDungeon(groupJid, p2, '2348002222222@s.whatsapp.net', mockDb)
  assert.equal(check2.allowed, true)
  recordDungeonEntry(groupJid, p2, '2348002222222@s.whatsapp.net')

  assert.equal(getActiveDungeonSlots(groupJid, mockDb).length, 2)

  // Player 3 tries to enter -> denied (2 people already inside)
  const check3 = canEnterDungeon(groupJid, p3, '2348003333333@s.whatsapp.net', mockDb)
  assert.equal(check3.allowed, false)
  assert.match(check3.reason, /dungeon is currently at capacity/i)

  // Player 1 entering again (or advancing) -> allowed (they already have a slot)
  const check1Again = canEnterDungeon(groupJid, p1, 'user1@s.whatsapp.net', mockDb)
  assert.equal(check1Again.allowed, true)

  // Premium player enters -> allowed despite 2 players inside!
  const checkPrem = canEnterDungeon(groupJid, pPrem, 'premium_user@s.whatsapp.net', mockDb)
  assert.equal(checkPrem.allowed, true)
  assert.equal(checkPrem.isPremium, true)
  recordDungeonEntry(groupJid, pPrem, 'premium_user@s.whatsapp.net')

  // Still 2 non-premium players occupying the 2 base slots
  const check3StillDenied = canEnterDungeon(groupJid, p3, '2348003333333@s.whatsapp.net', mockDb)
  assert.equal(check3StillDenied.allowed, false)

  // Player 1 leaves dungeon
  releaseDungeonSlot(groupJid, p1, 'user1@s.whatsapp.net')
  p1.inDungeon = false

  // Player 3 can now enter!
  const check3NowAllowed = canEnterDungeon(groupJid, p3, '2348003333333@s.whatsapp.net', mockDb)
  assert.equal(check3NowAllowed.allowed, true)
})

test('Dungeon Slots: 10-minute idle kick and hidden tag announcement', async (t) => {
  const groupJid = 'group_idle_test@g.us'
  clearDungeonSlots()

  const mockDb = {
    data: {
      users: {
        'idle_guy@s.whatsapp.net': {
          id: 'idle_guy@s.whatsapp.net',
          phone: '2349000000000',
          name: 'Sleepy Head',
          inDungeon: true,
          inBattle: true,
          battleState: { enemy: { name: 'Slime' } },
          premium: { plan: null }
        },
        'prem_idle@s.whatsapp.net': {
          id: 'prem_idle@s.whatsapp.net',
          phone: '2349111111111',
          name: 'Rich Sleeper',
          inDungeon: true,
          inBattle: false,
          premium: { active: true, expiresAt: Date.now() + 10000000, plan: "monthly" }
        }
      }
    }
  }

  const idleP = mockDb.data.users['idle_guy@s.whatsapp.net']
  const premP = mockDb.data.users['prem_idle@s.whatsapp.net']

  recordDungeonEntry(groupJid, idleP, 'idle_guy@s.whatsapp.net')
  recordDungeonEntry(groupJid, premP, 'prem_idle@s.whatsapp.net')

  // Backdate their activity to 11 minutes ago
  const slots = getActiveDungeonSlots(groupJid, mockDb)
  for (const s of slots) {
    s.lastActivityAt = Date.now() - 11 * 60_000
  }

  let sentMessages = []
  const mockSock = {
    groupMetadata: async (jid) => ({
      id: jid,
      participants: [
        { id: 'idle_guy@s.whatsapp.net' },
        { id: 'prem_idle@s.whatsapp.net' },
        { id: 'member_a@s.whatsapp.net' },
        { id: 'member_b@s.whatsapp.net' },
      ]
    }),
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content })
      return {}
    }
  }

  const instances = [{ activeSock: mockSock }]

  // Run idle sweep
  await runDungeonIdleSweep(instances, mockDb)

  // 1. Idle regular player should be kicked out of dungeon
  assert.equal(idleP.inDungeon, false)
  assert.equal(idleP.inBattle, false)
  assert.equal(idleP.battleState, null)

  // 2. Premium user should NOT be kicked
  assert.equal(premP.inDungeon, true)

  // 3. Slot should be announced with hidden tag-all containing all group members
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].jid, groupJid)
  assert.match(sentMessages[0].content.text, /DUNGEON SLOT OPEN/i)
  assert.equal(sentMessages[0].content.mentions.length, 4)
  assert.ok(sentMessages[0].content.mentions.includes('member_a@s.whatsapp.net'))
  assert.ok(sentMessages[0].content.mentions.includes('member_b@s.whatsapp.net'))
})
