//
//   ⚔️  RPGBOT — MAIN CONNECTION  ⚔️
//
//   Runs one or more WhatsApp numbers (see config.js's `bots` array) as
//   independent Baileys sockets INSIDE THIS SINGLE PROCESS, all sharing one
//   `db` (config.dbPath). Running them as one process — instead of one PM2
//   process per number — is deliberate: lib/player-repo.js's write queue
//   only serializes db.read()/db.write() cycles within a single process.
//   Two separate processes hammering the same db.json can each read a
//   stale snapshot and clobber each other's writes (lost gold, vanished
//   items — see the warning already written into player-repo.js about this
//   exact failure mode). One process, one in-memory writeQueue, one file =
//   safe. Two numbers are just two sockets sharing that one queue.
//

import { seedRuntimeData, IS_PERSISTENT } from './lib/runtime-paths.js'
import './lib/fonts.js' // registers bundled fonts before any canvas draw — see lib/fonts.js
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  Browsers,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { Low } from 'lowdb'
import { createDbAdapter, describeDbTarget, closeDbAdapter } from './lib/db-adapter.js'
import { mkdir, readdir, readFile, stat, unlink } from 'fs/promises'
import { mkdirSync, createWriteStream, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join as pathJoin, dirname as pathDirname } from 'path'
import { fileURLToPath } from 'url'
import { config, bots } from './config.js'
import { wrapSendWithRateLimit } from './lib/send-rate-limiter.js'
import { setHealthProvider } from './lib/bot-health.js'
import { loadPlugins } from './lib/plugin-manager.js'
import { makeHandler } from './handler.js'
import { flushPendingWrites } from './lib/player-repo.js'
import { runValidation } from './plugins/validate.js'
import { getGroupSettings } from './lib/group-settings.js'
import { getPremiumGroups, removePremiumGroup } from './lib/premium-groups.js'
import { isPremiumActive, expirePremiumIfDue } from './lib/premium.js'
import { inventoryOverflow, checkOverflowGrace, planOverflowShed, applyOverflowShed, summarizeItemIds, OVERFLOW_GRACE_MS } from './lib/inventory-limits.js'
import { storageCap } from './lib/housing-engine.js'
import { allItems } from './lib/game-data.js'
import { pushNotificationSync } from './lib/notification-repo.js'
import { isOwnerJid } from './lib/group-helpers.js'
import { updateAllPlayers, getPlayer } from './lib/player-repo.js'
import { migrateAllPlayers } from './lib/stat-progression.js'
import { getCardSpawnGroups, removeCardSpawnGroup } from './lib/card-spawn-groups.js'
import { fetchSpawnCard, tierStars, cardSellPrice } from './lib/card-engine.js'
import { setActiveSpawn } from './lib/card-spawn-state.js'
import { getSeriesSpawnGroups, removeSeriesSpawnGroup } from './lib/series-spawn-groups.js'
import { fetchRandomSeries, getSeriesTier, seriesTierEmoji, seriesTierStars, generateSeriesClaimCode } from './lib/series-engine.js'
import { setActiveSeriesSpawn } from './lib/series-spawn-state.js'
import { getPokemonSpawnGroups, removePokemonSpawnGroup } from './lib/pokemon-spawn-groups.js'
import { fetchRandomPokemon, formatTypes } from './lib/pokemon-engine.js'
import { setActiveSpawn as setActivePokemonSpawn, getActiveSpawn as getActivePokemonSpawn, clearActiveSpawn as clearActivePokemonSpawn } from './lib/pokemon-spawn-state.js'
import { inPokeBattle, handlePokeBattleTimeout } from './plugins/pokebattle.js'
import { syncSeasonLifecycle } from './lib/season-engine.js'
import { isNightMode, onNightModeOff } from './lib/night-mode.js'
import { initAbsoluteSpawnTimer } from './lib/spawn-timer.js'
import { listStorySlots, releaseStorySlot } from './lib/moderation-state.js'
import {
  CARD_SPAWN_INTERVAL_MS,
  SERIES_SPAWN_INTERVAL_MS,
  POKEMON_SPAWN_INTERVAL_MS,
  POKEMON_SPAWN_FLEE_MS,
  humanInterval,
} from './lib/spawn-intervals.js'
// NOT a static import. lib/api-server.js pulls in express, cors,
// cookie-parser and jsonwebtoken — if any of those aren't installed yet
// (fresh clone, `npm install` not run, a failed install), a static import
// here would throw MODULE_NOT_FOUND at load time and take the ENTIRE BOT
// down with it. The website is an add-on; the bot has to survive without
// it. Loaded lazily in main() instead, inside a try/catch.
let startApiServer = null

// ── Kill Baileys internal spam ────────────────────────────────────────────
// Baileys' signal-session internals log a lot of low-value noise straight to
// stdout/stderr even with a silent logger passed in. Filter it at the stream
// level so it never reaches the terminal or the log files.
const SPAM_PATTERNS = [
  'Closing session', 'SessionEntry', 'baseKey', 'baseKeyType',
  'pendingPreKey', 'signedKeyId', 'preKeyId', 'remoteIdentityKey',
  'ephemeralKeyPair', 'currentRatchet', 'registrationId', '_chains',
  'chainKey', 'chainType', 'messageKeys', 'rootKey', '<Buffer',
  'pubKey', 'privKey', 'previousCounter', 'indexInfo',
  'Closing open session', 'Decrypted message with closed session',
  'Failed to decrypt', 'Session error', 'Bad MAC', 'SessionCipher',
  'decryptWithSessions', 'verifyMAC', 'asyncQueueExecutor', 'closed session',
  'Connection Closed', 'rate-overlimit',
]
function isSpam(str) {
  if (typeof str !== 'string') return false
  return SPAM_PATTERNS.some(p => str.includes(p))
}
const _stdoutWrite = process.stdout.write.bind(process.stdout)
const _stderrWrite = process.stderr.write.bind(process.stderr)
process.stdout.write = (chunk, ...args) => {
  if (isSpam(String(chunk))) return true
  return _stdoutWrite(chunk, ...args)
}
process.stderr.write = (chunk, ...args) => {
  if (isSpam(String(chunk))) return true
  return _stderrWrite(chunk, ...args)
}

// ── Silent Baileys logger ─────────────────────────────────────────────────
const silentLogger = {
  level: 'silent',
  trace: () => {}, debug: () => {}, info:  () => {},
  warn:  () => {}, error: () => {}, fatal: () => {},
  child: () => silentLogger,
}

// ── Global (not-instance-specific) log helper ───────────────────────────────
// Normal informational logs still go to stdout (pm2-out.log).
function globalLog(...args) {
  const line = `[${new Date().toISOString()}] ` + args.join(' ') + '\n'
  _stdoutWrite(line)
}

// Crash-level logs go to stderr on purpose, so PM2 puts them in
// pm2-err.log — this is what you should be checking when the bot goes
// quiet / stops responding.
function globalErrorLog(...args) {
  const line = `[${new Date().toISOString()}] ` + args.join(' ') + '\n'
  _stderrWrite(line)
}

// ── Global error guards ────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  globalErrorLog('💥 uncaughtException:', err?.message ?? err)
  globalErrorLog('📍 Stack trace:\n' + (err?.stack ?? '(no stack)'))
})
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason)
  if (msg === 'Connection Closed' || msg === 'rate-overlimit') return
  globalErrorLog('💥 unhandledRejection:', msg)
  globalErrorLog('📍 Stack trace:\n' + (reason?.stack ?? '(no stack)'))
})

// ── Graceful shutdown (PM2 / VPS signals) ───────────────────────────────────
// Set once main() finishes initDb() — lets shutdown flush any write that's
// still sitting in player-repo.js's debounce window instead of losing up to
// FLUSH_DEBOUNCE_MS worth of the most recent mutations on restart/deploy.
let _dbRef = null

// Exported so main-all.js can reuse the ONE Low instance main() opens instead
// of calling initDb() again. A second Low instance on the same db.json runs its
// own steno write cycle (write .db.json.tmp → rename onto db.json) with no lock
// shared with this one; two of those overlapping is what produced
// "ENOENT: no such file or directory, rename '.db.json.tmp' -> './db.json'".
// Returns null until main()'s initDb() resolves — callers poll for it.
export function getDb() {
  return _dbRef
}

