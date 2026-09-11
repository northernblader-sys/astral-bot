/**
 * pvp-kit-render.mjs — the PvP kit image: a 5x3 gaming-style grid.
 *
 * This is the port of the standalone generate_inventory.mjs from the spec
 * folder, moved onto the bot's own canvas stack and wired to real data:
 *   - `canvas` -> `@napi-rs/canvas` (the package this bot actually depends on)
 *   - `registerFont(path, { family })` -> `GlobalFonts.registerFromPath(path, family)`
 *   - the 15 boxes are no longer empty texture; each one holds the real vendor
 *     glyph for one copy of one item, tinted by the item's rarity, with a name
 *     strip. Copies are not stacked: 15 totems occupy 15 boxes.
 *
 * The grid is 5 columns x 3 rows because that is exactly PVP_KIT_SLOTS from
 * lib/pvp-kit.js. The cap and the picture are one fact, imported from one
 * place, so they cannot drift apart.
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createCanvas, loadImage, rarityPalette } from './season-render-common.mjs'
import { GlobalFonts } from '@napi-rs/canvas'
import { loadIconGlyph, loadItemRaster } from './item-art-render.mjs'
import { iconFor } from './item-art-map.js'
import { PVP_KIT_COLS, PVP_KIT_ROWS, PVP_KIT_SLOTS, kitContents } from './pvp-kit.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, 'assets', 'inventory')

/* ───────────────────────── layout (from the spec) ───────────────────────── */

const COLS = PVP_KIT_COLS
const ROWS = PVP_KIT_ROWS
const CELL = 150
const LINE_W = 6
const TOP_SPACE = 150

const GRID_W = COLS * CELL
const GRID_H = ROWS * CELL
const WIDTH  = GRID_W
const HEIGHT = GRID_H + TOP_SPACE

/* ───────────────────────────── fonts ───────────────────────────── */

let fontsReady = false

/**
 * Registers the two display faces once per process. Missing font files are not
 * fatal: the canvas falls back to a system sans and the grid still renders,
 * which matters because a duel should never fail to draw over a typeface.
 */
function ensureFonts() {
  if (fontsReady) return
  fontsReady = true
  for (const [file, family] of [
    ['Orbitron-Bold.ttf', 'Orbitron'],
    ['Bangers-Regular.ttf', 'Bangers'],
  ]) {
    const path = join(ASSETS, file)
    try {
      if (existsSync(path)) GlobalFonts.registerFromPath(path, family)
    } catch { /* fall through to the system font */ }
  }
}

/** Font stack strings, with fallbacks in case registration was skipped. */
const TITLE_FONT = 'bold 60px Orbitron, sans-serif'
const TAG_FONT   = '46px Bangers, sans-serif'

/* ──────────────────────────── helpers ──────────────────────────── */

/** Letter-by-letter draw with extra tracking, centred on the canvas. */
function drawSpreadText(ctx, text, y, font, color, letterSpacing = 8, width = WIDTH) {
  ctx.font = font
  ctx.fillStyle = color
  ctx.textBaseline = 'top'

  const chars = [...text]
  const widths = chars.map((ch) => ctx.measureText(ch).width)
  const total = widths.reduce((a, b) => a + b, 0) + letterSpacing * (chars.length - 1)

  let x = (width - total) / 2
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x, y)
    x += widths[i] + letterSpacing
  }
}

/** Rotated text drawn on an offscreen canvas, then composited at (dx, dy). */
function drawRotatedText(ctx, text, font, color, angleDeg, dx, dy, boxW, boxH) {
  const off = createCanvas(boxW, boxH)
  const octx = off.getContext('2d')
  octx.font = font
  octx.fillStyle = color
  octx.textBaseline = 'top'
  octx.translate(boxW / 2, boxH / 2)
  octx.rotate((angleDeg * Math.PI) / 180)
  const w = octx.measureText(text).width
  octx.fillText(text, -w / 2, -boxH * 0.2)
  ctx.drawImage(off, dx, dy)
}

/**
 * Cover-fit source rect for drawing `img` into a target box without distortion,
 * cropping the overflow. Same maths the spec script did inline.
 */
