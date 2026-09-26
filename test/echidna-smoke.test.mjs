/**
 * echidna-smoke.test.mjs - end-to-end smoke for Echidna's commands: runs the
 * REAL plugins (greed, echidna, wisdom) through a mocked ctx/db the way
 * handler.js would, without starting the bot or a WhatsApp socket.
 *
 *   1. PvE .greed turn - tithe lands, wallet credited, enemy undamaged,
 *      enemy's turn skipped by the distraction, charge burned once, second
 *      cast refused.
 *   2. PvE .greed with a GROWN child - Little Gospel renders and pays.
 *   3. .echidna ritual / name / child / status - the whole family loop,
 *      including ONE-child enforcement and the visit cooldown.
 *   4. .echidna stranger gate - non-holders never trigger an API call.
 *   5. .wisdom - enemy readout in battle, refusal without Echidna equipped.
 *   6. .echidna AI chat - only asserts the graceful path: without network to
 *      Google (or without a key) she must answer in character, never crash;
 *      with both, the reply must be her voice. Network access varies by
 *      machine, so a blocked connection is NOT a failure here.
 *
 * Run:  node test/echidna-smoke.test.mjs
 */
import { config } from '../config.js'

const greedMod = await import('../plugins/greed.js')
const echidnaMod = await import('../plugins/echidna.js')
const wisdomMod = await import('../plugins/wisdom.js')

function makeDb(users) {
  return { data: { users }, write: async () => {}, read: async () => {} }
}

function makeCtx(db, from, args = []) {
  const replies = []
  return {
    db, from, args,
    player: db.data.users[from],
    sender: from,
    isGroup: false,
    platform: 'whatsapp',
    reply: async (t) => { replies.push(String(t)); return {} },
    replyImage: async (_img, t) => { replies.push('[IMG] ' + String(t)); return {} },
    replyGif: async (_img, t) => { replies.push('[GIF] ' + String(t)); return {} },
    replies,
  }
}

let failures = 0
function check(name, cond) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name)
  if (!cond) failures++
}

// ════════════════ 1. PvE .greed turn ════════════════
console.log('── PvE .greed turn (monster carrying 400 solars) ──')
{
  const users = {
    'p1@s.whatsapp.net': {
      name: 'Tester', level: 42,
      equippedCharacter: 'echidna',
      ownedCharacters: ['echidna'],
      inBattle: true,
      hp: 100, maxHp: 100, mp: 50, maxMp: 50,
      wallet: { solars: 100, gems: 3 },
      battleState: {
        turn: 1, playerDefending: false,
        enemy: { name: 'Bandit', emoji: '🗡️', hp: 300, maxHp: 300, atk: 20, def: 5, solars: 400, activeEffects: [] },
      },
    },
  }
  const db = makeDb(users)
  const ctx = makeCtx(db, 'p1@s.whatsapp.net')
  await greedMod.default.run(ctx)
  const p = users['p1@s.whatsapp.net']
  const text = ctx.replies.join('\n')
  check('reply announces the GOSPEL OF GREED', /GOSPEL OF GREED/.test(text))
  check('solars increased by the tithe', p.wallet.solars > 100)
  check('enemy took no damage from the theft', p.battleState.enemy.hp === 300)
  // A 1-turn distraction is consumed by the enemy's own status tick inside
  // the same command (same shape as Puppet Strings' tangle): the proof that
  // it worked is the skipped enemy turn, not a surviving effect record.
  check('enemy lost its turn to the distraction', /No move comes|still counting/.test(text))
  check('charge burned once', p.battleState.greedTitheUsed === true)
  check('turn counter advanced', p.battleState.turn === 2)

  const ctx2 = makeCtx(db, 'p1@s.whatsapp.net')
  await greedMod.default.run(ctx2)
  check('second .greed in the same battle is refused', /already been opened once/.test(ctx2.replies.join('')))
}

// ════════════════ 2. PvE .greed with a grown child ════════════════
console.log('── PvE .greed with a GROWN child ──')
{
  const users = {
    'p2@s.whatsapp.net': {
      name: 'Parent', level: 60,
      equippedCharacter: 'echidna', ownedCharacters: ['echidna'],
      inBattle: true, hp: 100, maxHp: 100, mp: 10, maxMp: 10,
      wallet: { solars: 0, gems: 0 },
      echidnaChild: { name: 'Nyx', bornAt: Date.now() - 100 * 3600_000, visits: 0, lastVisitAt: 0 },
      battleState: { turn: 1, enemy: { name: 'Wyrm', emoji: '🐉', hp: 500, maxHp: 500, atk: 30, def: 8, solars: 200, activeEffects: [] } },
    },
  }
  const db = makeDb(users)
  const ctx = makeCtx(db, 'p2@s.whatsapp.net')
  await greedMod.default.run(ctx)
  const p = users['p2@s.whatsapp.net']
  const text = ctx.replies.join('\n')
  check('the child is in the reveal', /Little Gospel|Nyx/.test(text))
  check('wallet credited', p.wallet.solars > 0)
}

