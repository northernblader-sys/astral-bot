/**
 * Behavioral checks for Megumi Fushiguro — the Ten Shadows Technique,
 * Chimera Shadow Garden, and Mahoraga's Wheel of adaptation.
 * Run: node scripts/megumi-check.mjs
 */
import {
  megumiTurnStart, activateChimeraDomain, resolveMegumiIncoming,
  isChimeraDomainActive, moveKeyFor, hasMahoraga,
} from '../lib/megumi.js'
import { getEffectiveStat } from '../lib/effects.js'

const mk = () => ({
  name: 'Megumi', equippedCharacter: 'megumi', hp: 500, maxHp: 1000, mp: 100, maxMp: 100,
  stats: { atk: 100, def: 50, int: 80 }, activeEffects: [],
  battleState: { turn: 1 },
})
const enemy = () => ({ name: 'Sukuna', hp: 2000, maxHp: 2000, stats: { atk: 300, def: 40 }, activeEffects: [] })

let pass = 0, fail = 0
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <- ' + extra : '')) }
}

console.log('\n=== 1. Mahoraga: same skill 3x -> 0 damage forever ===')
{
  const p = mk(), bs = p.battleState
  const hit = () => resolveMegumiIncoming(p, { damage: 200, kind: 'skill', id: 'fireball', label: 'fireball', bs })
  const r1 = hit(), r2 = hit(), r3 = hit(), r4 = hit()
  t('hit 1 full damage (200)', r1.damage === 200, 'got ' + r1.damage)
  t('hit 1 narrates 1/3', /1\/3/.test(r1.message))
  t('hit 2 full damage (200)', r2.damage === 200, 'got ' + r2.damage)
  t('hit 2 narrates 2/3', /2\/3/.test(r2.message))
  t('hit 3 nullified -> 0', r3.damage === 0 && r3.nullified, 'got ' + r3.damage)
  t('hit 3 spins the wheel (GIF caption set)', !!r3.wheelCaption)
  t('hit 4+ still 0 (mastered forever)', r4.damage === 0 && r4.nullified, 'got ' + r4.damage)
  t('hit 4 does NOT re-spin the GIF', !r4.wheelCaption)
}

console.log('\n=== 2. Different move resets the count; mastery is permanent ===')
{
  const p = mk(), bs = p.battleState
  const fire = () => resolveMegumiIncoming(p, { damage: 100, kind: 'skill', id: 'fireball', label: 'fireball', bs })
  const ice = () => resolveMegumiIncoming(p, { damage: 100, kind: 'skill', id: 'icelance', label: 'icelance', bs })
  fire(); fire()
  t('switching to a new skill deals full damage', ice().damage === 100)
  t('fireball count RESET by the switch', fire().damage === 100)
  fire(); const fire3 = fire()
  t('fireball mastered after 3 consecutive', fire3.damage === 0)
  t('a DIFFERENT skill still deals full damage', ice().damage === 100)
  ice(); const ice3 = ice()
  t('icelance masters on its own 3-count', ice3.damage === 0)
  t('fireball STILL 0 (mastery permanent)', fire().damage === 0)
}

console.log('\n=== 3. .pvp attack (basic) masters on its own identity ===')
{
  const p = mk(), bs = p.battleState
  const atk = () => resolveMegumiIncoming(p, { damage: 150, kind: 'attack', label: 'ATTACK', bs })
  atk(); atk()
  const a3 = atk()
  t('basic attack nullified after 3x', a3.damage === 0 && a3.nullified)
  t('wheel spun for basic attack', !!a3.wheelCaption)
  t("moveKeyFor('attack') === 'attack'", moveKeyFor('attack') === 'attack')
  t("moveKeyFor('skill','fireball') === 'skill:fireball'", moveKeyFor('skill', 'fireball') === 'skill:fireball')
}

console.log('\n=== 4. Mahoraga adapts to TRUE damage too (boss DEF-bypass) ===')
{
  const p = mk(), bs = p.battleState
  const boss = () => resolveMegumiIncoming(p, { damage: 400, trueDamage: true, kind: 'boss', id: 'Malevolent Shrine', label: 'Malevolent Shrine', bs })
  boss(); boss()
  const b3 = boss()
  t('true-damage boss attack nullified after 3x', b3.damage === 0 && b3.nullified, 'got ' + b3.damage)
}

console.log('\n=== 5. Non-Megumi defender untouched (safe to call anywhere) ===')
{
  const other = { name: 'Bob', equippedCharacter: 'wither', hp: 500, maxHp: 1000, activeEffects: [], battleState: { turn: 1 } }
  const r = resolveMegumiIncoming(other, { damage: 250, kind: 'skill', id: 'fireball', bs: other.battleState })
  t('damage passes through unchanged', r.damage === 250, 'got ' + r.damage)
  t('no lines emitted', r.lines.length === 0)
  t('hasMahoraga false for non-Megumi', hasMahoraga(other) === false)
}