function coverRect(img, targetW, targetH) {
  const targetRatio = targetW / targetH
  const imgRatio = img.width / img.height
  if (imgRatio > targetRatio) {
    const sh = img.height
    const sw = sh * targetRatio
    return { sx: (img.width - sw) / 2, sy: 0, sw, sh }
  }
  const sw = img.width
  const sh = sw / targetRatio
  return { sx: 0, sy: (img.height - sh) / 2, sw, sh }
}

/** Truncate to fit a pixel width, adding an ellipsis. */
function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}...`).width > maxW) out = out.slice(0, -1)
  return `${out}...`
}

/* ─────────────────────────── the render ─────────────────────────── */

/**
 * renderPvpKit(player, opts) -> PNG Buffer
 *
 * opts.title    header word, default 'INVENTORY' (the spec's original)
 * opts.tag      the tilted red corner tag, default 'PVP'
 * opts.subtitle small centred line under the title
 *
 * Never throws for missing art: a slot whose item has no vendor glyph falls
 * back to the item's initial on the tan plate, and a missing texture falls back
 * to a flat fill. A duel must never fail because a PNG is absent.
 */
export async function renderPvpKit(player, opts = {}) {
  ensureFonts()

  const title = opts.title ?? 'INVENTORY'
  const tag = opts.tag ?? 'PVP'
  const subtitle = opts.subtitle ?? `${player?.name ?? 'kit'} · ${(player?.pvpKit ?? []).length}/${PVP_KIT_SLOTS} slots`

  const canvas = createCanvas(WIDTH, HEIGHT)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'black'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  // ── header: wood texture, blurred and darkened ──
  const wood = await safeLoad(join(ASSETS, 'wood_sign.jpg'))
  const headerCanvas = createCanvas(WIDTH, TOP_SPACE)
  const hctx = headerCanvas.getContext('2d')
  if (wood) {
    const { sx, sy, sw, sh } = coverRect(wood, WIDTH, TOP_SPACE)
    // Drawn 10px oversize on every edge so the blur has material to sample and
    // does not fade to transparent at the border.
    hctx.filter = 'blur(6px)'
    hctx.drawImage(wood, sx, sy, sw, sh, -10, -10, WIDTH + 20, TOP_SPACE + 20)
    hctx.filter = 'none'
  } else {
    hctx.fillStyle = '#2a1c10'
    hctx.fillRect(0, 0, WIDTH, TOP_SPACE)
  }
  hctx.fillStyle = 'rgba(0,0,0,0.65)'
  hctx.fillRect(0, 0, WIDTH, TOP_SPACE)
  ctx.drawImage(headerCanvas, 0, 0)

  // ── the 15 boxes ──
  const texture = await safeLoad(join(ASSETS, 'tan_texture_crop.png'))
  const boxSize = CELL - LINE_W
  const slots = buildSlots(player)

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * CELL + LINE_W / 2
      const y = TOP_SPACE + r * CELL + LINE_W / 2
      if (texture) {
        ctx.drawImage(texture, 0, 0, texture.width, texture.height, x, y, boxSize, boxSize)
      } else {
        ctx.fillStyle = '#c9ad84'
        ctx.fillRect(x, y, boxSize, boxSize)
      }
      const slot = slots[r * COLS + c]
      if (slot) await drawSlot(ctx, slot, x, y, boxSize)
    }
  }

  // ── title, tag, subtitle ──
  drawSpreadText(ctx, title, 45, TITLE_FONT, 'white', 10)
  drawRotatedText(ctx, tag, TAG_FONT, 'rgb(255,60,60)', -12, WIDTH - 165, 15, 160, 80)
  drawSpreadText(ctx, subtitle, 115, 'italic 14px sans-serif', 'rgb(220,220,220)', 5)

  // ── grid lines last, so they sit over the art ──
  ctx.strokeStyle = 'white'
  ctx.lineWidth = LINE_W
  for (let i = 0; i <= COLS; i++) {
    const x = i * CELL
    ctx.beginPath(); ctx.moveTo(x, TOP_SPACE); ctx.lineTo(x, HEIGHT); ctx.stroke()
  }
  for (let j = 0; j <= ROWS; j++) {
    const y = TOP_SPACE + j * CELL
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WIDTH, y); ctx.stroke()
  }

  return canvas.toBuffer('image/png')
}

/** loadImage that returns null instead of throwing on a missing file. */
async function safeLoad(path) {
  try {
    if (!existsSync(path)) return null
    return await loadImage(readFileSync(path))
  } catch {
    return null
  }
}

/**
 * One box per copy. 15 totems fill 15 boxes, the way a real inventory grid
 * works, rather than collapsing into one box wearing an "x15" badge. The
 * 15-slot cap counts copies (see kitSpace in lib/pvp-kit.js), so a full kit is
 * exactly a full grid and the picture can never disagree with the subtitle.
 *
 * kitContents groups by id for the text panel; the sort order it returns is
 * kept, so copies of the same item sit next to each other.
 */
function buildSlots(player) {
  const out = []
  for (const entry of kitContents(player ?? {})) {
    for (let i = 0; i < entry.count; i++) {
      if (out.length >= PVP_KIT_SLOTS) return out
      out.push({ id: entry.id, item: entry.item, count: 1 })
    }
  }
  return out
}

/**
 * Draws one stocked slot into its box: rarity wash, vendor glyph, name strip.
 * One box is one copy, so there is no stack badge to draw. The glyph is drawn at
 * 62% of the box so the tan texture stays visible around it and the boxes still
 * read as a grid of pouches rather than a wall of full-bleed cards.
 */
async function drawSlot(ctx, slot, x, y, size) {
  const item = slot.item
  const pal = rarityPalette(item?.rarity ?? 'common')
  const accent = pal?.glow ?? pal?.line ?? '#e8d9b0'

  // Rarity wash, kept light so the tan reads through it.
  ctx.save()
  ctx.globalAlpha = 0.22
  ctx.fillStyle = accent
  ctx.fillRect(x, y, size, size)
  ctx.restore()

  // Inner rarity frame.
  ctx.save()
  ctx.strokeStyle = accent
  ctx.lineWidth = 2
  ctx.strokeRect(x + 4, y + 4, size - 8, size - 8)
  ctx.restore()

  // ── the artwork: hand-drawn sprite first, vendor glyph second ──
  // A sprite made for the item should never lose to a generic glyph, so the
  // raster is tried first. It skips the light halo, which exists only to keep
  // dark single-color line art legible on tan and would wash out a real sprite.
  const raster = item ? await loadItemRaster(item) : null
  const iconPath = raster ? null : (item ? iconFor(item) : null)
  const glyph = raster ?? (iconPath ? await loadIconGlyph(iconPath, '#1a1208') : null)
  const inset = Math.round(size * 0.19)
  const artBox = size - inset * 2

  if (glyph) {
    if (!raster) {
      ctx.save()
      // Soft light halo behind the glyph so dark line art stays legible on tan.
      ctx.globalAlpha = 0.55
      ctx.fillStyle = 'rgba(255,248,230,0.9)'
      ctx.beginPath()
      ctx.arc(x + size / 2, y + size / 2 - 6, artBox * 0.52, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }

    ctx.drawImage(glyph, x + inset, y + inset - 6, artBox, artBox)
  } else {
    // Fallback: the item's initial, so an unmapped icon is still identifiable.
    ctx.save()
    ctx.fillStyle = '#2a1c10'
    ctx.font = `bold ${Math.round(size * 0.42)}px Orbitron, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText((item?.name ?? slot.id ?? '?')[0].toUpperCase(), x + size / 2, y + size / 2 - 6)
    ctx.restore()
  }

  // ── name strip across the bottom ──
  ctx.save()
  ctx.fillStyle = 'rgba(12,10,8,0.82)'
  ctx.fillRect(x, y + size - 22, size, 22)
  ctx.font = 'bold 12px sans-serif'
  ctx.fillStyle = '#f4e6c2'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(fit(ctx, item?.name ?? slot.id, size - 12), x + size / 2, y + size - 10)
  ctx.restore()
}

/**
 * sendKitReply(ctx, player, caption) — render and send, falling back to the text
 * panel if canvas is unavailable in this environment. Mirrors the shape of
 * sendBattleTurnReply in lib/battle-frame-render.mjs: the plugin calls one
 * function and never has to know whether an image was produced.
 */
export async function sendKitReply(ctx, player, caption) {
  try {
    const png = await renderPvpKit(player)
    if (png && typeof ctx.replyImage === 'function') {
      return ctx.replyImage(png, caption)
    }
  } catch (err) {
    console.error('[pvp-kit-render] falling back to text:', err?.message)
  }
  return ctx.reply(caption)
}
