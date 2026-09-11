/**
 * boot.js — shared startup for every platform entry point.
 *
 * ── The single-writer rule (read this before adding an entry point) ───────
 * lib/player-repo.js:267 documents the invariant this whole bot depends on:
 * ONE process is the only writer of db.json. Its write queue serializes
 * db.read()/db.write() cycles in memory, which works precisely because no
 * other process is touching the file. Two processes on the same db.json each
 * hold a stale snapshot and clobber each other — vanished gold, duplicated
 * items, rolled-back levels.
 *
 * That makes "run Discord as its own PM2 process against the same db" a data
 * corruption bug, not a deployment choice. So there are exactly two supported
 * shapes, and acquireDbLock() enforces the boundary between them:
 *
 *   Shared accounts  → main-all.js. One process, one db, every platform.
 *                      A player's character is the same on all three.
 *   Separate worlds  → main-discord.js / main-telegram.js with their own
 *                      DB_PATH. Independent processes, independent rosters.
 *
 * The lock is what turns a silent corruption into a refusal to start.
 */

import { Low } from 'lowdb'
import { createDbAdapter, describeDbTarget, closeDbAdapter } from '../db-adapter.js'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { config } from '../../config.js'
import { loadPlugins, setActivePlatform } from '../plugin-manager.js'
import { runValidation } from '../../plugins/validate.js'
import { updateAllPlayers, flushPendingWrites } from '../player-repo.js'
import { migrateAllPlayers } from '../stat-progression.js'

export function globalLog(...args) {
  console.log(...args)
}

/**
 * Boot-time failure reporting, written to STDERR so PM2 routes it into
 * pm2-err.log rather than burying it in pm2-out.log among normal output.
 *
 * Takes the Error itself (not just err.message) because the stack is the only
 * thing that identifies WHERE a startup failed — a bare "Unauthorized" in the
 * out log is indistinguishable from a dozen other causes. Mirrors the direct
 * process.stderr.write() that dispatch() already uses for plugin errors.
 *
 * @param {string} label  what failed, e.g. 'Discord failed to start'
 * @param {Error|any} err
 * @param {string[]} hints  actionable lines to print under the stack
 */
export function globalError(label, err, hints = []) {
  const detail = err?.stack ?? err?.message ?? String(err)
  process.stderr.write(
    `[${new Date().toISOString()}] ❌ ${label}\n` +
    `  ${detail.split('\n').join('\n  ')}\n` +
    hints.map(h => `  → ${h}\n`).join('') +
    '\n'
  )
  // Also echo a one-liner to stdout so the startup banner in pm2-out.log
  // stays readable end-to-end without having to cross-reference two files.
  console.log(`❌ ${label}: ${err?.message ?? err}`)
}

/**
 * Refuse to start if another live process already owns this db file.
 *
 * The lockfile records the owning pid. A stale lock (process gone — crash,
 * kill -9, power loss) is reclaimed automatically, so a hard crash never
 * requires manual cleanup. Returns a release function for shutdown.
 */
export function acquireDbLock(dbPath) {
  const lockPath = `${resolve(dbPath)}.lock`

  if (existsSync(lockPath)) {
    let holder = null
    try {
      holder = JSON.parse(readFileSync(lockPath, 'utf8'))
    } catch {
      // Corrupt lockfile is treated as stale — it can't identify an owner.
    }

    if (holder?.pid && isProcessAlive(holder.pid)) {
      globalLog('')
      globalLog('❌ REFUSING TO START — another bot process already owns this database.')
      globalLog(`   Database: ${resolve(dbPath)}`)
      globalLog(`   Held by:  pid ${holder.pid} (${holder.platform ?? 'unknown'}), since ${holder.startedAt ?? 'unknown'}`)
      globalLog('')
      globalLog('   Two processes writing one db.json corrupt each other\'s saves')
      globalLog('   (see the single-writer note in lib/player-repo.js).')
      globalLog('')
      globalLog('   Either:')
      globalLog('     • run every platform in ONE process:  npm run start:all')
      globalLog('     • or give this one its own database:  DB_PATH=./db-discord.json npm run start:discord')
      globalLog('')
      process.exit(1)
    }

    globalLog(`⚠️  Reclaiming stale database lock from dead pid ${holder?.pid ?? '?'}`)
    try { unlinkSync(lockPath) } catch { /* raced with another reclaim — fine */ }
  }

  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    platform: process.env.__BOT_PLATFORM ?? 'unknown',
    startedAt: new Date().toISOString(),
  }, null, 2))

  return function releaseDbLock() {
    try {
      // Only remove a lock we still own — never clear a lock another process
      // legitimately took after we were declared stale.
      const held = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (held.pid === process.pid) unlinkSync(lockPath)
    } catch { /* already gone */ }
  }
}

