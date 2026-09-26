/**
 * scripts/lottery-salvage-check.mjs — behavioural check for the lottery and
 * salvage additions, plus the .me / .profile image split.
 *
 *   node scripts/lottery-salvage-check.mjs
 *
 * Same shape as scripts/housing-check.mjs: stub sock, in-memory db pointed at
 * db.data.users, no WhatsApp connection and no writes to the real db.json.
 *
 * The invariants that actually matter here:
 *   - the lottery is a SINK: solars paid in always exceed the pot, and the pot
 *     can never pay out more than was paid in. Nothing mints.
 *   - a pot is never paid twice, even when two players race the same draw.
 *   - salvage never destroys an item that has a use or is equipped.
 *   - .profile never renders the composited card; .me still does.
 *   - no plugin here calls sock.sendMessage (no broadcasts, no DM fan-out).
 */
import assert from 'assert'
import fs from 'fs'
import lottery, { pickWinner } from '../plugins/lottery.js'
import salvage from '../plugins/salvage.js'
import inventory from '../plugins/inventory.js'
import { CURIO_USES, isInertCurio, salvageValue, JUNK_VALUE, SALVAGE_FLOOR } from '../lib/curios.js'
import { allItems } from '../lib/game-data.js'

const A = '111000111000@s.whatsapp.net'
const B = '222000222000@s.whatsapp.net'
const C = '333000333000@s.whatsapp.net'

let pass = 0, fail = 0
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass++ }
  catch (err) { console.log(`  ✗ ${label}\n      ${err.message}`); fail++ }
}
async function acheck(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++ }
  catch (err) { console.log(`  ✗ ${label}\n      ${err.message}`); fail++ }
}

// ── Fakes ────────────────────────────────────────────────────────────────
let sockSends = 0
const sock = { sendMessage: async () => { sockSends++; return {} } }
const db = { data: { users: {}, notifications: {} }, read: async () => {}, write: async () => {} }

function makePlayer(id, name, solars, extra = {}) {
  const p = {
    id, name, level: 50, location: 'astral_town',
    hp: 100, maxHp: 100, mp: 50, maxMp: 50,
    wallet: { solars }, inventory: [], equipped: {}, ...extra,
  }
  db.data.users[id] = p
  return p
}

function run(plugin, from, argsLine, cmd = plugin.name) {
  const replies = []
  const ctx = {
    sock, db, from, sender: from, isGroup: false, cmd,
    msg: { message: {} },
    player: db.data.users[from],
    args: String(argsLine ?? '').split(' ').filter(Boolean),
    reply: async t => { replies.push(String(t)); return {} },
    replyImage: async (_i, caption) => { replies.push(String(caption)); return {} },
  }
  return plugin.run(ctx).then(() => replies.join('\n'))
}

const solarsOf = id => db.data.users[id].wallet.solars

console.log('\nLottery + salvage\n')

// ── 1. Curio registry ────────────────────────────────────────────────────
console.log('Curio registry')

check('every id in CURIO_USES is a real misc item', () => {
  const map = Object.fromEntries(allItems.map(i => [i.id, i]))
  for (const id of Object.keys(CURIO_USES)) {
    assert.ok(map[id], `${id} is not in the item data`)
    assert.strictEqual(map[id].type, 'misc', `${id} is type ${map[id].type}, not misc`)
  }
})

check('a curio with a use is never salvageable', () => {
  const map = Object.fromEntries(allItems.map(i => [i.id, i]))
  for (const id of Object.keys(CURIO_USES)) {
    assert.strictEqual(isInertCurio(map[id]), false, `${id} would be scrapped despite having a use`)
  }
})

check('non-misc items are never salvageable', () => {
  for (const item of allItems) {
    if (item.type !== 'misc') assert.strictEqual(isInertCurio(item), false, `${item.id} (${item.type}) is scrappable`)
  }
})

check('salvage value never drops below the floor', () => {
  for (const item of allItems) {
    if (isInertCurio(item)) assert.ok(salvageValue(item) >= SALVAGE_FLOOR, `${item.id} pays under the floor`)
  }
})

// ── 2. Salvage behaviour ─────────────────────────────────────────────────
console.log('\nSalvage')

await acheck('a clean inventory has nothing to salvage', async () => {
  makePlayer(A, 'Aria', 10_000, { inventory: ['ender_pearl', 'health_potion'] })
  const out = await run(salvage, A, '')
  assert.match(out, /Nothing to salvage/i)
})

await acheck('a live curio is never destroyed by .salvage all', async () => {
  makePlayer(A, 'Aria', 0, { inventory: ['ender_pearl', 'cracked_ender_shard'] })
  await run(salvage, A, 'all')
  assert.deepStrictEqual(db.data.users[A].inventory, ['ender_pearl', 'cracked_ender_shard'])
  assert.strictEqual(solarsOf(A), 0, 'paid out for items it did not remove')
})

