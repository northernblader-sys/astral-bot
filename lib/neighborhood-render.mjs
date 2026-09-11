/**
 * lib/neighborhood-render.mjs
 * Draws the street: every claimed home, ranked by comfort, as one row each.
 *
 *   export async function renderNeighborhood(opts) → Buffer (PNG)
 *
 * opts: {
 *   houses,   // [{ name, tier, comfort, rooms, decor, plots, ready, isYou }]
 *   viewer,   // display name, used in the footer
 *   prefix,   // command prefix for the footer hint
 * }
 *
 * Every house is drawn as vector geometry rather than fetched art, for two
 * reasons: there is no per-tier artwork to fetch, and a street is the one
 * render where a missing image would leave an obvious hole in the middle of
 * the row. Roof pitch, body width and window count all key off the tier rank,
 * so a tent and an estate are distinguishable at a glance without a label.
 *
 * NO EMOJI IS EVER DRAWN here — same reason as the rest of lib/*-render.mjs:
 * a headless VPS has no emoji font and paints tofu. See the header of
 * season-render-common.mjs.
 */
import {
  createCanvas, roundedRect, linearFill, truncate, drawStar, drawSpark,
  GOLD, GOLD_DIM, INK, PANEL, PANEL_HI, TEXT, TEXT_DIM,
} from './season-render-common.mjs'

const PAD = 26
const HEADER_H = 120
const ROW_H = 96
const ROW_GAP = 10
const FOOTER_H = 58
const W = 900
const HOUSE_W = 132          // the drawing column on the left of each row
const RANK_W = 62

/** Tier tint — earthier as the house gets grander. */
const TIER_TINT = {
  tent:    { wall: '#4a4438', roof: '#6b5f4a', accent: '#8a7a5c' },
  cottage: { wall: '#57503f', roof: '#7d5a44', accent: '#a8845c' },
  manor:   { wall: '#5d5342', roof: '#6d4436', accent: '#c39a63' },
  estate:  { wall: '#5a5468', roof: '#3f3a52', accent: '#d4af37' },
}

const tintFor = id => TIER_TINT[id] ?? TIER_TINT.tent

/**
 * One house, drawn to fit a box. `rank` decides the silhouette:
 * 0 is a canvas lean-to, 3 gets a second storey and a gate.
 */
function drawHouse(ctx, x, y, w, h, { rank = 0, tierId = 'tent' } = {}) {
  const tint = tintFor(tierId)
  const groundY = y + h - 8

  // ground line
  ctx.strokeStyle = 'rgba(212,175,55,0.20)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x + 4, groundY)
  ctx.lineTo(x + w - 4, groundY)
  ctx.stroke()

  if (rank <= 0) {
    // Tent: two canvas panels and a pole. No walls to speak of.
    const cx = x + w / 2
    const baseW = w * 0.62
    const topY = y + h * 0.24
    ctx.fillStyle = tint.roof
    ctx.beginPath()
    ctx.moveTo(cx, topY)
    ctx.lineTo(cx - baseW / 2, groundY)
    ctx.lineTo(cx + baseW / 2, groundY)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.moveTo(cx, topY)
    ctx.lineTo(cx, groundY)
    ctx.lineTo(cx + baseW / 2, groundY)
    ctx.closePath()
    ctx.fill()
    // door flap
    ctx.fillStyle = INK
    ctx.beginPath()
    ctx.moveTo(cx, topY + h * 0.18)
    ctx.lineTo(cx - baseW * 0.16, groundY)
    ctx.lineTo(cx + baseW * 0.16, groundY)
    ctx.closePath()
    ctx.fill()
    return
  }

  const storeys = rank >= 2 ? 2 : 1
  const bodyW = w * (rank >= 3 ? 0.80 : rank >= 2 ? 0.72 : 0.62)
  const bodyH = h * (storeys === 2 ? 0.52 : 0.40)
  const bx = x + (w - bodyW) / 2
  const by = groundY - bodyH
  const roofH = h * (rank >= 3 ? 0.30 : 0.26)

  // walls
  ctx.fillStyle = tint.wall
  ctx.fillRect(bx, by, bodyW, bodyH)
  ctx.fillStyle = 'rgba(0,0,0,0.22)'
  ctx.fillRect(bx + bodyW * 0.62, by, bodyW * 0.38, bodyH)

  // roof
  ctx.fillStyle = tint.roof
  ctx.beginPath()
  ctx.moveTo(bx - w * 0.06, by)
  ctx.lineTo(x + w / 2, by - roofH)
  ctx.lineTo(bx + bodyW + w * 0.06, by)
  ctx.closePath()
  ctx.fill()

  // windows — one per storey per side, lit
  const winW = bodyW * 0.16
  const winH = bodyH / (storeys + 1) * 0.52
  ctx.fillStyle = tint.accent
  for (let s = 0; s < storeys; s++) {
    const wy = by + bodyH * (s === 0 ? 0.14 : 0.56)
    ctx.fillRect(bx + bodyW * 0.14, wy, winW, winH)
    ctx.fillRect(bx + bodyW * 0.70, wy, winW, winH)
  }

  // door
  const doorW = bodyW * 0.20
  const doorH = bodyH * (storeys === 2 ? 0.34 : 0.44)
  ctx.fillStyle = INK
  ctx.fillRect(x + w / 2 - doorW / 2, groundY - doorH, doorW, doorH)
  ctx.fillStyle = GOLD_DIM
  ctx.fillRect(x + w / 2 + doorW * 0.22, groundY - doorH * 0.6, 2, 2)

  // chimney from cottage up
  ctx.fillStyle = tint.roof
  ctx.fillRect(bx + bodyW * 0.74, by - roofH * 0.72, w * 0.045, roofH * 0.6)

  // estate: iron gate posts either side
  if (rank >= 3) {
    ctx.strokeStyle = GOLD_DIM
    ctx.lineWidth = 2
    for (const gx of [x + 6, x + w - 6]) {
      ctx.beginPath()
      ctx.moveTo(gx, groundY)
      ctx.lineTo(gx, groundY - h * 0.26)
      ctx.stroke()
    }
  }
}

