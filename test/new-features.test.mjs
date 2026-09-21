/**
 * new-features.test.mjs — regression tests for the 2026-09-21 batch:
 *
 *  1. PREMIUM ABILITY GRANT — every premium buyer must end up with an ability
 *     in their equipped ability slot: monthly buyers are GIFTED a random
 *     one-of-one outright (no spin, no luck roll — rendered from
 *     player.premiumAbility), everyone else gets Crown's Favor
 *     (data/abilities.json, equipped when a slot is free). No duplicates on
 *     repeat purchases. Everything granted is stripped when Premium expires
 *     (stripPremiumAbilities). The reported bugs: buyers checked their slot
 *     and saw nothing, and the old weekly luck-spin could leave a paying
 *     buyer with "Spin: no ability.".
 *
 *  2. CROWN'S FAVOR IS REAL — it resolves in the generic ability engine and
 *     applyPassiveAbilities() applies its all-stat strengthen at battle start.
 *
 *  3. .RANKS LADDER — formatFullRankLadder() lists EVERY attainable rank,
 *     highest to lowest: the four post-cap prestige titles (LM, GM, Am, Pro)
 *     on top, then the ten Lv 1–100 ranks down to E-Rank "Beginner" at the
 *     foot, in exactly that order.
 *
 *  4. ART DROP — lib/image.js's map resolves every new banner (armor shop,
 *     all five guilds, premium, top-up, payment-done, rank-up) to the correct
 *     ImgBB URL.
 *
 *  5. .GIVEBEAST — owner-only beast grant: new beast lands with its starting
 *     CP and auto-equips when no active beast; the 4-beast cap and the
 *     one-per-beast roster rule are enforced; non-owners are refused.
 *
 *  6. .GIVEABILITY — generic grants (inventory + auto-equip) and the
 *     one-of-one premium path (claim registry: refused when held by another
 *     player, refused when the target already holds one, claimed atomically
 *     with the grant when free).
 *
 * Run:  node test/new-features.test.mjs
 */
import assert from 'node:assert/strict'

const { grantPremiumAbility, PREMIUM_ABILITY_ID, abilityRegistryKey } = await import('../lib/premium-abilities.js')
const { applyPassiveAbilities, getAbilityDef } = await import('../lib/ability-engine.js')
const { formatFullRankLadder } = await import('../lib/rank-engine.js')
const { resolveImageSource } = await import('../lib/image.js')
const { giveBeast, findBeastDef } = await import('../plugins/givebeast.js')
const { giveAbility, findAbilityDef, listGrantableAbilities } = await import('../plugins/giveability.js')
const giveSummonPlugin = (await import('../plugins/givesummon.js')).default
const { ranks } = await import('../lib/game-data.js')
const { PRESTIGE_TIERS } = await import('../lib/title-engine.js')
const { getExclusiveSpinWinner } = await import('../lib/season-engine.js')
const { BEAST_MAX_OWNED, findOwnedBeast } = await import('../lib/beast-engine.js')

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (err) { failures.push({ name, err }); console.log(`FAIL  ${name}\n      ${err.message}`) }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const OWNER = '2347062301848@s.whatsapp.net' // config.js default owner number
const BUYER = '234000000101@s.whatsapp.net'
const OTHER = '234000000102@s.whatsapp.net'

function makePlayer(jid, name, extra = {}) {
  return {
    id: jid,
    name,
    level: 10,
    xp: 0,
    stats: { str: 20, agi: 20, int: 20, def: 20, lck: 10 },
    wallet: { solars: 0, gems: 0 },
    inventory: [],
    skills: [],
    activeEffects: [],
    abilityInventory: [],
    equippedAbilities: [],
    abilitySlots: 1,
    summonedBeasts: [],
    beastInventory: [],
    activeBeast: null,
    premium: { active: false },
    registeredAt: Date.now(),
    ...extra,
  }
}

function makeDb(users) {
  return { data: { users: Object.fromEntries(users.map(u => [u.id, u])) } }
}

function makeCtx(db, from, args, { mention = null } = {}) {
  const replies = []
  const ctx = {
    db,
    from,
    args,
    isGroup: false,
    platform: 'whatsapp',
    msg: mention
      ? { message: { extendedTextMessage: { contextInfo: { mentionedJid: [mention] } } } }
      : {},
    reply: async (text) => { replies.push(String(text)) },
    sock: { sendMessage: async () => ({}) },
    sender: from,
  }
  return { ctx, replies }
}

// ══════════════════════════════════════════════════════════════════════════
// 1. Premium ability grant
// ══════════════════════════════════════════════════════════════════════════

