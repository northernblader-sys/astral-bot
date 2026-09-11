/**
 * Spin banner checks: lib/spin-banners.js and the two web spin routes.
 * Run: node scripts/spin-check.mjs
 *
 * Covers the thing that actually matters about a one-of-one — that the SECOND
 * player is refused and charged nothing — on both entry points, since chat and
 * the website now spin the same banner through the same module.
 *
 * Section 2 boots the real API against an in-memory db on port 45991, so it
 * needs no WhatsApp connection and touches no save file.
 */
process.env.JWT_SECRET ??= '0123456789abcdef0123456789abcdef0123456789abcdef'
process.env.API_PORT = '45991'
process.env.ALLOWED_ORIGINS = 'http://localhost:4321'

import { getSpinBanner, runSpinBatch } from '../lib/spin-banners.js'
import { getExclusiveSpinWinner } from '../lib/season-engine.js'

const B = getSpinBanner('gogeta')

let pass = 0, fail = 0
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <- ' + extra : '')) }
}

const freshDb = () => ({ data: { users: {}, seasonRuntime: {} } })
const mk = (over = {}) => ({ wallet: { gems: 500 }, gogetaSpins: 0, ownedCharacters: [], ...over })

console.log('\n=== 1. The pull loop ===')

/* The dead zone is a true zero, not a low chance: spins 1-230 cannot win. */
{
  const db = freshDb()
  const p = mk()
  const out = runSpinBatch(db, p, B, 'A', 20)
  t('dead zone cannot win', out.reason === 'exhausted' && !out.results.some(r => r.won), out.reason)
  t('charged 20 x 1.5', p.wallet.gems === 470, 'gems ' + p.wallet.gems)
  t('counter advanced to 20', p.gogetaSpins === 20, 'spins ' + p.gogetaSpins)
  t('nothing claimed', getExclusiveSpinWinner(db, 'gogeta') === null)
}

/* A batch is clamped to the per-command cap, whatever was asked for. */
{
  const out = runSpinBatch(freshDb(), mk({ wallet: { gems: 9999 } }), B, 'A', 999)
  t('999 requested clamps to ' + B.maxSpinsPerCommand, out.count === B.maxSpinsPerCommand, 'count ' + out.count)
}

/* Past the dead zone a win lands, takes the bot-wide lock, grants the copy. */
let lockedDb = null
{
  const db = freshDb()
  const p = mk({ gogetaSpins: 240 })
  let out = null
  for (let i = 0; i < 6 && !getExclusiveSpinWinner(db, 'gogeta'); i++) out = runSpinBatch(db, p, B, 'A', 10)
  t('a win lands past the dead zone', out?.reason === 'won', String(out?.reason))
  t('lock is held by the winner', getExclusiveSpinWinner(db, 'gogeta') === 'A')
  t('character granted', p.ownedCharacters.includes('gogeta'))
  t('reel marks the winning spin', out?.results?.at(-1)?.won === true)
  lockedDb = db
}

/* The whole point: a second player cannot win him, and pays nothing to learn it. */
{
  const p = mk({ gogetaSpins: 245 })
  const out = runSpinBatch(lockedDb, p, B, 'B', 20)
  t('second player refused', out.reason === 'claimed', String(out.reason))
  t('second player charged nothing', p.wallet.gems === 500, 'gems ' + p.wallet.gems)
  t('second player counter untouched', p.gogetaSpins === 245)
  t('lock unchanged', getExclusiveSpinWinner(lockedDb, 'gogeta') === 'A')
}

/* The holder is told he is already theirs, not sold a second copy. */
{
  const p = mk({ gogetaSpins: 250, ownedCharacters: ['gogeta'] })
  const out = runSpinBatch(lockedDb, p, B, 'A', 5)
  t('holder gets owned', out.reason === 'owned', String(out.reason))
  t('holder charged nothing', p.wallet.gems === 500)
}

/* Free refusals: an empty wallet and the lifetime cap. */
{
  const db = freshDb()
  const broke = mk({ wallet: { gems: 1 } })
  t('below one spin refused', runSpinBatch(db, broke, B, 'C', 5).reason === 'gems')
  t('and charged nothing', broke.wallet.gems === 1)

  const spent = mk({ gogetaSpins: B.maxSpinsPerPlayer })
  t('lifetime cap refused', runSpinBatch(db, spent, B, 'D', 5).reason === 'exhausted_lifetime')
  t('and charged nothing', spent.wallet.gems === 500)
}

/* Gems running out mid-batch charges only the spins that happened. */
{
  const p = mk({ wallet: { gems: 4.5 } })
  const out = runSpinBatch(freshDb(), p, B, 'E', 20)
  t('3 of 20 requested spins ran', out.spinsUsed === 3 && out.count === 20, 'used ' + out.spinsUsed)
  t('wallet emptied exactly', p.wallet.gems === 0, 'gems ' + p.wallet.gems)
}

