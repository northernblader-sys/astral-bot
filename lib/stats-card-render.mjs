/**
 * lib/stats-card-render.mjs
 * Renders the stat panel image shown by bare `.stats` (plugins/stats.js).
 *
 * This is the combat-stat sheet, visually distinct from the social profile
 * card (lib/profile-card-render.mjs): a navy HUD readout that draws the five
 * combat stats as a RADAR (spider) chart — one axis per stat, the stat name
 * and a letter grade at each vertex, and a filled polygon that pushes out
 * toward wherever the player actually put their points. That shape is the
 * whole point of the panel: a 200-STR berserker and a 200-DEF knight have the
 * same POWER and read completely differently here.
 *
 * The chart is scaled to the player's OWN peak stat, not a global cap: the
 * ring labels carry the real numbers, and the polygon is a picture of the
 * build's shape (balance), which a fixed scale would flatten to a dot for
 * every low-level player.
 *
 * Like the old sheet, NOTHING here is dynamic-height: every block is a fixed
 * size (names fit by shrinking, never wrapping), so the canvas height is
 * computed arithmetically and the render is a single pass. The only variable
 * block is the optional End-aura strip, which adds its own fixed height.
 *
 * Canvas text has no emoji font on the host (see lib/fonts.js — DejaVu only,
 * plus Orbitron/Bangers), so every label here is plain ASCII: stat rows use
 * text labels, and the End-aura line is sanitized before it is drawn.
 *
 * export async function renderStatsCard(player, opts) → Buffer (PNG)
 *
 * `player` is the whole player record, read defensively like buildView() in
 * the profile renderer. opts.prefix customizes the footer hints (defaults to
 * config.prefix); opts.endLine is the precomputed The End aura line from
 * endStatusBadge() (needs `db`, which the renderer deliberately never sees)
 * or null — when present it draws as its own strip above the footer.
 */
import './fonts.js' // registers bundled fonts before any canvas draw — see lib/fonts.js
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { config } from '../config.js'
import { getRankForLevel, getXpProgress } from './rank-engine.js'
import { classes, races } from './game-data.js'
import { ensureStatPoints, statPointCap, trainCostPerPoint } from './stat-progression.js'
import { playerLevelCap } from './reborn-engine.js'
import { getGuildTag } from './guild-repo.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PFP = join(__dir, 'assets', 'profile', 'default-pfp.png')

const W = 820
const PAD = 20

const COLORS = {
  frame:      '#1a5f79',
  cardBg:     '#081321',
  cardLine:   '#0b2233',
  panelBg:    '#0a1a2b',
  panelLine:  '#15546f',
  boxBg:      '#0c2032',
  grid:       'rgba(94,192,232,0.14)',
  gridMid:    'rgba(94,192,232,0.22)',
  gridEdge:   'rgba(120,215,255,0.42)',
  spoke:      'rgba(94,192,232,0.28)',
  cyan:       '#4fd8ff',
  textLight:  '#e8f6ff',
  textMuted:  '#8fb0c4',
  textFaint:  '#5d8299',
  fillTop:    'rgba(120,230,255,0.46)',
  fillBottom: 'rgba(56,150,205,0.16)',
  trackBg:    '#0f2f45',
  xpFill:     '#4fd8ff',
  dangerBg:   '#2a1116',
  dangerLine: '#a34e58',
  dangerText: '#f0b9bf',
}

const STAT_META = [
  { key: 'str', label: 'STR', full: 'Strength',  color: '#ff6b6f' },
  { key: 'agi', label: 'AGI', full: 'Agility',   color: '#51cf66' },
  { key: 'int', label: 'INT', full: 'Intellect', color: '#74a0ff' },
  { key: 'def', label: 'DEF', full: 'Defense',   color: '#ffc078' },
  { key: 'lck', label: 'LCK', full: 'Luck',      color: '#c792ea' },
]

// Letter grades for one axis, judged against the player's own peak stat: a
// stat that IS the peak is S, a stat the player never touched is E. The
// scale's rim is a tidy number just above the peak (see niceStep), so the
// peak always lands at >= ~75% of the rim — S's floor sits a touch below
// that so the strongest stat always grades S, while a stat more than a quarter
// behind the peak drops to A.
const GRADE_STEPS = [
  { min: 0.74, grade: 'S', color: '#ff5f8f' },
  { min: 0.58, grade: 'A', color: '#ffd84d' },
  { min: 0.44, grade: 'B', color: '#c9b6ff' },
  { min: 0.30, grade: 'C', color: '#4fd8ff' },
  { min: 0.15, grade: 'D', color: '#7f9fb3' },
  { min: 0,    grade: 'E', color: '#54707f' },
]

