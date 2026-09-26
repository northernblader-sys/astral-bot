/**
 * scripts/generate-item-art.mjs
 *
 * Generates artwork for every data/ entry whose image is missing or points at
 * the dead play.astral.qzz.io host, writes the PNGs into lib/assets/items/,
 * and rewrites the `image` field in data/*.json to the bot's own URL.
 *
 *   node scripts/generate-item-art.mjs --dry-run     # report only, write nothing
 *   node scripts/generate-item-art.mjs --sheet       # also emit a contact sheet
 *   node scripts/generate-item-art.mjs               # generate + rewrite JSON
 *
 * Self-hosted, not uploaded: the entire reason ~100 items have no art is that
 * the host holding it stopped resolving. Putting the replacements on another
 * third party repeats that mistake. These sit next to the code, get served by
 * the API process that already serves /assets/profile, and can't disappear
 * without the bot disappearing too.
 *
 * SAFETY: this repo is not under version control, so an in-place rewrite of
 * data/*.json is unrecoverable if it goes wrong. Every file this script edits
 * is copied to <name>.json.pre-art-backup first, and the rewrite only touches
 * the `image` field of entries it actually generated art for.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from '../config.js'
import { iconFor } from '../lib/item-art-map.js'
import { renderItemArt, renderContactSheet } from '../lib/item-art-render.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'data')
const OUT = join(ROOT, 'lib', 'assets', 'items')

const DRY = process.argv.includes('--dry-run')
const SHEET = process.argv.includes('--sheet')

/** Files to sweep. Each may be a bare array or an object wrapping one. */
const FILES = [
  'items', 'materials', 'named-weapons', 'weapons', 'tools',
  'season-01-content', 'season-01-weapons',
]

/**
 * The host that died. Must stay fully qualified: the replacement URLs live on
 * `animeastral.qzz.io`, which contains `astral.qzz.io` as a substring, so a
 * looser match makes every already-fixed entry look broken and re-generates
 * the whole set on each run.
 */
const DEAD_HOST = 'play.astral.qzz.io'
const BASE = String(config.publicApiUrl ?? '').replace(/\/+$/, '')

if (!BASE && !DRY) {
  console.error('config.publicApiUrl is unset — the rewritten URLs would be relative.')
  console.error('Set it in .env, or run with --dry-run to preview.')
  process.exit(1)
}

/** Returns the array of entries inside a data file, whatever its shape. */
function entriesOf(json) {
  if (Array.isArray(json)) return json
  const arr = Object.values(json).find(Array.isArray)
  return Array.isArray(arr) ? arr : []
}

/** An entry needs art if it has no image, or its image is on the dead host. */
function needsArt(entry) {
  const url = entry?.image
  if (!url) return true
  return String(url).includes(DEAD_HOST)
}

if (!DRY) mkdirSync(OUT, { recursive: true })

const sheetRows = []
let generated = 0, skipped = 0, failed = 0, untouched = 0

for (const name of FILES) {
  const path = join(DATA, `${name}.json`)
  if (!existsSync(path)) { console.log(`- ${name}.json missing, skipped`); continue }

  const raw = readFileSync(path, 'utf8')
  const json = JSON.parse(raw)
  const entries = entriesOf(json)
  let changed = 0

  for (const entry of entries) {
    if (!needsArt(entry)) { untouched++; continue }

    const icon = iconFor(entry)
    if (!icon) {
      // No mapping and no type default — leave the image field alone so the
      // renderers keep using drawEmblem(), which already looks deliberate.
      skipped++
      console.log(`  skip  ${String(entry.id).padEnd(24)} (no icon mapped)`)
      continue
    }

    const buffer = DRY ? Buffer.alloc(0) : await renderItemArt(entry, icon, 512)
    if (!DRY && !buffer) {
      failed++
      console.log(`  FAIL  ${String(entry.id).padEnd(24)} ${icon}`)
      continue
    }

    const file = `${entry.id}.png`
    if (!DRY) {
      writeFileSync(join(OUT, file), buffer)
      entry.image = `${BASE}/assets/items/${file}`
      changed++
    }
    if (SHEET && !DRY) sheetRows.push({ entry, buffer })
    generated++
    console.log(`  ok    ${String(entry.id).padEnd(24)} ${icon}`)
  }

  if (!DRY && changed) {
    // Back up before the first write to this file — no git safety net here.
    const backup = `${path}.pre-art-backup`
    if (!existsSync(backup)) copyFileSync(path, backup)
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`)
    console.log(`- ${name}.json: ${changed} image URLs rewritten (backup: ${name}.json.pre-art-backup)`)
  }
}

if (SHEET && sheetRows.length) {
  const sheetPath = join(ROOT, 'tmp-art', 'all-items.png')
  mkdirSync(dirname(sheetPath), { recursive: true })
  writeFileSync(sheetPath, await renderContactSheet(sheetRows, { cell: 190, cols: 8 }))
  console.log(`\ncontact sheet -> ${sheetPath}`)
}

console.log(`\n${DRY ? '[dry run] ' : ''}generated ${generated}, skipped ${skipped}, failed ${failed}, already-fine ${untouched}`)
if (DRY) console.log('Nothing was written. Re-run without --dry-run to apply.')