await acheck('an inert curio scraps for at least the floor', async () => {
  makePlayer(A, 'Aria', 0, { inventory: ['bar_tab_receipt', 'ender_pearl'] })
  const out = await run(salvage, A, 'all')
  assert.ok(solarsOf(A) >= SALVAGE_FLOOR, `paid ${solarsOf(A)}`)
  assert.deepStrictEqual(db.data.users[A].inventory, ['ender_pearl'], 'took the pearl too')
  assert.match(out, /SALVAGED/)
})

await acheck('a leftover id scraps at the junk rate and frees the slot', async () => {
  makePlayer(A, 'Aria', 0, { inventory: ['ghost_of_a_retired_item', 'ghost_of_a_retired_item'] })
  await run(salvage, A, 'all')
  assert.strictEqual(solarsOf(A), JUNK_VALUE * 2)
  assert.strictEqual(db.data.users[A].inventory.length, 0)
})

await acheck('an equipped item is never salvaged', async () => {
  // Even if a misc item somehow ends up equipped, it must survive.
  makePlayer(A, 'Aria', 0, {
    inventory: ['bar_tab_receipt', 'ghost_item'],
    equipped: { relic: 'bar_tab_receipt' },
  })
  await run(salvage, A, 'all')
  assert.ok(db.data.users[A].inventory.includes('bar_tab_receipt'), 'scrapped an equipped item')
  assert.strictEqual(solarsOf(A), JUNK_VALUE)
})

await acheck('.salvage <item> scraps only the named entry', async () => {
  makePlayer(A, 'Aria', 0, { inventory: ['bar_tab_receipt', 'ghost_item'] })
  await run(salvage, A, 'ghost item')
  assert.deepStrictEqual(db.data.users[A].inventory, ['bar_tab_receipt'])
  assert.strictEqual(solarsOf(A), JUNK_VALUE)
})

await acheck('an unmatched query destroys nothing', async () => {
  makePlayer(A, 'Aria', 0, { inventory: ['bar_tab_receipt'] })
  const out = await run(salvage, A, 'excalibur')
  assert.deepStrictEqual(db.data.users[A].inventory, ['bar_tab_receipt'])
  assert.strictEqual(solarsOf(A), 0)
  assert.match(out, /Nothing salvageable matches/i)
})

await acheck('inventory lists curios with their use, not as unknowns', async () => {
  makePlayer(A, 'Aria', 0, { inventory: ['ender_pearl', 'bar_tab_receipt', 'ghost_item'] })
  const out = await run(inventory, A, '')
  assert.match(out, /Curios/, 'misc items still fall through to Other')
  assert.match(out, /Ender Pearl.*setpearl/, 'pearl does not show its command')
  assert.match(out, /Bar Tab Receipt.*salvage/, 'inert curio does not point at salvage')
  assert.match(out, /Ghost Item.*salvage/, 'leftover id does not point at salvage')
})

// ── 3. Lottery ───────────────────────────────────────────────────────────
console.log('\nLottery')

function resetLottery() { delete db.data.lottery }

check('weighted pick favours the bigger holder', () => {
  const tickets = { [A]: { name: 'Aria', count: 1 }, [B]: { name: 'Bo', count: 99 } }
  let bo = 0
  for (let i = 0; i < 1000; i++) {
    // Deterministic sweep across the whole [0,1) range.
    if (pickWinner(tickets, () => i / 1000).jid === B) bo++
  }
  assert.ok(bo > 950, `Bo won ${bo}/1000, expected ~990`)
})

check('an empty ticket map has no winner', () => {
  assert.strictEqual(pickWinner({}, () => 0.5), null)
})

await acheck('a first look opens a round with an empty pot', async () => {
  resetLottery()
  makePlayer(A, 'Aria', 10_000)
  const out = await run(lottery, A, '')
  assert.match(out, /DAILY LOTTERY/)
  assert.strictEqual(db.data.lottery.potSolars, 0)
  assert.ok(db.data.lottery.drawAt > Date.now(), 'draw deadline is not in the future')
})

await acheck('buying charges the wallet and the pot takes less than was paid', async () => {
  resetLottery()
  makePlayer(A, 'Aria', 10_000)
  await run(lottery, A, 'buy 2')
  const spent = 10_000 - solarsOf(A)
  assert.ok(spent > 0, 'nothing was charged')
  assert.ok(db.data.lottery.potSolars < spent, 'the pot is not a sink, it took the full price')
  assert.strictEqual(db.data.lottery.tickets[A].count, 2)
})

await acheck('a player cannot buy past the per-round cap', async () => {
  resetLottery()
  makePlayer(A, 'Aria', 1_000_000)
  await run(lottery, A, 'buy 500')
  const held = db.data.lottery.tickets[A].count
  assert.ok(held <= 20, `holds ${held}`)
  const out = await run(lottery, A, 'buy 1')
  assert.match(out, /maximum/i)
  assert.strictEqual(db.data.lottery.tickets[A].count, held, 'cap was breached on a second buy')
})

await acheck('a player who cannot pay buys nothing', async () => {
  resetLottery()
  makePlayer(A, 'Aria', 10)
  const out = await run(lottery, A, 'buy 1')
  assert.match(out, /You have/i)
  assert.strictEqual(solarsOf(A), 10, 'charged a player who could not pay')
  assert.strictEqual(db.data.lottery.tickets[A], undefined)
})

