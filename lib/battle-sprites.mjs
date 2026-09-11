/**
 * battle-sprites.mjs — the sprite registry for the battle renderer.
 *
 * WHY THIS EXISTS
 * lib/battle-frame-render.mjs used to draw exactly three images: one player
 * sheet, one 32×32 monster icon, one background. Every one of the 963 monsters
 * in data/monsters.json rendered as the same icon, every one of the 9 classes
 * rendered as the same body, and a PvP duel drew the *opponent player* with the
 * monster icon — so a duel looked identical to a dungeon fight apart from the
 * name label. This module is the lookup layer that fixes all three:
 *
 *   classSpriteFile(classId, pose)   → per-class player sheet (both sides in PvP)
 *   classArtCandidates(classId,pose) → that sheet plus every fallback, best first
 *   monsterSpriteFile(monster)       → per-family, per-tier monster sprite
 *   backgroundFor(scene, seed)       → which of the five arenas this fight uses
 *
 * Nothing here loads or draws anything: it maps game data to filenames. Two
 * separate art sets can satisfy those names, and the renderer takes whichever
 * it finds first:
 *
 *   • the hand-drawn CraftPix bodies and the five arena backgrounds, installed
 *     by scripts/install-battle-assets.mjs (this is what ships)
 *   • procedural per-class and per-monster art from scripts/gen-battle-sprites.mjs,
 *     which overrides the hand-drawn set for any class it has generated
 *
 * Every lookup degrades to the old single-sprite behaviour if a file is
 * missing, so a half-generated asset folder can never break a fight.
 *
 * ADDING A MONSTER: you don't have to. Classification is by emoji first and
 * name keyword second, so a new monster in monsters.json gets a fitting sprite
 * the moment it exists. Only a brand-new *emoji* needs a line in EMOJI_FAMILY,
 * and even that falls back to a name-keyword match, then to 'beast'.
 */

// ── Palettes ────────────────────────────────────────────────────────────────
// Five slots each, darkest → brightest, plus a glow used for eyes/energy.
// Kept deliberately high-contrast: these are drawn at 32×32 and upscaled 4×,
// so subtle shading just reads as mud.
const P = (dark, mid, light, accent, glow) => ({ dark, mid, light, accent, glow })

/**
 * Monster families. `archetype` picks the silhouette-drawing function in the
 * generator; the palette makes two families sharing an archetype read as
 * different creatures (a stone golem and a clockwork construct are both
 * `blocky`, but nobody would confuse them).
 */
