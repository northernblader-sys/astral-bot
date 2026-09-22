/**
 * lib/stats-card-render.mjs
 * Renders the stat panel image shown by bare `.stats` (plugins/stats.js).
 *
 * This is the combat-stat sheet, visually distinct from the social profile
 * card (lib/profile-card-render.mjs): a fixed obsidian-and-gold RPG panel
 * with the player's pfp, name, rank/XP bar, one row per combat stat
 * (STR/AGI/INT/DEF/LCK with a value-scaled bar), three point boxes
 * (unallocated / earned-vs-cap / total power), and the command hints.
 *
 * Unlike the profile card, NOTHING here is dynamic-height: every row is a
 * fixed block (the name fits by shrinking, never by wrapping, and there is
 * no bio), so the height is computed arithmetically and the render is a
 * single pass — no measure-then-render needed.
 *
 * Canvas text has no emoji font on the host (see lib/fonts.js — DejaVu only),
 * so stat rows use text labels and colored bars instead of the 💪🏃🧠🛡️🍀
 * glyphs the chat caption uses. Same reason the optional End-aura line is
 * sanitized to plain ASCII-ish text before drawing.
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

const W = 736
const PAD = 26
const BOTTOM_PAD = 54

const COLORS = {
  outerBorder: '#c9a227',
  cardBg:      '#14141c',
  cardOutline: '#000000',
  boxBg:       '#1e1e28',
  boxOutline:  '#000000',
  trackBg:     '#2b2b38',
  textLight:   '#f2f2f5',
  textMuted:   '#a7a7b8',
  textGold:    '#e8c547',
  xpFill:      '#c9a227',
  xpTrack:     '#2b2b38',
}

const STAT_META = [
  { key: 'str', label: 'STR', full: 'Strength',  color: '#e5484d' },
  { key: 'agi', label: 'AGI', full: 'Agility',   color: '#30a46c' },
  { key: 'int', label: 'INT', full: 'Intellect', color: '#3e63dd' },
  { key: 'def', label: 'DEF', full: 'Defense',   color: '#f5a524' },
  { key: 'lck', label: 'LCK', full: 'Luck',      color: '#8e4ec6' },
]

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
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

function fillRoundedRect(ctx, x, y, w, h, r, fillStyle) {
  roundedRectPath(ctx, x, y, w, h, r)
  ctx.fillStyle = fillStyle
  ctx.fill()
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
 * Player names and big point totals both land in fixed boxes, so both go
 * through here rather than trusting the value to fit.
 */
function fitFont(ctx, text, maxWidth, { size, min = 12, weight = 'bold' } = {}) {
  let s = size
  ctx.font = `${weight} ${s}px sans-serif`.trim()
  while (s > min && ctx.measureText(text).width > maxWidth) {
    s -= 1
    ctx.font = `${weight} ${s}px sans-serif`.trim()
  }
  return s
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

// ── Sections (all fixed-height; each returns the y below it) ──────────────

const HEADER_H = 152
const RANK_H = 66
const ROW_H = 62
const BOX_H = 96
const END_H = 44

function drawHeader(ctx, card, view, pfpImg, y0) {
  const d = 116
  const cx = card.x + 40 + d / 2
  const cy = y0 + d / 2

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.5)'
  ctx.shadowBlur = 12
  ctx.shadowOffsetY = 4
  ctx.beginPath()
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2)
  ctx.fillStyle = COLORS.boxBg
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2)
  ctx.clip()
  if (pfpImg) {
    drawCover(ctx, pfpImg, cx - d / 2, cy - d / 2, d, d)
  } else {
    ctx.fillStyle = '#3a3320'
    ctx.fillRect(cx - d / 2, cy - d / 2, d, d)
    ctx.textAlign = 'center'
    ctx.font = `bold ${Math.round(d * 0.42)}px sans-serif`
    ctx.fillStyle = COLORS.textGold
    ctx.fillText(view.initial, cx, cy + d * 0.15)
  }
  ctx.restore()

  ctx.beginPath()
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2)
  ctx.strokeStyle = COLORS.outerBorder
  ctx.lineWidth = 5
  ctx.stroke()

  const tx = card.x + 40 + d + 28
  const maxW = card.x + card.w - 40 - tx

  ctx.textAlign = 'left'
  fitFont(ctx, view.name, maxW, { size: 34, min: 17 })
  ctx.fillStyle = COLORS.textLight
  ctx.fillText(view.name, tx, y0 + 46)

  fitFont(ctx, view.handle, maxW, { size: 18, min: 11 })
  ctx.fillStyle = COLORS.textGold
  ctx.fillText(view.handle, tx, y0 + 74)

  ctx.font = 'bold 15px sans-serif'
  ctx.fillStyle = COLORS.textMuted
  ctx.fillText(view.subtitle, tx, y0 + 102)

  return y0 + HEADER_H
}

