/**
 * ability-and-pack-lookup.test.mjs — regression tests for the player-reported
 * batch of 2026-09-25.
 *
 *  1. PACK LOOKUP — ".pack info the_dark_monarch" (and ".packinfo", which is
 *     now a real alias) answered `"the_dark_monarch" is not a season pack` for
 *     a pack sitting right there in the .pack list. The old findPack folded
 *     SPACES into underscores and compared that against the id and the name, so
 *     any query typed with underscores, or typed as the pack's title
 *     ("The Dark Monarch"), matched nothing. Every pack must now resolve by id,
 *     by name and by title, in any separator style.
 *
 *  2. .giveability ARGUMENTS — the plugin read args.slice(1), a shape copied
 *     from admin.js's sub-flow where args[0] really is the subcommand. The
 *     dispatcher hands plugins args WITHOUT the command word, so
 *     ".giveability jack_of_all_trades yochan" threw the ability away and
 *     answered `No ability matching "yochan"`, and a single-argument
 *     ".giveability crown's favor" printed the usage line instead of granting.
 *
 *  3. .giveability TARGETS — a target could only ever be an @mention or a
 *     reply. ".giveability heat_blaze Yochan" now resolves Yochan by name
 *     (lib/player-repo.js findPlayerByName), in either argument order, and says
 *     so plainly when no player matches instead of silently granting to the
 *     owner.
 *
 *  4. PREMIUM ABILITIES ARE VISIBLE — a monthly buyer is GIFTED a one-of-one
 *     (player.premiumAbility), which is not an equippedAbilities entry, so
 *     .useability read "None equipped" and there was no .ability command at all.
 *     .ability now lists slots + bag + the one-of-one, .useability lists the
 *     one-of-one and routes it to its own active command.
 *
 * Run:  node --test test/ability-and-pack-lookup.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { findPack } = await import('../plugins/pack.js')
const packPlugin = (await import('../plugins/pack.js')).default
const { parseGiveArgs, findAbilityDef, giveAbility } = await import('../plugins/giveability.js')
const abilityPlugin = (await import('../plugins/ability.js')).default
const { describePlayerAbilities } = await import('../plugins/ability.js')
const useabilityPlugin = (await import('../plugins/useability.js')).default
const { findHeldPremiumAbility } = await import('../plugins/useability.js')
const { findPlayerByName } = await import('../lib/player-repo.js')
const { seasonPacks } = await import('../lib/game-data.js')
const { abilityRegistryKey } = await import('../lib/premium-abilities.js')
const { getExclusiveSpinWinner } = await import('../lib/season-engine.js')

// ── Fixtures ───────────────────────────────────────────────────────────────
const OWNER  = '2347062301848@s.whatsapp.net' // config.js default owner number
const BUYER  = '234000000101@s.whatsapp.net'
const YOCHAN = '234000000199@s.whatsapp.net'

function makePlayer(jid, name, extra = {}) {
  return {
    id: jid,
    name,
    level: 10,
    xp: 0,
    stats: { str: 20, agi: 20, int: 20, def: 20, lck: 10 },
    wallet: { solars: 0, gems: 0 },
    inventory: [],
    ownedPacks: [],
    activePack: null,
    skills: [],
    activeEffects: [],
    abilityInventory: [],
    equippedAbilities: [],
    abilitySlots: 1,
    premiumAbility: null,
    premium: { active: false },
    registeredAt: Date.now(),
    ...extra,
  }
}

function makeDb(users) {
  return { data: { users: Object.fromEntries(users.map(u => [u.id, u])) } }
}

function makeMonster(extra = {}) {
  return {
    name: 'Test Wraith', emoji: '👾', hp: 999_999, maxHp: 999_999,
    atk: 10, def: 5, xp: 100, solars: 50, drops: [], tier: 'regular', ...extra,
  }
}

/** ctx with the shape handler.js builds: args WITHOUT the command word. */
function makeCtx(db, from, args, { mention = null, cmd = null, player = null } = {}) {
  const replies = []
  const sent = []
  const sender = player ?? db.data.users[from] ?? null
  const ctx = {
    db,
    from,
    args,
    cmd,
    isGroup: false,
    platform: 'whatsapp',
    player: sender,
    msg: mention
      ? { message: { extendedTextMessage: { contextInfo: { mentionedJid: [mention] } } } }
      : { message: {} },
    reply: async (text) => { replies.push(String(text)); return text },
    // sendImage() ends up here for a WhatsApp ctx; capturing the payload means
    // a pack detail page can be asserted on without any network.
    sock: { sendMessage: async (to, payload) => { sent.push(payload); return { key: {} } } },
    sender: from,
    replies,
    sent,
  }
  return ctx
}