export const FAMILIES = {
  beast:     { archetype: 'quadruped', pal: P('#2b1a10', '#6b4423', '#a9713a', '#d9a466', '#ffd76a') },
  serpent:   { archetype: 'serpent',   pal: P('#0c2a17', '#1e6b35', '#37a84f', '#7ee08a', '#c8ff5a') },
  dragon:    { archetype: 'winged',    pal: P('#2a0b0b', '#7a1616', '#c02b2b', '#f2653f', '#ffd24a'), decor: ['horns', 'spikes'] },
  bird:      { archetype: 'winged',    pal: P('#241a05', '#6d5410', '#b9911f', '#e8c95a', '#fff3a8'), decor: ['beak'] },
  arachnid:  { archetype: 'arachnid',  pal: P('#160b1c', '#3d1b4a', '#6b2f7d', '#a24ab8', '#ff4d6d') },
  slime:     { archetype: 'blob',      pal: P('#0d2b12', '#1f7a2c', '#37b845', '#7ef07a', '#e6ffb0') },
  undead:    { archetype: 'humanoid',  pal: P('#1a1a20', '#4a4a55', '#8f8f9c', '#d6d6df', '#9dff6a'), decor: ['skull', 'ribs'] },
  demon:     { archetype: 'humanoid',  pal: P('#2b0710', '#701226', '#b81f3c', '#ef5a6a', '#ffcf3a'), decor: ['horns', 'wings'] },
  knight:    { archetype: 'humanoid',  pal: P('#151a24', '#3a475e', '#6d80a0', '#b3c2da', '#7fd0ff'), decor: ['helm', 'shield'] },
  jester:    { archetype: 'humanoid',  pal: P('#1c0b26', '#5c1d6e', '#9b30b0', '#e05fd0', '#ffe14a'), decor: ['bells', 'mask'] },
  ghost:     { archetype: 'floater',   pal: P('#101828', '#2f4260', '#5c7aa8', '#a8c4e8', '#e8f4ff'), decor: ['wisps'] },
  eye:       { archetype: 'floater',   pal: P('#1c0f24', '#4a2060', '#7d3898', '#c46fd8', '#ff3b5c'), decor: ['pupil', 'lashes'] },
  void:      { archetype: 'floater',   pal: P('#050308', '#170d22', '#2b1740', '#4a2a6e', '#c04dff'), decor: ['rift'] },
  mirror:    { archetype: 'crystal',   pal: P('#1a1f28', '#4d5a68', '#8b9cb0', '#d8e4f2', '#ffffff'), decor: ['shine'] },
  lunar:     { archetype: 'floater',   pal: P('#0d1024', '#26305c', '#4a5a9c', '#9aa8e0', '#fdfbe4'), decor: ['crescent'] },
  astral:    { archetype: 'floater',   pal: P('#0a0a20', '#1f2a6b', '#3d55b8', '#7f9bf0', '#fff3a8'), decor: ['stars'] },
  storm:     { archetype: 'elemental', pal: P('#141024', '#31306b', '#5a5ab8', '#9a9af0', '#fff45a'), decor: ['bolts'] },
  flame:     { archetype: 'elemental', pal: P('#2b0a03', '#8a2606', '#d65a10', '#f7a52c', '#fff06a'), decor: ['embers'] },
  ice:       { archetype: 'elemental', pal: P('#0a1e2b', '#1c5a7a', '#3a9bc4', '#8fd8f0', '#eafcff'), decor: ['shards'] },
  water:     { archetype: 'elemental', pal: P('#04182b', '#0f4a7a', '#1d7fc4', '#5ec2f0', '#dff6ff'), decor: ['droplets'] },
  arcane:    { archetype: 'crystal',   pal: P('#170a2b', '#3d1a7a', '#6b2fc4', '#a86ff0', '#ffe66a'), decor: ['runes'] },
  crystal:   { archetype: 'crystal',   pal: P('#0a2028', '#125a63', '#1f9ba8', '#6fe0e8', '#ffffff'), decor: ['facets'] },
  time:      { archetype: 'crystal',   pal: P('#241a08', '#6b4d12', '#ab7d1f', '#e0bb5a', '#fff3c0'), decor: ['hands'] },
  golem:     { archetype: 'blocky',    pal: P('#1c1a18', '#4d4a45', '#7d7a72', '#b0aca0', '#ff8a3a'), decor: ['cracks'] },
  construct: { archetype: 'blocky',    pal: P('#1a1614', '#5c4a2e', '#8f7440', '#c2a76a', '#5affd0'), decor: ['gears', 'bolts'] },
  vessel:    { archetype: 'blocky',    pal: P('#241610', '#6b3a20', '#a35c33', '#d69a6a', '#9dff6a'), decor: ['seal'] },
  blood:     { archetype: 'blob',      pal: P('#240409', '#6b0a1a', '#a81230', '#e04a5a', '#ffd0d8'), decor: ['drips'] },
}

