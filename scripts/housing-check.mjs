/**
 * scripts/housing-check.mjs — behavioural check for the housing pillar.
 *
 * Drives plugins/home.js, homebuild.js, homedecor.js, farm.js, fish.js,
 * homeinvite.js and neighborhood.js through a fake ctx (stub sock +
 * in-memory db) and asserts the rules the pillar is actually for: you can't
 * farm without a home, tiers gate rooms and crops, growth is wall-clock, a
 * greenhouse built after planting does NOT speed up what's already in the
 * ground, and the neighborhood ranks by comfort. Run it directly:
 *
 *   node scripts/housing-check.mjs
 *
 * No WhatsApp connection and no writes to the real db.json — updatePlayer is
 * pointed at a throwaway lowdb-shaped object, same as auction-check.mjs.
 */
import assert from 'assert'
import home from '../plugins/home.js'
import homebuild from '../plugins/homebuild.js'
import homedecor from '../plugins/homedecor.js'
import farm from '../plugins/farm.js'
import fish from '../plugins/fish.js'
import homeinvite from '../plugins/homeinvite.js'
import neighborhood from '../plugins/neighborhood.js'
import {
  ensureHome, hasHome, tierOf, growthMsFor, splitPlots, plotCap,
  comfortOf, storageCap, rollFish, rollYield, castSlots,
  formatRemaining, cooldownLeft, TIER_ORDER, CROPS, FISH,
} from '../lib/housing-engine.js'
import { renderNeighborhood } from '../lib/neighborhood-render.mjs'
import {
  getInventoryCap, inventoryOverflow, checkOverflowGrace, planOverflowShed,
  applyOverflowShed, overflowWarnMessage, overflowShedMessage, OVERFLOW_GRACE_MS,
  resolveOverflowNotice,
} from '../lib/inventory-limits.js'
import { allItems } from '../lib/game-data.js'

const A = '111000111000@s.whatsapp.net'
const B = '222000222000@s.whatsapp.net'
const GROUP = '120363000000000000@g.us'

let pass = 0, fail = 0
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass++ }
  catch (err) { console.log(`  ✗ ${label}\n      ${err.message}`); fail++ }
}

// ── Fakes ────────────────────────────────────────────────────────────────
const sent = []
const sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); return {} } }

// player-repo keys off db.data.users — not .players.
const db = { data: { users: {} }, write: async () => {} }

function makePlayer(id, name, solars, extra = {}) {
  const p = {
    id, name, level: 50, location: 'astral_town',
    hp: 50, maxHp: 100, mp: 10, maxMp: 50,
    wallet: { solars }, inventory: [], ...extra,
  }
  db.data.users[id] = p
  return p
}

/** Runs a plugin as `from`, returning everything it replied, joined. */
function run(plugin, from, argsLine, cmd = plugin.name, msg = undefined) {
  const replies = []
  const player = db.data.users[from]
  const ctx = {
    sock, db, from, sender: from, isGroup: false, cmd,
    msg: msg ?? { message: {} },
    player,
    args: String(argsLine ?? '').split(' ').filter(Boolean),
    reply: async t => { replies.push(String(t)); return {} },
    replyImage: async (_buf, caption) => { replies.push(String(caption)); return {} },
  }
  return plugin.run(ctx).then(() => replies.join('\n'))
}

/** A ctx whose quoted-message contextInfo mentions `target`. */
const mentioning = target => ({
  message: { extendedTextMessage: { contextInfo: { mentionedJid: [target] } } },
})

console.log('\nHousing pillar\n')

// ── 1. Engine invariants ─────────────────────────────────────────────────
console.log('Engine')

check('tier ladder is contiguous from rank 0', () => {
  TIER_ORDER.forEach((t, i) => assert.strictEqual(t.rank, i, `${t.id} rank ${t.rank} at index ${i}`))
})

check('every crop and fish is reachable from some tier', () => {
  const maxRank = TIER_ORDER[TIER_ORDER.length - 1].rank
  for (const c of CROPS) assert.ok(c.minRank <= maxRank, `${c.id} needs rank ${c.minRank}`)
  assert.ok(FISH.every(f => f.weight > 0), 'a fish has zero weight and can never roll')
})

check('crops are profitable at minimum yield', () => {
  for (const c of CROPS) {
    assert.ok(c.sell * c.yieldMin > c.seedCost, `${c.id} loses money on a min roll`)
  }
})

check('ensureHome backfills without granting a house', () => {
  const legacy = { id: 'x', name: 'Legacy' }
  ensureHome(legacy)
  assert.strictEqual(legacy.home.tier, null)
  assert.strictEqual(hasHome(legacy), false)
  assert.deepStrictEqual(legacy.home.plots, [])
  assert.strictEqual(storageCap(legacy), 0)
  assert.strictEqual(plotCap(legacy), 0)
})

