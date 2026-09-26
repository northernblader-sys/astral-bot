/**
 * lib/empire-map-render.mjs
 * Draws one empire's territory: 8 compass regions arranged around a centre,
 * each holding up to REGION_CAP (see lib/empire-engine.js) buildings, each
 * building marked with a small hand-drawn location pin.
 *
 *   export async function renderEmpireMap(opts) → Buffer (PNG)
 *
 * opts: {
 *   empireName, tierName, citizenCount,
 *   regions: [{ id, name, angle, cap, buildings: [{ type, name, level }] }],
 *   prefix,   // command prefix for the footer hint
 * }
 *
 * `angle` is a screen-space degree (0 = east/right, -90 = north/up, matching
 * data/empire.json's regions.list) so region anchors are placed with plain
 * cos/sin — no separate compass→screen conversion needed.
 *
 * PALETTE IS INTENTIONALLY ITS OWN THING. Every other lib/*-render.mjs shares
 * season-render-common.mjs's gold-on-black palette, but a territory map reads
 * as parchment, not a UI panel — so this file only borrows the structural
 * helpers (createCanvas, roundedRect, truncate) and defines its own browns
 * and inks below rather than importing GOLD/INK/PANEL.
 *
 * NO EMOJI IS EVER DRAWN here — same reason as the rest of lib/*-render.mjs:
 * a headless VPS has no emoji font and paints tofu. See the header of
 * season-render-common.mjs. There is also no location-pin SVG asset in the
 * repo, so the pin is hand-drawn vector geometry right here rather than a
 * fetched or embedded external file.
 */
import './fonts.js' // registers bundled fonts before any canvas draw — see lib/fonts.js
import { createCanvas, roundedRect, truncate } from './season-render-common.mjs'

// ── Parchment palette ───────────────────────────────────────────────────────
const PARCH_LIGHT = '#f1e3bd'
const PARCH_MID   = '#e2cd97'
const PARCH_DARK  = '#c9ac6e'
const INK        = '#4a3419'
const INK_DIM    = '#8a6f47'
const INK_FAINT  = 'rgba(74,52,25,0.28)'
const SEAL_RED   = '#8c3b2e'
const PIN_FILL   = '#7a3b2b'
const PIN_FILL_EMPTY = '#b79a63'

const W = 980
const H = 1040
const PAD = 36
const CX = W / 2
const CY = 566
const RING_R = 235
const ZONE_R = 85

function deg2rad(d) { return (d * Math.PI) / 180 }

