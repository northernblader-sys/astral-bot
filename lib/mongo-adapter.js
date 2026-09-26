/**
 * mongo-adapter.js — db.json stays the live database, and every save is
 * copied up to MongoDB the moment it lands on disk.
 *
 * WHY: db.json was the ONLY copy of every player's progress. Deleting a folder
 * on the VPS deleted the game, and restoring a week-old backup cost 503
 * players a week of play. Now the file is written exactly as before and a
 * managed database off-box receives the same data right after, so the file can
 * be lost, corrupted, or deleted without losing anyone's progress.
 *
 * WHICH COPY IS IN CHARGE: the local file. Boot reads db.json, players are
 * served from it, and MongoDB trails behind it as a replica. That ordering is
 * deliberate: no command ever waits on the network, so a slow cluster or a dead
 * connection cannot make the bot feel laggy or drop a save. The one time the
 * replica takes over is when the local file is gone or empty at boot, which is
 * exactly the disaster this exists for: read() pulls the world back down and
 * writes db.json out again before the bot serves a single message.
 *
 * WHY THE REST OF THE BOT DOESN'T CHANGE: lowdb's adapter contract is two
 * methods, read() and write(wholeObject). lib/player-repo.js still owns the
 * write queue, plugins still mutate db.data in memory, and switching storage
 * is one constructor argument in main.js.
 *
 * ── Shape on the server ───────────────────────────────────────────────────
 *   users collection : one document per player  { _id: <jid>, json, fp, updatedAt }
 *   meta  collection : one document per other top-level key  { _id: <key>, json, fp }
 *
 * There are 20 top-level keys in the live db.json (users, sessions, bans,
 * guilds, abilities, jail, parties, market, tourneys, mods, notifications,
 * accountLinks, empires, lottery, and more), so meta is generic on purpose: a
 * new db.data.whatever starts being backed up with no change to this file.
 *
 * users is split per player rather than kept in one document because BSON caps
 * a single document at 16MB, and because a per-player split lets each sync push
 * ONLY the players who changed. At 503 players averaging 4KB, a busy minute
 * moves a few KB instead of re-uploading 2MB.
 *
 * `fp` is a fingerprint of `json` (sha1, base64). It exists so a boot can ask
 * "what does the cluster already have?" by downloading only fingerprints
 * instead of the whole world, and so an unchanged player is skipped without a
 * byte crossing the network.
 *
 * Values are stored as JSON strings rather than native BSON subdocuments. That
 * is deliberate: JSON.stringify/JSON.parse is byte-for-byte what the file
 * adapter already does, so backing up cannot silently change a value. Native
 * subdocuments would drag in BSON's rules about field names containing dots
 * (every WhatsApp JID has them: 234...@s.whatsapp.net) and its int/double
 * distinction. Durability is what this buys, not queries inside a player.
 *
 * ── Single writer, now across machines ────────────────────────────────────
 * A local .lock file cannot see a process on another machine, and a cluster is
 * reachable from your laptop and the VPS at once. Two bots replicating their
 * own local worlds into one database would overwrite each other's backup, so
 * meta holds a __writer_lock document with a heartbeat: whoever doesn't own it
 * keeps playing from its own db.json but does not sync.
 */

import { hostname } from 'os'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { FastJSONFile } from './fast-json-adapter.js'

const USERS_COLLECTION = 'users'
const META_COLLECTION = 'meta'

/** _id of the cross-machine writer lock, inside META_COLLECTION. */
const WRITER_LOCK_ID = '__writer_lock'
/** A holder whose heartbeat is older than this is treated as dead. */
const LOCK_STALE_MS = 90_000
/** How often the owner refreshes its heartbeat. Must stay well under STALE. */
const LOCK_HEARTBEAT_MS = 25_000
/** Documents per bulkWrite call — keeps a first full upload in sane batches. */
const BULK_CHUNK = 500
/** One document can't exceed 16MB; warn long before anything gets close. */
const DOC_WARN_BYTES = 8 * 1024 * 1024
/** How long to wait for the cluster before giving up on a connect attempt. */
const CONNECT_TIMEOUT_MS = 15_000
/** Cadence of the background reconnect loop while the backup is offline. */
const RECONNECT_EVERY_MS = 30_000
/** Longest shutdown will wait for the final sync before letting go. */
const CLOSE_DRAIN_MS = 10_000