check('growth speedup is floored so stacking cannot reach zero', () => {
  const crop = { minutes: 100 }
  const stacked = { home: { rooms: ['greenhouse', 'greenhouse', 'greenhouse', 'greenhouse',
    'greenhouse', 'greenhouse', 'greenhouse', 'greenhouse'] }, }
  const ms = growthMsFor(stacked, crop)
  assert.ok(ms >= 100 * 60 * 1000 * 0.25, `floor breached: ${ms}`)
})

check('formatRemaining reads naturally at every scale', () => {
  assert.strictEqual(formatRemaining(0), 'ready')
  assert.strictEqual(formatRemaining(-5), 'ready')
  assert.strictEqual(formatRemaining(45 * 60000), '45m')
  assert.strictEqual(formatRemaining(134 * 60000), '2h 14m')
  assert.strictEqual(formatRemaining(120 * 60000), '2h')
})

check('cooldownLeft treats a never-used timer as ready', () => {
  assert.strictEqual(cooldownLeft(null, 1000), 0)
  assert.strictEqual(cooldownLeft(undefined, 1000), 0)
  const now = 10_000
  assert.strictEqual(cooldownLeft(now - 400, 1000, now), 600)
  assert.strictEqual(cooldownLeft(now - 5000, 1000, now), 0)
})

check('rollYield stays inside its bounds', () => {
  const crop = { yieldMin: 2, yieldMax: 4 }
  assert.strictEqual(rollYield(crop, () => 0), 2)
  assert.strictEqual(rollYield(crop, () => 0.999), 4)
})

check('rollFish covers first and last of the weight table', () => {
  assert.strictEqual(rollFish(() => 0.0001).id, FISH[0].id)
  assert.strictEqual(rollFish(() => 0.9999).id, FISH[FISH.length - 1].id)
})

check('castSlots clamps difficulty to a playable range', () => {
  assert.strictEqual(castSlots(0), 2)
  assert.strictEqual(castSlots(1), 2)
  assert.strictEqual(castSlots(8), 8)
  assert.strictEqual(castSlots(99), 8)
  assert.strictEqual(castSlots(undefined), 2)
})

// ── 2. No home means no pillar ───────────────────────────────────────────
console.log('\nBefore claiming')

makePlayer(A, 'Alpha', 5_000_000)

let out = await run(farm, A, '')
check('.farm refuses without a home', () => assert.match(out, /need a home/i))
out = await run(homebuild, A, 'bedroom')
check('.homebuild refuses without a home', () => assert.match(out, /need a home/i))
out = await run(homedecor, A, 'rug')
check('.homedecor refuses without a home', () => assert.match(out, /need a home/i))
out = await run(home, A, '')
check('.home offers the free tent', () => assert.match(out, /home claim/i))

// ── 3. Claim, and claim twice ────────────────────────────────────────────
console.log('\nClaiming and upgrading')

out = await run(home, A, 'claim')
check('.home claim pitches a tent for free', () => {
  assert.match(out, /pitched/i)
  assert.strictEqual(db.data.users[A].home.tier, 'tent')
  assert.strictEqual(db.data.users[A].wallet.solars, 5_000_000, 'the tent charged something')
})

out = await run(home, A, 'claim')
check('.home claim is idempotent', () => assert.match(out, /already have a home/i))

out = await run(homebuild, A, 'greenhouse')
check('a rank-2 room is refused at tent', () => {
  assert.match(out, /bigger house/i)
  assert.deepStrictEqual(db.data.users[A].home.rooms, [])
})

out = await run(farm, A, 'plant moonberry')
check('a rank-2 crop is refused at tent', () => assert.match(out, /bigger home/i))

out = await run(home, A, 'upgrade')
check('.home upgrade buys the cottage and charges for it', () => {
  assert.match(out, /Stone Cottage/i)
  assert.strictEqual(db.data.users[A].home.tier, 'cottage')
  assert.strictEqual(db.data.users[A].wallet.solars, 5_000_000 - 75_000)
})

await run(home, A, 'upgrade')          // manor
check('two upgrades reach the manor and its plots', () => {
  assert.strictEqual(db.data.users[A].home.tier, 'manor')
  assert.strictEqual(plotCap(db.data.users[A]), 6)
})

// ── 4. Rooms, slots and stacking perks ───────────────────────────────────
console.log('\nRooms')

out = await run(homebuild, A, 'bedroom')
check('.homebuild builds and reports the perk', () => {
  assert.match(out, /Bedroom built/i)
  assert.ok(db.data.users[A].home.rooms.includes('bedroom'))
})