/** Flat gradient wash + soft vignette, so the map reads as one aged sheet. */
function paintParchment(ctx) {
  const g = ctx.createLinearGradient(0, 0, W, H)
  g.addColorStop(0, PARCH_LIGHT)
  g.addColorStop(0.55, PARCH_MID)
  g.addColorStop(1, PARCH_DARK)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)

  const vg = ctx.createRadialGradient(CX, H * 0.5, H * 0.18, CX, H * 0.5, H * 0.78)
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(1, 'rgba(60,42,18,0.32)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, W, H)

  // A handful of fixed, faint age-blotches — deterministic (no RNG) so the
  // same empire renders the same map twice, only the data changes it.
  const blots = [
    [120, 140, 90], [800, 200, 70], [140, 820, 100],
    [830, 860, 80], [470, 60, 60], [60, 500, 65],
  ]
  for (const [bx, by, br] of blots) {
    const bg = ctx.createRadialGradient(bx, by, 0, bx, by, br)
    bg.addColorStop(0, 'rgba(120,90,40,0.10)')
    bg.addColorStop(1, 'rgba(120,90,40,0)')
    ctx.fillStyle = bg
    ctx.beginPath()
    ctx.arc(bx, by, br, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** Double-rule ink border, the classic old-map frame. */
function drawFrame(ctx) {
  ctx.strokeStyle = INK
  ctx.lineWidth = 3
  ctx.strokeRect(PAD, PAD, W - PAD * 2, H - PAD * 2)
  ctx.lineWidth = 1
  ctx.strokeStyle = INK_DIM
  ctx.strokeRect(PAD + 8, PAD + 8, W - (PAD + 8) * 2, H - (PAD + 8) * 2)
}

function drawHeader(ctx, empireName, tierName, citizenCount) {
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'center'
  ctx.fillStyle = INK
  ctx.font = 'bold 40px serif'
  ctx.fillText(truncate(ctx, String(empireName || 'Unnamed Empire').toUpperCase(), W - PAD * 4), CX, PAD + 62)

  ctx.font = 'italic 18px serif'
  ctx.fillStyle = INK_DIM
  ctx.fillText(`${tierName || ''} · Territory Map`, CX, PAD + 90)

  ctx.strokeStyle = INK_FAINT
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD + 60, PAD + 110)
  ctx.lineTo(W - PAD - 60, PAD + 110)
  ctx.stroke()

  ctx.textAlign = 'left'
  ctx.font = 'bold 16px serif'
  ctx.fillStyle = INK
  ctx.fillText(`Citizens: ${Number(citizenCount ?? 0).toLocaleString()}`, PAD + 24, PAD + 138)
  ctx.textAlign = 'left'
}

/** Small N/E/S/W rose, tucked in the top-right corner for orientation. */
function drawCompassRose(ctx, cx, cy, r) {
  ctx.save()
  ctx.strokeStyle = INK_DIM
  ctx.fillStyle = INK
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()

  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i
    const long = i % 2 === 0
    const rr = long ? r : r * 0.6
    const x = cx + Math.cos(a) * rr
    const y = cy + Math.sin(a) * rr
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(x, y)
    ctx.strokeStyle = long ? INK : INK_FAINT
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.arc(cx, cy, 3.5, 0, Math.PI * 2)
  ctx.fillStyle = SEAL_RED
  ctx.fill()

  ctx.font = 'bold 13px serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = INK
  ctx.fillText('N', cx, cy - r - 12)
  ctx.fillText('S', cx, cy + r + 12)
  ctx.fillText('E', cx + r + 12, cy)
  ctx.fillText('W', cx - r - 12, cy)
  ctx.restore()
}

/**
 * A soft, slightly-wobbled territory outline around one region's anchor —
 * fixed per-index offsets rather than RNG, so it reads as hand-drawn without
 * the map changing shape between calls.
 */
const WOBBLE = [1.00, 0.90, 1.08, 0.94, 1.05, 0.88, 1.02, 0.96, 1.10, 0.92, 1.04, 0.90]
function drawZone(ctx, x, y, r, hasBuildings) {
  ctx.beginPath()
  const steps = WOBBLE.length
  for (let i = 0; i <= steps; i++) {
    const a = (Math.PI * 2 * i) / steps
    const rr = r * WOBBLE[i % steps]
    const px = x + Math.cos(a) * rr
    const py = y + Math.sin(a) * rr
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fillStyle = hasBuildings ? 'rgba(122,59,43,0.10)' : 'rgba(138,111,71,0.06)'
  ctx.fill()
  ctx.setLineDash([5, 5])
  ctx.strokeStyle = hasBuildings ? INK_DIM : INK_FAINT
  ctx.lineWidth = 1.4
  ctx.stroke()
  ctx.setLineDash([])
}

/** Hand-drawn map-pin: a circular head tapering to a point, classic marker shape. */
function drawPin(ctx, x, headY, r, fill) {
  const tipY = headY + r * 2.15
  ctx.beginPath()
  ctx.arc(x, headY, r, Math.PI, 0, false)
  ctx.bezierCurveTo(x + r, headY + r * 0.85, x + r * 0.32, headY + r * 1.55, x, tipY)
  ctx.bezierCurveTo(x - r * 0.32, headY + r * 1.55, x - r, headY + r * 0.85, x - r, headY)
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  ctx.lineWidth = 1.2
  ctx.strokeStyle = INK
  ctx.stroke()
  // the little hole near the top that makes it read as a "pin" and not a balloon
  ctx.beginPath()
  ctx.arc(x, headY, r * 0.34, 0, Math.PI * 2)
  ctx.fillStyle = PARCH_LIGHT
  ctx.fill()
  ctx.lineWidth = 0.8
  ctx.stroke()
}

/** Up to REGION_CAP slot offsets around a zone's centre, arranged so their
 *  labels don't collide: one up top, two spread wide along the bottom. */
const SLOT_OFFSETS = [
  [0, -30], [-46, 18], [46, 18],
]

function drawRegion(ctx, region) {
  const rad = deg2rad(region.angle ?? 0)
  const x = CX + Math.cos(rad) * RING_R
  const y = CY + Math.sin(rad) * RING_R
  const buildings = region.buildings ?? []
  const cap = region.cap ?? buildings.length

  drawZone(ctx, x, y, ZONE_R, buildings.length > 0)

  // road from the capital seal out to this region
  ctx.beginPath()
  ctx.moveTo(CX, CY)
  ctx.lineTo(x, y)
  ctx.strokeStyle = INK_FAINT
  ctx.lineWidth = 1
  ctx.setLineDash([2, 6])
  ctx.stroke()
  ctx.setLineDash([])

  // label: pushed further out from centre than the zone, so it never
  // collides with pins sitting inside the zone
  const dx = Math.cos(rad)
  const dy = Math.sin(rad)
  const lx = x + dx * (ZONE_R + 6)
  const ly = y + dy * (ZONE_R + 6) + (dy > 0.5 ? 18 : dy < -0.5 ? -6 : 4)
  ctx.textAlign = dx > 0.3 ? 'left' : dx < -0.3 ? 'right' : 'center'
  ctx.font = 'bold 17px serif'
  ctx.fillStyle = INK
  ctx.fillText(region.name ?? region.id, lx, ly)
  ctx.font = '12px serif'
  ctx.fillStyle = INK_DIM
  ctx.fillText(`${buildings.length}/${cap}`, lx, ly + 16)
  ctx.textAlign = 'left'

  if (!buildings.length) return

  const shown = buildings.slice(0, SLOT_OFFSETS.length)
  for (let i = 0; i < shown.length; i++) {
    const b = shown[i]
    const [ox, oy] = SLOT_OFFSETS[i]
    const px = x + ox
    const py = y + oy
    const pinR = 11
    const headY = py - pinR
    drawPin(ctx, px, headY, pinR, PIN_FILL)
    const tipY = headY + pinR * 2.15

    ctx.font = '10px serif'
    ctx.fillStyle = INK
    ctx.textAlign = 'center'
    const label = truncate(ctx, `${b.name ?? b.type}${b.level ? ` Lv${b.level}` : ''}`, 76)
    ctx.fillText(label, px, tipY + 13)
    ctx.textAlign = 'left'
  }
}

/** The empire's seat, marked at the centre where every region's road meets. */
function drawCapital(ctx, empireName) {
  ctx.beginPath()
  ctx.arc(CX, CY, 16, 0, Math.PI * 2)
  ctx.fillStyle = SEAL_RED
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = INK
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(CX, CY, 6, 0, Math.PI * 2)
  ctx.fillStyle = PARCH_LIGHT
  ctx.fill()

  ctx.font = 'italic 12px serif'
  ctx.fillStyle = INK_DIM
  ctx.textAlign = 'center'
  ctx.fillText(truncate(ctx, empireName || 'the seat', 160), CX, CY + 34)
  ctx.textAlign = 'left'
}

function drawFooter(ctx, prefix) {
  const fy = H - PAD - 22
  ctx.strokeStyle = INK_FAINT
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD + 24, fy - 16)
  ctx.lineTo(W - PAD - 24, fy - 16)
  ctx.stroke()

  ctx.font = '13px serif'
  ctx.fillStyle = INK_DIM
  ctx.textAlign = 'left'
  ctx.fillText(`${prefix}empire build <type> <region> — raise something new`, PAD + 24, fy)
  ctx.textAlign = 'right'
  ctx.fillText(`${prefix}empire build list — see everything unlocked`, W - PAD - 24, fy)
  ctx.textAlign = 'left'
}

export async function renderEmpireMap({
  empireName = '', tierName = '', citizenCount = 0, regions = [], prefix = '.',
} = {}) {
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')

  paintParchment(ctx)
  drawFrame(ctx)
  drawHeader(ctx, empireName, tierName, citizenCount)
  drawCompassRose(ctx, W - PAD - 74, PAD + 74, 42)

  for (const region of regions) drawRegion(ctx, region)
  drawCapital(ctx, empireName)
  drawFooter(ctx, prefix)

  return canvas.encode('png')
}