/** Every caption/text a ctx produced, image sends included. */
const allText = (ctx) => [
  ...ctx.replies,
  ...ctx.sent.map(m => m?.caption ?? m?.text ?? ''),
].join('\n')

const premiumOn = () => ({ active: true, plan: 'monthly', expiresAt: Date.now() + 86400000 })

// ══════════════════════════════════════════════════════════════════════════
// 1. Pack lookup
// ══════════════════════════════════════════════════════════════════════════

test('the reported query: the_dark_monarch and The Dark Monarch both resolve', () => {
  assert.equal(findPack('the_dark_monarch')?.id, 'dark_monarch')
  assert.equal(findPack('The Dark Monarch')?.id, 'dark_monarch')
  assert.equal(findPack('THE-DARK-MONARCH')?.id, 'dark_monarch')
})

test('every season pack resolves by id, name and title, spaces or underscores', () => {
  const packs = seasonPacks.filter(p => p && p.id)
  assert.ok(packs.length >= 5, 'catalogue loaded')
  for (const pack of packs) {
    for (const query of [
      pack.id,
      pack.name,
      pack.title,
      pack.name.replace(/ /g, '_'),
      pack.title.replace(/ /g, '_'),
      pack.name.toUpperCase(),
    ]) {
      assert.equal(findPack(query)?.id, pack.id, `${query} -> ${pack.id}`)
    }
  }
})

test('a partial pack name still finds the closest pack', () => {
  assert.equal(findPack('dark')?.id, 'dark_monarch')
  assert.equal(findPack('totem')?.id, 'totem_pack')
  assert.equal(findPack('gemstone')?.id, 'gemstone')
})

test('a pack that does not exist still says so', async () => {
  assert.equal(findPack('no_such_pack'), null)
  assert.equal(findPack(''), null)
  assert.equal(findPack(null), null)

  const db = makeDb([makePlayer(BUYER, 'Buyer')])
  const ctx = makeCtx(db, BUYER, ['no_such_pack'], { cmd: 'packinfo' })
  await packPlugin.run(ctx)
  assert.match(ctx.replies[0], /is not a season pack/)
})

test('.packinfo is a registered alias and opens the pack detail page', async () => {
  assert.ok(packPlugin.aliases.includes('packinfo'), '.packinfo must be a real command')

  const db = makeDb([makePlayer(BUYER, 'Buyer')])
  const ctx = makeCtx(db, BUYER, ['the_dark_monarch'], { cmd: 'packinfo' })
  await packPlugin.run(ctx)
  const text = allText(ctx)
  assert.match(text, /Dark Monarch/, 'the detail page rendered')
  assert.match(text, /Signature/, 'with its signature block')
  assert.match(text, /pack buy dark_monarch|pack equip dark_monarch/, 'with the next step')
})

test('.pack info <name> answers the same page as .packinfo <name>', async () => {
  const db = makeDb([makePlayer(BUYER, 'Buyer')])
  const viaSub = makeCtx(db, BUYER, ['info', 'dark monarch'], { cmd: 'pack' })
  await packPlugin.run(viaSub)
  const viaAlias = makeCtx(db, BUYER, ['dark monarch'], { cmd: 'packinfo' })
  await packPlugin.run(viaAlias)
  assert.equal(allText(viaSub), allText(viaAlias))
})

// ══════════════════════════════════════════════════════════════════════════
// 2. .giveability argument parsing
// ══════════════════════════════════════════════════════════════════════════

test('giveability reads the dispatcher arg shape: ability first, target last', () => {
  const parsed = parseGiveArgs(['jack_of_all_trades', 'yochan'])
  assert.equal(parsed.found?.def?.id, 'jack_of_all_trades', 'the ability is arg 0, not arg 1')
  assert.equal(parsed.targetName, 'yochan')
})

