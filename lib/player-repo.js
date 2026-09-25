/**
 * player-repo.js — the single source of truth for db.data.users access.
 * No plugin or other module should read/write db.data.users directly.
 *
 * Expected player schema (built by plugins/register.js via getTotalStats):
 * {
 *   id:          string,          // ctx.from (WhatsApp JID)
 *   name:        string,
 *   classId:     string,          // key from data/classes.json
 *   raceId:      string,          // key from data/races.json
 *   title:       string|null,
 *   bio:         string|null,     // short profile blurb, max 9 words — set via .setbio
 *   pfp:         string|null,     // local file path under media/pfp/ — set via .setpfp
 *   level:       number,
 *   xp:          number,
 *   hp:          number,
 *   maxHp:       number,
 *   mp:          number,
 *   maxMp:       number,
 *   stats:       { str, agi, int, def, lck },
 *   statPoints:  {
 *     version, earned, spent, unallocated,
 *     allocations: { str, agi, int, def, lck },
 *   },
 *   wallet:      {
 *     solars, gems, bankGold, loan,
 *     vault:     number,          // safe-storage balance — NOT in data/currency.json,
 *                                 // set directly here since it's deposit/withdraw-only,
 *                                 // never earned/spent directly. Deliberately excluded
 *                                 // from rob.js and pvp.js's money-loss logic — see
 *                                 // plugins/vault.js for the only mutation sites.
 *   },
 *   equipped:    { weapon: null|itemId, helmet: null|itemId, chestplate: null|itemId, boots: null|itemId, relic: null|itemId, pet: null|petId },
 *   inventory:   string[],        // array of item ids
 *   chest:       {                // see plugins/chest.js — safe storage,
 *                                 // NEVER cleared on death (unlike inventory)
 *     unlocked:  boolean,          // false until bought via .chest buy
 *     items:     string[],         // same stacking convention as inventory
 *   },
 *   pets:        string[],        // array of owned petIds (from data/pets.json), adopted at the pet store
 *   beastInventory: Array<{ beastId, obtainedAt }>, // every beast ever obtained (see lib/beast-engine.js)
 *   summonedBeasts: Array<{ beastId, cp, obtainedAt }>, // live roster, max 4 (cap enforced on acquisition)
 *   activeBeast: string|null,     // beastId of the one summonedBeasts entry currently equipped
 *   skills:      string[],        // array of skill ids
 *   abilityInventory:  string[],  // slot machinery kept, but data/abilities.json is empty — nothing to obtain right now
 *   equippedAbilities: string[],  // active subset of abilityInventory, length <= abilitySlots
 *   abilitySlots:      number,    // starts at 1; buy more via .shop buy ability_slot
 *   ownsGemMiner:      boolean,   // see lib/empire-engine.js premiumShopItems / plugins/empire-premium.js
 *   lastGemMineClaim:  number,    // ms epoch of last .empire premium claim; unset until first claim
 *   ownedCharacters: string[],     // character ids bought via .character buy (data/characters.json) — never lost
 *   equippedCharacter: string|null, // the one active character id, or null — set via .character equip
 *   activeEffects: Array<{        // managed by lib/effects.js
 *     type:      string,          // 'heal'|'regen'|'burn'|'poison'|'freeze'|'stun'|'shield'|'weaken'
 *     remaining: number,          // ticks/turns remaining
 *     value:     number,          // magnitude (heal amount, dmg/tick, shield pool, stat delta)
 *     meta:      object|null,     // effect-specific extra data (e.g. { stat: 'str' } for weaken)
 *     sourceId:  string|null,     // itemId or skillId that applied it
 *   }>,
 *   location:    string,          // current locationId (default: 'astral_town')
 *   currentFloor: number,         // floor the player is on within a dungeon (0 = not in dungeon)
 *   dungeonProgress: {            // per-dungeon floor records
 *     [locationId]: {
 *       highestFloor: number,     // deepest floor ever reached
 *       conquered:    boolean,    // true once the final boss is killed
 *     }
 *   },
 *   registeredAt: number,         // Date.now()
 *   premium: {                    // see lib/premium.js
 *     active:              boolean,
 *     plan:                string|null,   // 'weekly'|'monthly'|'yearly'
 *     expiresAt:           number|null,   // epoch ms
 *     grantedAt:           number|null,   // epoch ms of first-ever grant
 *     autoReviveUsedToday: boolean,
 *     autoReviveDate:      number|null,   // startOfDay ms the flag above applies to
 *   },
 *   premiumPending: {              // set by plugins/premium.js's `buy` flow, cleared on confirm/reject
 *     plan:  string,
 *     state: 'awaiting_screenshot'|'pending_confirmation',
 *   } | null,
 *   topupPending: {                // set by plugins/topup.js's `buy` flow, cleared on confirm/reject
 *     packageId: string,
 *     gems:      number,
 *     state:     'awaiting_screenshot'|'pending_confirmation',
 *   } | null,
 *   storyProgress: {               // see lib/story-engine.js, plugins/story.js
 *     volumes: {
 *       [volumeId]: {
 *         currentChapter: number,        // 1-indexed chapter the player is on
 *         currentBeat: number,           // 0-indexed into that chapter's beats array;
 *                                        // 0 means the chapter hasn't been started yet
 *         completed: boolean,            // true once the final chapter's onComplete fired
 *         choices: { [chapterId]: optionId }, // flavor-only picks, never branches the story
 *         lastChapterCompletedAt: number|null, // epoch ms, drives the 24h chapter cooldown
 *         chaptersCompletedInWindow: number,   // count within the current rolling 24h window
 *         seenIntro: boolean,            // whether the appreciation/credits sequence has played
 *       },
 *     },
 *   } | undefined,                 // absent until the player's first `.story enter`
 *   storyFlags: string[]|undefined, // volume-completion perk flags (e.g.
 *                                   // 'free-travel-all-locations'), absent until earned
 *   home: {                       // see lib/housing-engine.js — backfilled by
 *                                 // ensureHome() on accounts that predate it
 *     tier:      string|null,     // housing.json tier id; null until .home claim,
 *                                 // so "has no house" stays representable
 *     rooms:     string[],        // built room ids, no duplicates
 *     decor:     string[],        // placed decor ids, no duplicates
 *     storage:   string[],        // item ids kept at home (flat, like chest.items)
 *     plots: Array<{              // one entry per sown plot; harvest removes it
 *       cropId:    string,
 *       plantedAt: number,        // epoch ms
 *       readyAt:   number,        // epoch ms — baked in at plant time so a
 *                                 // greenhouse built later can't retroactively
 *                                 // speed up a crop already in the ground
 *     }>,
 *     harvest:   { [cropId]: number },  // picked produce, sold via .farm sell
 *     bucket:    { [fishId]: number },  // landed fish, sold via .fish sell
 *     visitors:  string[],        // jids allowed in via .homeinvite
 *     lastRest:  number|null,     // epoch ms of last .home rest
 *     lastFish:  number|null,     // epoch ms of last .fish
 *     lastParty: number|null,     // epoch ms of last .homeparty
 *     founded:   number|null,     // epoch ms of first claim
 *   },
 * }
 */

