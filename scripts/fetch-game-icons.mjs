/**
 * scripts/fetch-game-icons.mjs
 *
 * Populates vendor/game-icons/ with the icon SVGs that lib/item-art-map.js
 * actually names — nothing more.
 *
 *   node scripts/fetch-game-icons.mjs            # download whatever is missing
 *   node scripts/fetch-game-icons.mjs --check    # report only, write nothing
 *   node scripts/fetch-game-icons.mjs --force    # re-download everything
 *
 * WHY THIS EXISTS
 *
 * vendor/game-icons is load-bearing at RUNTIME, not just for a one-off
 * `generate-item-art.mjs` run: lib/item-art-cache.mjs renders every item plate
 * on demand from these SVGs (see its header). When the directory is absent,
 * renderItemArt() returns null for every item, the bot falls through to the
 * `image` URL in data/*.json, and that URL only resolves while our own public
 * origin is up — so `.shop info <item>` loses its artwork the moment the
 * tunnel hiccups. The whole point of rendering locally is not to depend on
 * that. A missing vendor/ silently undoes it.
 *
 * This repo is not under version control, so the directory can't be restored
 * with a checkout. Hence a script: the icon set is a pure function of the
 * mapping table, so it can always be rebuilt from lib/item-art-map.js.
 *
 * Upstream layout matches ours 1:1 — `lorc/pointy-sword` in the map is
 * `lorc/pointy-sword.svg` in the repo and vendor/game-icons/lorc/
 * pointy-sword.svg on disk — so no path translation is needed. The SVGs are
 * taken verbatim: lib/item-art-render.mjs does its own edits (strip the black
 * backing rect, recolor `fill="#fff"` by rarity) at render time, and rewriting
 * them here would break that.
 *
 * Licensing: game-icons.net is CC BY 3.0 / CC0 depending on the author, which
 * is why the icons may be vendored at all. Attribution is written to
 * NOTICE-game-icons.md, listing every author whose work ends up in vendor/.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { iconFor } from '../lib/item-art-map.js'
import { allItems } from '../lib/game-data.js'
import * as iconMap from '../lib/item-art-map.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'vendor', 'game-icons')
const RAW = 'https://raw.githubusercontent.com/game-icons/icons/master'

const CHECK = process.argv.includes('--check')
const FORCE = process.argv.includes('--force')

/** How many downloads to keep in flight. Polite to the CDN, still quick. */
const CONCURRENCY = 8

/**
 * Every icon path the map can yield. Two sources, unioned:
 *   - iconFor() over allItems, which is what actually renders at runtime;
 *   - the raw ICON_BY_ID / ICON_BY_TYPE tables, so an entry mapped for an item
 *     that isn't in allItems yet (a season not started, a new data file) still
 *     gets its icon fetched rather than 404ing later.
 */
function neededIcons() {
  const needed = new Set()
  for (const entry of allItems) {
    const icon = iconFor(entry)
    if (icon) needed.add(icon)
  }
  for (const table of Object.values(iconMap)) {
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue
    for (const value of Object.values(table)) {
      if (typeof value === 'string' && value.includes('/')) needed.add(value)
    }
  }
  return [...needed].sort()
}

async function fetchIcon(icon) {
  const dest = join(OUT, `${icon}.svg`)
  if (!FORCE && existsSync(dest)) return { icon, status: 'have' }

  const res = await fetch(`${RAW}/${icon}.svg`)
  if (!res.ok) return { icon, status: 'fail', detail: `HTTP ${res.status}` }
  const svg = await res.text()

  // Guard against saving an error page as an SVG — that would render as a
  // blank plate and look like a bug in the renderer rather than a bad fetch.
  if (!svg.trimStart().startsWith('<svg')) return { icon, status: 'fail', detail: 'not an SVG' }

  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, svg)
  return { icon, status: 'got', bytes: svg.length }
}

/** Runs `worker` over `items` with at most CONCURRENCY in flight. */
async function pool(items, worker) {
  const results = []
  let cursor = 0
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      try {
        results[index] = await worker(items[index])
      } catch (err) {
        results[index] = { icon: items[index], status: 'fail', detail: err.message }
      }
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * CC BY 3.0 requires naming the author. Regenerated on every run so it can
 * never drift from what's actually in vendor/.
 */
function writeNotice(icons) {
  const authors = [...new Set(icons.map((i) => i.split('/')[0]))].sort()
  const body = `# Icon attribution — game-icons.net

The SVGs in \`vendor/game-icons/\` come from [game-icons.net](https://game-icons.net)
(source: <https://github.com/game-icons/icons>). They are used to render this
game's item artwork on demand — see \`lib/item-art-render.mjs\`.

Licensed under CC BY 3.0 or CC0 depending on the author; see the upstream
repository for the per-author terms. Recolouring and compositing onto a rarity
plate count as adaptations, which both licences permit.

Re-fetch or update with:

    node scripts/fetch-game-icons.mjs

Icons vendored: ${icons.length}

Authors credited:

${authors.map((a) => `- ${a}`).join('\n')}
`
  writeFileSync(join(ROOT, 'NOTICE-game-icons.md'), body)
}

const icons = neededIcons()
console.log(`lib/item-art-map.js names ${icons.length} icons.`)

if (CHECK) {
  const missing = icons.filter((i) => !existsSync(join(OUT, `${i}.svg`)))
  console.log(`present: ${icons.length - missing.length}   missing: ${missing.length}`)
  if (missing.length) {
    for (const m of missing.slice(0, 40)) console.log(`  - ${m}`)
    if (missing.length > 40) console.log(`  … and ${missing.length - 40} more`)
    console.log('\nRun without --check to download them.')
  }
  process.exit(missing.length ? 1 : 0)
}

const results = await pool(icons, fetchIcon)
const got = results.filter((r) => r.status === 'got')
const have = results.filter((r) => r.status === 'have')
const failed = results.filter((r) => r.status === 'fail')

console.log(`downloaded ${got.length}, already present ${have.length}, failed ${failed.length}`)
for (const f of failed) console.log(`  ✗ ${f.icon} — ${f.detail}`)

const onDisk = icons.filter((i) => existsSync(join(OUT, `${i}.svg`)))
writeNotice(onDisk)

const kb = onDisk.reduce((sum, i) => sum + readFileSync(join(OUT, `${i}.svg`)).length, 0) / 1024
console.log(`vendor/game-icons now holds ${onDisk.length}/${icons.length} icons (${kb.toFixed(0)} KB)`)
console.log('NOTICE-game-icons.md updated.')

if (failed.length) process.exit(1)
