/**
 * phase2-cluster.test.mjs — unit tests for the multi-VPS per-player atomic
 * write path (Phase 2). No MongoDB required: the adapter is mocked with a
 * faithful in-memory compare-and-swap, so these run anywhere, every time.
 *
 * Run:  node test/phase2-cluster.test.mjs
 *
 * What it proves:
 *   - clusterUpdatePlayer reads FRESH (ignores stale local RAM), re-applies the
 *     mutator on conflict, and never loses an update (the +1/+50 race → 151).
 *   - exhaustion resolves loudly instead of rejecting or hanging.
 *   - a missing player is a hard error, same as the single-writer path.
 *   - flag OFF is byte-for-byte the old path: the adapter is never consulted.
 *   - buildOps (the bulk backup path) still never writes `rev`, so a
 *     single-VPS deploy never grows the field.
 */

import assert from 'node:assert/strict'
import { config } from '../config.js'
import { updatePlayer, createPlayer, savePlayer, refreshPlayerFromCluster } from '../lib/player-repo.js'
import { buildOps } from '../lib/mongo-adapter.js'

// ── tiny runner (explicit exit so pino's transport worker can't hang us) ────
let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (err) { failures.push({ name, err }); console.log(`FAIL  ${name}\n      ${err.message}`) }
}

/** A mock adapter with a real CAS: store is id -> { obj, rev }. */
function makeMockAdapter(initial = {}) {
  const store = new Map()
  for (const [id, obj] of Object.entries(initial)) store.set(id, { obj, rev: 1 })
  const calls = { read: 0, write: 0, conflicts: 0 }
  const clone = (o) => JSON.parse(JSON.stringify(o))
  const adapter = {
    store, calls,
    async readPlayer(id) {
      calls.read++
      const e = store.get(id)
      return e ? { json: clone(e.obj), rev: e.rev } : { json: null, rev: 0 }
    },
    async writePlayerAtomic(id, obj, expectedRev) {
      calls.write++
      const cur = store.get(id)?.rev ?? 0
      if (cur !== expectedRev) { calls.conflicts++; return { conflict: true } }
      const rev = expectedRev + 1
      store.set(id, { obj: clone(obj), rev })
      return { ok: true, rev }
    },
  }
  return adapter
}

function makeDb(adapter, users = {}) {
  return {
    data: { users },
    adapter,
    writeCalls: 0,
    async write() { this.writeCalls++ },
  }
}

console.log('phase2 cluster unit tests\n')

// ─────────────────────────────────────────────────────────────────────────
await test('happy path: reads fresh, mutates, CAS-writes, refreshes RAM', async () => {
  config.clusterMode = true
  try {
    const adapter = makeMockAdapter({ u1: { id: 'u1', solars: 100 } })
    // Deliberately STALE local RAM: 999. The fresh Mongo value is 100.
    const db = makeDb(adapter, { u1: { id: 'u1', solars: 999 } })

    const result = await updatePlayer(db, 'u1', (p) => { p.solars += 50 })

    assert.equal(result.solars, 150, 'mutator ran on the FRESH 100, not the stale 999')
    assert.equal(adapter.store.get('u1').rev, 2, 'rev bumped once')
    assert.equal(adapter.store.get('u1').obj.solars, 150, 'cluster holds the new value')
    assert.equal(db.data.users.u1.solars, 150, 'local RAM refreshed to committed value')
    assert.equal(adapter.calls.read, 1)
    assert.equal(adapter.calls.write, 1)
    assert.equal(adapter.calls.conflicts, 0)
    assert.equal(db.writeCalls, 0, 'cluster mode never calls the whole-object db.write()')
  } finally { config.clusterMode = false }
})