/** Cheap content hash. Not security: this only answers "did this change?". */
function fingerprint(json) {
  return createHash('sha1').update(json).digest('base64')
}

/** Resolves with the promise, or after ms, whichever comes first. */
function raceTimeout(promise, ms) {
  let timer
  const capped = new Promise(resolve => {
    timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
  return Promise.race([promise, capped]).finally(() => clearTimeout(timer))
}

/**
 * Work out the smallest set of writes that makes MongoDB match `data`.
 *
 * Pure and exported so it can be tested without a cluster: given the
 * fingerprints of what was last pushed, it returns the bulk ops to send and the
 * fingerprint map that will be current once they land. Keys are prefixed (`u:`
 * players, `m:` everything else) so one map covers both collections.
 *
 * A key that's in `prev` but not in `data` produces a delete: that's how a
 * player wiped locally stops existing in the backup too.
 */
export function buildOps(prev, data) {
  const next = new Map()
  const userOps = []
  const metaOps = []
  const oversize = []
  const users = data?.users ?? {}
  const updatedAt = new Date()

  for (const id of Object.keys(users)) {
    const json = JSON.stringify(users[id])
    const fp = fingerprint(json)
    next.set(`u:${id}`, fp)
    if (prev.get(`u:${id}`) === fp) continue
    if (json.length > DOC_WARN_BYTES) oversize.push({ key: `player ${id}`, bytes: json.length })
    userOps.push({
      updateOne: { filter: { _id: id }, update: { $set: { json, fp, updatedAt } }, upsert: true },
    })
  }

  for (const key of Object.keys(data ?? {})) {
    if (key === 'users') continue
    const json = JSON.stringify(data[key])
    const fp = fingerprint(json)
    next.set(`m:${key}`, fp)
    if (prev.get(`m:${key}`) === fp) continue
    if (json.length > DOC_WARN_BYTES) oversize.push({ key: `db.data.${key}`, bytes: json.length })
    metaOps.push({
      updateOne: { filter: { _id: key }, update: { $set: { json, fp, updatedAt } }, upsert: true },
    })
  }

  for (const key of prev.keys()) {
    if (next.has(key)) continue
    const id = key.slice(2)
    if (key.startsWith('u:')) userOps.push({ deleteOne: { filter: { _id: id } } })
    else metaOps.push({ deleteOne: { filter: { _id: id } } })
  }

  return { userOps, metaOps, next, oversize }
}

export class ReplicatedJSONFile {
  /** The local file — still the live database. */
  #file
  #client = null
  #db = null
  /** Fingerprints of what MongoDB currently holds, keyed u:<id> / m:<key>. */
  #fingerprints = new Map()
  /** True only when connected, lock held, and fingerprints loaded. */
  #synced = false
  #pushing = false
  #pushAgain = false
  #pushChain = Promise.resolve()
  /** Live reference to db.data, so a reconnect can push without a save. */
  #lastData = null
  #heartbeatTimer = null
  #reconnectTimer = null
  #reconnecting = false
  #failStreak = 0
  #lockConflictLogged = false
  /** The boot banner and the first connect attempt are once-per-process. */
  #loadLogged = false
  #connectStarted = false
  #closed = false
  #closing = null

  constructor({
    uri,
    dbName = 'astral',
    localPath,
    readOnly = false,
    allowSecondWriter = false,
    log = console.log,
    warn = console.warn,
  }) {
    if (!uri) throw new Error('ReplicatedJSONFile: no MongoDB connection string (set MONGO_URI in .env)')
    if (!localPath) throw new Error('ReplicatedJSONFile: localPath is required — the local file is the live database')
    this.uri = uri
    this.dbName = dbName
    this.localPath = localPath
    this.readOnly = readOnly
    this.allowSecondWriter = allowSecondWriter
    this.log = log
    this.warn = warn
    this.lastSyncedAt = null
    // Same atomic temp-file + rename writer the bot has always used.
    this.#file = new FastJSONFile(localPath)
  }

  /** The connection string with the password stripped, safe to log. */
  get safeUri() {
    return String(this.uri).replace(/\/\/[^@/]*@/, '//<credentials>@')
  }

  /** Whether the backup is currently keeping up, for logs and health checks. */
  get syncState() {
    return { synced: this.#synced, lastSyncedAt: this.lastSyncedAt, failures: this.#failStreak }
  }

  // ── read() — lowdb adapter contract ─────────────────────────────────────

  async read() {
    const local = existsSync(this.localPath) ? await this.#file.read() : null
    const players = Object.keys(local?.users ?? {}).length

    if (local && players > 0) {
      // Boot banner, once. read() is not a boot-only call: plugins call
      // db.read() to refresh before they touch shared state, so this fires
      // several times a minute on a busy bot and used to print every time.
      if (!this.#loadLogged) {
        this.#loadLogged = true
        this.log(`💾 Loaded ${players} players from ${this.localPath}`)
      }
      // Connect in the background. Boot must not wait on a network hop, and a
      // cluster that's down must not delay the bot coming online at all.
      this.#connectInBackground(local)
      return local
    }

    // No usable local file. This is the case the whole feature exists for.
    return await this.#restoreFromRemote(local)
  }

  /**
   * Open the backup connection the first time the world is read.
   *
   * Only the first call does the network work. `#lastData` is still refreshed
   * on every call, because lowdb replaces db.data wholesale on each read() and
   * a push has to replicate the object the bot is actually holding.
   *
   * It used to reconnect, re-lock and re-download every fingerprint on EVERY
   * read, which meant one lock write plus two full collection scans per command
   * that called db.read(), and one "backup connected" line each time over a
   * connection that had never dropped. Recovery does not need this hook:
   * #onRemoteFailure schedules #tryReconnect on a timer, which redoes the lock
   * and fingerprints properly and logs once when it succeeds.
   */
  #connectInBackground(data) {
    this.#lastData = data
    if (this.#connectStarted) return
    this.#connectStarted = true
    void (async () => {
      try {
        await this.#connect()
        if (!this.readOnly) await this.#acquireWriterLock()
        await this.#loadFingerprints()
        this.#synced = true
        this.#failStreak = 0
        const known = this.#fingerprints.size
        this.log(
          `☁️ MongoDB backup connected ("${this.dbName}", ${known} documents already there) — ` +
          `every save is copied up from now on.`
        )
        // Anything the file has that the cluster doesn't goes up right now.
        this.#schedulePush()
      } catch (err) {
        this.#onRemoteFailure(err, 'connect')
      }
    })()
  }

  /**
   * The local file is missing or has no players. Pull the world back down.
   *
   * `local` is null (no file at all) or an empty-ish object (a file exists but
   * holds nobody). The difference matters: an empty file is a legitimate fresh
   * install and may boot with no backup reachable, while a missing file plus an
   * unreachable cluster means there is genuinely nothing to start from, and
   * booting an empty world would replicate "no players exist" over the backup.
   */
  async #restoreFromRemote(local) {
    try {
      await this.#connect()
      if (!this.readOnly) await this.#acquireWriterLock()
    } catch (err) {
      await this.#closeClient()
      if (local) {
        this.warn(
          `⚠️ MongoDB unreachable (${err.message}) — starting from ${this.localPath} as it is. ` +
          `Nothing is being backed up until the connection returns.`
        )
        this.#lastData = local
        this.#scheduleReconnect()
        return local
      }
      throw new Error(
        `There is no database at ${this.localPath} and MongoDB (${this.safeUri}) cannot be ` +
        `reached, so there is nothing to start from.\n` +
        `  Refusing to boot an empty world: the first save would replicate "no players exist" ` +
        `over the backup.\n` +
        `  Check Atlas Network Access (is this server's IP allowed?), the database user's ` +
        `password, and MONGO_URI. Cause: ${err.message}`
      )
    }

    const data = await this.#downloadAll()
    const count = Object.keys(data.users).length
    this.#synced = true

    if (count === 0) {
      this.log(`☁️ MongoDB "${this.dbName}" is empty too — starting a fresh world and backing it up.`)
      this.#lastData = local
      return local
    }

    this.warn(
      `♻️ ${this.localPath} was missing or empty, so the database was RESTORED from MongoDB: ` +
      `${count} players recovered. Writing the file back out now.`
    )
    await this.#file.write(data)
    this.#lastData = data
    return data
  }

  /** Every document, parsed back into a db.data-shaped object. */
  async #downloadAll() {
    const [users, meta] = await Promise.all([
      this.#db.collection(USERS_COLLECTION).find({}).toArray(),
      this.#db.collection(META_COLLECTION).find({ _id: { $ne: WRITER_LOCK_ID } }).toArray(),
    ])

    const data = { users: {} }
    this.#fingerprints = new Map()

    for (const doc of users) {
      const parsed = this.#parse(doc.json, `player ${doc._id}`)
      if (parsed === undefined) continue
      data.users[String(doc._id)] = parsed
      this.#fingerprints.set(`u:${doc._id}`, doc.fp ?? fingerprint(doc.json))
    }
    for (const doc of meta) {
      const parsed = this.#parse(doc.json, `db.data.${doc._id}`)
      if (parsed === undefined) continue
      data[String(doc._id)] = parsed
      this.#fingerprints.set(`m:${doc._id}`, doc.fp ?? fingerprint(doc.json))
    }
    return data
  }

  /** Fingerprints only — a few KB, so a boot can diff without downloading. */
  async #loadFingerprints() {
    const [users, meta] = await Promise.all([
      this.#db.collection(USERS_COLLECTION).find({}, { projection: { fp: 1 } }).toArray(),
      this.#db.collection(META_COLLECTION)
        .find({ _id: { $ne: WRITER_LOCK_ID } }, { projection: { fp: 1 } }).toArray(),
    ])
    this.#fingerprints = new Map()
    // '?' for a document written before fp existed: it doesn't match any real
    // fingerprint, so it gets refreshed once, and it still counts as present so
    // an orphan can still be deleted.
    for (const doc of users) this.#fingerprints.set(`u:${doc._id}`, doc.fp ?? '?')
    for (const doc of meta) this.#fingerprints.set(`m:${doc._id}`, doc.fp ?? '?')
  }

  #parse(json, label) {
    try {
      return JSON.parse(json)
    } catch (err) {
      // Skipping is the least-bad option: including garbage would corrupt live
      // state, and the log names exactly which document to look at.
      this.warn(`⚠️ MongoDB: ${label} did not parse and was skipped — ${err.message}`)
      return undefined
    }
  }

  // ── write() — lowdb adapter contract ────────────────────────────────────

  async write(data) {
    this.#lastData = data
    // The local file is the primary and stays on the caller's critical path,
    // unchanged: same atomic temp-file + rename write as before, same latency.
    await this.#file.write(data)
    // The copy to MongoDB happens after, off that path. Slow, down, or midway
    // through a reconnect, the bot never notices and no player waits.
    this.#schedulePush()
  }

  /**
   * Queue a sync. Coalescing matters here: player-repo.js already debounces
   * saves to ~150ms, and a busy group can still land several in the time one
   * round trip to Atlas takes. Rather than queueing a push per save, a push
   * already in flight just gets told to run once more when it finishes, and it
   * then reads the latest db.data — so N saves cost at most 2 syncs.
   */
  #schedulePush() {
    if (this.readOnly || this.#closed || !this.#synced) return
    if (this.#pushing) {
      this.#pushAgain = true
      return
    }
    this.#pushing = true
    this.#pushChain = (async () => {
      try {
        do {
          this.#pushAgain = false
          await this.#pushNow(this.#lastData)
        } while (this.#pushAgain && !this.#closed && this.#synced)
      } finally {
        this.#pushing = false
      }
    })()
    this.#pushChain.catch(() => {})
  }

  /**
   * Push the current diff. Never throws by default — a failed backup must not
   * surface as a failed player command. `rethrow` is for scripts, where a
   * silent failure would be worse than a crash.
   */
  async #pushNow(data, { rethrow = false } = {}) {
    if (!data || !this.#db || this.readOnly) return

    const { userOps, metaOps, next, oversize } = buildOps(this.#fingerprints, data)
    for (const { key, bytes } of oversize) {
      this.warn(
        `⚠️ ${key} is ${(bytes / 1048576).toFixed(1)}MB — a single MongoDB document cannot ` +
        `exceed 16MB. Split it the way users is split before it gets there.`
      )
    }
    if (userOps.length === 0 && metaOps.length === 0) return

    try {
      if (userOps.length) await this.#bulk(USERS_COLLECTION, userOps)
      if (metaOps.length) await this.#bulk(META_COLLECTION, metaOps)
      // Only now is the cluster known to match: a failed batch must be retried
      // by the next sync, not forgotten because the map moved on.
      this.#fingerprints = next
      this.#failStreak = 0
      this.lastSyncedAt = Date.now()
    } catch (err) {
      this.#onRemoteFailure(err, 'save')
      if (rethrow) throw err
    }
  }

  async #bulk(collection, ops) {
    const col = this.#db.collection(collection)
    for (let i = 0; i < ops.length; i += BULK_CHUNK) {
      const chunk = ops.slice(i, i + BULK_CHUNK)
      // ordered:false — one rejected document must not stop the rest landing.
      await col.bulkWrite(chunk, { ordered: false })
      if (ops.length > BULK_CHUNK) {
        this.log(`☁️ MongoDB ${collection}: ${Math.min(i + chunk.length, ops.length)}/${ops.length} written`)
      }
    }
  }

  // ── Per-player atomic writes (cluster mode) ──────────────────────────────
  //
  // The two methods below are the whole reason multiple VPS can share one
  // database. The bulk path above replicates the ENTIRE local world and assumes
  // this process is the only writer; run three of those against one cluster and
  // a stale player in one node's RAM overwrites a fresh save from another. These
  // two sidestep that: read ONE player straight from the cluster, then write it
  // back only if nobody else has touched it since (an optimistic `rev`
  // compare-and-swap). lib/player-repo.js drives the read → mutate → CAS → retry
  // loop; this file just owns the two database round trips.
  //
  // `rev` is an integer that starts absent (0) and is bumped on every atomic
  // write. The bulk buildOps path never sets it, so a single-VPS deploy that
  // never turns cluster mode on never grows the field — no migration, and the
  // first atomic write on a given player stamps rev: 1.

  /**
   * Read one player fresh from the cluster. Returns the parsed player (or null
   * if there is no such document) and its current `rev` — the two things the
   * write path needs to attempt a compare-and-swap.
   */
  async readPlayer(id) {
    await this.#ensureReady()
    if (!this.#db) throw new Error('readPlayer: MongoDB is not connected')
    const doc = await this.#db.collection(USERS_COLLECTION).findOne({ _id: id })
    if (!doc) return { json: null, rev: 0 }
    const parsed = this.#parse(doc.json, `player ${id}`)
    return {
      json: parsed ?? null,
      rev: Number.isInteger(doc.rev) ? doc.rev : 0,
    }
  }

  /**
   * Write one player back, but only if its stored `rev` still equals
   * `expectedRev` — i.e. nobody else wrote it since we read it. On success the
   * document's rev is bumped to expectedRev+1 and { ok, rev } is returned. If
   * another node got there first, nothing is written and { conflict: true } comes
   * back so the caller can re-read and re-apply.
   *
   * expectedRev === 0 means "I believe this player does not exist yet, or exists
   * from a pre-cluster bulk push with no rev field". The filter matches both of
   * those and upserts, so a brand-new player is created here; two nodes both
   * trying it means one upsert wins and the other collides on _id (E11000),
   * which is just another conflict.
   */
  async writePlayerAtomic(id, playerObj, expectedRev = 0) {
    await this.#ensureReady()
    if (!this.#db) throw new Error('writePlayerAtomic: MongoDB is not connected')

    const json = JSON.stringify(playerObj)
    const fp = fingerprint(json)
    const updatedAt = new Date()
    const nextRev = expectedRev + 1
    // rev 0 also matches documents written before rev existed (bulk path).
    const revFilter = expectedRev === 0
      ? { $or: [{ rev: 0 }, { rev: { $exists: false } }] }
      : { rev: expectedRev }

    try {
      const res = await this.#db.collection(USERS_COLLECTION).updateOne(
        { _id: id, ...revFilter },
        { $set: { json, fp, rev: nextRev, updatedAt } },
        { upsert: expectedRev === 0 },
      )
      // Neither matched an existing doc nor inserted one → somebody else moved
      // the rev out from under us. Not an error; the caller retries.
      if (res.matchedCount === 0 && res.upsertedCount === 0) return { conflict: true }
    } catch (err) {
      // Upsert race: our filter didn't match, upsert tried to insert, and the
      // _id already exists because another node just created it. Same as a
      // rev conflict from our point of view.
      if (err?.code === 11000) return { conflict: true }
      throw err
    }

    // The cluster now holds exactly this json for this player, so teach the bulk
    // path its fingerprint. Without this, the next whole-object write() would
    // diff RAM against a stale fp and redundantly re-push the same player (or,
    // worse in a future phase, race the value we just committed).
    this.#fingerprints.set(`u:${id}`, fp)
    this.lastSyncedAt = Date.now()
    return { ok: true, rev: nextRev }
  }

  // ── Per-key atomic writes for SHARED state (cluster mode) ────────────────
  //
  // The market, empires, lottery and the like are not players — they live one
  // per key in the meta collection (db.data.market, db.data.empires, ...). Two
  // VPS mutating the same shared object at once is the same lost-update hazard
  // the player CAS solves, so these two methods are the meta-collection twins of
  // readPlayer / writePlayerAtomic: read ONE key fresh, write it back only if its
  // `rev` is unchanged. lib/shared-repo.js drives the read → mutate → CAS → retry
  // loop; this file just owns the two round trips.
  //
  // Same no-migration property as players: the bulk buildOps path never sets
  // rev, so rev absent means 0 and the first atomic write on a key stamps rev 1.

  /**
   * Read one shared meta key fresh from the cluster. Returns the parsed value
   * (or null if there is no such document) and its current `rev`. A key that has
   * only ever been bulk-pushed has no rev and reads as 0.
   */
  async readMeta(key) {
    await this.#ensureReady()
    if (!this.#db) throw new Error('readMeta: MongoDB is not connected')
    const doc = await this.#db.collection(META_COLLECTION).findOne({ _id: key })
    if (!doc) return { json: null, rev: 0 }
    const parsed = this.#parse(doc.json, `db.data.${key}`)
    return {
      json: parsed ?? null,
      rev: Number.isInteger(doc.rev) ? doc.rev : 0,
    }
  }

  /**
   * Write one shared meta key back, but only if its stored `rev` still equals
   * `expectedRev`. On success rev is bumped and { ok, rev } returned; if another
   * node moved it first, nothing is written and { conflict: true } comes back so
   * the caller can re-read and re-apply.
   *
   * expectedRev === 0 upserts (a key that never existed, or one from a pre-cluster
   * bulk push with no rev), so the first shared mutation creates the doc.
   */
  async writeMetaAtomic(key, value, expectedRev = 0) {
    await this.#ensureReady()
    if (!this.#db) throw new Error('writeMetaAtomic: MongoDB is not connected')

    const json = JSON.stringify(value)
    const fp = fingerprint(json)
    const updatedAt = new Date()
    const nextRev = expectedRev + 1
    const revFilter = expectedRev === 0
      ? { $or: [{ rev: 0 }, { rev: { $exists: false } }] }
      : { rev: expectedRev }

    try {
      const res = await this.#db.collection(META_COLLECTION).updateOne(
        { _id: key, ...revFilter },
        { $set: { json, fp, rev: nextRev, updatedAt } },
        { upsert: expectedRev === 0 },
      )
      if (res.matchedCount === 0 && res.upsertedCount === 0) return { conflict: true }
    } catch (err) {
      if (err?.code === 11000) return { conflict: true }
      throw err
    }

    this.#fingerprints.set(`m:${key}`, fp)
    this.lastSyncedAt = Date.now()
    return { ok: true, rev: nextRev }
  }

  // ── Staying connected ───────────────────────────────────────────────────

  #onRemoteFailure(err, phase) {
    this.#failStreak++
    this.#synced = false

    if (err?.code === 'DB_WRITER_LOCK') {
      // Another machine owns the backup. Playing on is fine; replicating on top
      // of them is not. Say it once instead of every 30 seconds forever.
      if (!this.#lockConflictLogged) {
        this.#lockConflictLogged = true
        this.warn(`⚠️ Not backing up: ${err.message}`)
      }
    } else if (this.#failStreak === 1 || this.#failStreak % 20 === 0) {
      this.warn(
        `⚠️ MongoDB backup ${phase} failed (${err?.message ?? err}) — ${this.localPath} is still ` +
        `saving normally, so nothing is lost yet. Retrying every ${RECONNECT_EVERY_MS / 1000}s.`
      )
    }

    void this.#closeClient()
    this.#scheduleReconnect()
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer || this.#closed) return
    this.#reconnectTimer = setInterval(() => { void this.#tryReconnect() }, RECONNECT_EVERY_MS)
    this.#reconnectTimer.unref?.()
  }

  async #tryReconnect() {
    if (this.#closed || this.#synced || this.#reconnecting) return
    this.#reconnecting = true
    try {
      await this.#connect()
      if (!this.readOnly) await this.#acquireWriterLock()
      await this.#loadFingerprints()
      this.#synced = true
      this.#failStreak = 0
      this.#lockConflictLogged = false
      clearInterval(this.#reconnectTimer)
      this.#reconnectTimer = null
      this.log('☁️ MongoDB backup reconnected — copying up everything saved while it was offline.')
      this.#schedulePush()
    } catch (err) {
      await this.#closeClient()
      if (err?.code === 'DB_WRITER_LOCK' && !this.#lockConflictLogged) {
        this.#lockConflictLogged = true
        this.warn(`⚠️ Not backing up: ${err.message}`)
      }
    } finally {
      this.#reconnecting = false
    }
  }

  // ── Connecting, and the cross-machine writer lock ───────────────────────

  /**
   * Open a client. The driver is imported here rather than at the top of the
   * file so a bot with no MONGO_URI never needs the package installed at all —
   * this whole module stays dormant until someone opts in.
   */
  async #connect() {
    if (this.#db) return
    let MongoClient
    try {
      ({ MongoClient } = await import('mongodb'))
    } catch {
      const err = new Error('the "mongodb" package is not installed — run: npm install mongodb')
      err.code = 'DB_DRIVER_MISSING'
      throw err
    }

    const client = new MongoClient(this.uri, {
      // Fail fast instead of hanging boot when Atlas is unreachable or this
      // server's IP isn't on the access list.
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      retryWrites: true,
      // One process making small writes: a large pool would only hold idle
      // sockets against the cluster's connection limit.
      maxPoolSize: 8,
    })
    await client.connect()
    // connect() can resolve before the cluster is actually usable, so prove it
    // with a round trip before declaring the backup healthy.
    await client.db(this.dbName).command({ ping: 1 })
    this.#client = client
    this.#db = client.db(this.dbName)
  }

  /**
   * Claim the right to be the one process replicating into this database.
   *
   * Atomic by construction: one updateOne whose filter matches only three
   * situations — no lock document at all, the lock is already mine, or the
   * holder stopped beating. Two bots racing means one filter matches and the
   * other's upsert collides on _id (E11000), which is the losing branch rather
   * than an error worth retrying.
   *
   * Losing does NOT stop the bot. It keeps playing from its own local file; it
   * just declines to overwrite someone else's backup with its own world.
   */
  async #acquireWriterLock() {
    if (this.allowSecondWriter) return
    const meta = this.#db.collection(META_COLLECTION)
    const me = { pid: process.pid, host: hostname(), heartbeat: Date.now() }
    const staleBefore = Date.now() - LOCK_STALE_MS

    try {
      const res = await meta.updateOne(
        {
          _id: WRITER_LOCK_ID,
          $or: [
            { holder: { $exists: false } },
            { holder: null },
            { 'holder.pid': me.pid, 'holder.host': me.host },
            { 'holder.heartbeat': { $lt: staleBefore } },
          ],
        },
        { $set: { holder: me } },
        { upsert: true },
      )
      if (res.matchedCount === 0 && res.upsertedCount === 0) {
        throw this.#lockError(await meta.findOne({ _id: WRITER_LOCK_ID }).catch(() => null))
      }
    } catch (err) {
      if (err?.code === 'DB_WRITER_LOCK') throw err
      // Duplicate _id means the document exists and our filter didn't match it:
      // somebody live already holds it.
      if (err?.code === 11000) {
        throw this.#lockError(await meta.findOne({ _id: WRITER_LOCK_ID }).catch(() => null))
      }
      throw err
    }

    this.#startHeartbeat()
  }

  /** "Someone else owns the backup" — names who, and how long ago they spoke. */
  #lockError(doc) {
    const h = doc?.holder
    const who = h ? `pid ${h.pid} on "${h.host}"` : 'another process'
    const age = h?.heartbeat ? ` (last heartbeat ${Math.round((Date.now() - h.heartbeat) / 1000)}s ago)` : ''
    const err = new Error(
      `MongoDB "${this.dbName}" is already being backed up by ${who}${age}. ` +
      `This bot keeps playing and saving to ${this.localPath}, but will not replicate over ` +
      `their copy. Stop that process, or point this one at a different MONGO_DB_NAME. ` +
      `A crashed holder frees the lock by itself after ${LOCK_STALE_MS / 1000}s.`
    )
    err.code = 'DB_WRITER_LOCK'
    return err
  }

  /**
   * Keep the lock fresh. If this process dies the beat stops, and after
   * LOCK_STALE_MS any other machine can take the database over on its own —
   * a kill -9 or a power cut never needs manual cleanup.
   */
  #startHeartbeat() {
    if (this.#heartbeatTimer) return
    this.#heartbeatTimer = setInterval(() => {
      void (async () => {
        if (!this.#db || this.#closed) return
        try {
          await this.#db.collection(META_COLLECTION).updateOne(
            { _id: WRITER_LOCK_ID, 'holder.pid': process.pid, 'holder.host': hostname() },
            { $set: { 'holder.heartbeat': Date.now() } },
          )
        } catch { /* a real outage surfaces on the next push; don't double-log */ }
      })()
    }, LOCK_HEARTBEAT_MS)
    this.#heartbeatTimer.unref?.()
  }

  /** Hand the lock back, so a restart doesn't have to wait out the staleness. */
  async #releaseWriterLock() {
    if (!this.#db || this.readOnly || this.allowSecondWriter) return
    try {
      await this.#db.collection(META_COLLECTION).updateOne(
        { _id: WRITER_LOCK_ID, 'holder.pid': process.pid, 'holder.host': hostname() },
        { $unset: { holder: '' } },
      )
    } catch { /* a lock we can't clear goes stale on its own */ }
  }

  // ── For scripts and health checks ───────────────────────────────────────

  /** Connect + lock + fingerprints, on demand. Used by the entry points below. */
  async #ensureReady() {
    if (!this.#db) {
      await this.#connect()
      if (!this.readOnly) await this.#acquireWriterLock()
      await this.#loadFingerprints()
    }
    this.#synced = true
  }

  /**
   * Push and WAIT, surfacing failures. write() deliberately does neither, since
   * a player's command must not fail because a backup did. Scripts are the
   * opposite: a sync that silently didn't happen is the worst outcome there.
   */
  async syncNow(data = this.#lastData) {
    await this.#ensureReady()
    this.#lastData = data
    await this.#pushNow(data, { rethrow: true })
    return { players: Object.keys(data?.users ?? {}).length, at: this.lastSyncedAt }
  }

  /** Everything in the backup as a db.data-shaped object. Never writes the file. */
  async fetchRemote() {
    if (!this.#db) {
      await this.#connect()
      if (!this.readOnly) await this.#acquireWriterLock()
    }
    return await this.#downloadAll()
  }

  /** What's on the cluster right now, for `db-mongo.mjs status` or /health. */
  async stats() {
    if (!this.#db) await this.#connect()
    const meta = this.#db.collection(META_COLLECTION)
    const [players, keys, lock] = await Promise.all([
      this.#db.collection(USERS_COLLECTION).countDocuments(),
      meta.find({ _id: { $ne: WRITER_LOCK_ID } }, { projection: { _id: 1 } }).toArray(),
      meta.findOne({ _id: WRITER_LOCK_ID }),
    ])
    const holder = lock?.holder ?? null
    return {
      players,
      keys: keys.map(d => String(d._id)),
      holder,
      holderLive: holder?.heartbeat ? Date.now() - holder.heartbeat < LOCK_STALE_MS : false,
      ...this.syncState,
    }
  }

  // ── Shutdown ────────────────────────────────────────────────────────────

  /**
   * Last chance to get the newest save off this box: drain whatever push is in
   * flight, run one final diff, hand back the lock, close the socket.
   *
   * Every wait is capped at CLOSE_DRAIN_MS because PM2 follows SIGTERM with
   * SIGKILL a few seconds later — a hung cluster must not be the reason a
   * restart never finishes. The local file is already written either way, so the
   * worst case is the backup missing the last few seconds and catching up on the
   * next boot.
   */
  async close() {
    if (this.#closing) return this.#closing
    this.#closing = (async () => {
      this.#closed = true
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = null
      clearInterval(this.#reconnectTimer)
      this.#reconnectTimer = null

      await raceTimeout(this.#pushChain.catch(() => {}), CLOSE_DRAIN_MS)
      // #schedulePush() is disabled by #closed now, so the final diff goes
      // straight to #pushNow — which never throws unless asked to.
      if (this.#db && !this.readOnly && this.#synced) {
        await raceTimeout(this.#pushNow(this.#lastData), CLOSE_DRAIN_MS)
      }
      await this.#releaseWriterLock()
      await this.#closeClient()
    })()
    return this.#closing
  }

  /** Drop the connection without touching the local file or the close latch. */
  async #closeClient() {
    const client = this.#client
    this.#client = null
    this.#db = null
    this.#synced = false
    if (!client) return
    try { await client.close(true) } catch { /* already gone */ }
  }
}