import { config } from '../config.js'

// ── Cluster mode (Phase 2, multi-VPS) ─────────────────────────────────────
// When CLUSTER_MODE is on AND the backing store can do per-player atomic writes
// (i.e. MongoDB is configured, so db.adapter exposes writePlayerAtomic),
// updatePlayer switches from the single-writer fast path to a read-fresh →
// mutate → compare-and-swap loop, so several VPS pointed at one database can
// write the same player without losing updates. With the flag off, or with no
// Mongo adapter behind it, isClusterMode is false and everything runs exactly
// as it always has. See config.clusterMode for why it stays off in production.
const CLUSTER_CAS_MAX_ATTEMPTS = 20
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** True when player writes must go through the per-player atomic path. */
function isClusterMode(db) {
  return config.clusterMode && typeof db?.adapter?.writePlayerAtomic === 'function'
}

/** Returns the player object for `id`, or null if not found. */
export function getPlayer(db, id) {
  return db.data.users[id] ?? null
}

/**
 * Cluster read-half: pull ONE player fresh from the cluster into this node's
 * RAM, so a read-only command (.profile, .bal) served here sees what another
 * VPS just committed, and a player who registered on a different number becomes
 * visible on this one. This is the whole "reads are eventually consistent, but
 * the acting player is made current on entry" contract — call it once per
 * message for the sender, before getPlayer/ctx.player is taken.
 *
 * Best-effort by design: the write path (clusterUpdatePlayer) re-reads fresh
 * from Mongo under a CAS regardless, so a failed or skipped refresh can never
 * lose data — it only means this one read might show a value a beat stale, the
 * same as any other cache miss. So a Mongo hiccup here must never throw into the
 * message handler; it logs and leaves RAM as-is.
 *
 * A null result (no such document) is left alone rather than deleted from RAM:
 * an unregistered sender legitimately has no cluster doc, and so does a brand
 * new one mid-registration — neither should have their in-memory record wiped.
 *
 * No-op (returns the current RAM copy) unless cluster mode is on and the backing
 * store can do per-player reads, so single-VPS behaviour is untouched.
 */