const GRADE_WORDS = {
  S: 'APEX BUILD', A: 'PEAK WEIGHTED', B: 'SOLID SHAPE',
  C: 'DEVELOPING', D: 'THIN SPREAD', E: 'UNALLOCATED',
}

export function gradeFor(frac) {
  // Clamp to [0, 1]: a value over the rim is still an S, garbage in is an E.
  const n = Number(frac)
  const f = !Number.isFinite(n) ? (n > 0 ? 1 : 0) : Math.min(1, Math.max(0, n))
  return GRADE_STEPS.find((s) => f >= s.min) ?? GRADE_STEPS[GRADE_STEPS.length - 1]
}

// ── Radar geometry ────────────────────────────────────────────────────────

const TAU = Math.PI * 2

/**
 * Pure radar math, kept separate from the draw pass so it can be tested and
 * so a degenerate player (no stats at all) can never produce NaN geometry.
 *
 * `ref` is the player's own peak stat rounded UP to a tidy ring number, so
 * the four rings read as round figures and the peak sits at or inside the
 * rim. Every vertex carries its own letter grade; `density` is
 * mean(frac) — how evenly the build is filled out — and grades the panel's
 * OVERALL RATING box.
 */
export function computeRadar(stats, { R = 168, cx = 0, cy = 0, rings = 4 } = {}) {
  const axes = STAT_META.map((m) => ({ ...m, value: Math.max(0, Math.round(Number(stats?.[m.key]) || 0)) }))
  const peak = axes.reduce((best, a) => (a.value > best.value ? a : best), axes[0])
  const rawRef = Math.max(peak?.value || 0, 1)
  const step = niceStep(rawRef / rings)
  const ref = step * rings

  const n = axes.length
  const points = axes.map((a, i) => {
    const angle = -Math.PI / 2 + (TAU * i) / n
    const frac = Math.max(0, a.value) / ref
    const r = frac * R
    const g = gradeFor(ref > 0 ? frac : 0)
    return {
      ...a,
      angle,
      frac,
      r,
      grade: g.grade,
      gradeColor: g.color,
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      rimX: cx + Math.cos(angle) * R,
      rimY: cy + Math.sin(angle) * R,
      // Which side of the chart the label block hangs off: the top vertex
      // centres above the rim, everything else sits out to its own side.
      labelSide: Math.abs(Math.cos(angle)) < 0.25 ? 'top' : (Math.cos(angle) >= 0 ? 'right' : 'left'),
    }
  })

  const empty = axes.every((a) => a.value === 0)
  const mean = axes.reduce((s, a) => s + a.value, 0) / (axes.length || 1)
  return {
    points,
    ref,
    step,
    rings,
    R, cx, cy,
    empty,
    peak: { key: peak?.key ?? null, label: peak?.label ?? '-', value: peak?.value ?? 0 },
    total: axes.reduce((s, a) => s + a.value, 0),
    mean,
    density: ref > 0 && !empty ? mean / ref : 0,
  }
}

/**
 * Rounds a ring interval UP to a tidy number so the four ring labels stay
 * clean — but with a dense multiplier set (1/1.2/1.5/2/2.5/3/4/5/6/8/10) so
 * the rim overshoots the peak by at most ~25%. That keeps the strongest stat
 * pinned at the edge of the chart instead of floating halfway in. The result
 * is always an integer, so ring labels never show decimals.
 */
function niceStep(raw) {
  const v = Math.max(1, Math.ceil(raw))
  const mag = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const s = mag * m
    if (s >= v) return Math.round(s)
  }
  return mag * 10
}

// ── Asset loading ─────────────────────────────────────────────────────────
// Same never-throws contract as the profile renderer: a dead pfp URL or a
// missing default file degrades to an initial disc, never a crash.

async function tryLoadLocal(path) {
  try { return await loadImage(readFileSync(path)) }
  catch { return null }
}

async function tryLoadPlayerFile(url) {
  if (!url) return null
  if (!url.startsWith('http://') && !url.startsWith('https://')) return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return await loadImage(Buffer.from(await res.arrayBuffer()))
  } catch {
    return null
  }
}

const defaultPfp = await tryLoadLocal(DEFAULT_PFP)

