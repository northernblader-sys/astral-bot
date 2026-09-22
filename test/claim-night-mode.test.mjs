/**
 * claim-night-mode.test.mjs — `.claim <code>` must work for CARDS and SERIES,
 * including while `.night on` has the realm closed.
 *
 * THE TWO BUGS THIS KILLS.
 *
 * 1. `.claim <code>` never claimed anything. 'claim' is registered twice:
 *    plugins/claim.js (the card claim) and plugins/daily.js (alias of the daily
 *    reward). The loader resolves a same-platform alias collision to the LAST
 *    plugin registered (lib/plugin-manager.js resolvePlugin — explicitly
 *    last-wins, and its own comment names 'claim'/daily.js as the case it
 *    preserves), which by file-load order is daily.js. daily.js ignored its
 *    args entirely, so a player typing `.claim K7Q2MN` at a spawned card got
 *    their DAILY REWARD and the card stayed on the floor. And even had claim.js
 *    won the key, it only looked at lib/card-spawn-state.js, so a SERIES code
 *    answered "No card is currently spawned here."
 *
 * 2. `.night on` locked the claim out. The night gate in handler.js refused
 *    everything outside LOCKOUT_EXEMPT_COMMANDS (ban appeals). Night mode pauses
 *    the spawn SWEEPS but does not clear a spawn that is already live, so a card
 *    or series that appeared a minute before the realm closed was stranded with
 *    its code posted and nobody able to spend it until morning.
 *
 * Sections:
 *   1. Registry — which plugin actually answers `.claim` (the fact bug 1 hides)
 *   2. `.claim <code>` claims a CARD, and a SERIES
 *   3. `.collect <code>` still claims both (no regression)
 *   4. Wrong code / no spawn — refused without consuming anything
 *   5. The night gate — claims pass, everything else is refused
 *   6. Claims are still NOT exempt from ban/jail (scope check)
 *   7. End to end through handler.js's makeHandler with night mode ON
 *
 * Runs the REAL plugins and the REAL handler gate through a mocked ctx/db the
 * way handler.js would, without starting the bot or a WhatsApp socket.
 *
 * Run:  node test/claim-night-mode.test.mjs
 */
// Set before config.js is first imported: the plugin registry logs ~20 pre-existing
// "Alias collision" warnings at WARN, which would bury this test's own output.
process.env.LOG_LEVEL ??= 'error'

import { config } from '../config.js'

const dailyMod   = await import('../plugins/daily.js')
const claimMod   = await import('../plugins/claim.js')
const collectMod = await import('../plugins/collect.js')
const handler    = await import('../handler.js')

const { setActiveSpawn, clearActiveSpawn, getActiveSpawn } = await import('../lib/card-spawn-state.js')
const { setActiveSeriesSpawn, clearActiveSeriesSpawn, getActiveSeriesSpawn } = await import('../lib/series-spawn-state.js')
const { setNightMode, isNightMode } = await import('../lib/night-mode.js')
const { buildNewPlayer } = await import('../lib/player-factory.js')

let failures = 0
function check(name, cond) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name)
  if (!cond) failures++
}

function makeDb(users) {
  return { data: { users }, write: async () => {}, read: async () => {} }
}

function makeCtx(db, from, args = []) {
  const replies = []
  return {
    db, from, args,
    player: db.data.users[from],
    sender: from,
    isGroup: true,
    platform: 'whatsapp',
    reply: async (t) => { replies.push(String(t)); return {} },
    replyImage: async (_img, t) => { replies.push('[IMG] ' + String(t)); return {} },
    replies,
  }
}

/**
 * A real player record, built by the same factory the bot registers with. The
 * daily reward runs a genuine level-up pass (applyLevelUps -> ensureStatPoints
 * -> getTotalStats), which needs a valid classId/raceId AND a populated
 * stats/baseStats/statPoints block — hand-rolling that shape here would just
 * rot the first time lib/player-factory.js changes.
 */
function makePlayer(id, extra = {}) {
  const p = buildNewPlayer({ id, name: 'Tester', classId: 'warrior', raceId: 'human' })
  p.level = 10
  p.wallet.solars = 1000   // known baseline: the claim tests assert this never moves
  p.cards = []
  p.seriesCollection = []
  return { ...p, ...extra }
}

const CARD_SPAWN = {
  title: 'Naruto Uzumaki',
  imageUrl: 'https://example.test/naruto.png',
  tier: 4,
  series: 'Naruto',
  claim: 'K7Q2MN',
}

