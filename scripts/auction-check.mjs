/**
 * scripts/auction-check.mjs — behavioural check for the owner-started auction.
 *
 * Drives plugins/auction.js through a fake ctx (stub sock + in-memory db) and
 * asserts the flow the rework was for: nobody can bid until the OWNER opens a
 * round, bids then land, and settling pays out. Run it directly:
 *
 *   node scripts/auction-check.mjs
 *
 * No WhatsApp connection and no writes to the real db.json — updatePlayer is
 * pointed at a throwaway lowdb-shaped object.
 */
import assert from 'assert'
import { config } from '../config.js'
import auction from '../plugins/auction.js'

const OWNER  = `${config.ownerNumbers[0]}@s.whatsapp.net`
const RANDO  = '999000111222@s.whatsapp.net'
const GROUP  = '120363000000000000@g.us'
const DM     = '555000111222@s.whatsapp.net'

let pass = 0, fail = 0
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass++ }
  catch (err) { console.log(`  ✗ ${label}\n      ${err.message}`); fail++ }
}

// ── Fakes ────────────────────────────────────────────────────────────────
const sent = []   // every sock.sendMessage call
const sock = {
  sendMessage: async (jid, content) => { sent.push({ jid, text: content.text }); return {} },
}

function makePlayer(id, name, solars, level = 99) {
  return { id, name, level, wallet: { solars }, inventory: [] }
}

// player-repo keys off db.data.users — not .players.
const db = { data: { users: {} }, write: async () => {} }

function makeCtx(from, sender, argsLine, player = null) {
  const replies = []
  return {
    ctx: {
      sock, db, from, sender,
      isGroup: sender.endsWith('@g.us'),
      player,
      args: argsLine.split(' ').filter(Boolean),
      reply: async (t) => { replies.push(String(t)); return {} },
    },
    replies,
  }
}

const run = (from, sender, argsLine, player) => {
  const { ctx, replies } = makeCtx(from, sender, argsLine, player)
  return auction.run(ctx).then(() => replies.join('\n'))
}

console.log('\nAuction — owner-started flow\n')

// 1. Idle: no auction runs until the owner opens one.
let out = await run(RANDO, GROUP, '', makePlayer(RANDO, 'Rando', 999999))
check('closed hall when nothing is running', () => {
  assert.match(out, /hall is closed/i)
})

// 2. A non-owner cannot open one.
out = await run(RANDO, GROUP, 'start', makePlayer(RANDO, 'Rando', 999999))
check('non-owner is refused .auction start', () => {
  assert.match(out, /only the bot owner/i)
})

// 3. Bidding is impossible while closed.
out = await run(RANDO, GROUP, 'bid 1 5000', makePlayer(RANDO, 'Rando', 999999))
check('bidding refused while closed', () => {
  assert.match(out, /hall is closed/i)
  assert.doesNotMatch(out, /bid placed/i)
})

// 4. Owner opens a single named lot with an explicit 5-minute window.
// Must be a real entry from data/auction.json — season relics are a different pool.
out = await run(OWNER, GROUP, 'start solaris reaver 5', makePlayer(OWNER, 'Owner', 0))
check('owner opens a named single lot', () => {
  assert.match(out, /THE AUCTION IS OPEN/i)
  assert.match(out, /Closes in \*5 min\*/)
  assert.match(out, /\[1\]/)
  assert.doesNotMatch(out, /\[2\]/, 'named start should open exactly one lot')
})

// 5. Now players can bid.
const bidder = makePlayer(RANDO, 'Rando', 999999)
out = await run(RANDO, GROUP, 'bid 1 50000', bidder)
check('player can bid once the round is open', () => {
  assert.match(out, /Bid placed on lot #1/i)
  assert.match(out, /50,000/)
})

// 6. A lower bid is rejected.
out = await run(DM, DM, 'bid 1 10', makePlayer(DM, 'Lowball', 999999))
check('under-bid is rejected', () => {
  assert.match(out, /must beat the current bid/i)
})

// 7. A bid from a DM mirrors into the host chat.
sent.length = 0
out = await run(DM, DM, 'bid 1 60000', makePlayer(DM, 'Sniper', 999999))
check('DM bid is mirrored to the host chat', () => {
  assert.match(out, /Bid placed/i)
  const mirror = sent.find(m => m.jid === GROUP && /bids/i.test(m.text ?? ''))
  assert.ok(mirror, `expected a mirror message to ${GROUP}, got ${JSON.stringify(sent)}`)
})

// 8. Owner cannot open a second round on top of a live one.
out = await run(OWNER, GROUP, 'start', makePlayer(OWNER, 'Owner', 0))
check('second start is refused while a round is live', () => {
  assert.match(out, /already running/i)
})

// 9. Non-owner cannot end it.
out = await run(RANDO, GROUP, 'end', makePlayer(RANDO, 'Rando', 0))
check('non-owner is refused .auction end', () => {
  assert.match(out, /only the bot owner/i)
})

// 10. Owner ends it; the winner is announced in the host chat.
db.data.users[DM] = makePlayer(DM, 'Sniper', 999999)
sent.length = 0
out = await run(OWNER, GROUP, 'end', makePlayer(OWNER, 'Owner', 0))
check('owner settles the round and it announces in the host chat', () => {
  assert.match(out, /Settling \*1\* open lot/i)
  const closing = sent.find(m => /AUCTION LOT CLOSED/i.test(m.text ?? ''))
  assert.ok(closing, `expected a closing announcement, got ${JSON.stringify(sent)}`)
  assert.strictEqual(closing.jid, GROUP, 'closing announcement went to the wrong chat')
  assert.match(closing.text, /SOLD/i, 'lot had a top bidder, so it should have sold')
})

check('winner is charged and receives the item', () => {
  const winner = db.data.users[DM]
  assert.ok(winner.inventory.includes('solaris_reaver'), 'item not granted to winner')
  assert.strictEqual(winner.wallet.solars, 999999 - 60000, 'winner was not charged the bid')
})

// 11. Back to closed afterwards.
out = await run(RANDO, GROUP, '', makePlayer(RANDO, 'Rando', 999999))
check('hall is closed again after settling', () => {
  assert.match(out, /hall is closed/i)
})

// 12. A random round opens 5 lots.
out = await run(OWNER, DM, 'start', makePlayer(OWNER, 'Owner', 0))
check('bare start opens a full random round', () => {
  assert.match(out, /THE AUCTION IS OPEN/i)
  assert.match(out, /\[5\]/)
})
await run(OWNER, DM, 'end', makePlayer(OWNER, 'Owner', 0))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
