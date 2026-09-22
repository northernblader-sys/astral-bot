/**
 * echidna-battle-gate.test.mjs — pins that Echidna's battle commands are
 * reachable DURING a battle, on all three platforms.
 *
 * THE BUG THIS KILLS. handler.js and lib/platform/pipeline.js each hold a
 * BATTLE_ALLOWED_COMMANDS set: while player.inBattle is true, a command that is
 * not in that set is rejected before its plugin ever runs. Every character
 * active in this bot has tripped over it at least once (the comment above the
 * set in handler.js counts the instances), and Echidna had it twice over:
 *
 *   .greed    her once-per-battle Gospel of Greed. It spends the turn, writes
 *             bs.greedTitheUsed, tangles the enemy's next move and pays out of
 *             the enemy's carried wallet. It is a battle action in the strictest
 *             sense, and the gate rejected it in every dungeon, swarm floor and
 *             boss fight.
 *   .wisdom   her Book of Wisdom readout. Its PvE branch reads battleState.enemy
 *             (HP, attack, defence, carried wealth, statuses), so mid-fight is
 *             the only place it says anything the player cannot already see.
 *
 * Duels do not set player.inBattle and pvp.js routes .greed through its own
 * 'greedtithe' action, so she appeared to work in PvP and nowhere else. Which
 * is the same disguise the four other actives wore before their own lines.
 *
 * Also pinned here, in both directions:
 *   - the `.echidna` hub command must NOT clear the gate. `.echidna ritual`
 *     creates a child on the house state and `.echidna name` rewrites it; doing
 *     that with a live battleState is precisely the state corruption the gate
 *     exists to prevent. Her status card is a nicety, not a reason.
 *   - every token whitelisted for her must belong to her. `cmd` is the raw
 *     typed token with no alias resolution, so whitelisting 'read' whitelists
 *     whatever ELSE is called 'read' too (see the 'night'/'dl' note in
 *     handler.js's premium block, which dodged exactly that).
 *
 * Run:  node test/echidna-battle-gate.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let passed = 0
const failures = []
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (err) { failures.push(name); console.log(`FAIL  ${name}\n      ${err.message.split('\n')[0]}`) }
}

/** Extract the quoted tokens of a `NAME = new Set([...])` literal from source. */
function gateTokens(src, label) {
  const block = src.match(/BATTLE_ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\n\]\)/)
  assert.ok(block, `${label}: BATTLE_ALLOWED_COMMANDS set not found`)
  const out = new Set()
  for (const line of block[1].split('\n')) {
    if (!/^\s*'/.test(line)) continue   // comment lines start with //
    for (const m of line.matchAll(/'([^']+)'/g)) out.add(m[1])
  }
  return out
}

/** name + aliases declared by a plugin file, without importing it. */
function pluginTokens(rel) {
  const src = read(rel)
  const name = src.match(/\n\s*name:\s*'([^']+)'/)?.[1]
  const aliases = src.match(/aliases:\s*\[([^\]]*)\]/)?.[1] ?? ''
  return [name, ...aliases.matchAll(/'([^']+)'/g).map(m => m[1])].filter(Boolean)
}

const HANDLER = gateTokens(read('handler.js'), 'handler.js')
const PIPELINE = gateTokens(read('lib/platform/pipeline.js'), 'pipeline.js (Discord/Telegram)')

// The real token lists, read from the plugins themselves so a future alias on
// greed.js or wisdom.js has to be added to the gate before this file goes green.
const GREED = pluginTokens('plugins/greed.js')
const WISDOM = pluginTokens('plugins/wisdom.js')
const ECHIDNA_HUB = pluginTokens('plugins/echidna.js')
const BATTLE_TOKENS = [...GREED, ...WISDOM]

console.log('── 1. her battle commands clear the gate ───────────────────────')
ok(`greed.js declares ${GREED.length} tokens, wisdom.js ${WISDOM.length}`, () => {
  assert.ok(GREED.includes('greed'), 'plugins/greed.js should be registered as .greed')
  assert.ok(WISDOM.includes('wisdom'), 'plugins/wisdom.js should be registered as .wisdom')
  assert.ok(GREED.length >= 2 && WISDOM.length >= 2, 'alias lists look truncated')
})
for (const tok of BATTLE_TOKENS) {
  ok(`'${tok}' allowed mid-battle on WhatsApp (handler.js)`, () => assert.ok(HANDLER.has(tok)))
  ok(`'${tok}' allowed mid-battle on Discord/Telegram (pipeline.js)`, () => assert.ok(PIPELINE.has(tok)))
}

console.log('\n── 2. the rite stays OUT of battle ─────────────────────────────')
for (const tok of ECHIDNA_HUB) {
  ok(`'${tok}' (the hub command) is NOT battle-allowed anywhere`, () => {
    assert.ok(!HANDLER.has(tok), `handler.js whitelists '${tok}'`)
    assert.ok(!PIPELINE.has(tok), `pipeline.js whitelists '${tok}'`)
  })
}

console.log('\n── 3. no other command rides in on her aliases ─────────────────')
{
  const owners = new Map()
  for (const f of readdirSync(join(ROOT, 'plugins')).filter(f => f.endsWith('.js'))) {
    for (const tok of pluginTokens(`plugins/${f}`)) {
      if (!owners.has(tok)) owners.set(tok, [])
      owners.get(tok).push(f)
    }
  }
  const foreign = BATTLE_TOKENS.filter(t => (owners.get(t) ?? []).some(f => f !== 'greed.js' && f !== 'wisdom.js'))
  ok('every whitelisted token belongs to greed.js or wisdom.js only', () => {
    assert.deepEqual(foreign, [], `these tokens are also claimed by another plugin: ${foreign.join(', ')}`)
  })
  const dupe = BATTLE_TOKENS.filter((t, i) => BATTLE_TOKENS.indexOf(t) !== i)
  ok('no token is listed twice across the two plugins', () => assert.deepEqual(dupe, []))
}

console.log('\n── 4. the two gate copies stay in lockstep for her ─────────────')
ok('handler.js and pipeline.js agree on every Echidna token', () => {
  const onlyHandler = BATTLE_TOKENS.filter(t => HANDLER.has(t) && !PIPELINE.has(t))
  const onlyPipeline = BATTLE_TOKENS.filter(t => PIPELINE.has(t) && !HANDLER.has(t))
  assert.deepEqual(onlyHandler, [], `missing from pipeline.js: ${onlyHandler.join(', ')}`)
  assert.deepEqual(onlyPipeline, [], `missing from handler.js: ${onlyPipeline.join(', ')}`)
})

// Informational only, and deliberately not an assertion. pipeline.js copies
// handler.js's set by hand ("importing handler.js would drag Baileys-dependent
// modules into the Discord/Telegram processes"), and as of today it is missing
// several other characters' actives (kurama, puppetry, timestop and the Aizen /
// premium ability tokens). That drift is a pre-existing bug of the same family
// this file exists for, printed here so the next session can see the size of it
// without a red suite.
const drifted = [...HANDLER].filter(t => !PIPELINE.has(t))
console.log(`  note  ${drifted.length} handler.js tokens are absent from pipeline.js: ${drifted.join(', ') || 'none'}`)

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
