/**
 * unstick-check.mjs — exercises plugins/unstick.js against an in-memory db.
 *
 * Run: node scripts/unstick-check.mjs
 *
 * Covers the two things that matter: every lock actually clears, and nothing
 * that represents progress or money is touched.
 */
import unstick from '../plugins/unstick.js'
import { config } from '../config.js'

const OWNER = `${(config.ownerNumbers ?? [])[0] ?? '0000000000'}@s.whatsapp.net`
const TARGET = '2349019816559@s.whatsapp.net'
const ALLY = '2348000000001@s.whatsapp.net'

let pass = 0, fail = 0
const t = (label, cond) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`)
  cond ? pass++ : fail++
}

// A player wedged in essentially every way at once.
const stuck = {
  id: TARGET, name: 'Gentle', level: 100, xp: 500_000,
  wallet: { solars: 12_345, gems: 40, vault: 900 },
  inventory: ['health_potion', 'iron_sword'],
  stats: { str: 50, wins: 9, losses: 3 },
  dungeonProgress: { deep_forest: { highestFloor: 12, conquered: true } },
  stamina: { current: 3, max: 30 },
  location: 'deep_forest',
  inDungeon: true, dungeonFloor: 7, inBattle: true,
  battleState: { enemy: { name: 'Rotting Treant', hp: 40 }, turn: 3 },
  activeEffects: [{ id: 'poison', turns: 2 }, { id: 'burn', turns: 1 }],
  pvpChallenge: { fromJid: ALLY, expiresAt: 1 },
  sleepUntil: 9_999_999_999_999,
  pendingTrade: 'trade_042',
  hypnosis: { used: 1, snapshot: {} },
  partyId: TARGET,
  reborn: { count: 1, pick: 'ceiling_150', trial: { startedAt: 1, hpAtStart: 80 }, offer: { x: 1 } },
}

const ally = { id: ALLY, name: 'Ally', level: 40, partyId: TARGET, wallet: { solars: 10 } }

const db = {
  data: {
    users: { [OWNER]: { id: OWNER, name: 'Owner' }, [TARGET]: stuck, [ALLY]: ally },
    parties: {
      [TARGET]: { leaderId: TARGET, members: [TARGET, ALLY], pendingInvites: [], battle: { enemy: 'boss' }, createdAt: 1 },
    },
  },
  write: async () => {},
}

const replies = []
const ctx = {
  platform: 'whatsapp',
  from: OWNER,
  db,
  args: [],
  isGroup: true,
  reply: async (s) => { replies.push(s); return s },
  // Owner tagging the stuck player.
  msg: { message: { extendedTextMessage: { contextInfo: { mentionedJid: [TARGET] } } } },
}

await unstick.run(ctx)
// updatePlayer resolves the caller before its debounced disk flush; give the
// queued follow-up writes (the freed ally) a tick to land.
await new Promise(r => setTimeout(r, 50))

const p = db.data.users[TARGET]

console.log('\n── locks cleared ──')
t('inBattle false',                p.inBattle === false)
t('battleState null',              p.battleState === null)
t('inDungeon false',               p.inDungeon === false)
t('dungeonFloor 0',                p.dungeonFloor === 0)
t('activeEffects emptied',         Array.isArray(p.activeEffects) && p.activeEffects.length === 0)
t('pvpChallenge null',             p.pvpChallenge === null)
t('sleepUntil null',               p.sleepUntil === null)
t('pendingTrade null',             p.pendingTrade === null)
t('hypnosis deleted',              p.hypnosis === undefined)
t('reborn.trial deleted',          p.reborn.trial === undefined)
t('reborn.offer deleted',          p.reborn.offer === undefined)
t('partyId null',                  p.partyId === null)
t('moved to astral_town',          p.location === 'astral_town')
t('party disbanded from store',    db.data.parties[TARGET] === undefined)
t('other member freed too',        db.data.users[ALLY].partyId === null)

console.log('\n── progress preserved ──')
t('reborn result kept',            p.reborn.count === 1 && p.reborn.pick === 'ceiling_150')
t('level kept',                    p.level === 100)
t('xp kept',                       p.xp === 500_000)
t('wallet untouched',              p.wallet.solars === 12_345 && p.wallet.gems === 40 && p.wallet.vault === 900)
t('inventory untouched',           p.inventory.length === 2)
t('dungeonProgress untouched',     p.dungeonProgress.deep_forest.highestFloor === 12)
t('stamina NOT refilled',          p.stamina.current === 3)
t('ally wallet untouched',         db.data.users[ALLY].wallet.solars === 10)

console.log('\n── report ──')
t('replied once',                  replies.length === 1)
t('names the target',              /Gentle/.test(replies[0] ?? ''))
t('mentions the foe',              /Rotting Treant/.test(replies[0] ?? ''))
console.log('\n' + (replies[0] ?? '(no reply)'))

// Second pass on an already-clean player must report "not stuck", not re-clear.
replies.length = 0
await unstick.run(ctx)
await new Promise(r => setTimeout(r, 50))
console.log('\n── idempotence ──')
t('second run reports clean',      /wasn't stuck/.test(replies[0] ?? ''))

console.log(`\n${fail === 0 ? '🎉 all good' : '💥 failures'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
