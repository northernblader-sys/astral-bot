/**
 * generate-monsters.mjs — Deterministic monster generator for World of Astral.
 *
 * Generates all regular monsters fresh (no legacy entries preserved).
 * Stat anchor = floorRange[0] exactly. Assertion validates each monster
 * within ±20% of formula target at F = floorRange[0].
 * All 41 bosses are untouched.
 *
 * Run: node scripts/generate-monsters.mjs  (from game/ directory)
 */

import { readFileSync, writeFileSync } from 'fs'

const SEED = 7331

// ── Seeded RNG (mulberry32) ────────────────────────────────────────────────────
function makeRng(seed) {
  let s = seed >>> 0
  return {
    next()          { s += 0x6d2b79f5; let t = Math.imul(s^(s>>>15),1|s); t ^= t+Math.imul(t^(t>>>7),61|t); return ((t^(t>>>14))>>>0)/4294967296 },
    randint(lo, hi) { return lo + Math.floor(this.next()*(hi-lo+1)) },
    uniform(lo, hi) { return lo + this.next()*(hi-lo) },
    choice(arr)     { return arr[Math.floor(this.next()*arr.length)] },
    sample(arr, n)  { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(this.next()*(i+1));[a[i],a[j]]=[a[j],a[i]]} return a.slice(0,n) },
  }
}

// ── Gear bonus tables (real averages from weapons.json + items.json) ───────────
// Band midpoints: 100,300,500,700,900 (bands: 1-200,200-400,400-600,600-800,800-1000)
const BAND_MID     = [100,  300,   500,   700,   900]
const GEAR_PRIMARY = [2.4,  5.6,   8.4,  13.1,  21.2]
const GEAR_DEF     = [3.6,  2.5,  18.3,  18.0,  32.5]
const GEAR_HP      = [14.3, 8.8,  56.7,  55.0, 175.0]

function interp(F, mid, vals) {
  F = Math.max(mid[0], Math.min(mid[mid.length-1], F))
  for (let i = 0; i < mid.length-1; i++) {
    if (F >= mid[i] && F <= mid[i+1]) {
      const t = (F-mid[i])/(mid[i+1]-mid[i])
      return vals[i] + t*(vals[i+1]-vals[i])
    }
  }
  return vals[vals.length-1]
}
const gearPrimary = F => interp(F, BAND_MID, GEAR_PRIMARY)
const gearDef     = F => interp(F, BAND_MID, GEAR_DEF)
const gearHp      = F => interp(F, BAND_MID, GEAR_HP)

// ── Stat formulas — anchor is F = floorRange[0] ────────────────────────────────
function entryStats(F) {
  const avgPrimary = 12 + 4*(F-1)
  const monDef = Math.round(0.15 * avgPrimary)
  const monHp  = Math.round(3.5 * (avgPrimary - monDef))
  const plrDef = 5 + (F-1)
  const plrHp  = 100 + 10*(F-1)
  const monAtk = Math.round(plrHp/5 + plrDef)
  return [monHp, monDef, monAtk]
}

function endgameStats(F) {
  const playerPower = 408 + gearPrimary(F)
  const monDef  = Math.round(0.20 * playerPower)
  const monHp   = Math.round(4 * (playerPower - monDef))
  const plrDef  = 101 + gearDef(F)
  const plrHp   = 1130 + gearHp(F)
  const monAtk  = Math.round(plrHp/5 + plrDef)
  return [monHp, monDef, monAtk]
}

function perFloorScaling(statFn, F0, maxFloor) {
  const [hp0, def0, atk0] = statFn(F0)
  const F1 = Math.min(F0+1, maxFloor)
  const [hp1, def1, atk1] = statFn(F1)
  return [
    Math.round((hp1-hp0)   * 1000) / 1000,
    Math.round((def1-def0) * 1000) / 1000,
    Math.round((atk1-atk0) * 1000) / 1000,
  ]
}

