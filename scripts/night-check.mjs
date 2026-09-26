/**
 * Night mode checks: the switch, its durability, the notice throttle, and that
 * the gate is actually wired into the handler chokepoint and all three sweeps.
 * Run: node scripts/night-check.mjs
 */
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'

const STATE = fileURLToPath(new URL('../data/night-mode.json', import.meta.url))
const HANDLER = readFileSync(new URL('../handler.js', import.meta.url), 'utf8')
const MAIN = readFileSync(new URL('../main.js', import.meta.url), 'utf8')

// Start from a known-clean slate so a leftover file can't skew the run.
const had = existsSync(STATE) ? readFileSync(STATE, 'utf8') : null
if (existsSync(STATE)) unlinkSync(STATE)

const {
  isNightMode, getNightState, setNightMode, shouldNotifyNight, nightNotice,
} = await import('../lib/night-mode.js')

let pass = 0, fail = 0
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <- ' + extra : '')) }
}

console.log('\n=== 1. Toggle ===')
t('defaults to OFF (fails open)', isNightMode() === false)
{
  const r = setNightMode(true, 'owner@s.whatsapp.net')
  t('turning on reports changed', r.changed === true)
  t('isNightMode true', isNightMode() === true)
  t('records who turned it on', getNightState().by === 'owner@s.whatsapp.net')
  t('records when', typeof getNightState().since === 'number')

  const again = setNightMode(true, 'owner@s.whatsapp.net')
  t('turning on twice reports NOT changed', again.changed === false)

  const off = setNightMode(false, 'owner@s.whatsapp.net')
  t('turning off reports changed', off.changed === true)
  t('isNightMode false', isNightMode() === false)
  t('since cleared on off', getNightState().since === null)
  t('turning off twice reports NOT changed', setNightMode(false).changed === false)
}

console.log('\n=== 2. Durability across a restart ===')
{
  setNightMode(true, 'mod@s.whatsapp.net')
  t('state file written', existsSync(STATE))
  const onDisk = JSON.parse(readFileSync(STATE, 'utf8'))
  t('file says on', onDisk.on === true)

  // Fresh module instance = what a restart sees.
  const fresh = await import('../lib/night-mode.js?restart=1')
  t('survives a restart as ON', fresh.isNightMode() === true)

  setNightMode(false)
  const fresh2 = await import('../lib/night-mode.js?restart=2')
  t('survives a restart as OFF', fresh2.isNightMode() === false)
}

console.log('\n=== 3. Corrupt state file fails OPEN (never bricks the bot) ===')
{
  writeFileSync(STATE, '{ this is not json', 'utf8')
  const broken = await import('../lib/night-mode.js?restart=3')
  t('corrupt file -> night mode OFF', broken.isNightMode() === false)
  t('no throw on import', true)
  setNightMode(false)
}

console.log('\n=== 4. Notice throttle ===')
{
  const jid = 'player1@s.whatsapp.net'
  const now = 1_700_000_000_000
  t('first blocked command notifies', shouldNotifyNight(jid, now) === true)
  t('immediate repeat is silent', shouldNotifyNight(jid, now + 1000) === false)
  t('still silent 29 min later', shouldNotifyNight(jid, now + 29 * 60000) === false)
  t('notifies again after 30 min', shouldNotifyNight(jid, now + 31 * 60000) === true)
  t('a different player is notified independently',
    shouldNotifyNight('player2@s.whatsapp.net', now + 1000) === true)

  // Toggling clears the throttle so the first person after a change is told.
  shouldNotifyNight('player3@s.whatsapp.net', now)
  setNightMode(true, 'owner@s.whatsapp.net')
  t('toggle resets the throttle', shouldNotifyNight('player3@s.whatsapp.net', now + 1000) === true)
  setNightMode(false)
}

console.log('\n=== 5. The notice text ===')
{
  const n = nightNotice('.')
  t('says it is night', /night/i.test(n))
  t('tells them to sleep/rest', /sleep|rest/i.test(n))
  t('says back tomorrow', /tomorrow/i.test(n))
  t('reassures nothing is lost', /saved/i.test(n))
  t('leaves no unreplaced placeholder', !/\{prefix\}/.test(n))
}

