/**
 * lib/season-render-common.mjs
 *
 * Shared canvas primitives for the three season renders
 * (season-shop-render, season-pass-render, season-item-render). Same
 * @napi-rs/canvas → PNG Buffer contract as every other lib/*-render.mjs in
 * this bot; see lib/pokemon-party-render.mjs for the original of that shape.
 *
 * Two things here are worth knowing before changing them:
 *
 * 1. NO EMOJI IS EVER DRAWN. A headless Linux VPS usually has no emoji font
 *    installed, so `ctx.fillText('🔱')` silently paints tofu boxes — which
 *    looks broken in a way that's easy to miss in review and impossible to
 *    miss in a screenshot. Every icon here is drawn as vector geometry
 *    (stars, crests, gems, padlocks) and every label is plain ASCII-safe
 *    text. Emoji still belong in the text captions, which WhatsApp renders
 *    with the phone's own font.
 *
 * 2. ARTWORK IS ALWAYS OPTIONAL. Most item images in data/*.json point at
 *    play.astral.qzz.io, which is currently unreachable, so tryFetch() will
 *    return null for them. Callers must fall back to drawEmblem() rather
 *    than leaving a hole — a render that only looks right when the network
 *    cooperates isn't finished. If those URLs come back up, or get re-hosted,
 *    the artwork appears with no code change.
 */
import './fonts.js' // registers bundled fonts before any canvas draw — see lib/fonts.js
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { readFileSync } from 'fs'
import { localPathForAssetUrl } from './self-hosted-asset.js'

export { createCanvas, loadImage }

/** Gold-on-black, matching the companion site's --gold: #d4af37. */
export const GOLD = '#d4af37'
export const GOLD_DIM = '#8a7327'
export const INK = '#07070a'
export const PANEL = '#121218'
export const PANEL_HI = '#1c1c25'
export const TEXT = '#f5f3ee'
export const TEXT_DIM = '#9b968c'

export const RARITY = {
  common: { base: '#8d949e', glow: '#c8ced6', stars: 1 },
  uncommon: { base: '#3f9d63', glow: '#86dfa4', stars: 2 },
  rare: { base: '#3277e0', glow: '#8fbdff', stars: 3 },
  epic: { base: '#9b4dea', glow: '#d6b0fb', stars: 4 },
  legendary: { base: '#d4af37', glow: '#ffe6a0', stars: 5 },
  mythical: { base: '#e0475f', glow: '#ffadb9', stars: 6 },
}

/**
 * Spellings that appear in data/ but aren't the table's key. `mythic` is used
 * 16 times across data/*.json against only 2 uses of `mythical`, so without
 * this every one of those entries fell through to the grey unranked default —
 * no tint and no stars — in the shop, pass and item renders alike. Normalising
 * here fixes all three at once, and is safer than renaming the key (the data
 * files, the site and the season engine all read the string form).
 */
const RARITY_ALIASES = {
  mythic: 'mythical',
  myth: 'mythical',
  ultra: 'mythical',
  uncommmon: 'uncommon',   // typo seen in older entries
  legend: 'legendary',
}

export function rarityPalette(rarity) {
  const key = String(rarity ?? '').trim().toLowerCase()
  return RARITY[RARITY_ALIASES[key] ?? key] ?? { base: '#5a5a64', glow: '#9a9aa4', stars: 0 }
}

/**
 * Renders an item plate for one of our own /assets/items/ URLs, or null for
 * anything else. Resolved through a dynamic import to keep this module free of
 * a static dependency on item-art-cache, which imports back into here.
 */
async function itemArtFor(url) {
  try {
    const { itemArtBufferForUrl } = await import('./item-art-cache.mjs')
    return await itemArtBufferForUrl(url)
  } catch { return null }
}

/**
 * Fetches an image, or returns null on ANY failure (404, DNS, timeout,
 * non-image body). Never throws — a dead artwork host must not fail a render.
 *
 * Self-hosted URLs never touch the network. Fetching them over the public
 * internet was a round trip out to Cloudflare and back for something already in
 * reach, and it meant the art vanished whenever the tunnel did. Two ways to
 * satisfy one locally: a file on disk (profile defaults — see
 * lib/self-hosted-asset.js), or a plate rendered on the spot (item art).
 */
export async function tryFetch(url, timeoutMs = 6000) {
  if (!url || typeof url !== 'string') return null
  const local = localPathForAssetUrl(url)
  if (local) {
    try { return await loadImage(readFileSync(local)) } catch { /* fall through to the network */ }
  }
  // Item plates aren't stored any more — they're rendered from vendor/game-icons
  // on demand (lib/item-art-cache.mjs). Imported lazily because that module
  // reaches back into this one for createCanvas/rarityPalette, and a static
  // import either way round would be a cycle.
  const plate = await itemArtFor(url)
  if (plate) {
    try { return await loadImage(plate) } catch { /* fall through to the network */ }
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return await loadImage(Buffer.from(await res.arrayBuffer()))
  } catch { return null }
}