// ── Assertion: baseStats must be within ±20% of formula target at floorRange[0] ──
function assertStats(monster, statFn) {
  const F0 = monster.floorRange[0]
  const [tHp, tDef, tAtk] = statFn(F0)
  const { hp, def, atk } = monster.baseStats

  const check = (label, actual, target) => {
    if (target === 0) return
    const ratio = actual / target
    if (ratio < 0.80 || ratio > 1.20) {
      console.error(`\nASSERTION FAILED: ${monster.id}`)
      console.error(`  ${label}: actual=${actual}, target=${target}, ratio=${ratio.toFixed(3)}`)
      console.error(`  floorRange[0]=${F0}, formula targets: hp=${tHp} def=${tDef} atk=${tAtk}`)
      process.exit(1)
    }
  }
  check('hp',  hp,  tHp)
  check('def', def, tDef)
  check('atk', atk, tAtk)
}

// ── Rarity helpers ─────────────────────────────────────────────────────────────
function entryRarity(F) {
  if (F < 30)  return 'common'
  if (F < 60)  return 'uncommon'
  if (F < 90)  return 'rare'
  return 'epic'
}
function endgameRarity(F) {
  if (F < 200) return 'common'
  if (F < 400) return 'uncommon'
  if (F < 600) return 'rare'
  if (F < 800) return 'epic'
  return 'legendary'
}

// ── Word banks ─────────────────────────────────────────────────────────────────
const WORDS = {
  entry_tower: {
    adj:  ['Crumbling','Feral','Mossy','Lurking','Stone','Dusty','Hollow','Twisted',
           'Rusted','Grim','Muddy','Spiked','Frenzied','Rotten','Snarling','Ancient',
           'Scarred','Mangled','Bloated','Withered','Darkened','Fanged','Clawed','Horned','Scaled'],
    noun: ['Slime','Rat','Crawler','Hound','Imp','Shade','Beetle','Worm','Golem',
           'Brute','Specter','Fiend','Stalker','Wretch','Creeper','Ogre','Ghoul',
           'Toad','Spider','Bat','Lizard','Gargoyle','Harpy','Basilisk','Chimera'],
  },
  gambits_dungeon: {
    adj:  ['Phantom','Mirror','Shifting','Illusory','Veiled','Tricky','Masked','Echoing',
           'Twisted','Fading','Cunning','Deceitful','Fractured','Mirrored','Spectral',
           'Elusive','Hollow','False','Shadow','Flickering','Uncanny','Deceptive',
           'Haunting','Unseen','Cursed'],
    noun: ['Jester','Mimic','Echo','Trickster','Shade','Phantom','Wisp','Gambler',
           'Illusion','Doppel','Lure','Specter','Marionette','Pawn','Jinx','Riddle',
           'Bluff','Ruse','Decoy','Mirage','Puppet','Wraith','Gambit','Facade','Ploy'],
  },
  centurions_dungeon: {
    adj:  ['Iron','Legion','Steel','Forged','Tempered','Battle-Worn','Reinforced','Ancient',
           'Sentinel','Shield','Vanguard','Hardened','Armoured','Relentless','Marching',
           'Bastion','Gilded','War-Torn','Rigid','Heavy','Unbending','Ranked','Bronze',
           'Veteran','Scarred'],
    noun: ['Centurion','Legionnaire','Sentinel','Vanguard','Bastion','Warden','Phalanx',
           'Shield','Tribune','Praetor','Cohort','Lancer','Bulwark','Rampart','Sentry',
           'Guardian','Juggernaut','Ironclad','Colossus','Oathkeeper','Warlord',
           'Gladiator','Champion','Enforcer','Paragon'],
  },
  astral_tower: {
    adj:  ['Void','Astral','Stellar','Nebular','Cosmic','Ethereal','Rift','Aetheric',
           'Starborn','Celestial','Abyssal','Radiant','Prismatic','Drifting','Formless',
           'Ancient','Dark','Luminous','Infinite','Unbound','Shattered','Eclipsed',
           'Fractured','Howling','Silent'],
    noun: ['Rift','Wraith','Star','Nebula','Voidling','Specter','Aether','Drifter',
           'Singularity','Anomaly','Flux','Comet','Pulsar','Shade','Remnant','Echo',
           'Phantom','Revenant','Watcher','Oracle','Wanderer','Colossus','Eye',
           'Leviathan','Shard'],
  },
  eternal_dungeon: {
    adj:  ['Decayed','Timeless','Ancient','Withered','Ruinous','Forsaken','Hollow',
           'Cursed','Bound','Sunken','Endless','Deathless','Rotting','Pale','Eternal',
           'Lost','Forgotten','Ashen','Bleached','Faded','Crumbling','Haunted',
           'Wailing','Dread','Still'],
    noun: ['Wraith','Specter','Revenant','Shade','Lich','Phantom','Soul','Ruin',
           'Echo','Fate','Remnant','Elegy','Warden','Reaper','Apparition','Dirge',
           'Effigy','Knell','Scourge','Wail','Husk','Vessel','Harbinger','Tempus','Void'],
  },
}

