/**
 * Offline exercise of the new website purchase endpoints.
 *
 *   node scripts/smoke-shop-api.mjs
 *
 * Boots the API against an in-memory stub db — no db.json is opened and no
 * real player is touched — mints a session for a fake player, then walks every
 * success and failure path of POST /api/shop/buy and POST /api/cards/buy-tier,
 * asserting the balance moved by exactly the right amount (and, on every
 * rejection, not at all).
 *
 * The card purchase hits the live Cards API, so that section is skipped if the
 * upstream is unreachable rather than failing the run.
 */
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET ??= '0123456789abcdef0123456789abcdef0123456789abcdef'
process.env.API_PORT = process.env.API_PORT ?? '45998'

const { config } = await import('../config.js')
const { default: startApiServer } = await import('../lib/api-server.js')

const JID = '2340000000000@s.whatsapp.net'

function freshPlayer(overrides = {}) {
  return {
    id: JID,
    name: 'Smoke Tester',
    level: 50,
    xp: 0,
    hp: 100, maxHp: 100, mp: 50, maxMp: 50,
    stats: { str: 10, agi: 10, int: 10, def: 10, lck: 10, wins: 0, losses: 0 },
    wallet: { solars: 100_000, gems: 10, bankGold: 0, vault: 0, loan: 0 },
    inventory: [],
    cards: [],
    equipped: {},
    skills: [], pets: [], summonedBeasts: [], ownedCharacters: [],
    registeredAt: Date.now(),
    ...overrides,
  }
}

const db = {
  data: {
    users: { [JID]: freshPlayer() },
    notifications: {},
    seasonRuntime: { activeSeasonId: 'season_01', startedAt: Date.now(), endsAt: Date.now() + 86_400_000 },
  },
  read: async () => {},
  write: async () => {},
}

const server = startApiServer(db, [])
if (!server) {
  console.error('✖ API server refused to start')
  process.exit(1)
}
await new Promise(r => setTimeout(r, 500))
const base = `http://127.0.0.1:${server.address().port}`

const token = jwt.sign({ sub: JID, uid: 'smoke', epoch: 0 }, config.jwtSecret, { expiresIn: '1h' })

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const solars = () => db.data.users[JID].wallet.solars
const reset = (overrides) => { db.data.users[JID] = freshPlayer(overrides) }

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ── shop ──────────────────────────────────────────────────────────────── */

console.log('\nGET /api/shop')
{
  const { status, json } = await call('GET', '/api/shop')
  check('200', status === 200)
  check('has shelves', (json?.shelves ?? []).length > 0)
  check('every row has an image', json.shelves.every(s => s.groups.every(g => g.rows.every(r => r.image))))
  check('you.discount present', typeof json.you?.discount === 'number')
}

console.log('\nPOST /api/shop/buy — happy path')
{
  reset()
  const before = solars()
  const { status, json } = await call('POST', '/api/shop/buy', { id: 'health_potion', qty: 3 })
  const price = json?.bought?.buyPrice
  check('200', status === 200, JSON.stringify(json))
  check('debited exactly qty × buyPrice', solars() === before - price * 3, `${before} → ${solars()}, price ${price}`)
  check('3 copies in inventory', db.data.users[JID].inventory.filter(i => i === 'health_potion').length === 3)
  check('balance echoed matches', json?.balance === solars())
}