function drawRankBar(ctx, card, view, y) {
  const marginX = 40
  const x = card.x + marginX
  const w = card.w - marginX * 2

  fillRoundedRect(ctx, x, y, w, RANK_H, 16, COLORS.xpTrack)
  if (view.xpPct > 0) {
    ctx.save()
    roundedRectPath(ctx, x, y, w, RANK_H, 16)
    ctx.clip()
    ctx.fillStyle = COLORS.xpFill
    ctx.fillRect(x, y, w * Math.min(1, view.xpPct), RANK_H)
    ctx.restore()
  }
  roundedRectPath(ctx, x, y, w, RANK_H, 16)
  ctx.strokeStyle = COLORS.cardOutline
  ctx.lineWidth = 3
  ctx.stroke()

  const pctText = view.xpMaxed ? 'MAX' : `${Math.round(view.xpPct * 100)}%`
  ctx.font = 'bold 18px sans-serif'
  const pctW = ctx.measureText(pctText).width

  ctx.textAlign = 'left'
  fitFont(ctx, view.rankLine, w - 52 - pctW - 16, { size: 21, min: 12 })
  ctx.fillStyle = '#ffffff'
  // Soft dark halo so the label stays readable over the gold fill.
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 6
  ctx.fillText(view.rankLine, x + 26, y + RANK_H / 2 + 8)
  ctx.restore()

  ctx.textAlign = 'right'
  ctx.font = 'bold 18px sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.fillText(pctText, x + w - 22, y + RANK_H / 2 + 7)

  return y + RANK_H
}

function drawStatRows(ctx, card, view, y) {
  const marginX = 40
  const x = card.x + marginX
  const w = card.w - marginX * 2
  const max = Math.max(1, ...view.stats.map(s => s.value))

  for (const stat of view.stats) {
    ctx.textAlign = 'left'
    ctx.font = 'bold 20px sans-serif'
    ctx.fillStyle = stat.color
    ctx.fillText(stat.label, x, y + 22)

    ctx.font = '16px sans-serif'
    ctx.fillStyle = COLORS.textMuted
    ctx.fillText(stat.full, x + 62, y + 22)

    const valText = stat.value.toLocaleString()
    ctx.textAlign = 'right'
    ctx.font = 'bold 20px sans-serif'
    ctx.fillStyle = COLORS.textLight
    ctx.fillText(valText, x + w, y + 22)

    const barY = y + 30
    const barH = 14
    fillRoundedRect(ctx, x, barY, w, barH, 7, COLORS.trackBg)
    const fillW = Math.max(stat.value > 0 ? 14 : 0, (w * stat.value) / max)
    if (fillW > 0) fillRoundedRect(ctx, x, barY, fillW, barH, 7, stat.color)

    y += ROW_H
  }
  return y
}