test('giveability survives multi-word ability names and either argument order', () => {
  assert.equal(parseGiveArgs(['jack', 'of', 'all', 'trades', 'Yochan']).found?.def?.id, 'jack_of_all_trades')
  assert.equal(parseGiveArgs(['jack', 'of', 'all', 'trades', 'Yochan']).targetName, 'Yochan')
  assert.equal(parseGiveArgs(['yochan', 'heat_blaze']).found?.def?.id, 'heat_blaze', 'target-first order')
  assert.equal(parseGiveArgs(['yochan', 'heat_blaze']).targetName, 'yochan')
})

test('giveability keeps @mentions out of the name and defaults to yourself', () => {
  assert.equal(parseGiveArgs(['freeze_touch', '@123@s.whatsapp.net']).targetName, null)
  assert.equal(parseGiveArgs(["crown's favor"]).targetName, null)
  assert.equal(parseGiveArgs(["crown's favor"]).found?.def?.id, 'premium_favor')
})

test('giveability still tolerates the shifted admin.js arg shape', () => {
  // plugins/givecharacter.js hands admin.js [null, ...args]; the old tests were
  // written against that shape. Both must keep working.
  assert.equal(parseGiveArgs(['giveability', 'freeze_touch']).found?.def?.id, 'freeze_touch')
  assert.equal(parseGiveArgs(['giveability', 'heat_blaze', 'yochan']).targetName, 'yochan')
})

test('giveability with nothing to grant shows usage, not a bogus match', () => {
  assert.equal(parseGiveArgs([]).query, '')
  assert.equal(parseGiveArgs(['no_such_ability']).found, null)
  assert.equal(parseGiveArgs(['no_such_ability']).query, 'no_such_ability', 'the whole query is quoted back')
})

test('findAbilityDef matches ids, names and nicknames across both families', () => {
  assert.equal(findAbilityDef("crown's favor")?.kind, 'generic')
  assert.equal(findAbilityDef('premium_favor')?.kind, 'generic')
  assert.equal(findAbilityDef('freeze_touch')?.kind, 'premium')
  assert.equal(findAbilityDef('Heat Blaze')?.kind, 'premium')
  assert.equal(findAbilityDef('freeze touch')?.def?.id, 'freeze_touch')
  assert.equal(findAbilityDef('jack')?.def?.id, 'jack_of_all_trades', 'nickname works')
  assert.equal(findAbilityDef('definitely_not_an_ability'), null)
})

// ══════════════════════════════════════════════════════════════════════════
// 3. .giveability targets
// ══════════════════════════════════════════════════════════════════════════

test('the reported command: .giveability jack_of_all_trades yochan grants to Yochan', async () => {
  const db = makeDb([makePlayer(OWNER, 'Owner'), makePlayer(YOCHAN, 'Yochan')])
  const ctx = makeCtx(db, OWNER, ['jack_of_all_trades', 'yochan'])
  await giveAbility(ctx)

  assert.equal(db.data.users[YOCHAN].premiumAbility, 'jack_of_all_trades', 'granted to the named player')
  assert.equal(getExclusiveSpinWinner(db, abilityRegistryKey('jack_of_all_trades')), YOCHAN, 'registry claimed')
  assert.equal(db.data.users[OWNER].premiumAbility, null, 'not granted to the owner by accident')
  assert.match(ctx.replies[0], /Jack of All Trades/)
  assert.match(ctx.replies[0], /Yochan/)
})

