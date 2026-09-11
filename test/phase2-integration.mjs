/**
 * phase2-integration.mjs — proves the per-player atomic write path against a
 * REAL MongoDB, the way three VPS would hit it. Two independent adapter
 * instances (two "nodes", two connections) hammer the SAME player with N
 * increments each; if the compare-and-swap works, the final value is exactly
 * 2N with not one lost update.
 *
 * Safety:
 *   - Runs ONLY against a throwaway database name (phase2_test_<ts>), NEVER the
 *     live one, and drops it at the end.
 *   - Never prints MONGO_URI or anything derived from it.
 *   - Skips cleanly (exit 0) if MONGO_URI is not configured.
 *
 * Run:  node test/phase2-integration.mjs
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config.js'
import { ReplicatedJSONFile } from '../lib/mongo-adapter.js'

const uri = config.mongoUri
if (!uri) {
  console.log('SKIP: MONGO_URI is not configured — integration test needs a live cluster.')
  process.exit(0)
}

const DB_NAME = `phase2_test_${Date.now()}`
const N = 30                       // increments per node
const PLAYER = 'race@s.whatsapp.net'
const noop = () => {}

function makeNode(tag) {
  return new ReplicatedJSONFile({
    uri,
    dbName: DB_NAME,
    localPath: join(tmpdir(), `phase2-${tag}-${Date.now()}.json`), // never written
    allowSecondWriter: true,       // cluster mode: every node may write
    readOnly: false,
    log: noop,
    warn: noop,
  })
}

/** One node doing n atomic increments, retrying on every CAS conflict. */
async function increment(node, id, n, counters) {
  for (let i = 0; i < n; i++) {
    for (;;) {
      const { json, rev } = await node.readPlayer(id)
      const cur = json ?? { id, solars: 0 }
      const res = await node.writePlayerAtomic(id, { ...cur, solars: (cur.solars ?? 0) + 1 }, rev)
      if (res.ok) break
      counters.conflicts++
    }
  }
}

let failed = false
const fail = (msg) => { failed = true; console.log(`FAIL  ${msg}`) }
const ok = (msg) => console.log(`  ok  ${msg}`)

const nodeA = makeNode('a')
const nodeB = makeNode('b')

try {
  console.log(`phase2 integration test (throwaway db: ${DB_NAME})\n`)

  // Seed the contested player at rev 0 → 1, solars 0.
  const seed = await nodeA.writePlayerAtomic(PLAYER, { id: PLAYER, solars: 0 }, 0)
  if (!seed.ok) throw new Error('failed to seed the test player')

  // ── The proof: two nodes, same player, concurrent increments ────────────
  const counters = { conflicts: 0 }
  await Promise.all([
    increment(nodeA, PLAYER, N, counters),
    increment(nodeB, PLAYER, N, counters),
  ])

  const { json: final } = await nodeA.readPlayer(PLAYER)
  if (final?.solars === 2 * N) ok(`same-player race: final solars == ${2 * N} (no lost updates, ${counters.conflicts} conflicts retried)`)
  else fail(`same-player race: expected ${2 * N}, got ${final?.solars} — an update was LOST`)

  if (counters.conflicts > 0) ok(`CAS actually contended (${counters.conflicts} conflicts), so the guarantee was exercised`)
  else console.log(`  --  note: 0 conflicts this run (nodes did not overlap); correctness still held`)

  // ── Different players from different nodes must not clobber each other ───
  await Promise.all([
    (async () => { const { rev } = await nodeA.readPlayer('pa'); await nodeA.writePlayerAtomic('pa', { id: 'pa', solars: 111 }, rev) })(),
    (async () => { const { rev } = await nodeB.readPlayer('pb'); await nodeB.writePlayerAtomic('pb', { id: 'pb', solars: 222 }, rev) })(),
  ])
  const pa = (await nodeA.readPlayer('pa')).json
  const pb = (await nodeB.readPlayer('pb')).json
  if (pa?.solars === 111 && pb?.solars === 222) ok('different-player writes from two nodes: neither clobbered')
  else fail(`different-player writes: pa=${pa?.solars} (want 111), pb=${pb?.solars} (want 222)`)

  // ── A stale rev must be refused (the core CAS guarantee) ────────────────
  const staleRev = (await nodeA.readPlayer(PLAYER)).rev - 1
  const refused = await nodeA.writePlayerAtomic(PLAYER, { id: PLAYER, solars: 999999 }, staleRev)
  if (refused.conflict) ok('a write at a stale rev is refused (conflict), not applied')
  else fail('a stale-rev write was accepted — CAS is not guarding')
} catch (err) {
  fail(`threw: ${err.message}`)
} finally {
  // Drop the throwaway database and close everything. Never logs the uri.
  try {
    const { MongoClient } = await import('mongodb')
    const client = new MongoClient(uri)
    await client.connect()
    await client.db(DB_NAME).dropDatabase()
    await client.close()
    console.log(`\ncleaned up: dropped ${DB_NAME}`)
  } catch (err) {
    console.log(`\n⚠️ could not drop ${DB_NAME} (${err.message}) — remove it manually`)
  }
  try { await nodeA.close() } catch {}
  try { await nodeB.close() } catch {}
}

process.exit(failed ? 1 : 0)
