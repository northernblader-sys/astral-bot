/**
 * install-battle-assets.mjs — builds lib/assets/battle/ from a staging folder.
 *
 * Why this exists: the battle renderer used to load its art over HTTP from
 * ImgBB at module init (see lib/image.js). Three files were mapped there and
 * the other four simply did not exist, so `character_attack/hurt/dead/defend`
 * failed on every boot and every fight fell back to the idle pose. Worse, a
 * dead tunnel or an offline VPS meant no battle image at all. Everything now
 * ships on disk and the remote map is only a last-resort fallback.
 *
 * Run:  node scripts/install-battle-assets.mjs [--staging tmp/battle-src] [--force]
 *
 * Expected staging layout (see CREDITS.txt in the output dir for provenance):
 *   <staging>/backgrounds/arena.jpe|png      forest clearing, flat dirt floor
 *   <staging>/backgrounds/dunes.jpe|png      desert sunset
 *   <staging>/backgrounds/hollow.jpe|png     blue cavern
 *   <staging>/backgrounds/grotto.jpe|png     ochre stalactite cave
 *   <staging>/backgrounds/deepwood.jpe|png   firefly forest (the old default)
 *   <staging>/sheets/<Class>/{Idle,Attack_1,Attack_2,Attack_3,Hurt,Dead,Shield}.png
 *   <staging>/monster_default.png            32x32 monster icon
 *
 * Sprite sheets must be horizontal strips of 128x128 frames (width % 128 === 0).
 * They are copied verbatim: the renderer derives the frame count from the file
 * width, so a 5-frame sheet and a 6-frame sheet both work with no config.
 *
 * Backgrounds are cover-cropped to exactly 480x270 (the canvas size) with a
 * nearest-neighbour kernel, because bilinear scaling turns pixel art to mush.
 */
import sharp from 'sharp'
import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const STAGING = join(ROOT, argOf('--staging', 'tmp/battle-src'))
const OUT     = join(ROOT, 'lib', 'assets', 'battle')
const FORCE   = args.includes('--force')

const W = 480, H = 270          // must match battle-frame-render.mjs
const FRAME = 128               // must match CHAR_FRAME_W / CHAR_FRAME_H

// Staged class folder → sprite base used in filenames (char_<base>_<pose>.png).
const CLASSES = { Fighter: 'fighter', Samurai: 'samurai', Shinobi: 'shinobi' }

// Staged sheet name → renderer pose. Attack_2/Attack_3 give skills and
// ultimates their own animation instead of reusing the basic attack swing.
const POSES = {
  Idle:     'default',
  Attack_1: 'attack',
  Attack_2: 'skill',
  Attack_3: 'ultimate',
  Hurt:     'hurt',
  Dead:     'dead',
  Shield:   'defend',
}

const BACKGROUNDS = ['arena', 'dunes', 'hollow', 'grotto', 'deepwood']

let wrote = 0, skipped = 0
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1 }

if (!existsSync(STAGING)) {
  console.error(`Staging folder not found: ${STAGING}`)
  console.error('Nothing to do. See the header of this file for the expected layout.')
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })

// ── backgrounds ──────────────────────────────────────────────────────────────
const bgDir = join(STAGING, 'backgrounds')
for (const name of BACKGROUNDS) {
  const src = ['png', 'jpe', 'jpg', 'jpeg', 'webp']
    .map(ext => join(bgDir, `${name}.${ext}`))
    .find(existsSync)
  if (!src) { fail(`background missing from staging: ${name}.*`); continue }
  const dest = join(OUT, `bg_${name}.png`)
  if (existsSync(dest) && !FORCE) { skipped++; continue }
  await sharp(src)
    .resize(W, H, { fit: 'cover', position: 'centre', kernel: 'nearest' })
    .png({ compressionLevel: 9 })
    .toFile(dest)
  wrote++
}

// The renderer's legacy default name. Kept as a real file so a caller that
// asks for background_default.png resolves on disk instead of over HTTP.
const arena = join(OUT, 'bg_arena.png')
if (existsSync(arena)) copyFileSync(arena, join(OUT, 'background_default.png'))

// ── character sheets ─────────────────────────────────────────────────────────
for (const [folder, base] of Object.entries(CLASSES)) {
  const dir = join(STAGING, 'sheets', folder)
  if (!existsSync(dir)) { fail(`sheet folder missing from staging: sheets/${folder}`); continue }
  for (const [sheet, pose] of Object.entries(POSES)) {
    const src = join(dir, `${sheet}.png`)
    if (!existsSync(src)) { fail(`sheets/${folder}/${sheet}.png missing`); continue }
    const meta = await sharp(src).metadata()
    if (meta.height !== FRAME || meta.width % FRAME !== 0) {
      fail(`sheets/${folder}/${sheet}.png is ${meta.width}x${meta.height}, expected height ${FRAME} and a multiple of ${FRAME} wide`)
      continue
    }
    const dest = join(OUT, `char_${base}_${pose}.png`)
    if (existsSync(dest) && !FORCE) { skipped++; continue }
    copyFileSync(src, dest)   // verbatim: already frame-aligned, no re-encode
    wrote++
  }
}

// Legacy generic names, so an old caller (or a class with no sheet of its own)
// still finds art locally. Fighter is the stand-in.
for (const pose of ['default', 'attack', 'skill', 'ultimate', 'hurt', 'dead', 'defend']) {
  const src = join(OUT, `char_fighter_${pose}.png`)
  if (existsSync(src)) copyFileSync(src, join(OUT, `character_${pose}.png`))
}

// ── monster icon ─────────────────────────────────────────────────────────────
const monSrc = join(STAGING, 'monster_default.png')
if (existsSync(monSrc)) {
  copyFileSync(monSrc, join(OUT, 'monster_default.png'))
  wrote++
} else {
  fail('monster_default.png missing from staging')
}

// ── credits ──────────────────────────────────────────────────────────────────
writeFileSync(join(OUT, 'CREDITS.txt'), [
  'Battle art assets — provenance and licensing',
  '',
  'Character sprite sheets (char_fighter_*, char_samurai_*, char_shinobi_*)',
  '  "Free Shinobi Sprites Pixel Art" by CraftPix.net (pack 453698).',
  '  License: https://craftpix.net/file-licenses/',
  '  Sheets are horizontal strips of 128x128 frames, copied verbatim.',
  '  Idle -> default, Attack_1 -> attack, Attack_2 -> skill,',
  '  Attack_3 -> ultimate, Hurt -> hurt, Dead -> dead, Shield -> defend.',
  '  Unused in-pack animations: Jump, Run, Walk.',
  '',
  'Backgrounds (bg_*.png)',
  '  Pixel-art game backgrounds, cover-cropped to 480x270 (nearest neighbour).',
  '  bg_deepwood.png is the original battle background this bot shipped with.',
  '',
  'monster_default.png',
  '  32x32 monster icon, unchanged from the original asset set.',
  '',
  `Regenerate with: node scripts/install-battle-assets.mjs --force`,
].join('\n'))

// ── report ───────────────────────────────────────────────────────────────────
const files = readdirSync(OUT).filter(f => f.endsWith('.png'))
const bytes = files.reduce((n, f) => n + statSync(join(OUT, f)).size, 0)
console.log(`lib/assets/battle: ${files.length} png, ${(bytes / 1024).toFixed(0)} KiB (${wrote} written, ${skipped} kept)`)
if (skipped && !FORCE) console.log('Existing files were kept. Re-run with --force to overwrite.')
