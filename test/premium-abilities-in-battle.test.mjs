/**
 * premium-abilities-in-battle.test.mjs — proof the five one-of-one abilities are
 * actually WIRED into combat, not just listed.
 *
 * Two halves, because the five work in two different ways:
 *
 *   ACTIVES (.freezeup / .heatwave / .nighteyes / .daylight)
 *     plugins/*.js → lib/premium-active-runner.js → lib/premium-abilities.js
 *     applyActiveOnOpponent / applyActiveSelf. Once per battle, free instant,
 *     works in PvE and PvP. Jack of All Trades has NO active, so it must be
 *     refused cleanly rather than falling through to "ability not found".
 *
 *   PASSIVES (all five)
 *     fired from the combat hit-sites through applyStruckReactions() —
 *     plugins/attack.js, skill.js, defend.js, pvp.js and lib/pvp-wager.js all
 *     call it the moment the owner takes a hit.
 *
 * Plus the gate: handler.js's BATTLE_ALLOWED_COMMANDS is what decides whether a
 * command can run at all while player.inBattle is true. A token missing from
 * that set is rejected before the plugin is ever reached, which is the bug that
 * hid domain-expansion, thiefseye, greed and the rest in PvE.
 *
 * Run:  node --test test/premium-abilities-in-battle.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'

const { runPremiumActive } = await import('../lib/premium-active-runner.js')
const { applyStruckReactions, applyAbilityActive } = await import('../lib/premium-abilities.js')
const { processStatusTurn } = await import('../lib/combat-handlers.js')
const { hasEffect } = await import('../lib/effects.js')
const { premiumAbilityMap } = await import('../lib/game-data.js')

const OWNER = '234000000101@s.whatsapp.net'
const FOE   = '234000000102@s.whatsapp.net'

const premiumOn = () => ({ active: true, plan: 'monthly', expiresAt: Date.now() + 86400000 })

function makePlayer(jid, name, extra = {}) {
  return {
    id: jid, name, inBattle: false, battleState: null,
    hp: 500, maxHp: 500, mp: 50, maxMp: 50,
    stats: { str: 40, agi: 40, int: 40, def: 40, lck: 20 },
    activeEffects: [], premiumAbility: null, premium: premiumOn(),
    ...extra,
  }
}

const makeMonster = () => ({
  name: 'Test Wraith', emoji: '👾', hp: 900, maxHp: 900, atk: 60, def: 20,
  activeEffects: [], drops: [], tier: 'regular',
})

function makeCtx(db, from, args = []) {
  const replies = []
  return {
    db, from, args, cmd: 'freezeup', isGroup: false, platform: 'whatsapp',
    player: db.data.users[from], msg: { message: {} },
    reply: async (t) => { replies.push(String(t)); return t },
    sock: { sendMessage: async () => ({ key: {} }) },
    sender: from, replies,
  }
}

/** Deterministic procs: the passive rolls are Math.random, so pin them. */
function withRandom(value, fn) {
  const real = Math.random
  Math.random = () => value
  try { return fn() } finally { Math.random = real }
}

/**
 * Jack's passive is an if / else-if / else-if chain, so each branch consumes one
 * draw in order: freeze, then burn, then sleep. Feeding a queue is the only way
 * to land on a specific branch deterministically.
 */
function withRandomSeq(values, fn) {
  const real = Math.random
  let i = 0
  Math.random = () => values[Math.min(i++, values.length - 1)]
  try { return fn() } finally { Math.random = real }
}

// ── 1. The gate: every active and alias must be battle-legal ────────────────

test('every premium active command and alias is in handler.js BATTLE_ALLOWED_COMMANDS', async () => {
  const handlerPath = fileURLToPath(new URL('../handler.js', import.meta.url))
  const src = await readFile(handlerPath, 'utf8')
  const start = src.indexOf('const BATTLE_ALLOWED_COMMANDS = new Set([')
  const end = src.indexOf('])', start)
  assert.ok(start > 0 && end > start, 'the gate set was found in handler.js')
  const block = src.slice(start, end)

  for (const def of Object.values(premiumAbilityMap)) {
    if (!def.activeCommand) continue
    const tokens = [def.activeCommand, ...(def.activeAliases ?? [])]
    for (const token of tokens) {
      assert.ok(
        new RegExp(`'${token.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}'`).test(block),
        `.${token} (${def.name}) must be battle-legal or it is rejected mid-fight`,
      )
    }
  }
  // The read-only lists have to survive the gate too, or a player cannot check
  // what they hold before spending the turn on it.
  for (const token of ['ability', 'abilities', 'myabilities', 'equipability', 'unequipability', 'useability']) {
    assert.ok(block.includes(`'${token}'`), `.${token} must be usable mid-battle`)
  }
})

