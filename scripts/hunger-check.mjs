/**
 * Hunger rework checks: starvation must never kill, never touch HP, drain a
 * lot of stamina, and collapse the player instead.
 * Run: node scripts/hunger-check.mjs
 */
import {
  applyHungerTick, ensureHunger, isCollapsed, collapseMessage,
  feed, hungerBar, resetHunger, STARVE_HP_PER_MIN, STARVE_STAM_PER_MIN,
} from '../lib/hunger-engine.js'

const MIN = 60 * 1000
const mk = () => ({
  name: 'Tester', hp: 400, maxHp: 400, mp: 50, maxMp: 50,
  stamina: { current: 100, max: 100 },
  location: 'deep_forest', inBattle: false, inDungeon: true, dungeonFloor: 4,
})

let pass = 0, fail = 0
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <- ' + extra : '')) }
}

console.log('\n=== 1. Constants ===')
t('HP drain per minute is 0', STARVE_HP_PER_MIN === 0, 'got ' + STARVE_HP_PER_MIN)
t('stamina drain is steep (>= 20/min)', STARVE_STAM_PER_MIN >= 20, 'got ' + STARVE_STAM_PER_MIN)

console.log('\n=== 2. Away for 10 days while starving -> still alive ===')
{
  const p = mk()
  const t0 = 1_000_000_000_000
  ensureHunger(p, t0)
  const d = applyHungerTick(p, t0 + 10 * 24 * 60 * MIN)
  t('no death flag anywhere', !d.died && !d.message, JSON.stringify(Object.keys(d)))
  t('HP completely untouched', p.hp === 400, 'got ' + p.hp)
  t('starving reported', d.starving === true)
  t('hpLost is 0', d.hpLost === 0, 'got ' + d.hpLost)
  t('stamina drained to 0', p.stamina.current === 0, 'got ' + p.stamina.current)
  t('reported as collapsed', d.collapsed === true)
  t('still in their dungeon (not yanked to town)', p.inDungeon === true && p.location === 'deep_forest')
  t('hunger bar reads empty', Math.round(p.hunger.current) === 0)
}

console.log('\n=== 3. Collapse threshold ===')
{
  const p = mk()
  const t0 = 2_000_000_000_000
  ensureHunger(p, t0)
  t('not collapsed while fed', !isCollapsed(p))

  // 90 min empties the bar exactly; +1 min of starving = 25 stamina gone.
  const d1 = applyHungerTick(p, t0 + 91 * MIN)
  t('1 min of starving drains ~25 stamina', p.stamina.current === 75, 'got ' + p.stamina.current)
  t('starving but NOT yet collapsed (stamina left)', d1.starving && !d1.collapsed)
  t('isCollapsed false with stamina remaining', !isCollapsed(p))

  const d2 = applyHungerTick(p, t0 + 95 * MIN)
  t('4 more min wipes the rest of the stamina', p.stamina.current === 0, 'got ' + p.stamina.current)
  t('now collapsed', d2.collapsed === true && isCollapsed(p))
  t('HP still full through all of it', p.hp === 400, 'got ' + p.hp)
}

console.log('\n=== 4. Eating stands you back up ===')
{
  const p = mk()
  const t0 = 3_000_000_000_000
  ensureHunger(p, t0)
  applyHungerTick(p, t0 + 200 * MIN)
  t('collapsed first', isCollapsed(p))
  feed(p, 60, { now: t0 + 200 * MIN })
  t('no longer collapsed after eating', !isCollapsed(p))
  t('hunger restored', Math.round(p.hunger.current) === 60, 'got ' + p.hunger.current)
  const d = applyHungerTick(p, t0 + 201 * MIN)
  t('fed player takes no drain', !d.starving, JSON.stringify(d))
}

console.log('\n=== 5. Golden Apple immunity can never collapse ===')
{
  const p = mk()
  const t0 = 4_000_000_000_000
  ensureHunger(p, t0)
  feed(p, 0, { immune: true })
  p.stamina.current = 0
  const d = applyHungerTick(p, t0 + 500 * MIN)
  t('immune reported', d.immune === true)
  t('bar pinned full', p.hunger.current === p.hunger.max)
  t('never collapsed even at 0 stamina', !isCollapsed(p))
  t('bar shows immune tag', /immune/.test(hungerBar(p)))
}

console.log('\n=== 6. Mid-battle starvation is stamina-only, never lethal ===')
{
  const p = mk()
  p.inBattle = true
  p.hp = 12
  const t0 = 5_000_000_000_000
  ensureHunger(p, t0)
  const d = applyHungerTick(p, t0 + 400 * MIN)
  t('low-HP player in battle survives', p.hp === 12, 'got ' + p.hp)
  t('no death', !d.died)
  t('stamina still drains in battle', p.stamina.current === 0)
  t('battle state untouched', p.inBattle === true)
}

console.log('\n=== 7. Messaging ===')
{
  const p = mk()
  const t0 = 6_000_000_000_000
  ensureHunger(p, t0)
  const d = applyHungerTick(p, t0 + 300 * MIN)
  t('warn message mentions stamina', /stamina/i.test(d.warnMessage ?? ''))
  t('warn message promises no death', /won't die/i.test(d.warnMessage ?? ''))
  t('warn message does NOT threaten HP', !/\bHP\b/.test(d.warnMessage ?? ''))
  const cm = collapseMessage(p)
  t('collapse message says collapsed', /collapsed/i.test(cm))
  t('collapse message reassures about stats', /no.*stats/i.test(cm))
  t('collapse message tells them to eat', /eat/i.test(cm))
  t('bar shows collapsed tag', /collapsed/.test(hungerBar(p)), hungerBar(p))
}

console.log('\n=== 8. resetHunger still clears everything ===')
{
  const p = mk()
  const t0 = 7_000_000_000_000
  ensureHunger(p, t0)
  applyHungerTick(p, t0 + 300 * MIN)
  resetHunger(p, t0 + 300 * MIN)
  t('bar refilled', p.hunger.current === p.hunger.max)
  t('not collapsed after reset', !isCollapsed(p))
  t('debts cleared', p.hunger.stamDebt === 0 && p.hunger.hpDebt === 0)
}

console.log('\n' + '='.repeat(52))
console.log('  ' + pass + ' passed, ' + fail + ' failed')
console.log('='.repeat(52))
process.exit(fail ? 1 : 0)
