/**
 * lib/self-hosted-asset.js — map one of this bot's own asset URLs back to the
 * file on disk that serves it.
 *
 * Why: data/*.json stores absolute URLs like
 * `https://animeastral.qzz.io/assets/items/iron_sword.png`, because the site
 * needs absolute URLs in <img> tags. The bot then fetched those same URLs over
 * the public internet to draw them into a canvas — a round trip out to
 * Cloudflare and back to the very process holding the file. That means:
 *
 *   - a Cloudflare hiccup, DNS stall or expired tunnel blanks the artwork,
 *     even though the PNG is sitting right there on disk;
 *   - the art doesn't work at all until the assets are deployed to the VPS,
 *     so a fresh checkout renders 190 fallback emblems;
 *   - every render pays real network latency per item (the shop draws 8).
 *
 * So: if a URL points at our own origin and the file exists locally, use the
 * local file. Everything else (ImgBB banners, PokéAPI sprites, player-uploaded
 * pfps) is untouched and still fetched normally.
 *
 * Host-gated on purpose. Matching on the path alone would mean any third-party
 * URL that happened to end in `/assets/items/foo.png` got served from our disk
 * instead — wrong, and the kind of wrong that looks like a caching bug.
 */
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Public URL prefix -> directory on disk. Mirrors the express.static mounts in
 * lib/api-server.js; keep the two in step if a mount is added there.
 */
const MOUNTS = [
  { prefix: '/assets/items/', dir: path.join(__dirname, 'assets', 'items') },
  { prefix: '/assets/profile/', dir: path.join(__dirname, 'assets', 'profile') },
]

/** Hostnames that are us. Empty entries are dropped so a blank config is safe. */
const OWN_HOSTS = new Set(
  [config.publicApiUrl, config.siteUrl, 'localhost', '127.0.0.1']
    .map((value) => {
      const raw = String(value ?? '').trim()
      if (!raw) return ''
      try { return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase() } catch { return '' }
    })
    .filter(Boolean),
)

/**
 * Returns an absolute local file path for a self-hosted asset URL, or null if
 * the URL isn't ours, isn't a mounted path, or the file isn't on disk.
 *
 * Accepts absolute URLs and root-relative paths (`/assets/items/x.png`), since
 * some data entries are stored without an origin.
 */
export function localPathForAssetUrl(url) {
  const raw = String(url ?? '').trim()
  if (!raw) return null

  let pathname = ''
  if (raw.startsWith('/')) {
    pathname = raw
  } else if (/^https?:\/\//i.test(raw)) {
    let parsed
    try { parsed = new URL(raw) } catch { return null }
    if (!OWN_HOSTS.has(parsed.hostname.toLowerCase())) return null
    pathname = parsed.pathname
  } else {
    return null
  }

  for (const { prefix, dir } of MOUNTS) {
    if (!pathname.startsWith(prefix)) continue
    const file = decodeURIComponent(pathname.slice(prefix.length))
    // No path traversal: the tail must be a bare filename. `..%2Fetc` decodes
    // to `../etc`, which would otherwise escape the mount directory.
    if (!file || file.includes('/') || file.includes('\\') || file.includes('..')) return null
    const full = path.join(dir, file)
    return existsSync(full) ? full : null
  }
  return null
}

/** True when this URL can be served from disk. */
export function isLocallyServable(url) {
  return localPathForAssetUrl(url) != null
}