console.log('\nPOST /api/shop/buy — rejections must not move the balance')
const rejections = [
  ['unknown id', { id: 'not_a_real_item', qty: 1 }, 404, {}],
  ['partial name is not accepted as an id', { id: 'health', qty: 1 }, 404, {}],
  ['material with no buyPrice', { id: 'iron_ore', qty: 1 }, 400, {}],
  ['over-level item', { id: 'eternal_spear', qty: 1 }, 403, { level: 1 }],
  // Level is checked before funds (same order as plugins/shop.js), so this
  // case has to clear the level gate for the funds gate to be the one tested.
  ['insufficient solars', { id: 'eternal_spear', qty: 1 }, 402, { level: 99, wallet: { solars: 5, gems: 0 } }],
  ['inventory full', { id: 'health_potion', qty: 1 }, 409, { inventory: Array(30).fill('health_potion') }],
  ['gear mid-battle', { id: 'leather_armor', qty: 1 }, 409, { inBattle: true }],
  ['missing id', {}, 400, {}],
]
for (const [label, body, expected, overrides] of rejections) {
  reset(overrides)
  const before = solars()
  const { status, json } = await call('POST', '/api/shop/buy', body)
  check(`${label} → ${expected}`, status === expected, `got ${status} ${JSON.stringify(json)}`)
  check(`${label} → balance unchanged`, solars() === before, `${before} → ${solars()}`)
}

console.log('\nPOST /api/shop/buy — potions ARE allowed mid-battle')
{
  reset({ inBattle: true })
  const before = solars()
  const { status } = await call('POST', '/api/shop/buy', { id: 'health_potion', qty: 1 })
  check('200', status === 200)
  check('debited', solars() < before)
}

console.log('\nPOST /api/shop/buy — qty is clamped to 1..99')
{
  reset()
  const { json } = await call('POST', '/api/shop/buy', { id: 'health_potion', qty: 9999 })
  check('clamped or rejected, never unbounded', (json?.bought?.qty ?? 0) <= 99)
}

/* ── cards ─────────────────────────────────────────────────────────────── */

console.log('\nGET /api/cards/prices')
{
  const { status, json } = await call('GET', '/api/cards/prices')
  check('200', status === 200)
  check('exactly tiers 1,2,3,4,6', JSON.stringify((json?.tiers ?? []).map(t => t.tier)) === '["1","2","3","4","6"]')
  check('tier 5 absent (earn-only)', !(json?.tiers ?? []).some(t => t.tier === '5'))
  check('tier S absent (earn-only)', !(json?.tiers ?? []).some(t => String(t.tier).toUpperCase() === 'S'))
}

console.log('\nPOST /api/cards/buy-tier — rejections')
for (const [label, body, expected] of [
  ['tier 5 not for sale', { tier: '5' }, 400],
  ['tier S not for sale', { tier: 'S' }, 400],
  ['garbage tier', { tier: 'banana' }, 400],
  ['no tier', {}, 400],
]) {
  reset()
  const before = solars()
  const { status } = await call('POST', '/api/cards/buy-tier', body)
  check(`${label} → ${expected}`, status === expected)
  check(`${label} → balance unchanged`, solars() === before)
}

console.log('\nPOST /api/cards/buy-tier — insufficient funds is checked before the upstream fetch')
{
  reset({ wallet: { solars: 10, gems: 0 } })
  const t0 = Date.now()
  const { status } = await call('POST', '/api/cards/buy-tier', { tier: '1' })
  check('402', status === 402)
  check('answered without waiting on the Cards API', Date.now() - t0 < 2000, `${Date.now() - t0}ms`)
  check('balance unchanged', solars() === 10)
}

console.log('\nPOST /api/cards/buy-tier — happy path (live Cards API)')
{
  reset()
  const before = solars()
  const { status, json } = await call('POST', '/api/cards/buy-tier', { tier: '1' })
  if (status === 503) {
    console.log('  ⚠ Cards API unreachable — skipping')
    check('nothing charged on upstream failure', solars() === before)
  } else {
    check('200', status === 200, JSON.stringify(json))
    check('debited exactly 500', solars() === before - 500, `${before} → ${solars()}`)
    check('card added to collection', db.data.users[JID].cards.length === 1)
    check('card is tier 1', db.data.users[JID].cards[0]?.tier === '1')
    check('notification pushed', (db.data.notifications[JID] ?? []).length === 1)
  }
}

server.close()
console.log(failures ? `\n✖ ${failures} check(s) failed\n` : '\n✓ all checks passed\n')
process.exit(failures ? 1 : 0)