const SERIES_SPAWN = {
  anilistId: 21,
  title: 'One Piece',
  imageUrl: 'https://example.test/onepiece.png',
  score: 8.7,
  tier: 'A',
  claimCode: 'RT4X9B',
}

/** Wipe both spawn slots so a test never inherits the previous one's spawn. */
function resetSpawns(jid) {
  clearActiveSpawn(jid)
  clearActiveSeriesSpawn(jid)
}

// ════════════════ 1. Registry: who actually answers .claim? ════════════════
console.log('── 1. Registry resolution for the claim keys ──')
{
  const { loadPlugins, getPluginFor, setActivePlatform } = await import('../lib/plugin-manager.js')
  setActivePlatform('whatsapp')
  await loadPlugins('./plugins')

  const claimWinner = getPluginFor('claim', 'whatsapp')
  const collectWinner = getPluginFor('collect', 'whatsapp')
  const grabWinner = getPluginFor('grab', 'whatsapp')

  // Not asserting WHICH plugin wins — that is file-load order and the loader
  // documents last-wins. Asserting the thing that must hold either way: whoever
  // holds the 'claim' key has to be one of the two that can spend a code, and
  // the daily reward must not be reachable by a name that means "grab a card".
  check('.claim resolves to a real plugin', !!claimWinner)
  check(".claim is held by daily.js or claim.js",
    ['daily', 'claim'].includes(claimWinner?.name))
  check('.collect resolves to collect.js', collectWinner?.name === 'collect')
  check('.grab resolves to collect.js', grabWinner?.name === 'collect')

  // The routing that makes bug 1 impossible to reintroduce silently: whichever
  // plugin holds 'claim', a 6-char code argument must reach the spawn claim.
  check('collect.js exports the shared claim helper',
    typeof collectMod.claimActiveSpawn === 'function')
  check('collect.js exports the claim-code shape test',
    typeof collectMod.looksLikeClaimCode === 'function')
  check('daily.js routes claim codes (imports the shared helper)',
    /\bclaimActiveSpawn\b/.test(String(dailyMod.default.run)))
}

// ════════════════ 2. .claim <code> claims a CARD and a SERIES ════════════════
console.log('\n── 2. .claim <code> — card and series ──')
{
  const JID = 'g-card@s.whatsapp.net'
  resetSpawns(JID)
  const users = { [JID]: makePlayer(JID) }
  const db = makeDb(users)

  setActiveSpawn(JID, { ...CARD_SPAWN })
  const ctx = makeCtx(db, JID, ['K7Q2MN'])
  await dailyMod.default.run(ctx)   // daily.js owns the 'claim' key — see §1

  const p = users[JID]
  const text = ctx.replies.join('\n')
  check('card claimed via .claim <code>', p.cards.length === 1)
  check('the RIGHT card was claimed', p.cards[0]?.title === 'Naruto Uzumaki')
  check('reply is a claim success, not a daily reward',
    /claimed the card|collected the card/.test(text) && !/Daily Reward|already claimed/i.test(text))
  check('spawn slot cleared after the claim', getActiveSpawn(JID) === null)
  check('the daily reward was NOT paid out', p.wallet.solars === 1000)

  // Same command, series code.
  resetSpawns(JID)
  p.cards = []
  setActiveSeriesSpawn(JID, { ...SERIES_SPAWN })
  const ctx2 = makeCtx(db, JID, ['RT4X9B'])
  await dailyMod.default.run(ctx2)
  const text2 = ctx2.replies.join('\n')
  check('series claimed via .claim <code>', p.seriesCollection.length === 1)
  check('the RIGHT series was claimed', p.seriesCollection[0]?.title === 'One Piece')
  check('series entry stored a sell price', (p.seriesCollection[0]?.sellPrice ?? 0) > 0)
  check('reply is a series claim success', /claimed the series/.test(text2))
  check('series spawn slot cleared', getActiveSeriesSpawn(JID) === null)

  // claim.js itself must also handle both, so the command works no matter
  // which plugin ends up holding the 'claim' key.
  resetSpawns(JID)
  p.seriesCollection = []
  setActiveSeriesSpawn(JID, { ...SERIES_SPAWN })
  const ctx3 = makeCtx(db, JID, ['RT4X9B'])
  await claimMod.default.run(ctx3)
  check('claim.js also claims a SERIES (not cards only)', p.seriesCollection.length === 1)

  resetSpawns(JID)
  p.cards = []
  setActiveSpawn(JID, { ...CARD_SPAWN })
  const ctx4 = makeCtx(db, JID, ['K7Q2MN'])
  await claimMod.default.run(ctx4)
  check('claim.js still claims a CARD', p.cards.length === 1)
}

