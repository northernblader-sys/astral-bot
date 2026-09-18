/**
 * lib/season-shop-render.mjs
 * Renders the current Season Shop page as a vertical shelf — one full-width
 * row per entry, carrying its artwork, name, kind, rarity, Season Point price
 * and an OWNED / SOLD OUT / n LEFT chip.
 *
 *   export async function renderSeasonShopPage(opts) → Buffer (PNG)
 *
 * opts: {
 *   season,          // the active season object (name/number)
 *   page,            // { label, emoji, entries } from getSeasonShopPages()
 *   pageIndex,       // 0-based
 *   pageCount,
 *   player,          // optional — drives the points readout and OWNED chips
 *   entryState,      // optional Map/obj: entryId -> { owned, soldOut, left, affordable }
 * }
 *
 * Rows, not a grid. The previous 2×2 card layout gave each name ~380px at
 * 23px type, so most entries truncated mid-word and the kind label collided
 * with the price. A full-width row gives a name ~600px and lets the price sit
 * in its own measured column, so nothing overlaps and nothing is cut short.
 * It also shows six entries instead of four, and the canvas is sized to the
 * number of entries — a three-item shelf no longer pads itself out with empty
 * "sealed" cells.
 *
 * Colour is deliberately restrained: a flat ink field, one soft wash behind
 * the header, and gold used only for prices and the points readout. Rarity
 * shows up in two places — the row's left edge and its thumbnail tile — rather
 * than as a glow on every border, which is what made the old version read as
 * noisy.
 *
 * PNG, not SVG: WhatsApp image messages don't render SVG at all, and every
 * other render in this bot (lib/*-render.mjs) already returns a PNG Buffer
 * that ctx.replyImage takes directly.
 */
import './fonts.js' // registers bundled fonts before any canvas draw — see lib/fonts.js
import {
  createCanvas, tryFetch, roundedRect, truncate, drawContain, drawEmblem,
  drawStars, drawSpark, drawCheck, rarityPalette,
  GOLD, INK, PANEL, TEXT, TEXT_DIM,
} from './season-render-common.mjs'
import { describeSeasonEntry } from './season-engine.js'

const W = 940
const PAD = 30
const HEADER_H = 150
const FOOTER_H = 64
const GRID_GAP = 16
const ROW_H = 104
const ROW_GAP = 12
const MAX_ROWS = 6

const OK = '#4ad07a'
const NO = '#c8606f'

/** Every helper here save/restores. A leaked textAlign is the classic canvas
 *  bug in this codebase — it's what made the item render overflow. */
function drawBackdrop(ctx, H) {
  ctx.save()
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, W, H)

  // One wash, top-down, fading out before the first row. Enough to lift the
  // header off the field without texturing the whole canvas.
  const wash = ctx.createLinearGradient(0, 0, 0, HEADER_H * 1.6)
  wash.addColorStop(0, 'rgba(212,175,55,0.09)')
  wash.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = wash
  ctx.fillRect(0, 0, W, HEADER_H * 1.6)
  ctx.restore()
}

function drawHeader(ctx, { season, page, pageIndex, pageCount, player, shown, total }) {
  ctx.save()
  ctx.textAlign = 'left'

  ctx.font = 'bold 14px sans-serif'
  ctx.fillStyle = GOLD
  ctx.fillText(
    `SEASON ${season?.number ?? 1}  ·  ${String(season?.name ?? '').toUpperCase()}`,
    PAD, 42,
  )

  // The points readout is measured before the title so the title's maxWidth
  // can be derived from it — that's what keeps a long shelf name from ever
  // running underneath the number.
  const points = Number(player?.seasonPoints ?? 0).toLocaleString('en-US')
  ctx.font = 'bold 34px sans-serif'
  const pointsW = ctx.measureText(points).width
  ctx.font = '12px sans-serif'
  const capW = ctx.measureText('SEASON POINTS').width
  const blockW = Math.max(pointsW + 26, capW) + 34

  ctx.font = 'bold 42px sans-serif'
  ctx.fillStyle = TEXT
  ctx.fillText(truncate(ctx, page?.label ?? 'Season Shop', W - PAD * 2 - blockW - 24), PAD, 88)

  ctx.font = '15px sans-serif'
  ctx.fillStyle = TEXT_DIM
  const scope = total > shown ? `showing ${shown} of ${total}` : `${total} ${total === 1 ? 'item' : 'items'}`
  ctx.fillText(`Shelf ${pageIndex + 1} of ${pageCount}  ·  ${scope}`, PAD, 116)

  ctx.textAlign = 'right'
  ctx.font = 'bold 34px sans-serif'
  ctx.fillStyle = GOLD
  ctx.fillText(points, W - PAD, 76)
  drawSpark(ctx, W - PAD - pointsW - 17, 64, 11, GOLD)
  ctx.font = '12px sans-serif'
  ctx.fillStyle = TEXT_DIM
  ctx.fillText('SEASON POINTS', W - PAD, 100)

  ctx.beginPath()
  ctx.moveTo(PAD, HEADER_H - 12)
  ctx.lineTo(W - PAD, HEADER_H - 12)
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.restore()
}
/**
 * A small pill: text on a translucent field with a 1px border. Used for the
 * ownership state and the rarity word. Returns its own width so the caller can
 * lay several out left-to-right without measuring twice.
 */