const EMOJIS = {
  entry_tower:        ['🐀','🟢','🦎','🐍','🕷️','🦂','🐗','🐺','👹','💀','🦴','🐊','🦅','🐉','🔥','⚡','🌑','🧟','👁️','🗿'],
  gambits_dungeon:    ['🃏','🪞','👁️','🌀','🌫️','🎭','🧿','💫','🕯️','🔮','🪄','🌙','🎪','🧩','⚗️','🌒','👤','🔯','🪬','💠'],
  centurions_dungeon: ['⚔️','🛡️','🪖','🏺','🗡️','⚙️','🔩','🗿','🪬','🧱','🏰','🪣','🔱','⚒️','🗜️','🔧','🏛️','🪚','🧲','💎'],
  astral_tower:       ['✨','🌟','💫','🌌','🔵','🌀','☄️','🌑','🌠','🪐','⭐','🌙','🔭','🌈','💠','🕳️','🎇','🌕','🛸','🌙'],
  eternal_dungeon:    ['💀','🦴','⚰️','🕯️','🌑','👻','🕰️','⌛','🌫️','🧿','🌚','🔮','🪦','🩸','😱','🌒','🌊','❄️','🌪️','🎑'],
}

// ── Drop builder ───────────────────────────────────────────────────────────────
function buildDrops(rng, rarity, matsByRarity, wepsByRarity, itemsByRarity, isElite) {
  const scale = isElite ? 1.5 : 1.0
  const drops = []
  const matPool = matsByRarity[rarity] || []
  if (matPool.length) {
    const picks = rng.sample(matPool, Math.min(2, matPool.length))
    const chances = [
      Math.round(Math.min(0.18, rng.uniform(0.08, 0.15)*scale)*100)/100,
      Math.round(Math.min(0.12, rng.uniform(0.05, 0.10)*scale)*100)/100,
    ]
    picks.forEach((id, i) => drops.push({ itemId: id, chance: chances[i] }))
  }
  const wepPool = wepsByRarity[rarity] || []
  if (wepPool.length && rng.next() < 0.25)
    drops.push({ itemId: rng.choice(wepPool), chance: Math.round(Math.min(0.08, rng.uniform(0.02, 0.06)*scale)*100)/100 })
  const itmPool = itemsByRarity[rarity] || []
  if (itmPool.length && rng.next() < 0.20)
    drops.push({ itemId: rng.choice(itmPool), chance: Math.round(Math.min(0.06, rng.uniform(0.02, 0.05)*scale)*100)/100 })
  return drops
}

// ── Name / ID helpers ──────────────────────────────────────────────────────────
function makeName(location, rng, usedNames) {
  const w = WORDS[location]
  for (let i = 0; i < 80; i++) {
    const c = `${rng.choice(w.adj)} ${rng.choice(w.noun)}`
    if (!usedNames.has(c)) { usedNames.add(c); return c }
  }
  let base = `${rng.choice(w.adj)} ${rng.choice(w.noun)}`, n = 2
  while (usedNames.has(`${base} ${n}`)) n++
  usedNames.add(`${base} ${n}`)
  return `${base} ${n}`
}

function makeId(location, name, usedIds) {
  const prefix = location.split('_')[0].slice(0,3)
  const base   = `${prefix}_${name.toLowerCase().replace(/[ -]/g,'_')}`
  let uid = base, n = 2
  while (usedIds.has(uid)) uid = `${base}_${n++}`
  usedIds.add(uid)
  return uid
}