// ── Geometry + text helpers ───────────────────────────────────────────────

function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.lineTo(x + rr, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr, rr)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + rr, y, rr)
  ctx.closePath()
}

function fillRoundedRect(ctx, x, y, w, h, r, fillStyle) {
  roundedRectPath(ctx, x, y, w, h, r)
  ctx.fillStyle = fillStyle
  ctx.fill()
}

function strokeRoundedRect(ctx, x, y, w, h, r, style, lineWidth = 2) {
  roundedRectPath(ctx, x, y, w, h, r)
  ctx.strokeStyle = style
  ctx.lineWidth = lineWidth
  ctx.stroke()
}

/** Draws `img` filling the box, cropping to cover without distortion. */
function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

/**
 * Shrinks ctx.font from `size` (floor `min`) until `text` fits `maxWidth`.
 * Player names, rank pills and big totals all land in fixed boxes, so
 * everything goes through here rather than trusting a value to fit.
 */
function fitFont(ctx, text, maxWidth, { size, min = 12, weight = 'bold', family = 'sans-serif' } = {}) {
  let s = size
  const font = (px) => `${weight} ${px}px ${family}`.trim()
  ctx.font = font(s)
  while (s > min && ctx.measureText(text).width > maxWidth) {
    s -= 1
    ctx.font = font(s)
  }
  return s
}

function setSpacing(ctx, px) {
  try { ctx.letterSpacing = `${px}px` } catch { /* older canvas builds ignore it */ }
}

