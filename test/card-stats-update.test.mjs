/**
 * test/card-stats-update.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Suite for the 2026-09-22 card + stats drop:
 *
 *  1. TIER REPRICE (lib/card-engine.js) — S sells for 150k, tier 6 for 130k,
 *     stepping down; buy price stays above sell price on EVERY tier so
 *     buy-then-sell can never mint Solars; unknown tiers still fall back to
 *     tier 1 instead of NaN/undefined.
 *  2. GIF-AWARE CARD MEDIA (lib/card-media.js) — .gif detection, still-image
 *     payloads without touching the network, gif-transcode failure degrading
 *     to the still first frame (no throw), and sendCardMedia's text fallback.
 *     The sandbox has no ffmpeg, so the SUCCESSFUL-transcode path (real MP4
 *     Buffer + gifPlayback) is asserted structurally where possible and the
 *     fallback ladder is asserted exactly — the ladder is what must never
 *     regress, since every spawn path depends on it.
 *  3. STATS CARD RENDER (lib/stats-card-render.mjs) — renders a real PNG for
 *     a full player, a bare-minimum legacy-shaped player, and with a The End
 *     aura line; the sanitizer strips emoji/markdown so canvas never draws
 *     tofu.
 *  4. .stats PLUGIN WIRING (plugins/stats.js) — bare .stats sends the image
 *     with a summary caption; the add/train subcommands still answer in text.
 *
 * Run:  node test/card-stats-update.test.mjs
 */
import assert from 'node:assert/strict'

import {
  cardSellPrice, cardBuyPrice, tierStars, tierRank,
} from '../lib/card-engine.js'
import { isGifUrl, isDirectVideoUrl, cardMediaPayload, sendCardMedia } from '../lib/card-media.js'
import { renderStatsCard, sanitizeCanvasLine } from '../lib/stats-card-render.mjs'
import statsPlugin from '../plugins/stats.js'

console.log('🧪 Card reprice + gif media + stats card — feature suite')

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (err) {
    failures.push({ name, err })
    console.log(`FAIL  ${name}\n      ${err.stack?.split('\n').slice(0, 5).join('\n      ')}`)
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

function makePlayer(overrides = {}) {
  return {
    id: '234700000001@s.whatsapp.net',
    name: 'TestHero',
    level: 42,
    xp: 50000,
    classId: 'warrior',
    raceId: 'human',
    stats: { str: 120, agi: 95, int: 60, def: 110, lck: 40 },
    wallet: { solars: 100000, gems: 10, monds: 5, vault: 2000, bankGold: 3000 },
    ...overrides,
  }
}

// ── 1. Tier reprice ─────────────────────────────────────────────────────────

await test('sell ladder: S=150k, 6=130k, strictly increasing by tier rank', () => {
  assert.strictEqual(cardSellPrice('S'), 150000)
  assert.strictEqual(cardSellPrice(6), 130000)
  const ladder = ['1', '2', '3', '4', '5', '6', 'S']
  const prices = ladder.map(t => cardSellPrice(t))
  for (const p of prices) assert.ok(Number.isFinite(p) && p > 0, `non-positive sell price: ${p}`)
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(
      prices[i] > prices[i - 1],
      `sell ladder not increasing: tier ${ladder[i - 1]}=${prices[i - 1]} vs ${ladder[i]}=${prices[i]}`,
    )
  }
  // Ranks still order S above 6.
  assert.ok(tierRank('S') > tierRank(6))
})

await test('buy price exceeds sell price on every tier (no flip profit)', () => {
  for (const t of ['1', '2', '3', '4', '5', '6', 'S']) {
    const buy = cardBuyPrice(t)
    const sell = cardSellPrice(t)
    assert.ok(Number.isFinite(buy) && buy > sell, `tier ${t}: buy=${buy} sell=${sell}`)
  }
})