function drawPointBoxes(ctx, card, view, y) {
  const gap = 16
  const marginX = 40
  const boxes = [
    { value: compact(view.unallocated), label: 'UNALLOCATED' },
    { value: `${compact(view.earned)}/${compact(view.cap)}`, label: 'EARNED' },
    { value: compact(view.power), label: 'POWER' },
  ]
  const boxW = (card.w - marginX * 2 - gap * (boxes.length - 1)) / boxes.length

  boxes.forEach((box, i) => {
    const x = card.x + marginX + i * (boxW + gap)
    fillRoundedRect(ctx, x, y, boxW, BOX_H, 16, COLORS.boxBg)
    roundedRectPath(ctx, x, y, boxW, BOX_H, 16)
    ctx.strokeStyle = COLORS.boxOutline
    ctx.lineWidth = 3
    ctx.stroke()

    ctx.textAlign = 'center'
    fitFont(ctx, box.value, boxW - 20, { size: 26, min: 13 })
    ctx.fillStyle = i === 0 ? COLORS.textGold : COLORS.textLight
    ctx.fillText(box.value, x + boxW / 2, y + 42)

    ctx.font = 'bold 13px sans-serif'
    ctx.fillStyle = COLORS.textMuted
    ctx.fillText(box.label, x + boxW / 2, y + 70)
  })

  return y + BOX_H
}

function drawEndStrip(ctx, card, view, y) {
  if (!view.endLine) return y
  const marginX = 40
  const x = card.x + marginX
  const w = card.w - marginX * 2

  fillRoundedRect(ctx, x, y, w, END_H, 12, '#2a1e14')
  roundedRectPath(ctx, x, y, w, END_H, 12)
  ctx.strokeStyle = '#8a6d2b'
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.textAlign = 'center'
  fitFont(ctx, view.endLine, w - 32, { size: 15, min: 10, weight: '' })
  ctx.fillStyle = COLORS.textGold
  ctx.fillText(view.endLine, x + w / 2, y + 28)

  return y + END_H
}

function drawFooter(ctx, card, view, y) {
  const centerX = card.x + card.w / 2
  ctx.textAlign = 'center'
  ctx.font = 'bold 15px sans-serif'
  ctx.fillStyle = COLORS.textMuted
  ctx.fillText(view.trainLine, centerX, y + 24)
  ctx.font = '14px sans-serif'
  ctx.fillStyle = COLORS.textMuted
  ctx.fillText(view.hintLine, centerX, y + 50)
  return y + 50
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

  return {
    name: tag ? `${tag} ${rawName}` : rawName,
    handle: handleFor(p),
    initial: ([...rawName][0] ?? '?').toUpperCase(),
    subtitle: `${className}  -  ${raceName}`,
    rankLine: `${rank.title}  -  Lv ${level}${cap != null ? `/${cap}` : ''}`,
    xpPct: prog.pct,
    xpMaxed: prog.maxed,
    stats: STAT_META.map(m => ({ ...m, value: Number(stats[m.key]) || 0 })),
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
  const contentH = 30
    + (HEADER_H + 22)
    + (RANK_H + 20)
    + (STAT_META.length * ROW_H + 20)
    + (BOX_H + 20)
    + (view.endLine ? (END_H + 20) : 0)
    + 2 + 50
  const height = PAD * 2 + contentH + BOTTOM_PAD

  const canvas = createCanvas(W, height)
  const ctx = canvas.getContext('2d')

  fillRoundedRect(ctx, 0, 0, W, height, 42, COLORS.outerBorder)
  const card = { x: PAD, y: PAD, w: W - PAD * 2, h: height - PAD * 2 }
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = 18
  ctx.shadowOffsetY = 10
  fillRoundedRect(ctx, card.x, card.y, card.w, card.h, 30, COLORS.cardBg)
  ctx.restore()
  roundedRectPath(ctx, card.x, card.y, card.w, card.h, 30)
  ctx.strokeStyle = COLORS.cardOutline
  ctx.lineWidth = 4
  ctx.stroke()

  let y = card.y + 30
  y = drawHeader(ctx, card, view, pfpImg, y) + 22
  y = drawRankBar(ctx, card, view, y) + 20
  y = drawStatRows(ctx, card, view, y) + 20
  y = drawPointBoxes(ctx, card, view, y) + 20
  if (view.endLine) y = drawEndStrip(ctx, card, view, y) + 20
  y = drawFooter(ctx, card, view, y + 2)

  return canvas.toBuffer('image/png')
}