/** Fetches many images at once; each slot is an Image or null, order kept. */
export function fetchAll(urls, timeoutMs = 6000) {
  return Promise.all(urls.map((u) => tryFetch(u, timeoutMs)))
}

export function roundedRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.arcTo(x + w, y, x + w, y + h, rad)
  ctx.arcTo(x + w, y + h, x, y + h, rad)
  ctx.arcTo(x, y + h, x, y, rad)
  ctx.arcTo(x, y, x + w, y, rad)
  ctx.closePath()
}

export function linearFill(ctx, x, y, w, h, stops, vertical = true) {
  const g = vertical
    ? ctx.createLinearGradient(x, y, x, y + h)
    : ctx.createLinearGradient(x, y, x + w, y)
  for (const [offset, color] of stops) g.addColorStop(offset, color)
  return g
}

/** Truncates to fit maxWidth, appending an ellipsis. Set ctx.font first. */
export function truncate(ctx, text, maxWidth) {
  const str = String(text ?? '')
  if (ctx.measureText(str).width <= maxWidth) return str
  let cut = str
  while (cut.length > 1 && ctx.measureText(`${cut}...`).width > maxWidth) {
    cut = cut.slice(0, -1)
  }
  return `${cut.trimEnd()}...`
}

/** Word-wraps into at most maxLines, ellipsising the last one. */
export function wrapText(ctx, text, maxWidth, maxLines = 3) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width <= maxWidth) { line = next; continue }
    if (line) lines.push(line)
    line = word
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && line) lines.push(line)
  if (lines.length === maxLines && words.length) {
    const joined = lines.join(' ')
    const consumed = joined.split(/\s+/).length
    if (consumed < words.length) lines[maxLines - 1] = truncate(ctx, lines[maxLines - 1], maxWidth)
  }
  return lines
}