await test('standard buyer (no gift in play) gets Crown\'s Favor equipped', () => {
  const p = makePlayer(BUYER, 'Buyer')
  const res = grantPremiumAbility(p, null)
  assert.equal(res.granted, 'new')
  assert.equal(res.id, PREMIUM_ABILITY_ID)
  assert.equal(res.equipped, true)
  assert.deepEqual(p.abilityInventory, [PREMIUM_ABILITY_ID])
  assert.deepEqual(p.equippedAbilities, [PREMIUM_ABILITY_ID])
})

await test('monthly gift winner keeps the one-of-one, no standard grant on top', () => {
  const p = makePlayer(BUYER, 'Buyer')
  const res = grantPremiumAbility(p, { outcome: 'won', abilityId: 'freeze_touch' })
  assert.equal(res.granted, 'gift')
  assert.equal(res.id, 'freeze_touch')
  assert.equal(p.abilityInventory.length, 0, 'no duplicate standard ability for gift holders')
  assert.equal(p.equippedAbilities.length, 0)
})

await test('renewal keeping a one-of-one (gift already) gets no standard grant on top', () => {
  const p = makePlayer(BUYER, 'Buyer', { premiumAbility: 'heat_blaze' })
  const res = grantPremiumAbility(p, { outcome: 'already', abilityId: 'heat_blaze' })
  assert.equal(res.granted, 'gift')
  assert.equal(res.id, 'heat_blaze')
  assert.equal(p.abilityInventory.length, 0)
})

await test('sold-out monthly buyer still walks away with an ability (Crown\'s Favor)', () => {
  const p = makePlayer(BUYER, 'Buyer')
  const res = grantPremiumAbility(p, { outcome: 'sold_out' })
  assert.equal(res.granted, 'new')
  assert.equal(res.equipped, true)
  assert.ok(p.equippedAbilities.includes(PREMIUM_ABILITY_ID))
})

await test('repeat buyer does not get a second copy', () => {
  const p = makePlayer(BUYER, 'Buyer')
  grantPremiumAbility(p, null)
  const res = grantPremiumAbility(p, { outcome: 'sold_out' })
  assert.equal(res.granted, 'already')
  assert.equal(p.abilityInventory.filter(id => id === PREMIUM_ABILITY_ID).length, 1)
  assert.equal(p.equippedAbilities.filter(id => id === PREMIUM_ABILITY_ID).length, 1)
})

await test('slots full — granted and owned, but not auto-equipped', () => {
  const p = makePlayer(BUYER, 'Buyer', {
    equippedAbilities: ['some_other_ability'],
    abilitySlots: 1,
  })
  const res = grantPremiumAbility(p, null)
  assert.equal(res.granted, 'new')
  assert.equal(res.equipped, false)
  assert.ok(p.abilityInventory.includes(PREMIUM_ABILITY_ID))
  assert.equal(p.equippedAbilities.includes(PREMIUM_ABILITY_ID), false)
  assert.equal(p.equippedAbilities.length, 1, 'slot cap respected')
})

// ══════════════════════════════════════════════════════════════════════════
// 2. Crown's Favor is a real generic ability
// ══════════════════════════════════════════════════════════════════════════

await test('Crown\'s Favor resolves in the ability engine', () => {
  const def = getAbilityDef(PREMIUM_ABILITY_ID)
  assert.ok(def, 'premium_favor must exist in data/abilities.json')
  assert.equal(def.type, 'passive')
  assert.equal(def.rarity, 'epic')
  assert.equal(def.effects.length, 5)
})

await test('Crown\'s Favor applies all-stat strengthen at battle start', () => {
  const p = makePlayer(BUYER, 'Buyer')
  p.equippedAbilities = [PREMIUM_ABILITY_ID]
  applyPassiveAbilities(p)
  const strengthened = (p.activeEffects ?? [])
    .filter(e => e.type === 'strengthen')
    .map(e => e.meta?.stat)
    .sort()
  assert.deepEqual(strengthened, ['agi', 'def', 'int', 'lck', 'str'])
})

// ══════════════════════════════════════════════════════════════════════════
// 3. .ranks — the full ladder, GM/LM down to Beginner
// ══════════════════════════════════════════════════════════════════════════

await test('ladder covers ALL ranks: 4 prestige + every level rank', () => {
  const ladder = formatFullRankLadder()
  const lines = ladder.split('\n')
  assert.equal(lines.length, PRESTIGE_TIERS.length + ranks.length)
  for (const tier of PRESTIGE_TIERS) assert.ok(ladder.includes(tier.name), `missing prestige ${tier.name}`)
  for (const r of ranks) assert.ok(ladder.includes(r.title), `missing rank ${r.title}`)
})