let _isShuttingDown = false
async function gracefulShutdown(signal) {
  if (_isShuttingDown) return
  _isShuttingDown = true
  globalLog('🛑', signal, 'received — shutting down gracefully...')
  if (_dbRef) {
    try {
      await flushPendingWrites(_dbRef)
      globalLog('💾 Pending database writes flushed.')
    } catch (err) {
      globalLog('⚠️ Failed to flush pending writes on shutdown:', err?.message ?? err)
    }
  }
  // Hand the remote writer lock back so a redeploy can take over immediately
  // instead of waiting for the heartbeat to go stale. No-op on local files.
  await closeDbAdapter()
  globalLog('✅ Shutdown complete.')
  process.exit(0)
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT',  () => gracefulShutdown('SIGINT'))

// ── Database (ONE shared db for every bot instance) ─────────────────────────
async function initDb() {
  // Storage is chosen by lib/db-adapter.js, not hardcoded here. Either way
  // config.dbPath is the live database, written by the same atomic writer as
  // before (lib/fast-json-adapter.js — no pretty-printing, temp file +
  // rename); with MONGO_URI set in .env, each save is additionally copied up
  // to MongoDB right after it lands, so losing this box no longer loses the
  // players. The read()/write() contract is identical in both cases, so the
  // shared write queue in lib/player-repo.js, and every plugin above it, is
  // untouched.
  // Move/keep mutable state on the persistent volume BEFORE anything reads
  // it. On Railway the container is rebuilt from GitHub each deploy, so any
  // state written back into the repo's ./data (group settings, moderation,
  // spawn lists) and ./db.json reverts on the next push unless it lives on a
  // mounted volume. seedRuntimeData() copies the existing files across once,
  // then leaves the volume authoritative forever after. No volume mounted =
  // no-op, identical to the old behaviour. See lib/runtime-paths.js.
  seedRuntimeData(globalLog)
  if (!IS_PERSISTENT) {
    globalLog(
      '⚠️ State is stored inside the deployment (./data, ./db.json). On Railway this ' +
      'resets on every redeploy — mount a volume and set RUNTIME_DATA_DIR=/data to keep it.',
    )
  }

  const adapter = createDbAdapter(config.dbPath, { log: globalLog, warn: globalErrorLog })
  // Default structure — expand when RPG features are added
  const db = new Low(adapter, { users: {}, sessions: {}, bans: {}, mods: [] })
  await db.read()
  // Low's default data only applies on first-ever creation of db.json — an
  // existing db.json from before the ban feature won't have `bans` at all,
  // so backfill it here rather than crashing every ban lookup on undefined.
  if (!db.data.bans) db.data.bans = {}
  // Same backfill for `mods` (global mod list — see lib/mod-repo.js),
  // added after ban support.
  if (!db.data.mods) db.data.mods = []
  await db.write()
  globalLog('💾 Database ready (shared by all bot instances):', describeDbTarget(config.dbPath))
  return db
}

// ── Auth-state integrity check ───────────────────────────────────────────
//
// useMultiFileAuthState() (@whiskeysockets/baileys/lib/Utils/use-multi-file-
// auth-state.js) writes creds.json with a bare fs/promises.writeFile() — no
// temp-file + rename, no fsync. If the process dies mid-write (crash, OOM-
// kill, `pm2 restart` racing a creds.update save, two sockets briefly
// sharing one auth folder — see the single-writer note atop this file) the
// file on disk can be left truncated or half-written.
//
// Worse: Baileys' own readData() catches every error from that read —
// ENOENT, EACCES, a JSON.parse syntax error, all of it — and returns null
// (use-multi-file-auth-state.js, the try/catch around readFile+JSON.parse).
// useMultiFileAuthState() then does `(await readData('creds.json')) ||
// initAuthCreds()`, so a CORRUPTED file and a MISSING file produce the
// exact same result: a silent, brand-new, never-registered identity. There
// is no warning, no thrown error, nothing — the bot just quietly starts
// what looks like a fresh pairing on a folder that used to hold a real,
// working session, and nothing in this file's own logs would say why.
//
// This also isn't purely a "bad shutdown" story. CVE-2026-48063 /
// GHSA-qvv5-jq5g-4cgg (Critical, patched in Baileys 6.7.22 — see
// package.json) describes a crafted payload that can, among other things,
// "corrupt the app state sync system by sending fake key shares." That is
// a second, independent way this exact file can end up in a broken state
// without the process ever crashing at all. Upgrading past 6.7.22 closes
// that hole; this check exists for whatever reaches creds.json next
// regardless of cause, including the plain non-atomic-write risk above,
// which the Baileys maintainers have never claimed to have solved (their
// own doc comment: "I wouldn't endorse this for any production level use").
//
// Distinguishes three states rather than a plain boolean, because "no file
// yet" (first-ever pairing) and "file exists but is garbage" (something
// broke) need very different log messages — the first is completely
// normal and the second is exactly the silent failure this whole block
// exists to surface.
//
//   ok        — creds.json is absent (fresh pairing) or present, parses,
//               and has the fields every real creds object has.
//   corrupted — creds.json exists but failed to read as JSON, or parsed to
//               something that isn't a real creds object.
//
// Read directly with fs/promises.readFile rather than trusting
// state.creds after useMultiFileAuthState() has already run, precisely
// because that function's own null-swallowing (above) is what hides the
// problem — by the time state.creds exists, a corrupted file already looks
// identical to no file at all.
const CREDS_REQUIRED_FIELDS = [
  // Fields initAuthCreds() (auth-utils.js) always sets, whether this is a
  // brand-new identity or one freshly loaded from disk. A real creds.json,
  // corrupted or not, has all of these; a stray unrelated JSON blob or a
  // truncated fragment is very unlikely to happen to have every one.
  'noiseKey', 'signedIdentityKey', 'signedPreKey', 'registrationId', 'advSecretKey',
]

async function checkCredsIntegrity(authFolder) {
  // Baileys' own fixFileName() (use-multi-file-auth-state.js) is just
  // this — no colons or slashes ever appear in the literal name
  // 'creds.json', but matching the real function instead of hardcoding
  // the joined path keeps this from silently drifting if that ever changes.
  const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-')
  const credsPath = pathJoin(authFolder, fixFileName('creds.json'))

  let raw
  try {
    raw = await readFile(credsPath, { encoding: 'utf-8' })
  } catch (err) {
    if (err?.code === 'ENOENT') return { status: 'ok', reason: 'no creds.json yet (fresh pairing)' }
    // Anything else reading the file (EACCES, EISDIR, a full disk on a
    // partial read) is exactly as suspicious as a parse failure below —
    // Baileys' own readData() would swallow this too and hand back null.
    return { status: 'corrupted', reason: `could not read creds.json: ${err.message}` }
  }

  let parsed
  try {
    // Deliberately NOT using Baileys' BufferJSON.reviver here — this check
    // only needs to confirm the JSON is well-formed and has the right top-
    // level keys, not reconstruct real Buffer/Uint8Array values. Plain
    // JSON.parse is enough to catch a truncated write, which is the
    // failure mode this exists for.
    parsed = JSON.parse(raw)
  } catch (err) {
    return { status: 'corrupted', reason: `creds.json is not valid JSON (${err.message}) — most likely a truncated write from a process that died mid-save` }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { status: 'corrupted', reason: 'creds.json parsed but is not an object' }
  }

  const missing = CREDS_REQUIRED_FIELDS.filter((f) => !(f in parsed))
  if (missing.length > 0) {
    return { status: 'corrupted', reason: `creds.json is missing expected field(s): ${missing.join(', ')} — file exists and parses but doesn't look like a real session` }
  }

  return { status: 'ok', reason: 'creds.json present and looks valid' }
}

/**
 * True for ids a Baileys socket can actually send to.
 *
 * The spawn snapshot lists (data/card-spawn-groups.json and friends) are
 * written by plugins/waifu.js, plugins/series.js and plugins/pokeswitch.js,
 * and in combined mode (main-all.js) those same plugins run on Discord and
 * Telegram too — so a Telegram group that runs `.waifu on` lands its own
 * `tg:-100…` id in the list this WhatsApp sweep reads. Sending to it fails
 * every single sweep, forever, with a logged error per run.
 *
 * Skipped, deliberately NOT removed: the list is the other platform's record
 * of that toggle as well, and removing the entry here would silently turn the
 * feature off for them.
 */
function isWhatsAppJid(jid) {
  return typeof jid === 'string' && (
    jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')
  )
}

// ── Card auto-spawn sweep ────────────────────────────────────────────────
// Every hour, spawns one card in each group that has `.waifu on` active
// (see plugins/waifu.js and lib/card-spawn-groups.js). Always spawns on
// schedule regardless of whether the previous spawn was claimed — an
// unclaimed spawn is simply overwritten by the new one. Runs once globally
// (not once per bot instance) and sends via whichever socket is currently
// connected —
// picking the first live one avoids the same card spawning twice (once per
// number) in a group that only one of the bots is actually in.
// (Interval constants now live in lib/spawn-intervals.js — imported above —
// so the "spawns every X" strings in the toggle plugins can't drift from the
// real sweep cadence.)

async function runCardSpawnSweep(instances) {
  // Night mode (`.night on`) pauses every auto-spawn sweep — see
  // lib/night-mode.js. Checked here rather than by clearing the interval so the
  // cadence is never rescheduled: the sweep just no-ops until morning, then
  // picks up on its normal beat with nothing queued or replayed.
  if (isNightMode()) return
  const sock = instances.map(i => i.activeSock).find(Boolean)
  if (!sock) return

  const groupJids = await getCardSpawnGroups()
  for (const groupJid of groupJids) {
    if (!isWhatsAppJid(groupJid)) continue
    try {
      const settings = await getGroupSettings(groupJid)
      if (!settings.cardsEnabled) {
        // Turned off directly via group-settings without `.waifu off` —
        // drop it from the snapshot list too so it stops being swept.
        await removeCardSpawnGroup(groupJid)
        continue
      }

      const card = await fetchSpawnCard()
      if (!card) continue

      setActiveSpawn(groupJid, card)
      await sock.sendMessage(groupJid, {
        image: { url: card.imageUrl },
        caption:
          `🎴 *A WILD CARD APPEARED!*\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `✨ *${card.title}*\n` +
          `📺 _${card.series}_\n` +
          `${tierStars(card.tier)}  ·  💰 *${cardSellPrice(card.tier).toLocaleString()}* Solars\n\n` +
          `🎯 First to type *${config.prefix}collect ${card.claim}* claims it!`,
      }).catch(err => {
        globalLog(`⚠️ Card spawn: failed to send in ${groupJid}:`, err.message)
      })
    } catch (err) {
      globalLog(`⚠️ Card spawn: failed processing group ${groupJid}:`, err.message)
    }
  }
}

// ── Anime Series auto-spawn sweep ──────────────────────────────────────────
// Every 2 hours, spawns one series in each group that has `.series on` active.
// Mirrors the card spawn sweep's error-handling pattern exactly.
// (SERIES_SPAWN_INTERVAL_MS imported from lib/spawn-intervals.js.)

async function runSeriesSpawnSweep(instances) {
  // Night mode (`.night on`) pauses every auto-spawn sweep — see
  // lib/night-mode.js. Checked here rather than by clearing the interval so the
  // cadence is never rescheduled: the sweep just no-ops until morning, then
  // picks up on its normal beat with nothing queued or replayed.
  if (isNightMode()) return
  const sock = instances.map(i => i.activeSock).find(Boolean)
  if (!sock) return

  const groupJids = await getSeriesSpawnGroups()
  for (const groupJid of groupJids) {
    if (!isWhatsAppJid(groupJid)) continue
    try {
      const settings = await getGroupSettings(groupJid)
      if (!settings.seriesEnabled) {
        // Turned off directly without `.series off` — drop from snapshot list too.
        await removeSeriesSpawnGroup(groupJid)
        continue
      }

      const series = await fetchRandomSeries()
      if (!series) continue

      const tier = getSeriesTier(series.score)
      const code = generateSeriesClaimCode()
      const spawn = { ...series, tier: tier.name, claimCode: code }

      setActiveSeriesSpawn(groupJid, spawn)

      const score = series.score != null ? `${series.score.toFixed(1)}⭐` : 'Unrated'
      await sock.sendMessage(groupJid, {
        image: { url: series.imageUrl },
        caption:
          `📺 *AN ANIME SERIES APPEARED!*\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `${seriesTierEmoji(tier.name)} ${seriesTierStars(tier.name)} *${series.title}*\n` +
          `🏅 Score ${score}  ·  Tier *${tier.name}*\n\n` +
          `🎯 First to type *${config.prefix}collect ${code}* claims it!`,
      }).catch(err => {
        globalLog(`⚠️ Series spawn: failed to send in ${groupJid}:`, err.message)
      })
    } catch (err) {
      globalLog(`⚠️ Series spawn: failed processing group ${groupJid}:`, err.message)
    }
  }
}

// ── Wild Pokémon auto-spawn sweep ──────────────────────────────────────────
// Every 1 hour 30 minutes, spawns one wild Pokémon in each group that has
// `.pokeswitch on` active. Mirrors the card/series spawn sweeps' structure
// and error-handling pattern exactly — see runCardSpawnSweep above.
// (POKEMON_SPAWN_INTERVAL_MS / POKEMON_SPAWN_FLEE_MS imported from
// lib/spawn-intervals.js — the flee line below is derived from the constant.)

async function runPokemonSpawnSweep(instances) {
  // Night mode (`.night on`) pauses every auto-spawn sweep — see
  // lib/night-mode.js. Checked here rather than by clearing the interval so the
  // cadence is never rescheduled: the sweep just no-ops until morning, then
  // picks up on its normal beat with nothing queued or replayed.
  if (isNightMode()) return
  const sock = instances.map(i => i.activeSock).find(Boolean)
  if (!sock) return

  const groupJids = await getPokemonSpawnGroups()
  for (const groupJid of groupJids) {
    if (!isWhatsAppJid(groupJid)) continue
    try {
      const settings = await getGroupSettings(groupJid)
      if (!settings.pokemonEnabled) {
        // Turned off directly without `.pokeswitch off` — drop from snapshot list too.
        await removePokemonSpawnGroup(groupJid)
        continue
      }

      const pokemon = await fetchRandomPokemon()
      if (!pokemon) continue

      setActivePokemonSpawn(groupJid, pokemon)

      const shinyTag = pokemon.isShiny ? '✨ *SHINY ENCOUNTER!* ✨\n' : ''
      await sock.sendMessage(groupJid, {
        image: { url: pokemon.image },
        caption:
          `${shinyTag}🐾 *A WILD POKÉMON APPEARED!*\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `*${pokemon.name}*  ·  ${formatTypes(pokemon.types)}\n\n` +
          `🫀 HP ${pokemon.hp}   ⚔️ ATK ${pokemon.atk}\n` +
          `🛡️ DEF ${pokemon.def}   💨 SPD ${pokemon.spd}\n\n` +
          `🎯 First to type *${config.prefix}collect ${pokemon.claim}* catches it!\n` +
          `⏳ _Flees in ${humanInterval(POKEMON_SPAWN_FLEE_MS)}._`,
      }).catch(err => {
        globalLog(`⚠️ Pokémon spawn: failed to send in ${groupJid}:`, err.message)
      })

      // Auto-flee after the window — same "still the same spawn" guard
      // pattern the reference bot used, adapted to this bot's spawn-state
      // shape (compares claim code rather than a mongoose _id).
      setTimeout(() => {
        const stillActive = getActivePokemonSpawn(groupJid)
        if (stillActive?.claim === pokemon.claim) {
          clearActivePokemonSpawn(groupJid)
          sock.sendMessage(groupJid, { text: `💨 The wild *${pokemon.name}* fled away!` }).catch(() => {})
        }
      }, POKEMON_SPAWN_FLEE_MS)
    } catch (err) {
      globalLog(`⚠️ Pokémon spawn: failed processing group ${groupJid}:`, err.message)
    }
  }
}

// ── Temp image file auto-cleanup sweep ──────────────────────────────────────
// Sticker and ffmpeg conversions write temp files and clean them up in
// finally blocks. But if the process crashes mid-conversion the finally
// never runs, leaving orphan files that pile up and eventually cause ENOSPC.
// This sweep runs every 3 minutes and deletes any file in the temp dirs
// that is older than 5 minutes — safely past any legitimate in-flight use.
const TEMP_CLEANUP_INTERVAL_MS = 3 * 60_000   // every 3 minutes
const TEMP_FILE_MAX_AGE_MS     = 5 * 60_000   // delete files older than 5 min

const _mainDir   = pathDirname(fileURLToPath(import.meta.url))
const TEMP_DIRS  = [
  pathJoin(_mainDir, 'temp'),
  pathJoin(tmpdir(), 'astral-sticker'),
]

async function runTempCleanupSweep() {
  const cutoff = Date.now() - TEMP_FILE_MAX_AGE_MS
  let removed = 0
  for (const dir of TEMP_DIRS) {
    if (!existsSync(dir)) continue
    let entries
    try { entries = await readdir(dir) } catch { continue }
    for (const entry of entries) {
      const full = pathJoin(dir, entry)
      try {
        const info = await stat(full)
        if (info.isFile() && info.mtimeMs < cutoff) {
          await unlink(full)
          removed++
        }
      } catch { /* already gone — fine */ }
    }
  }
  if (removed > 0) globalLog(`🧹 Temp cleanup: removed ${removed} orphaned image file(s)`)
}

// ── Pokémon battle turn-timeout sweep (Pokémon overhaul §3.2 step 4) ────────
// Every 20s, scans every player currently inPokeBattle() for a
// pokemonBattleState.turnDeadline that has passed while pendingMove is still
// null — i.e. they never called .move in time. That player's whole match is
// forfeited via handlePokeBattleTimeout() (plugins/pokebattle.js), which
// routes through the same pokebattleConclude() an explicit .pokebattle
// forfeit uses, so wins/losses/HP-heal/state-clear all stay in one place.
//
// Read-only scan against the already-loaded db.data.users — deliberately
// NOT wrapped in updateAllPlayers()/updatePlayer(), because
// handlePokeBattleTimeout() -> pokebattleConclude() makes its own sequential
// top-level updatePlayer() calls per player; nesting those inside this
// sweep's own mutator would deadlock against the shared write queue exactly
// like the long comment block atop plugins/pokebattle.js's
// resolvePokeBattleTurn() explains for its own turn-resolution flow. A
// snapshot read (each entry read fresh off db.data.users, not cached
// player objects held across the sweep) is enough here since the actual
// conclusion itself performs its own fresh updatePlayer() reads/writes and
// is naturally idempotent against a double-timeout race (the loser's
// inPokemonBattle/pokemonBattleState is cleared inside that same
// updatePlayer call, so a second sweep tick sees them already out of battle
// and simply skips them).
//
// Each JID is only processed once per sweep tick even though both sides of
// a battle would otherwise independently satisfy the "timed out" check —
// see the `handled` Set below.
const POKEBATTLE_TIMEOUT_SWEEP_INTERVAL_MS = 20_000 // 20 seconds

async function runPokeBattleTimeoutSweep(instances, db) {
  const sock = instances.map(i => i.activeSock).find(Boolean)
  if (!sock) return

  const now = Date.now()
  const users = db.data.users ?? {}
  const handled = new Set()

  for (const [jid, player] of Object.entries(users)) {
    if (handled.has(jid)) continue
    if (!inPokeBattle(player)) continue

    const bs = player.pokemonBattleState
    if (!bs?.turnDeadline || now < bs.turnDeadline) continue
    if (bs.pendingMove) continue // already locked in — not a timeout, just hasn't resolved yet

    const opponentJid = bs.opponentJid
    if (!opponentJid) continue

    handled.add(jid)
    handled.add(opponentJid)

    // Minimal synthetic ctx — handlePokeBattleTimeout()/pokebattleConclude()
    // only ever calls ctx.reply(text), so a bare sock.sendMessage wrapper is
    // enough; no msg/quoted context exists for a sweep-initiated message.
    // Sent to the timed-out player's own JID (DM), matching how every other
    // sweep in this file sends via whichever socket is currently connected.
    const ctx = {
      reply: (text) => sock.sendMessage(jid, { text: String(text) }, {}),
    }

    try {
      await handlePokeBattleTimeout(db, ctx, jid, opponentJid, player.name ?? 'Trainer')
    } catch (err) {
      globalLog(`⚠️ Pokébattle timeout: failed resolving ${jid} vs ${opponentJid}:`, err.message)
    }
  }
}


// ── Story Mode slot timeout sweep ────────────────────────────────────────
// Every group has at most one active Story Mode slot (see
// lib/moderation-state.js's storySlots + plugins/story.js's claimStorySlot
// call in .story enter/start). If the holder goes STORY_SLOT_TIMEOUT_MS
// without running a story command (enter/start, or answering a pending
// choice — both bump lastActivityAt), the SLOT is freed so the next person
// isn't stuck waiting on someone who walked away.
//
// ── It no longer removes anyone from the group (2026-09 fix) ─────────────
// This used to call groupParticipantsUpdate(..., 'remove'): going quiet for
// five minutes mid-story got you thrown out of the entire WhatsApp group.
// That was never the intent — the scarce thing is the story slot, not
// membership — and it was punishing people for a slow reply, a dropped
// connection, or simply reading. Freeing the slot achieves everything the
// sweep is for. Removing someone from a group stays where it belongs: a
// deliberate admin action via `.kick`.
//
// Poll-based like every other sweep in this file rather than a per-user
// setTimeout, so a PM2 restart mid-wait doesn't lose the timeout — the next
// tick just checks lastActivityAt against the clock same as always.
//
// The timeout is generous on purpose: a chapter is something you read, and
// the old 5 minutes treated a normal reading pace as "walked away".
const STORY_SLOT_TIMEOUT_MS = 15 * 60_000 // 15 minutes
const STORY_SLOT_SWEEP_INTERVAL_MS = 30_000 // check every 30s

async function runStorySlotTimeoutSweep(instances, db) {
  const slots = await listStorySlots()
  if (!slots.length) return

  const now = Date.now()
  for (const [groupJid, rec] of slots) {
    if (now - rec.lastActivityAt < STORY_SLOT_TIMEOUT_MS) continue

    const userJid = rec.userJid
    await releaseStorySlot(groupJid)

    // Announce in the group that the slot is open — never touch membership.
    let sock = null
    for (const inst of instances) {
      if (!inst.activeSock) continue
      try {
        await inst.activeSock.groupMetadata(groupJid)
        sock = inst.activeSock
        break
      } catch {
        // this instance isn't in the group — try the next one
      }
    }
    if (!sock) continue

    const bareTag = userJid.replace(/@.*$/, '')
    const idleMin = Math.round(STORY_SLOT_TIMEOUT_MS / 60_000)
    try {
      await sock.sendMessage(groupJid, {
        text:
          `📖 *Story slot released*\n` +
          `─────────────────────\n` +
          `@${bareTag} was idle for ${idleMin} minutes, so the slot is now free ` +
          `for someone else.\n\n` +
          `_Nobody was removed from the group — your progress is saved exactly ` +
          `where you left it._\n\n` +
          `▸ *${config.prefix}story start* — @${bareTag}, pick your chapter straight back up\n` +
          `▸ *${config.prefix}story enter <volume>* — anyone else, the slot is yours\n` +
          `▸ *${config.prefix}story* — volume list and how it all works`,
        mentions: [userJid],
      }, {})
      globalLog(`📖 Story slot timeout: released ${userJid}'s slot in ${groupJid} (no removal)`)
    } catch (err) {
      globalLog(`⚠️ Story slot timeout: released the slot but couldn't post in ${groupJid}:`, err.message)
    }
  }
}


// Runs once globally against the shared db (not once per bot instance —
// player premium state isn't per-number, so sweeping it twice would just be
// redundant work on the same shared writeQueue). Group removal actions are
// performed via whichever bot instance is actually a member of that group.
const PREMIUM_SWEEP_INTERVAL_MS = 15 * 60_000 // 15 minutes

/**
 * Resolves bags left over their cap by a premium lapse. Warn first, shed later:
 *
 *   - over cap, no deadline yet -> stamp a 48h deadline and post a bell notice.
 *     Nothing in the bag is touched. handler.js repeats this in chat on their
 *     own commands so the warning cannot be missed.
 *   - over cap, deadline still running -> leave them alone, it's their time.
 *   - over cap, deadline passed -> shed the cheapest items: into house storage
 *     if it has room, sold at shop price if not, destroyed only if neither is
 *     possible. The receipt is parked on `player.inventoryShed` for handler.js
 *     to deliver in chat once, so this sweep never touches a socket and can
 *     never turn into a fan-out of DMs.
 *   - back under cap on their own -> the stale deadline is dropped, so a future
 *     lapse starts a fresh 48h rather than shedding on the spot.
 *
 * Premium players are skipped entirely: their cap is the higher one and the
 * whole mechanism exists to clean up after it dropping. One updateAllPlayers
 * pass, so all of it lands in a single serialized write alongside the expiry
 * flags from the caller. Never throws on a player with no inventory or house.
 */
async function runInventoryOverflowSweep(db) {
  const now = Date.now()
  const tally = { warned: 0, shed: 0, cleared: 0 }

  await updateAllPlayers(db, (users) => {
    let changed = false
    for (const [jid, player] of Object.entries(users)) {
      if (!player || isPremiumActive(player)) continue
      // Cheap pre-check: no overflow and no stamp means nothing to do, which is
      // every player on almost every sweep.
      if (inventoryOverflow(player).over <= 0 && !player.inventoryGrace) continue

      const grace = checkOverflowGrace(player, now)
      if (grace.phase === 'clear') { tally.cleared++; changed = true; continue }
      if (grace.phase === 'grace') continue

      if (grace.phase === 'warned') {
        pushNotificationSync(db, jid, {
          kind: 'premium',
          title: `Bag over the limit (${grace.held}/${grace.cap})`,
          body:
            `Premium ended, so your bag cap dropped to ${grace.cap} and you are ${grace.over} over. ` +
            `You have ${Math.round(OVERFLOW_GRACE_MS / 3600_000)}h to sell or store the extras yourself. ` +
            `After that the ${grace.over} cheapest are cleared for you: into home storage if it has room, ` +
            `sold at shop price if not. Nothing equipped is touched.`,
          meta: { over: grace.over, cap: grace.cap, until: grace.until },
        }, now)
        tally.warned++
        changed = true
        continue
      }

      // phase === 'due': the warning has been up for 48h, shed it now.
      const plan = planOverflowShed(player, allItems, storageCap(player))
      const result = applyOverflowShed(player, plan)
      player.inventoryShed = {
        at: now,
        moved: result.moved,
        sold: result.sold,
        dropped: result.dropped,
        solars: result.solars,
      }
      pushNotificationSync(db, jid, {
        kind: 'premium',
        title: `Bag trimmed to ${plan.cap} slots`,
        body:
          `${plan.over} item(s) left your bag: ` +
          [
            result.moved.length ? `${result.moved.length} to home storage` : null,
            result.sold.length ? `${result.sold.length} sold for ${result.solars.toLocaleString()} solars` : null,
            result.dropped.length ? `${result.dropped.length} discarded` : null,
          ].filter(Boolean).join(', ') +
          `. Nothing equipped was touched.`,
        meta: { over: plan.over, cap: plan.cap, solars: result.solars },
      }, now)
      tally.shed++
      changed = true
      globalLog(
        `🎒 Overflow shed for ${jid}: ${plan.over} over cap ${plan.cap} ` +
        `(${result.moved.length} stored, ${result.sold.length} sold for ${result.solars}, ${result.dropped.length} dropped)` +
        (result.dropped.length ? ` dropped: ${summarizeItemIds(result.dropped, allItems)}` : '')
      )
    }
    return changed
  })

  if (tally.warned || tally.shed || tally.cleared) {
    globalLog(`🎒 Inventory overflow sweep: ${tally.warned} warned, ${tally.shed} shed, ${tally.cleared} resolved on their own`)
  }
  return tally
}

async function runPremiumSweep(db, instances) {
  const anySock = instances.map(i => i.activeSock).find(Boolean)
  if (!anySock) return

  // Expiry flagging goes through updateAllPlayers so it's serialized on
  // the same shared queue as every updatePlayer() call (purchases,
  // equips, wallet changes, etc) across BOTH bot instances. Previously
  // this called db.read()/db.write() directly on `db`, completely outside
  // that queue — and because the loop below makes slow network calls
  // (groupMetadata, groupParticipantsUpdate) before ever reaching its own
  // db.write(), any purchase that landed in that window got silently
  // overwritten by this sweep's eventual write, taking the player's
  // Solars but making the purchased item vanish. See lib/player-repo.js
  // for the full explanation of why a per-player queue alone wasn't
  // enough here — the same protection is what makes it safe for two
  // WhatsApp numbers to share this db in the first place.
  await updateAllPlayers(db, (users) => {
    let anyExpired = false
    for (const player of Object.values(users)) {
      if (expirePremiumIfDue(player)) anyExpired = true
    }
    return anyExpired
  })

  // Second pass: the fallout of an expiry. Losing premium drops the bag cap
  // from 50 to 30, which can strand a player ABOVE their own limit with every
  // hasInventoryRoom() check failing, so they can't loot, craft or buy again.
  // Warn first, shed once the grace has run out. See lib/inventory-limits.js.
  await runInventoryOverflowSweep(db)

  const groupJids = await getPremiumGroups()
  for (const groupJid of groupJids) {
    try {
      const settings = await getGroupSettings(groupJid)
      if (!settings.premiumOnly) {
        // Gate was turned off directly via group-settings without going
        // through `.premium off` — drop it from the snapshot list too so
        // this group stops being swept.
        await removePremiumGroup(groupJid)
        continue
      }

      // Use whichever bot instance is actually in this group — a group
      // metadata / participant-removal call will fail if issued from a
      // socket that was never added to that group.
      let sock = null
      let meta = null
      for (const inst of instances) {
        if (!inst.activeSock) continue
        try {
          meta = await inst.activeSock.groupMetadata(groupJid)
          sock = inst.activeSock
          break
        } catch {
          // this instance isn't in the group — try the next one
        }
      }
      if (!sock || !meta) continue

      for (const participant of meta.participants) {
        const jid = participant.id
        if (isOwnerJid(jid)) continue
        // Re-read this one player fresh right before deciding to kick —
        // never reuse a snapshot taken before this network loop started,
        // since purchases/renewals may have landed in the meantime.
        const player = getPlayer(db, jid)
        if (player && isPremiumActive(player)) continue

        await sock.groupParticipantsUpdate(groupJid, [jid], 'remove').then(() => {
          globalLog(`💫 Premium sweep: removed expired/non-premium member ${jid} from ${groupJid}`)
        }).catch(err => {
          globalLog(`⚠️ Premium sweep: failed to remove ${jid} from ${groupJid}:`, err.message)
        })
      }
    } catch (err) {
      globalLog(`⚠️ Premium sweep: failed processing group ${groupJid}:`, err.message)
    }
  }
}

// Seasons are fixed 90-day rotations. This sweep also starts an auto-start
// season on a fresh database, so the feature does not require an owner to
// remember a boot-time command.
const SEASON_SWEEP_INTERVAL_MS = 5 * 60_000

async function runSeasonSweep(db) {
  const result = await syncSeasonLifecycle(db)
  if (result.action !== 'none') {
    globalLog(`🌞 Season lifecycle: ${result.action} ${result.season?.id ?? result.ended?.season?.id ?? ''}`)
  }
}

// ── Inbound-stall watchdog ─────────────────────────────────────────────────
//
// The bug this exists for: "the bot is online, everyone is sending messages
// and it won't answer, but the hourly card and the Pokémon spawns still
// arrive normally."
//
// That combination is only possible if OUTBOUND works and INBOUND doesn't.
// The spawn sweeps above are driven by setInterval, so they never touch the
// inbound path — they keep firing on schedule no matter how dead message
// delivery is, which is exactly what makes the bot look healthy while it
// ignores every command.
//
// Two things can put a socket in that state, and neither one closes it:
//
//   • Baileys fails to decrypt incoming messages (stale Signal session, bad
//     prekey, "Bad MAC"). Those errors are also FILTERED OUT of the logs by
//     SPAM_PATTERNS at the top of this file, so the symptom is invisible.
//     The socket is fine; the messages are dropped before messages.upsert.
//   • The WhatsApp side quietly stops routing to this device while the
//     websocket and its keepalive pings stay perfectly healthy.
//
// Baileys' own keepalive can't catch either one: the ping round-trips fine.
// So the only reliable signal is silence on messages.upsert itself, and the
// only known fix is a reconnect, which forces sessions to be renegotiated.
//
// The trade-off is deliberate: a genuinely idle bot (nobody talking for 15
// minutes at 4am) will occasionally reconnect for no reason. A reconnect is
// cheap, keeps the auth files, and is rate-limited by the cooldown below —
// a pointless reconnect every 20 minutes is a much smaller problem than
// hours of unanswered commands.
const STALL_CHECK_INTERVAL_MS = 60_000

// A reply that has been waiting this long means the outbound queue — not the
// inbound path — is what's making the bot look frozen. Different cause, so
// it gets its own warning rather than a reconnect (reconnecting would only
// throw the backlog away).
const SEND_BACKLOG_WARN_MS = 60_000

function runStallWatchdog(instances, db) {
  const now = Date.now()

  for (const inst of instances) {
    const sock = inst.activeSock
    if (!sock) continue // not open — the reconnect logic already owns this case

    // Outbound side: report, don't reconnect.
    const rl = sock.__rateLimiter
    if (rl && rl.oldestPendingMs > SEND_BACKLOG_WARN_MS) {
      globalErrorLog(
        `⚠️ [${inst.botName}] outbound backlog: ${rl.pending} queued, oldest ${Math.round(rl.oldestPendingMs / 1000)}s, ` +
        `${rl.sentLastMinute}/${rl.limits.maxPerMinute} sent this minute. ` +
        `Commands ARE being received — the replies are queued behind the send rate limit.`,
      )
    }

    // Inbound side: REMOVED (2026-09).
    //
    // This used to force a reconnect after 15 minutes without an inbound
    // message, on the theory that silence meant Baileys had stopped
    // delivering. In practice a quiet group is just a quiet group: the
    // watchdog fired on healthy sockets in the small hours, and every
    // forced reconnect renegotiates sessions, drops whatever was in the
    // send queue, and risks the connection it was supposed to be
    // protecting. The "🚑 no inbound message for 15 min" line was noise.
    //
    // Genuine disconnects still reconnect on their own: Baileys emits
    // connection.update {connection:'close'} and the handler below owns
    // that path. If inbound delivery really does wedge again, bring this
    // back behind an env flag rather than on by default.
  }
}

// ── One WhatsApp connection ─────────────────────────────────────────────────
// `botCfg` is one entry from config.js's `bots` array: { botName, authFolder,
// phoneFile }. `inst` is a small per-instance state bag (log stream, pairing
// flags, activeSock) that this function closes over instead of using
// module-level globals — that's what lets multiple numbers run side by side
// in one process without stepping on each other's state.
function createBotInstance(botCfg) {
  const inst = {
    botName: botCfg.botName,
    authFolder: botCfg.authFolder,
    phoneFile: botCfg.phoneFile,
    activeSock: null,
    // Guards a pairing code from being re-requested on every reconnect —
    // without this, Baileys' first unstable handshake (statusCode 428)
    // causes connect() to be called again 5s later, which requests a
    // brand new code before you've had a chance to enter the old one.
    pairingRequested: false,
    // Tracks whether we've ever reached connection === 'open' this run —
    // used so a fake/soft 401 doesn't wipe a session that was already paired.
    wasEverConnected: false,
    // Ensures the "bot is online" DM to the owner fires once per process
    // start for THIS number, not on every reconnect.
    onlineDmSent: false,
    // Counts consecutive "never paired, logged out" reconnect attempts —
    // used to stop retrying (and spamming pm2 logs every 60s) once it's
    // clear the pairing code was never entered, instead of looping forever.
    unpairedRetryCount: 0,

    // ── Liveness bookkeeping (read by runStallWatchdog + plugins/health.js) ──
    // When connection === 'open' last happened, and when we last saw ANY
    // inbound message. The gap between those two is the whole basis of the
    // stall watchdog: a socket that has been open for an hour with zero
    // inbound messages is not idle, it's deaf.
    openedAt: 0,
    lastInboundAt: 0,
    inboundCount: 0,
    lastForcedReconnectAt: 0,
    forcedReconnect: false,

    // ── Reconnect hygiene ───────────────────────────────────────────────────
    // connect() used to be callable from several places at once: every
    // 'close' event scheduled its own call, and a retired socket's late
    // 'close' could land after a new socket had already opened. Two overlapping
    // connects on one auth folder is exactly what produces WhatsApp's
    // statusCode 440 (session conflict), which closes both sockets, which
    // schedules two more connects — a loop that gets worse the longer it runs.
    // currentSock + connectInFlight + one reconnectTimer make "at most one
    // socket, at most one pending reconnect" an invariant instead of a hope.
    currentSock: null,
    connectInFlight: false,
    reconnectTimer: null,
  }

  // Bot log file — appends to logs/<botName>/out.log, still shows in pm2
  // logs. Log folder name is derived from botName but sanitized for the
  // filesystem — spaces and special characters are fine in chat messages
  // but awkward to type/quote when navigating logs over SSH. Each bot
  // instance gets its own folder so the two numbers' logs never interleave
  // in the same file.
  const logDirSlug = inst.botName.replace(/[^a-zA-Z0-9_-]+/g, '-')
  const logDir = `./logs/${logDirSlug}`
  mkdirSync(logDir, { recursive: true })
  const logStream = createWriteStream(`${logDir}/out.log`, { flags: 'a' })

  function log(...args) {
    const line = `[${new Date().toISOString()}] [${inst.botName}] ` + args.join(' ') + '\n'
    _stdoutWrite(line)      // still shows in pm2 logs
    logStream.write(line)   // also written to this bot's own log folder
  }
  inst.log = log

  /**
   * The ONLY way a reconnect is scheduled. Collapses duplicate requests (two
   * closes in the same second, a watchdog kill racing a real close) into one
   * pending attempt, and retries by itself if the attempt throws before a
   * socket even exists.
   *
   * That last part matters: connect() awaits mkdir + useMultiFileAuthState
   * before building the socket, and any throw in there used to reject an
   * un-awaited promise. The process stayed alive with NO socket and nothing
   * scheduled to try again — offline until someone noticed and ran
   * `pm2 restart rpg-bot`.
   */
  inst.scheduleReconnect = function scheduleReconnect(db, delayMs, reason) {
    if (inst.reconnectTimer) {
      log(`↩️ Reconnect already scheduled — ignoring duplicate request (${reason}).`)
      return
    }
    log(`🔄 Reconnecting in ${Math.round(delayMs / 1000)}s (${reason})…`)
    inst.reconnectTimer = setTimeout(() => {
      inst.reconnectTimer = null
      inst.connect(db).catch(err => {
        log('⚠️ Reconnect attempt failed before a socket was created:', err?.message ?? err)
        inst.scheduleReconnect(db, 30_000, 'previous attempt threw')
      })
    }, delayMs)
  }

  const openConnection = async function connect(db) {
    await mkdir(inst.authFolder, { recursive: true })

    // Check the file on disk BEFORE useMultiFileAuthState() touches it —
    // see the long comment above checkCredsIntegrity(). Once that call
    // returns, a corrupted creds.json and a missing one are indistinguishable
    // (both become a fresh initAuthCreds()), so this is the only point where
    // "was there actually a broken file here" can still be answered.
    const credsCheck = await checkCredsIntegrity(inst.authFolder)
    if (credsCheck.status === 'corrupted') {
      // Logged loudly, not auto-repaired. Deleting/renaming the folder here
      // would force a full re-pair on nothing more than this check's say-so
      // — if it's ever wrong (a legitimate but unusual creds shape after a
      // future Baileys upgrade, say), that's a much worse outcome than one
      // clear warning. This makes the failure visible instead of silent;
      // what to do about it (wait for a reconnect to fix it, or manually
      // clear the folder and re-pair) stays a human decision.
      globalErrorLog(
        `🚨 [${inst.botName}] creds.json integrity check failed: ${credsCheck.reason}. ` +
        `Proceeding anyway — Baileys will treat this as an unregistered session and may ` +
        `request a fresh pairing. If this instance was previously paired and working, this ` +
        `is likely why: ${inst.authFolder} held a broken file, not a healthy one.`,
      )
    } else {
      log(`✅ Auth state check: ${credsCheck.reason}`)
    }

    const { state, saveCreds } = await useMultiFileAuthState(inst.authFolder)
    const { version, isLatest } = await fetchLatestBaileysVersion()
    log('📶 Baileys version', version.join('.'), isLatest ? '(latest)' : '(outdated)')

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        // Wraps the raw signal keystore with an in-memory cache — without
        // this, rapid session lookups during pairing/reconnect can desync
        // and cause WhatsApp to kill the connection almost immediately
        // (fast 401s).
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      browser: Browsers.ubuntu('Chrome'), // explicit, recognized browser identity
      printQRInTerminal: false,
      // Improves Baileys' rendering of ordinary link previews (e.g. when a
      // player pastes a URL in chat). No longer tied to a custom card
      // system — the old externalAdReply-based rich-card helper
      // (lib/link-card.js) was removed; all image replies now go through
      // lib/image.js's plain sendImage() instead.
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      keepAliveIntervalMs: 25_000,
      connectTimeoutMs: 60_000,
      // Silence Baileys' internal logger unless you need deep debug
      logger: silentLogger,
    })

    // Newer / less-trusted numbers get banned fast if plugins burst-send
    // (tournament brackets, leaderboards, mass DMs, etc.). rateLimit is set
    // per-bot in config.js's bots[] entries — bot2 defaults to a tighter
    // cap than bot1 since it has no send history yet. Wrapping here means
    // every sock.sendMessage() call anywhere in the codebase (handler.js,
    // all plugins/*.js, the welcome/goodbye code just below) is throttled
    // without having to touch each call site.
    wrapSendWithRateLimit(sock, {
      botName: inst.botName,
      minGapMs: botCfg.rateLimit?.minGapMs,
      maxPerMinute: botCfg.rateLimit?.maxPerMinute,
      log,
    })

    // Claim this socket as the instance's current one immediately — before
    // any listener is attached, so a 'close' from the socket we're replacing
    // can already tell that it has been retired (see the identity check in
    // the close handler). activeSock still waits for 'open': currentSock
    // means "the one we're driving", activeSock means "the one you can send
    // through", and those are genuinely different states.
    inst.currentSock = sock

    // NOT assigned here on purpose. `makeWASocket()` returns immediately, long
    // before the connection is usable — publishing it now meant liveSocket()
    // in lib/api-server.js handed out a still-connecting (or already-dead)
    // socket, sendMessage() threw, and the website told people "We couldn't DM
    // that number. Make sure you've messaged the bot at least once." That
    // message was a lie: the number was fine, the bot just wasn't online yet.
    // activeSock is now set on 'open' and cleared on 'close' below, so it
    // means what its name says.

    // Debounce creds saves — Baileys fires creds.update rapidly during
    // pairing and reconnect. Writing on every single event risks
    // partial/race writes that corrupt the auth files right when the
    // connection is most volatile. Wait 500ms for the burst to settle,
    // then do one clean write.
    let saveCredsTimer = null
    sock.ev.on('creds.update', () => {
      if (saveCredsTimer) clearTimeout(saveCredsTimer)
      saveCredsTimer = setTimeout(async () => {
        saveCredsTimer = null
        try { await saveCreds() } catch (err) { log('⚠️ saveCreds error:', err.message) }
      }, 500)
    })
    // Every command from this number goes through the SAME shared `db` and
    // the SAME shared writeQueue in lib/player-repo.js as the other number
    // — that's what makes "one big shared database" safe here. botName is
    // passed through to ctx so replies show the number they came in on.
    //
    // The stamp in front of the handler is what the stall watchdog reads. It
    // has to count EVERY upsert, including ones the handler ignores (its own
    // messages, non-commands, protocol messages): the question the watchdog
    // asks is "is WhatsApp still delivering anything at all to this socket",
    // not "did anyone run a command".
    const handleMessages = makeHandler(sock, db, inst.botName)
    sock.ev.on('messages.upsert', (arg) => {
      inst.lastInboundAt = Date.now()
      inst.inboundCount++
      // The handler already try/catches each message, but a throw in its own
      // outer scope would otherwise surface as an unhandled rejection with no
      // instance name attached to it.
      Promise.resolve(handleMessages(arg)).catch(err =>
        log('⚠️ Message handler threw:', err?.message ?? err))
    })

    // ── Welcome / goodbye announcements ───────────────────────────────────
    // Fires whenever WhatsApp reports members joining or leaving a group.
    // Purely config-driven via data/group-settings.json (toggled through
    // .groupguard welcome/goodbye on|off) — no-ops if a group hasn't opted in.
    sock.ev.on('group-participants.update', async (update) => {
      try {
        const { id: groupId, participants, action } = update
        const settings = await getGroupSettings(groupId)

        // ── Join gate: antifake / antiinternational ──────────────────────
        // Runs before the welcome so a number that's about to be removed
        // never gets greeted. Both are sub-settings of .grouplock — see
        // plugins/grouplock.js. Removed members are collected so they're
        // skipped by the welcome loop below.
        const removed = new Set()
        if (action === 'add' && (settings.antiFake || settings.antiInternational)) {
          const allowed = (settings.localPrefixes ?? []).length
            ? settings.localPrefixes
            : (config.ownerNumbers ?? []).map(n => String(n).replace(/\D/g, '').slice(0, 3)).filter(Boolean)

          for (const jid of participants) {
            if (isOwnerJid(jid)) continue
            const num = String(jid).replace(/@.*$/, '').split(':')[0].replace(/\D/g, '')
            if (!num) continue

            // A real WhatsApp MSISDN is 10-15 digits including country code.
            // Anything outside that is a placeholder/spoofed entry.
            const looksFake = settings.antiFake && (num.length < 10 || num.length > 15)
            const isForeign = settings.antiInternational && allowed.length &&
              !allowed.some(pfx => num.startsWith(String(pfx)))

            if (!looksFake && !isForeign) continue

            const why = looksFake ? 'an invalid number' : 'an international number'
            const kicked = await sock.groupParticipantsUpdate(groupId, [jid], 'remove')
              .then(() => true)
              .catch(err => { log('⚠️ join-gate kick failed:', err.message); return false })

            removed.add(jid)
            await sock.sendMessage(groupId, {
              text: kicked
                ? `🚪 Removed @${num} — ${why} isn't allowed here.`
                : `⚠️ @${num} joined with ${why} but I couldn't remove them. Make me a group admin.`,
              mentions: [jid],
            }).catch(() => {})
          }
        }

        if (action === 'add' && settings.welcome) {
          const template = settings.welcomeMessage || 'Welcome {user}! 🎉'
          for (const jid of participants) {
            if (removed.has(jid)) continue
            const text = template.replace(/\{user\}/g, `@${jid.split('@')[0]}`)
            await sock.sendMessage(groupId, { text, mentions: [jid] }).catch(err =>
              log('⚠️ welcome message failed:', err.message))
          }
        }

        if (action === 'remove' && settings.goodbye) {
          const template = settings.goodbyeMessage || 'Goodbye {user}. 👋'
          for (const jid of participants) {
            const text = template.replace(/\{user\}/g, `@${jid.split('@')[0]}`)
            await sock.sendMessage(groupId, { text, mentions: [jid] }).catch(err =>
              log('⚠️ goodbye message failed:', err.message))
          }
        }
      } catch (err) {
        log('⚠️ group-participants.update handler error:', err.message)
      }
    })

    // Pairing code — requested once per process, from this instance's phoneFile
    if (!sock.authState.creds.registered && !inst.pairingRequested) {
      inst.pairingRequested = true
      // Give the socket a moment to stabilize before hitting the pairing
      // endpoint — requesting immediately on a still-settling connection is
      // a common cause of an instant 401 right after the code is issued.
      await new Promise(r => setTimeout(r, 3_000))

      // Read the file BEFORE deciding it's usable. An existing-but-blank phone
      // file used to pass the existsSync check, hand '' to requestPairingCode()
      // and fail three times with "All pairing attempts failed. Delete the auth
      // folder and restart." — which sends you deleting a healthy auth folder
      // when the real problem is a file you hadn't filled in yet. Non-digits are
      // stripped, so a file holding a note-to-self reads as blank here too.
      const hasPhoneFile = existsSync(inst.phoneFile)
      const phone = hasPhoneFile
        ? readFileSync(inst.phoneFile, 'utf-8').trim().replace(/\D/g, '')
        : ''

      if (!hasPhoneFile) {
        log(`❌ ${inst.phoneFile} not found! Create it with your number, e.g. 2348012345678`)
      } else if (phone.length < 8) {
        // Shorter than a country code + subscriber number: a typo or a
        // placeholder, never a real number.
        log(`❌ ${inst.phoneFile} has no usable number in it (${phone ? `only got "${phone}"` : 'the file is empty'}). Put your number in it, digits only, e.g. 2348012345678`)
      } else {
        log('📱 Requesting pairing code for:', phone)

        let code = null
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            code = await sock.requestPairingCode(phone)
            break
          } catch (err) {
            log(`⚠️ Pairing attempt ${attempt} failed:`, err.message)
            if (attempt < 3) await new Promise(r => setTimeout(r, 3_000))
          }
        }

        if (!code) {
          log('❌ All pairing attempts failed. Delete the auth folder and restart.')
        } else {
          log('📱 Enter this 8-digit code in WhatsApp → Linked Devices → Link with phone number (within 60s):', code)
        }
      }
    }

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'connecting') {
        log('🔌 Connecting to WhatsApp…')
      }

      if (connection === 'open') {
        inst.wasEverConnected = true
        inst.unpairedRetryCount = 0
        inst.openedAt = Date.now()
        // Fresh socket, fresh inbound clock. Without this the watchdog would
        // measure silence from before the reconnect and immediately kill the
        // socket it just built.
        inst.lastInboundAt = Date.now()
        inst.forcedReconnect = false
        // Publish the socket only now that it can actually send. Everything
        // that reaches for a socket (the sweeps above, the website's OTP DM
        // in lib/api-server.js) goes through this field.
        inst.activeSock = sock
        log(`✅ ${inst.botName} is online`)

        // spawn-timer.js — standalone card/series spawn timer, independent
        // of night-mode.js and of this file's own armCardSpawn/
        // armSeriesSpawn. Hands over (or refreshes, on reconnect) the live
        // socket it sends spawns with. See lib/spawn-timer.js's header for
        // why this exists (the original sweeps went silently dead for 3
        // days — suspected cause: a stuck night-mode.json).
        initAbsoluteSpawnTimer(sock)

        if (!inst.onlineDmSent) {
          inst.onlineDmSent = true
          // LID-based accounts need the @lid suffix — @s.whatsapp.net will
          // silently fail to deliver to them. Try LID first if configured,
          // then fall back to the plain phone-number JID.
          const candidates = []
          if (config.ownerLid) candidates.push(`${config.ownerLid}@lid`)
          const ownerNumber = (config.ownerNumbers ?? [])[0]
          if (ownerNumber) candidates.push(`${ownerNumber.replace(/\D/g, '')}@s.whatsapp.net`)

          if (candidates.length === 0) {
            log('⚠️ No owner LID or number configured — skipping online DM.')
          } else {
            ;(async () => {
              for (const jid of candidates) {
                try {
                  await sock.sendMessage(jid, { text: `✅ ${inst.botName} is online.` })
                  log('✅ Online DM sent to owner:', jid)
                  return
                } catch (err) {
                  log(`⚠️ Online DM failed for ${jid}:`, err.message)
                }
              }
              log('❌ Online DM failed for all configured owner targets.')
            })()
          }
        }
      }

      if (connection === 'close') {
        // Retire this socket so nothing tries to send through it. The identity
        // check matters: reconnects below build a NEW socket, and the old
        // one's 'close' can land after the new one's 'open'. A bare
        // `inst.activeSock = null` would then blank out the live socket and
        // take the bot offline as far as the website is concerned.
        if (inst.activeSock === sock) inst.activeSock = null

        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode

        // A close from a socket we've already replaced must not schedule
        // anything. Acting on it is how one instance ends up with two live
        // sockets on one auth folder, which WhatsApp answers with 440s —
        // each of which closes a socket and schedules another connect.
        if (inst.currentSock !== sock) {
          log('🗑️ Ignoring close from a retired socket. statusCode:', statusCode)
          return
        }

        // Nothing else is listening to this socket now. Baileys' own end()
        // already drops its ws + connection.update listeners; this releases
        // the rest (messages.upsert, group-participants.update) so a dead
        // socket can't keep a handler — and the db it closes over — alive.
        try { sock.ev.removeAllListeners?.('messages.upsert') } catch { /* not fatal */ }
        try { sock.ev.removeAllListeners?.('group-participants.update') } catch { /* not fatal */ }

        const loggedOut  = statusCode === DisconnectReason.loggedOut
        const conflict   = statusCode === DisconnectReason.conflict
        const restartReq = statusCode === DisconnectReason.restartRequired // 515

        log('⚠️ Connection closed. statusCode:', statusCode)

        if (inst.forcedReconnect) {
          // Nothing sets this any more — the inbound-stall watchdog that used
          // to was removed (see runStallWatchdog). Kept so a deliberate
          // in-process reconnect (`inst.forcedReconnect = true; sock.end()`)
          // still comes back fast if one is ever added again.
          inst.forcedReconnect = false
          inst.scheduleReconnect(db, 5_000, 'watchdog forced reconnect')
          return
        }

        if (restartReq) {
          // 515 is WhatsApp's normal "restart to finish linking" signal
          // right after a successful pairing — not an error. Reconnect
          // immediately; waiting the usual 1 min here let the freshly-
          // paired session expire and produced a 401 on the next attempt.
          log('🔁 Restart required (515) — this is expected right after pairing, reconnecting now…')
          inst.scheduleReconnect(db, 0, 'restart required (515)')
          return
        }

        if (conflict) {
          // Another process/session is using the same auth (e.g. this auth
          // folder opened twice) — this needs a short retry, not the full
          // 1-min wait used for logout, since it's usually transient.
          log('⚠️ Session conflict (code 440) — reconnecting in 10s…')
          inst.scheduleReconnect(db, 10_000, 'session conflict (440)')
          return
        }

        if (loggedOut && inst.wasEverConnected) {
          // WhatsApp sometimes sends a fake/soft 401 on an already-paired
          // session. A real logout is rare — wiping auth on every 401
          // kills a good session permanently and forces an unnecessary
          // re-pair. Just reconnect instead.
          log('⚠️ Got logout signal (401) on a previously-connected session — reconnecting in 1 min without wiping auth…')
          inst.scheduleReconnect(db, 60_000, 'soft logout (401) on a paired session')
          return
        }

        if (loggedOut) {
          inst.unpairedRetryCount++

          // Never actually paired yet. Give the user a few chances to
          // actually type the pairing code into WhatsApp before we give up
          // — retrying too fast invalidates the code they're still typing.
          // But after MAX_UNPAIRED_RETRIES straight misses, stop looping:
          // logging this every 60s forever just spams pm2 logs while
          // nobody's actively pairing. Log once and wait for a manual
          // restart (e.g. `pm2 restart rpg-bot`) once the number is ready.
          const MAX_UNPAIRED_RETRIES = 5
          if (inst.unpairedRetryCount > MAX_UNPAIRED_RETRIES) {
            log(`❌ Logged out before pairing completed, ${inst.unpairedRetryCount - 1} retries exhausted — giving up for this run. Update ${inst.phoneFile} if needed, then run "pm2 restart rpg-bot" to request a fresh pairing code.`)
            return
          }

          log(`❌ Logged out before pairing completed — waiting 1 min before requesting a new code… (attempt ${inst.unpairedRetryCount}/${MAX_UNPAIRED_RETRIES})`)
          inst.pairingRequested = false
          inst.scheduleReconnect(db, 60_000, 'logged out before pairing completed')
          return
        }

        inst.scheduleReconnect(db, 60_000, `connection closed (${statusCode ?? 'unknown'})`)
      }
    })

    return sock
  }

  /**
   * Public entry point for (re)connecting. Refuses to run two connects at
   * once for this instance — see the reconnect-hygiene note on inst above.
   */
  inst.connect = async function connect(db) {
    if (inst.connectInFlight) {
      log('↩️ connect() called while another connect is already in progress — ignoring.')
      return null
    }
    inst.connectInFlight = true
    try {
      return await openConnection(db)
    } finally {
      inst.connectInFlight = false
    }
  }

  return inst
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function main() {
  globalLog(`🚀 Starting ${bots.length} bot instance(s), sharing one database…`)
  const { passed, errors } = runValidation()
  if (!passed) {
    errors.forEach(e => globalLog('❌ Data validation failure:', e))
    globalLog('❌ Data validation failed — fix all errors above before starting the bot.')
    process.exit(1)
  }
  globalLog('✅ Data validation passed')

  const db = await initDb()
  _dbRef = db
  await runSeasonSweep(db)
  const migrated = await updateAllPlayers(db, (users) => migrateAllPlayers(users))
  if (migrated) globalLog('📊 Migrated player stat pools to the level-100 / 1,500-point progression.')
  await loadPlugins('./plugins')

  // Guard against misconfiguration — two instances pointed at the same
  // auth folder would fight over the same Baileys session and produce
  // exactly the "instant 401 / conflict" symptoms the reconnect logic
  // above already has to work around for a single number.
  const seenAuthFolders = new Set()
  for (const b of bots) {
    if (seenAuthFolders.has(b.authFolder)) {
      globalLog(`❌ Duplicate authFolder "${b.authFolder}" used by more than one bot in config.js's bots[] — each number needs its own. Refusing to start.`)
      process.exit(1)
    }
    seenAuthFolders.add(b.authFolder)
  }

  const instances = bots.map(createBotInstance)
  for (const inst of instances) {
    // One number failing to even build its socket (unreadable auth folder,
    // full disk, DNS down at boot) must not abort main(). Everything after
    // this loop — the website API and EVERY sweep, including the card and
    // Pokémon spawns — used to be skipped when this threw, leaving a process
    // that was alive with no scheduled work at all.
    try {
      await inst.connect(db)
    } catch (err) {
      globalErrorLog(`❌ [${inst.botName}] initial connect failed: ${err?.stack ?? err}`)
      inst.scheduleReconnect(db, 30_000, 'initial connect failed')
    }
  }

  // Live health readout for plugins/health.js (`.health`). Kept as a getter
  // rather than a snapshot object so it can never go stale.
  setHealthProvider(() => ({
    uptimeSec: Math.floor(process.uptime()),
    instances: instances.map(inst => {
      const sock = inst.activeSock
      const rl = sock?.__rateLimiter ?? null
      return {
        botName: inst.botName,
        online: Boolean(sock),
        openedAt: inst.openedAt,
        lastInboundAt: inst.lastInboundAt,
        inboundCount: inst.inboundCount,
        lastForcedReconnectAt: inst.lastForcedReconnectAt,
        reconnectPending: Boolean(inst.reconnectTimer),
        send: rl ? {
          pending: rl.pending,
          pendingReactions: rl.pendingReactions,
          oldestPendingMs: rl.oldestPendingMs,
          sentLastMinute: rl.sentLastMinute,
          draining: rl.draining,
          limits: rl.limits,
          counters: rl.counters,
        } : null,
      }
    }),
  }))

  // Website bridge (lib/api-server.js). Started AFTER the sockets connect so
  // the very first /api/auth/request-otp already has a live socket to DM the
  // login code from. It runs in THIS process on purpose — see the
  // single-writer note at the top of this file and in lib/player-repo.js.
  // Declines to start (rather than crashing the bot) if JWT_SECRET is unset.
  try {
    ({ startApiServer } = await import('./lib/api-server.js'))
    startApiServer(db, instances)
  } catch (err) {
    const missing = err?.code === 'ERR_MODULE_NOT_FOUND'
    globalLog(
      missing
        ? `⛔ Website API not started — a dependency is missing. Run \`npm install\` on the VPS. (${err.message})`
        : `⛔ Website API failed to start: ${err?.stack ?? err}`,
    )
    globalLog('   The bot itself is unaffected and will keep running normally.')
  }

  setInterval(() => {
    runPremiumSweep(db, instances).catch(err => globalLog('⚠️ Premium sweep crashed:', err.message))
  }, PREMIUM_SWEEP_INTERVAL_MS)
  globalLog(`⏱️ Premium expiry sweep scheduled every ${PREMIUM_SWEEP_INTERVAL_MS / 60_000} min`)

  // Runs synchronously and only reads counters, so it can't itself be the
  // thing that stalls. See the long note above runStallWatchdog.
  setInterval(() => {
    try { runStallWatchdog(instances, db) }
    catch (err) { globalErrorLog('⚠️ Stall watchdog crashed:', err?.message ?? err) }
  }, STALL_CHECK_INTERVAL_MS)
  globalLog('⏱️ Outbound backlog watchdog active (reports a stuck send queue; never forces a reconnect)')

  setInterval(() => {
    runSeasonSweep(db).catch(err => globalLog('⚠️ Season sweep crashed:', err.message))
  }, SEASON_SWEEP_INTERVAL_MS)
  globalLog(`⏱️ Season lifecycle sweep scheduled every ${SEASON_SWEEP_INTERVAL_MS / 60_000} min`)

  // ── Card / Series / Pokémon auto-spawn: resettable, not a bare setInterval ─
  //
  // A plain setInterval ticks on a fixed clock from process boot and doesn't
  // know or care about night mode. That created two real symptoms:
  //   1. `.night off` mid-cycle could leave up to a full interval (up to an
  //      hour for cards, two for series) with zero spawns, since the timer
  //      just kept counting through the closed period.
  //   2. If the process restarted while night mode was on (crash, PM2
  //      restart, redeploy), night-mode.json's `on: true` survives the
  //      restart on purpose (so an overnight crash doesn't reopen the bot),
  //      but nothing ever told the freshly-booted sweeps to catch up —
  //      isNightMode() just kept returning true and every sweep silently
  //      no-op'd forever until someone happened to run `.night off` again.
  //
  // Fix: each sweep's setInterval is now held in a variable so it can be
  // cleared and re-armed, and lib/night-mode.js's onNightModeOff() fires a
  // registered callback the INSTANT `.night off` runs (see setNightMode
  // there). That callback runs every sweep immediately — so a spawn fires
  // right away, not after whatever's left on the old clock — then rearms a
  // fresh setInterval from that moment, so the hourly (etc.) cadence counts
  // from the actual wake time, not from process boot.
  //
  // This also self-heals the restart case: `.night off` after a stuck
  // restart hits this exact same path, no special-casing needed.

  let cardSpawnTimer   = null
  let seriesSpawnTimer = null
  let pokemonSpawnTimer = null

  function armCardSpawn() {
    if (cardSpawnTimer) clearInterval(cardSpawnTimer)
    cardSpawnTimer = setInterval(() => {
      runCardSpawnSweep(instances).catch(err => globalLog('⚠️ Card spawn sweep crashed:', err.message))
    }, CARD_SPAWN_INTERVAL_MS)
  }

  function armSeriesSpawn() {
    if (seriesSpawnTimer) clearInterval(seriesSpawnTimer)
    seriesSpawnTimer = setInterval(() => {
      runSeriesSpawnSweep(instances).catch(err => globalLog('⚠️ Series spawn sweep crashed:', err.message))
    }, SERIES_SPAWN_INTERVAL_MS)
  }

  function armPokemonSpawn() {
    if (pokemonSpawnTimer) clearInterval(pokemonSpawnTimer)
    pokemonSpawnTimer = setInterval(() => {
      runPokemonSpawnSweep(instances).catch(err => globalLog('⚠️ Pokémon spawn sweep crashed:', err.message))
    }, POKEMON_SPAWN_INTERVAL_MS)
  }

  armCardSpawn()
  globalLog(`⏱️ Card auto-spawn scheduled every ${humanInterval(CARD_SPAWN_INTERVAL_MS)}`)

  armSeriesSpawn()
  globalLog(`⏱️ Anime Series auto-spawn scheduled every ${humanInterval(SERIES_SPAWN_INTERVAL_MS)}`)

  armPokemonSpawn()
  globalLog(`⏱️ Wild Pokémon auto-spawn scheduled every ${humanInterval(POKEMON_SPAWN_INTERVAL_MS)}`)

  // Fires once, the instant night mode goes OFF (whether via a fresh
  // `.night off` or one run after a stuck restart): an immediate spawn on
  // each sweep — isNightMode() is already false by the time this runs (see
  // setNightMode's ordering), so these are real spawns, not skipped ones —
  // then a clean re-arm so the next tick is a full interval from right now.
  onNightModeOff(() => {
    globalLog('☀️ Night mode off — firing an immediate spawn sweep and resetting the hourly clock.')
    runCardSpawnSweep(instances).catch(err => globalLog('⚠️ Card spawn sweep crashed:', err.message))
    runSeriesSpawnSweep(instances).catch(err => globalLog('⚠️ Series spawn sweep crashed:', err.message))
    runPokemonSpawnSweep(instances).catch(err => globalLog('⚠️ Pokémon spawn sweep crashed:', err.message))
    armCardSpawn()
    armSeriesSpawn()
    armPokemonSpawn()
  })

  setInterval(() => {
    runPokeBattleTimeoutSweep(instances, db).catch(err => globalLog('⚠️ Pokébattle timeout sweep crashed:', err.message))
  }, POKEBATTLE_TIMEOUT_SWEEP_INTERVAL_MS)
  globalLog(`⏱️ Pokémon battle turn-timeout sweep scheduled every ${POKEBATTLE_TIMEOUT_SWEEP_INTERVAL_MS / 1000}s`)

  setInterval(() => {
    runStorySlotTimeoutSweep(instances, db).catch(err => globalLog('⚠️ Story slot timeout sweep crashed:', err.message))
  }, STORY_SLOT_SWEEP_INTERVAL_MS)
  globalLog(`⏱️ Story Mode slot timeout sweep scheduled every ${STORY_SLOT_SWEEP_INTERVAL_MS / 1000}s (${STORY_SLOT_TIMEOUT_MS / 60_000} min idle limit)`)

  // Run once immediately on startup to clear any leftover files from a
  // previous crash, then keep sweeping every 3 minutes automatically.
  runTempCleanupSweep().catch(err => globalLog('⚠️ Temp cleanup (startup) crashed:', err.message))
  setInterval(() => {
    runTempCleanupSweep().catch(err => globalLog('⚠️ Temp cleanup sweep crashed:', err.message))
  }, TEMP_CLEANUP_INTERVAL_MS)
  globalLog(`⏱️ Temp image cleanup scheduled every ${TEMP_CLEANUP_INTERVAL_MS / 60_000} min`)
}

// A throw anywhere in main() used to surface as an unhandled rejection and
// leave a live process with no sockets, no sweeps and no API server —
// "online" as far as PM2 is concerned, dead to every user. Say so in
// pm2-err.log and exit non-zero instead, so PM2's autorestart gets a chance
// to fix it.
main().catch(err => {
  globalErrorLog('💥 Boot failed:', err?.stack ?? err)
  process.exit(1)
})

// Telegram and Discord auto-boot used to live here. It was removed: this is a
// WhatsApp-only deploy now. The adapters (adapters/telegram, adapters/discord),
// the platform plugin directories (plugins-telegram/, plugins-discord/) and the
// multi-platform entry points (main-all.js, main-telegram.js, main-discord.js)
// were all deleted. Bringing the other platforms back means restoring those
// files and re-adding a boot block like the one that was here.