console.log('\n=== 2. The web routes ===')

const jwt = (await import('jsonwebtoken')).default
const { default: startApiServer } = await import('../lib/api-server.js')

const JID = '2348000000000@s.whatsapp.net'
const OTHER = '2348111111111@s.whatsapp.net'
const webPlayer = id => ({
  id,
  name: id === JID ? 'Tester' : 'Rival',
  level: 40,
  wallet: { gems: 500, coins: 0 },
  gogetaSpins: 243,
  ownedCharacters: [],
  stats: { str: 10, agi: 10, int: 10, def: 10, lck: 10 },
  hp: 400, maxHp: 400, mp: 50, maxMp: 50,
  inventory: [],
})

const db = {
  data: {
    users: { [JID]: webPlayer(JID), [OTHER]: webPlayer(OTHER) },
    notifications: {},
    seasonRuntime: { activeSeasonId: 'season_01', startedAt: Date.now(), endsAt: Date.now() + 86400000 },
  },
  read: async () => {},
  write: async () => {},
}

startApiServer(db, [])
await new Promise(r => setTimeout(r, 2500))

const token = id => jwt.sign({ sub: id, epoch: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })
async function call(path, { method = 'GET', body, id } = {}) {
  const res = await fetch('http://127.0.0.1:45991/api' + path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(id ? { Authorization: 'Bearer ' + token(id) } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

/* Signed out: the banner still describes itself, with no per-player fields. */
{
  const { status, body } = await call('/spins')
  const b = body.banners?.[0]
  t('GET /spins works signed out', status === 200 && !!b, 'status ' + status)
  t('signed out has no balance', b?.gems === null)
  t('signed out cannot spin', b?.canSpin === false)
  t('an unregistered id 404s', (await call('/characters/nobody/spin')).status === 404)
  t('POST needs a session', (await call('/characters/gogeta/spin', { method: 'POST', body: { count: 1 } })).status === 401)
}

/* Signed in: own numbers, then spin until it lands (7 live spins at 0.8). */
{
  const { body } = await call('/characters/gogeta/spin', { id: JID })
  t('own spin count', body.spinsUsed === 243, String(body.spinsUsed))
  t('own balance', body.gems === 500, String(body.gems))
  t('canSpin true', body.canSpin === true)
}

let won = null
for (let i = 0; i < 4 && !won; i++) {
  const { status, body } = await call('/characters/gogeta/spin', { method: 'POST', body: { count: 5 }, id: JID })
  t('POST spin ' + (i + 1) + ' returns 200', status === 200, 'status ' + status)
  if (body.won) won = body
}

if (!won) t('a win landed within 20 live spins', false, 'no win, rerun')
else {
  t('win returns the character', won.character?.id === 'gogeta')
  t('reel marks the win', won.results.at(-1)?.won === true)
  t('spinsThisPull is this pull only', won.spinsThisPull <= 5, String(won.spinsThisPull))
  t('spinsUsed is the lifetime total', won.spinsUsed > won.spinsThisPull, String(won.spinsUsed))
  t('claimed by you', won.claimedByYou === true && won.owned === true)
  t('balance debited', won.balance < 500, String(won.balance))
  t('serializeSelf came back', !!won.player?.name)
  t('notification pushed', (db.data.notifications?.[JID] ?? []).some(n => n.kind === 'reward'))
  t('no phone number in the payload', !JSON.stringify(won).includes('@s.whatsapp.net'))
}

/* The lock, over HTTP, from a different account. */
{
  const { body } = await call('/characters/gogeta/spin', { id: OTHER })
  t('other sees it claimed', body.claimed === true && body.claimedByYou === false)
  t('holder shown by name, not id', body.claimedBy === 'Tester', String(body.claimedBy))
  t('other cannot spin', body.canSpin === false)

  const post = await call('/characters/gogeta/spin', { method: 'POST', body: { count: 5 }, id: OTHER })
  t('POST from other is 409', post.status === 409, 'status ' + post.status)
  t('other charged nothing', db.data.users[OTHER].wallet.gems === 500, 'gems ' + db.data.users[OTHER].wallet.gems)
  t('other counter untouched', db.data.users[OTHER].gogetaSpins === 243)

  const again = await call('/characters/gogeta/spin', { method: 'POST', body: { count: 1 }, id: JID })
  t('holder POST is 409 owned', again.status === 409 && again.body.owned === true)
}

/* The curve stays secret on every surface, the site included. */
{
  const { body } = await call('/spins', { id: OTHER })
  t('/spins reports claimed', body.banners?.[0]?.claimed === true)
  t('no dead zone or plateau in the payload', !JSON.stringify(body).match(/deadZone|plateau|pityAt/i))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
