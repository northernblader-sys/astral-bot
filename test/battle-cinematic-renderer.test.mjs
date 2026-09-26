/** Exercise the actual renderer entry used by plugins/pvp.js, not a stand-in. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { sendBattleTurnReply, renderBattleFrameStill } from '../lib/battle-frame-render.mjs'
import { ART } from '../lib/witch-heroes.js'
import { withBattleCinematic, isBattleCinematicActive } from '../lib/battle-presentation.js'
import pvp, { pvpCinderVerdict } from '../plugins/pvp.js'

function setup() {
  const calls = [], a = { name: 'Maiden', inBattle: true, hp: 400, maxHp: 900, level: 1, classId: 'samurai', battleState: { type: 'pvp', opponentJid: 'b', myTurn: true } }
  const b = { ...a, name: 'Ronova', battleState: { type: 'pvp', opponentJid: 'a', myTurn: false } }
  const db = { data: { users: { a, b } }, write: async () => {} }
  const ctx = { db, from: 'a', player: a, sender: 'group', args: ['status'],
    reply: async text => { calls.push(['text', text]); return { key: { id: 'one' } } },
    replyImage: async (image, text) => calls.push(['image', image, text]),
    editReply: async (sent, text) => calls.push(['edit', sent.key.id, text]),
  }
  return { ctx, calls, opts: { player: a, e: b, isPvp: true, msg: 'GENERIC TURN FOOTER — .pvp attack', lastAction: null } }
}

test('actual PvP renderer chooses clash INSTEAD OF its generic card and footer', async () => {
  const { ctx, calls, opts } = setup()
  const result = await sendBattleTurnReply(ctx, { ...opts,
    cinematic: { type: 'endworld-clash', finalText: 'MAIDEN WINS', participants: ['a', 'b'] },
  })
  assert.deepEqual(result, { cinematic: true })
  assert.deepEqual(calls.map(c => c[0]), ['image', 'image', 'text', 'edit', 'edit'])
  assert.equal(calls[0][1], ART.vortex)
  assert.equal(calls[1][1], ART.invisibleSword)
  assert.equal(calls.at(-1)[2], 'MAIDEN WINS')
  assert.equal(JSON.stringify(calls).includes('GENERIC TURN FOOTER'), false)
  assert.equal(calls.filter(c => c[0] === 'text').length, 1)
  assert.equal(calls[3][1], calls[4][1])
  assert.deepEqual(await sendBattleTurnReply(ctx, opts), { suppressed: true })
  assert.equal(calls.length, 5)
})

test('real PvP status and signature-action entry points cannot interrupt an active scene', async () => {
  const { ctx, calls, opts } = setup()
  const before = JSON.stringify(ctx.db.data)
  await withBattleCinematic(ctx, async () => {
    const other = { ...ctx, from: 'b', player: opts.e }
    assert.equal(isBattleCinematicActive(other), true)
    await pvp.run(other)
    await pvpCinderVerdict(other)
    await sendBattleTurnReply(other, { ...opts, player: opts.e, e: opts.player })
    assert.equal(calls.length, 0)
    assert.equal(JSON.stringify(ctx.db.data), before)
    // Outcome settlement may clear battle state before the closing animation.
    // The explicit participant lock must still win over "not in a duel" copy.
    opts.player.inBattle = opts.e.inBattle = false
    opts.player.battleState = opts.e.battleState = null
    const settled = JSON.stringify(ctx.db.data)
    await pvp.run(other)
    await pvpCinderVerdict(other)
    assert.equal(calls.length, 0)
    assert.equal(JSON.stringify(ctx.db.data), settled)
  })
})

test('Coordinate uses three ordered text strikes, one final art, no generic PvP footer', async () => {
  const { ctx, calls, opts } = setup()
  await sendBattleTurnReply(ctx, { ...opts, cinematic: {
    type: 'coordinate', finalText: 'ONE BATTLE RESULT', strikes: [{ damage: 900, revived: true }, { damage: 400, revived: true }, { damage: 200 }],
  } })
  assert.deepEqual(calls.map(c => c[0]), ['text', 'text', 'text', 'image'])
  assert.equal(calls.at(-1)[1], ART.coordinate)
  assert.equal(calls.at(-1)[2], 'ONE BATTLE RESULT')
  assert.equal(JSON.stringify(calls).includes('GENERIC TURN FOOTER'), false)
})

test('ordinary PvP turns still render their normal card', async () => {
  const { ctx, calls, opts } = setup()
  await sendBattleTurnReply(ctx, opts)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].at(-1), opts.msg)
  assert.ok(Buffer.isBuffer(calls[0][1]))
})

test('malformed cinematic is rejected before sending any messages or acquiring a lock', async () => {
  for (const cinematic of [{ type: 'missing', finalText: 'x' }, { type: 'endworld-clash' }, { type: 'coordinate', finalText: 'x', strikes: [{ damage: NaN }] }]) {
    const { ctx, calls, opts } = setup()
    await assert.rejects(sendBattleTurnReply(ctx, { ...opts, cinematic }))
    assert.equal(calls.length, 0)
    assert.equal(isBattleCinematicActive(ctx), false)
  }
})

function solid(color) {
  const c = createCanvas(480, 270), g = c.getContext('2d')
  g.fillStyle = color; g.fillRect(0, 0, 480, 270)
  return c.toBuffer('image/png')
}
async function corner(buffer) {
  const c = createCanvas(480, 270), g = c.getContext('2d')
  g.drawImage(await loadImage(buffer), 0, 0)
  return [...g.getImageData(0, 100, 1, 1).data]
}
const renderState = { scene: 'pvp', lastAction: null,
  left: { name: 'Maiden', hp: 100, maxHp: 100, classId: 'samurai' },
  right: { name: 'Ronova', hp: 100, maxHp: 100, classId: 'mage', isPlayer: true } }

test('actual rendered pixels change to each approved Endworld background', async () => {
  const original = globalThis.fetch, urls = []
  globalThis.fetch = async (url, opts) => {
    urls.push(url); assert.ok(opts.signal)
    assert.ok([ART.endworld1, ART.endworld2].includes(url))
    return { ok: true, arrayBuffer: async () => solid(url === ART.endworld1 ? '#ff0000' : '#0000ff') }
  }
  try {
    const first = await renderBattleFrameStill({ ...renderState, cinematicBackground: ART.endworld1 })
    const second = await renderBattleFrameStill({ ...renderState, cinematicBackground: ART.endworld2 })
    assert.deepEqual(await corner(first), [255, 0, 0, 255])
    assert.deepEqual(await corner(second), [0, 0, 255, 255])
    assert.deepEqual(urls, [ART.endworld1, ART.endworld2])
  } finally { globalThis.fetch = original }
})

test('arbitrary background URLs cannot turn the renderer into a remote fetch proxy', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network access') }
  try {
    assert.ok(await renderBattleFrameStill({ ...renderState, cinematicBackground: 'http://127.0.0.1/private' }))
    assert.equal(calls, 0)
  } finally { globalThis.fetch = original }
})


test('an unavailable cinematic background falls back to the normal arena, never a lost turn', async () => {
  // Independent module instance so the success test's cached art cannot mask
  // the failure. Local sprite assets remain the real production assets.
  const { renderBattleFrameStill: freshRender } = await import('../lib/battle-frame-render.mjs?art-failure')
  const original = globalThis.fetch
  let failed = false
  globalThis.fetch = async url => { assert.equal(url, ART.endworld1); failed = true; throw new Error('art host offline') }
  try {
    const frame = await freshRender({ ...renderState, cinematicBackground: ART.endworld1 })
    assert.equal(failed, true)
    assert.ok(Buffer.isBuffer(frame))
    assert.ok(frame.length > 100)
  } finally { globalThis.fetch = original }
})

test('a generic turn already rendering when the scene starts is dropped after its await', async () => {
  const { sendBattleTurnReply: freshSend } = await import('../lib/battle-frame-render.mjs?slow-render')
  const original = globalThis.fetch, { ctx, calls, opts } = setup()
  let releaseFetch, arrived
  const started = new Promise(resolve => { arrived = resolve })
  const held = new Promise(resolve => { releaseFetch = resolve })
  globalThis.fetch = async url => {
    assert.equal(url, ART.endworld1)
    arrived()
    await held
    return { ok: true, arrayBuffer: async () => solid('#ff0000') }
  }
  try {
    opts.player.battleState.cinematicBackground = ART.endworld1
    const pendingCard = freshSend(ctx, opts)
    await started
    // Another command context, same duel. Scene finishes before the slow
    // render does; the generation ticket must still invalidate that card.
    await withBattleCinematic({ ...ctx }, async () => {})
    releaseFetch()
    assert.deepEqual(await pendingCard, { suppressed: true })
    assert.equal(calls.length, 0)
  } finally { releaseFetch?.(); globalThis.fetch = original }
})