console.log('\n=== 6. Wired into handler.js ===')
t('imports the gate', /import \{[^}]*isNightMode[^}]*\} from '\.\/lib\/night-mode\.js'/.test(HANDLER))
t('imports isMod', /import \{ isMod \} from '\.\/lib\/mod-repo\.js'/.test(HANDLER))
t('gate checks night mode', /if \(isNightMode\(\) &&/.test(HANDLER))
t('owner is exempt', /isNightMode\(\) && !isOwnerJid\(from\)/.test(HANDLER))
t('mods are exempt', /!isMod\(db, from\)/.test(HANDLER))
t('gate returns (blocks the command)', /shouldNotifyNight\(from\)[\s\S]{0,300}?return/.test(HANDLER))
t('gate sits before the ban lockout',
  HANDLER.indexOf('isNightMode()') < HANDLER.indexOf('const ban = getBan(db, from)'))
t('gate sits after the command is parsed',
  HANDLER.indexOf('const cmd = rawCmd.toLowerCase()') < HANDLER.indexOf('isNightMode()'))

// Ban appeals must survive the night, same as they survive the ban/jail
// lockouts — otherwise someone banned at 2am has no route out until morning.
// So must spawn claims: night mode pauses the spawn SWEEPS but never clears a
// spawn that is already live, so without this a card or series that appeared
// just before `.night on` sits there with its code posted and nobody able to
// spend it until morning. See SPAWN_CLAIM_COMMANDS in handler.js.
{
  const gate = HANDLER.slice(HANDLER.indexOf('isNightMode() &&'), HANDLER.indexOf('── Ban lockout'))
  t('the night gate routes exemptions through isNightModeAllowed()',
    /if \(!isNightModeAllowed\(cmd\)\)/.test(gate))
  t('isNightModeAllowed keeps ban appeals reachable',
    /export function isNightModeAllowed\(cmd\) \{[\s\S]{0,200}?LOCKOUT_EXEMPT_COMMANDS\.has\(cmd\)/.test(HANDLER))
  t('isNightModeAllowed keeps spawn claims reachable',
    /SPAWN_CLAIM_COMMANDS = new Set\(\['claim', 'collect', 'grab'\]\)/.test(HANDLER))
  t('exemption is checked BEFORE the notice is sent',
    gate.indexOf('isNightModeAllowed') < gate.indexOf('shouldNotifyNight'))
  // Widening the night gate must not widen the ban/jail lockouts with it.
  const banGate = HANDLER.slice(HANDLER.indexOf('── Ban lockout'), HANDLER.indexOf('── Jail lockout'))
  t("'claim' was NOT added to the every-lockout exemption set",
    /const LOCKOUT_EXEMPT_COMMANDS = new Set\(\['unban', 'unban-me', 'unbanme', 'appeal'\]\)/.test(HANDLER)
    && !/isNightModeAllowed/.test(banGate))
}

console.log('\n=== 6b. In-battle commands are reachable mid-battle ===')
{
  const block = HANDLER.match(/BATTLE_ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\n\]\)/)[1]
  const allowed = new Set([...block.matchAll(/^\s*'.*$/gm)]
    .flatMap(l => [...l[0].matchAll(/'([^']+)'/g)].map(m => m[1])))
  // Every command whose plugin hard-requires being in battle must clear the
  // gate, or it is unreachable in the only state it works in.
  for (const id of [
    'attack', 'skill', 'defend', 'flee',            // core
    'cinderverdict', 'wildcard', 'circe',           // Wither, Circe
    'ultimate',                                     // Nisha's dragon
    'domain-expansion', 'domain', 'chimera',        // Megumi
    'mahoraga',                                     // Megumi (status card)
    'finalform', 'ff', 'transform',                // Mei
    'greed', 'tithe', 'wisdom',                     // Echidna
    'willow', 'advise', 'advisor',                  // Willow
    'pvp', 'duel', 'dparty', 'pattack',             // PvP + party
    'cb', 'unstuck',                                // escape hatch
  ]) t("'" + id + "' clears the battle gate", allowed.has(id))
}

console.log('\n=== 7. Wired into all three spawn sweeps ===')
for (const fn of ['runCardSpawnSweep', 'runSeriesSpawnSweep', 'runPokemonSpawnSweep']) {
  const start = MAIN.indexOf('async function ' + fn)
  const body = MAIN.slice(start, start + 900)
  t(fn + ' gated', start !== -1 && /if \(isNightMode\(\)\) return/.test(body))
  t(fn + ' gated BEFORE it picks a socket',
    body.indexOf('isNightMode()') < body.indexOf('instances.map'))
}
// Named-import list, not a literal `{ isNightMode }` — main.js also imports
// onNightModeOff from the same module, and the old single-name pattern silently
// stopped matching the day that second import was added.
t('main.js imports the gate',
  /import \{[^}]*\bisNightMode\b[^}]*\} from '\.\/lib\/night-mode\.js'/.test(MAIN))
t('exactly 3 sweeps gated', (MAIN.match(/if \(isNightMode\(\)\) return/g) ?? []).length === 3)

// Leave the repo as we found it.
if (had === null) { if (existsSync(STATE)) unlinkSync(STATE) } else writeFileSync(STATE, had, 'utf8')

console.log('\n' + '='.repeat(52))
console.log('  ' + pass + ' passed, ' + fail + ' failed')
console.log('='.repeat(52))
process.exit(fail ? 1 : 0)