// ── Reward formulas ────────────────────────────────────────────────────────────
const entryRewards   = F => ({ xpBase: Math.max(8, Math.round(8+0.52*(F-1))),  xpPerFloor: 0.52, solarsBase: Math.max(2, Math.round(2+0.13*(F-1))),  solarsPerFloor: 0.13 })
const endgameRewards = F => ({ xpBase: Math.round(500+2*F), xpPerFloor: 2, solarsBase: Math.round(80+0.4*F), solarsPerFloor: 0.4 })

// ── Generator ──────────────────────────────────────────────────────────────────
function generate(location, floorMin, floorMax, count, spanMin, spanMax,
                  statFn, rarityFn, rewardFn,
                  matsByRarity, wepsByRarity, itemsByRarity,
                  rng, usedIds) {
  const monsters  = []
  const usedNames = new Set()
  const emojiPool = EMOJIS[location]
  const maxStart  = floorMax - spanMin
  const step      = (maxStart - floorMin) / Math.max(1, count-1)

  for (let i = 0; i < count; i++) {
    const span = rng.randint(spanMin, spanMax)
    const fLo  = Math.max(floorMin, Math.round(floorMin + i*step))  // anchor floor
    const fHi  = Math.min(floorMax, fLo + span)

    // Compute formula targets at F = fLo (floorRange[0])
    const [tHp, tDef, tAtk] = statFn(fLo)

    // Apply ±15% variance around formula target
    const hp  = Math.max(1, Math.round(tHp  * (1 + rng.uniform(-0.15, 0.15))))
    const atk = Math.max(1, Math.round(tAtk * (1 + rng.uniform(-0.15, 0.15))))
    const def = Math.max(0, Math.round(tDef * (1 + rng.uniform(-0.10, 0.10))))

    const isElite = rng.next() < 0.12
    const finalHp  = isElite ? Math.round(hp  * 1.8) : hp
    const finalAtk = isElite ? Math.round(atk * 1.3) : atk
    const finalDef = isElite ? Math.round(def * 1.3) : def

    const [hpPf, defPf, atkPf] = perFloorScaling(statFn, fLo, floorMax)
    const name    = makeName(location, rng, usedNames)
    const id      = makeId(location, name, usedIds)
    const emoji   = emojiPool[i % emojiPool.length]
    const rarity  = rarityFn(fLo)
    const drops   = buildDrops(rng, rarity, matsByRarity, wepsByRarity, itemsByRarity, isElite)
    const rewards = rewardFn(fLo)

    const monster = {
      id, name, emoji, locationId: location,
      tier: isElite ? 'elite' : 'regular',
      floorRange: [fLo, fHi],
      baseStats:  { hp: finalHp, def: finalDef, atk: finalAtk },
      scaling:    { hpPerFloor: hpPf, defPerFloor: defPf, atkPerFloor: atkPf },
      rewards, drops,
    }

    // ── Assertion: non-elite stats must be within ±20% of formula target at fLo ──
    // (elite multipliers are intentional, so we check pre-elite values)
    const checkHp  = hp  / tHp
    const checkAtk = atk / tAtk
    const checkDef = tDef > 0 ? def / tDef : 1
    if (checkHp < 0.80 || checkHp > 1.20 || checkAtk < 0.80 || checkAtk > 1.20 || checkDef < 0.80 || checkDef > 1.20) {
      console.error(`\nASSERTION FAILED: ${id}  floorRange[0]=${fLo}`)
      console.error(`  Formula targets:  hp=${tHp}  def=${tDef}  atk=${tAtk}`)
      console.error(`  Generated (pre-elite): hp=${hp}  def=${def}  atk=${atk}`)
      console.error(`  Ratios: hp=${checkHp.toFixed(3)}  def=${checkDef.toFixed(3)}  atk=${checkAtk.toFixed(3)}`)
      process.exit(1)
    }

    monsters.push(monster)
  }
  return monsters
}

// ── Main ───────────────────────────────────────────────────────────────────────
const weapons  = JSON.parse(readFileSync('data/weapons.json',  'utf8'))
const items    = JSON.parse(readFileSync('data/items.json',    'utf8'))
const mats     = JSON.parse(readFileSync('data/materials.json','utf8'))
const existing = JSON.parse(readFileSync('data/monsters.json', 'utf8'))