out = await run(homebuild, A, 'bedroom')
check('the same room cannot be built twice', () => {
  assert.match(out, /already have/i)
  assert.strictEqual(db.data.users[A].home.rooms.filter(r => r === 'bedroom').length, 1)
})

out = await run(homebuild, A, 'cellar')
check('a cellar raises storage capacity above the tier base', () => {
  const p = db.data.users[A]
  assert.ok(out.match(/Cellar built/i))
  assert.strictEqual(storageCap(p), tierOf(p).storage + 30)
})

out = await run(homebuild, A, 'nonsense room')
check('an unknown room name is rejected, not guessed at', () => assert.match(out, /No room called/i))

// ── 5. Real-time growth ──────────────────────────────────────────────────
console.log('\nFarming')

out = await run(farm, A, 'plant wheat 3')
check('.farm plant sows the requested count and charges per seed', () => {
  const p = db.data.users[A]
  assert.match(out, /Planted 3x Wheat/i)
  assert.strictEqual(p.home.plots.length, 3)
  assert.ok(p.home.plots.every(pl => pl.readyAt > Date.now()), 'a plot was ready instantly')
})

const beforeGreenhouse = db.data.users[A].home.plots.map(pl => pl.readyAt)
await run(homebuild, A, 'greenhouse')
check('a greenhouse built AFTER planting does not speed up standing crops', () => {
  const after = db.data.users[A].home.plots.map(pl => pl.readyAt)
  assert.deepStrictEqual(after, beforeGreenhouse)
})

check('...but it does speed up the next planting', () => {
  const p = db.data.users[A]
  const wheat = CROPS.find(c => c.id === 'wheat')
  assert.ok(growthMsFor(p, wheat) < wheat.minutes * 60_000, 'greenhouse had no effect on new crops')
})

out = await run(farm, A, '', 'harvest')
check('.harvest reports nothing ready and the wait until the first one', () => {
  assert.match(out, /Nothing ready yet/i)
  assert.match(out, /still growing/i)
})

// Fast-forward the clock by rewriting readyAt — the same thing wall-clock time
// would do, without sleeping for 20 minutes.
for (const plot of db.data.users[A].home.plots) plot.readyAt = Date.now() - 1000

check('splitPlots sees back-dated plots as ready', () => {
  const { ready, growing } = splitPlots(db.data.users[A])
  assert.strictEqual(growing.length, 0)
  assert.strictEqual(ready.length, 3)
})

out = await run(farm, A, '', 'harvest')
check('.harvest empties the plots and fills the basket', () => {
  const p = db.data.users[A]
  assert.match(out, /Harvested 3 plots/i)
  assert.strictEqual(p.home.plots.length, 0, 'plots were not cleared')
  assert.ok((p.home.harvest.wheat ?? 0) >= 3 * 2, 'yield below 3x the minimum')
})

const beforeSale = db.data.users[A].wallet.solars
out = await run(farm, A, 'sell')
check('.farm sell converts produce to Solars and empties the basket', () => {
  const p = db.data.users[A]
  assert.match(out, /Produce sold/i)
  assert.ok(p.wallet.solars > beforeSale, 'balance did not grow')
  assert.strictEqual(p.home.harvest.wheat, 0)
})

out = await run(farm, A, 'sell')
check('selling an empty basket is refused, not paid out', () => assert.match(out, /Nothing harvested/i))

out = await run(farm, A, 'plant wheat 99')
check('planting more than the plot cap is capped, not overdrawn', () => {
  const p = db.data.users[A]
  assert.strictEqual(p.home.plots.length, plotCap(p))
  assert.match(out, /limited by/i)
})

out = await run(farm, A, 'plant carrot')
check('a full farm refuses further planting', () => assert.match(out, /already sown/i))

// A pauper can't plant.
makePlayer(B, 'Beta', 0)
await run(home, B, 'claim')
out = await run(farm, B, 'plant wheat')
check('planting without Solars is refused', () => {
  assert.match(out, /Not enough Solars/i)
  assert.strictEqual(db.data.users[B].home.plots.length, 0)
})

// ── 6. Decor and comfort ─────────────────────────────────────────────────
console.log('\nDecor')

out = await run(homedecor, A, 'rug')
check('.homedecor places decor and raises comfort', () => {
  const p = db.data.users[A]
  assert.match(out, /Woven Rug placed/i)
  assert.strictEqual(comfortOf(p), 2)
})

out = await run(homedecor, A, 'rug')
check('the same decor cannot be placed twice', () => assert.match(out, /already have/i))

await run(homedecor, A, 'hearth')
out = await run(homedecor, A, 'remove rug')
check('.homedecor remove frees the slot and drops comfort', () => {
  const p = db.data.users[A]
  assert.match(out, /taken down/i)
  assert.strictEqual(comfortOf(p), 4)
  assert.ok(!p.home.decor.includes('rug'))
})