export async function refreshPlayerFromCluster(db, id) {
  if (!isClusterMode(db) || typeof db.adapter.readPlayer !== 'function') {
    return db.data.users[id] ?? null
  }
  try {
    const { json: fresh } = await db.adapter.readPlayer(id)
    if (fresh != null) db.data.users[id] = fresh
  } catch (err) {
    logWriteFailure(`refreshPlayerFromCluster(${id})`, err)
  }
  return db.data.users[id] ?? null
}

/** Returns true if a player record exists for `id`. */
export function playerExists(db, id) {
  return Object.prototype.hasOwnProperty.call(db.data.users, id)
}

/**
 * findPlayerByName(allUsers, query) — resolve a TYPED player name to a record.
 *
 * Owner tools that target someone by name instead of an @mention
 * (.premium confirm, .giveability, .monds gift, .fame, .season offer) each
 * grew their own copy of this. They disagreed in the details, which is how
 * ".giveability heat_blaze Yochan" ended up unable to find Yochan at all, so
 * this is the one definition.
 *
 * `allUsers` is either the array form (Object.values(db.data.users)) or the
 * users map itself. Matching, in order:
 *   1. exact, ignoring case and every separator (spaces, _, -, '.') so
 *      "yochan_the_great" and "Yochan The Great" are the same player;
 *   2. otherwise the SHORTEST name that contains the query, so a partial
 *      "yochan" lands on Yochan rather than on YochansAltFriend when both
 *      exist, instead of on whichever record happens to come first.
 * Returns null when nothing matches or the query is empty.
 */
export function findPlayerByName(allUsers, query) {
  const list = Array.isArray(allUsers) ? allUsers : Object.values(allUsers ?? {})
  const raw = String(query ?? '').trim()
  if (!raw) return null

  const fold = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const q = fold(raw)
  if (!q) return null

  const exact = list.find((u) => fold(u?.name) === q)
  if (exact) return exact

  const partial = list.filter((u) => fold(u?.name).includes(q))
  if (!partial.length) return null
  return partial.reduce((best, u) => (
    fold(u?.name).length < fold(best?.name).length ? u : best
  ))
}

/**
 * Creates a new player record and persists to disk.
 * Caller is responsible for ensuring the player does not already exist.
 */
export async function createPlayer(db, id, data) {
  db.data.users[id] = data
  if (isClusterMode(db)) {
    // Register straight into the cluster (rev 0 → 1). No whole-object flush:
    // in cluster mode MongoDB is authoritative and the local file is a cache.
    try { await db.adapter.writePlayerAtomic(id, data, 0) }
    catch (err) { logWriteFailure(`createPlayer(${id}) [cluster]`, err) }
    return db.data.users[id]
  }
  await scheduleFlush(db)
  return db.data.users[id]
}

/**
 * Persists an already-mutated player object to disk.
 * The player's `id` field is used as the key.
 */
export async function savePlayer(db, player) {
  db.data.users[player.id] = player
  if (isClusterMode(db)) {
    // Whole-object player save is the read-modify-write pattern updatePlayer
    // exists to avoid, and no plugin uses it (this is kept for completeness).
    // In cluster mode persist it as a best-effort atomic write against the
    // current rev; prefer updatePlayer, which retries on conflict.
    try {
      const { rev } = await db.adapter.readPlayer(player.id)
      await db.adapter.writePlayerAtomic(player.id, player, rev)
    } catch (err) {
      logWriteFailure(`savePlayer(${player.id}) [cluster]`, err)
    }
    return
  }
  await scheduleFlush(db)
}

