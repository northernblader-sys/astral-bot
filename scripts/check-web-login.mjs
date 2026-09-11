/**
 * check-web-login.mjs — why can't this number sign in on the website?
 *
 * Website sign-in has exactly one hard problem: almost every account is keyed
 * by a WhatsApp LID (`170823868481696@lid`), and a LID shares no digits with
 * the phone number that owns it. So a code sent to +234… can only be connected
 * back to a character by one of:
 *
 *   1. the `phone` field stamped on the record (offline, always works), or
 *   2. the LID that onWhatsApp() hands back at login (a live, rate-limited
 *      network call that fails exactly when WhatsApp is throttling the bot)
 *
 * When neither is available the site cannot see the character and offers to
 * create a new one, which is the "it's not getting our usernames" report.
 *
 * Usage:
 *   node scripts/check-web-login.mjs                 # audit every account
 *   node scripts/check-web-login.mjs 2349151234567   # trace one number
 *
 * Read-only. Never writes to db.json.
 */
import { readFileSync } from 'node:fs'
import { findPlayerByPhone, jidDigits } from '../lib/api-server.js'
import { normalizePhone } from '../lib/otp-store.js'
import { config } from '../config.js'

const DB_PATH = process.env.DB_PATH ?? './db.json'

let raw
try {
  raw = JSON.parse(readFileSync(DB_PATH, 'utf8'))
} catch (err) {
  console.error(`❌ Could not read ${DB_PATH}: ${err.message}`)
  process.exit(1)
}

// findPlayerByPhone expects a lowdb-shaped handle, not the parsed file.
const db = { data: raw }
const users = raw.users ?? {}
const keys = Object.keys(users)

/* ── audit ──────────────────────────────────────────────────────────────── */

const lidKeyed = keys.filter(k => k.includes('@lid'))
const phoneKeyed = keys.filter(k => k.includes('@s.whatsapp.net'))
const stamped = keys.filter(k => users[k]?.phone)
const orphans = lidKeyed.filter(k => !users[k]?.phone)

const pct = n => `${((n / Math.max(1, keys.length)) * 100).toFixed(1)}%`

console.log(`\n📊 ${DB_PATH} — ${keys.length} accounts\n`)
console.log(`  LID-keyed (@lid)          ${String(lidKeyed.length).padStart(4)}  ${pct(lidKeyed.length)}`)
console.log(`  phone-keyed (@s.whats…)   ${String(phoneKeyed.length).padStart(4)}  ${pct(phoneKeyed.length)}`)
console.log(`  have a stamped .phone     ${String(stamped.length).padStart(4)}  ${pct(stamped.length)}   ← findable offline`)
console.log(`  LID-keyed, no .phone      ${String(orphans.length).padStart(4)}  ${pct(orphans.length)}   ← need a live onWhatsApp() lookup`)

if (orphans.length > keys.length * 0.5) {
  console.log(
    `\n⚠️  Most accounts can only sign in while onWhatsApp() is answering.\n` +
    `   Every one of them self-heals the next time that player sends a message:\n` +
    `   handler.js stamps .phone from key.senderPn (DM) or key.participantPn (group).\n` +
    `   If this number stays flat over a day of traffic, that stamp is not running.`,
  )
} else {
  console.log(`\n✅ Most accounts carry a .phone, so sign-in no longer depends on the network.`)
}

/* ── trace one number ───────────────────────────────────────────────────── */

const arg = process.argv[2]
if (!arg) {
  console.log(`\n_Pass a number to trace one account: node scripts/check-web-login.mjs 2349151234567_\n`)
  process.exit(0)
}

const phone = normalizePhone(arg, config.defaultCountryCode)
if (!phone) {
  console.error(`\n❌ "${arg}" is not a usable phone number.`)
  process.exit(1)
}

const masked = `+${phone.slice(0, 3)}•••${phone.slice(-3)}`
console.log(`\n🔍 Tracing ${masked}  (normalized: ${phone})\n`)

// Shot 2 (the account's LID) is the only one a script cannot reproduce: it needs
// a live socket. Everything else is offline, so report those honestly and say
// plainly that the LID shot is untested here.
const offline = findPlayerByPhone(db, phone, `${phone}@s.whatsapp.net`, null)

if (offline) {
  const how = users[`${phone}@s.whatsapp.net`] === offline
    ? 'its id is the phone JID'
    : offline.phone === phone
      ? 'the .phone field is stamped'
      : `its id digits match (${jidDigits(offline.id)})`
  console.log(`✅ Found *${offline.name}* offline, because ${how}.`)
  console.log(`   id: ${offline.id}`)
  console.log(`   Sign-in works for this account even while WhatsApp is throttling the bot.`)
} else {
  console.log(`❌ Not findable offline. No record has .phone === ${phone}, and no id's digits match it.`)
  console.log(`   Sign-in for this number depends entirely on onWhatsApp() returning its LID.`)
  console.log(`   That is the call that fails under rate-overlimit, and it is why the site`)
  console.log(`   offered to create a new character instead of showing the existing one.\n`)
  console.log(`   To confirm which character it should be, find their LID and check:`)
  console.log(`     node -e "const u=JSON.parse(require('fs').readFileSync('${DB_PATH}','utf8')).users;const k=Object.keys(u).find(k=>k.startsWith('THE_LID'));console.log(k,u[k]?.name)"`)
  console.log(`   Then either have them send one message in a group (the stamp backfills`)
  console.log(`   automatically), or set .phone on the record directly.`)
}

console.log('')
