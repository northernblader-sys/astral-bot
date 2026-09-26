/**
 * lib/top-render.mjs
 * Renders a "Top Adventurers" podium image for the .top command: the top 3
 * players by level, each shown with their avatar, name, level and rank on a
 * classic 1-2-3 podium (winner center and tallest).
 *
 * Matches the canvas stack used by lib/player-id-render.mjs (@napi-rs/canvas).
 * Avatars load from a URL (idImage / a http pfp) or a local file path (pfp),
 * with a lettered placeholder disc when a player has no picture.
 *
 * export async function renderTopPodium(entries) → Buffer (PNG)
 *   entries: up to 3 of { name, level, rankTitle, idImage?, pfp? }, best first.
 */
import './fonts.js' // registers bundled fonts before any canvas draw — see lib/fonts.js
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { drawBadgedName, titleTextWidth } from './title-glyphs.js'

const W = 820, H = 560
const BASE_Y = 524            // podium blocks rest on this line
const SITE   = 'playastral.qzz.io'

// Per-place look: ring around the avatar, podium block gradient, and numeral.
const PLACE = {
  0: { cx: W / 2, blockTopY: 312, blockW: 214, avatarR: 74, ring: '#FFD54A', top: '#FFDC6E', bot: '#B8860B', numeral: '1' },
  1: { cx: 182,   blockTopY: 360, blockW: 190, avatarR: 58, ring: '#D8DEE9', top: '#EEF3FA', bot: '#8A97A8', numeral: '2' },
  2: { cx: 638,   blockTopY: 392, blockW: 190, avatarR: 58, ring: '#E0955B', top: '#F0A868', bot: '#9C5A28', numeral: '3' },
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function tryFetchImage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    return await loadImage(Buffer.from(await res.arrayBuffer()))
  } catch { return null }
}

/** Load a player's avatar: URL image, http pfp, or local-file pfp. */
async function loadAvatar(entry) {
  const url = entry.idImage
  if (url && /^https?:\/\//.test(url)) {
    const img = await tryFetchImage(url)
    if (img) return img
  }
  const pfp = entry.pfp
  if (pfp) {
    if (/^https?:\/\//.test(pfp)) {
      const img = await tryFetchImage(pfp)
      if (img) return img
    } else {
      try { return await loadImage(pfp) } catch { /* missing / unreadable file */ }
    }
  }
  return null
}

function drawCover(ctx, img, x, y, w, h) {
  const s  = Math.max(w / img.width, h / img.height)
  const dw = img.width * s, dh = img.height * s
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

/** Rounded top corners, square bottom (a podium block). */
function podiumPath(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h)
  ctx.lineTo(x, y + h)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/** Trim text with an ellipsis to fit maxW at the current font. */
function fitText(ctx, text, maxW) {
  let t = String(text ?? '')
  if (ctx.measureText(t).width <= maxW) return t
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1)
  return t + '…'
}

// ── One podium column ──────────────────────────────────────────────────────