out = await run(homedecor, A, 'remove rug')
check('removing decor you never placed is refused', () => assert.match(out, /haven't placed/i))

// ── 7. Storage round-trip ────────────────────────────────────────────────
console.log('\nStorage')

db.data.users[A].inventory.push('health_potion', 'health_potion', 'health_potion')
out = await run(home, A, 'store health_potion 2')
check('.home store moves items out of the inventory', () => {
  const p = db.data.users[A]
  assert.match(out, /Stored 2x/i)
  assert.strictEqual(p.inventory.filter(i => i === 'health_potion').length, 1)
  assert.strictEqual(p.home.storage.filter(i => i === 'health_potion').length, 2)
})

out = await run(home, A, 'take health_potion 2')
check('.home take brings them back', () => {
  const p = db.data.users[A]
  assert.match(out, /Took 2x/i)
  assert.strictEqual(p.inventory.filter(i => i === 'health_potion').length, 3)
  assert.strictEqual(p.home.storage.length, 0)
})

out = await run(home, A, 'take health_potion')
check('taking what is not stored is refused', () => assert.match(out, /No.*Health Potion.*in home storage/i))

// ── 8. Rest ──────────────────────────────────────────────────────────────
console.log('\nRest')

db.data.users[A].hp = 10
db.data.users[A].mp = 5
out = await run(home, A, 'rest')
check('.home rest heals by the tier + room bonus', () => {
  const p = db.data.users[A]
  assert.match(out, /Rested at home/i)
  assert.ok(p.hp > 10, 'no HP recovered')
  assert.ok(p.mp > 5, 'no MP recovered')
})

out = await run(home, A, 'rest')
check('.home rest is on cooldown immediately after', () => assert.match(out, /only just got up/i))

// ── 9. Fishing ───────────────────────────────────────────────────────────
console.log('\nFishing')

out = await run(fish, B, '1')
check('.fish resolves a cast in one call', () => {
  assert.match(out, /Cast into/i)
  assert.match(out, /(Landed a|slips the hook)/i)
  assert.ok(typeof db.data.users[B].home.lastFish === 'number', 'cooldown not stamped')
})

out = await run(fish, B, '1')
check('.fish is on cooldown right after a cast', () => assert.match(out, /still in the water/i))

// Force a landed fish into the bucket so the sell path is covered regardless
// of how the guess rolled.
db.data.users[B].home.bucket = { minnow: 2 }
out = await run(fish, B, 'bucket')
check('.fish bucket lists the haul and its worth', () => {
  assert.match(out, /Silver Minnow/i)
  assert.match(out, /x2/)
})

out = await run(fish, B, 'sell')
check('.fish sell pays out and empties the bucket', () => {
  const p = db.data.users[B]
  assert.match(out, /Catch sold/i)
  assert.ok(p.wallet.solars > 0)
  assert.strictEqual(p.home.bucket.minnow, 0)
})

out = await run(fish, B, 'sell')
check('selling an empty bucket is refused', () => assert.match(out, /Nothing to sell/i))

// ── 10. Guests, visiting, parties ────────────────────────────────────────
console.log('\nGuests')

out = await run(homeinvite, B, `@${A}`, 'homevisit', mentioning(A))
check('.homevisit is refused when not on the guest list', () => assert.match(out, /door's locked/i))

out = await run(homeinvite, A, `@${B}`, 'homeinvite', mentioning(B))
check('.homeinvite adds a registered player', () => {
  assert.match(out, /can now visit/i)
  assert.ok(db.data.users[A].home.visitors.includes(B))
})

out = await run(homeinvite, A, `@${B}`, 'homeinvite', mentioning(B))
check('inviting the same player twice is refused', () => {
  assert.match(out, /already on your guest list/i)
  assert.strictEqual(db.data.users[A].home.visitors.filter(v => v === B).length, 1)
})

out = await run(homeinvite, B, `@${A}`, 'homevisit', mentioning(A))
check('.homevisit shows the host\'s house once invited', () => {
  assert.match(out, /TIMBER MANOR/i)
  assert.match(out, /Comfort/i)
  assert.match(out, /guest here/i)
})

db.data.users[B].hp = 1
db.data.users[B].mp = 1
out = await run(homeinvite, A, '', 'homeparty')
check('.homeparty charges the host and heals the guests', () => {
  assert.match(out, /PARTY AT YOUR PLACE/i)
  assert.ok(db.data.users[B].hp > 1, 'guest HP not restored')
  assert.ok(db.data.users[B].mp > 1, 'guest MP not restored')
})

out = await run(homeinvite, A, '', 'homeparty')
check('.homeparty is on cooldown afterwards', () => assert.match(out, /hasn't been cleaned up/i))

out = await run(homeinvite, A, `remove @${B}`, 'homeinvite', mentioning(B))
check('.homeinvite remove revokes access', () => {
  assert.match(out, /no longer let themselves in/i)
  assert.ok(!db.data.users[A].home.visitors.includes(B))
})

out = await run(homeinvite, B, `@${A}`, 'homevisit', mentioning(A))
check('a revoked guest is locked out again', () => assert.match(out, /door's locked/i))

// ── 11. Neighborhood ─────────────────────────────────────────────────────
console.log('\nNeighborhood')

out = await run(neighborhood, B, 'text')
check('.neighborhood text ranks by comfort, best first', () => {
  assert.match(out, /THE NEIGHBOURHOOD/i)
  const posA = out.indexOf('Alpha')
  const posB = out.indexOf('Beta')
  assert.ok(posA !== -1 && posB !== -1, 'a home is missing from the street')
  assert.ok(posA < posB, 'the more comfortable home is not ranked first')
})

const png = await renderNeighborhood({
  houses: Object.values(db.data.users).filter(hasHome).map(p => ({
    name: p.name, tier: p.home.tier, tierName: tierOf(p).name, rank: tierOf(p).rank,
    comfort: comfortOf(p), rooms: p.home.rooms.length, decor: p.home.decor.length,
    plots: p.home.plots.length, ready: 0, isYou: p.id === A,
  })),
  viewer: 'Alpha',
  prefix: '.',
})
check('renderNeighborhood returns a PNG buffer', () => {
  assert.ok(Buffer.isBuffer(png), 'not a Buffer')
  assert.ok(png.length > 2000, `suspiciously small: ${png.length} bytes`)
  assert.strictEqual(png.subarray(1, 4).toString(), 'PNG', 'not a PNG signature')
})

const emptyPng = await renderNeighborhood({ houses: [], prefix: '.' })
check('renderNeighborhood handles nobody having a home', () => {
  assert.ok(Buffer.isBuffer(emptyPng) && emptyPng.length > 1000)
})

// ── Bag overflow after a premium lapse ──────────────────────────────────────
// lib/inventory-limits.js. Lives in the housing check because home storage is
// where the overflow is supposed to LAND: the whole point of the mechanism is
// that a lapse relocates your items rather than destroying them.
console.log('\n🎒 Premium lapse overflow')

const cheap = allItems.filter(i => i.rarity === 'uncommon' && i.sellPrice > 0)
  .sort((a, b) => a.sellPrice - b.sellPrice)[0]
const dear = allItems.filter(i => i.rarity === 'legendary' && i.sellPrice > 0)
  .sort((a, b) => b.sellPrice - a.sellPrice)[0]
const unsellable = allItems.find(i => i.rarity === 'common' && !(i.sellPrice > 0))

/** A lapsed player holding `nCheap` junk + `nDear` treasures, no house. */
function makeBag(id, nCheap, nDear, extra = {}) {
  const p = makePlayer(id, 'Overflow', 0, {
    inventory: [...Array(nCheap).fill(cheap.id), ...Array(nDear).fill(dear.id)],
    equipped: { weapon: dear.id },
    premium: { active: false, expiresAt: Date.now() - 1000 },
    ...extra,
  })
  return p
}

const OV = '901000000001@s.whatsapp.net'
const ov = makeBag(OV, 25, 10) // 35 held against the standard 30

check('cap is 30 standard, 50 premium', () => {
  assert.strictEqual(getInventoryCap(ov), 30)
  const vip = { ...ov, premium: { active: true, expiresAt: Date.now() + 60_000 } }
  assert.strictEqual(getInventoryCap(vip), 50)
})

check('overflow is measured against the lapsed cap', () => {
  const o = inventoryOverflow(ov)
  assert.deepStrictEqual([o.over, o.held, o.cap], [5, 35, 30])
})

check('first sight only WARNS, nothing leaves the bag', () => {
  const g = checkOverflowGrace(ov, Date.now())
  assert.strictEqual(g.phase, 'warned')
  assert.strictEqual(ov.inventory.length, 35, 'items were taken without warning')
  assert.ok(ov.inventoryGrace?.until > Date.now(), 'no deadline was stamped')
})

check('grace is 48h and repeat checks stay in grace', () => {
  const left = ov.inventoryGrace.until - ov.inventoryGrace.stampedAt
  assert.strictEqual(left, OVERFLOW_GRACE_MS)
  assert.strictEqual(Math.round(OVERFLOW_GRACE_MS / 3600_000), 48)
  assert.strictEqual(checkOverflowGrace(ov, Date.now() + 60_000).phase, 'grace')
  assert.strictEqual(ov.inventory.length, 35)
})

check('the deadline passing turns it due', () => {
  assert.strictEqual(checkOverflowGrace(ov, ov.inventoryGrace.until + 1).phase, 'due')
})

check('warning copy names the numbers and uses no em dashes', () => {
  const g = checkOverflowGrace(ov, Date.now() + 60_000)
  const msg = overflowWarnMessage(ov, g, '.')
  assert.match(msg, /35\/30/)
  assert.match(msg, /\.shop sell/)
  assert.ok(!/[—–]/.test(msg), 'em/en dash in player-facing copy')
})

check('getting back under cap clears the deadline, so a later lapse gets a fresh 48h', () => {
  const p = makeBag('901000000002@s.whatsapp.net', 25, 10)
  checkOverflowGrace(p, Date.now())
  assert.ok(p.inventoryGrace, 'no stamp to clear')
  p.inventory = p.inventory.slice(0, 28) // they sold down themselves
  assert.strictEqual(checkOverflowGrace(p, Date.now()).phase, 'clear')
  assert.strictEqual(p.inventoryGrace, undefined, 'stale deadline survived')
  p.inventory = [...p.inventory, ...Array(7).fill(cheap.id)] // over again later
  assert.strictEqual(checkOverflowGrace(p, Date.now()).phase, 'warned', 'shed without a fresh warning')
})

check('the plan sheds the CHEAPEST items and keeps the treasures', () => {
  const plan = planOverflowShed(ov, allItems, 0)
  assert.strictEqual(plan.over, 5)
  assert.strictEqual(plan.slots.length, 5)
  const shedIds = [...plan.toStorage, ...plan.toSell, ...plan.toDrop]
  assert.ok(shedIds.every(id => id === cheap.id), `a treasure was shed: ${shedIds.join(',')}`)
})

check('a house takes the overflow instead of losing it', () => {
  const p = makeBag('901000000003@s.whatsapp.net', 25, 10)
  ensureHome(p)
  p.home.tier = 'manor'
  const plan = planOverflowShed(p, allItems, storageCap(p))
  assert.strictEqual(plan.toStorage.length, 5, 'storage was not used first')
  assert.strictEqual(plan.toSell.length, 0)
  assert.strictEqual(plan.toDrop.length, 0)
  assert.strictEqual(plan.solars, 0)
})

check('a full house sells the overflow at shop price instead of destroying it', () => {
  const p = makeBag('901000000004@s.whatsapp.net', 25, 10)
  ensureHome(p)
  p.home.tier = 'tent'                       // 5 slots
  p.home.storage = Array(5).fill(cheap.id)   // all of them used
  const plan = planOverflowShed(p, allItems, storageCap(p))
  assert.strictEqual(plan.toStorage.length, 0)
  assert.strictEqual(plan.toSell.length, 5)
  assert.strictEqual(plan.solars, cheap.sellPrice * 5)
})

check('only what can be neither stored nor sold is destroyed', () => {
  const p = makeBag('901000000005@s.whatsapp.net', 0, 30)
  p.inventory.push(...Array(3).fill(unsellable.id)) // 33 held, cap 30
  const plan = planOverflowShed(p, allItems, 0)
  assert.strictEqual(plan.over, 3)
  assert.deepStrictEqual(plan.toDrop, Array(3).fill(unsellable.id))
  assert.strictEqual(plan.toSell.length, 0)
})

check('applying a plan lands exactly on the cap and pays for what it sold', () => {
  const p = makeBag('901000000006@s.whatsapp.net', 25, 10)
  p.wallet.solars = 100
  checkOverflowGrace(p, Date.now())
  const plan = planOverflowShed(p, allItems, 0)
  const res = applyOverflowShed(p, plan)
  assert.strictEqual(p.inventory.length, 30, `landed on ${p.inventory.length}, not the cap`)
  assert.strictEqual(p.inventory.filter(id => id === dear.id).length, 10, 'a treasure was taken')
  assert.strictEqual(p.wallet.solars, 100 + (cheap.sellPrice * 5))
  assert.strictEqual(res.solars, cheap.sellPrice * 5)
  assert.strictEqual(p.inventoryGrace, undefined, 'the deadline was not cleared after shedding')
  assert.strictEqual(p.equipped.weapon, dear.id, 'equipped gear was touched')
  assert.strictEqual(inventoryOverflow(p).over, 0)
})

check('shedding is idempotent: a second pass has nothing to do', () => {
  const p = makeBag('901000000007@s.whatsapp.net', 25, 10)
  applyOverflowShed(p, planOverflowShed(p, allItems, 0))
  const again = planOverflowShed(p, allItems, 0)
  assert.strictEqual(again.over, 0)
  assert.deepStrictEqual(applyOverflowShed(p, again), { moved: [], sold: [], dropped: [], solars: 0 })
  assert.strictEqual(p.inventory.length, 30)
})

check('duplicate ids are removed by slot, never the wrong copy', () => {
  const p = makeBag('901000000008@s.whatsapp.net', 0, 0)
  p.inventory = [dear.id, ...Array(31).fill(cheap.id), dear.id] // 33 held
  applyOverflowShed(p, planOverflowShed(p, allItems, 0))
  assert.strictEqual(p.inventory.length, 30)
  assert.strictEqual(p.inventory.filter(id => id === dear.id).length, 2, 'a treasure was removed')
  assert.strictEqual(p.inventory[0], dear.id, 'slot removal shifted the wrong copies')
  assert.strictEqual(p.inventory[p.inventory.length - 1], dear.id)
})

check('the receipt reports every destination', () => {
  const p = makeBag('901000000009@s.whatsapp.net', 25, 10)
  ensureHome(p)
  p.home.tier = 'tent'
  p.home.storage = Array(3).fill(cheap.id) // 2 slots left of 5
  const res = applyOverflowShed(p, planOverflowShed(p, allItems, storageCap(p)))
  assert.strictEqual(res.moved.length, 2)
  assert.strictEqual(res.sold.length, 3)
  const msg = overflowShedMessage(res, allItems, '.')
  assert.match(msg, /home storage/i)
  assert.match(msg, /Sold/i)
  assert.ok(!/[—–]/.test(msg), 'em/en dash in player-facing copy')
  assert.ok(!/undefined/.test(msg), 'an item id failed to resolve to a name')
})

check('an item the catalog has never heard of is shed LAST, not first', () => {
  // data/monsters.json drops several ids that were never added to the catalog.
  // Pricing them as common junk would shed a player's rarest pieces first.
  const ghost = 'trickster_vest'
  assert.ok(!allItems.some(i => i.id === ghost), 'this id is in the catalog now, pick another')
  const p = makeBag('901000000011@s.whatsapp.net', 29, 0)
  p.inventory.push(ghost, ghost, ghost) // 32 held, cap 30
  const plan = planOverflowShed(p, allItems, 0)
  assert.strictEqual(plan.over, 2)
  const shedIds = [...plan.toStorage, ...plan.toSell, ...plan.toDrop]
  assert.ok(!shedIds.includes(ghost), 'an unpriceable item was shed ahead of known junk')
  applyOverflowShed(p, plan)
  assert.strictEqual(p.inventory.filter(id => id === ghost).length, 3, 'an unpriceable item was destroyed')
})

check('an unknown id still reads as a name in the receipt, never as a slug', () => {
  const msg = overflowShedMessage(
    { moved: ['trickster_vest'], sold: [], dropped: [], solars: 0 }, allItems, '.',
  )
  assert.match(msg, /Trickster Vest/)
  assert.ok(!/trickster_vest/.test(msg), 'a raw id leaked into player-facing copy')
})

check('a premium player is left alone at 40 items', () => {
  const p = makeBag('901000000010@s.whatsapp.net', 30, 10)
  p.premium = { active: true, expiresAt: Date.now() + 86400_000 }
  assert.strictEqual(inventoryOverflow(p).over, 0)
  assert.strictEqual(checkOverflowGrace(p, Date.now()).phase, 'clear')
  assert.strictEqual(p.inventory.length, 40)
})

// ── The state machine handler.js actually runs ───────────────────────────────
// resolveOverflowNotice is the single entry point the command handler calls, so
// these cover the player's real experience: what they are told, when, and how
// many commands it takes before anything is removed.

console.log('\n🎒 Warn-then-shed over a play session')

const COOLDOWN = 6 * 60 * 60_000
const notice = (p, at, storage = 0) => resolveOverflowNotice(p, {
  allItems, storageCap: storage, prefix: '.', cooldownMs: COOLDOWN, now: at,
})

check('the first command after a lapse warns and removes nothing', () => {
  const p = makeBag('901000000020@s.whatsapp.net', 25, 10)
  const t0 = Date.now()
  const r = notice(p, t0)
  assert.strictEqual(r.phase, 'warned')
  assert.match(r.notice, /Bag over the limit\* \(35\/30\)/)
  assert.strictEqual(p.inventory.length, 35, 'items left the bag on the warning pass')
  assert.strictEqual(p.inventoryGrace.until, t0 + OVERFLOW_GRACE_MS)
})

check('the next command does not warn again, so it is never spam', () => {
  const p = makeBag('901000000021@s.whatsapp.net', 25, 10)
  const t0 = Date.now()
  notice(p, t0)
  const second = notice(p, t0 + 30_000)
  assert.strictEqual(second.notice, null)
  assert.strictEqual(second.phase, 'grace')
  assert.strictEqual(second.changed, false, 'a quiet pass should not need a write')
})

check('the warning comes back every 6h while the grace runs', () => {
  const p = makeBag('901000000022@s.whatsapp.net', 25, 10)
  const t0 = Date.now()
  notice(p, t0)
  assert.strictEqual(notice(p, t0 + COOLDOWN - 1000).notice, null)
  const again = notice(p, t0 + COOLDOWN)
  assert.match(again.notice, /Bag over the limit/)
  assert.strictEqual(p.inventory.length, 35, 'the repeat warning removed items')
  // and the clock it repeats against moves, without moving the deadline
  assert.strictEqual(p.inventoryGrace.warnedAt, t0 + COOLDOWN)
  assert.strictEqual(p.inventoryGrace.until, t0 + OVERFLOW_GRACE_MS)
})

check('fixing the bag during the grace ends it with no receipt and no loss', () => {
  const p = makeBag('901000000023@s.whatsapp.net', 25, 10)
  const t0 = Date.now()
  notice(p, t0)
  p.inventory.splice(0, 5) // they sold five themselves
  const r = notice(p, t0 + 3600_000)
  assert.strictEqual(r.notice, null)
  assert.strictEqual(r.phase, 'clear')
  assert.strictEqual(r.changed, true, 'dropping the deadline has to be persisted')
  assert.strictEqual(p.inventoryGrace, undefined, 'a stale deadline survived')
  assert.strictEqual(p.inventory.length, 30)
})

check('nothing is removed until the 48h deadline has actually passed', () => {
  const p = makeBag('901000000024@s.whatsapp.net', 25, 10)
  const t0 = Date.now()
  notice(p, t0)
  // a whole session of commands right up to the deadline
  for (let h = 1; h <= 47; h++) notice(p, t0 + h * 3600_000)
  assert.strictEqual(p.inventory.length, 35, 'the bag was trimmed early')
  const shed = notice(p, t0 + OVERFLOW_GRACE_MS + 1)
  assert.strictEqual(shed.phase, 'due')
  assert.strictEqual(p.inventory.length, 30)
  assert.match(shed.notice, /Bag trimmed to the 30 slot limit/)
})

check('a house catches the overflow on the shed pass', () => {
  const p = makeBag('901000000025@s.whatsapp.net', 25, 10)
  p.home = { tier: 'manor', storage: [] }
  const t0 = Date.now()
  notice(p, t0, 60)
  const shed = notice(p, t0 + OVERFLOW_GRACE_MS + 1, 60)
  assert.strictEqual(p.inventory.length, 30)
  assert.strictEqual(p.home.storage.length, 5)
  assert.strictEqual(shed.result.dropped.length, 0, 'an item was destroyed with a house standing')
  assert.match(shed.notice, /Moved to home storage \(5\)/)
})

check('the shed only ever happens once', () => {
  const p = makeBag('901000000026@s.whatsapp.net', 25, 10)
  const t0 = Date.now()
  notice(p, t0)
  notice(p, t0 + OVERFLOW_GRACE_MS + 1)
  assert.strictEqual(p.inventory.length, 30)
  const after = notice(p, t0 + OVERFLOW_GRACE_MS + 2000)
  assert.strictEqual(after.notice, null)
  assert.strictEqual(after.phase, 'clear')
  assert.strictEqual(p.inventory.length, 30)
})

check('a receipt parked by the offline sweep is delivered once, then dropped', () => {
  const p = makeBag('901000000027@s.whatsapp.net', 0, 5)
  p.inventoryShed = { at: Date.now(), moved: ['iron_ore'], sold: [], dropped: [], solars: 0 }
  const first = notice(p, Date.now())
  assert.strictEqual(first.phase, 'receipt')
  assert.match(first.notice, /Moved to home storage \(1\)/)
  assert.strictEqual(p.inventoryShed, undefined)
  assert.strictEqual(notice(p, Date.now()).notice, null, 'the receipt was sent twice')
})

check('a player under the cap never enters the machine at all', () => {
  const p = makeBag('901000000028@s.whatsapp.net', 20, 5)
  const r = notice(p, Date.now())
  assert.strictEqual(r.notice, null)
  assert.strictEqual(r.phase, 'clear')
  assert.strictEqual(r.changed, false)
  assert.strictEqual(p.inventory.length, 25)
  assert.strictEqual(p.inventoryGrace, undefined)
})

check('a missing player is a no-op, never a crash', () => {
  const r = resolveOverflowNotice(null, { allItems })
  assert.strictEqual(r.notice, null)
  assert.strictEqual(r.changed, false)
})

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
