/**
 * e2e-connect-link.mjs — end-to-end trace of `.link <username>` on Discord
 * through to what the website's notification bell would actually return.
 *
 * Runs the REAL plugins/connect.js run() and the REAL read path the site uses
 * (lib/notification-repo.js listNotifications, keyed the way
 * lib/api-server.js's GET /api/notifications keys it), against an in-memory db.
 *
 * Scenario B is the important one: the character registered under a LID, which
 * is what an account looks like when it was created on a modern WhatsApp
 * client. The site login finds it by the stamped `phone` field; the question is
 * whether the bell read and the connect write agree on the key.
 *
 *   node scripts/e2e-connect-link.mjs
 */
import connect from '../plugins/connect.js'
import { listNotifications } from '../lib/notification-repo.js'
import { findPlayerByUsername, isMasterId } from '../lib/account-link.js'

const PHONE = '2348012345678'
const DISCORD_ID = 'dc:99988877766'

function makeDb(playerId, extra = {}) {
  return {
    data: {
      users: {
        [playerId]: {
          id: playerId,
          name: 'Tuna',
          username: 'ilovetuna',
          level: 12,
          ...extra,
        },
      },
      notifications: {},
      accountLinks: {},
    },
    write: async () => {},
  }
}

/** Mirrors lib/api-server.js findPlayerByPhone() — the site's login lookup. */
function findPlayerByPhone(db, phone, resolvedJid = null, lid = null) {
  const users = db.data.users ?? {}
  if (resolvedJid && users[resolvedJid]) return users[resolvedJid]
  if (lid && users[lid]) return users[lid]
  const direct = users[`${phone}@s.whatsapp.net`]
  if (direct) return direct
  const digits = j => String(j ?? '').split('@')[0].split(':')[0].replace(/\D/g, '')
  const lidDigits = lid ? digits(lid) : null
  for (const p of Object.values(users)) {
    if (p?.phone && String(p.phone) === phone) return p
    if (digits(p?.id) === phone) return p
    if (lidDigits && digits(p?.id) === lidDigits && String(p?.id ?? '').includes('@lid')) return p
  }
  return null
}

async function scenario(label, playerId, extra, discordId) {
  console.log(`\n═══ ${label}`)
  console.log(`    player id: ${playerId}`)

  const db = makeDb(playerId, extra)

  // ── 1. what .link looks up ───────────────────────────────────────────────
  const target = findPlayerByUsername(db, 'ilovetuna')
  console.log(`    [1] findPlayerByUsername('ilovetuna') -> ${target ? target.id : 'NULL'}`)
  console.log(`        isMasterId(${playerId}) = ${isMasterId(playerId)}`)
  if (!target) {
    console.log(`    ❌ STOPS HERE — user is told "No character found with the username @ilovetuna"`)
    return
  }

  // ── 2. run the real command ──────────────────────────────────────────────
  let replied = null
  const ctx = {
    args: ['ilovetuna'],
    reply: async t => { replied = t; return t },
    db,
    platform: 'discord',
    platformId: discordId,
  }
  await connect.run(ctx)
  const firstLine = String(replied).split('\n')[0]
  console.log(`    [2] .link ilovetuna replied: ${firstLine}`)

  // ── 3. where did it get written ──────────────────────────────────────────
  const keys = Object.keys(db.data.notifications ?? {})
  console.log(`    [3] notification written under key(s): ${JSON.stringify(keys)}`)

  // ── 4. what the site's bell reads ────────────────────────────────────────
  const sessionPlayer = findPlayerByPhone(db, PHONE, `${PHONE}@s.whatsapp.net`)
  const reqJid = sessionPlayer?.id ?? null
  console.log(`    [4] site login by number ${PHONE} -> req.jid = ${reqJid}`)

  const bell = listNotifications(db, reqJid)
  const codeItem = bell.find(n => /connect code/i.test(n.title))
  console.log(`    [5] bell returns ${bell.length} item(s); connect code present: ${Boolean(codeItem)}`)
  if (codeItem) console.log(`        -> "${codeItem.title}"`)

  console.log(codeItem
    ? `    ✅ PASS — the code reaches the bell`
    : `    ❌ FAIL — "Code sent" was shown but the bell will never display it`)
}

await scenario(
  'A: character registered under a phone JID (classic)',
  `${PHONE}@s.whatsapp.net`,
  {},
  `${DISCORD_ID}a`,
)

await scenario(
  'B: character registered under a LID, phone stamped by a previous web login',
  '198765432109876@lid',
  { phone: PHONE },
  `${DISCORD_ID}b`,
)

process.exit(0)