/**
 * Single global write queue for the whole db, not just per-player.
 *
 * lowdb's db.read() replaces db.data wholesale from disk, and db.write()
 * dumps the whole in-memory db.data back out — there is no per-player
 * write, only whole-file read/write. That means a per-player queue is
 * NOT enough to prevent data loss: any *other* code path that also does
 * its own db.read() ... db.write() cycle directly on the same db object
 * (e.g. a periodic sweep that walks every player) can still start its
 * read while a player's purchase is mid-flight, hold that stale snapshot
 * open for a while, and then write it back out — silently erasing the
 * purchase's changes even though updatePlayer() "completed successfully"
 * moments earlier. This was the root cause of reports like "solars were
 * taken but the item never showed up in my inventory": main.js's premium
 * sweep (runPremiumSweep) read the db, spent time walking group metadata
 * over the network, and its eventual db.write() clobbered any purchase
 * that happened to land in that window.
 *
 * Fix: every read→mutate→write cycle against this db — whether for one
 * player (updatePlayer) or all of them (updateAllPlayers) — is chained
 * onto ONE shared queue, so they always run fully serialized. Baileys
 * fires message events without waiting for the previous handler to
 * finish, so two commands in quick succession (a double-tapped .shop
 * buy, a plugin's updatePlayer racing the sleep-check updatePlayer in
 * handler.js, or a background sweep) can otherwise interleave.
 *
 * ── Why this is no longer ONE queue (2026-09 fix) ─────────────────────────
 *
 * The strict single global queue was correct but far too coarse. ~167 call
 * sites across 33 plugins do `await ctx.reply(...)` from INSIDE their
 * mutatorFn (run scan-mutator-sends.mjs), and every send now goes through
 * lib/send-rate-limiter.js — so an awaited send inside a mutator sits in the
 * send queue for whole seconds by design. With one global queue that meant
 * one player's dungeon reply held the write lock for 5–12s and EVERY other
 * player's command, on both numbers, blocked behind it. Those are the
 * "updatePlayer(...) itself took 11802ms" / "waited 11969ms behind other
 * tasks" warnings.
 *
 * What the queue actually has to guarantee is only this: a whole-db sweep
 * (updateAllPlayers) must never interleave with a single-player mutation,
 * and two mutations of the SAME player must not interleave. It never needed
 * to serialize player A against player B — they touch different keys.
 *
 * So this is now a readers-writer style lock:
 *   - updatePlayer(id)   → runs on a lane private to that id. Different
 *                          players run concurrently; the same player still
 *                          serializes, so double-tapped .shop buy is safe.
 *   - updateAllPlayers() → a barrier. It waits for every in-flight player
 *                          lane, and every player task queued after it waits
 *                          for the sweep. The "solars taken but no item"
 *                          clobbering bug therefore still cannot happen.
 *
 * A slow mutator now only delays that one player, which is what everyone
 * expects anyway.
 */

/** Barrier lane: updateAllPlayers sweeps. Player lanes queue behind it. */
let globalTail = Promise.resolve()

/** id → tail promise for that one player's lane. Deleted when it goes idle. */
const playerTails = new Map()

// Instrumentation for diagnosing "bot online but ignores commands for a
// while then recovers" — reported by plugins/health.js (`.health`). Every
// task that goes through runExclusive (every updatePlayer/updateAllPlayers
// call, from EITHER bot number, since both share this one process/queue) is
// timed. A task taking a long time to even START (queuedFor) means something
// ahead of it in line is slow; a task taking a long time to FINISH
// (ranFor) means that task itself — usually its mutatorFn — is the slow
// one. Both get logged past a threshold so the culprit shows up in logs
// without needing to reproduce it under a debugger.
const SLOW_TASK_WARN_MS = 3_000
export const queueStats = {
  lastTaskLabel: null,
  lastTaskStartedAt: null,   // null when idle
  lastTaskDurationMs: null,
  slowTaskCount: 0,
  currentQueueDepth: 0,
}

/**
 * Runs `task` under the lock for `key`.
 *
 * key = a player id  → that player's private lane (concurrent with others).
 * key = null         → global barrier: waits for every live player lane, and
 *                      blocks every player lane queued after it.
 */
function runExclusive(task, label = 'unlabeled', key = null) {
  queueStats.currentQueueDepth++
  const queuedAt = Date.now()

  let gate
  if (key === null) {
    // Barrier. Everything currently in flight must finish first.
    gate = Promise.allSettled([globalTail, ...playerTails.values()])
  } else {
    // This player's own previous task, plus any sweep already queued.
    gate = Promise.allSettled([globalTail, playerTails.get(key) ?? Promise.resolve()])
  }

  const run = gate.then(() => runTimed(task, label, queuedAt, key))
  const tail = run.catch(() => {}) // a rejection must not poison future chains

  if (key === null) {
    globalTail = tail
  } else {
    playerTails.set(key, tail)
    // Keep the map from growing one entry per player forever: drop the lane
    // once it's idle (only if nothing newer took its place in the meantime).
    tail.then(() => { if (playerTails.get(key) === tail) playerTails.delete(key) })
  }

  return run
}

