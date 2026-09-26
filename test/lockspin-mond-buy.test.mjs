/**
 * lockspin-mond-buy.test.mjs — `.lockspin <name>` must close BOTH doors a
 * character can enter an account through: the spin banner and the Mond shop.
 *
 * THE REPORT THIS KILLS.
 *
 * The owner froze a character for a staged reveal. A player typed
 * `.character buy <name>`, paid 5 Monds, and walked out with the frozen
 * character anyway. Cause: `.lockspin` writes one flag (data/spin-locks.json,
 * read through lib/spin-locks.js) but only spinLockGate() — the ONE line in
 * every *-spin.js plugin — ever consulted it. plugins/character.js's handleBuy()
 * checked `seasonId`, the flat Mond price, and the one-of-one claim, and never
 * asked whether the owner had shut the character. So the freeze was a lock on
 * one of two doors, which is not a lock: anyone with 🪙5 could route around it,
 * and the reveal was spoiled on the first attempt.
 *
 * The fix is shopLockGate() in lib/spin-locks.js, called by handleBuy() as its
 * FIRST statement. These tests hold the fix to the three things that matter:
 *   1. a locked character cannot be bought, by anyone, at any price
 *   2. the refusal costs NOTHING — no Monds, and no one-of-one global claim
 *   3. the listing stops advertising a route the player cannot use
 *
 * Sections:
 *   1. The store, and the reported bug (locked → refused, open → works)
 *   2. Nothing is spent on the way to the refusal (Monds, and the one-of-one lock)
 *   3. One switch, both doors (the same freeze still closes the spin plugin)
 *   4. `.character` / `.character info` / `.character equip` stop quoting 🪙5
 *   5. `.lockspin` / `.unlockspin` — owner gate and the copy that promises this
 *
 * Runs the REAL plugins against a mocked ctx/db the way handler.js would, with
 * no bot, no socket and no db file. The lock store is pointed at a throwaway
 * directory BEFORE anything imports lib/spin-locks.js, so persist() can never
 * touch the repo's tracked data/spin-locks.json — which ships with `gojo`
 * frozen, and a test that read that file would start from a surprise lock.
 *
 * Run:  node --test test/lockspin-mond-buy.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOG_LEVEL ??= 'error'
// Must be set before the first import of lib/spin-locks.js (via runtime-paths).
process.env.RUNTIME_DATA_DIR = mkdtempSync(join(tmpdir(), 'astral-spin-locks-test-'))

const { config }             = await import('../config.js')
const characterPlugin        = (await import('../plugins/character.js')).default
const lockspinPlugin         = (await import('../plugins/lockspin.js')).default
const unlockspinPlugin       = (await import('../plugins/unlockspin.js')).default
const gojoSpinPlugin         = (await import('../plugins/gojo-spin.js')).default
const { lockSpin, unlockSpin, isSpinLocked } = await import('../lib/spin-locks.js')
const { mondPriceFor, getMonds, MOND }      = await import('../lib/monds.js')
const { characterMap }                       = await import('../lib/game-data.js')

const OWNER = '2340000000000'
// Pinned so the owner-only checks do not depend on whose number config.js
// happens to default to, or on a local .env overriding it.
config.ownerNumbers = [OWNER]

const PLAYER = '234000000101@s.whatsapp.net'
/** A player with more than enough Monds for any flat price in the roster. */
function makePlayer(extra = {}) {
  return {
    id: PLAYER,
    name: 'Buyer',
    level: 30,
    wallet: { solars: 0, gems: 500, monds: 50 },
    ownedCharacters: [],
    ...extra,
  }
}

function makeDb(player) {
  return { data: { users: { [player.id]: player } }, write: async () => {} }
}

/** ctx shaped the way handler.js builds it: args WITHOUT the command word. */
function makeCtx(db, from, args, cmd = 'character') {
  const replies = []
  const ctx = {
    db, from, args, cmd, isGroup: false, platform: 'whatsapp',
    player: db.data.users[from],
    reply: async (text) => { replies.push(String(text)); return text },
    replyImage: async (url, text) => { replies.push(String(text)); return text },
    // sendCharacterArt() sends the caption as a WhatsApp image message rather
    // than a text reply, so capture the caption off the wire shape as well —
    // `.character info` and a successful equip would otherwise read as silence.
    sock: { sendMessage: async (to, payload) => {
      if (payload?.caption) replies.push(String(payload.caption))
      return { key: {} }
    } },
    sender: PLAYER, replies,
  }
  return ctx
}

async function runCharacter(db, args, from = PLAYER) {
  const ctx = makeCtx(db, from, args)
  await characterPlugin.run(ctx)
  return { ctx, text: () => ctx.replies.join('\n') }
}

/**
 * The one character per shape these tests need, resolved out of the real data
 * file so a roster edit (Gojo stops being spinOnly, Echidna stops being
 * one-of-one) fails loudly here instead of quietly testing the wrong thing.
 */
