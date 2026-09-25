/**
 * ability-equip-routing.test.mjs — regression tests for the player report of
 * 2026-09-26.
 *
 * The report, verbatim: a player who owns Jack of All Trades ran the ability
 * equip command and got
 *
 *     ❌ You don't own an ability matching "jack_of_all_trades".
 *     Yours are listed under .ability.
 *
 * ...and `.ability` then showed them Jack of All Trades sitting right there.
 *
 * Cause: handleEquip() in plugins/ability.js only ever searched
 * player.abilityInventory, and the five one-of-one premium abilities never live
 * there — they sit on player.premiumAbility with their own engine
 * (lib/premium-abilities.js) and no slot at all. So for the exact player the
 * command was written for, nothing could ever match, and the reply pointed at a
 * list that contradicted it. data/abilities.json holds exactly ONE generic
 * ability (Crown's Favor), so "equip" was effectively dead for nearly everyone.
 *
 * Also covered here:
 *   - every list in the plugin prints the COMMAND that fires each ability
 *     (the report: "list the commands for them beside the ability")
 *   - `.equipability` / `.unequipability` resolve to the same code path
 *   - `.useability jack of all trades` no longer falls through to "not found"
 *
 * Run:  node --test test/ability-equip-routing.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const abilityPlugin = (await import('../plugins/ability.js')).default
const { commandFor, ownedLine } = await import('../plugins/ability.js')
const useabilityPlugin = (await import('../plugins/useability.js')).default
const { premiumAbilityMap, abilities } = await import('../lib/game-data.js')

const HOLDER = '234000000101@s.whatsapp.net'
const OTHER  = '234000000102@s.whatsapp.net'

function makePlayer(jid, name, extra = {}) {
  return {
    id: jid, name, level: 10, xp: 0,
    stats: { str: 20, agi: 20, int: 20, def: 20, lck: 10 },
    wallet: { solars: 0, gems: 0 }, inventory: [],
    abilityInventory: [], equippedAbilities: [], abilitySlots: 1,
    premiumAbility: null, premium: { active: false },
    ...extra,
  }
}

function makeDb(users) {
  return { data: { users: Object.fromEntries(users.map(u => [u.id, u])) } }
}

/** ctx shaped the way handler.js builds it: args WITHOUT the command word. */
function makeCtx(db, from, args, cmd = 'ability') {
  const replies = []
  return {
    db, from, args, cmd, isGroup: false, platform: 'whatsapp',
    player: db.data.users[from], msg: { message: {} },
    reply: async (text) => { replies.push(String(text)); return text },
    sock: { sendMessage: async () => ({ key: {} }) },
    sender: 'g@g.us', replies,
  }
}

const run = async (db, from, args, cmd = 'ability') => {
  const ctx = makeCtx(db, from, args, cmd)
  await abilityPlugin.run(ctx)
  return ctx.replies.join('\n')
}

const jackHolder = () => makePlayer(HOLDER, 'Holder', {
  premiumAbility: 'jack_of_all_trades',
  premium: { active: true, plan: 'monthly', expiresAt: Date.now() + 86400000 },
})

// ── 1. The exact reported failure ────────────────────────────────────────────

