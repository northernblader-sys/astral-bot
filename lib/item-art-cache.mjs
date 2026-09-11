/**
 * lib/item-art-cache.mjs — item plates, rendered on demand instead of stored.
 *
 * The 190 generated plates used to live in lib/assets/items/ as 16 MB of PNGs
 * that had to be deployed to the VPS alongside the code. They don't anymore:
 * a plate is a pure function of (item entry, icon SVG), both of which are
 * already on disk — the entry in data/*.json and the icon in vendor/game-icons
 * (2.3 MB for all 162 icons the map names). So the PNG is derived at first use
 * and kept in memory, and nothing is written to disk at all.
 *
 * Note the consequence: vendor/game-icons is now load-bearing at RUNTIME, not
 * just for a manual `node scripts/generate-item-art.mjs` run. Deleting it blanks
 * every item image.
 *
 * Why an in-memory LRU rather than render-to-disk-then-unlink: unlinking after
 * each send means re-rendering the same plate on every single view, and a shop
 * page draws eight of them. Caching the buffer costs a few MB of RAM, makes a
 * repeat view free, and still leaves zero footprint on the VPS. The cache is
 * bounded in BYTES (not entries) so one big plate can't quietly blow the budget.
 *
 * Every export fails soft — null, never a throw. A missing icon or an unknown
 * id has to degrade to the drawn emblem, exactly as it did when a PNG 404'd.
 */
import { allItems } from './game-data.js'
import { iconFor } from './item-art-map.js'
import { renderItemArt } from './item-art-render.mjs'

/** Plate edge in px. Matches what scripts/generate-item-art.mjs wrote. */
const SIZE = Number(process.env.ITEM_ART_SIZE || 512)

/**
 * Cache ceiling. ~85 KB a plate, so the 12 MB default holds roughly 140 — more
 * than any one session realistically touches, and a third of what the folder
 * cost on disk. Set ITEM_ART_CACHE_MB=0 to disable caching entirely.
 */
const BUDGET = Math.max(0, Number(process.env.ITEM_ART_CACHE_MB || 12)) * 1024 * 1024

const ITEM_URL_RE = /\/assets\/items\/([A-Za-z0-9_-]+)\.(?:png|jpe?g|webp)$/i

/** id -> Buffer. Map keeps insertion order, which is what makes the LRU cheap. */
const cache = new Map()
let bytes = 0

/** In-flight renders, so eight concurrent shop rows don't render one plate 8×. */
const pending = new Map()

const byId = new Map(allItems.filter((entry) => entry?.id).map((entry) => [String(entry.id), entry]))

function touch(id) {
  // Re-inserting moves the key to the end = most recently used.
  const hit = cache.get(id)
  if (hit === undefined) return null
  cache.delete(id)
  cache.set(id, hit)
  return hit
}

function store(id, buffer) {
  if (!BUDGET || !buffer) return
  if (buffer.length > BUDGET) return      // single plate larger than the budget
  cache.set(id, buffer)
  bytes += buffer.length
  for (const [key, value] of cache) {
    if (bytes <= BUDGET) break
    if (key === id) continue              // never evict what we just stored
    cache.delete(key)
    bytes -= value.length
  }
}

/** `/assets/items/iron_sword.png` (or a full URL) -> `iron_sword`. */
export function itemIdFromAssetUrl(url) {
  const match = ITEM_URL_RE.exec(String(url ?? '').split('?')[0])
  return match ? match[1] : null
}

/**
 * The plate for one item id, rendered on first call and cached after.
 * @returns {Promise<Buffer|null>} PNG, or null for an unknown id / unusable icon.
 */
export async function itemArtBuffer(id) {
  const key = String(id ?? '').trim()
  if (!key) return null

  const cached = touch(key)
  if (cached) return cached

  const inFlight = pending.get(key)
  if (inFlight) return inFlight

  const job = (async () => {
    const entry = byId.get(key)
    if (!entry) return null
    const icon = iconFor(entry)
    if (!icon) return null
    try {
      const buffer = await renderItemArt(entry, icon, SIZE)
      if (buffer) store(key, buffer)
      return buffer ?? null
    } catch {
      return null                          // a broken SVG must not fail a render
    } finally {
      pending.delete(key)
    }
  })()

  pending.set(key, job)
  return job
}

/** Same, addressed by the asset URL the data files store. */
export function itemArtBufferForUrl(url) {
  const id = itemIdFromAssetUrl(url)
  return id ? itemArtBuffer(id) : Promise.resolve(null)
}

/** True when this URL is one we can render ourselves. */
export function isRenderableItemUrl(url) {
  const id = itemIdFromAssetUrl(url)
  return !!id && byId.has(id)
}

export function itemArtCacheStats() {
  return { entries: cache.size, bytes, budget: BUDGET, size: SIZE }
}