// ─────────────────────────────────────────────────────────────────────────
await test('conflict then retry: no lost update (+1 and +50 both land → 151)', async () => {
  config.clusterMode = true
  try {
    const adapter = makeMockAdapter({ u1: { id: 'u1', solars: 100 } })
    const db = makeDb(adapter, {})

    // Simulate another node committing +1 right before our first write lands.
    let raced = false
    const realWrite = adapter.writePlayerAtomic.bind(adapter)
    adapter.writePlayerAtomic = async (id, obj, rev) => {
      if (!raced) {
        raced = true
        const e = adapter.store.get(id)
        adapter.store.set(id, { obj: { ...e.obj, solars: e.obj.solars + 1 }, rev: e.rev + 1 })
      }
      return realWrite(id, obj, rev)
    }

    const result = await updatePlayer(db, 'u1', (p) => { p.solars += 50 })

    assert.equal(result.solars, 151, 'retry re-applied +50 to the raced 101, not the stale 100')
    assert.equal(adapter.store.get('u1').obj.solars, 151)
    assert.equal(adapter.store.get('u1').rev, 3, 'rev 1 → raced 2 → ours 3')
    assert.equal(adapter.calls.conflicts, 1)
    assert.equal(adapter.calls.read, 2, 're-read on conflict')
  } finally { config.clusterMode = false }
})

// ─────────────────────────────────────────────────────────────────────────
await test('exhaustion: resolves with last write and logs, never rejects/hangs', async () => {
  config.clusterMode = true
  const origErr = process.stderr.write.bind(process.stderr)
  let logged = ''
  process.stderr.write = (s) => { logged += s; return true }
  try {
    const adapter = makeMockAdapter({ u1: { id: 'u1', solars: 100 } })
    const db = makeDb(adapter, {})
    // Every write conflicts: a competing node bumps rev on each attempt.
    const realWrite = adapter.writePlayerAtomic.bind(adapter)
    adapter.writePlayerAtomic = async (id, obj, rev) => {
      const e = adapter.store.get(id)
      adapter.store.set(id, { obj: e.obj, rev: e.rev + 1 })
      return realWrite(id, obj, rev)
    }

    const result = await updatePlayer(db, 'u1', (p) => { p.solars += 1 })
    assert.ok(result, 'still resolves')
    assert.equal(adapter.calls.write, 20, 'CLUSTER_CAS_MAX_ATTEMPTS attempts')
    assert.match(logged, /gave up after 20 CAS attempts/, 'logged loudly')
  } finally {
    process.stderr.write = origErr
    config.clusterMode = false
  }
})

// ─────────────────────────────────────────────────────────────────────────
await test('missing player rejects, same as single-writer path', async () => {
  config.clusterMode = true
  try {
    const adapter = makeMockAdapter({}) // empty store
    const db = makeDb(adapter, {})
    await assert.rejects(
      () => updatePlayer(db, 'ghost', (p) => { p.solars += 1 }),
      /no player found for id ghost/,
    )
  } finally { config.clusterMode = false }
})

// ─────────────────────────────────────────────────────────────────────────
await test('flag OFF: adapter is never consulted, whole-object write() is used', async () => {
  config.clusterMode = false
  const adapter = {
    readPlayer: async () => { throw new Error('readPlayer must NOT be called when flag off') },
    writePlayerAtomic: async () => { throw new Error('writePlayerAtomic must NOT be called when flag off') },
  }
  const db = makeDb(adapter, { u1: { id: 'u1', solars: 100 } })

  const result = await updatePlayer(db, 'u1', (p) => { p.solars += 50 })
  assert.equal(result.solars, 150)
  assert.equal(db.data.users.u1.solars, 150)
  // The single-writer path debounces the flush ~150ms; give it room, then confirm.
  await new Promise((r) => setTimeout(r, 250))
  assert.ok(db.writeCalls >= 1, 'whole-object db.write() ran (the old path)')
})

// ─────────────────────────────────────────────────────────────────────────
await test('createPlayer (cluster) upserts atomically at rev 0 → 1', async () => {
  config.clusterMode = true
  try {
    const adapter = makeMockAdapter({})
    const db = makeDb(adapter, {})
    await createPlayer(db, 'newbie', { id: 'newbie', solars: 0 })
    assert.equal(adapter.store.get('newbie').rev, 1)
    assert.equal(adapter.calls.write, 1)
    assert.equal(db.writeCalls, 0, 'no whole-object flush in cluster mode')
  } finally { config.clusterMode = false }
})