await test('unknown tiers fall back to tier-1 prices, never NaN', () => {
  assert.strictEqual(cardSellPrice('999'), cardSellPrice(1))
  assert.strictEqual(cardBuyPrice(undefined), cardBuyPrice(1))
  assert.ok(Number.isFinite(cardSellPrice(null)))
  assert.ok(tierStars('S').length > 0 && tierStars(1).length > 0)
})

// ── 2. GIF-aware card media ─────────────────────────────────────────────────

await test('isGifUrl / isDirectVideoUrl classify by extension (query-tolerant)', () => {
  assert.strictEqual(isGifUrl('https://cdn.example.com/art.gif'), true)
  assert.strictEqual(isGifUrl('https://cdn.example.com/art.gif?x=1'), true)
  assert.strictEqual(isGifUrl('https://cdn.example.com/art.GIF'), true)
  assert.strictEqual(isGifUrl('https://cdn.example.com/art.jpg'), false)
  assert.strictEqual(isGifUrl('https://cdn.example.com/art.webp'), false)
  assert.strictEqual(isGifUrl(null), false)
  assert.strictEqual(isDirectVideoUrl('https://cdn.example.com/clip.mp4'), true)
  assert.strictEqual(isDirectVideoUrl('https://cdn.example.com/clip.webm?t=2'), true)
  assert.strictEqual(isDirectVideoUrl('https://cdn.example.com/art.gif'), false)
  assert.strictEqual(isDirectVideoUrl('https://cdn.example.com/art.png'), false)
})

await test('still image → image payload without network', async () => {
  const payload = await cardMediaPayload('https://cdn.example.com/art.jpg', 'hello')
  assert.deepStrictEqual(Object.keys(payload).sort(), ['caption', 'image'])
  assert.deepStrictEqual(payload.image, { url: 'https://cdn.example.com/art.jpg' })
  assert.strictEqual(payload.caption, 'hello')
})

await test('real video URL → looping video payload', async () => {
  const payload = await cardMediaPayload('https://cdn.example.com/clip.mp4', 'hello')
  assert.strictEqual(payload.gifPlayback, true)
  assert.deepStrictEqual(payload.video, { url: 'https://cdn.example.com/clip.mp4' })
})

await test('gif with failed transcode degrades to still frame, never throws', async () => {
  // A local path that cannot exist: readFile fails before ffmpeg is ever
  // involved, so this exercises the fallback with no network and no binary.
  const payload = await cardMediaPayload('/nonexistent-dir/nope.gif', 'hello')
  assert.deepStrictEqual(payload.image, { url: '/nonexistent-dir/nope.gif' })
  assert.strictEqual(payload.caption, 'hello')
  assert.strictEqual(payload.gifPlayback, undefined)
})

await test('missing URL → text payload', async () => {
  assert.deepStrictEqual(await cardMediaPayload(null, 'hello'), { text: 'hello' })
})

await test('sendCardMedia sends media, falls back to text, null on total failure', async () => {
  const calls = []
  const okSock = { sendMessage: async (jid, payload, opts) => { calls.push({ jid, payload, opts }); return { ok: 1 } } }
  const res = await sendCardMedia(okSock, 'group@g.us', 'https://cdn.example.com/a.jpg', 'cap', { quoted: { id: 'q' } })
  assert.deepStrictEqual(res, { ok: 1 })
  assert.strictEqual(calls.length, 1)
  assert.deepStrictEqual(calls[0].payload.image, { url: 'https://cdn.example.com/a.jpg' })
  assert.deepStrictEqual(calls[0].opts, { quoted: { id: 'q' } })

  // Media send throws → text fallback goes out instead.
  const flakyCalls = []
  const flakySock = {
    sendMessage: async (jid, payload) => {
      flakyCalls.push(payload)
      if (payload.text) return { ok: 'text' }
      throw new Error('media host dead')
    },
  }
  const res2 = await sendCardMedia(flakySock, 'group@g.us', 'https://cdn.example.com/a.jpg', 'claim ABC123')
  assert.deepStrictEqual(res2, { ok: 'text' })
  assert.strictEqual(flakyCalls.length, 2)
  assert.strictEqual(flakyCalls[1].text, 'claim ABC123')

  // Everything throws → null, never a rejection.
  const deadSock = { sendMessage: async () => { throw new Error('down') } }
  assert.strictEqual(await sendCardMedia(deadSock, 'g@g.us', 'https://cdn.example.com/a.jpg', 'x'), null)
})