function drawHeader(ctx, count, prefix) {
  // linearFill returns the gradient rather than painting — assign it.
  ctx.fillStyle = linearFill(ctx, 0, 0, W, HEADER_H, [
    [0, '#16131c'], [1, INK],
  ])
  ctx.fillRect(0, 0, W, HEADER_H)

  ctx.strokeStyle = GOLD_DIM
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, HEADER_H - 0.5)
  ctx.lineTo(W, HEADER_H - 0.5)
  ctx.stroke()

  ctx.fillStyle = GOLD
  ctx.font = 'bold 40px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('THE NEIGHBOURHOOD', PAD, 58)

  ctx.fillStyle = TEXT_DIM
  ctx.font = '16px sans-serif'
  ctx.fillText(`${count} home${count === 1 ? '' : 's'} on the street, ranked by comfort`, PAD, 86)

  ctx.textAlign = 'right'
  ctx.fillStyle = TEXT_DIM
  ctx.font = '14px sans-serif'
  ctx.fillText(`${prefix}homedecor to climb`, W - PAD, 86)
  ctx.textAlign = 'left'
}

function drawRow(ctx, house, index, y) {
  const highlight = Boolean(house.isYou)
  roundedRect(ctx, PAD, y, W - PAD * 2, ROW_H, 12)
  ctx.fillStyle = highlight ? PANEL_HI : PANEL
  ctx.fill()
  if (highlight) {
    ctx.strokeStyle = GOLD
    ctx.lineWidth = 2
    ctx.stroke()
  }

  // rank
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = index < 3 ? GOLD : TEXT_DIM
  ctx.font = `bold ${index < 3 ? 30 : 24}px sans-serif`
  ctx.fillText(String(index + 1), PAD + RANK_W / 2, y + ROW_H / 2)
  if (index < 3) {
    drawStar(ctx, PAD + RANK_W / 2, y + ROW_H - 18, 6, 2.6)
    ctx.fillStyle = GOLD
    ctx.fill()
  }

  drawHouse(ctx, PAD + RANK_W, y + 6, HOUSE_W, ROW_H - 12, {
    rank: house.rank ?? 0,
    tierId: house.tier,
  })

  const tx = PAD + RANK_W + HOUSE_W + 16
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  ctx.fillStyle = highlight ? GOLD : TEXT
  ctx.font = 'bold 24px sans-serif'
  const nameMax = 300
  ctx.fillText(truncate(ctx, String(house.name ?? 'Unknown'), nameMax), tx, y + 36)

  ctx.fillStyle = TEXT_DIM
  ctx.font = '15px sans-serif'
  ctx.fillText(String(house.tierName ?? ''), tx, y + 62)

  ctx.font = '14px sans-serif'
  ctx.fillStyle = TEXT_DIM
  const stats = `Rooms ${house.rooms}   Decor ${house.decor}   Plots ${house.plots}`
    + (house.ready ? `   Ripe ${house.ready}` : '')
  ctx.fillText(stats, tx, y + 84)

  // comfort, right-aligned with a spark
  const rx = W - PAD - 22
  drawSpark(ctx, rx, y + ROW_H / 2 - 12, 9, GOLD)
  ctx.textAlign = 'right'
  ctx.fillStyle = GOLD
  ctx.font = 'bold 30px sans-serif'
  ctx.fillText(String(house.comfort ?? 0), rx - 20, y + ROW_H / 2 + 2)
  ctx.fillStyle = TEXT_DIM
  ctx.font = '12px sans-serif'
  ctx.fillText('COMFORT', rx - 20, y + ROW_H / 2 + 22)
  ctx.textAlign = 'left'
}

export async function renderNeighborhood({ houses = [], viewer = '', prefix = '.' } = {}) {
  const rows = houses.slice(0, 12)
  const H = HEADER_H + rows.length * (ROW_H + ROW_GAP) + FOOTER_H

  const canvas = createCanvas(W, Math.max(HEADER_H + FOOTER_H + ROW_H, H))
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = INK
  ctx.fillRect(0, 0, W, canvas.height)

  drawHeader(ctx, houses.length, prefix)

  let y = HEADER_H + 16
  if (!rows.length) {
    ctx.fillStyle = TEXT_DIM
    ctx.font = '18px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('Nobody has claimed a home yet.', W / 2, y + 40)
    ctx.textAlign = 'left'
  }
  for (let i = 0; i < rows.length; i++) {
    drawRow(ctx, rows[i], i, y)
    y += ROW_H + ROW_GAP
  }

  const fy = canvas.height - FOOTER_H / 2
  ctx.strokeStyle = 'rgba(212,175,55,0.18)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, canvas.height - FOOTER_H)
  ctx.lineTo(W - PAD, canvas.height - FOOTER_H)
  ctx.stroke()

  ctx.fillStyle = TEXT_DIM
  ctx.font = '14px sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(viewer ? `Viewing as ${viewer}` : 'Astral Town', PAD, fy)
  ctx.textAlign = 'right'
  ctx.fillText(`${prefix}homevisit to look inside`, W - PAD, fy)
  ctx.textAlign = 'left'

  return canvas.encode('png')
}
