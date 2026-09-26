import test from 'node:test'
import assert from 'node:assert/strict'
import { pullBanner, sendBannerArt, NEW_CHARACTERS, SPIN_FIELDS } from '../lib/witch-heroes-spins.js'
import { BANNERS } from '../lib/witch-heroes.js'
import { updatePlayer } from '../lib/player-repo.js'
const dbFor = users => ({ data: { users }, write: async () => {} })
const player = gems => ({ wallet: { gems }, ownedCharacters: [] })

for (const [id, banner] of Object.entries(BANNERS)) {
  test(`${id}: full acquisition costs exactly the guaranteed spin and stops its winning batch`, () => {
    const p = player(1000), db = dbFor({ p })
    while (!p.ownedCharacters.includes(id)) pullBanner(db, p, 'p', id, 5)
    assert.equal(p[SPIN_FIELDS[id]], banner.guarantee)
    assert.equal(p.wallet.gems, 1000 - banner.guarantee)
    assert.equal(db.data.seasonRuntime.exclusiveSpinWinners[id], 'p')
    assert.deepEqual(p.ownedCharacters, [id])
    assert.equal(pullBanner(db, p, 'p', id).spent, 0)
    const other = player(1000)
    assert.equal(pullBanner(db, other, 'other', id).reason, 'claimed')
    assert.equal(other.wallet.gems, 1000)
  })
}
test('insufficient gems and exhausted cap do not charge or increment spins', () => {
  const p = player(0), db = dbFor({ p })
  assert.equal(pullBanner(db, p, 'p', 'scarlett').reason, 'gems')
  assert.equal(p.scarlettSpins, undefined)
  p.wallet.gems = 100; p.scarlettSpins = 250
  assert.equal(pullBanner(db, p, 'p', 'scarlett').reason, 'cap')
  assert.equal(p.wallet.gems, 100)
})
test('batch caps at five and insufficient funds only pay for actual attempts', () => {
  const p = player(6), db = dbFor({ p })
  assert.equal(pullBanner(db, p, 'p', 'ronova', 300).spent, 5)
  assert.equal(pullBanner(db, p, 'p', 'ronova', 5).spent, 1)
  assert.equal(p.wallet.gems, 0)
  assert.equal(p.ronovaSpins, 6)
})
test('two racing serialized pulls produce one winner and the loser is not charged', async () => {
  const a = player(1), b = player(1)
  a.swordMaidenSpins = b.swordMaidenSpins = 299
  const db = dbFor({ a, b })
  const outcomes = []
  await Promise.all(['a', 'b'].map(id => updatePlayer(db, id, p => {
    outcomes.push(pullBanner(db, p, id, 'sword_maiden'))
  })))
  assert.equal(outcomes.filter(o => o.reason === 'won').length, 1)
  assert.equal(outcomes.filter(o => o.reason === 'claimed').length, 1)
  assert.equal(a.wallet.gems + b.wallet.gems, 1)
})
test('Maiden preview AND win use GIF path; never fall back to flattening it', async () => {
  const calls = [], c = NEW_CHARACTERS.find(c => c.id === 'sword_maiden')
  const ctx = { replyGif: async () => calls.push('gif'), replyImage: async () => calls.push('image'), reply: async () => calls.push('text') }
  await sendBannerArt(ctx, c, 'preview')
  await sendBannerArt(ctx, c, 'win', { win: true })
  assert.deepEqual(calls, ['gif', 'gif'])
  ctx.replyGif = async () => { throw new Error('media failed') }
  await sendBannerArt(ctx, c, 'fallback')
  assert.deepEqual(calls, ['gif', 'gif', 'text'])
})
test('staged character definitions are all exclusive and not direct gem purchases', () => {
  for (const c of NEW_CHARACTERS) { assert.equal(c.exclusive, true); assert.equal(c.gemPrice, null); assert.equal(c.mondPrice, undefined) }
  assert.equal(NEW_CHARACTERS.find(c => c.id === 'sword_maiden').series, 'The Heroes')
})
