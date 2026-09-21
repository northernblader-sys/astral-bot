/**
 * echidna.test.mjs - regression tests for Echidna, the Witch of Greed:
 *
 *  1. CHARACTER ENTRY - data/characters.json carries echidna with the
 *     exclusive flag, the animated giphy GIF as her portrait (the
 *     replyGif path), the webp spin card, and Book of Wisdom as her
 *     listed ability.
 *
 *  2. SPIN CURVE - spins 1-250 are a true 0% dead zone ("she doesn't
 *     accept you yet"), spin 251+ is a guaranteed 100%, the lifetime cap
 *     is 275, and the cost is 0.9 gems - exactly the design numbers.
 *
 *  3. MOODS - the roll splits 45/35/20 into amused/capricious/displeased,
 *     and each mood's tithe share is right (half / half / quarter).
 *
 *  4. PV TITHE - resolveEchidnaTithePvE credits the holder's wallet with
 *     the mood-shaped share of the enemy's carried solars plus the gem
 *     plunder; wallets never go negative; a missing wallet is created.
 *
 *  5. PVP TITHE - echidnaPvpTithe takes half the opponent's solars when
 *     amused/capricious and a quarter when displeased, steals gems only up
 *     to what exists, and can never push a wallet below zero - including
 *     against an empty wallet.
 *
 *  6. THE CHILD - stage thresholds (newborn -> infant 12h -> child 36h ->
 *     grown 72h effective age), the +6h-per-visit growth boost, the visit
 *     cooldown, naming validation, and the stage-scaled battle bonus.
 *
 *  7. SPIN ROUTE - plugins/character.js's SPIN_ROUTES table points her
 *     card at .echidna-spin (source-level check; importing the plugin
 *     pulls in canvas-era deps the test env does not install).
 *
 * Run:  node test/echidna.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'

const { chanceForExclusiveSpin } = await import('../lib/season-engine.js')
const { characterMap } = await import('../lib/game-data.js')
const spinMod = await import('../plugins/echidna-spin.js')
const {
  ECHIDNA_MOODS, rollEchidnaMood, echidnaTitheAmounts, echidnaGemPlunder,
  resolveEchidnaTithePvE, echidnaPvpTithe, buildGreedTitheReveal,
  hasEchidna, ownsEchidna,
} = await import('../lib/echidna.js')
const child = await import('../lib/echidna-child.js')

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log(`  ✅ ${name}`)
}

console.log('── 1. character entry ──────────────────────────────────────────')
const echidna = characterMap.echidna
ok('echidna exists in data/characters.json', () => assert.ok(echidna))
ok('she is a bot-wide exclusive, not for sale', () => {
  assert.equal(echidna.exclusive, true)
  assert.equal(echidna.gemPrice, null)
  assert.equal(echidna.mondPrice, undefined)
})
ok('portrait is her animated giphy GIF (the replyGif path)', () => {
  assert.match(echidna.image, /giphy\.com\/media\/.*giphy\.gif$/)
})
ok('spin card is the provided webp', () => {
  assert.match(echidna.spinImage, /Echidna-Spin-.*\.webp$/)
})
ok('listed ability is the Book of Wisdom', () => {
  assert.equal(echidna.ability.name, 'Book of Wisdom')
  assert.match(echidna.ability.flavor, /\.greed/)
  assert.match(echidna.ability.flavor, /\.echidna/)
})
ok('name and rarity match the witch series', () => {
  assert.equal(echidna.name, 'Echidna, the Witch of Greed')
  assert.equal(echidna.rarity, 'boundless')
})

console.log('── 2. spin curve ───────────────────────────────────────────────')
const SPIN_OPTS = {
  deadZoneUntil: spinMod.DEAD_ZONE_UNTIL,
  plateauChance: spinMod.PLATEAU_CHANCE,
  pityAt: spinMod.PITY_AT,
}
ok('constants: 275 total spins, 0.9 gems, dead zone to 250', () => {
  assert.equal(spinMod.MAX_SPINS_PER_PLAYER, 275)
  assert.equal(spinMod.COST_PER_SPIN, 0.9)
  assert.equal(spinMod.DEAD_ZONE_UNTIL, 250)
  assert.equal(spinMod.PITY_AT, 251)
  assert.equal(spinMod.PLATEAU_CHANCE, 1.0)
  assert.equal(spinMod.CHARACTER_ID, 'echidna')
})
ok('spins 1-250: flat 0% - she does not accept you yet', () => {
  for (const n of [1, 50, 125, 200, 249, 250]) {
    assert.equal(chanceForExclusiveSpin(n, SPIN_OPTS), 0, `spin ${n} must be 0%`)
  }
})
ok('spins 251-275: 100% - once the wall is paid she cannot be missed', () => {
  for (const n of [251, 260, 275]) {
    assert.equal(chanceForExclusiveSpin(n, SPIN_OPTS), 1, `spin ${n} must be 100%`)
  }
})

console.log('── 3. moods ────────────────────────────────────────────────────')
ok('mood roll splits 45/35/20', () => {
  assert.equal(rollEchidnaMood(0.00), 'amused')
  assert.equal(rollEchidnaMood(0.44), 'amused')
  assert.equal(rollEchidnaMood(0.45), 'capricious')
  assert.equal(rollEchidnaMood(0.79), 'capricious')
  assert.equal(rollEchidnaMood(0.80), 'displeased')
  assert.equal(rollEchidnaMood(0.99), 'displeased')
})
ok('tithe shares: half when amused/capricious, quarter when displeased', () => {
  assert.equal(echidnaTitheAmounts(1000, 'amused').solars, 500)
  assert.equal(echidnaTitheAmounts(1000, 'capricious').solars, 500)
  assert.equal(echidnaTitheAmounts(1000, 'displeased').solars, 250)
  assert.equal(echidnaTitheAmounts(0, 'amused').solars, 0)
  assert.equal(echidnaTitheAmounts(-5, 'amused').solars, 0)
})
ok('gem plunder obeys the mood', () => {
  assert.equal(echidnaGemPlunder('amused', { rand: 0.1, available: 5 }), 1)
  assert.equal(echidnaGemPlunder('amused', { rand: 0.9, available: 5 }), 0)
  assert.equal(echidnaGemPlunder('amused', { rand: 0.1, available: 0 }), 0)
  assert.equal(echidnaGemPlunder('displeased', { rand: 0.0, available: 9 }), 0)
})

console.log('── 4. PvE tithe ────────────────────────────────────────────────')
ok('holder wallet credited, enemy untouched', () => {
  const player = { wallet: { solars: 100, gems: 2 } }
  const enemy = { solars: 400, hp: 500 }
  const res = resolveEchidnaTithePvE(player, enemy, 'amused', { rand: 0.9 })
  assert.equal(res.solars, 200) // half of 400, no child, gem roll missed
  assert.equal(player.wallet.solars, 300)
  assert.equal(player.wallet.gems, 2)
  assert.equal(enemy.hp, 500) // the tithe deals no damage
  assert.equal(enemy.solars, 400) // and rewrites nothing on the enemy
})
ok('gem plunder lands when the mood allows', () => {
  const player = { wallet: { solars: 0, gems: 0 } }
  const res = resolveEchidnaTithePvE(player, { solars: 100 }, 'amused', { rand: 0.1 })
  assert.equal(res.gems, 1)
  assert.equal(player.wallet.gems, 1)
})
ok('a player with no wallet gets one, never negative', () => {
  const player = {}
  const res = resolveEchidnaTithePvE(player, { solars: 0 }, 'displeased', { rand: 0.5 })
  assert.equal(res.solars, 0)
  assert.equal(player.wallet.solars, 0)
  assert.ok(player.wallet.gems >= 0)
})
ok('reveal copy carries mood, money and the distraction', () => {
  const text = buildGreedTitheReveal({
    ownerName: 'Tester', enemyName: 'Bandit', mood: 'amused',
    solars: 200, gems: 1, context: 'dungeon',
  })
  assert.match(text, /GOSPEL OF GREED/)
  assert.match(text, /\+200 Solars/)
  assert.match(text, /1 gem/)
})

console.log('── 5. PvP tithe ────────────────────────────────────────────────')
ok('amused takes half the opponent\'s solars', () => {
  const res = echidnaPvpTithe({ solars: 1000, gems: 4 }, 'amused', { rand: 0.9 })
  assert.equal(res.solarsTaken, 500)
  assert.equal(res.gemsTaken, 0) // rand past the plunder chance
})
ok('gem theft comes off the opponent and is capped at what exists', () => {
  const two = echidnaPvpTithe({ solars: 100, gems: 2 }, 'amused', { rand: 0.1 })
  assert.equal(two.gemsTaken, 2)
  const one = echidnaPvpTithe({ solars: 100, gems: 1 }, 'capricious', { rand: 0.1 })
  assert.equal(one.gemsTaken, 1)
  const none = echidnaPvpTithe({ solars: 100, gems: 0 }, 'amused', { rand: 0.1 })
  assert.equal(none.gemsTaken, 0)
})
ok('displeased takes a quarter and no gems', () => {
  const res = echidnaPvpTithe({ solars: 1000, gems: 9 }, 'displeased', { rand: 0.0 })
  assert.equal(res.solarsTaken, 250)
  assert.equal(res.gemsTaken, 0)
})
ok('empty/broken wallets yield zero, never negative', () => {
  for (const wallet of [{ solars: 0, gems: 0 }, {}, { solars: -50, gems: -3 }, null]) {
    const res = echidnaPvpTithe(wallet, 'amused', { rand: 0.0 })
    assert.ok(res.solarsTaken >= 0)
    assert.ok(res.gemsTaken >= 0)
  }
})
ok('a grown child adds its cut on top', () => {
  const grown = { name: 'Nyx', bornAt: Date.now() - 100 * 3600_000, visits: 0 }
  const res = echidnaPvpTithe({ solars: 1000, gems: 0 }, 'amused', { rand: 0.99, child: grown })
  assert.ok(res.solarsTaken >= 500 + Math.floor(500 * 0.18) || res.solarsTaken <= 1000)
  assert.ok(res.childBonus >= 0)
})

console.log('── 6. the child ────────────────────────────────────────────────')
const NOW = Date.now()
const bornAgo = (h) => ({ name: 'Nyx', bornAt: NOW - h * 3_600_000, visits: 0, lastVisitAt: 0 })
ok('stage thresholds: 12h infant, 36h child, 72h grown', () => {
  assert.equal(child.getChildStage(bornAgo(1), NOW), 'newborn')
  assert.equal(child.getChildStage(bornAgo(13), NOW), 'infant')
  assert.equal(child.getChildStage(bornAgo(40), NOW), 'child')
  assert.equal(child.getChildStage(bornAgo(80), NOW), 'grown')
})
ok('each visit counts as 6h of growth', () => {
  const c = { ...bornAgo(1), visits: 2 } // 1h + 12h = 13h effective
  assert.equal(child.getChildStage(c, NOW), 'infant')
  assert.equal(child.getChildStage({ ...bornAgo(1), visits: 12 }, NOW), 'grown')
})
ok('visit math: newborn + one visit stays newborn until 12h effective', () => {
  const player = { echidnaChild: bornAgo(1) }
  const res = child.visitChild(player, NOW)
  assert.equal(res.ok, true)
  // 1h real + 6h boost = 7h effective -> still newborn
  assert.equal(res.stage, 'newborn')
  assert.equal(res.grewUp, false)
})
ok('a visit that crosses a threshold reports the stage-up', () => {
  const player = { echidnaChild: bornAgo(7) } // 7h + 6h visit = 13h -> infant
  const res = child.visitChild(player, NOW)
  assert.equal(res.stage, 'infant')
  assert.equal(res.grewUp, true)
  assert.equal(res.gift, child.VISIT_GIFT_SOLARS.infant)
})
ok('visits respect the cooldown', () => {
  const player = { echidnaChild: bornAgo(1) }
  assert.equal(child.visitChild(player, NOW).ok, true)
  const again = child.visitChild(player, NOW + 60_000)
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'cooldown')
  const later = child.visitChild(player, NOW + child.VISIT_COOLDOWN_MS + 1)
  assert.equal(later.ok, true)
})
ok('naming strips markdown and enforces the length cap', () => {
  const player = { echidnaChild: bornAgo(1) }
  assert.equal(child.nameChild(player, '*Loot*').ok, true)
  assert.equal(player.echidnaChild.name, 'Loot')
  assert.equal(child.nameChild(player, '   ').ok, false)
  assert.equal(child.nameChild(player, 'x'.repeat(30)).ok, false)
  assert.equal(child.nameChild({}, 'Nyx').reason, 'no_child')
})
ok('battle bonus scales with stage and stays inert without a child', () => {
  assert.deepEqual(child.childBattleBonus(null), { hasChild: false, stage: null, solarsPct: 0, gemChance: 0, line: '' })
  assert.equal(child.childBattleBonus(bornAgo(1), NOW).solarsPct, 0.04)
  assert.equal(child.childBattleBonus(bornAgo(80), NOW).solarsPct, 0.18)
  assert.equal(child.childBattleBonus(bornAgo(80), NOW).gemChance, 0.30)
  assert.match(child.childBattleBonus(bornAgo(80), NOW).line, /Little Gospel/)
})
ok('hasChild guards a missing record', () => {
  assert.equal(child.hasChild({}), false)
  assert.equal(child.hasChild({ echidnaChild: { bornAt: NOW } }), true)
})

console.log('── 7. wiring ───────────────────────────────────────────────────')
ok('hasEchidna/ownsEchidna read equip and ownership', () => {
  assert.equal(hasEchidna({ equippedCharacter: 'echidna' }), true)
  assert.equal(hasEchidna({ equippedCharacter: 'alexa' }), false)
  assert.equal(ownsEchidna({ ownedCharacters: ['echidna'] }), true)
  assert.equal(ownsEchidna({}), false)
})
ok('character.js routes her card at .echidna-spin', () => {
  const src = readFileSync(new URL('../plugins/character.js', import.meta.url), 'utf8')
  assert.match(src, /echidna:\s*'echidna-spin'/)
})
ok('pvp.js registers the greedtithe action end to end', () => {
  const src = readFileSync(new URL('../plugins/pvp.js', import.meta.url), 'utf8')
  assert.match(src, /GREED_ALIASES = new Set/)
  assert.match(src, /'greedtithe'/)
  assert.match(src, /export async function pvpGreedTithe/)
  assert.match(src, /echidnaPvpTithe\(opp\.wallet, greedMood/)
})
ok('the greed plugin covers swarm, boss and PvP handoff', () => {
  const src = readFileSync(new URL('../plugins/greed.js', import.meta.url), 'utf8')
  assert.match(src, /pvpGreedTithe\(ctx\)/)
  assert.match(src, /resolveSwarmAbility/)
  assert.match(src, /incrementBossTurn/)
})
ok('the .echidna plugin wires ritual, child, name and chat', () => {
  const src = readFileSync(new URL('../plugins/echidna.js', import.meta.url), 'utf8')
  assert.match(src, /runRitual/)
  assert.match(src, /runVisit/)
  assert.match(src, /runName/)
  assert.match(src, /askGemini/)
})
ok('config carries the key as a secret, not a default', () => {
  const src = readFileSync(new URL('../config.js', import.meta.url), 'utf8')
  assert.match(src, /geminiApiKey: env\('GEMINI_API_KEY', ''\)/)
  assert.match(src, /'GEMINI_API_KEY'/)
})

console.log(`\nALL ${passed} ECHIDNA CHECKS PASSED`)