async function runTimed(task, label, queuedAt, key = null) {
  const queuedFor = Date.now() - queuedAt
  if (queuedFor > SLOW_TASK_WARN_MS) {
    process.stderr.write(
      `[${new Date().toISOString()}] ⚠️ player-repo queue: "${label}" waited ${queuedFor}ms ` +
      (key === null
        ? `for every player lane to drain before the sweep could start.\n`
        : `behind this same player's previous task (other players were NOT blocked).\n`)
    )
  }
  queueStats.lastTaskLabel = label
  queueStats.lastTaskStartedAt = Date.now()
  const startedAt = queueStats.lastTaskStartedAt
  try {
    return await task()
  } finally {
    const ranFor = Date.now() - startedAt
    queueStats.lastTaskDurationMs = ranFor
    queueStats.lastTaskStartedAt = null
    queueStats.currentQueueDepth--
    if (ranFor > SLOW_TASK_WARN_MS) {
      queueStats.slowTaskCount++
      process.stderr.write(
        `[${new Date().toISOString()}] ⚠️ player-repo queue: "${label}" itself took ${ranFor}ms to run ` +
        (key === null
          ? `— this is a barrier, so every player was blocked behind it.\n`
          : `— only this player was blocked. Almost always an awaited ctx.reply()/sendMessage() ` +
            `inside the mutatorFn waiting on the send rate limiter; move the send outside ` +
            `updatePlayer() (see scan-mutator-sends.mjs).\n`)
      )
    }
  }
}

// Hard ceiling on any single queued task. Several plugins still call
// ctx.reply()/sock.sendMessage() from inside their mutatorFn; if that
// network call ever hangs (e.g. mid-reconnect), it used to hold this
// queue open forever — every future updatePlayer() call across every
// player would await a promise that never settles, so the bot would
// react but never reply, permanently, until the process was restarted.
// This guarantees the queue always frees up within 20s even if a
// mutator's own I/O gets stuck.
const QUEUE_TASK_TIMEOUT_MS = 20_000