function compact(n) {
  const v = Number(n) || 0
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1).replace(/\.0$/, '')}B`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(v))
}

function handleFor(player) {
  const local = String(player?.id ?? '').split('@')[0].split(':')[0].trim()
  return local ? `@${local}` : '@unknown'
}

/**
 * The End-aura line arrives as chat markdown with emoji
 * ("⚠️ _Weakened by the End's aura (−40%)..._"). Canvas has no emoji font,
 * so strip markdown + emoji/pictographs, keeping letters, digits and common
 * punctuation (the − in −40% is U+2212, which DejaVu does cover — but the
 * ASCII hyphen reads identically, so normalize it too and stay safe).
 */
export function sanitizeCanvasLine(text, maxLen = 90) {
  let s = String(text ?? '')
    .replace(/[*_`~]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .replace(/−/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E%()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 3)}...`
  return s
}

/** HUD corner brackets — the four L ticks that sell the "readout" look. */
function drawBrackets(ctx, x, y, w, h, len, style, lw = 2) {
  ctx.save()
  ctx.strokeStyle = style
  ctx.lineWidth = lw
  ctx.beginPath()
  for (const [sx, sy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x + w, y + h, -1, -1], [x, y + h, 1, -1]]) {
    ctx.moveTo(sx + dx * len, sy)
    ctx.lineTo(sx, sy)
    ctx.lineTo(sx, sy + dy * len)
  }
  ctx.stroke()
  ctx.restore()
}

/**
 * Small squared letter-grade badge. Returns the width it consumed so the
 * caller can line the badge up against a measured value string.
 */
function drawBadge(ctx, text, x, yCenter, color, { h = 24, size = 14, pad = 8, align = 'left' } = {}) {
  ctx.font = `bold ${size}px sans-serif`
  const w = Math.max(h + 6, Math.round(ctx.measureText(text).width) + pad * 2)
  const bx = align === 'right' ? x - w : x
  fillRoundedRect(ctx, bx, yCenter - h / 2, w, h, 6, 'rgba(8,19,33,0.85)')
  strokeRoundedRect(ctx, bx, yCenter - h / 2, w, h, 6, color, 1.5)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = color
  ctx.fillText(text, bx + w / 2, yCenter + 1)
  return w
}

// ── Layout constants (everything is fixed-height) ─────────────────────────

const HEADER_H = 64
const IDENTITY_H = 118
const RINGS = 4
const RADAR_R = 168
const RADAR_SUB_H = 34
// The rim is only the drawing area: label blocks hang OUTSIDE it, so the
// panel is sized from the geometry rather than a magic number. Bottom needs
// less than top because the two lower axes sit at sin(54 deg) ~ 0.81 R.
const RADAR_LABEL_T = 72
const RADAR_LABEL_B = 78
const RADAR_FIELD_H = RADAR_R + RADAR_LABEL_T + Math.round(RADAR_R * 0.81) + RADAR_LABEL_B
const RADAR_H = RADAR_SUB_H + RADAR_FIELD_H + 10
const READOUT_H = 96
const END_H = 44
const FOOTER_H = 58
const MARGIN_X = 30

// ── Sections ──────────────────────────────────────────────────────────────

function drawHeaderBar(ctx, card, view, y) {
  const x = card.x + MARGIN_X
  const w = card.w - MARGIN_X * 2

  ctx.save()
  const grad = ctx.createLinearGradient(x, y, x + w, y)
  grad.addColorStop(0, 'rgba(79,216,255,0.20)')
  grad.addColorStop(1, 'rgba(79,216,255,0.02)')
  ctx.fillStyle = grad
  ctx.fillRect(x, y, w, HEADER_H)
  ctx.restore()

  ctx.strokeStyle = COLORS.panelLine
  ctx.lineWidth = 1.5
  ctx.strokeRect(x, y, w, HEADER_H)

  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  setSpacing(ctx, 5)
  ctx.font = `bold ${fitFont(ctx, 'PERFORMANCE GRAPH', w - 250, { size: 27, min: 16, family: 'Orbitron, sans-serif' })}px Orbitron, sans-serif`
  ctx.fillStyle = COLORS.cyan
  ctx.fillText('PERFORMANCE GRAPH', x + 20, y + HEADER_H / 2 + 1)
  setSpacing(ctx, 0)

  ctx.textAlign = 'right'
  ctx.font = 'bold 15px sans-serif'
  ctx.fillStyle = COLORS.textMuted
  ctx.fillText(view.idLine, x + w - 18, y + HEADER_H / 2 + 1)

  // A bright tick at the left edge of the bar, like a channel marker.
  ctx.fillStyle = COLORS.cyan
  ctx.fillRect(x, y, 5, HEADER_H)

  return y + HEADER_H
}

function drawIdentity(ctx, card, view, pfpImg, y0) {
  const x = card.x + MARGIN_X
  const d = 104
  const ccx = x + d / 2
  const ccy = y0 + IDENTITY_H / 2
  const hex = (rad) => {
    ctx.beginPath()
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / 3
      const px = ccx + Math.cos(a) * rad
      const py = ccy + Math.sin(a) * rad
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
  }

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = 16
  ctx.shadowOffsetY = 4
  hex(d / 2 + 4)
  ctx.fillStyle = COLORS.boxBg
  ctx.fill()
  ctx.restore()

  ctx.save()
  hex(d / 2)
  ctx.clip()
  if (pfpImg) {
    drawCover(ctx, pfpImg, ccx - d / 2, ccy - d / 2, d, d)
  } else {
    ctx.fillStyle = '#0f2c3f'
    ctx.fillRect(ccx - d / 2, ccy - d / 2, d, d)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `bold ${Math.round(d * 0.4)}px sans-serif`
    ctx.fillStyle = COLORS.cyan
    ctx.fillText(view.initial, ccx, ccy + 2)
  }
  ctx.restore()
  hex(d / 2)
  ctx.strokeStyle = COLORS.cyan
  ctx.lineWidth = 2.5
  ctx.stroke()

  const tx = x + d + 26
  const rightBlock = 250
  const maxW = card.x + card.w - MARGIN_X - rightBlock - tx - 18

  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  fitFont(ctx, view.name, maxW, { size: 32, min: 17 })
  ctx.fillStyle = COLORS.textLight
  ctx.fillText(view.name, tx, y0 + IDENTITY_H / 2 - 16)

  ctx.font = 'bold 16px sans-serif'
  ctx.fillStyle = COLORS.cyan
  ctx.fillText(view.handle, tx, y0 + IDENTITY_H / 2 + 12)

  ctx.font = '14px sans-serif'
  ctx.fillStyle = COLORS.textMuted
  ctx.fillText(view.subtitle, tx, y0 + IDENTITY_H / 2 + 36)

  // Right column: rank pill over the XP bar.
  const rx = card.x + card.w - MARGIN_X - rightBlock
  const rw = rightBlock
  ctx.textAlign = 'right'
  fitFont(ctx, view.rankLine, rw - 16, { size: 19, min: 12, family: 'Orbitron, sans-serif' })
  ctx.fillStyle = COLORS.cyan
  ctx.fillText(view.rankLine, rx + rw, y0 + IDENTITY_H / 2 - 20)

  const barW = rw
  const barH = 12
  const barY = y0 + IDENTITY_H / 2 + 2
  fillRoundedRect(ctx, rx, barY, barW, barH, 6, COLORS.trackBg)
  if (view.xpPct > 0) {
    ctx.save()
    roundedRectPath(ctx, rx, barY, barW, barH, 6)
    ctx.clip()
    ctx.fillStyle = COLORS.xpFill
    ctx.fillRect(rx, barY, barW * Math.min(1, view.xpPct), barH)
    ctx.restore()
  }
  strokeRoundedRect(ctx, rx, barY, barW, barH, 6, COLORS.panelLine, 1.5)

  ctx.font = '13px sans-serif'
  ctx.fillStyle = COLORS.textFaint
  ctx.fillText(view.xpLine, rx + rw, barY + barH + 22)

  return y0 + IDENTITY_H
}

function drawRadarPanel(ctx, card, view, y0) {
  const x = card.x + MARGIN_X
  const w = card.w - MARGIN_X * 2
  const radar = view.radar
  const cx = x + w / 2
  const cy = y0 + RADAR_SUB_H + RADAR_R + 52

  fillRoundedRect(ctx, x, y0, w, RADAR_H, 16, COLORS.panelBg)
  strokeRoundedRect(ctx, x, y0, w, RADAR_H, 16, COLORS.panelLine, 2)
  drawBrackets(ctx, x + 8, y0 + 8, w - 16, RADAR_H - 16, 16, 'rgba(79,216,255,0.55)', 2)

  // Sub-header: what the chart is, and the scale it is drawn on.
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = 'bold 13px sans-serif'
  setSpacing(ctx, 3)
  ctx.fillStyle = COLORS.textFaint
  ctx.fillText('STAT PROFILE', x + 22, y0 + RADAR_SUB_H / 2 + 2)
  setSpacing(ctx, 0)
  ctx.textAlign = 'right'
  ctx.fillStyle = COLORS.textMuted
  ctx.fillText(radar.empty ? 'NO STATS YET' : `SCALE 0 - ${radar.ref}   (PEAK: ${radar.peak.label} ${radar.peak.value})`, x + w - 22, y0 + RADAR_SUB_H / 2 + 2)
  ctx.strokeStyle = COLORS.panelLine
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x + 14, y0 + RADAR_SUB_H)
  ctx.lineTo(x + w - 14, y0 + RADAR_SUB_H)
  ctx.stroke()

  // Soft glow behind the chart so the polygon reads against the navy.
  const halo = ctx.createRadialGradient(cx, cy, 10, cx, cy, radar.R * 1.35)
  halo.addColorStop(0, 'rgba(79,216,255,0.14)')
  halo.addColorStop(1, 'rgba(79,216,255,0)')
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(cx, cy, radar.R * 1.35, 0, Math.PI * 2)
  ctx.fill()

  const n = radar.points.length
  const ringPath = (radius) => {
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (TAU * i) / n
      const px = cx + Math.cos(a) * radius
      const py = cy + Math.sin(a) * radius
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
  }

  // Concentric rings, brightest at the rim.
  for (let k = 1; k <= radar.rings; k++) {
    const radius = (radar.R * k) / radar.rings
    ringPath(radius)
    ctx.strokeStyle = k === radar.rings ? COLORS.gridEdge : (k === radar.rings - 1 ? COLORS.gridMid : COLORS.grid)
    ctx.lineWidth = k === radar.rings ? 2 : 1
    ctx.stroke()
  }

  // Spokes centre -> rim.
  ctx.strokeStyle = COLORS.spoke
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (TAU * i) / n
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(a) * radar.R, cy + Math.sin(a) * radar.R)
  }
  ctx.stroke()

  // Ring values along the top spoke, nudged clear of the rim so a peak-stat
  // vertex dot (drawn on the axis itself) never sits on top of a label.
  ctx.textAlign = 'left'
  ctx.font = '11px sans-serif'
  ctx.fillStyle = COLORS.textFaint
  for (let k = 1; k <= radar.rings; k++) {
    const radius = (radar.R * k) / radar.rings
    ctx.fillText(String(radar.step * k), cx + 12, cy - radius - 1)
  }
  ctx.fillText('0', cx + 12, cy - 1)

  if (radar.empty) {
    ctx.textAlign = 'center'
    ctx.font = 'bold 17px sans-serif'
    ctx.fillStyle = COLORS.textMuted
    ctx.fillText('NO STAT DATA - ALLOCATE WITH .stats add', cx, cy + 2)
    return y0 + RADAR_H
  }

  // The value polygon: fills toward whatever the player stacked. The view's
  // radar was probed at the origin (for grading), so the panel re-roots every
  // vertex at (cx, cy) before drawing.
  const at = (p) => [cx + p.x, cy + p.y]
  ctx.save()
  ctx.beginPath()
  radar.points.forEach((p, i) => { const [px, py] = at(p); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py) })
  ctx.closePath()
  const fill = ctx.createLinearGradient(0, cy - radar.R, 0, cy + radar.R)
  fill.addColorStop(0, COLORS.fillTop)
  fill.addColorStop(1, COLORS.fillBottom)
  ctx.fillStyle = fill
  ctx.shadowColor = 'rgba(79,216,255,0.45)'
  ctx.shadowBlur = 18
  ctx.fill()
  ctx.restore()

  ctx.beginPath()
  radar.points.forEach((p, i) => { const [px, py] = at(p); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py) })
  ctx.closePath()
  ctx.strokeStyle = COLORS.cyan
  ctx.lineWidth = 2.5
  ctx.stroke()

  // Vertex dots + the label/grade block that hangs off each rim point.
  for (const p of radar.points) {
    const [px, py] = at(p)
    ctx.beginPath()
    ctx.arc(px, py, 5, 0, Math.PI * 2)
    ctx.fillStyle = p.color
    ctx.fill()
    ctx.strokeStyle = 'rgba(8,19,33,0.9)'
    ctx.lineWidth = 2
    ctx.stroke()

    drawAxisLabel(ctx, p, cx, cy, radar.R)
  }

  // Centre pip.
  ctx.beginPath()
  ctx.arc(cx, cy, 2.5, 0, Math.PI * 2)
  ctx.fillStyle = COLORS.cyan
  ctx.fill()

  return y0 + RADAR_H
}

/**
 * Stat name + value + letter grade, anchored outside the rim on whichever
 * side of the chart the axis is on. Widths come from measureText so the grade
 * badge always sits tight against the number and nothing overlaps the rim.
 */
function drawAxisLabel(ctx, p, cx, cy, R) {
  const nameFont = 'bold 20px sans-serif'
  const fullFont = '13px sans-serif'
  const valFont = 'bold 23px sans-serif'
  const badgeW = 42

  // Measure the two candidate line widths, then lay the block out as
  //   [ STR  STRENGTH ]
  //   [ 120      [ A ] ]
  // anchored outside the rim on the axis' own side.
  ctx.font = nameFont
  const nameW = Math.round(ctx.measureText(p.label).width)
  ctx.font = fullFont
  const fullW = Math.round(ctx.measureText(p.full.toUpperCase()).width)
  ctx.font = valFont
  const valW = Math.round(ctx.measureText(p.value.toLocaleString()).width)
  const blockW = Math.max(nameW + 8 + fullW, valW + 10 + badgeW)

  const anchorX = cx + Math.cos(p.angle) * (R + 16)
  const anchorY = cy + Math.sin(p.angle) * (R + 16)
  const left = p.labelSide === 'top'
    ? cx - blockW / 2
    : (p.labelSide === 'right' ? anchorX + 12 : anchorX - 12 - blockW)
  const nameY = anchorY + (p.labelSide === 'top' ? -34 : -12)
  const valY = nameY + 28

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = nameFont
  ctx.fillStyle = p.color
  ctx.fillText(p.label, left, nameY)
  ctx.font = fullFont
  ctx.fillStyle = COLORS.textFaint
  ctx.fillText(p.full.toUpperCase(), left + nameW + 8, nameY + 1)

  ctx.font = valFont
  ctx.fillStyle = COLORS.textLight
  ctx.fillText(p.value.toLocaleString(), left, valY)
  drawBadge(ctx, p.grade, left + valW + 10, valY, p.gradeColor, { h: 25, size: 14, align: 'left' })
}

function drawReadout(ctx, card, view, y) {
  const x = card.x + MARGIN_X
  const w = card.w - MARGIN_X * 2
  const gap = 14
  const radar = view.radar
  const overall = gradeFor(radar.density)

  const wideW = 268
  const boxW = (w - wideW - gap * 3) / 3
  const boxes = [
    { value: compact(view.unallocated), label: 'UNALLOCATED', color: COLORS.textLight },
    { value: `${compact(view.earned)}/${compact(view.cap)}`, label: 'EARNED', color: COLORS.textLight },
    { value: compact(view.power), label: 'TOTAL POWER', color: COLORS.cyan },
  ]

  // Overall rating box: the one big verdict, like the reference panel's
  // "overall grade" block under the chart.
  fillRoundedRect(ctx, x, y, wideW, READOUT_H, 16, COLORS.boxBg)
  strokeRoundedRect(ctx, x, y, wideW, READOUT_H, 16, overall.color, 2)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  setSpacing(ctx, 3)
  ctx.font = 'bold 13px sans-serif'
  ctx.fillStyle = COLORS.textFaint
  ctx.fillText('OVERALL RATING', x + 20, y + 26)
  setSpacing(ctx, 0)

  ctx.font = `bold 46px ${'Orbitron, sans-serif'}`
  ctx.fillStyle = overall.color
  const gradeW = Math.round(ctx.measureText(overall.grade).width)
  ctx.fillText(overall.grade, x + wideW - 26 - gradeW, y + READOUT_H / 2 + 4)

  ctx.font = 'bold 17px sans-serif'
  ctx.fillStyle = COLORS.textLight
  ctx.fillText(GRADE_WORDS[overall.grade] ?? 'RATED', x + 20, y + 58)
  ctx.font = '13px sans-serif'
  ctx.fillStyle = COLORS.textMuted
  ctx.fillText(`AVG ${Math.round(radar.mean)} / PEAK ${radar.peak.value}   SPREAD ${Math.round(radar.density * 100)}%`, x + 20, y + 80)

  boxes.forEach((box, i) => {
    const bx = x + wideW + gap + i * (boxW + gap)
    fillRoundedRect(ctx, bx, y, boxW, READOUT_H, 16, COLORS.boxBg)
    strokeRoundedRect(ctx, bx, y, boxW, READOUT_H, 16, COLORS.panelLine, 1.5)
    ctx.textAlign = 'center'
    fitFont(ctx, box.value, boxW - 20, { size: 25, min: 13 })
    ctx.fillStyle = box.color
    ctx.fillText(box.value, bx + boxW / 2, y + 42)
    ctx.font = 'bold 12px sans-serif'
    setSpacing(ctx, 2)
    ctx.fillStyle = COLORS.textFaint
    ctx.fillText(box.label, bx + boxW / 2, y + 70)
    setSpacing(ctx, 0)
  })

  return y + READOUT_H
}

function drawEndStrip(ctx, card, view, y) {
  if (!view.endLine) return y
  const x = card.x + MARGIN_X
  const w = card.w - MARGIN_X * 2

  fillRoundedRect(ctx, x, y, w, END_H, 12, COLORS.dangerBg)
  strokeRoundedRect(ctx, x, y, w, END_H, 12, COLORS.dangerLine, 2)
  ctx.fillStyle = COLORS.dangerLine
  ctx.fillRect(x, y + 8, 4, END_H - 16)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  fitFont(ctx, view.endLine, w - 40, { size: 15, min: 10, weight: '' })
  ctx.fillStyle = COLORS.dangerText
  ctx.fillText(view.endLine, x + w / 2, y + END_H / 2 + 1)

  return y + END_H
}

function drawFooter(ctx, card, view, y) {
  const centerX = card.x + card.w / 2
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = 'bold 15px sans-serif'
  ctx.fillStyle = COLORS.textMuted
  ctx.fillText(view.trainLine, centerX, y + 16)
  ctx.font = '14px sans-serif'
  ctx.fillStyle = COLORS.textFaint
  ctx.fillText(view.hintLine, centerX, y + 42)
  return y + FOOTER_H
}

// ── View model ────────────────────────────────────────────────────────────

function buildView(player, opts) {
  const p = player ?? {}
  const level = Number(p.level) || 1
  const rank = getRankForLevel(level)
  const xp = Number(p.xp) || 0

  let cap = null
  try { cap = playerLevelCap(p) } catch { cap = null }
  const prog = getXpProgress(level, xp, cap)

  const state = ensureStatPoints(p)
  const stats = p.stats ?? {}
  const capPoints = statPointCap(level, p)
  const power = STAT_META.reduce((sum, m) => sum + (Number(stats[m.key]) || 0), 0)

  const className = classes[p.classId]?.name ?? p.classId ?? 'Unknown'
  const raceName = races[p.raceId]?.name ?? p.raceId ?? 'Unknown'
  // Guild tags carry emoji ('[VANGUARD]' is '[+swords emoji VANGUARD]' on the
  // wire) and player names can too — canvas has no emoji font, so strip
  // pictographs or they draw as tofu boxes. The '[ ' gap a stripped tag
  // emoji leaves is closed back up so the badge still reads clean.
  const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu
  const clean = (s) => String(s ?? '').replace(EMOJI_RE, '').replace(/\s+/g, ' ').replace(/\[\s+/g, '[').trim()
  const rawName = clean(String(p.name ?? 'Unknown').slice(0, 28)) || 'Unknown'
  const tag = clean(getGuildTag(p))
  const prefix = opts.prefix ?? config.prefix

  const radar = computeRadar(stats, { R: RADAR_R, cx: 0, cy: 0, rings: RINGS })

  return {
    name: tag ? `${tag} ${rawName}` : rawName,
    handle: handleFor(p),
    idLine: `ID ${handleFor(p)}`,
    initial: ([...rawName][0] ?? '?').toUpperCase(),
    subtitle: `${className}  -  ${raceName}`,
    rankLine: `${rank.title}  -  LV ${level}${cap != null ? `/${cap}` : ''}`,
    xpLine: prog.maxed ? 'XP MAXED' : `XP ${compact(prog.intoLevel)}/${compact(prog.forLevel)}  -  ${compact(prog.xpToNext)} TO GO`,
    xpPct: prog.pct,
    xpMaxed: prog.maxed,
    stats: STAT_META.map((m) => ({ ...m, value: Number(stats[m.key]) || 0 })),
    radar,
    unallocated: state.unallocated,
    earned: state.earned,
    cap: capPoints,
    power,
    endLine: opts.endLine ? sanitizeCanvasLine(opts.endLine) : '',
    trainLine: `Training: ${trainCostPerPoint(level).toLocaleString()} solars per point`,
    hintLine: `${prefix}stats add <str|agi|int|def|lck> <amount>   -   ${prefix}train [amount]`,
  }
}

// ── Entry point ───────────────────────────────────────────────────────────

export async function renderStatsCard(player, opts = {}) {
  const view = buildView(player, opts)
  const pfpImg = (await tryLoadPlayerFile(player?.pfp)) ?? defaultPfp

  // Fixed-height layout: every section is constant-size, so the canvas height
  // is exact up front — no measure pass like the profile card needs. Mirrors
  // the gap sequence of the draw calls below, plus bottom breathing room.
  const contentH = 26
    + (HEADER_H + 18)
    + (IDENTITY_H + 20)
    + (RADAR_H + 18)
    + (READOUT_H + 16)
    + (view.endLine ? (END_H + 16) : 0)
    + FOOTER_H
  const height = PAD * 2 + contentH

  const canvas = createCanvas(W, height)
  const ctx = canvas.getContext('2d')

  // Outer frame: a thin cyan shell around the navy panel, with a glow.
  const shell = ctx.createLinearGradient(0, 0, 0, height)
  shell.addColorStop(0, '#1f7a99')
  shell.addColorStop(1, '#0e3f55')
  fillRoundedRect(ctx, 0, 0, W, height, 30, shell)
  const card = { x: PAD, y: PAD, w: W - PAD * 2, h: height - PAD * 2 }
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = 18
  ctx.shadowOffsetY = 8
  fillRoundedRect(ctx, card.x, card.y, card.w, card.h, 20, COLORS.cardBg)
  ctx.restore()
  strokeRoundedRect(ctx, card.x, card.y, card.w, card.h, 20, COLORS.cardLine, 2)

  // Faint scanlines, the texture that keeps the flat navy from looking empty.
  ctx.save()
  roundedRectPath(ctx, card.x, card.y, card.w, card.h, 20)
  ctx.clip()
  ctx.fillStyle = 'rgba(120,215,255,0.035)'
  for (let sy = card.y; sy < card.y + card.h; sy += 4) ctx.fillRect(card.x, sy, card.w, 1)
  ctx.restore()

  // The polygon is centred on the panel, so draw it with the real geometry
  // rather than the (cx=0, cy=0) probe used for grading above.
  let y = card.y + 26
  y = drawHeaderBar(ctx, card, view, y) + 18
  y = drawIdentity(ctx, card, view, pfpImg, y) + 20
  y = drawRadarPanel(ctx, card, view, y) + 18
  y = drawReadout(ctx, card, view, y) + 16
  if (view.endLine) y = drawEndStrip(ctx, card, view, y) + 16
  y = drawFooter(ctx, card, view, y)

  return canvas.toBuffer('image/png')
}