/** Emoji → family. Covers every emoji currently present in data/monsters.json. */
export const EMOJI_FAMILY = {
  '🐀': 'beast', '🐺': 'beast', '🐗': 'beast', '👤': 'ghost',
  '🦎': 'serpent', '🐍': 'serpent', '🐊': 'serpent',
  '🐉': 'dragon', '☄️': 'astral', '🦅': 'bird', '🛸': 'astral',
  '🕷️': 'arachnid', '🦂': 'arachnid', '🟢': 'slime',
  '💀': 'undead', '🦴': 'undead', '🧟': 'undead', '⚰️': 'undead', '🪦': 'undead', '⛓️': 'undead',
  '👻': 'ghost', '🌫️': 'ghost',
  '👁️': 'eye', '🧿': 'eye', '🪬': 'eye', '🔯': 'eye',
  '🔮': 'arcane', '🪄': 'arcane', '⚗️': 'arcane',
  '💠': 'crystal', '🔵': 'crystal', '💎': 'crystal',
  '🃏': 'jester', '🎪': 'jester', '🧩': 'jester', '🎭': 'jester', '🎼': 'jester',
  '⚔️': 'knight', '🗡️': 'knight', '🛡️': 'knight', '🪖': 'knight', '🔱': 'knight',
  '👹': 'demon', '👑': 'demon',
  '🌑': 'lunar', '🌙': 'lunar', '🌒': 'lunar', '🌕': 'lunar', '🌚': 'lunar', '🎑': 'lunar',
  '🌌': 'astral', '🪐': 'astral', '🌠': 'astral', '🌟': 'astral', '⭐': 'astral',
  '💫': 'astral', '✨': 'astral', '🎇': 'astral', '🔭': 'astral', '♾️': 'astral', '🌈': 'astral',
  '⚡': 'storm', '🌪️': 'storm', '🌀': 'storm',
  '🔥': 'flame', '🕯️': 'flame', '❄️': 'ice', '🌊': 'water',
  '🗿': 'golem', '🧱': 'golem', '🏛️': 'golem', '🏰': 'golem', '🗻': 'golem',
  '⚙️': 'construct', '🔩': 'construct', '🔧': 'construct', '⚒️': 'construct',
  '🗜️': 'construct', '🪚': 'construct', '🧲': 'construct',
  '🏺': 'vessel', '🪣': 'vessel', '🚪': 'vessel',
  '🕰️': 'time', '⌛': 'time', '⏳': 'time', '⚖️': 'time',
  '🩸': 'blood', '😱': 'blood', '🧠': 'blood',
  '🪞': 'mirror', '🕳️': 'void',
}

/**
 * Name keywords, checked when the emoji is unknown. Ordered — first match
 * wins, so put the specific words above the generic ones.
 */
const NAME_HINTS = [
  [/dragon|wyrm|drake|wyvern/i, 'dragon'],
  [/skelet|bone|lich|corpse|zombie|revenant|grave|tomb|crypt|mummy/i, 'undead'],
  [/ghost|spectre|specter|phantom|wraith|shade|shroud|haunt|mist|fog/i, 'ghost'],
  [/spider|scorpion|beetle|mantis|swarm|hive|larva|weaver/i, 'arachnid'],
  [/slime|ooze|jelly|pudding|mucus/i, 'slime'],
  [/serpent|snake|viper|lizard|croc|basilisk|naga|reptil/i, 'serpent'],
  [/golem|statue|stone|granite|marble|obsidian|monolith|gargoyle/i, 'golem'],
  [/clock|gear|cog|automat|machin|engine|construct|mech|puppet/i, 'construct'],
  [/eye|gaze|watcher|beholder|iris|pupil|stare/i, 'eye'],
  [/flame|fire|ember|ash|cinder|pyre|blaze|magma|lava/i, 'flame'],
  [/frost|ice|glacier|rime|freez|winter|snow/i, 'ice'],
  [/storm|thunder|lightning|tempest|gale|cyclone|vortex/i, 'storm'],
  [/tide|water|wave|abyss|drown|deep|sea|ocean|kraken/i, 'water'],
  [/blood|gore|flesh|heart|brain|vein|carn/i, 'blood'],
  [/void|null|empty|nothing|rift|hollow/i, 'void'],
  [/mirror|reflect|glass|echo|twin|double/i, 'mirror'],
  [/moon|luna|crescent|eclipse|night/i, 'lunar'],
  [/star|astral|cosmic|nebula|comet|celest|galax|constell/i, 'astral'],
  [/crystal|gem|prism|shard|diamond|quartz/i, 'crystal'],
  [/rune|arcane|mage|witch|warlock|sorcer|hex|spell/i, 'arcane'],
  [/knight|guard|sentinel|warden|soldier|legion|centurion|blade/i, 'knight'],
  [/jester|clown|harlequin|card|joker|mask|carnival|puppet/i, 'jester'],
  [/demon|devil|fiend|imp|hell|abyssal|king|lord|emperor/i, 'demon'],
  [/hour|time|clock|aeon|epoch|eternal|second|minute/i, 'time'],
  [/urn|jar|pot|vessel|chest|door|gate|coffer/i, 'vessel'],
  [/wolf|rat|boar|hound|beast|fang|claw|maw|prowler/i, 'beast'],
  [/hawk|eagle|raven|crow|owl|wing|feather|harpy/i, 'bird'],
]