// ════════════════ 3. .collect <code> — unchanged for both ════════════════
console.log('\n── 3. .collect <code> — no regression ──')
{
  const JID = 'g-collect@s.whatsapp.net'
  resetSpawns(JID)
  const users = { [JID]: makePlayer(JID) }
  const db = makeDb(users)
  const p = users[JID]

  setActiveSpawn(JID, { ...CARD_SPAWN })
  await collectMod.default.run(makeCtx(db, JID, ['K7Q2MN']))
  check('.collect claims a card', p.cards.length === 1)

  resetSpawns(JID)
  setActiveSeriesSpawn(JID, { ...SERIES_SPAWN })
  await collectMod.default.run(makeCtx(db, JID, ['RT4X9B']))
  check('.collect claims a series', p.seriesCollection.length === 1)

  resetSpawns(JID)
  const ctx = makeCtx(db, JID, [])
  await collectMod.default.run(ctx)
  check('.collect with no code prints usage', /Usage/.test(ctx.replies.join('\n')))

  resetSpawns(JID)
  const ctx2 = makeCtx(db, JID, ['AAAAAA'])
  await dailyMod.default.run(ctx2)
  check('.claim with no spawn says nothing is spawned',
    /No card, series/.test(ctx2.replies.join('\n')))
}

// ════════════════ 4. Wrong code must not consume the spawn ════════════════
console.log('\n── 4. Wrong code / no consumption ──')
{
  const JID = 'g-wrong@s.whatsapp.net'
  resetSpawns(JID)
  const users = { [JID]: makePlayer(JID) }
  const db = makeDb(users)
  const p = users[JID]

  setActiveSpawn(JID, { ...CARD_SPAWN })
  setActiveSeriesSpawn(JID, { ...SERIES_SPAWN })

  const ctx = makeCtx(db, JID, ['ZZZZZZ'])
  await dailyMod.default.run(ctx)
  check('wrong code is refused', /Wrong code/.test(ctx.replies.join('\n')))
  check('wrong code claimed nothing', p.cards.length === 0 && p.seriesCollection.length === 0)
  check('wrong code left BOTH spawns live',
    getActiveSpawn(JID) !== null && getActiveSeriesSpawn(JID) !== null)

  // A non-code argument must still be the daily reward, not a spawn claim.
  resetSpawns(JID)
  const ctx2 = makeCtx(db, JID, ['extra'])
  await dailyMod.default.run(ctx2)
  check('.claim extra falls through to the daily reward',
    /Daily Reward Claimed/.test(ctx2.replies.join('\n')))

  const ctx3 = makeCtx(db, JID, [])
  await dailyMod.default.run(ctx3)
  check('bare .claim is the daily reward (already claimed today)',
    /already claimed today/i.test(ctx3.replies.join('\n')))
  resetSpawns(JID)
}

// ════════════════ 5. The night gate ════════════════
console.log('\n── 5. Night gate — claims survive .night on ──')
{
  setNightMode(true, 'owner@s.whatsapp.net')
  check('night mode is on for this section', isNightMode() === true)

  for (const cmd of ['claim', 'collect', 'grab']) {
    check(`'${cmd}' passes the night gate`, handler.isNightModeAllowed(cmd) === true)
  }
  for (const cmd of ['appeal', 'unban', 'unban-me', 'unbanme']) {
    check(`'${cmd}' still passes the night gate (ban appeals)`,
      handler.isNightModeAllowed(cmd) === true)
  }
  for (const cmd of ['attack', 'daily', 'series', 'pokemon', 'pvp', 'shop', 'register']) {
    check(`'${cmd}' is still refused at night`, handler.isNightModeAllowed(cmd) === false)
  }

  // The gate function must be the one handler.js actually calls, not a lookalike.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../handler.js', import.meta.url), 'utf8')
  const gate = src.slice(src.indexOf('if (isNightMode() &&'), src.indexOf('── Ban lockout'))
  check('handler.js night gate calls isNightModeAllowed(cmd)',
    /if \(!isNightModeAllowed\(cmd\)\)/.test(gate))
  check('the exemption is checked BEFORE the "go to sleep" notice is sent',
    gate.indexOf('isNightModeAllowed') < gate.indexOf('shouldNotifyNight'))
  check('the night gate still exempts owner and mods',
    /if \(isNightMode\(\) && !isOwnerJid\(from\) && !isMod\(db, from\)\)/.test(src))

  setNightMode(false, 'owner@s.whatsapp.net')
  check('night mode switched back off', isNightMode() === false)
}