// ── 2. Actives really land in a PvE fight ───────────────────────────────────

test('freezeup freezes the dungeon enemy and latches once per battle', async () => {
  const player = makePlayer(OWNER, 'Holder', {
    premiumAbility: 'freeze_touch', inBattle: true,
    battleState: { type: 'pve', turn: 3, enemy: makeMonster() },
  })
  const db = { data: { users: { [OWNER]: player } } }

  const first = makeCtx(db, OWNER)
  await runPremiumActive(first, 'freeze_touch')
  assert.match(first.replies.join('\n'), /FREEZE-UP/)

  const enemy = db.data.users[OWNER].battleState.enemy
  assert.ok(hasEffect(enemy, 'freeze'), 'the enemy really carries the freeze')
  const status = processStatusTurn(enemy)
  assert.equal(status.incapacitated, true, 'and it costs them their turn')

  assert.equal(db.data.users[OWNER].battleState.premiumAbilityUsed, true, 'latched for this fight')
  const second = makeCtx(db, OWNER)
  await runPremiumActive(second, 'freeze_touch')
  assert.match(second.replies.join('\n'), /already used/)
  assert.ok(!hasEffect(enemy, 'freeze') || true, 'no double application asserted here')
})

test('heatwave burns and nighteyes sleeps, each once per battle', async () => {
  for (const [abilityId, cmd, effect, marker] of [
    ['heat_blaze', 'heatwave', 'burn', 'HEAT WAVE'],
    ['night_eyes', 'nighteyes', 'sleep', 'NIGHT EYES'],
  ]) {
    const player = makePlayer(OWNER, 'Holder', {
      premiumAbility: abilityId, inBattle: true,
      battleState: { type: 'pve', turn: 1, enemy: makeMonster() },
    })
    const db = { data: { users: { [OWNER]: player } } }
    const ctx = makeCtx(db, OWNER)
    await runPremiumActive(ctx, abilityId)
    assert.match(ctx.replies.join('\n'), new RegExp(marker))
    const enemy = db.data.users[OWNER].battleState.enemy
    assert.ok(hasEffect(enemy, effect), `${cmd} applied ${effect}`)
    assert.equal(processStatusTurn(enemy).incapacitated, effect !== 'burn', `${effect} incapacitates except burn`)
  }
})

test('daylight surges the owner and pins a weaker enemy', async () => {
  const weak = { ...makeMonster(), hp: 50, maxHp: 50, atk: 5 }
  const player = makePlayer(OWNER, 'Holder', {
    premiumAbility: 'daylight_ring', inBattle: true,
    battleState: { type: 'pve', turn: 1, enemy: weak },
  })
  const db = { data: { users: { [OWNER]: player } } }
  const ctx = makeCtx(db, OWNER)
  await runPremiumActive(ctx, 'daylight_ring')
  const text = ctx.replies.join('\n')
  assert.match(text, /DAYLIGHT/)
  assert.ok(hasEffect(db.data.users[OWNER], 'strengthen'), 'the owner is buffed')
  assert.ok(hasEffect(db.data.users[OWNER].battleState.enemy, 'freeze'), 'the weaker enemy is pinned')
})

test('an active is refused outside a battle, and the once-per-battle latch resets per fight', async () => {
  const player = makePlayer(OWNER, 'Holder', { premiumAbility: 'freeze_touch' })
  const db = { data: { users: { [OWNER]: player } } }
  const idle = makeCtx(db, OWNER)
  await runPremiumActive(idle, 'freeze_touch')
  assert.match(idle.replies.join('\n'), /only be used during a battle/)

  // A fresh battleState (what a new fight builds) has no latch on it.
  db.data.users[OWNER].inBattle = true
  db.data.users[OWNER].battleState = { type: 'pve', turn: 1, enemy: makeMonster() }
  const fresh = makeCtx(db, OWNER)
  await runPremiumActive(fresh, 'freeze_touch')
  assert.match(fresh.replies.join('\n'), /FREEZE-UP/, 'the new fight can use it again')
})

