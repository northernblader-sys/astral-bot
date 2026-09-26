/**
 * test/card-stats-update.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Suite for the 2026-09-22 card + stats drop:
 *
 *  1. TIER REPRICE (lib/card-engine.js) — S sells for 50k (owner-scaled
 *     from the same morning's 150k), tier 6 for 43k, stepping down; buy
 *     price stays above sell price on EVERY tier so buy-then-sell can
 *     never mint Solars; unknown tiers still fall back to tier 1 instead
 *     of NaN/undefined; hasCardSeries hides the 'Unknown' placeholder.
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
 *     tofu. The radar chart itself (2026-09-23 redesign: spider chart with a
 *     stat + letter grade at each vertex, fill bulging toward the strong
 *     stats) is tested via computeRadar/gradeFor — geometry, tidy ring scale,
 *     peak pinned at the rim, and the all-zero degenerate case.
 *  4. .stats PLUGIN WIRING (plugins/stats.js) — bare .stats sends the image
 *     with a summary caption; the add/train subcommands still answer in text.
 *
 * Run:  node test/card-stats-update.test.mjs
 */
import assert from 'node:assert/strict'

import {
  cardSellPrice, cardBuyPrice, tierStars, tierRank, hasCardSeries,
} from '../lib/card-engine.js'
import { isGifUrl, isDirectVideoUrl, cardMediaPayload, sendCardMedia } from '../lib/card-media.js'
import { renderStatsCard, sanitizeCanvasLine, computeRadar, gradeFor } from '../lib/stats-card-render.mjs'
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

await test('sell ladder: S=50k, 6=43k, strictly increasing by tier rank', () => {
  assert.strictEqual(cardSellPrice('S'), 50000)
  assert.strictEqual(cardSellPrice(6), 43000)
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

await test("hasCardSeries hides the 'Unknown' placeholder (no 📺 Unknown)", () => {
  assert.strictEqual(hasCardSeries('Unknown'), false)
  assert.strictEqual(hasCardSeries('unknown'), false)
  assert.strictEqual(hasCardSeries(' UNKNOWN '), false)
  assert.strictEqual(hasCardSeries(''), false)
  assert.strictEqual(hasCardSeries(null), false)
  assert.strictEqual(hasCardSeries(undefined), false)
  assert.strictEqual(hasCardSeries('Naruto'), true)
  assert.strictEqual(hasCardSeries(' Cowboy Bebop '), true)
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

// ── 3b. Radar geometry + letter grades ─────────────────────────────────────
// The redesign draws a spider chart: one axis per stat, a letter grade at
// each vertex, and a fill polygon that bulges toward the strong stats. The
// math lives in computeRadar() so it is tested here, independent of the
// pixel pass.

await test('radar: tidy ring scale, peak pinned at the rim as an S', () => {
  const radar = computeRadar({ str: 120, agi: 95, int: 60, def: 110, lck: 40 }, { cx: 100, cy: 100, R: 168 })
  assert.strictEqual(radar.points.length, 5)
  // 120/4 = 30 is already tidy → step 30, rim 120. Peak fills the whole rim.
  assert.strictEqual(radar.step, 30)
  assert.strictEqual(radar.ref, 120)
  assert.strictEqual(radar.rings, 4)
  assert.strictEqual(radar.peak.key, 'str')
  assert.strictEqual(radar.peak.value, 120)

  const str = radar.points[0]
  assert.strictEqual(str.label, 'STR')
  assert.ok(Math.abs(str.frac - 1) < 1e-9, `peak frac ${str.frac} should sit at the rim`)
  assert.strictEqual(str.grade, 'S')
  // The top vertex points straight up from the centre.
  assert.ok(Math.abs(str.x - 100) < 1e-6, `STR x ${str.x} off the top axis`)
  assert.ok(Math.abs(str.y - (100 - 168)) < 1e-6, `STR y ${str.y} not at the rim`)
  assert.strictEqual(str.labelSide, 'top')

  // Every axis resolves to a finite point and a known label side.
  for (const p of radar.points) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.r), 'non-finite geometry')
    assert.ok(['top', 'left', 'right'].includes(p.labelSide), `bad side ${p.labelSide}`)
  }
  const sides = radar.points.map((p) => p.labelSide)
  assert.deepStrictEqual(sides, ['top', 'right', 'right', 'left', 'left'])
})

await test('radar: lopsided build spikes one axis and reads as a thin spread', () => {
  const radar = computeRadar({ str: 410, agi: 74, int: 12, def: 96, lck: 55 }, { R: 168 })
  // 410/4 = 102.5 → step rounds up to 120, rim 480 (overshoot < 25%).
  assert.strictEqual(radar.ref, 480)
  assert.strictEqual(radar.peak.key, 'str')
  // The one big stat still grades S; the near-empty ones fall to D/E.
  assert.strictEqual(radar.points[0].grade, 'S')
  assert.strictEqual(radar.points[2].grade, 'E') // int 12
  assert.ok(radar.points[2].r < radar.points[0].r * 0.1, 'weakest axis should hug the centre')
  // Density (mean / rim) is the OVERALL RATING driver — a one-stat dump is thin.
  assert.ok(radar.density < 0.4, `density ${radar.density} should read thin`)
  assert.strictEqual(radar.total, 647)
})

await test('radar: empty stats → every axis E, finite geometry, no NaN', () => {
  const radar = computeRadar({}, { cx: 0, cy: 0, R: 168 })
  assert.strictEqual(radar.empty, true)
  assert.strictEqual(radar.total, 0)
  assert.strictEqual(radar.density, 0)
  for (const p of radar.points) {
    assert.strictEqual(p.value, 0)
    assert.strictEqual(p.grade, 'E')
    // r = 0 → every vertex collapses to the centre, never NaN.
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
    assert.strictEqual(p.x, 0)
    assert.strictEqual(p.y, 0)
  }
  // A zero player still gets a sane scale (rim 4) so the rings can draw.
  assert.ok(radar.ref >= radar.rings, `degenerate ref ${radar.ref}`)
})

await test('gradeFor: S/A/B/C/D/E thresholds land on the right letter', () => {
  assert.strictEqual(gradeFor(1).grade, 'S')
  assert.strictEqual(gradeFor(0.74).grade, 'S')   // S floor
  assert.strictEqual(gradeFor(0.739).grade, 'A')  // just below the peak
  assert.strictEqual(gradeFor(0.58).grade, 'A')
  assert.strictEqual(gradeFor(0.44).grade, 'B')
  assert.strictEqual(gradeFor(0.30).grade, 'C')
  assert.strictEqual(gradeFor(0.15).grade, 'D')
  assert.strictEqual(gradeFor(0).grade, 'E')
  // Out-of-range input clamps instead of throwing.
  assert.strictEqual(gradeFor(-5).grade, 'E')
  assert.strictEqual(gradeFor(NaN).grade, 'E')
  assert.strictEqual(gradeFor(Infinity).grade, 'S')
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