// ── 3. Stats card render ────────────────────────────────────────────────────

await test('renders a PNG for a full player', async () => {
  const buf = await renderStatsCard(makePlayer())
  assert.ok(Buffer.isBuffer(buf))
  assert.ok(buf.subarray(0, 4).equals(PNG_MAGIC), 'not a PNG')
  assert.ok(buf.length > 20_000, `suspiciously small render: ${buf.length} bytes`)
})

await test('renders for a sparse legacy-shaped player (class/race only)', async () => {
  // Registration guarantees classId/raceId/stats (ensureStatPoints needs them
  // to resolve base stats); everything else is genuinely optional on the card.
  const buf = await renderStatsCard({ name: 'Old', classId: 'warrior', raceId: 'human', stats: {} })
  assert.ok(buf.subarray(0, 4).equals(PNG_MAGIC))
})

await test('renders with a The End aura line (taller card, no tofu input)', async () => {
  const plain = await renderStatsCard(makePlayer())
  const withEnd = await renderStatsCard(makePlayer(), {
    endLine: "⚠️ _Weakened by the End's aura (−40%). Equip a Blue Band._",
  })
  assert.ok(withEnd.subarray(0, 4).equals(PNG_MAGIC))
  assert.ok(withEnd.length !== plain.length, 'expected the end strip to change the render')
})

await test('sanitizeCanvasLine strips emoji + markdown, keeps the numbers', () => {
  const out = sanitizeCanvasLine("⚠️ _Weakened by the End's aura (−40%). Equip a Blue Band._")
  assert.ok(!/[*_]/.test(out), `markdown leaked: ${out}`)
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(out), `emoji leaked: ${out}`)
  assert.ok(out.includes('40'), `lost the number: ${out}`)
  assert.ok(out.length <= 90)
})

// ── 4. .stats plugin wiring ─────────────────────────────────────────────────

function fakeStatsCtx(player, args = []) {
  const calls = { images: [], texts: [] }
  return {
    ctx: {
      args,
      player,
      db: { data: {} },
      from: player.id,
      reply: async (text) => { calls.texts.push(String(text)); return true },
      replyImage: async (image, caption) => { calls.images.push({ image, caption: String(caption) }); return true },
    },
    calls,
  }
}

await test('bare .stats sends the sheet image with a summary caption', async () => {
  const { ctx, calls } = fakeStatsCtx(makePlayer())
  await statsPlugin.run(ctx)
  assert.strictEqual(calls.images.length, 1, `expected 1 image, got ${calls.images.length} (texts: ${calls.texts.length})`)
  const { image, caption } = calls.images[0]
  assert.ok(Buffer.isBuffer(image) && image.subarray(0, 4).equals(PNG_MAGIC))
  assert.ok(caption.includes('TestHero'))
  assert.ok(caption.includes('Unallocated'))
})

await test('.stats add still answers in text (no image)', async () => {
  const player = makePlayer()
  // updatePlayer needs the real repo queue — emulate the shape it touches.
  const { ctx, calls } = fakeStatsCtx(player, ['add', 'str', '1'])
  ctx.db = {
    data: { users: { [player.id]: player } },
    read: async () => {},
    write: async () => {},
  }
  // lib/player-repo's updatePlayer re-reads via db.read — our fake above
  // covers it; the real function only needs data.users + write.
  const { updatePlayer } = await import('../lib/player-repo.js')
  void updatePlayer
  await statsPlugin.run(ctx)
  assert.strictEqual(calls.images.length, 0)
  assert.ok(calls.texts.length >= 1)
  assert.ok(/Added|only have/i.test(calls.texts.join('\n')))
})

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f.name}: ${f.err.message}`)
  process.exit(1)
}