function drawChip(ctx, x, y, label, color, { align = 'left' } = {}) {
  ctx.save()
  ctx.font = 'bold 12px sans-serif'
  const w = ctx.measureText(label).width + 22
  const h = 24
  const left = align === 'right' ? x - w : x
  roundedRect(ctx, left, y, w, h, 12)
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.fill()
  ctx.strokeStyle = `${color}88`
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, left + w / 2, y + h / 2 + 0.5)
  ctx.restore()
  return w
}

/** The rarity-tinted thumbnail tile at the head of a row. */
function drawThumb(ctx, x, y, size, art, info, pal) {
  ctx.save()
  roundedRect(ctx, x, y, size, size, 14)
  ctx.save()
  ctx.clip()
  const tile = ctx.createLinearGradient(x, y, x, y + size)
  tile.addColorStop(0, `${pal.base}2e`)
  tile.addColorStop(1, 'rgba(255,255,255,0.03)')
  ctx.fillStyle = tile
  ctx.fillRect(x, y, size, size)
  if (art) drawContain(ctx, art, x + 8, y + 8, size - 16, size - 16)
  else drawEmblem(ctx, x + 4, y + 4, size - 8, size - 8, info)
  ctx.restore()
  ctx.strokeStyle = `${pal.base}77`
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.restore()
}

/**
 * One shelf row.
 *
 * Layout is columnar and measured right-to-left: the price block claims its
 * width first, the state chip sits above it, and the name column gets whatever
 * is left. That ordering is the whole point of the rewrite — in the old grid
 * the name was drawn first at a guessed width and the price was drawn on top
 * of whatever it hit.
 */
function drawRow(ctx, x, y, w, entry, art, state) {
  const info = describeSeasonEntry(entry)
  const pal = rarityPalette(info.rarity)
  const owned = !!state?.owned
  const soldOut = !!state?.soldOut && !owned
  const dimmed = owned || soldOut

  ctx.save()

  roundedRect(ctx, x, y, w, ROW_H, 16)
  ctx.fillStyle = PANEL
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'
  ctx.lineWidth = 1
  ctx.stroke()

  // Rarity edge — a 4px bar down the left, clipped to the row's own radius so
  // it follows the corner instead of sticking out of it.
  ctx.save()
  roundedRect(ctx, x, y, w, ROW_H, 16)
  ctx.clip()
  ctx.fillStyle = pal.base
  ctx.fillRect(x, y, 4, ROW_H)
  ctx.restore()

  const thumb = ROW_H - 20
  const thumbX = x + 18
  drawThumb(ctx, thumbX, y + 10, thumb, art, info, pal)

  // ── right column: price, measured first ────────────────────────────────
  const affordable = state?.affordable !== false
  const priceColor = dimmed ? TEXT_DIM : affordable ? GOLD : NO
  const priceText = Number(entry.price ?? 0).toLocaleString('en-US')
  ctx.font = 'bold 27px sans-serif'
  const priceW = ctx.measureText(priceText).width
  const priceRight = x + w - 22
  const priceBlockW = priceW + 30

  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = priceColor
  ctx.fillText(priceText, priceRight, y + 66)
  drawSpark(ctx, priceRight - priceW - 14, y + 57, 9, priceColor)

  ctx.font = '11px sans-serif'
  ctx.fillStyle = TEXT_DIM
  ctx.fillText('SEASON POINTS', priceRight, y + 84)
  const labelW = ctx.measureText('SEASON POINTS').width
  const rightW = Math.max(priceBlockW, labelW) + 18

  // ── state chip, top-right, above the price ─────────────────────────────
  let chipW = 0
  if (owned) chipW = drawChip(ctx, priceRight + 2, y + 14, 'OWNED', OK, { align: 'right' })
  else if (soldOut) chipW = drawChip(ctx, priceRight + 2, y + 14, 'SOLD OUT', NO, { align: 'right' })
  else if (state?.left != null) chipW = drawChip(ctx, priceRight + 2, y + 14, `${state.left} LEFT`, pal.base, { align: 'right' })
  else if (!affordable) chipW = drawChip(ctx, priceRight + 2, y + 14, 'CANT AFFORD', NO, { align: 'right' })

  // ── name column: whatever the two columns above left behind ────────────
  const textX = thumbX + thumb + 18
  const nameMax = x + w - Math.max(rightW, chipW + 24) - textX - 14

  ctx.textAlign = 'left'
  ctx.font = 'bold 26px sans-serif'
  ctx.fillStyle = dimmed ? TEXT_DIM : TEXT
  ctx.fillText(truncate(ctx, info.name, nameMax), textX, y + 44)

  // Kind, then rarity stars trailing it — both measured, never overlapping.
  ctx.font = '13px sans-serif'
  ctx.fillStyle = TEXT_DIM
  const kindText = String(info.kind ?? '').toUpperCase()
  ctx.fillText(kindText, textX, y + 70)
  const kindW = ctx.measureText(kindText).width
  if (pal.stars) {
    drawStars(ctx, textX + kindW + (kindW ? 14 : 0), y + 60, 5, pal.stars, 6, pal.base)
  }

  // The buy id, so the caption and the picture agree on what to type.
  ctx.font = '12px sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.34)'
  ctx.fillText(truncate(ctx, String(entry.id ?? ''), nameMax), textX, y + 90)

  if (owned) {
    // Wash an owned row back so the ones still worth buying read first.
    roundedRect(ctx, x, y, w, ROW_H, 16)
    ctx.fillStyle = 'rgba(7,7,10,0.40)'
    ctx.fill()
    drawCheck(ctx, thumbX + thumb - 6, y + 10 + thumb - 6, 13)
  }

  ctx.restore()
}

