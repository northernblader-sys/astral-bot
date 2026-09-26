#!/usr/bin/env node
/**
 * db-mongo.mjs — check on the backup, and move the database between the local
 * db.json and MongoDB by hand.
 *
 * The bot already does this on its own: db.json is the live database and every
 * save is copied up right after it lands on disk (read lib/mongo-adapter.js
 * first — this script is a thin wrapper around that same adapter so the
 * document shape can never drift between the two). What's left for a human is
 * the first upload, a recovery, and "is it actually working?".
 *
 *   node scripts/db-mongo.mjs status            what each side holds right now
 *   node scripts/db-mongo.mjs push [--force]    db.json -> MongoDB
 *   node scripts/db-mongo.mjs pull [--out FILE] MongoDB -> a new local file
 *
 * push makes MongoDB match db.json exactly, and that includes DELETING players
 * that exist up there but not locally. Correct for a replica; wrong if your
 * local file is an old backup — so it refuses, and names the count, unless you
 * pass --force.
 *
 * pull writes db-pull-<timestamp>.json rather than over db.json, so recovering
 * a copy can never clobber the file the bot is currently playing from.
 *
 * status and pull are safe while the bot is live. push is too, in that it will
 * simply be told the bot holds the writer lock and stop without touching data.
 */

import { existsSync, statSync } from 'fs'
import { config } from '../config.js'
import { FastJSONFile } from '../lib/fast-json-adapter.js'
import { ReplicatedJSONFile } from '../lib/mongo-adapter.js'

const [, , rawCommand, ...rest] = process.argv
const command = (rawCommand ?? '').toLowerCase()
const force = rest.includes('--force')
const outIndex = rest.indexOf('--out')
const outPath = outIndex >= 0 ? rest[outIndex + 1] : null

function die(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

if (!config.mongoUri) {
  die('MONGO_URI is not set in .env — there is no backup to talk to. See .env.example.')
}

/** Safe to print: the connection string carries the database password. */
const safeUri = String(config.mongoUri).replace(/\/\/[^@/]*@/, '//<credentials>@')
const players = (data) => Object.keys(data?.users ?? {}).length
const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`

/**
 * readOnly:true never takes the writer lock and never writes db.json, so it is
 * safe against a live bot. push asks for a writer, which is exactly how it
 * discovers the bot is running.
 */
function makeAdapter({ readOnly }) {
  return new ReplicatedJSONFile({
    uri: config.mongoUri,
    dbName: config.mongoDbName,
    localPath: config.dbPath,
    readOnly,
    allowSecondWriter: config.mongoAllowSecondWriter,
    // A script reports; it doesn't narrate the adapter's internal chatter.
    log: () => {},
    warn: (...args) => console.warn(...args),
  })
}

async function status() {
  console.log(`Cluster : ${safeUri}`)
  console.log(`Database: ${config.mongoDbName}`)

  const adapter = makeAdapter({ readOnly: true })
  try {
    const s = await adapter.stats()
    console.log('\nMongoDB backup')
    console.log(`  players    : ${s.players}`)
    console.log(`  other keys : ${s.keys.join(', ') || '(none)'}`)
    if (s.holder) {
      const age = Math.round((Date.now() - s.holder.heartbeat) / 1000)
      console.log(
        `  writer     : pid ${s.holder.pid} on "${s.holder.host}", last beat ${age}s ago ` +
        (s.holderLive ? '(LIVE — that bot is running and backing up)' : '(stale, free to take over)')
      )
    } else {
      console.log('  writer     : nobody holds the lock')
    }
  } catch (err) {
    console.log(`\nMongoDB backup\n  UNREACHABLE: ${err.message}`)
    console.log('  Check Atlas Network Access (is this machine\'s IP allowed?) and the password.')
  } finally {
    await adapter.close()
  }

  console.log(`\nLocal file — this is the live database`)
  console.log(`  path       : ${config.dbPath}`)
  if (!existsSync(config.dbPath)) {
    console.log('  MISSING    : the backup is the only copy left. The bot restores from it on boot.')
    return
  }
  const local = await new FastJSONFile(config.dbPath).read()
  const st = statSync(config.dbPath)
  console.log(`  players    : ${players(local)}`)
  console.log(`  size       : ${mb(st.size)}`)
  console.log(`  modified   : ${st.mtime.toISOString()}`)
}

async function push() {
  if (!existsSync(config.dbPath)) die(`No local database at ${config.dbPath} to push.`)
  const local = await new FastJSONFile(config.dbPath).read()
  const count = players(local)
  if (!local || count === 0) {
    die(`${config.dbPath} has no players in it — refusing to push an empty world over the backup.`)
  }

  const adapter = makeAdapter({ readOnly: false })
  try {
    // fetchRemote() connects and takes the writer lock, so this stops loudly and
    // harmlessly if the bot is live. It also loads real fingerprints, so the
    // push below sends only the players that actually differ.
    const remote = await adapter.fetchRemote()
    const localIds = new Set(Object.keys(local.users ?? {}))
    const orphans = Object.keys(remote.users ?? {}).filter(id => !localIds.has(id))

    console.log(`${config.dbPath} → MongoDB "${config.mongoDbName}"`)
    console.log(`  local  : ${count} players`)
    console.log(`  backup : ${players(remote)} players`)

    if (orphans.length && !force) {
      die(
        `${orphans.length} player(s) are in the backup but not in ${config.dbPath}, and pushing ` +
        `makes the backup match the local file exactly — they would be DELETED.\n` +
        `  If the local file is the newer one, re-run with --force.\n` +
        `  If it might be an old copy, take a backup of the backup first:\n` +
        `    node scripts/db-mongo.mjs pull`
      )
    }

    const { players: pushed } = await adapter.syncNow(local)
    console.log(
      `✅ ${pushed} players pushed — the backup now matches ${config.dbPath}` +
      (orphans.length ? `, and ${orphans.length} player(s) were removed from it.` : '.')
    )
  } finally {
    await adapter.close()
  }
}

async function pull() {
  const target = outPath ?? `./db-pull-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  if (existsSync(target) && !force) {
    die(`${target} already exists — pass --force to overwrite it.`)
  }

  const adapter = makeAdapter({ readOnly: true })
  try {
    const data = await adapter.fetchRemote()
    const count = players(data)
    if (count === 0) die(`MongoDB "${config.mongoDbName}" has no players in it — nothing to pull.`)
    await new FastJSONFile(target).write(data)
    console.log(`✅ Pulled ${count} players from "${config.mongoDbName}" into ${target}`)
    console.log('   This is a copy, not the live database. To actually run on it:')
    console.log(`     stop the bot, put it in place of ${config.dbPath}, start the bot.`)
    console.log(`   Or simply delete ${config.dbPath} — the bot pulls the world back down on boot.`)
  } finally {
    await adapter.close()
  }
}

const commands = { status, push, pull }

if (!commands[command]) {
  console.log('Usage:')
  console.log('  node scripts/db-mongo.mjs status')
  console.log('  node scripts/db-mongo.mjs push [--force]')
  console.log('  node scripts/db-mongo.mjs pull [--out FILE] [--force]')
  process.exit(command ? 1 : 0)
}

try {
  await commands[command]()
  process.exit(0)
} catch (err) {
  console.error(`\n❌ ${command} failed:\n${err?.message ?? err}`)
  process.exit(1)
}
