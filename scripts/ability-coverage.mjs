/**
 * Coverage audit: does every character's combat-critical hook actually fire
 * on every surface?
 *
 *   attack.js + skill.js  -> monsters, DUNGEONS and BOSSES (shared battleState)
 *   pvp.js                -> the separate duel engine
 *
 * A hook that exists in lib/ but is never called by a combat file is a
 * character that silently does nothing in that mode.
 *
 * Run: node scripts/ability-coverage.mjs
 */
import fs from 'node:fs'

// Only hooks that MUST run for the character to function in a fight.
// 'cmd' hooks are driven by the character's own command/action, so they are
// expected in pvp.js + that plugin, not in attack.js/skill.js.
const CHARACTERS = {
  'Mei':                  [['applyMeiSustainHeal', 'hit'], ['activateFinalForm', 'cmd']],
  'Kisuke Urahara':       [['applyTearOnHit', 'hit'], ['tickPermanentSever', 'turn']],
  'Wither':               [['activateCinderVerdict', 'cmd']],
  'Willow':               [['sendWillowAdvisory', 'turn']],
  'Miyashi':              [['tickFrostbindAura', 'turn'], ['applyFrostlockGate', 'gate']],
  'Nisha':                [['rollSerpentsGrace', 'hit']],
  'Monica':               [['applyAbsoluteOneSiphon', 'turn']],
  'Tyla & Alya':          [['applyAlyaStatBreak', 'turn'], ['danceOfTheRainMultiplier', 'dmg'], ['applyIncomingDamage', 'hit']],
  'Demon Lord Anastasia': [['resolveHypnosisRewind', 'death']],
  'Circe, the Jester':    [['resolveCirceGuard', 'hit'], ['resolveWildCard', 'cmd']],
  'Yoriichi':             [['checkYoriichiCatForm', 'death']],
  'Megumi Fushiguro':     [['megumiTurnStart', 'turn'], ['resolveMegumiIncoming', 'hit'], ['activateChimeraDomain', 'cmd']],
}

const SURFACES = {
  'attack (mob/dungeon/boss)': 'plugins/attack.js',
  'skill  (mob/dungeon/boss)': 'plugins/skill.js',
  'pvp    (duels)':            'plugins/pvp.js',
}
const src = {}
for (const k in SURFACES) src[k] = fs.readFileSync(SURFACES[k], 'utf8')

// Some hooks are deliberately reached INDIRECTLY through a shared handler, so
// a direct-call grep would report a false gap. Each entry says: hook X counts
// as wired on a surface if that surface calls wrapper Y, and Y really does
// call X (asserted below against the wrapper's own source).
const INDIRECT = {
  applyMeiSustainHeal:    { via: 'applyIncomingDamage',  where: 'lib/character-abilities.js' },
  resolveCirceGuard:      { via: 'applyIncomingDamage',  where: 'lib/character-abilities.js' },
  checkYoriichiCatForm:   { via: 'resolvePlayerHpZero',  where: 'lib/combat-handlers.js' },
  resolveHypnosisRewind:  { via: 'resolvePlayerHpZero',  where: 'lib/combat-handlers.js' },
}

const called = (name, text) =>
  new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(').test(text)

// Verify each indirect claim is actually true, so this table can't rot silently.
const brokenClaims = []
for (const [hook, { via, where }] of Object.entries(INDIRECT)) {
  if (!called(hook, fs.readFileSync(where, 'utf8'))) brokenClaims.push(hook + ' is NOT called in ' + where)
}

const isWired = (hook, text) => {
  if (called(hook, text)) return 'ok'
  const ind = INDIRECT[hook]
  if (ind && called(ind.via, text)) return 'via'
  return ' !!'
}

const surfaceKeys = Object.keys(SURFACES)
console.log('character                hook                          atk  skl  pvp')
console.log('-'.repeat(74))

const gaps = []
for (const [char, hooks] of Object.entries(CHARACTERS)) {
  hooks.forEach(([hook, kind], i) => {
    const marks = surfaceKeys.map(k => {
      const w = isWired(hook, src[k])
      return w === ' !!' ? (kind === 'cmd' ? '  -' : ' !!') : (w === 'via' ? 'ind' : ' ok')
    })
    console.log(
      (i === 0 ? char : '').padEnd(25) +
      (hook + ' [' + kind + ']').padEnd(30) +
      marks.join('  ')
    )
    if (marks.includes(' !!')) {
      gaps.push(char + ' :: ' + hook + ' missing from ' +
        surfaceKeys.filter((k, j) => marks[j] === ' !!').join(', '))
    }
  })
}

console.log('\n' + '='.repeat(74))
console.log('  ok = called directly   ind = via a shared handler   - = own command only')
if (brokenClaims.length) {
  console.log('\n  STALE INDIRECT CLAIMS:')
  for (const b of brokenClaims) console.log('   - ' + b)
}
if (gaps.length === 0) {
  console.log('\n  No gaps: every character functions on all three surfaces.')
} else {
  console.log('\n  GAPS FOUND (' + gaps.length + '):')
  for (const g of gaps) console.log('   - ' + g)
}
console.log('='.repeat(74))
process.exit(gaps.length || brokenClaims.length ? 1 : 0)