/** Draws `img` scaled to FIT inside the box (letterboxed), centred. */
export function drawContain(ctx, img, x, y, w, h) {
  const scale = Math.min(w / img.width, h / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

/** Draws `img` scaled to COVER the box, centre-cropped. Clip before calling. */
export function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

// ── Vector icons ─────────────────────────────────────────────────────────
// All hand-drawn rather than font glyphs — see the emoji note in the header.

export function drawStar(ctx, cx, cy, outer, inner = outer * 0.45, points = 5) {
  ctx.beginPath()
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = (Math.PI / points) * i - Math.PI / 2
    const px = cx + Math.cos(a) * r
    const py = cy + Math.sin(a) * r
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}

/** A row of `total` stars with `filled` of them lit in the rarity colour. */
export function drawStars(ctx, x, y, size, filled, total = 5, color = GOLD) {
  const gap = size * 2.4
  for (let i = 0; i < total; i++) {
    const cx = x + i * gap + size
    drawStar(ctx, cx, y + size, size)
    if (i < filled) {
      ctx.fillStyle = color
      ctx.fill()
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
  return x + total * gap
}

/** Small faceted gem — the Gems currency marker. */
export function drawGem(ctx, cx, cy, r, color = '#6fd6ff') {
  ctx.beginPath()
  ctx.moveTo(cx, cy - r)
  ctx.lineTo(cx + r * 0.85, cy - r * 0.2)
  ctx.lineTo(cx, cy + r)
  ctx.lineTo(cx - r * 0.85, cy - r * 0.2)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(cx, cy - r)
  ctx.lineTo(cx, cy + r)
  ctx.moveTo(cx - r * 0.85, cy - r * 0.2)
  ctx.lineTo(cx + r * 0.85, cy - r * 0.2)
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'
  ctx.lineWidth = 1
  ctx.stroke()
}

/** Four-point sparkle — the Season Points marker. */
export function drawSpark(ctx, cx, cy, r, color = GOLD) {
  ctx.beginPath()
  ctx.moveTo(cx, cy - r)
  ctx.quadraticCurveTo(cx + r * 0.18, cy - r * 0.18, cx + r, cy)
  ctx.quadraticCurveTo(cx + r * 0.18, cy + r * 0.18, cx, cy + r)
  ctx.quadraticCurveTo(cx - r * 0.18, cy + r * 0.18, cx - r, cy)
  ctx.quadraticCurveTo(cx - r * 0.18, cy - r * 0.18, cx, cy - r)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

export function drawLock(ctx, cx, cy, size, color = TEXT_DIM) {
  const bw = size
  const bh = size * 0.78
  const bx = cx - bw / 2
  const by = cy - bh / 2 + size * 0.18
  ctx.lineWidth = Math.max(1.6, size * 0.13)
  ctx.strokeStyle = color
  ctx.beginPath()
  ctx.arc(cx, by, bw * 0.32, Math.PI, 0)
  ctx.stroke()
  roundedRect(ctx, bx, by, bw, bh, size * 0.16)
  ctx.fillStyle = color
  ctx.fill()
}

export function drawCheck(ctx, cx, cy, size, color = '#4ad07a') {
  ctx.beginPath()
  ctx.arc(cx, cy, size, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(cx - size * 0.42, cy + size * 0.02)
  ctx.lineTo(cx - size * 0.10, cy + size * 0.36)
  ctx.lineTo(cx + size * 0.46, cy - size * 0.34)
  ctx.lineWidth = Math.max(2, size * 0.24)
  ctx.strokeStyle = INK
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.lineCap = 'butt'
}

/**
 * Fallback artwork: a rarity-tinted crest with a `kind`-appropriate glyph and
 * the entry's initials. Used whenever tryFetch() came back null — which is
 * most item images right now, since data/*.json points them at
 * play.astral.qzz.io and that host is down. It should look deliberate, not
 * like a missing image.
 */
export function drawEmblem(ctx, x, y, w, h, { name = '?', rarity = 'common', kind = '' } = {}) {
  const pal = rarityPalette(rarity)
  const cx = x + w / 2
  const cy = y + h / 2
  const r = Math.min(w, h) * 0.34

  ctx.save()
  const halo = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.9)
  halo.addColorStop(0, `${pal.base}55`)
  halo.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = halo
  ctx.fillRect(x, y, w, h)

  // Hexagonal crest
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2
    const px = cx + Math.cos(a) * r
    const py = cy + Math.sin(a) * r
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fillStyle = 'rgba(255,255,255,0.05)'
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = pal.base
  ctx.stroke()

  const glyph = String(kind).toLowerCase()
  ctx.strokeStyle = pal.glow
  ctx.fillStyle = pal.glow
  ctx.lineWidth = Math.max(2, r * 0.11)
  ctx.lineCap = 'round'

  if (glyph.includes('weapon')) {
    // Blade
    ctx.beginPath()
    ctx.moveTo(cx, cy - r * 0.62)
    ctx.lineTo(cx, cy + r * 0.30)
    ctx.moveTo(cx - r * 0.34, cy + r * 0.30)
    ctx.lineTo(cx + r * 0.34, cy + r * 0.30)
    ctx.moveTo(cx, cy + r * 0.30)
    ctx.lineTo(cx, cy + r * 0.62)
    ctx.stroke()
  } else if (glyph.includes('armor')) {
    // Shield
    ctx.beginPath()
    ctx.moveTo(cx, cy - r * 0.60)
    ctx.lineTo(cx + r * 0.46, cy - r * 0.34)
    ctx.lineTo(cx + r * 0.34, cy + r * 0.34)
    ctx.lineTo(cx, cy + r * 0.62)
    ctx.lineTo(cx - r * 0.34, cy + r * 0.34)
    ctx.lineTo(cx - r * 0.46, cy - r * 0.34)
    ctx.closePath()
    ctx.stroke()
  } else if (glyph.includes('relic') || glyph.includes('title')) {
    drawStar(ctx, cx, cy, r * 0.58, r * 0.26, 6)
    ctx.stroke()
  } else if (glyph.includes('consumable') || glyph.includes('item')) {
    // Flask
    ctx.beginPath()
    ctx.moveTo(cx - r * 0.20, cy - r * 0.58)
    ctx.lineTo(cx - r * 0.20, cy - r * 0.16)
    ctx.lineTo(cx - r * 0.46, cy + r * 0.42)
    ctx.quadraticCurveTo(cx, cy + r * 0.78, cx + r * 0.46, cy + r * 0.42)
    ctx.lineTo(cx + r * 0.20, cy - r * 0.16)
    ctx.lineTo(cx + r * 0.20, cy - r * 0.58)
    ctx.closePath()
    ctx.stroke()
  } else if (glyph.includes('currency') || glyph.includes('gem') || glyph.includes('stone')) {
    drawGem(ctx, cx, cy, r * 0.62, pal.glow)
  } else if (glyph.includes('pet') || glyph.includes('beast') || glyph.includes('pokemon')) {
    // Paw
    ctx.beginPath()
    ctx.ellipse(cx, cy + r * 0.24, r * 0.34, r * 0.28, 0, 0, Math.PI * 2)
    ctx.fill()
    for (const [dx, dy] of [[-0.40, -0.24], [-0.14, -0.44], [0.14, -0.44], [0.40, -0.24]]) {
      ctx.beginPath()
      ctx.ellipse(cx + r * dx, cy + r * dy, r * 0.13, r * 0.17, 0, 0, Math.PI * 2)
      ctx.fill()
    }
  } else {
    drawStar(ctx, cx, cy, r * 0.56)
    ctx.stroke()
  }
  ctx.lineCap = 'butt'

  // Initials under the crest so two fallbacks are never mistaken for each other
  const initials = String(name)
    .split(/\s+/)
    .slice(0, 2)
    .map((w2) => w2[0] ?? '')
    .join('')
    .toUpperCase()
  if (initials) {
    ctx.font = `bold ${Math.round(r * 0.42)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.fillText(initials, cx, cy + r * 1.42)
  }
  ctx.restore()
}