/** Shown when a shelf is genuinely empty — never as grid filler. */
function drawEmptyShelf(ctx, x, y, w, h) {
  ctx.save()
  roundedRect(ctx, x, y, w, h, 16)
  ctx.fillStyle = 'rgba(255,255,255,0.02)'
  ctx.fill()
  ctx.setLineDash([7, 7])
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.setLineDash([])
  ctx.font = '16px sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.28)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('This shelf is empty', x + w / 2, y + h / 2)
  ctx.restore()
}

function drawFooter(ctx, H, { pageIndex, pageCount, prefix, more }) {
  const y = H - FOOTER_H
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(PAD, y)
  ctx.lineTo(W - PAD, y)
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.font = '15px sans-serif'
  ctx.fillStyle = TEXT_DIM
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(`${prefix}season shop buy <id>`, PAD, y + 38)

  // Pips, right-aligned. Capped: a season with 20 shelves would otherwise draw
  // a row of dots straight through the text on the left.
  const shown = Math.min(pageCount, 12)
  const gap = 16
  const pipsRight = W - PAD
  const startX = pipsRight - (shown - 1) * gap
  for (let i = 0; i < shown; i++) {
    ctx.beginPath()
    ctx.arc(startX + i * gap, y + 32, i === pageIndex ? 5.5 : 4, 0, Math.PI * 2)
    ctx.fillStyle = i === pageIndex ? GOLD : 'rgba(255,255,255,0.22)'
    ctx.fill()
  }

  if (more > 0) {
    ctx.textAlign = 'center'
    ctx.font = '13px sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.40)'
    ctx.fillText(`+${more} more below — see the caption`, W / 2, y + 38)
  }
  ctx.restore()
}

export async function renderSeasonShopPage({
  season, page, pageIndex = 0, pageCount = 1, player = null, entryState = null, prefix = '.',
} = {}) {
  const all = page?.entries ?? []
  const entries = all.slice(0, MAX_ROWS)

  // Every artwork at once; any that fails is null and that row falls back to a
  // drawn emblem. A dead image host must never fail the render.
  const arts = await Promise.all(entries.map((e) => tryFetch(describeSeasonEntry(e).image)))

  // Height follows the content: a 3-item shelf is a short image, not a tall
  // one padded with placeholders.
  const rowCount = Math.max(entries.length, 1)
  const bodyH = rowCount * ROW_H + (rowCount - 1) * ROW_GAP
  const H = HEADER_H + GRID_GAP + bodyH + GRID_GAP + FOOTER_H

  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')

  drawBackdrop(ctx, H)
  drawHeader(ctx, {
    season, page, pageIndex, pageCount, player,
    shown: entries.length, total: all.length,
  })

  const rowW = W - PAD * 2
  const top = HEADER_H + GRID_GAP

  if (!entries.length) {
    drawEmptyShelf(ctx, PAD, top, rowW, bodyH)
  } else {
    entries.forEach((entry, i) => {
      const state = entryState
        ? (typeof entryState.get === 'function' ? entryState.get(entry.id) : entryState[entry.id])
        : null
      drawRow(ctx, PAD, top + i * (ROW_H + ROW_GAP), rowW, entry, arts[i], state)
    })
  }

  drawFooter(ctx, H, {
    pageIndex, pageCount, prefix,
    more: Math.max(0, all.length - entries.length),
  })
  return canvas.toBuffer('image/png')
}