console.log('\n=== 6. Thousand Shadows Swarm: drain + self-heal + ATK cut ===')
{
  const p = mk(), e = enemy(), bs = p.battleState
  const hpBefore = p.hp, eBefore = e.hp
  const s1 = megumiTurnStart(p, e, bs)
  t('enemy lost HP (life force drained)', e.hp < eBefore, eBefore + ' -> ' + e.hp)
  t('drain is 3.5% of enemy MAX hp on turn 1', eBefore - e.hp === Math.round(2000 * 0.035), 'got ' + (eBefore - e.hp))
  t('Megumi healed 40% of the drain', p.hp - hpBefore === Math.round((eBefore - e.hp) * 0.40), 'got ' + (p.hp - hpBefore))
  t('enemy has an ATK-cut effect the engine can read',
    e.activeEffects.some(f => f.type === 'weaken' && f.meta?.stat === 'atk'))
  t('getEffectiveStat reports the LOWERED atk', getEffectiveStat(e, 'atk') < 300, 'got ' + getEffectiveStat(e, 'atk'))
  t('narration mentions a thousand cursed spirits', /thousand cursed spirits/i.test(s1.message))
  const cut1 = e.activeEffects.find(f => f.type === 'weaken').value
  megumiTurnStart(p, e, bs)
  const cut2 = e.activeEffects.find(f => f.type === 'weaken').value
  t('ATK cut DEEPENS each turn', cut2 > cut1, cut1 + ' -> ' + cut2)
  t('ATK cut never stacks into multiple entries', e.activeEffects.filter(f => f.type === 'weaken').length === 1)

  // Real dungeon/boss monsters carry a bare `atk`, not `stats.atk`.
  const mob = { name: 'Cursed Womb', hp: 900, maxHp: 900, atk: 120, activeEffects: [] }
  const pm = mk()
  megumiTurnStart(pm, mob, pm.battleState)
  t('bare-atk monster (dungeon/boss shape) also gets weakened',
    getEffectiveStat(mob, 'atk') < 120, 'got ' + getEffectiveStat(mob, 'atk'))
  t('bare-atk monster also gets drained', mob.hp < 900, 'got ' + mob.hp)
}

console.log('\n=== 7. Domain Expansion: Chimera Shadow Garden ===')
{
  const p = mk(), bs = p.battleState
  t('domain not active before use', !isChimeraDomainActive(p))
  const g = activateChimeraDomain(p)
  t('activates successfully', g.ok === true)
  t('grants an opening-burst multiplier (9x)', g.multiplier === 9)
  t('domain now active', isChimeraDomainActive(p))
  t('summons Mahoraga (canon tie-in)', g.mahoragaSummoned === true)
  t('narration names the domain', /CHIMERA SHADOW GARDEN/.test(g.message))
  t('narration includes the Japanese name', /嵌合暗翳庭/.test(g.message))
  const g2 = activateChimeraDomain(p)
  t('cannot open twice in one battle', g2.ok === false && g2.alreadyUsed === true)

  const e2 = enemy()
  const before = e2.hp
  megumiTurnStart(p, e2, bs)
  const expected = Math.round(2000 * 0.035 * 2) + Math.round(2000 * 0.05) + Math.round(2000 * 0.03)
  t('swarm drain DOUBLED + shikigami + Mahoraga blade inside domain',
    before - e2.hp === expected, 'got ' + (before - e2.hp) + ', expected ' + expected)

  t('non-Megumi cannot expand', activateChimeraDomain({ name: 'Bob', equippedCharacter: 'wither', battleState: { turn: 1 } }).ok === false)
  t('cannot expand outside battle', activateChimeraDomain({ name: 'M', equippedCharacter: 'megumi' }).ok === false)
}

console.log('\n=== 8. Shadow-travel dodge exists only while the Garden is open ===')
{
  const p = mk(), bs = p.battleState
  let dodges = 0
  for (let i = 0; i < 400; i++) {
    if (resolveMegumiIncoming(p, { damage: 100, kind: 'skill', id: 's' + i, label: 's', bs }).dodged) dodges++
  }
  t('NO dodges before the domain is open', dodges === 0, 'got ' + dodges)

  const p2 = mk()
  activateChimeraDomain(p2)
  let d2 = 0
  for (let i = 0; i < 2000; i++) {
    if (resolveMegumiIncoming(p2, { damage: 100, kind: 'skill', id: 'u' + i, label: 'u', bs: p2.battleState }).dodged) d2++
  }
  const rate = d2 / 2000
  t('~45% shadow dodge while open', rate > 0.38 && rate < 0.52, (rate * 100).toFixed(1) + '%')

  let dTrue = 0
  for (let i = 0; i < 500; i++) {
    if (resolveMegumiIncoming(p2, { damage: 100, trueDamage: true, kind: 'skill', id: 'v' + i, label: 'v', bs: p2.battleState }).dodged) dTrue++
  }
  t('true damage is EXEMPT from the shadow dodge', dTrue === 0, 'got ' + dTrue)
}

console.log('\n' + '='.repeat(52))
console.log('  ' + pass + ' passed, ' + fail + ' failed')
console.log('='.repeat(52))
process.exit(fail ? 1 : 0)