/** The family a monster should be drawn as. Emoji first, then name, then beast. */
export function familyForMonster(monster) {
  if (!monster) return 'beast'
  const byEmoji = EMOJI_FAMILY[monster.emoji]
  if (byEmoji && FAMILIES[byEmoji]) return byEmoji
  const name = String(monster.name ?? '')
  for (const [re, fam] of NAME_HINTS) if (re.test(name)) return fam
  return 'beast'
}

/** Tiers get their own art: bigger, brighter, more decorated as you go up. */
export const TIERS = ['regular', 'elite', 'boss']

export function tierForMonster(monster) {
  const t = String(monster?.tier ?? 'regular').toLowerCase()
  if (t === 'boss' || monster?.isBoss) return 'boss'
  if (t === 'elite') return 'elite'
  return 'regular'
}

/**
 * The sprite filename for a monster. `mon_<family>.png` for regulars,
 * `mon_<family>_elite.png` / `_boss.png` for the harder tiers.
 */
export function monsterSpriteFile(monster) {
  const fam = familyForMonster(monster)
  const tier = tierForMonster(monster)
  return tier === 'regular' ? `mon_${fam}.png` : `mon_${fam}_${tier}.png`
}

/** Every monster sprite file the generator needs to produce. */
export function allMonsterSpriteFiles() {
  const out = []
  for (const fam of Object.keys(FAMILIES)) {
    out.push([`mon_${fam}.png`, fam, 'regular'])
    out.push([`mon_${fam}_elite.png`, fam, 'elite'])
    out.push([`mon_${fam}_boss.png`, fam, 'boss'])
  }
  return out
}

// ── Player classes ──────────────────────────────────────────────────────────
/**
 * One entry per class in data/classes.json. `weapon` picks the held-item shape,
 * and the palette colours cloth/armour so the nine classes are tellable apart
 * at 128 px — which matters most in PvP, where two of these now stand facing
 * each other and the only other difference is the name label.
 */
export const CLASS_SPRITES = {
  warrior:   { weapon: 'broadsword', pal: P('#1b1410', '#6b3a1f', '#a35c2e', '#d9a05a', '#ffd76a'), cloth: '#8a2b1f', trim: '#d9b45a' },
  mage:      { weapon: 'staff',      pal: P('#120e26', '#33246b', '#5a3fb8', '#9a7ff0', '#7ff0ff'), cloth: '#3a2a8a', trim: '#8fd8ff' },
  rogue:     { weapon: 'dagger',     pal: P('#101614', '#243a2e', '#3d6b52', '#6ba884', '#c8ff8a'), cloth: '#22402f', trim: '#7ad9a0' },
  cleric:    { weapon: 'mace',       pal: P('#241f10', '#6b5c26', '#a8933d', '#e0cf7a', '#fff6c0'), cloth: '#e8e2cf', trim: '#d9a83a' },
  samurai:   { weapon: 'katana',     pal: P('#1c1014', '#5c2030', '#94324a', '#cf6a7e', '#ffd0a8'), cloth: '#7a1f2e', trim: '#e8d8a0' },
  knight:    { weapon: 'lance',      pal: P('#141a24', '#37475e', '#6b809c', '#b0c2d9', '#8fd8ff'), cloth: '#2e3d5c', trim: '#c0cfe8' },
  duelist:   { weapon: 'rapier',     pal: P('#1a1020', '#4a2050', '#7a3a80', '#b86fc0', '#ffd8f0'), cloth: '#5c2466', trim: '#e8b0f0' },
  berserker: { weapon: 'axe',        pal: P('#20100a', '#6b2a12', '#a34a20', '#d98a4a', '#ff6a3a'), cloth: '#7a3418', trim: '#c04a2a' },
  assassin:  { weapon: 'twin',       pal: P('#0c0e14', '#1f2430', '#3a4252', '#6b7488', '#ff3b5c'), cloth: '#171b24', trim: '#8f2030' },
}