const BUYABLE = Object.values(characterMap).find(c => c.spinOnly === true && mondPriceFor(c) !== null)
const ONE_OF_ONE = Object.values(characterMap).find(c => c.exclusive === true && mondPriceFor(c) !== null)
/** Gojo, because plugins/gojo-spin.js is the banner this suite can actually run. */
const SPUN = characterMap.gojo
const PRICE = mondPriceFor(BUYABLE)
const PRICE_ONE = mondPriceFor(ONE_OF_ONE)

test('the roster has the two shapes this regression is about', () => {
  assert.ok(BUYABLE && ONE_OF_ONE, 'data/characters.json needs a spinOnly and an exclusive character')
  assert.ok(PRICE > 0 && PRICE_ONE > 0, 'both must be Mond-buyable, or the bug is unreachable')
})

// ── 1. The reported bug ─────────────────────────────────────────────────────

test('control: with the freeze OFF, .character buy charges and grants', async () => {
  unlockSpin(BUYABLE.id)
  assert.equal(isSpinLocked(BUYABLE.id), false)
  const player = makePlayer()
  const db = makeDb(player)
  const { text } = await runCharacter(db, ['buy', BUYABLE.id])
  assert.match(text(), /Purchase complete/i, 'the happy path must still work')
  assert.deepEqual(player.ownedCharacters, [BUYABLE.id])
  assert.equal(getMonds(player), 50 - PRICE, `the flat ${PRICE}-Mond price is charged`)
})

test('the bug: with the freeze ON, .character buy cannot obtain the character', async () => {
  lockSpin(BUYABLE.id, `${OWNER}@s.whatsapp.net`)
  assert.equal(isSpinLocked(BUYABLE.id), true, '.lockspin set the flag the shop has to honour')
  const player = makePlayer()
  const db = makeDb(player)
  const { text } = await runCharacter(db, ['buy', BUYABLE.id])
  assert.match(text(), /locked/i, 'the refusal names the lock')
  assert.doesNotMatch(text(), /Purchase complete/i, 'a frozen character must never report a sale')
  assert.deepEqual(player.ownedCharacters, [], `${BUYABLE.name} was not granted`)
  unlockSpin(BUYABLE.id)
})

test('a locked character cannot be bought by the owner either — a lock is a lock', async () => {
  lockSpin(BUYABLE.id, `${OWNER}@s.whatsapp.net`)
  const ownerPlayer = makePlayer({ id: `${OWNER}@s.whatsapp.net`, name: 'Owner' })
  const db = makeDb(ownerPlayer)
  const { text } = await runCharacter(db, ['buy', BUYABLE.id], ownerPlayer.id)
  assert.match(text(), /locked/i, 'the owner is not exempt from their own freeze')
  assert.deepEqual(ownerPlayer.ownedCharacters, [])
  unlockSpin(BUYABLE.id)
})

// ── 2. Refusing must cost nothing ───────────────────────────────────────────

test('the refusal spends no Monds', async () => {
  lockSpin(BUYABLE.id, null)
  const player = makePlayer()
  await runCharacter(makeDb(player), ['buy', BUYABLE.id])
  assert.equal(getMonds(player), 50, 'a locked purchase leaves the wallet exactly as it was')
  unlockSpin(BUYABLE.id)
})

test('the refusal does NOT burn the bot-wide one-of-one claim', async () => {
  // The old order claimed the exclusive BEFORE the lock was ever consulted, so a
  // buy that was refused still locked the character out for every other player.
  lockSpin(ONE_OF_ONE.id, null)
  const player = makePlayer()
  const db = makeDb(player)
  await runCharacter(db, ['buy', ONE_OF_ONE.id])
  const claimed = db.data.seasonRuntime?.exclusiveSpinWinners?.[ONE_OF_ONE.id]
  assert.equal(claimed, undefined, 'a refused purchase must not take the one-of-one slot')
  assert.equal(getMonds(player), 50)

  // And the slot is still free once the owner opens it.
  unlockSpin(ONE_OF_ONE.id)
  const { text } = await runCharacter(db, ['buy', ONE_OF_ONE.id])
  assert.match(text(), /Purchase complete/i, 'unfreezing restores the route, no restart needed')
  assert.equal(db.data.seasonRuntime.exclusiveSpinWinners[ONE_OF_ONE.id], PLAYER)
})

// ── 3. One switch, both doors ───────────────────────────────────────────────

test('the same freeze that closes the shop closes the banner', async () => {
  lockSpin(SPUN.id, null)
  const player = makePlayer()
  const db = makeDb(player)
  const ctx = makeCtx(db, player.id, [], 'gojo-spin')
  await gojoSpinPlugin.run(ctx)
  assert.match(ctx.replies.join('\n'), /locked/i, 'the spin plugin refuses the frozen id')
  assert.equal(player.gojoSpins ?? 0, 0, 'and charges nothing for the privilege')
  assert.equal(player.wallet.gems, 500)
  unlockSpin(SPUN.id)
})