await test('ladder order: prestige on top, E-Rank (Beginner) at the foot', () => {
  const ladder = formatFullRankLadder()
  const iLm = ladder.indexOf('Ⓛ🅜')
  const iGm = ladder.indexOf('Ⓖ🅜')
  const iAm = ladder.indexOf('Ⓐ🅜')
  const iPro = ladder.indexOf('Ⓟⓡⓞ')
  const iSov = ladder.indexOf('Shadow Sovereign')
  const iE = ladder.indexOf('E-Rank Hunter')
  assert.ok(iLm !== -1 && iGm !== -1 && iAm !== -1 && iPro !== -1, 'prestige titles present')
  assert.ok(iLm < iGm && iGm < iAm && iAm < iPro, 'prestige order LM→GM→Am→Pro')
  assert.ok(iPro < iSov, 'prestige sits above the level ranks')
  assert.ok(iSov < iE, 'Shadow Sovereign above E-Rank')
  assert.ok(iE === ladder.lastIndexOf('E-Rank Hunter'), 'E-Rank is the last line')
  assert.match(ladder.split('\n').pop(), /Beginner/, 'E-Rank line marks the beginner rung')
})

// ══════════════════════════════════════════════════════════════════════════
// 4. Art drop — image map resolution
// ══════════════════════════════════════════════════════════════════════════

const ART = {
  'armor-shop.jpg':          'https://i.ibb.co/6RgWqj7f/armor-shop.jpg',
  'guild-astral-vanguard.jpg': 'https://i.ibb.co/n8jYTqB8/Vanguard.jpg',
  'guild-shadow-covenant.jpg': 'https://i.ibb.co/SDGHY92s/shdow.jpg',
  'guild-gilded-order.jpg':  'https://i.ibb.co/RGqS2XwB/gilded-order.jpg',
  'guild-stormbreakers.jpg': 'https://i.ibb.co/5XNnjzgn/stormbraker.jpg',
  'guild-emberwake.jpg':     'https://i.ibb.co/23BPJ3kG/emberwake.jpg',
  'premium.jpg':             'https://i.ibb.co/prGbM4Mr/premium.jpg',
  'top-up.jpg':              'https://i.ibb.co/rG4dKqLS/top-up.jpg',
  'payment_done.jpg':        'https://i.ibb.co/x88P74cB/1046172188426924946.jpg',
  'rank-up.jpg':             'https://i.ibb.co/sdPTB84c/rank-up.jpg',
}

for (const [file, url] of Object.entries(ART)) {
  await test(`image map resolves ${file}`, () => {
    assert.equal(resolveImageSource(file), url)
  })
}

// ══════════════════════════════════════════════════════════════════════════
// 5. .givebeast
// ══════════════════════════════════════════════════════════════════════════

await test('givebeast resolves by id and by partial name', () => {
  assert.equal(findBeastDef('ember_hatchling')?.id, 'ember_hatchling')
  assert.equal(findBeastDef('ember hatchling')?.id, 'ember_hatchling')
  assert.equal(findBeastDef('hatchling')?.id, 'ember_hatchling')
  assert.equal(findBeastDef('nope_nope'), null)
})

await test('givebeast grants with starting CP and auto-equips when idle', async () => {
  const owner = makePlayer(OWNER, 'Owner')
  const target = makePlayer(BUYER, 'Buyer')
  const db = makeDb([owner, target])
  const { ctx, replies } = makeCtx(db, OWNER, ['givebeast', 'ember_hatchling'], { mention: BUYER })
  await giveBeast(ctx)
  const fresh = db.data.users[BUYER]
  assert.equal(fresh.summonedBeasts.length, 1)
  assert.equal(fresh.summonedBeasts[0].beastId, 'ember_hatchling')
  assert.equal(fresh.summonedBeasts[0].cp, 50)
  assert.ok(findOwnedBeast(fresh, 'ember_hatchling'))
  assert.equal(fresh.activeBeast, 'ember_hatchling', 'auto-equipped when no active beast')
  assert.match(replies[0], /Granted .*Ember Hatchling/)
})

await test('givebeast refuses a full roster (cap 4)', async () => {
  const full = ['ember_hatchling', 'ember_hatchling', 'ember_hatchling', 'ember_hatchling']
  const target = makePlayer(BUYER, 'Buyer', {
    summonedBeasts: full.map(id => ({ beastId: id, cp: 50, obtainedAt: Date.now() })),
  })
  const db = makeDb([makePlayer(OWNER, 'Owner'), target])
  const { ctx, replies } = makeCtx(db, OWNER, ['givebeast', 'ember_hatchling'], { mention: BUYER })
  await giveBeast(ctx)
  assert.equal(db.data.users[BUYER].summonedBeasts.length, BEAST_MAX_OWNED, 'cap enforced')
  assert.match(replies[0], /roster is full/)
})