export const DEFAULT_CLASS = 'warrior'

/**
 * Poses, and the frame count each procedurally generated sheet holds.
 *
 * These numbers only bind the generator. The renderer reads the real frame
 * count off the loaded image (width ÷ 128), because the hand-drawn sheets in
 * SPRITE_BASES below disagree with each other: the samurai swings over six
 * frames, the shinobi over five, the fighter over four. Hardcoding one number
 * would have played the samurai's attack at two thirds length and left the
 * shinobi's last frame on the floor.
 *
 * `skill` and `ultimate` are separate sheets so a skill does not replay the
 * basic attack swing. A class with no sheet for them falls back to `attack`.
 */
export const POSES = { default: 6, attack: 4, skill: 4, ultimate: 4, hurt: 3, dead: 3, defend: 2 }

/**
 * The hand-drawn sprite sets that actually ship in lib/assets/battle/
 * (CraftPix "Free Shinobi Sprites", see CREDITS.txt there). Three bodies, seven
 * poses each. Every class maps onto one of them, so nine classes cost 21 files
 * instead of 63 copies of the same three animations.
 */
export const SPRITE_BASES = {
  fighter: { desc: 'sword and guard, heavy stance' },
  samurai: { desc: 'katana, long reaching swings' },
  shinobi: { desc: 'hooded, fast and low' },
}

/**
 * classId → which hand-drawn body it borrows. Grouped by how the class fights
 * rather than by name, so the silhouette matches the moveset: shield-and-blade
 * bruisers on the fighter, long-swing blades on the samurai, and the light,
 * hooded frames on anything that stabs or casts.
 */
export const ART_BASE_BY_CLASS = {
  warrior:   'fighter',
  knight:    'fighter',
  berserker: 'fighter',
  cleric:    'fighter',
  samurai:   'samurai',
  duelist:   'samurai',
  rogue:     'shinobi',
  assassin:  'shinobi',
  mage:      'shinobi',
}

export const DEFAULT_ART_BASE = 'fighter'

function normalizeClassId(classId) {
  const id = String(classId ?? '').toLowerCase().trim()
  return CLASS_SPRITES[id] ? id : DEFAULT_CLASS
}

function normalizePose(pose) {
  return POSES[pose] ? pose : 'default'
}

/** The hand-drawn body a class borrows. */
export function artBaseForClass(classId) {
  const id = String(classId ?? '').toLowerCase().trim()
  return ART_BASE_BY_CLASS[id] ?? DEFAULT_ART_BASE
}

/** `char_<class>_<pose>.png`, e.g. char_mage_attack.png. */
export function classSpriteFile(classId, pose = 'default') {
  const cls = normalizeClassId(classId)
  return `char_${cls}_${normalizePose(pose)}.png`
}

/**
 * Every filename the renderer should try for one class and pose, best first.
 * The renderer walks this list and keeps the first sheet that loads, so all
 * three tiers of art can coexist and a missing file is never fatal:
 *
 *   1. char_<class>_<pose>.png   per-class art from scripts/gen-battle-sprites.mjs
 *   2. char_<base>_<pose>.png    the shipped hand-drawn body for that class
 *   3. char_<base>_attack.png    skill/ultimate reuse the attack swing
 *   4. character_<pose>.png      the original generic sheet
 *   5. character_default.png     last resort, idle for everything
 */
