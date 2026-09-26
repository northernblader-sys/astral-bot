/**
 * smoke-website.mjs — exercises the website modules that don't need
 * node_modules, against an in-memory fake db. lib/api-server.js itself needs
 * express, so it's covered by scripts/check-imports.mjs instead; everything
 * it *calls* is covered here.
 *
 * Run: node scripts/smoke-website.mjs
 */
import { buildNewPlayer, validateRegistration, listClasses, listRaces } from '../lib/player-factory.js'
import { pushNotification, listNotifications, unreadCount, markRead, markAllRead, deleteNotification, clearNotifications } from '../lib/notification-repo.js'
import { buildSelfAlerts, buildPublicAlerts } from '../lib/alerts.js'
import { initOtpStore, normalizePhone, checkRateLimit, issue, verify, discard } from '../lib/otp-store.js'

let pass = 0
let fail = 0
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? ' — ' + extra : ''}`) }
}
function section(t) { console.log(`\n${t}`) }

// A db stand-in with the one method player-repo actually calls on write.
const db = { data: { users: {}, notifications: {} }, async write() {} }

section('player-factory')
ok('listClasses returns entries', listClasses().length > 0)
ok('listRaces returns entries', listRaces().length > 0)
ok('rejects empty name', !validateRegistration({ name: '', classId: 'warrior', raceId: 'human' }).ok)
ok('rejects bad class', !validateRegistration({ name: 'Aragorn', classId: 'nope', raceId: 'human' }).ok)
ok('rejects bad race', !validateRegistration({ name: 'Aragorn', classId: 'warrior', raceId: 'nope' }).ok)
ok('rejects symbols in name', !validateRegistration({ name: 'a<script>', classId: 'warrior', raceId: 'human' }).ok)
const good = validateRegistration({ name: '  Aragorn ', classId: 'WARRIOR', raceId: 'Human' })
ok('accepts + normalizes valid input', good.ok && good.name === 'Aragorn' && good.classId === 'warrior' && good.raceId === 'human',
  JSON.stringify(good))

const jid = '2348012345678@s.whatsapp.net'
const player = buildNewPlayer({ id: jid, name: 'Aragorn', classId: 'warrior', raceId: 'human' })
db.data.users[jid] = player
ok('player has id/name', player.id === jid && player.name === 'Aragorn')
ok('level 1, xp 0', player.level === 1 && player.xp === 0)
ok('hp === maxHp', player.hp === player.maxHp && player.maxHp > 0)
ok('stats populated', player.stats.str > 0 && player.stats.def > 0)
ok('wallet has solars + vault', typeof player.wallet.solars === 'number' && player.wallet.vault === 0)
ok('starting gear + skill', player.inventory.length > 0 && player.skills.length > 0)
ok('season scaffolding', !!player.seasonProgress && !!player.seasonOwned)
ok('premium starts inactive', player.premium.active === false)
ok('stat points 15 unallocated', player.statPoints.unallocated === 15)
ok('chest locked, empty', player.chest.unlocked === false && player.chest.items.length === 0)

section('notification-repo')
ok('starts empty', listNotifications(db, jid).length === 0)
const n1 = await pushNotification(db, jid, { kind: 'system', title: 'First', body: 'one' })
await pushNotification(db, jid, { kind: 'reward', title: 'Second', body: 'two' })
ok('two stored', listNotifications(db, jid).length === 2)
ok('newest first', listNotifications(db, jid)[0].title === 'Second')
ok('unread = 2', unreadCount(db, jid) === 2)
ok('has stable id', !!n1.id)
await markRead(db, jid, n1.id)
ok('unread = 1 after markRead', unreadCount(db, jid) === 1)
await markAllRead(db, jid)
ok('unread = 0 after markAllRead', unreadCount(db, jid) === 0)
await deleteNotification(db, jid, n1.id)
ok('one left after delete', listNotifications(db, jid).length === 1)
ok('rejects unknown id gracefully', (await deleteNotification(db, jid, 'nope')) === false)
await clearNotifications(db, jid)
ok('empty after clear', listNotifications(db, jid).length === 0)
ok('unknown player reads as empty', listNotifications(db, 'ghost@s.whatsapp.net').length === 0)

section('alerts')
const selfAlerts = buildSelfAlerts(db, player)
ok('self alerts is an array', Array.isArray(selfAlerts))
ok('every alert has kind/title/body', selfAlerts.every(a => a.kind && a.title && a.body))
const hurt = { ...player, hp: 3, maxHp: 150, statPoints: { ...player.statPoints, unallocated: 7 } }
const hurtAlerts = buildSelfAlerts(db, hurt)
ok('low hp raises an urgent battle alert',
  hurtAlerts.some(a => a.severity === 'urgent' && a.kind === 'battle' && /low hp/i.test(a.title)),
  JSON.stringify(hurtAlerts.map(a => a.title)))
ok('unspent points raise an action alert',
  hurtAlerts.some(a => a.severity === 'action' && /stat point/i.test(a.title)),
  JSON.stringify(hurtAlerts.map(a => a.title)))
// Assert the ordering itself rather than comparing two findIndex results —
// a severity that's absent from the fixture returns -1, which made the old
// version pass or fail on whether the fixture happened to contain one.
const RANK = { urgent: 0, action: 1, good: 2, info: 3 }
ok('alerts are sorted most-urgent first',
  hurtAlerts.every((a, i) => i === 0 || RANK[hurtAlerts[i - 1].severity] <= RANK[a.severity]),
  JSON.stringify(hurtAlerts.map(a => a.severity)))
const pub = buildPublicAlerts(db, player)
ok('public alerts is an array', Array.isArray(pub))
const pubText = JSON.stringify(pub) + JSON.stringify(buildPublicAlerts(db, hurt))
ok('public alerts never leak the phone number', !pubText.includes('2348012345678'))

section('otp-store')
initOtpStore('a'.repeat(64))
ok('normalizes +234 form', normalizePhone('+234 801 234 5678') === '2348012345678')
ok('normalizes 0-prefixed local form', normalizePhone('08012345678')?.length >= 10)
ok('rejects junk', normalizePhone('abc') === null)
ok('rejects too-short', normalizePhone('123') === null)

const phone = '2348012345678'
discard(phone)
ok('rate limit allows first request', checkRateLimit(phone, '1.2.3.4').ok)
const issued = issue(phone, { ttlMs: 60_000, ip: '1.2.3.4', jid })
ok('code is 6 digits', /^\d{6}$/.test(issued.code))
ok('reports expiry', issued.expiresAt > Date.now())
ok('second request is throttled', !checkRateLimit(phone, '1.2.3.4').ok)
ok('wrong code rejected', !verify(phone, '000000').ok)
ok('right code accepted', verify(phone, issued.code).ok)
ok('code is single-use', !verify(phone, issued.code).ok)

discard(phone)
const i2 = issue(phone, { ttlMs: 60_000, ip: '9.9.9.9', jid })
for (let i = 0; i < 5; i++) verify(phone, '111111')
const locked = verify(phone, i2.code)
ok('locks out after too many wrong attempts', !locked.ok && locked.reason === 'too_many_attempts', JSON.stringify(locked))

discard(phone)
const i3 = issue(phone, { ttlMs: -1, ip: '9.9.9.9', jid })
ok('expired code rejected', verify(phone, i3.code).reason === 'expired')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
