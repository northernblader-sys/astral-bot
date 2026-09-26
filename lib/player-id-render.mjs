/**
 * lib/player-id-render.mjs
 * Renders an "Astral ID" card that matches the Student ID reference layout:
 *   - White card, thick rounded border
 *   - Left panel: sepia photo + barcode
 *   - Vertical dashed separator
 *   - Right panel: "Astral ID" title with swoosh arc + sparkle stars,
 *     horizontal dashed rule, then 2-column field grid
 *
 * Color customization via player.idColors:
 *   { accent: '#111111', border: '#111111' }
 *   accent → title text, swoosh stroke, sparkle stars
 *   border → card border, photo frame
 *
 * export async function renderPlayerIdCard(player, rank) → Buffer (PNG)
 */
import './fonts.js' // registers bundled fonts before any canvas draw — see lib/fonts.js
import { createCanvas, loadImage } from '@napi-rs/canvas'

const W = 700, H = 290, RADIUS = 18

// ── Helpers ────────────────────────────────────────────────────────────────

async function tryLoadUrl(url) {
  if (!url || !url.startsWith('http')) return null
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    return await loadImage(Buffer.from(await res.arrayBuffer()))
  } catch { return null }
}

function drawCover(ctx, img, x, y, w, h) {
  const s  = Math.max(w / img.width, h / img.height)
  const dw = img.width * s, dh = img.height * s
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

function cardPath(ctx) {
  ctx.beginPath()
  ctx.moveTo(RADIUS, 0)
  ctx.arcTo(W, 0,   W, H, RADIUS)
  ctx.arcTo(W, H,   0, H, RADIUS)
  ctx.arcTo(0, H,   0, 0, RADIUS)
  ctx.arcTo(0, 0,   W, 0, RADIUS)
  ctx.closePath()
}

/** 4-pointed star sparkle centred at (x, y). */
function drawSparkle(ctx, x, y, size, color) {
  ctx.save()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x,          y - size)
  ctx.quadraticCurveTo(x + size * 0.14, y - size * 0.14, x + size, y)
  ctx.quadraticCurveTo(x + size * 0.14, y + size * 0.14, x,        y + size)
  ctx.quadraticCurveTo(x - size * 0.14, y + size * 0.14, x - size, y)
  ctx.quadraticCurveTo(x - size * 0.14, y - size * 0.14, x,        y - size)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** Deterministic barcode — stable render, no random variance. */
function drawBarcode(ctx, x, y, w, h) {
  const segs = [3,1,2,1,3,2,1,3,1,2,3,1,2,1,3,1,2,1,3,2,1,3,1,2,1,3,2,1,3,1,2,1,3,1,2,1,3,2,1,3]
  let px = x, on = true
  for (const seg of segs) {
    const bw = Math.round(w * seg / 44)
    if (on) { ctx.fillStyle = '#000000'; ctx.fillRect(px, y, bw, h) }
    px += bw; on = !on
    if (px >= x + w) break
  }
}

// ── Main render ────────────────────────────────────────────────────────────

export async function renderPlayerIdCard(player, rank) {
  // Read per-player color prefs (with safe defaults matching the reference)
  const colors = player.idColors ?? {}
  const accentColor = colors.accent ?? '#111111'
  const borderColor = colors.border ?? '#111111'

  const canvas = createCanvas(W, H)
  const ctx    = canvas.getContext('2d')

  // ── Card background ────────────────────────────────────────────────────
  cardPath(ctx)
  ctx.fillStyle = '#FFFFFF'
  ctx.fill()

  // Card border — thick, matches reference
  cardPath(ctx)
  ctx.lineWidth   = 4
  ctx.strokeStyle = borderColor
  ctx.stroke()

  // ── Photo panel (left) ─────────────────────────────────────────────────
  const PX = 18, PY = 18
  const PW = 170, PH = 210

  // Photo frame
  ctx.fillStyle = '#1A1A1A'
  ctx.fillRect(PX, PY, PW, PH)

  const photoImg = await tryLoadUrl(player.idImage ?? player.pfp ?? null)
  if (photoImg) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(PX, PY, PW, PH)
    ctx.clip()
    drawCover(ctx, photoImg, PX, PY, PW, PH)
    // Sepia overlay — matches reference's brown-tinted photo
    ctx.fillStyle = 'rgba(100, 55, 15, 0.40)'
    ctx.fillRect(PX, PY, PW, PH)
    ctx.restore()
  } else {
    // Silhouette placeholder
    ctx.fillStyle = '#3A3A3A'
    ctx.fillRect(PX + 30, PY + 15, 110, 140)
    ctx.beginPath()
    ctx.arc(PX + 85, PY + 12, 36, 0, Math.PI * 2)
    ctx.fillStyle = '#3A3A3A'; ctx.fill()
  }

  // Photo frame border
  ctx.strokeStyle = borderColor
  ctx.lineWidth   = 2
  ctx.strokeRect(PX, PY, PW, PH)

  // Barcode — sits below the photo, left-aligned
  drawBarcode(ctx, PX, PY + PH + 10, PW, 20)

  // ── Vertical dashed separator ──────────────────────────────────────────
  const SEP_X = PX + PW + 14
  ctx.setLineDash([5, 5])
  ctx.strokeStyle = '#BBBBBB'
  ctx.lineWidth   = 1
  ctx.beginPath()
  ctx.moveTo(SEP_X, 12); ctx.lineTo(SEP_X, H - 12)
  ctx.stroke()
  ctx.setLineDash([])

  // ── Right panel ─────────────────────────────────────────────────────────
  const RX = SEP_X + 14   // right content start X
  const RW = W - RX - 14  // available width

  // Swoosh arc decoration (mirrors reference: curves up-right, stars at peak)
  // Arc: starts lower-left of title area, sweeps to upper-right
  const arcStartX = RX + 40
  const arcStartY = 68
  const arcEndX   = RX + RW - 12
  const arcEndY   = 8
  const arcCPX    = RX + RW - 40
  const arcCPY    = 62

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(arcStartX, arcStartY)
  ctx.quadraticCurveTo(arcCPX, arcCPY, arcEndX, arcEndY)
  ctx.lineWidth   = 2.5
  ctx.strokeStyle = accentColor
  ctx.stroke()
  ctx.restore()

  // Two sparkle stars at the arc tip
  drawSparkle(ctx, arcEndX - 2, arcEndY + 2,  10, accentColor)
  drawSparkle(ctx, arcEndX + 8, arcEndY + 14,  6, accentColor)

  // "Astral ID" title — big, bold, serif, matching reference weight
  // "Astral" line
  ctx.font      = `bold 38px Georgia, "Times New Roman", serif`
  ctx.fillStyle = accentColor
  ctx.textAlign = 'left'
  ctx.fillText('Astral', RX, 50)
  // "ID" — same font, same size, slightly offset right to match reference spacing
  ctx.fillText('ID', RX + 128, 50)

  // Horizontal dashed rule under title
  ctx.setLineDash([7, 4])
  ctx.strokeStyle = '#BBBBBB'
  ctx.lineWidth   = 1
  ctx.beginPath()
  ctx.moveTo(RX, 62); ctx.lineTo(W - 14, 62)
  ctx.stroke()
  ctx.setLineDash([])

  // ── Field grid (2 columns × 3 rows) ─────────────────────────────────────
  const fields = [
    { label: 'NAME',         value: player.name ?? '—' },
    { label: 'USERNAME',     value: player.username ? `@${player.username}` : '—' },
    { label: 'POKÉMON',      value: String((player.pokemon ?? []).length) },
    { label: 'LEVEL',        value: String(player.level ?? 1) },
    { label: 'RANK',         value: rank?.title ?? '—' },
    { label: 'BATTLES WON',  value: String(player.battleRecord?.wins ?? 0) },
  ]

  const COL2_X = RX + Math.floor(RW / 2) + 6
  const ROW_H  = 54
  let rowY     = 80

  for (let i = 0; i < fields.length; i++) {
    const colX = i % 2 === 0 ? RX : COL2_X
    if (i % 2 === 0 && i > 0) rowY += ROW_H

    // Label — small caps style, gray
    ctx.font      = '10px sans-serif'
    ctx.fillStyle = '#888888'
    ctx.textAlign = 'left'
    ctx.fillText(fields[i].label, colX, rowY)

    // Value — bold, dark
    ctx.font = 'bold 17px sans-serif'
    ctx.fillStyle = accentColor
    let val = fields[i].value
    const maxW = Math.floor(RW / 2) - 8
    while (ctx.measureText(val).width > maxW && val.length > 2) val = val.slice(0, -1)
    if (val !== fields[i].value) val += '…'
    ctx.fillText(val, colX, rowY + 18)
  }

  return canvas.toBuffer('image/png')
}