test('the report: the holder of jack_of_all_trades is no longer told they do not own it', async () => {
  for (const query of ['jack_of_all_trades', 'jack of all trades', 'jac']) {
    const db = makeDb([jackHolder()])
    const text = await run(db, HOLDER, ['equip', query])
    assert.doesNotMatch(text, /don't own an ability matching/, `query "${query}" must not say they do not own it`)
    assert.match(text, /Jack of All Trades/, `query "${query}" names the ability`)
    assert.match(text, /already on you/, `query "${query}" explains it is already active`)
    assert.match(text, /never takes a slot/, `query "${query}" explains why equip is the wrong verb`)
  }
})

test('unequipping a one-of-one says it was never in a slot, not "isn\'t in one of your slots"', async () => {
  const db = makeDb([jackHolder()])
  const text = await run(db, HOLDER, ['unequip', 'jack of all trades'])
  assert.match(text, /can't be unequipped/)
  assert.match(text, /never in a slot/)
})

test('a one-of-one is NOT pushed into equippedAbilities by the equip path', async () => {
  const db = makeDb([jackHolder()])
  await run(db, HOLDER, ['equip', 'jack_of_all_trades'])
  assert.deepEqual(db.data.users[HOLDER].equippedAbilities, [], 'nothing was equipped')
  assert.equal(db.data.users[HOLDER].premiumAbility, 'jack_of_all_trades', 'and nothing was lost')
})

// ── 2. Routing for the other four, and for people who do not hold one ────────

test('equipping a one-of-one you hold names its battle command', async () => {
  const db = makeDb([makePlayer(HOLDER, 'Holder', { premiumAbility: 'freeze_touch' })])
  const text = await run(db, HOLDER, ['equip', 'freeze touch'])
  assert.match(text, /\.freezeup/, 'the active command is printed')
  assert.match(text, /\.freeze/, 'and its aliases')
})

test('equipping a one-of-one someone else holds says who holds it', async () => {
  const db = makeDb([
    makePlayer(HOLDER, 'Holder', { premiumAbility: 'freeze_touch' }),
    makePlayer(OTHER, 'Plain'),
  ])
  db.data.seasonRuntime = { exclusiveSpinWinners: { 'ability:freeze_touch': HOLDER } }
  const text = await run(db, OTHER, ['equip', 'freeze touch'])
  assert.match(text, /isn't yours to equip/)
  assert.match(text, /Holder/, 'the holder is named')
  assert.match(text, /premium buy monthly/, 'and the real way to get one')
})

test('an ability nobody holds points at the monthly plan, not a spin', async () => {
  const db = makeDb([makePlayer(OTHER, 'Plain')])
  const text = await run(db, OTHER, ['equip', 'night eyes'])
  assert.match(text, /premium buy monthly/)
  assert.doesNotMatch(text, /weekly/, 'these are gifted monthly, never spun weekly')
})

test('an unknown name still says so, but now lists what you actually hold', async () => {
  const db = makeDb([makePlayer(HOLDER, 'Holder', {
    premiumAbility: 'heat_blaze', abilityInventory: ['premium_favor'], equippedAbilities: ['premium_favor'],
  })])
  const text = await run(db, HOLDER, ['equip', 'zzzzz'])
  assert.match(text, /don't own an ability matching/)
  assert.match(text, /Heat Blaze/, 'the one-of-one is listed')
  assert.match(text, /Crown's Favor/, 'and so is the slot ability')
  assert.match(text, /ability all/, 'with the way to see everything')
})

test('bare ".ability equip" lists what can be equipped instead of failing', async () => {
  const db = makeDb([jackHolder()])
  const text = await run(db, HOLDER, ['equip'])
  assert.match(text, /Usage: \*\.ability equip <name>\*/)
  assert.match(text, /Jack of All Trades/)
})

// ── 3. .equipability / .unequipability ──────────────────────────────────────

test('.equipability and .unequipability are real aliases of the same plugin', () => {
  assert.ok(abilityPlugin.aliases.includes('equipability'))
  assert.ok(abilityPlugin.aliases.includes('unequipability'))
})

test('.equipability <name> lands on the same code path as .ability equip <name>', async () => {
  // Two separate DBs: equipping mutates equippedAbilities, so comparing two runs
  // against one record would compare "equipped" with "already equipped".
  const mk = () => makeDb([makePlayer(HOLDER, 'Holder', {
    premiumAbility: 'jack_of_all_trades', abilityInventory: ['premium_favor'],
  })])
  const viaAlias = await run(mk(), HOLDER, ["crown's favor"], 'equipability')
  const viaSub = await run(mk(), HOLDER, ['equip', "crown's favor"], 'ability')
  assert.equal(viaAlias, viaSub)
  assert.match(viaAlias, /Crown's Favor equipped/)
})

test('.equipability with no argument lists what you hold', async () => {
  const db = makeDb([jackHolder()])
  const text = await run(db, HOLDER, [], 'equipability')
  assert.match(text, /Usage: \*\.equipability <name>\*/)
  assert.match(text, /Jack of All Trades/)
})

// ── 4. Commands printed beside every ability ────────────────────────────────

test('every one-of-one renders its own battle command', () => {
  assert.match(commandFor(premiumAbilityMap.freeze_touch), /\.freezeup/)
  assert.match(commandFor(premiumAbilityMap.heat_blaze), /\.heatwave/)
  assert.match(commandFor(premiumAbilityMap.night_eyes), /\.nighteyes/)
  assert.match(commandFor(premiumAbilityMap.daylight_ring), /\.daylight/)
  // Jack has no active at all — it must say so instead of inventing a command.
  assert.match(commandFor(premiumAbilityMap.jack_of_all_trades), /no command: passive, always on/)
})

test('.ability all prints a command line under every single ability', async () => {
  const db = makeDb([jackHolder()])
  const text = await run(db, HOLDER, ['all'])
  for (const def of Object.values(premiumAbilityMap)) {
    assert.ok(text.includes(def.name), `${def.name} is listed`)
  }
  for (const def of abilities) {
    assert.ok(text.includes(def.name), `${def.name} is listed`)
  }
  // One "▸" command line per listed ability, premium and generic alike.
  const lines = text.split('\n').filter(l => l.includes('▸')).length
  assert.equal(lines, Object.keys(premiumAbilityMap).length + abilities.length)
  assert.match(text, /\.freezeup/)
  assert.match(text, /\.heatwave/)
  assert.match(text, /\.nighteyes/)
  assert.match(text, /\.daylight/)
})

test('.ability overview carries the battle command beside the one-of-one', async () => {
  const db = makeDb([makePlayer(HOLDER, 'Holder', {
    premiumAbility: 'freeze_touch', abilityInventory: ['premium_favor'],
  })])
  const text = await run(db, HOLDER, [])
  assert.match(text, /In battle:\* \*\.freezeup\*/)
  assert.match(text, /One-of-ones never take a slot/)
  assert.match(text, /equip with \*\.ability equip Crown's Favor\*/)
})

test('the one-of-one detail page shows the command and never contradicts ownership', async () => {
  const db = makeDb([jackHolder()])
  const text = await run(db, HOLDER, ['jack of all trades'])
  assert.match(text, /In battle:\*/)
  assert.match(text, /that's you/i, 'the holder line names the player, not "unclaimed"')
  assert.doesNotMatch(text, /unclaimed/, 'a held ability must never read as unclaimed')
  assert.match(text, /takes no slot/)
})

test('ownedLine names every ability and its command, and the empty case', () => {
  const held = ownedLine(makePlayer(HOLDER, 'Holder', {
    premiumAbility: 'heat_blaze', abilityInventory: ['premium_favor'], equippedAbilities: ['premium_favor'],
  }))
  assert.match(held, /Heat Blaze/)
  assert.match(held, /\.heatwave/)
  assert.match(held, /Crown's Favor/)
  assert.match(held, /\(equipped\)/)

  const empty = ownedLine(makePlayer(OTHER, 'Plain'))
  assert.match(empty, /Nothing yet/)
  assert.match(empty, /\.premium/)
})

// ── 5. .useability must not swallow a passive one-of-one ────────────────────

test('.useability jack of all trades explains the passive instead of "not found"', async () => {
  const db = makeDb([jackHolder()])
  const ctx = makeCtx(db, HOLDER, ['jack of all trades'], 'useability')
  ctx.player.battleState = { type: 'pvp', opponentJid: OTHER }
  ctx.player.inBattle = false
  await useabilityPlugin.run(ctx)
  const text = ctx.replies.join('\n')
  assert.match(text, /has no active move/)
  assert.match(text, /passive only/)
  assert.doesNotMatch(text, /not found or not equipped/)
})