await test('givebeast refuses duplicates', async () => {
  const target = makePlayer(BUYER, 'Buyer', {
    summonedBeasts: [{ beastId: 'ember_hatchling', cp: 50, obtainedAt: Date.now() }],
  })
  const db = makeDb([makePlayer(OWNER, 'Owner'), target])
  const { ctx, replies } = makeCtx(db, OWNER, ['givebeast', 'ember_hatchling'], { mention: BUYER })
  await giveBeast(ctx)
  assert.equal(db.data.users[BUYER].summonedBeasts.length, 1)
  assert.match(replies[0], /already owns/)
})

await test('givebeast is owner-only', async () => {
  const db = makeDb([makePlayer(OTHER, 'Sneak'), makePlayer(BUYER, 'Buyer')])
  const { ctx, replies } = makeCtx(db, OTHER, ['givebeast', 'ember_hatchling'], { mention: BUYER })
  const runner = (await import('../plugins/givebeast.js')).default
  await runner.run(ctx)
  assert.match(replies.at(-1), /restricted to the bot owner/)
  assert.equal(db.data.users[BUYER].summonedBeasts.length, 0, 'nothing granted')
})

// ══════════════════════════════════════════════════════════════════════════
// 6. .giveability
// ══════════════════════════════════════════════════════════════════════════

await test('giveability finds generic and premium abilities', () => {
  assert.equal(findAbilityDef('crown\'s favor')?.kind, 'generic')
  assert.equal(findAbilityDef('premium_favor')?.kind, 'generic')
  assert.equal(findAbilityDef('freeze_touch')?.kind, 'premium')
  assert.equal(findAbilityDef('Heat Blaze')?.kind, 'premium')
  assert.equal(findAbilityDef('definitely_not_an_ability'), null)
  assert.ok(listGrantableAbilities().includes('Crown\'s Favor'))
  assert.ok(listGrantableAbilities().includes('Freeze Touch'))
})

await test('giveability grants a generic ability + auto-equips', async () => {
  const target = makePlayer(BUYER, 'Buyer')
  const db = makeDb([makePlayer(OWNER, 'Owner'), target])
  const { ctx, replies } = makeCtx(db, OWNER, ['giveability', 'crown\'s favor'], { mention: BUYER })
  await giveAbility(ctx)
  const fresh = db.data.users[BUYER]
  assert.deepEqual(fresh.abilityInventory, ['premium_favor'])
  assert.deepEqual(fresh.equippedAbilities, ['premium_favor'])
  assert.match(replies[0], /Granted .*Crown's Favor/)
})

await test('giveability grants a FREE one-of-one and claims the registry', async () => {
  const target = makePlayer(BUYER, 'Buyer')
  const db = makeDb([makePlayer(OWNER, 'Owner'), target])
  const { ctx, replies } = makeCtx(db, OWNER, ['giveability', 'freeze_touch'], { mention: BUYER })
  await giveAbility(ctx)
  const fresh = db.data.users[BUYER]
  assert.equal(fresh.premiumAbility, 'freeze_touch')
  assert.equal(getExclusiveSpinWinner(db, abilityRegistryKey('freeze_touch')), BUYER, 'registry claimed')
  assert.match(replies[0], /one-of-one premium ability/)
})

await test('giveability refuses a one-of-one already held by another player', async () => {
  const holder = makePlayer(OTHER, 'Holder', { premiumAbility: 'freeze_touch' })
  const target = makePlayer(BUYER, 'Buyer')
  const db = makeDb([makePlayer(OWNER, 'Owner'), holder, target])
  // Pre-claim the registry the same way a real spin/claim would.
  const { claimExclusiveSpinForPlayer } = await import('../lib/season-engine.js')
  claimExclusiveSpinForPlayer(db, abilityRegistryKey('freeze_touch'), OTHER)

  const { ctx, replies } = makeCtx(db, OWNER, ['giveability', 'freeze_touch'], { mention: BUYER })
  await giveAbility(ctx)
  assert.equal(db.data.users[BUYER].premiumAbility, undefined, 'nothing granted')
  assert.equal(getExclusiveSpinWinner(db, abilityRegistryKey('freeze_touch')), OTHER, 'registry untouched')
  assert.match(replies[0], /already claimed/)
})

await test('giveability refuses when the target already holds a one-of-one', async () => {
  const target = makePlayer(BUYER, 'Buyer', { premiumAbility: 'heat_blaze' })
  const db = makeDb([makePlayer(OWNER, 'Owner'), target])
  const { ctx, replies } = makeCtx(db, OWNER, ['giveability', 'freeze_touch'], { mention: BUYER })
  await giveAbility(ctx)
  assert.equal(db.data.users[BUYER].premiumAbility, 'heat_blaze', 'no swapping one-of-ones')
  assert.match(replies[0], /only ever hold one/)
})

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.err.stack?.split('\n').slice(0, 3).join('\n')}`)
  process.exit(1)
}