test('unlocking reopens both doors at once', async () => {
  // One store, one switch: there is no way to leave the banner shut while the
  // price is live, which is what a per-plugin flag would have allowed.
  lockSpin(BUYABLE.id, null)
  assert.equal(isSpinLocked(BUYABLE.id), true)
  assert.equal(unlockSpin(BUYABLE.id).changed, true)
  assert.equal(isSpinLocked(BUYABLE.id), false)
  assert.equal(unlockSpin(BUYABLE.id).changed, false, 'unlocking an open character changes nothing')
})

// ── 4. The listing must not advertise a closed door ─────────────────────────

test('`.character` shows a frozen character as frozen, not as 🪙-priced', async () => {
  lockSpin(BUYABLE.id, null)
  const player = makePlayer()
  const { text } = await runCharacter(makeDb(player), [])
  const line = text().split('\n').find(l => l.includes(`*${BUYABLE.emoji} ${BUYABLE.name}*`))
  assert.ok(line, 'the character is still listed — a freeze hides nothing, it just closes purchase')
  assert.match(line, /frozen/i, 'and the row says why')
  assert.doesNotMatch(line, /character buy /, 'while it does NOT print the buy command')
  assert.ok(!line.includes(`${MOND}${PRICE}`), 'and does not quote a price nobody can pay')
  unlockSpin(BUYABLE.id)
  const { text: again } = await runCharacter(makeDb(player), [])
  const openLine = again().split('\n').find(l => l.includes(`*${BUYABLE.emoji} ${BUYABLE.name}*`))
  assert.ok(openLine.includes(`${MOND}${PRICE}`), 'unfreezing puts the price back')
})

test('`.character info` on a frozen character promises nothing it cannot deliver', async () => {
  lockSpin(BUYABLE.id, null)
  const { text } = await runCharacter(makeDb(makePlayer()), ['info', BUYABLE.id])
  assert.match(text(), /frozen/i)
  assert.doesNotMatch(text(), /Buy outright for/, 'no price line on a frozen card')
  assert.doesNotMatch(text(), /spin for it with gems/i, 'no spin line either')
  unlockSpin(BUYABLE.id)
})

test('freezing does not disturb a player who already owns it', async () => {
  // A freeze is a door, not a revocation: the roster row stays ✅ and equip
  // still works, so a mid-season lock cannot strand an owner.
  const player = makePlayer({ ownedCharacters: [BUYABLE.id] })
  const db = makeDb(player)
  lockSpin(BUYABLE.id, null)
  const { text } = await runCharacter(db, [])
  const line = text().split('\n').find(l => l.includes(BUYABLE.name))
  assert.match(line, /owned/, 'already-owned still reads as owned')
  const equip = await runCharacter(db, ['equip', BUYABLE.id])
  assert.match(equip.text(), /equipped/i, 'and still equips')
  unlockSpin(BUYABLE.id)
})

test('`.character equip` on a frozen, unowned character gives the freeze, not a shop window', async () => {
  lockSpin(BUYABLE.id, null)
  const { text } = await runCharacter(makeDb(makePlayer()), ['equip', BUYABLE.id])
  assert.match(text(), /frozen/i)
  assert.doesNotMatch(text(), /Buy it outright/, 'and refuses without handing out the closed route')
  unlockSpin(BUYABLE.id)
})

// ── 5. The owner-facing commands ────────────────────────────────────────────

test('`.lockspin <name>` tells the owner the price is closed too', async () => {
  unlockSpin(BUYABLE.id)
  const ctx = makeCtx(makeDb(makePlayer()), `${OWNER}@s.whatsapp.net`, [BUYABLE.id], 'lockspin')
  await lockspinPlugin.run(ctx)
  const text = ctx.replies.join('\n')
  assert.match(text, /locked/i)
  assert.match(text, /mond|buy/i, 'the promise has to match what the freeze now does')
  assert.equal(isSpinLocked(BUYABLE.id), true)
  unlockSpin(BUYABLE.id)
})

test('`.lockspin` with no argument lists frozen characters, and is owner-only', async () => {
  lockSpin(BUYABLE.id, null)
  const listed = makeCtx(makeDb(makePlayer()), `${OWNER}@s.whatsapp.net`, [], 'lockspin')
  await lockspinPlugin.run(listed)
  assert.match(listed.replies.join('\n'), new RegExp(BUYABLE.name), 'the frozen id appears in the listing')

  const stranger = makeCtx(makeDb(makePlayer()), '234000000999@s.whatsapp.net', [BUYABLE.id], 'lockspin')
  await lockspinPlugin.run(stranger)
  assert.match(stranger.replies.join('\n'), /not allowed|owner/i, 'a non-owner cannot lock or unlock')
  unlockSpin(BUYABLE.id)
})

test('`.unlockspin <name>` reopens the character and says so', async () => {
  lockSpin(BUYABLE.id, null)
  const ctx = makeCtx(makeDb(makePlayer()), `${OWNER}@s.whatsapp.net`, [BUYABLE.id], 'unlockspin')
  await unlockspinPlugin.run(ctx)
  assert.match(ctx.replies.join('\n'), /open/i)
  assert.match(ctx.replies.join('\n'), /mond|buy/i)
  assert.equal(isSpinLocked(BUYABLE.id), false)
})