export function classArtCandidates(classId, pose = 'default') {
  const cls  = normalizeClassId(classId)
  const p    = normalizePose(pose)
  const base = artBaseForClass(classId)
  const out  = [`char_${cls}_${p}.png`, `char_${base}_${p}.png`]
  if (p === 'skill' || p === 'ultimate') {
    out.push(`char_${cls}_attack.png`, `char_${base}_attack.png`)
  }
  out.push(`character_${p}.png`, 'character_default.png')
  return [...new Set(out)]
}

/** Every player sprite file the generator needs to produce. */
export function allClassSpriteFiles() {
  const out = []
  for (const cls of Object.keys(CLASS_SPRITES)) {
    for (const pose of Object.keys(POSES)) {
      out.push([`char_${cls}_${pose}.png`, cls, pose, POSES[pose]])
    }
  }
  return out
}

export const SPRITE_COUNTS = {
  monsters: Object.keys(FAMILIES).length * TIERS.length,
  players: Object.keys(CLASS_SPRITES).length * Object.keys(POSES).length,
  families: Object.keys(FAMILIES).length,
  classes: Object.keys(CLASS_SPRITES).length,
  artBases: Object.keys(SPRITE_BASES).length,
  backgrounds: 0,   // overwritten below, once BACKGROUNDS is declared
}

// ── Backgrounds ─────────────────────────────────────────────────────────────
/**
 * Every fight used to happen in front of the same forest. There are now five
 * arenas and the fight picks one, so a duel in the dunes and a dungeon crawl in
 * the grotto no longer look like the same screenshot with different names.
 *
 * Files live in lib/assets/battle/bg_<key>.png, all exactly 480×270 so the
 * renderer can blit them 1:1 with no scaling (see scripts/install-battle-assets.mjs).
 */
export const BACKGROUNDS = {
  arena:    { file: 'bg_arena.png',    desc: 'forest clearing, flat dirt floor' },
  dunes:    { file: 'bg_dunes.png',    desc: 'desert at sunset' },
  hollow:   { file: 'bg_hollow.png',   desc: 'blue cavern, stone floor' },
  grotto:   { file: 'bg_grotto.png',   desc: 'ochre stalactite cave' },
  deepwood: { file: 'bg_deepwood.png', desc: 'firefly forest, the original arena' },
}

SPRITE_COUNTS.backgrounds = Object.keys(BACKGROUNDS).length

/**
 * Which arenas a kind of fight may use. A scene with more than one entry picks
 * deterministically from the seed the caller passes (see backgroundFor), so the
 * arena holds still for the whole of one fight instead of flickering per turn.
 */
export const SCENE_BACKGROUNDS = {
  wager:   ['dunes'],                          // stakes on the table, sun going down
  pvp:     ['arena', 'dunes'],
  boss:    ['hollow'],
  dungeon: ['grotto', 'hollow'],
  world:   ['deepwood', 'arena'],
  default: ['arena'],
}

/** Small stable string hash, so the same seed always picks the same arena. */
function hashSeed(seed) {
  const s = String(seed ?? '')
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0)
}

/**
 * The background file for one fight. `scene` is a key of SCENE_BACKGROUNDS,
 * `seed` is anything stable for the duration of the fight (a jid pair, a
 * battle start timestamp, a dungeon floor). Falls back to the default arena
 * for an unknown scene, and never returns null.
 */
export function backgroundFor(scene = 'default', seed = '') {
  const pool = SCENE_BACKGROUNDS[scene] ?? SCENE_BACKGROUNDS.default
  const key  = pool[hashSeed(seed) % pool.length] ?? 'arena'
  return BACKGROUNDS[key]?.file ?? 'bg_arena.png'
}

/** Every background file the installer is expected to have produced. */
export function allBackgroundFiles() {
  return Object.values(BACKGROUNDS).map(b => b.file)
}