const rarities      = ['common','uncommon','rare','epic','legendary']
const matsByRarity  = Object.fromEntries(rarities.map(r => [r, mats.filter(x=>x.rarity===r).map(x=>x.id)]))
const wepsByRarity  = Object.fromEntries(rarities.map(r => [r, weapons.filter(x=>x.rarity===r).map(x=>x.id)]))
const itemsByRarity = Object.fromEntries(rarities.map(r => [r, items.filter(x=>x.rarity===r).map(x=>x.id)]))

// Only preserve bosses — all regulars are regenerated fresh
const existingBosses = existing.bosses || []
const usedIds = new Set(existingBosses.map(b => b.id))

const rng    = makeRng(SEED)
const allNew = []

const configs = [
  { location:'entry_tower',       label:'Entry Tower',          floorMin:1, floorMax:100,  count:157, spanMin:8,  spanMax:12, statFn:entryStats,   rarityFn:entryRarity,   rewardFn:entryRewards   },
  { location:'gambits_dungeon',   label:"Gambit's Dungeon",     floorMin:1, floorMax:1000, count:190, spanMin:40, spanMax:60, statFn:endgameStats, rarityFn:endgameRarity, rewardFn:endgameRewards },
  { location:'centurions_dungeon',label:"Centurion's Dungeon",  floorMin:1, floorMax:1000, count:190, spanMin:40, spanMax:60, statFn:endgameStats, rarityFn:endgameRarity, rewardFn:endgameRewards },
  { location:'astral_tower',      label:'Astral Tower',         floorMin:1, floorMax:1000, count:190, spanMin:40, spanMax:60, statFn:endgameStats, rarityFn:endgameRarity, rewardFn:endgameRewards },
  { location:'eternal_dungeon',   label:'Eternal Dungeon',      floorMin:1, floorMax:1000, count:190, spanMin:40, spanMax:60, statFn:endgameStats, rarityFn:endgameRarity, rewardFn:endgameRewards },
]

for (const c of configs) {
  process.stdout.write(`Generating ${c.label} (${c.count})... `)
  const batch = generate(
    c.location, c.floorMin, c.floorMax, c.count, c.spanMin, c.spanMax,
    c.statFn, c.rarityFn, c.rewardFn,
    matsByRarity, wepsByRarity, itemsByRarity,
    rng, usedIds,
  )
  allNew.push(...batch)
  console.log(`✅ ${batch.length} (elite: ${batch.filter(m=>m.tier==='elite').length})`)
}

// Verify no duplicate IDs
const allIds = allNew.map(m=>m.id)
const dupes  = allIds.filter((id,i)=>allIds.indexOf(id)!==i)
if (dupes.length) { console.error('Duplicate IDs:', dupes); process.exit(1) }

writeFileSync('data/monsters.json', JSON.stringify({ regular: allNew, bosses: existingBosses }, null, 2))

console.log(`\n✅ Done.  Total regular: ${allNew.length}  |  Bosses (intact): ${existingBosses.length}`)

// ── Sample stats ───────────────────────────────────────────────────────────────
console.log('\n── Entry Tower (anchor = floorRange[0]) ──────────────────────────')
console.log('  F    avgPrimary   tHP   tDef   tAtk')
for (const F of [1, 25, 50, 100]) {
  const ap = 12 + 4*(F-1)
  const [hp,df,atk] = entryStats(F)
  console.log(`  ${String(F).padStart(3)}  ${String(ap).padStart(10)}  ${String(hp).padStart(5)}  ${String(df).padStart(5)}  ${String(atk).padStart(5)}`)
}

console.log('\n── Endgame / Astral Tower (anchor = floorRange[0]) ──────────────')
console.log('  F      gearPri  playerPwr    tHP   tDef   tAtk')
for (const F of [1, 250, 500, 750, 1000]) {
  const gp = gearPrimary(F).toFixed(1)
  const pp = (408+gearPrimary(F)).toFixed(1)
  const [hp,df,atk] = endgameStats(F)
  console.log(`  ${String(F).padStart(4)}  ${String(gp).padStart(8)}  ${String(pp).padStart(9)}  ${String(hp).padStart(5)}  ${String(df).padStart(5)}  ${String(atk).padStart(5)}`)
}