function withTimeout(promise, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${QUEUE_TASK_TIMEOUT_MS}ms`)),
      QUEUE_TASK_TIMEOUT_MS,
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Write coalescing: lowdb's db.write() serializes and writes the WHOLE
 * db.json to disk every time, so if 5 commands land in the same second
 * (a busy group chat), doing that 5 separate times is 5x the disk I/O
 * for no benefit — the 5th write already contains everything the first
 * 4 did. Instead, any write requested within FLUSH_DEBOUNCE_MS of an
 * already-scheduled one just piggybacks on it: only one db.write() runs,
 * and everyone waiting gets resolved (or rejected) together once it
 * settles. This still runs inside runExclusive, so ordering against
 * updateAllPlayers sweeps is untouched.
 *
 * Net effect for a busy bot: same durability (nothing waits more than
 * ~FLUSH_DEBOUNCE_MS past its mutation to hit disk), far fewer actual
 * fwrite() calls under load.
 */
const FLUSH_DEBOUNCE_MS = 150

let pendingFlush = null

// Player lanes now run concurrently, so two debounce windows can expire close
// together. db.write() rewrites the whole file, so two overlapping writes are
// never worth it (and depending on the adapter, not safe). Chain them.
let flushInFlight = null

// The entry carries the db it belongs to. lowdb rewrites THE WHOLE FILE, so a
// flush fired at the wrong instance is not a failed write, it is a successful
// write of the wrong data — and nothing in the caller can tell. One bot process
// only ever has one live db, but tests, scripts and the platform entry points
// each build their own Low, so the instance is recorded and used, never assumed.
async function runFlush() {
  const entry = pendingFlush
  if (!entry) return
  pendingFlush = null
  const db = entry.db
  const previous = flushInFlight
  const run = (async () => {
    if (previous) { try { await previous } catch {} }
    await db.write()
  })()
  flushInFlight = run
  try {
    await run
    entry.resolve()
  } catch (err) {
    entry.reject(err)
  } finally {
    if (flushInFlight === run) flushInFlight = null
  }
}

function scheduleFlush(db) {
  if (pendingFlush) return pendingFlush.promise

  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  const timer = setTimeout(() => { runFlush() }, FLUSH_DEBOUNCE_MS)

  pendingFlush = { promise, resolve, reject, timer, db }
  return promise
}

/** Forces any pending debounced write to happen immediately — call this
 * on graceful shutdown (SIGINT/SIGTERM) so the last burst of mutations
 * before exit isn't lost waiting out the debounce window. */
export async function flushPendingWrites(db) {
  const entry = pendingFlush
  if (!entry) return
  // A pending write belonging to a DIFFERENT database (a test's scratch db, a
  // script's throwaway Low) is none of this caller's business — flushing it
  // here would write that database's in-memory data through ours. It still gets
  // flushed, against its own instance, so no state is stranded.
  clearTimeout(entry.timer)
  await runFlush()
}

/**
 * installReadGuard(db) — make a raw `db.read()` stop rewinding the world.
 *
 * lowdb's read() replaces db.data WHOLESALE with whatever is on disk. That is
 * safe only while the disk copy is current, and it is not: updatePlayer()
 * releases the caller as soon as the mutation is applied in RAM, then schedules
 * the whole-file flush behind FLUSH_DEBOUNCE_MS (see scheduleFlush above). For
 * that window — plus however long the write itself takes, which on a large
 * db.json under load is far more than 150ms — the file on disk is BEHIND
 * db.data.
 *
 * A raw db.read() that lands in that window swaps db.data for the older copy,
 * and the flush that was already pending then writes that rewound state back
 * out. The difference is not a stale read the next command will fix: it is
 * permanent loss of everything applied since the last flush — allocated stat
 * points, a level-up, an equip's bonuses, a purchase.
 *
 * The window is not theoretical. ~50 call sites across plugins call
 * `await db.read()` — every ranking view (.top, .leaderboard, .card top,
 * .serverstats, .guild, .empire, .fame, the card market's getters, …) — so on a
 * busy bot another player's command lands in it constantly. That is the
 * "player stats keep dropping" report: the stat change is applied, one ranking
 * command in another group re-reads the file moments later, and the flush that
 * follows persists the pre-change sheet.
 *
 * Fixing it at the source (deleting all ~50 reads) would leave the next one
 * added to re-open the hole, so the guard closes it at the single choke point:
 * flush any pending write FIRST, so the disk copy the read returns is current
 * and the swap is a no-op. Installed on the one Low instance the bot runs on
 * (main.js's initDb and lib/platform/boot.js) — tests and one-off scripts build
 * their own throwaway db with no pending flush, so they never needed it.
 *
 * A failed pre-flush must never break the read itself: the state is still in
 * RAM, and the caller asked to read, not to write.
 */
export function installReadGuard(db) {
  if (!db || typeof db.read !== 'function' || db.__readGuarded) return db
  const originalRead = db.read.bind(db)
  db.read = async (...args) => {
    try {
      await flushPendingWrites(db)
    } catch (err) {
      logWriteFailure('db.read() pre-flush (read guard)', err)
    }
    return originalRead(...args)
  }
  db.__readGuarded = true
  return db
}

function logWriteFailure(label, err) {
  process.stderr.write(
    `[${new Date().toISOString()}] ⚠️ ${label}: db.write() failed/hung, ` +
    `continuing with in-memory state only — ${err?.code ?? err?.message ?? err}\n`
  )
}

/**
 * Safely mutates a player record: applies `mutatorFn` to the live
 * in-memory copy (this process is the only writer of db.json, so it's
 * never stale — see the note inside), then flushes to disk. Always use
 * this for any inventory/equip/wallet/stat mutation — never mutate
 * ctx.player directly and call savePlayer().
 *
 * mutatorFn receives the live player object and must mutate it in place
 * or return a new object to replace it.
 */
export async function updatePlayer(db, id, mutatorFn) {
  // Multi-VPS cluster mode: per-player atomic writes with optimistic
  // concurrency. Everything below is the single-writer fast path and is left
  // untouched when the flag is off (see clusterUpdatePlayer / config.clusterMode).
  if (isClusterMode(db)) return clusterUpdatePlayer(db, id, mutatorFn)

  // The mutation must stay inside runExclusive's chain (writeQueue) so it
  // still fully serializes against every future updatePlayer/
  // updateAllPlayers call — that ordering guarantee is the entire point
  // of the queue (see comment above) and must not be broken, or the
  // documented "solars taken but item never showed up" clobbering bug
  // can reappear.
  //
  // NOTE on the db.read() that used to open this function: this process
  // is the ONLY writer of db.json (see ecosystem.config.cjs — both
  // WhatsApp numbers run inside one PM2 process specifically so there's
  // never a second writer). Every mutation to db.data.users already goes
  // through this same runExclusive queue, so db.data is never stale
  // relative to disk from this process's own point of view — re-reading
  // the ENTIRE file off disk before every single player update was pure
  // wasted I/O (and the #1 cause of slow replies under load), not a
  // correctness requirement. If a second writer is ever reintroduced,
  // this assumption breaks and the read must come back.
  //
  // What we DON'T want is the CALLER (e.g. plugins/dungeon.js) stuck
  // waiting on — or failed by — a db.write() that's hanging because the
  // disk is full. lowdb rewrites the whole file in one shot, so on a
  // full disk db.write() doesn't reject quickly, it hangs; racing the
  // *entire* mutate+write against the 20s timeout meant a slow write
  // would eventually reject the whole call, discarding the already-
  // applied in-memory mutation and failing the command.
  //
  // So: the mutation resolves the caller's promise immediately once
  // applied, synchronously, with no disk I/O on the critical path at
  // all. The write itself is queued (debounced/coalesced, see
  // scheduleFlush below) and awaited inside the queue's task — it just
  // never propagates a rejection back to this function's caller. A
  // failed/hung write only ever produces a log line.
  let resolveCaller, rejectCaller
  const callerPromise = new Promise((res, rej) => { resolveCaller = res; rejectCaller = rej })

  runExclusive(() => withTimeout((async () => {
    const player = db.data.users[id]
    if (!player) throw new Error(`updatePlayer: no player found for id ${id}`)

    // Snapshot for the dirty check below. One player record is KBs and
    // stringifyable by construction (it round-trips through db.json), so two
    // stringifies around the mutator are cheap insurance against the write
    // that follows: db.write() stringifies the ENTIRE database.
    const before = JSON.stringify(player)

    const result = await mutatorFn(player)
    db.data.users[id] = result ?? player
    const finalPlayer = db.data.users[id]

    // Release the caller now — the mutation succeeded, which is what
    // command handlers like dungeon.js actually depend on. No disk I/O
    // has happened yet at this point.
    resolveCaller(finalPlayer)

    // No-op mutator, no write. Most of the handler's per-command mutators
    // are checks that usually change nothing (the inn-sleep check, the End
    // tick with the event off, the overflow notice with a healthy bag, the
    // pet payout with no pet), and every one of them used to force a
    // whole-db flush regardless. Under command overspam those no-op flushes
    // are pure load: db.write() runs a synchronous JSON.stringify over the
    // ENTIRE db.json on the event loop, and a flood of commands stringifying
    // a large file back-to-back is what lets the inbound pipeline fall so
    // far behind that Baileys' own keepalive watchdog declares the socket
    // dead ("Connection was lost") and reconnects: the brief disconnect
    // reported on overspam. Skipping the flush when the player record is
    // byte-identical afterwards is the cheap half of that fix; the reaction
    // lane's shedding (lib/send-rate-limiter.js) and main.js's serialized
    // inbound batches are the rest.
    if (JSON.stringify(finalPlayer) === before) return

    // ── The flush is scheduled, NOT awaited (2026-09: the reply-latency bug) ──
    //
    // This used to be `await scheduleFlush(db)`, which made the task — and with
    // it this player's whole lane — stay open for FLUSH_DEBOUNCE_MS (150ms) plus
    // the time the whole-file write takes. Nothing about the write needs the
    // lane held: db.write() stringifies the CURRENT db.data at the moment it
    // runs, so a flush that lands later still writes every mutation applied in
    // between. Awaiting it only bought head-of-line blocking, and the command
    // path pays it constantly — handler.js runs up to four updatePlayer hops per
    // message (inn-sleep gate, hunger tick, The End tick, pet payout) before and
    // after the plugin, each queued behind this same lane. Measured on a
    // 200-player db: 158ms of dead time per command, none of it the reply's.
    // Worse on the production db, where the write is bigger and busier.
    //
    // Errors still surface: the rejection is logged here, exactly as before.
    scheduleFlush(db).catch(err => logWriteFailure(`updatePlayer(${id})`, err))
  })(), `updatePlayer(${id})`), `updatePlayer(${id})`, id).catch(err => {
    // Only reaches here if mutatorFn() itself threw/timed out — a real
    // failure before any mutation happened — so it's correct for the
    // caller to see this one.
    rejectCaller(err)
  })

  return callerPromise
}

/**
 * The cluster-mode body of updatePlayer. Runs on the SAME writeQueue so it
 * still serializes against every other mutation in THIS process; the new part
 * is that it also coordinates with the OTHER VPS through the database:
 *
 *   read the player fresh from Mongo  →  refresh this node's RAM copy  →
 *   apply the mutator  →  write it back only if its rev is unchanged (CAS).
 *
 * If another node wrote the same player in between, the CAS reports a conflict
 * and the whole cycle repeats against the now-newer state. Because every call
 * site mutates the player it is handed (never an absolute value captured from a
 * stale earlier read), re-running the mutator on the fresh copy is safe.
 *
 * Unlike the single-writer path, the caller is resolved only AFTER the write
 * has committed to the cluster. That is deliberate: a player's command must be
 * durable before they get their reply, or a second node serving their next
 * message could read pre-command state. Writes therefore pay the Mongo round
 * trip here; reads elsewhere stay fast and local (eventually consistent).
 */
function clusterUpdatePlayer(db, id, mutatorFn) {
  let resolveCaller, rejectCaller
  const callerPromise = new Promise((res, rej) => { resolveCaller = res; rejectCaller = rej })

  runExclusive(() => withTimeout((async () => {
    const adapter = db.adapter
    let lastWrite = null

    for (let attempt = 1; attempt <= CLUSTER_CAS_MAX_ATTEMPTS; attempt++) {
      const { json: fresh, rev } = await adapter.readPlayer(id)
      if (fresh == null) {
        // Same contract as the single-writer path: no such player is a real
        // error the caller should see, not a silent no-op.
        throw new Error(`updatePlayer: no player found for id ${id}`)
      }

      // Refresh this node's RAM for this one player, so getPlayer(db, id) right
      // after this call returns the committed value and the mutator sees the
      // same object shape it always has.
      db.data.users[id] = fresh
      const result = await mutatorFn(fresh)
      const toWrite = result ?? fresh
      db.data.users[id] = toWrite
      lastWrite = toWrite

      const res = await adapter.writePlayerAtomic(id, toWrite, rev)
      if (res.ok) {
        resolveCaller(toWrite)
        return
      }
      // Conflict: another node bumped the rev. Re-read, re-apply, retry. A few
      // ms of jitter stops two nodes colliding in lockstep from doing it again.
      await sleep(5 + Math.floor(Math.random() * 15))
    }

    // Sustained contention on ONE player lost the race CLUSTER_CAS_MAX_ATTEMPTS
    // times running — vanishingly rare (each attempt reads the very latest, so
    // this needs a steady stream of writers on the same jid). Surface it loudly
    // and let the caller through with the last in-memory result: RAM has the
    // change even though this final attempt did not land it in the cluster.
    logWriteFailure(
      `updatePlayer(${id}) [cluster]`,
      new Error(`gave up after ${CLUSTER_CAS_MAX_ATTEMPTS} CAS attempts`),
    )
    resolveCaller(lastWrite ?? db.data.users[id])
  })(), `updatePlayer(${id})`), `updatePlayer(${id})`, id).catch(err => {
    // Only a mutator throw / timeout / non-conflict adapter error reaches here.
    rejectCaller(err)
  })

  return callerPromise
}

/**
 * Safely mutates every player record in one atomic read→mutate→write
 * cycle, serialized against updatePlayer() and every other global sweep
 * on the SAME shared queue (see comment above) — so a sweep can never
 * clobber an in-flight purchase/equip/wallet change no matter how long
 * the sweep's own mutatorFn takes (e.g. it makes network calls). Use
 * this instead of calling db.read()/db.write() directly whenever a task
 * needs to walk db.data.users as a whole (the premium expiry sweep in
 * main.js is the motivating example). mutatorFn receives the live
 * db.data.users map and may mutate players in place; return true if
 * anything actually changed so the caller knows whether a write happened.
 */
export async function updateAllPlayers(db, mutatorFn) {
  return runExclusive(() => withTimeout((async () => {
    // Same single-writer reasoning as updatePlayer: no db.read() needed,
    // db.data is always current from this process's own perspective.
    const changed = await mutatorFn(db.data.users ?? {})
    if (changed) {
      try {
        await scheduleFlush(db)
      } catch (err) {
        // Same rationale as updatePlayer above: don't let a disk-full
        // write failure reject this call and crash the calling sweep.
        process.stderr.write(
          `[${new Date().toISOString()}] ⚠️ updateAllPlayers: db.write() failed, ` +
          `continuing with in-memory state only — ${err?.code ?? err?.message ?? err}\n`
        )
      }
    }
    return changed
  })(), 'updateAllPlayers'), 'updateAllPlayers', null)
}
