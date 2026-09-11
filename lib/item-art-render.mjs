/**
 * lib/item-art-render.mjs — composites one item's artwork plate.
 *
 * Takes a game-icons.net SVG, recolors it by rarity, and lays it on a
 * rarity-tinted plate so all ~100 items share one art direction. Output is a
 * square PNG Buffer, same contract as every other lib/*-render.mjs here.
 *
 * The SVGs need two edits before they're usable:
 *
 *  1. Every game-icons file opens with `<path d="M0 0h512v512H0z"/>` — an
 *     opaque black backing square. Left in, every item is a black tile on the
 *     plate. It's stripped.
 *  2. The glyph itself is `fill="#fff"`. Recoloring it per rarity is what
 *     turns 4000 generic icons into artwork that belongs to this game.
 *
 * Both are string edits on the SVG source rather than canvas compositing,
 * because @napi-rs/canvas rasterizes the SVG in one shot — there's no layer to
 * reach into afterwards.
 */
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createCanvas, loadImage, roundedRect, rarityPalette } from './season-render-common.mjs'
import { rasterFor } from './item-art-map.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ICON_DIR = join(HERE, '..', 'vendor', 'game-icons')

/** Hand-drawn raster sprites, keyed by RASTER_BY_ID in lib/item-art-map.js. */
const RASTER_DIR = join(HERE, 'assets', 'items')

/** The opaque backing square every game-icons SVG starts with. */
const BACKING_RECT = /<path d="M0 0h512v512H0z"\s*\/>/

/**
 * Loads the hand-drawn sprite for an item, or null when it has none.
 *
 * Deliberately NOT recolored. The vendor glyphs are single-color line art, so
 * tinting them by rarity is what makes them feel like this game's items; a
 * finished sprite already has its own palette and tinting it would only ruin it.
 * Callers keep the rarity wash and frame, and just skip the recolor.
 */
export async function loadItemRaster(entry) {
  const file = rasterFor(entry)
  if (!file) return null
  const path = join(RASTER_DIR, file)
  try {
    if (!existsSync(path)) return null
    return await loadImage(readFileSync(path))
  } catch {
    return null
  }
}

export function iconExists(iconPath) {
  return !!iconPath && existsSync(join(ICON_DIR, `${iconPath}.svg`))
}

/**
 * Loads an icon SVG with the backing square removed and the glyph recolored.
 * Returns null when the icon isn't on disk — callers fall back to drawEmblem.
 */
/**
 * Loads an icon SVG with the backing square removed and the glyph recolored.
 * Returns null when the icon isn't on disk — callers fall back to drawEmblem.
 *
 * Exported as loadIconGlyph so lib/pvp-kit-render.mjs can draw bare glyphs onto
 * its own textured boxes instead of stamping a whole renderItemArt() plate over
 * them. Same SVG massaging, one implementation.
 */
export async function loadIconGlyph(iconPath, color) {
  return loadIcon(iconPath, color)
}