// ─────────────────────────────────────────────────────────────────────────
await test('savePlayer (cluster) reads current rev then atomic-writes', async () => {
  config.clusterMode = true
  try {
    const adapter = makeMockAdapter({ u1: { id: 'u1', solars: 100 } })
    const db = makeDb(adapter, {})
    await savePlayer(db, { id: 'u1', solars: 200 })
    assert.equal(adapter.store.get('u1').obj.solars, 200)
    assert.equal(adapter.store.get('u1').rev, 2)
    assert.equal(adapter.calls.read, 1)
    assert.equal(adapter.calls.write, 1)
  } finally { config.clusterMode = false }
})

// ─────────────────────────────────────────────────────────────────────────
await test('buildOps never writes rev (single-VPS deploy never grows the field)', async () => {
  const { userOps, metaOps } = buildOps(new Map(), {
    users: { u1: { id: 'u1', solars: 1 } },
    market: { listings: [] },
  })
  assert.equal(userOps.length, 1)
  assert.equal(metaOps.length, 1)
  const userSet = userOps[0].updateOne.update.$set
  const metaSet = metaOps[0].updateOne.update.$set
  assert.deepEqual(Object.keys(userSet).sort(), ['fp', 'json', 'updatedAt'])
  assert.ok(!('rev' in userSet), 'bulk path must not set rev on a user doc')
  assert.ok(!('rev' in metaSet), 'bulk path must not set rev on a meta doc')
})

// ─────────────────────────────────────────────────────────────────────────
await test('read-half (cluster): refresh pulls another node\'s commit into RAM', async () => {
  config.clusterMode = true
  try {
    // The cluster holds 150; this node's RAM is a stale 100 (another VPS wrote).
    const adapter = makeMockAdapter({ u1: { id: 'u1', solars: 150 } })
    const db = makeDb(adapter, { u1: { id: 'u1', solars: 100 } })

    const fresh = await refreshPlayerFromCluster(db, 'u1')

    assert.equal(fresh.solars, 150, 'returns the committed cluster value')
    assert.equal(db.data.users.u1.solars, 150, 'RAM refreshed in place for read-only commands')
    assert.equal(adapter.calls.read, 1)
    assert.equal(adapter.calls.write, 0, 'a pure read never writes')
  } finally { config.clusterMode = false }
})

// ─────────────────────────────────────────────────────────────────────────
await test('read-half: a missing cluster doc never wipes an in-memory record', async () => {
  config.clusterMode = true
  try {
    const adapter = makeMockAdapter({}) // cluster has nobody
    // e.g. a brand-new player mid-registration, or an unregistered sender.
    const db = makeDb(adapter, { u1: { id: 'u1', solars: 5 } })

    const result = await refreshPlayerFromCluster(db, 'u1')

    assert.equal(result.solars, 5, 'RAM copy is left intact')
    assert.equal(db.data.users.u1.solars, 5)
  } finally { config.clusterMode = false }
})

// ─────────────────────────────────────────────────────────────────────────
await test('read-half: a cluster read error is swallowed, RAM left as-is', async () => {
  config.clusterMode = true
  const origErr = process.stderr.write.bind(process.stderr)
  let logged = ''
  process.stderr.write = (s) => { logged += s; return true }
  try {
    const adapter = makeMockAdapter({ u1: { id: 'u1', solars: 100 } })
    adapter.readPlayer = async () => { throw new Error('cluster down') }
    const db = makeDb(adapter, { u1: { id: 'u1', solars: 99 } })

    const result = await refreshPlayerFromCluster(db, 'u1')

    assert.equal(result.solars, 99, 'handler still gets the last-known RAM copy')
    assert.match(logged, /refreshPlayerFromCluster\(u1\)/, 'logged the hiccup')
  } finally {
    process.stderr.write = origErr
    config.clusterMode = false
  }
})

// ─────────────────────────────────────────────────────────────────────────
await test('read-half (flag OFF): adapter is never consulted', async () => {
  config.clusterMode = false
  const adapter = {
    readPlayer: async () => { throw new Error('readPlayer must NOT be called when flag off') },
  }
  const db = makeDb(adapter, { u1: { id: 'u1', solars: 7 } })

  const result = await refreshPlayerFromCluster(db, 'u1')
  assert.equal(result.solars, 7, 'returns the plain RAM copy with no cluster read')
})

// ── summary ─────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