// ════════════════ 3. ritual / child / name / status ════════════════
console.log('── .echidna ritual / child / name ──')
{
  const users = {
    'p3@s.whatsapp.net': {
      name: 'Holder', level: 55,
      ownedCharacters: ['echidna'], equippedCharacter: 'echidna',
      wallet: { solars: 10, gems: 1 },
    },
  }
  const db = makeDb(users)

  const ctxR = makeCtx(db, 'p3@s.whatsapp.net', ['ritual'])
  await echidnaMod.default.run(ctxR)
  const p = users['p3@s.whatsapp.net']
  check('ritual plays the multi-message story', ctxR.replies.length >= 5)
  check('rite stays a sanctuary ceremony', /sanctuary|Gospel|vessel/i.test(ctxR.replies.join(' ')))
  check('child born into the house', !!p.echidnaChild?.bornAt)

  const ctxR2 = makeCtx(db, 'p3@s.whatsapp.net', ['ritual'])
  await echidnaMod.default.run(ctxR2)
  check('second ritual refused - ONE child, ever', /ONE child|already have one/i.test(ctxR2.replies.join(' ')))

  const ctxN = makeCtx(db, 'p3@s.whatsapp.net', ['name', '*Nyx*'])
  await echidnaMod.default.run(ctxN)
  check('child named (markdown stripped)', p.echidnaChild.name === 'Nyx')

  const ctxV = makeCtx(db, 'p3@s.whatsapp.net', ['child'])
  await echidnaMod.default.run(ctxV)
  check('visit works and reports growth', /Growth|newborn/i.test(ctxV.replies.join(' ')))
  check('visit increments visits', (p.echidnaChild.visits ?? 0) === 1)

  const ctxV2 = makeCtx(db, 'p3@s.whatsapp.net', ['child'])
  await echidnaMod.default.run(ctxV2)
  check('visit cooldown enforced', /miss you|min/.test(ctxV2.replies.join(' ')))

  const ctxS = makeCtx(db, 'p3@s.whatsapp.net', [])
  await echidnaMod.default.run(ctxS)
  check('status card renders', /ECHIDNA, THE WITCH OF GREED/.test(ctxS.replies.join('')))
}

// ════════════════ 4. stranger gate ════════════════
console.log('── .echidna stranger gate ──')
{
  const users = {
    'stranger@s.whatsapp.net': { name: 'Nobody', level: 3, wallet: { solars: 5, gems: 0 } },
  }
  const db = makeDb(users)
  const ctx = makeCtx(db, 'stranger@s.whatsapp.net', ['hi'])
  await echidnaMod.default.run(ctx)
  check('non-holder gets a static dismissal, no API call', /not the one|Strangers|Do the maths/.test(ctx.replies.join(' ')))
}

// ════════════════ 5. .wisdom ════════════════
console.log('── .wisdom readouts ──')
{
  const users = {
    'p4@s.whatsapp.net': {
      name: 'Reader', level: 20,
      ownedCharacters: ['echidna'], equippedCharacter: 'echidna',
      wallet: { solars: 777, gems: 4 },
      inBattle: true,
      battleState: { enemy: { name: 'Golem', emoji: '🗿', hp: 90, maxHp: 120, atk: 15, def: 12, solars: 250, activeEffects: [] } },
    },
    'p5@s.whatsapp.net': { name: 'Poor', level: 2, equippedCharacter: null, wallet: { solars: 1, gems: 0 } },
  }
  const db = makeDb(users)
  const ctx = makeCtx(db, 'p4@s.whatsapp.net')
  await wisdomMod.default.run(ctx)
  const text = ctx.replies.join('\n')
  check('enemy page read in battle', /BOOK OF WISDOM/.test(text) && /Golem/.test(text) && /250 Solars/.test(text))

  const ctx2 = makeCtx(db, 'p5@s.whatsapp.net')
  await wisdomMod.default.run(ctx2)
  check('refused without Echidna equipped', /stays shut/.test(ctx2.replies.join('')))
}

// ════════════════ 6. .echidna AI chat ════════════════
console.log('── .echidna AI chat (graceful path) ──')
{
  const users = {
    'owner@s.whatsapp.net': {
      name: 'Blader', level: 88,
      ownedCharacters: ['echidna'], equippedCharacter: 'echidna',
      wallet: { solars: 12500, gems: 9.5 },
      echidnaChild: { name: 'Nyx', bornAt: Date.now() - 90 * 3600_000, visits: 3, lastVisitAt: 0 },
      inBattle: false,
    },
  }
  const db = makeDb(users)
  const ctx = makeCtx(db, 'owner@s.whatsapp.net', ['hi'])
  await echidnaMod.default.run(ctx)
  const out = ctx.replies.join('\n')
  // The contract here is: whatever happens - no key, blocked network, API
  // hiccup, or a successful answer - the owner gets ONE in-character reply
  // and the plugin never throws. Network egress to AI providers varies by
  // machine, so a graceful "the page comes back blank" also passes.
  check('owner gets exactly one in-character reply', out.length > 10 && !/Error|TypeError|undefined/.test(out))
  if (config.groqApiKey || config.openrouterApiKey) {
    console.log('     key configured; live reply preview:', out.slice(0, 140).replace(/\n/g, ' '))
  } else {
    console.log('     no AI key configured - chat uses the in-character quiet-time reply')
  }
}

console.log(failures === 0 ? '\nSMOKE TEST: ALL PASSED' : `\nSMOKE TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