test('a single-argument .giveability crown\'s favor grants instead of printing usage', async () => {
  const db = makeDb([makePlayer(OWNER, 'Owner')])
  const ctx = makeCtx(db, OWNER, ["crown's favor"])
  await giveAbility(ctx)

  assert.deepEqual(db.data.users[OWNER].abilityInventory, ['premium_favor'])
  assert.deepEqual(db.data.users[OWNER].equippedAbilities, ['premium_favor'])
  assert.match(ctx.replies[0], /Granted .*Crown's Favor/)
})

test('an @mention target still wins', async () => {
  const db = makeDb([makePlayer(OWNER, 'Owner'), makePlayer(YOCHAN, 'Yochan')])
  const ctx = makeCtx(db, OWNER, ['heat_blaze'], { mention: YOCHAN })
  await giveAbility(ctx)
  assert.equal(db.data.users[YOCHAN].premiumAbility, 'heat_blaze')
})

test('a target name nobody matches is refused, and nothing is granted', async () => {
  const db = makeDb([makePlayer(OWNER, 'Owner'), makePlayer(YOCHAN, 'Yochan')])
  const ctx = makeCtx(db, OWNER, ['heat_blaze', 'somebody_else'])
  await giveAbility(ctx)
  assert.match(ctx.replies[0], /No player found matching \*"somebody_else"\*/)
  assert.equal(db.data.users[OWNER].premiumAbility, null, 'no silent grant to the owner')
  assert.equal(db.data.users[YOCHAN].premiumAbility, null)
})

test('findPlayerByName is separator-insensitive and prefers the closest name', () => {
  const users = [
    { id: 'a@s.whatsapp.net', name: 'Yochan' },
    { id: 'b@s.whatsapp.net', name: 'Yochan The Great' },
    { id: 'c@s.whatsapp.net', name: 'Darkblade' },
  ]
  assert.equal(findPlayerByName(users, 'yochan')?.id, 'a@s.whatsapp.net', 'exact beats partial')
  assert.equal(findPlayerByName(users, 'YOCHAN')?.id, 'a@s.whatsapp.net')
  assert.equal(findPlayerByName(users, 'yochan_the_great')?.id, 'b@s.whatsapp.net', 'underscores fold')
  assert.equal(findPlayerByName(users, 'dark')?.id, 'c@s.whatsapp.net')
  assert.equal(findPlayerByName(users, 'nobody'), null)
  assert.equal(findPlayerByName(users, ''), null)
  assert.equal(findPlayerByName({ 'a@s.whatsapp.net': users[0] }, 'yochan')?.id, 'a@s.whatsapp.net', 'map form')
})

// ══════════════════════════════════════════════════════════════════════════
// 4. Premium abilities are visible: .ability and .useability
// ══════════════════════════════════════════════════════════════════════════

test('.ability lists a gifted one-of-one and how to fire it', async () => {
  const buyer = makePlayer(BUYER, 'Buyer', { premiumAbility: 'freeze_touch', premium: premiumOn() })
  const db = makeDb([buyer])
  const ctx = makeCtx(db, BUYER, [], { player: buyer })
  await abilityPlugin.run(ctx)

  assert.match(ctx.replies[0], /Freeze Touch/, 'the one-of-one is listed')
  assert.match(ctx.replies[0], /\.freezeup/, 'with the command that fires it')
  assert.match(describePlayerAbilities(buyer), /One-of-one premium/)
})

test('.ability lists Crown\'s Favor in the slot list', () => {
  const buyer = makePlayer(BUYER, 'Buyer', {
    abilityInventory: ['premium_favor'],
    equippedAbilities: ['premium_favor'],
  })
  const out = describePlayerAbilities(buyer)
  assert.match(out, /Equipped \(1\/1 slots\)/)
  assert.match(out, /Crown's Favor/)
})

test('.ability with nothing held points at Premium instead of showing a blank page', () => {
  const out = describePlayerAbilities(makePlayer(BUYER, 'Buyer'))
  assert.match(out, /No abilities yet/)
  assert.match(out, /\.premium/)
})

test('.ability equip and unequip move an owned ability through a slot', async () => {
  const player = makePlayer(BUYER, 'Buyer', { abilityInventory: ['premium_favor'] })
  const db = makeDb([player])

  const eq = makeCtx(db, BUYER, ['equip', 'crown'], { player })
  await abilityPlugin.run(eq)
  assert.deepEqual(db.data.users[BUYER].equippedAbilities, ['premium_favor'])
  assert.match(eq.replies[0], /equipped/i)

  const again = makeCtx(db, BUYER, ['equip', 'crown'], { player: db.data.users[BUYER] })
  await abilityPlugin.run(again)
  assert.match(again.replies[0], /already equipped/i)

  const un = makeCtx(db, BUYER, ['unequip', 'crown'], { player: db.data.users[BUYER] })
  await abilityPlugin.run(un)
  assert.deepEqual(db.data.users[BUYER].equippedAbilities, [])
  assert.deepEqual(db.data.users[BUYER].abilityInventory, ['premium_favor'], 'stays owned')
})

test('.ability equip refuses when every slot is full', async () => {
  // The slot is held by an id that no longer resolves in data/abilities.json —
  // a real shape for an ability retired from the catalogue, and the one case
  // where the "slots are full" reply has no name to print.
  const player = makePlayer(BUYER, 'Buyer', {
    abilityInventory: ['premium_favor'],
    equippedAbilities: ['retired_ability'],
    abilitySlots: 1,
  })
  const db = makeDb([player])
  const ctx = makeCtx(db, BUYER, ['equip', 'crown'], { player })
  await abilityPlugin.run(ctx)
  assert.match(ctx.replies[0], /slot\(s\) are full/)
  assert.deepEqual(db.data.users[BUYER].equippedAbilities, ['retired_ability'], 'nothing forced in')
})

test('.ability <name> shows detail for both families', async () => {
  const buyer = makePlayer(BUYER, 'Buyer', {
    premiumAbility: 'freeze_touch',
    premium: premiumOn(),
    abilityInventory: ['premium_favor'],
    equippedAbilities: ['premium_favor'],
  })
  const db = makeDb([buyer])

  const oneOfOne = makeCtx(db, BUYER, ['freeze_touch'], { player: buyer })
  await abilityPlugin.run(oneOfOne)
  assert.match(oneOfOne.replies[0], /Freeze Touch/)
  assert.match(oneOfOne.replies[0], /Passive/)
  assert.match(oneOfOne.replies[0], /it's yours/i)

  const generic = makeCtx(db, BUYER, ["crown's favor"], { player: buyer })
  await abilityPlugin.run(generic)
  assert.match(generic.replies[0], /Crown's Favor/)
  assert.match(generic.replies[0], /Equipped/)

  const missing = makeCtx(db, BUYER, ['not_an_ability'], { player: buyer })
  await abilityPlugin.run(missing)
  assert.match(missing.replies[0], /No ability matching/)
})

test('.useability lists the one-of-one instead of "None equipped"', async () => {
  const buyer = makePlayer(BUYER, 'Buyer', { premiumAbility: 'freeze_touch', premium: premiumOn() })
  const db = makeDb([buyer])
  const ctx = makeCtx(db, BUYER, [], { player: buyer })
  await useabilityPlugin.run(ctx)
  assert.match(ctx.replies[0], /Freeze Touch/)
  assert.match(ctx.replies[0], /\.freezeup/)
  assert.doesNotMatch(ctx.replies[0], /None equipped\./)
})

test('.useability freeze touch fires the one-of-one active in a fight', async () => {
  const buyer = makePlayer(BUYER, 'Buyer', { premiumAbility: 'freeze_touch', premium: premiumOn() })
  buyer.inBattle = true
  buyer.battleState = {
    type: 'dungeon', enemy: makeMonster(), turn: 1,
    playerDefending: false, abilityCooldowns: {}, startedAt: Date.now(), lastMoveAt: Date.now(),
  }
  const db = makeDb([buyer])
  const ctx = makeCtx(db, BUYER, ['freeze', 'touch'], { player: buyer })
  await useabilityPlugin.run(ctx)

  assert.equal(db.data.users[BUYER].battleState.premiumAbilityUsed, true, 'the active actually ran')
  assert.doesNotMatch(ctx.replies.join('\n'), /not found or not equipped/)
})

test('findHeldPremiumAbility only matches the ability the player actually holds', () => {
  const holder = makePlayer(BUYER, 'Buyer', { premiumAbility: 'freeze_touch' })
  const other  = makePlayer(YOCHAN, 'Yochan', { premiumAbility: 'heat_blaze' })
  assert.equal(findHeldPremiumAbility(holder, 'freeze touch')?.id, 'freeze_touch')
  assert.equal(findHeldPremiumAbility(holder, 'freezeup')?.id, 'freeze_touch', 'active alias')
  assert.equal(findHeldPremiumAbility(holder, 'fu')?.id, 'freeze_touch')
  assert.equal(findHeldPremiumAbility(holder, 'heat_blaze'), null, "someone else's ability")
  assert.equal(findHeldPremiumAbility(holder, 'fury'), null, 'a short alias must be typed exactly')
  assert.equal(findHeldPremiumAbility(makePlayer(OWNER, 'Owner'), 'freeze touch'), null)
})