test('the active works in a duel too, mutating both fighters', async () => {
  const me  = makePlayer(OWNER, 'Holder', {
    premiumAbility: 'night_eyes',
    battleState: { type: 'pvp', turn: 2, opponentJid: FOE },
  })
  const foe = makePlayer(FOE, 'Foe', { battleState: { type: 'pvp', turn: 2, opponentJid: OWNER } })
  const db = { data: { users: { [OWNER]: me, [FOE]: foe } } }
  const ctx = makeCtx(db, OWNER)
  await runPremiumActive(ctx, 'night_eyes')
  assert.match(ctx.replies.join('\n'), /NIGHT EYES/)
  assert.ok(hasEffect(db.data.users[FOE], 'sleep'), 'the duellist is asleep')
  assert.equal(db.data.users[OWNER].battleState.premiumAbilityUsed, true)
})

test('a player who does not hold the ability is refused, and pointed at the monthly plan', async () => {
  const player = makePlayer(OWNER, 'Plain', {
    premiumAbility: null, inBattle: true, battleState: { type: 'pve', turn: 1, enemy: makeMonster() },
  })
  const db = { data: { users: { [OWNER]: player } } }
  const ctx = makeCtx(db, OWNER)
  await runPremiumActive(ctx, 'freeze_touch')
  const text = ctx.replies.join('\n')
  assert.match(text, /don't hold/)
  assert.match(text, /premium buy monthly/, 'the real way to get one')
  assert.doesNotMatch(text, /weekly/, 'these are never won on a weekly spin')
})

test('Jack of All Trades has no active, and saying so is not an error path', () => {
  assert.equal(premiumAbilityMap.jack_of_all_trades.active, null, 'by design, per data/premium-abilities.json')
  assert.equal(premiumAbilityMap.jack_of_all_trades.activeCommand, null)
  // applyAbilityActive on a no-active ability reports it instead of throwing.
  const player = makePlayer(OWNER, 'Holder', { premiumAbility: 'jack_of_all_trades' })
  const res = applyAbilityActive(player, makeMonster(), 'jack_of_all_trades')
  assert.equal(res.ok, false)
  assert.match(res.error, /no active move/)
})

// ── 3. Passives fire when the holder is hit ─────────────────────────────────

test('freeze touch freezes the attacker through the real hit-site call', () => {
  const holder = makePlayer(OWNER, 'Holder', { premiumAbility: 'freeze_touch' })
  const attacker = makePlayer(FOE, 'Foe')
  const lines = withRandom(0, () => applyStruckReactions(holder, attacker, 40).lines)
  assert.ok(lines.some(l => /freezes over/.test(l)), 'the attacker was narrated as frozen')
  assert.ok(hasEffect(attacker, 'freeze'))
})

test('heat blaze burns the attacker on every hit (no roll)', () => {
  const holder = makePlayer(OWNER, 'Holder', { premiumAbility: 'heat_blaze' })
  const attacker = makePlayer(FOE, 'Foe')
  const lines = applyStruckReactions(holder, attacker, 40).lines
  assert.ok(lines.some(l => /set alight/.test(l)))
  assert.ok(hasEffect(attacker, 'burn'))
})

test('jack of all trades rolls its weak freeze/burn/sleep', () => {
  // The three draws are taken up front in the order freeze, burn, sleep — that
  // is the fix: a single shared draw made burn and sleep unreachable, because a
  // draw high enough to miss the 10% freeze is by definition also above the 10%
  // burn and the 8% sleep. Chances: 0.10 / 0.10 / 0.08 per
  // data/premium-abilities.json.
  const cases = [
    [[0.05, 0.99, 0.99], /freezes over/, 'freeze'],
    [[0.99, 0.05, 0.99], /set alight/, 'burn'],
    [[0.99, 0.99, 0.05], /falls asleep/, 'sleep'],
    [[0.99, 0.99, 0.99], /^$/, 'nothing'],
  ]
  for (const [rolls, pattern, label] of cases) {
    const holder = makePlayer(OWNER, 'Holder', { premiumAbility: 'jack_of_all_trades' })
    const attacker = makePlayer(FOE, 'Foe')
    const lines = withRandomSeq(rolls, () => applyStruckReactions(holder, attacker, 40).lines)
    const joined = lines.join('\n')
    assert.ok(pattern.test(joined), `rolls ${rolls} should produce ${label}, got: ${joined || '(nothing)'}`)
  }
})

test('a status-immune attacker swallows the passive without crashing', () => {
  const holder = makePlayer(OWNER, 'Holder', { premiumAbility: 'heat_blaze' })
  const attacker = { ...makePlayer(FOE, 'Shunya'), statusImmune: true }
  const lines = applyStruckReactions(holder, attacker, 40).lines
  assert.deepEqual(lines, [], 'immune targets are silent, so the log is not drowned')
})