/** Signal-0 probe: true if a process with this pid exists. */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return err.code === 'EPERM'
  }
}

/**
 * Open the database, backfilling collections older saves may lack.
 *
 * Storage comes from lib/db-adapter.js: always the atomic local-file writer,
 * plus a copy pushed to MongoDB after every save when MONGO_URI is set. Note
 * that once a backup is in play the local acquireDbLock() above is no longer the
 * whole story — a second writer can now be on a different machine entirely,
 * which is why lib/mongo-adapter.js keeps its own heartbeat lock inside the
 * database itself.
 */
export async function initDb(dbPath = config.dbPath) {
  const db = new Low(createDbAdapter(dbPath), { users: {}, sessions: {}, bans: {}, mods: [] })
  await db.read()
  if (!db.data.bans) db.data.bans = {}
  if (!db.data.mods) db.data.mods = []
  await db.write()
  globalLog('💾 Database ready:', describeDbTarget(dbPath))
  return db
}

/**
 * Everything common to booting a platform: validate game data, open the db,
 * migrate players, then load the shared plugin set plus this platform's own.
 *
 * @param {object}  opts
 * @param {string}  opts.platform  'discord' | 'telegram' | 'whatsapp'
 * @param {string}  opts.dbPath
 * @param {string?} opts.pluginDir extra plugin dir (e.g. './plugins-discord')
 */
export async function bootPlatform({ platform, dbPath = config.dbPath, pluginDir = null }) {
  const { passed, errors } = runValidation()
  if (!passed) {
    errors.forEach(e => globalLog('❌ Data validation failure:', e))
    globalLog('❌ Data validation failed — fix all errors above before starting.')
    process.exit(1)
  }
  globalLog('✅ Data validation passed')

  const db = await initDb(dbPath)

  const migrated = await updateAllPlayers(db, users => migrateAllPlayers(users))
  if (migrated) globalLog('📊 Migrated player stat pools to the level-100 progression.')

  // Must precede loadPlugins — the loader consults it to skip plugins this
  // platform can't support (see checkPlatformFit in lib/plugin-manager.js).
  setActivePlatform(platform)

  await loadPlugins('./plugins')
  if (pluginDir) await loadPlugins(pluginDir)

  return db
}

/**
 * Flush queued writes and release the lock on the way out.
 * Wired to SIGINT/SIGTERM so a restart never drops a pending save.
 */
export function installShutdownHandlers({ db, releaseDbLock, onShutdown }) {
  let shuttingDown = false

  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    globalLog(`\n🛑 ${signal} received — shutting down…`)

    try {
      if (typeof onShutdown === 'function') await onShutdown()
      if (db) await flushPendingWrites(db)
      globalLog('💾 Pending writes flushed.')
    } catch (err) {
      globalLog('⚠️ Error during shutdown:', err.message)
    } finally {
      // Hands back the remote writer lock (no-op on a local file) so the next
      // process can take the database over without waiting out the heartbeat.
      await closeDbAdapter()
      releaseDbLock?.()
      process.exit(0)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // A lock left behind by an uncaught crash would block the next start, so
  // release it here too — the stale-pid reclaim is the backstop, not the plan.
  process.on('uncaughtException', err => {
    globalLog('💥 Uncaught exception:', err.stack ?? err.message)
    releaseDbLock?.()
    process.exit(1)
  })
}
