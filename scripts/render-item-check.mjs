/**
 * scripts/render-item-check.mjs — visual regression check for the season item
 * card's text alignment.
 *
 * Reproduces the exact entry shape that exposed the bug: a long description
 * plus extras and NO stats. drawStatGrid() was the only thing that happened to
 * reset ctx.textAlign after chip() left it on 'center', so a statless entry
 * rendered its whole lower half centred on x = PAD and hanging off the canvas.
 *
 *   node scripts/render-item-check.mjs
 *
 * Writes ./season-item-check.png next to the repo root for eyeballing.
 */
import { writeFileSync } from 'fs'
import { renderSeasonItem } from '../lib/season-item-render.mjs'
import {
  seasons, getSeasonCatalog, getSeasonShopPages, describeSeasonEntry,
} from '../lib/season-engine.js'

// Real catalog, not a synthetic entry — describeSeasonEntry() resolves
// characters/weapons out of game data, so a made-up id normalises to an empty
// description and renders nothing below the chip row.
const season = seasons[0]
const catalog = getSeasonCatalog(season)
const pages = getSeasonShopPages(catalog)

// Pick the entry that best exercises the bug: longest description, no stats.
const statless = catalog
  .map((entry) => ({ entry, info: describeSeasonEntry(entry) }))
  .filter(({ info }) => info.description && !Object.keys(info.stats ?? {}).length)
  .sort((a, b) => b.info.description.length - a.info.description.length)

const withStats = catalog
  .map((entry) => ({ entry, info: describeSeasonEntry(entry) }))
  .filter(({ info }) => info.description && Object.keys(info.stats ?? {}).length)
  .sort((a, b) => b.info.description.length - a.info.description.length)

const picks = [statless[0], withStats[0]].filter(Boolean)
if (!picks.length) {
  console.error('No catalog entry has a description — nothing to check.')
  process.exit(1)
}

for (const [i, { entry, info }] of picks.entries()) {
  const pageIndex = pages.findIndex((p) => p.entries.some((e) => e.id === entry.id))
  const buf = await renderSeasonItem({
    season,
    entry,
    player: { seasonPoints: 0, seasonPurchases: {} },
    pageLabel: pages[pageIndex]?.label ?? null,
    prefix: '.',
  })
  const out = new URL(`../season-item-check-${i + 1}.png`, import.meta.url)
  writeFileSync(out, buf)
  console.log(
    `[${i + 1}] ${info.name} — desc ${info.description.length} chars, ` +
    `stats ${Object.keys(info.stats ?? {}).length}, extras ${info.extra?.length ?? 0} ` +
    `→ season-item-check-${i + 1}.png (${buf.length} bytes)`,
  )
}