// ════════════════ 6. Scope: claims do NOT escape ban/jail ════════════════
console.log('\n── 6. Scope check — ban/jail lockout untouched ──')
{
  const src = (await import('node:fs')).readFileSync(new URL('../handler.js', import.meta.url), 'utf8')
  const banGate = src.slice(src.indexOf('── Ban lockout'), src.indexOf('── Jail lockout'))
  check('ban lockout still keys off LOCKOUT_EXEMPT_COMMANDS only',
    /LOCKOUT_EXEMPT_COMMANDS\.has\(cmd\)/.test(banGate) && !/isNightModeAllowed/.test(banGate))
  check("'claim' was NOT added to the every-lockout exemption set",
    /const LOCKOUT_EXEMPT_COMMANDS = new Set\(\['unban', 'unban-me', 'unbanme', 'appeal'\]\)/.test(src))

  // A claim is a code spend, not a bot-utility: it must stay gated by the
  // character-state lockouts (inn sleep / hunger collapse) like any game action.
  check('.claim is still treated as an RPG action, not a bot utility',
    handler.isNonRpgCommand('claim') === false)
}

// ════════════════ 7. End to end through the REAL handler ════════════════
// Everything above tests the gate function and the plugins separately. This
// drives handler.js's own makeHandler with a fake socket, so the night gate,
// the prefix parse, the plugin registry lookup and the claim plugin all run as
// one path — which is the only version of this that proves a player typing
// `.claim K7Q2MN` at 2am gets the card.
console.log('\n── 7. End to end: makeHandler with night mode ON ──')
{
  const GROUP  = '120363000000000000@g.us'
  const PLAYER = '5511900000001@s.whatsapp.net'

  const { loadPlugins, setActivePlatform } = await import('../lib/plugin-manager.js')
  setActivePlatform('whatsapp')
  await loadPlugins('./plugins')

  const player = makePlayer(PLAYER)
  const db = makeDb({ [PLAYER]: player })
  db.data.chats = {}
  db.data.settings = {}

  const sent = []
  const sock = {
    sendMessage: async (_jid, content) => { sent.push(String(content?.text ?? content?.caption ?? '')); return {} },
    sendPresenceUpdate: async () => {},
    presenceSubscribe: async () => {},
    profilePictureUrl: async () => { throw new Error('no pfp') },
    fetchGroupMetadata: async () => ({ participants: [], subject: 'Test Group' }),
    groupMetadata: async () => ({ participants: [], subject: 'Test Group' }),
    readMessages: async () => {},
  }
  const handleMessage = handler.makeHandler(sock, db, 'Astral')

  const inbound = (text) => ({
    type: 'notify',
    messages: [{
      key: { remoteJid: GROUP, participant: PLAYER, fromMe: false, id: `T${Math.random().toString(36).slice(2)}` },
      message: { conversation: text },
      messageTimestamp: Math.floor(Date.now() / 1000),
    }],
  })

  setNightMode(true, 'owner@s.whatsapp.net')

  // Control: an ordinary command must still be refused.
  sent.length = 0
  await handleMessage(inbound(`${config.prefix}attack`))
  check('at night, .attack gets the "bot is asleep" notice',
    sent.some(t => /night time|asleep/i.test(t)))

  // The card claim, through the whole pipeline.
  setActiveSpawn(GROUP, { ...CARD_SPAWN })
  sent.length = 0
  await handleMessage(inbound(`${config.prefix}claim K7Q2MN`))
  check('at night, .claim <code> reaches the plugin (not "unknown command")',
    !sent.some(t => /Unknown command/.test(t)))
  check('at night, .claim <code> claims the CARD', player.cards.some(c => c.title === 'Naruto Uzumaki'))
  check('at night, the claim reply is sent to the group',
    sent.some(t => /collected the card|claimed the card/.test(t)))

  // The series claim, through the whole pipeline.
  setActiveSeriesSpawn(GROUP, { ...SERIES_SPAWN })
  sent.length = 0
  await handleMessage(inbound(`${config.prefix}collect RT4X9B`))
  check('at night, .collect <code> claims the SERIES',
    player.seriesCollection.some(s => s.title === 'One Piece'))

  setNightMode(false, 'owner@s.whatsapp.net')
  resetSpawns(GROUP)
  check('night mode left OFF after the suite', isNightMode() === false)
}

console.log('\n' + '='.repeat(56))
if (failures) {
  console.log(`  ${failures} FAILED`)
  console.log('='.repeat(56))
  process.exit(1)
}
console.log('  all checks passed')
console.log('='.repeat(56))
console.log(`  (prefix is "${config.prefix}")`)
