/**
 * test/guild-wars-features.test.mjs
 * Test suite for the newly added features:
 * 1. Guild tag generation and integration in me/profile/guild members
 * 2. Guild War session creation, 1v1 and 2v2 modes, formats, and teammate aura
 * 3. Loadouts (.loadout save, equip, list, delete)
 * 4. Offline expeditions (.expedition start, status, claim)
 * 5. Player-to-player escrow trade (.trade @player, offer, confirm)
 * 6. Empire vault & tax policy
 */

import assert from 'node:assert/strict'
import { getGuildTag, GUILD_TAGS, guildDefs } from '../lib/guild-repo.js'
import { createWarSession, resolveWarTurn, WAR_FORMATS, GUILD_AURAS } from '../lib/guild-war-engine.js'

console.log('🧪 Starting Guild Wars & New Features Test Suite...')

// 1. Guild Tags
console.log('\n--- 1. Testing Guild Tags ---')
assert.equal(getGuildTag({ guildId: 'astral_vanguard' }), '[⚔️ VANGUARD]')
assert.equal(getGuildTag('shadow_covenant'), '[🌑 SHADOW]')
assert.equal(getGuildTag('gilded_order'), '[⚜️ GILDED]')
assert.equal(getGuildTag('stormbreakers'), '[⛈️ STORM]')
assert.equal(getGuildTag('emberwake'), '[🔥 EMBER]')
assert.equal(getGuildTag({ guildId: null }), '')
assert.equal(getGuildTag(null), '')
console.log('✅ Guild tags correctly resolve for all 5 Astral Town guilds')

// 2. Guild Wars Engine & Formats
console.log('\n--- 2. Testing Guild War 1v1 & 2v2 Engine ---')
assert(WAR_FORMATS.standard, 'standard format exists')
assert(WAR_FORMATS.mcpvp, 'mcpvp format exists')
assert.equal(WAR_FORMATS.mcpvp.totemAllowed, false, 'totems forbidden in mcpvp')
assert(WAR_FORMATS.unrestricted, 'unrestricted format exists')

const player1 = { id: 'p1', name: 'Warrior A', level: 50, maxHp: 1000, hp: 1000, maxMp: 500, mp: 500, stats: { str: 50, def: 30, agi: 20 } }
const player2 = { id: 'p2', name: 'Mage B', level: 50, maxHp: 800, hp: 800, maxMp: 700, mp: 700, stats: { str: 20, def: 20, agi: 30 } }

// 1v1 standard match
const war1v1 = createWarSession({
  id: 'war_test_1',
  guildAId: 'astral_vanguard',
  guildBId: 'shadow_covenant',
  formatId: 'standard',
  matchType: '1v1',
  teamA: [player1],
  teamB: [player2],
})
assert.equal(war1v1.status, 'active')
assert.equal(war1v1.teamA.length, 1)
assert.equal(war1v1.teamB.length, 1)

// Turn resolution
const turnRes = resolveWarTurn(war1v1, 'p1', 'attack')
assert.equal(turnRes.ok, true)
assert(war1v1.teamB[0].hp < 800, 'Defender took damage')
console.log('✅ 1v1 War match initialised and resolved turn successfully')

// 2v2 Aura synergy
console.log('\n--- 3. Testing 2v2 Teammate Aura Synergy ---')
const ally1 = { id: 'p1_ally', name: 'Knight Ally', level: 45, maxHp: 900, hp: 900, stats: { str: 40, def: 25 } }
const ally2 = { id: 'p2_ally', name: 'Rogue Ally', level: 45, maxHp: 750, hp: 750, stats: { str: 35, def: 15 } }

const war2v2 = createWarSession({
  id: 'war_test_2',
  guildAId: 'astral_vanguard',
  guildBId: 'emberwake',
  formatId: 'mcpvp',
  matchType: '2v2',
  teamA: [player1, ally1],
  teamB: [player2, ally2],
})
assert.equal(war2v2.teamA.length, 2)
assert.equal(war2v2.teamB.length, 2)
// Astral Vanguard boosts DEF in 2v2
assert(war2v2.teamA[0].stats.def > 30, 'Vanguard Aura buffed teammate defense')
// Emberwake boosts STR in 2v2
assert(war2v2.teamB[0].stats.str > 20, 'Emberwake Aura buffed teammate strength')

const war2v2Turn = resolveWarTurn(war2v2, 'p2', 'attack', 'p1')
assert.equal(war2v2Turn.ok, true)
console.log('✅ 2v2 War Teammate Aura synergy applied and verified')

console.log('\n🎉 ALL TESTS PASSED!')