async function drawColumn(ctx, entry, place) {
  const { cx, blockTopY, blockW, avatarR, ring, top, bot, numeral } = place
  const blockX = cx - blockW / 2
  const blockH = BASE_Y - blockTopY

  // Podium block — vertical gradient in the place color.
  const grad = ctx.createLinearGradient(0, blockTopY, 0, BASE_Y)
  grad.addColorStop(0, top)
  grad.addColorStop(1, bot)
  podiumPath(ctx, blockX, blockTopY, blockW, blockH, 14)
  ctx.fillStyle = grad
  ctx.fill()
  // Soft top highlight
  podiumPath(ctx, blockX, blockTopY, blockW, blockH, 14)
  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(255,255,255,0.28)'
  ctx.stroke()

  // Big numeral on the block — plain sans-serif, no shadow.
  ctx.save()
  ctx.textAlign = 'center'
  ctx.font = `bold ${place.numeral === '1' ? 56 : 46}px sans-serif`
  ctx.fillStyle = 'rgba(255,255,255,0.90)'
  ctx.fillText(numeral, cx, blockTopY + (numeral === '1' ? 74 : 64))
  ctx.restore()

  // Level + rank inside the block, under the numeral.
  const infoY = blockTopY + (numeral === '1' ? 118 : 104)
  ctx.save()
  ctx.textAlign = 'center'
  ctx.font = 'bold 20px sans-serif'
  ctx.fillStyle = '#241a10'
  ctx.fillText(`Lv. ${entry.level ?? 1}`, cx, infoY)

  const rankFont = '13px sans-serif'
  if (entry.titleGlyph) {
    // Titled player: draw "<glyph> <tierName>" centered as one unit. The
    // glyph needs its own font (Noto Sans Symbols — see lib/title-glyphs.js's
    // header for why @napi-rs/canvas can't mix fonts in a single fillText),
    // and drawBadgedName is left-aligned, so center manually: measure both
    // segments first, then start drawing at cx minus half that total width.
    const name = fitText(ctx, entry.rankTitle ?? '', blockW - 60)
    ctx.font = rankFont
    const glyphW = titleTextWidth(ctx, entry.titleGlyph, rankFont)
    const nameW  = ctx.measureText(name).width
    const gap    = 6
    const totalW = glyphW + gap + nameW
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(30,20,8,0.80)'
    drawBadgedName(ctx, cx - totalW / 2, infoY + 20, {
      glyph: entry.titleGlyph,
      name,
      font: rankFont,
      gap,
    })
    ctx.textAlign = 'center'
  } else {
    ctx.font = rankFont
    ctx.fillStyle = 'rgba(30,20,8,0.80)'
    ctx.fillText(fitText(ctx, entry.rankTitle ?? '', blockW - 24), cx, infoY + 20)
  }
  ctx.restore()

  // Avatar disc above the block.
  const acy = blockTopY - avatarR - (numeral === '1' ? 44 : 38)
  const img = await loadAvatar(entry)

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, acy, avatarR, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()
  if (img) {
    drawCover(ctx, img, cx - avatarR, acy - avatarR, avatarR * 2, avatarR * 2)
  } else {
    // Lettered placeholder disc.
    ctx.fillStyle = '#2b2340'
    ctx.fillRect(cx - avatarR, acy - avatarR, avatarR * 2, avatarR * 2)
    ctx.fillStyle = ring
    ctx.textAlign = 'center'
    ctx.font = `bold ${avatarR}px sans-serif`
    ctx.fillText((entry.name ?? '?').charAt(0).toUpperCase(), cx, acy + avatarR * 0.35)
  }
  ctx.restore()

  // Avatar ring.
  ctx.beginPath()
  ctx.arc(cx, acy, avatarR, 0, Math.PI * 2)
  ctx.lineWidth = numeral === '1' ? 6 : 5
  ctx.strokeStyle = ring
  ctx.stroke()

  // Name between the avatar and the block top — plain, casual, no shadow.
  ctx.save()
  ctx.textAlign = 'center'
  ctx.font = `${numeral === '1' ? 20 : 17}px sans-serif`
  ctx.fillStyle = '#FFFFFF'
  ctx.fillText(fitText(ctx, entry.name ?? 'Unknown', blockW + 30), cx, blockTopY - 12)
  ctx.restore()
}

// ── Main render ──────────────────────────────────────────────────────────

export async function renderTopPodium(entries = []) {
  const canvas = createCanvas(W, H)
  const ctx    = canvas.getContext('2d')

  // Background — plain black.
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, W, H)

  // Title — plain, casual sans-serif. No glow, no shadow.
  ctx.textAlign = 'center'
  ctx.font = '14px sans-serif'
  ctx.fillStyle = '#888888'
  ctx.fillText('world of astral', W / 2, 46)

  ctx.font = '30px sans-serif'
  ctx.fillStyle = '#DDDDDD'
  ctx.fillText('Top Adventurers', W / 2, 88)

  // Podium columns — draw 2nd and 3rd first, winner last (front and center).
  const order = [1, 2, 0]
  for (const i of order) {
    if (entries[i]) await drawColumn(ctx, entries[i], PLACE[i])
  }

  // Floor line + site footer.
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(40, BASE_Y)
  ctx.lineTo(W - 40, BASE_Y)
  ctx.stroke()

  ctx.textAlign = 'center'
  ctx.font = '13px sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.fillText(SITE, W / 2, H - 16)

  return canvas.toBuffer('image/png')
}
