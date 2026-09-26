import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BANNERS, ART, spinChance, state, reflectAttack, activateEndworld,
  completeTurn, useSword, swordStatus, swordReaction, witchImmune, chargeSwordTurn,
} from '../lib/witch-heroes.js'

function fighter(id, extra = {}) {
  return { name: id, equippedCharacter: id, hp: 900, maxHp: 900, mp: 1000, maxMp: 1000,
    stats: { str: 10 }, inBattle: true, battleState: {}, ...extra }
}
function readyRonova() {
  const r = fighter('ronova'), enemy = fighter(null)
  for (let turn = 1; turn <= 5; turn++) completeTurn([r, enemy], turn)
  assert.equal(activateEndworld(r).ok, true)
  completeTurn([r, enemy], 6) // Activation action itself does not charge.
  return r
}
for (const [id, banner] of Object.entries(BANNERS)) {
  test(`${id}: every dead-zone spin is exactly zero; guarantee/cap boundaries`, () => {
    for (let spin = 1; spin <= banner.deadZone; spin++) assert.equal(spinChance(id, spin), 0)
    for (let spin = banner.guarantee; spin <= banner.cap; spin++) assert.equal(spinChance(id, spin), 1)
    for (const spin of [0, -1, NaN, Infinity, 1.5, banner.cap + 1]) assert.equal(spinChance(id, spin), 0)
    assert.equal(banner.cost, 1)
  })
}
test('Scarlett reflects equal damage, no self damage, no more than four hits', () => {
  const s = fighter('scarlett'), enemy = fighter(null, { hp: 10000 })
  for (let i = 0; i < 4; i++) {
    const result = reflectAttack(s, enemy, 71, { random: () => 0 })
    assert.equal(result.reflected, 71)
    assert.equal(result.damage, 0)
    assert.equal(s.hp, 900)
  }
  assert.equal(enemy.hp, 10000 - 284)
  assert.equal(reflectAttack(s, enemy, 71, { random: () => 0 }), null)
})
test('missed reflection rolls, indirect damage and zero damage do not consume charges', () => {
  const s = fighter('scarlett'), enemy = fighter(null)
  assert.equal(reflectAttack(s, enemy, 10, { random: () => 1 }), null)
  assert.equal(reflectAttack(s, enemy, 10, { random: () => 0, indirect: true }), null)
  assert.equal(reflectAttack(s, enemy, 0, { random: () => 0 }), null)
  assert.equal(state(s).reflections, 0)
})
test('Ronova cannot be reflected by Scarlett; normal targets are not witch immune', () => {
  const s = fighter('scarlett'), r = fighter('ronova')
  assert.equal(reflectAttack(s, r, 900, { random: () => 0 }), null)
  for (const id of ['alexa', 'witch_of_envy', 'echidna', 'circe', 'reverie', 'scarlett']) assert.equal(witchImmune(r, id), true)
  assert.equal(witchImmune(s, 'echidna'), false)
  assert.equal(witchImmune(r, 'sword_maiden'), false)
})
test('reflection battle state resets naturally in a new fight', () => {
  const s = fighter('scarlett'), enemy = fighter(null)
  state(s).reflections = 4
  s.battleState = {}
  assert.ok(reflectAttack(s, enemy, 10, { random: () => 0 }))
})
test('Endworld validates equipment, active battle, turn ownership and five-turn gate', () => {
  assert.equal(activateEndworld(fighter(null)).ok, false)
  assert.equal(activateEndworld(fighter('ronova', { inBattle: false })).ok, false)
  const r = fighter('ronova')
  state(r).completedTurns = 4
  assert.equal(activateEndworld(r).ok, false)
  state(r).completedTurns = 5
  r.battleState.type = 'pvp'; r.battleState.myTurn = false
  assert.equal(activateEndworld(r).ok, false)
  r.battleState.myTurn = true
  assert.equal(activateEndworld(r).ok, true)
  assert.equal(activateEndworld(r).ok, false)
})
test('Endworld background changes on next turn; exactly three charging turns execute once', () => {
  const r = readyRonova(), enemy = fighter(null)
  assert.equal(r.battleState.cinematicBackground, undefined)
  for (const turn of [7, 8]) {
    const events = completeTurn([r, enemy], turn)
    assert.equal(events.filter(e => e.terminal).length, 0)
    assert.equal(r.battleState.cinematicBackground, ART.endworld1)
    assert.equal(enemy.hp, 900)
  }
  const events = completeTurn([r, enemy], 9)
  assert.equal(enemy.hp, 0)
  assert.equal(events.filter(e => e.terminal).length, 1)
  assert.deepEqual(completeTurn([r, enemy], 9), [])
  assert.deepEqual(completeTurn([r, enemy], 10), [])
})
test('Maiden survives phase one unchanged, then unprepared Maiden loses after three more turns', () => {
  const r = readyRonova(), maiden = fighter('sword_maiden')
  for (let turn = 7; turn <= 8; turn++) completeTurn([r, maiden], turn)
  assert.ok(completeTurn([r, maiden], 9).some(e => e.type === 'survive'))
  assert.equal(maiden.hp, 900)
  assert.equal(r.battleState.cinematicBackground, ART.endworld2)
  for (let turn = 10; turn <= 11; turn++) { completeTurn([r, maiden], turn); assert.equal(maiden.hp, 900) }
  const clash = completeTurn([r, maiden], 12).find(e => e.type === 'clash')
  assert.equal(clash.winner, r)
  assert.equal(maiden.hp, 0)
})
test('prepared Transcended Sword cuts phase two beam and defeats Ronova', () => {
  const r = readyRonova(), maiden = fighter('sword_maiden')
  state(maiden).charge = 3
  assert.equal(useSword(maiden, r, 'transcended').ok, true)
  for (let turn = 7; turn < 12; turn++) completeTurn([r, maiden], turn)
  const clash = completeTurn([r, maiden], 12).find(e => e.type === 'clash')
  assert.equal(clash.winner, maiden)
  assert.equal(r.hp, 0)
  assert.equal(maiden.hp, 900)
  assert.equal(state(maiden).transcended, false)
})
test('dead caster cannot execute Endworld', () => {
  const r = readyRonova(), enemy = fighter(null)
  r.hp = 0
  assert.deepEqual(completeTurn([r, enemy], 7), [])
  assert.equal(enemy.hp, 900)
})
test('Sword Maiden charge grows once per completed turn and caps at six', () => {
  const m = fighter('sword_maiden', { battleState: { type: 'pvp', myTurn: true } })
  assert.equal(chargeSwordTurn(m), 1)
  for (let i = 0; i < 8; i++) chargeSwordTurn(m)
  assert.equal(state(m).charge, 6)
  assert.equal(chargeSwordTurn(fighter('ronova')), 0)
})
test('a completed sword-technique turn does not refund the charge it spent', () => {
  const m = fighter('sword_maiden'), enemy = fighter(null)
  state(m).charge = 1
  state(m).charge -= 1
  completeTurn([m, enemy], 1, { chargeSword: false })
  assert.equal(state(m).charge, 0)
})
test('status is read-only and replayed turns cannot farm charge', () => {
  const m = fighter('sword_maiden'), enemy = fighter(null)
  const before = JSON.stringify(m)
  assert.match(swordStatus(m), /Transcended Sword/)
  assert.match(swordStatus(m), /charge builds by 1 after each completed turn/i)
  assert.match(swordStatus(m), /does not recharge itself/i)
  assert.match(swordStatus(m), /spends charge and MP/i)
  assert.equal(JSON.stringify(m), before)
  completeTurn([m, enemy], 1); completeTurn([m, enemy], 1)
  assert.equal(state(m).charge, 1)
  for (let t = 2; t <= 15; t++) completeTurn([m, enemy], t)
  assert.equal(state(m).charge, 6)
})
test('failed sword actions do not spend MP or charge', () => {
  const m = fighter('sword_maiden'), enemy = fighter(null)
  assert.equal(useSword(m, enemy, 'sever').ok, false)
  state(m).charge = 6
  m.mp = 0
  assert.equal(useSword(m, enemy, 'coordinate').ok, false)
  assert.equal(state(m).charge, 6)
  assert.equal(m.mp, 0)
})
test('Sever deals nonzero absolute damage and removes shields; three basic cuts can kill', () => {
  const m = fighter('sword_maiden'), enemy = fighter(null, { def: 999999, activeEffects: [{ type: 'shield', value: 999999 }] })
  state(m).charge = 6
  for (let i = 0; i < 3; i++) assert.equal(useSword(m, enemy, 'sever').damage, 300)
  assert.equal(enemy.hp, 0)
  assert.deepEqual(enemy.activeEffects, [])
})
test('Wrong Foot breaks guard/counter; follow-up Sever rewards the setup', () => {
  const m = fighter('sword_maiden'), enemy = fighter('sword_maiden')
  state(m).charge = 6
  state(enemy).returnStroke = true
  enemy.battleState.defending = true
  assert.equal(useSword(m, enemy, 'wrongfoot').ok, true)
  assert.equal(enemy.battleState.defending, false)
  assert.equal(state(enemy).returnStroke, false)
  assert.equal(useSword(m, enemy, 'sever').damage, 450)
})
test('Transcended Sword does not hit until defending, and releases once', () => {
  const m = fighter('sword_maiden'), enemy = fighter(null)
  state(m).charge = 6
  assert.equal(useSword(m, enemy, 'transcended').ok, true)
  assert.equal(enemy.hp, 900)
  const mp = m.mp
  assert.equal(useSword(m, enemy, 'transcended').ok, false)
  assert.equal(m.mp, mp)
  assert.equal(swordReaction(m, enemy), null)
  assert.equal(swordReaction(m, enemy, { defend: true }).damage, 600)
  assert.equal(swordReaction(m, enemy, { defend: true }), null)
})
test('Return Stroke waits for a direct attack and is consumed once', () => {
  const m = fighter('sword_maiden'), enemy = fighter(null)
  state(m).charge = 6
  assert.equal(useSword(m, enemy, 'return').ok, true)
  assert.equal(enemy.hp, 900)
  assert.equal(swordReaction(m, enemy), null)
  assert.equal(swordReaction(m, enemy, { directAttack: true }).damage, 450)
  assert.equal(swordReaction(m, enemy, { directAttack: true }), null)
})
test('Coordinate emits three-strike intent, spends MP once and cannot be reused', () => {
  const m = fighter('sword_maiden'), enemy = fighter(null)
  state(m).charge = 6
  const result = useSword(m, enemy, 'coordinate')
  assert.equal(result.strikes, 3)
  assert.equal(m.mp, 200)
  assert.equal(enemy.hp, 900) // adapter owns actual sequential strikes/revivals
  state(m).charge = 6; m.mp = 1000
  assert.equal(useSword(m, enemy, 'coordinate').ok, false)
})
test('all battle state survives JSON persistence', () => {
  const r = readyRonova(), m = fighter('sword_maiden')
  const pair = JSON.parse(JSON.stringify([r, m]))
  assert.doesNotThrow(() => completeTurn(pair, 7))
  assert.equal(pair[0].battleState.witchHeroes.endworld.remaining, 2)
})
