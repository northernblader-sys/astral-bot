//
//   ⚔️  RPGBot — PM2 LAUNCHER  ⚔️
//   Entrypoint: node index.js
//   Auto-installs deps, then starts the bot via PM2
//

import { createServer } from 'http'
import { execSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 8080

// ── Keep-alive HTTP server — runs in the MAIN process so uptime monitors always see it ──
createServer((_, res) => res.end('⚔️ RPGBot is running')).listen(PORT, () => {
  console.log(`🌐 Keep-alive server on port ${PORT}`)
  console.log(`🟢 Self-ping active — pinging every 4 mins to stay online`)
})

// ── Ensure logs folder exists ──────────────────────────────────────────────
if (!existsSync(path.join(__dirname, 'logs'))) {
  mkdirSync(path.join(__dirname, 'logs'), { recursive: true })
  console.log('📁 Created logs/ directory')
}

// ── Auto-install dependencies if missing ───────────────────────────────────
function ensureDeps() {
  const nmPath = path.join(__dirname, 'node_modules', '@whiskeysockets')
  if (!existsSync(nmPath)) {
    console.log('📦 node_modules missing — running npm install...')
    try {
      execSync('npm install', { cwd: __dirname, stdio: 'inherit' })
      console.log('✅ npm install complete')
    } catch (err) {
      console.error('❌ npm install failed:', err.message)
      process.exit(1)
    }
  } else {
    console.log('✅ node_modules already present')
  }
}

// ── Ensure PM2 is installed ─────────────────────────────────────────────────
function ensurePM2() {
  try {
    execSync('pm2 --version', { stdio: 'ignore' })
    console.log('✅ PM2 already installed')
    return
  } catch {}
  console.log('📦 Installing PM2 locally...')
  execSync('npm install pm2', { stdio: 'inherit', cwd: __dirname })
  console.log('✅ PM2 installed locally')
}

// ── Resolve pm2 binary ──────────────────────────────────────────────────────
function getPM2Bin() {
  try {
    execSync('pm2 --version', { stdio: 'ignore' })
    return 'pm2'
  } catch {
    return path.join(__dirname, 'node_modules', '.bin', 'pm2')
  }
}

// Single PM2 process — it internally runs BOTH WhatsApp numbers as separate
// Baileys sockets (see main.js), sharing one database. If you add more
// numbers via config.js's `bots` array, this still only needs one entry
// here, since it's still one process.
const ECOSYSTEM_APPS = ['rpg-bot']

let _launching = false  // re-entrancy guard — prevents watchdog from double-launching

// ── Launch bot via ecosystem config ─────────────────────────────────────────
function launchWithPM2() {
  if (_launching) {
    console.log('⏳ launchWithPM2 already in progress — skipping duplicate call')
    return
  }
  _launching = true
  try {
    const pm2 = getPM2Bin()

    console.log('🚀 Starting bot via ecosystem.config.cjs...')
    // `pm2 start` on an ecosystem file is idempotent — if the app is already
    // running, PM2 just no-ops rather than duplicating it. No need to kill
    // the whole daemon first, which was tearing down a live WhatsApp socket
    // (including mid-pairing) and causing two sockets to briefly touch the
    // same auth_info folder — that's what was producing the instant 401s.
    const result = spawnSync(pm2, ['start', 'ecosystem.config.cjs'], {
      cwd: __dirname,
      stdio: 'inherit',
    })

    if (result.status !== 0) {
      throw new Error(`PM2 start failed (exit ${result.status})`)
    }

    spawnSync(pm2, ['save'], { cwd: __dirname, stdio: 'inherit' })
    console.log('✅ Bot running — logs in ./logs/')
    console.log(`🌐 Keep-alive server on port ${PORT}`)
    console.log('🟢 Self-ping active — pinging every 4 mins to stay online')
  } finally {
    _launching = false
  }
}

// ── Watchdog: re-launch if PM2 drops a required process ────────────────────
function startWatchdog() {
  const pm2 = getPM2Bin()
  const REQUIRED = ECOSYSTEM_APPS
  let _jlistFailures = 0
  const JLIST_FAIL_THRESHOLD = 3  // re-launch after 3 consecutive jlist failures (~3 min)
  // How many consecutive "missing" checks to tolerate before actually acting.
  // main.js can legitimately spend up to ~70s in an unpaired/reconnecting
  // state (pairing retries + 60s backoff), so a single miss on a 60s timer
  // must NOT trigger a relaunch — that was killing bots mid-pairing.
  let _missingStreak = 0
  const MISSING_STREAK_THRESHOLD = 4  // ~4 minutes of confirmed absence
  setInterval(() => {
    if (_launching) return  // don't interfere mid-launch
    try {
      const raw  = execSync(`"${pm2}" jlist`, { cwd: __dirname }).toString()
      const list = JSON.parse(raw)
      _jlistFailures = 0  // reset on success
      // Guard against null/undefined entries in PM2's process list
      const missing = REQUIRED.filter(name =>
        !list.some(p => p && p.name === name)  // process exists at all in PM2's list
      )
      if (missing.length > 0) {
        _missingStreak++
        console.warn(`⚠️  PM2 process(es) not found: ${missing.join(', ')} (${_missingStreak}/${MISSING_STREAK_THRESHOLD})`)
        if (_missingStreak >= MISSING_STREAK_THRESHOLD) {
          console.warn('⚠️  Confirmed missing after sustained checks — re-launching...')
          _missingStreak = 0
          launchWithPM2()
        }
      } else {
        _missingStreak = 0
      }
    } catch (err) {
      _jlistFailures++
      console.warn(`⚠️  Watchdog jlist failed (${_jlistFailures}/${JLIST_FAIL_THRESHOLD}):`, err?.message || err)
      if (_jlistFailures >= JLIST_FAIL_THRESHOLD) {
        console.warn('⚠️  PM2 daemon unresponsive — forcing re-launch...')
        _jlistFailures = 0
        launchWithPM2()
      }
    }
  }, 60_000)
}

// ── Global crash guard ───────────────────────────────────────────────────────
process.on('uncaughtException',  (e) => console.error('[launcher] uncaughtException:', e?.message || e))
process.on('unhandledRejection', (e) => console.error('[launcher] unhandledRejection:', e?.message || e))

// ── Boot ─────────────────────────────────────────────────────────────────────
console.log('⚔️  RPGBot PM2 Launcher starting...')
ensureDeps()
ensurePM2()
launchWithPM2()
startWatchdog()