await acheck('a low level player is refused', async () => {
  resetLottery()
  makePlayer(A, 'Aria', 10_000, { level: 2 })
  const out = await run(lottery, A, 'buy 1')
  assert.match(out, /level/i)
  assert.strictEqual(solarsOf(A), 10_000)
})

await acheck('a lone entrant rolls the round over and keeps their ticket', async () => {
  resetLottery()
  makePlayer(A, 'Aria', 10_000, { level: 50 })
  await run(lottery, A, 'buy 1')
  const pot = db.data.lottery.potSolars
  const held = db.data.lottery.tickets[A].count
  db.data.lottery.drawAt = Date.now() - 1000  // force the deadline past
  const out = await run(lottery, A, '')
  assert.match(out, /rolled over/i)
  assert.strictEqual(db.data.lottery.potSolars, pot, 'the pot was lost on a rollover')
  assert.strictEqual(db.data.lottery.tickets[A].count, held, 'the ticket was voided')
  assert.ok(db.data.lottery.drawAt > Date.now(), 'the deadline was not extended')
})

await acheck('the draw pays exactly the pot to one entrant, and opens a new round', async () => {
  resetLottery()
  makePlayer(A, 'Aria', 10_000)
  makePlayer(B, 'Bo', 10_000)
  makePlayer(C, 'Cyn', 10_000)
  await run(lottery, A, 'buy 3')
  await run(lottery, B, 'buy 2')
  const pot = db.data.lottery.potSolars
  const before = solarsOf(A) + solarsOf(B) + solarsOf(C)

  db.data.lottery.drawAt = Date.now() - 1000
  const out = await run(lottery, C, '')

  const after = solarsOf(A) + solarsOf(B) + solarsOf(C)
  assert.match(out, /drawn/i)
  assert.strictEqual(after - before, pot, `paid ${after - before}, pot was ${pot}`)
  assert.strictEqual(db.data.lottery.potSolars, 0, 'the new round did not start empty')
  assert.deepStrictEqual(db.data.lottery.tickets, {}, 'tickets carried into the new round')
  assert.strictEqual(db.data.lottery.roundId, 2)
  assert.ok(db.data.lottery.lastResult.prize === pot)
})

await acheck('a pot is never paid twice when two players race the draw', async () => {
  resetLottery()
  makePlayer(A, 'Aria', 10_000)
  makePlayer(B, 'Bo', 10_000)
  await run(lottery, A, 'buy 2')
  await run(lottery, B, 'buy 2')
  const pot = db.data.lottery.potSolars
  const before = solarsOf(A) + solarsOf(B)

  db.data.lottery.drawAt = Date.now() - 1000
  // Both players hit the closed round at the same instant.
  await Promise.all([run(lottery, A, ''), run(lottery, B, '')])

  const after = solarsOf(A) + solarsOf(B)
  assert.strictEqual(after - before, pot, `paid ${after - before} for a pot of ${pot}`)
  assert.strictEqual(db.data.lottery.roundId, 2, 'the round advanced more than once')
})

await acheck('the lottery is a net sink across a full round', async () => {
  resetLottery()
  makePlayer(A, 'Aria', 50_000)
  makePlayer(B, 'Bo', 50_000)
  const before = solarsOf(A) + solarsOf(B)
  await run(lottery, A, 'buy 5')
  await run(lottery, B, 'buy 5')
  db.data.lottery.drawAt = Date.now() - 1000
  await run(lottery, A, '')
  const after = solarsOf(A) + solarsOf(B)
  assert.ok(after < before, `players ended with ${after}, started with ${before}: the lottery minted solars`)
})

await acheck('.lottery last reports the previous winner', async () => {
  const out = await run(lottery, A, 'last')
  assert.match(out, /LOTTERY, ROUND/i)
})

// ── 4. Profile / me image split ──────────────────────────────────────────
console.log('\nProfile image split')

const profileSrc = fs.readFileSync(new URL('../plugins/profile.js', import.meta.url), 'utf8')
const meSrc = fs.readFileSync(new URL('../plugins/me.js', import.meta.url), 'utf8')

check('.profile never renders the composited card', () => {
  // Matches an actual call or import, not the word appearing in a comment
  // explaining why the card is .me-only.
  assert.ok(!/renderProfileCard\s*\(/.test(profileSrc), 'profile.js still calls renderProfileCard')
  assert.ok(!/^\s*import[^\n]*profile-card-render/m.test(profileSrc), 'profile.js still imports the card renderer')
})

check('.me still renders the composited card', () => {
  assert.ok(/renderProfileCard\s*\(/.test(meSrc), 'me.js lost the card render')
})

check('.me shows the player title', () => {
  assert.ok(/Title:/.test(meSrc), 'me.js does not show a title line')
  assert.ok(/p\.title/.test(meSrc), 'me.js does not read p.title')
})

// ── 5. No broadcasts ─────────────────────────────────────────────────────
console.log('\nBroadcast safety')
check('nothing sent a message outside ctx.reply', () => {
  assert.strictEqual(sockSends, 0, `${sockSends} direct sock.sendMessage calls`)
})

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