async function loadIcon(iconPath, color) {
  const file = join(ICON_DIR, `${iconPath}.svg`)
  if (!existsSync(file)) return null
  let svg = readFileSync(file, 'utf8')
  svg = svg.replace(BACKING_RECT, '')
  // Some icons set fill on the root <svg> instead of the path, so both forms
  // are rewritten. Anything still unfilled inherits the root fill.
  svg = svg.replace(/fill="#fff"/gi, `fill="${color}"`)
  if (!/fill="/.test(svg)) svg = svg.replace('<svg ', `<svg fill="${color}" `)
  try {
    return await loadImage(Buffer.from(svg))
  } catch {
    return null
  }
}

/* ─────────────────── the Totem of Undying revive animation ─────────────────── */

/** The looping revive animation, read once per process and then reused. */
let reviveGifCache
function totemReviveGif() {
  if (reviveGifCache !== undefined) return reviveGifCache
  const path = join(RASTER_DIR, 'totem_revive.gif')
  try {
    reviveGifCache = existsSync(path) ? readFileSync(path) : null
  } catch {
    reviveGifCache = null
  }
  return reviveGifCache
}

/**
 * sendTotemReviveAnimation(ctx, who, opts) — plays the totem animation the moment
 * a lethal hit is eaten instead of landing.
 *
 * Sent as its own message, ahead of the turn's own frame, because the point is
 * that the death did not happen: burying it in a caption under the battle board
 * is exactly the wrong emphasis. The caption names who was saved and what burned,
 * so a player scrolling back knows a charge was spent and not just that something
 * flashed.
 *
 * Never throws and never blocks the turn. If the GIF is missing or the transcode
 * fails, the narrative line checkTotemRevive() already returned still tells the
 * whole story in text, so this stays a bonus rather than a dependency.
 */
export async function sendTotemReviveAnimation(ctx, who, opts = {}) {
  const gif = totemReviveGif()
  if (!gif) return false
  const isClasp = !!opts.isClasp
  const caption =
    `✨ *${isClasp ? 'PHOENIX CLASP' : 'TOTEM OF UNDYING'} USED!*\n` +
    `_${who} should be dead. The ${isClasp ? 'clasp' : 'totem'} went instead._\n` +
    `💫 Death cancelled, one charge spent.`
  try {
    if (typeof ctx.replyGif === 'function') return !!(await ctx.replyGif(gif, caption))
    if (typeof ctx.replyImage === 'function') return !!(await ctx.replyImage(gif, caption))
  } catch (err) {
    console.error('[item-art-render] totem animation failed:', err?.message)
  }
  return false
}

/**
 * Renders the item plate.
 *
 * @param {object} entry           { id, name, type, rarity }
 * @param {string} iconPath        e.g. 'lorc/broadsword'
 * @param {number} size            square edge in px
 * @returns {Promise<Buffer|null>} PNG, or null if the icon was unusable
 */
export async function renderItemArt(entry, iconPath, size = 512) {
  const pal = rarityPalette(entry?.rarity)
  // Hand-drawn sprite first, vendor glyph second. Everything below (plate, wash,
  // halo, ticks, pips) is identical either way, so a raster item still sits in
  // the same frame as the other hundred and the shop rows stay uniform.
  const raster = await loadItemRaster(entry)
  const img = raster ?? await loadIcon(iconPath, pal.glow)
  if (!img) return null

  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const s = size / 512   // every constant below is authored against 512

  // ── plate ──────────────────────────────────────────────────────────────
  ctx.fillStyle = '#0d0d12'
  ctx.fillRect(0, 0, size, size)

  const wash = ctx.createLinearGradient(0, 0, 0, size)
  wash.addColorStop(0, `${pal.base}33`)
  wash.addColorStop(1, '#0d0d1200')
  ctx.fillStyle = wash
  ctx.fillRect(0, 0, size, size)

  // Rarity halo behind the glyph — this is what makes a legendary read as
  // legendary at thumbnail size, where the border is only a couple of pixels.
  const halo = ctx.createRadialGradient(size / 2, size / 2, 20 * s, size / 2, size / 2, size * 0.52)
  halo.addColorStop(0, `${pal.base}4d`)
  halo.addColorStop(1, '#00000000')
  ctx.fillStyle = halo
  ctx.fillRect(0, 0, size, size)

  // Corner ticks instead of a full frame: a frame competes with the shop
  // render's own row border, ticks read as a plate at any size.
  ctx.save()
  ctx.strokeStyle = `${pal.base}aa`
  ctx.lineWidth = 3 * s
  ctx.lineCap = 'round'
  const m = 26 * s          // margin
  const t = 46 * s          // tick length
  for (const [cx, cy, dx, dy] of [
    [m, m, 1, 1], [size - m, m, -1, 1],
    [m, size - m, 1, -1], [size - m, size - m, -1, -1],
  ]) {
    ctx.beginPath()
    ctx.moveTo(cx + dx * t, cy)
    ctx.lineTo(cx, cy)
    ctx.lineTo(cx, cy + dy * t)
    ctx.stroke()
  }
  ctx.restore()

  // ── glyph ──────────────────────────────────────────────────────────────
  // Drawn twice: a blurred pass for the glow, then the crisp pass on top.
  // shadowBlur alone tints the edges without lifting the whole shape.
  const inset = size * 0.22
  const box = size - inset * 2

  if (!raster) {
    ctx.save()
    ctx.globalAlpha = 0.45
    ctx.shadowColor = pal.base
    ctx.shadowBlur = 34 * s
    ctx.drawImage(img, inset, inset, box, box)
    ctx.restore()
  }

  ctx.drawImage(img, inset, inset, box, box)

  // ── rarity pips ────────────────────────────────────────────────────────
  // Small, bottom-centred, and skipped entirely for unranked entries.
  if (pal.stars) {
    const r = 5 * s
    const gap = 16 * s
    const total = pal.stars
    const startX = size / 2 - ((total - 1) * gap) / 2
    const y = size - 34 * s
    ctx.fillStyle = pal.base
    for (let i = 0; i < total; i++) {
      ctx.beginPath()
      ctx.arc(startX + i * gap, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  return canvas.toBuffer('image/png')
}

/** Convenience: a contact sheet of several plates, for eyeballing a batch. */
export async function renderContactSheet(rows, { cell = 190, cols = 5 } = {}) {
  const lines = Math.ceil(rows.length / cols)
  const labelH = 34
  const W = cols * cell
  const H = lines * (cell + labelH)
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#07070a'
  ctx.fillRect(0, 0, W, H)

  for (let i = 0; i < rows.length; i++) {
    const { entry, buffer } = rows[i]
    const x = (i % cols) * cell
    const y = Math.floor(i / cols) * (cell + labelH)
    if (buffer) {
      const img = await loadImage(buffer)
      ctx.save()
      roundedRect(ctx, x + 8, y + 8, cell - 16, cell - 16, 14)
      ctx.clip()
      ctx.drawImage(img, x + 8, y + 8, cell - 16, cell - 16)
      ctx.restore()
    }
    ctx.font = 'bold 12px sans-serif'
    ctx.fillStyle = '#f5f3ee'
    ctx.textAlign = 'center'
    const name = String(entry.name ?? entry.id ?? '')
    ctx.fillText(name.length > 24 ? `${name.slice(0, 23)}…` : name, x + cell / 2, y + cell + 4)
    ctx.font = '10px sans-serif'
    ctx.fillStyle = '#9b968c'
    ctx.fillText(String(entry.rarity ?? ''), x + cell / 2, y + cell + 20)
  }
  return canvas.toBuffer('image/png')
}
