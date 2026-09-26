/**
 * db-adapter.js — the one place that decides WHERE the database lives.
 *
 * MONGO_URI set   → the local file is still the live database, and every save is
 *                   copied up to MongoDB right after it lands on disk
 *                   (lib/mongo-adapter.js). Same file, same latency, plus an
 *                   off-box replica that survives the folder being deleted.
 * MONGO_URI unset → the original local-file behaviour, byte for byte.
 *
 * Both entry points that open a Low instance (main.js and
 * lib/platform/boot.js) go through here, so they can't drift apart the way
 * they had already started to: main.js was using the atomic FastJSONFile
 * while boot.js was still on lowdb's stock JSONFile.
 */

import { resolve } from 'path'
import { config } from '../config.js'
import { FastJSONFile } from './fast-json-adapter.js'
import { ReplicatedJSONFile } from './mongo-adapter.js'

/** The adapter the bot is actually writing through, for shutdown. */
let activeAdapter = null

/**
 * @param {string} dbPath        the live local database file
 * @param {object} [opts]
 * @param {boolean} [opts.readOnly] never write, never take the writer lock
 *                                  (for scripts and one-off inspection)
 * @param {Function} [opts.log]     info logger (main.js passes globalLog)
 * @param {Function} [opts.warn]    warning logger (main.js passes stderr)
 */
export function createDbAdapter(dbPath = config.dbPath, { readOnly = false, log, warn } = {}) {
  const adapter = config.mongoUri
    ? new ReplicatedJSONFile({
        uri: config.mongoUri,
        dbName: config.mongoDbName,
        localPath: dbPath,
        // Cluster mode makes every node a writer, so it implies the lock bypass.
        allowSecondWriter: config.mongoAllowSecondWriter || config.clusterMode,
        readOnly,
        ...(log ? { log } : {}),
        ...(warn ? { warn } : {}),
      })
    : new FastJSONFile(dbPath)

  if (!readOnly) activeAdapter = adapter
  return adapter
}

/** True when saves are being copied to a database off this machine. */
export function isRemoteDb() {
  return Boolean(config.mongoUri)
}

/**
 * Where the data actually is, for the startup banner. Never includes the
 * connection string — that holds the database password.
 */
export function describeDbTarget(dbPath = config.dbPath) {
  return config.mongoUri
    ? `${resolve(dbPath)} (backed up to MongoDB "${config.mongoDbName}" after every save)`
    : resolve(dbPath)
}

/**
 * Flush the last save to the backup, release the remote writer lock, and close
 * the connection on the way out. No-op for the local-file adapter, so shutdown
 * paths can call it blind.
 */
export async function closeDbAdapter() {
  const adapter = activeAdapter
  activeAdapter = null
  if (typeof adapter?.close !== 'function') return
  try {
    await adapter.close()
  } catch { /* shutting down anyway */ }
}
