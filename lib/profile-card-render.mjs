/**
 * lib/profile-card-render.mjs
 * Renders the profile card image shown by `.me` / `.profile`.
 *
 * This is the social-profile-card layout: a rounded card with a colored
 * outer border, a banner strip, a circular pfp straddling the banner's
 * bottom edge, the name/handle/bio block, three stat boxes, a rank bar
 * with an XP fill, and a bottom stat row. Unlike the old version, the
 * text IS drawn onto the image — the WhatsApp caption still carries the
 * long-form detail (see plugins/me.js, plugins/profile.js).
 *
 * THERE IS NO FIXED COLOR PALETTE. The whole theme (border, accent,
 * text-accent, card background) is derived at render time from the
 * average color of the player's own banner + pfp, so every player's
 * card is tinted to their own artwork instead of the bot's colors.
 * See deriveColorsFromImages().
 *
 * THE HEIGHT IS NOT FIXED EITHER. Pass 1 draws the whole layout onto a
 * generously tall scratch canvas purely to find out where the content
 * actually ends; pass 2 renders for real at that fitted height. That's
 * why a player with a 3-line bio and a player with none both get a card
 * with the same padding under the last row instead of dead space or a
 * clipped box. Image composites are skipped in pass 1 (measure = true)
 * since only text metrics affect the height.
 *
 * Both the per-player pfp/banner and the shared "nobody set one"
 * defaults go through the same tryLoad() path, so a missing/corrupt
 * file never crashes the render — see the comment on tryLoadLocal().
 *
 * Assets expected at (relative to this file):
 *   assets/profile/default-pfp.png     — fallback circular pfp
 *   assets/profile/default-banner.png  — fallback banner fill
 *
 * export async function renderProfileCard(player, opts) → Buffer (PNG)
 *
 * `player` is the whole player record (see lib/player-repo.js). Every
 * field is read defensively, so a partial object still renders.
 *
 * opts.publicView — true for `.profile @player`, the short view someone
 * else can pull up. Drops the wallet boxes, season points and the bottom
 * row entirely, so nobody can scout another player's balances off their
 * card. Keep it that way: that view deliberately shows name, level, rank
 * and bio only.
 */
import './fonts.js' // registers bundled fonts before any canvas draw — see lib/fonts.js
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { fmtGems } from './format.js'
import { getRankForLevel, getXpProgress } from './rank-engine.js'
import { classes, races } from './game-data.js'
import { isPremiumActive } from './premium.js'
import { playerLevelCap } from './reborn-engine.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const ASSET = p => join(__dir, 'assets', 'profile', p)

const W = 736

/** Card inset from the canvas edge — the colored outer border's thickness. */
const PAD = 26

/**
 * Banner height in absolute pixels, NOT a fraction of the card height.
 * The measure-then-render pass changes the total height between passes,
 * so anything proportional here would move every row below it and the
 * fitted height would never settle.
 */
const BANNER_H = 356

/** Clear space under the last row, so its shadow doesn't fuse with the border. */
const BOTTOM_PAD = 70

const FONT = {
  name:        'bold 34px sans-serif',
  handle:      'bold 18px sans-serif',
  subtitle:    'bold 15px sans-serif',
  bio:         '16px sans-serif',
  statValue:   'bold 26px sans-serif',
  statLabel:   'bold 14px sans-serif',
  rank:        'bold 22px sans-serif',
  rankPct:     'bold 18px sans-serif',
  sideValue:   'bold 20px sans-serif',
  sideLabel:   'bold 11px sans-serif',
  bottomValue: 'bold 22px sans-serif',
  bottomLabel: 'bold 13px sans-serif',
}

// ── Asset loading ─────────────────────────────────────────────────────────

/**
 * Loads a local asset file. Never throws — a missing/unreadable file just
 * means a null image, handled at draw time (see drawFallbackFill()), so one
 * bad file degrades gracefully instead of breaking .me for everyone. Same
 * reasoning as tryLoad() in lib/battle-frame-render.mjs.
 */
async function tryLoadLocal(path) {
  try { return await loadImage(readFileSync(path)) }
  catch (err) {
    console.error(`[profile-card-render] missing/unreadable asset: ${path} — ${err.message}`)
    return null
  }
}

/**
 * player.pfp / player.banner are ImgBB URLs (see lib/pfp.js, lib/banner.js —
 * uploads moved off local disk to avoid filling the VPS). Fetches the bytes
 * and loads them the same never-throws way as tryLoadLocal(), so a dead
 * link or network hiccup falls back to the default asset instead of
 * crashing the render.
 */
async function tryLoadPlayerFile(url) {
  if (!url) return null
  // Old player records stored local relative paths (media/pfp/..., media/banner/...).
  // After the ImgBB migration those files no longer exist, and fetch() cannot
  // parse a relative path anyway — so silently skip them and fall back to the
  // default asset instead of logging a noisy error every time.
  if (!url.startsWith('http://') && !url.startsWith('https://')) return null
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    return await loadImage(buffer)
  } catch (err) {
    console.error(`[profile-card-render] missing/unreachable image: ${url} — ${err.message}`)
    return null
  }
}

const [defaultPfp, defaultBanner] = await Promise.all([
  tryLoadLocal(ASSET('default-pfp.png')),
  tryLoadLocal(ASSET('default-banner.png')),
])

// ── Geometry helpers ──────────────────────────────────────────────────────

function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = typeof r === 'number' ? { tl: r, tr: r, br: r, bl: r } : r
  ctx.beginPath()
  ctx.moveTo(x + rr.tl, y)
  ctx.lineTo(x + w - rr.tr, y)
  ctx.arcTo(x + w, y, x + w, y + rr.tr, rr.tr)
  ctx.lineTo(x + w, y + h - rr.br)
  ctx.arcTo(x + w, y + h, x + w - rr.br, y + h, rr.br)
  ctx.lineTo(x + rr.bl, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr.bl, rr.bl)
  ctx.lineTo(x, y + rr.tl)
  ctx.arcTo(x, y, x + rr.tl, y, rr.tl)
  ctx.closePath()
}

function fillRoundedRect(ctx, x, y, w, h, r, fillStyle) {
  roundedRectPath(ctx, x, y, w, h, r)
  ctx.fillStyle = fillStyle
  ctx.fill()
}

function strokeRoundedRect(ctx, x, y, w, h, r, strokeStyle, lineWidth) {
  roundedRectPath(ctx, x, y, w, h, r)
  ctx.strokeStyle = strokeStyle
  ctx.lineWidth = lineWidth
  ctx.stroke()
}

/** Draws `img` filling the box at (x,y,w,h), cropping to cover without distortion. */
function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

/**
 * Themed fill for a player who has set no banner (and for whom even the
 * shared default asset failed to load). Deliberately NOT a flat dark slab:
 * the card around it is light, so a near-black rectangle reads as a broken
 * image rather than a design. An accent gradient reads as intentional.
 */
function drawBannerFallback(ctx, x, y, w, h, colors) {
  const grad = ctx.createLinearGradient(x, y, x + w, y + h)
  grad.addColorStop(0, colors.accentDark)
  grad.addColorStop(1, colors.accent)
  ctx.fillStyle = grad
  ctx.fillRect(x, y, w, h)
  // Faint diagonal sheen, so the empty banner still has some depth.
  ctx.save()
  ctx.globalAlpha = 0.08
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.moveTo(x, y + h)
  ctx.lineTo(x + w * 0.55, y)
  ctx.lineTo(x + w, y)
  ctx.lineTo(x + w, y + h)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function withDropShadow(ctx, drawFn, { blur = 0, offsetX = 0, offsetY = 4, color = 'rgba(0,0,0,0.25)' } = {}) {
  ctx.save()
  ctx.shadowColor = color
  ctx.shadowBlur = blur
  ctx.shadowOffsetX = offsetX
  ctx.shadowOffsetY = offsetY
  drawFn()
  ctx.restore()
}

// ── Text helpers ──────────────────────────────────────────────────────────

/**
 * Sets ctx.font to the largest size (starting at `size`, floor `min`) that
 * keeps `text` inside `maxWidth`. Player-supplied names and six-figure
 * balances both land in fixed-width boxes, so every such slot goes through
 * here rather than trusting the value to fit.
 */
function fitFont(ctx, text, maxWidth, { size, min = 12, weight = 'bold' }) {
  let s = size
  ctx.font = `${weight} ${s}px sans-serif`.trim()
  while (s > min && ctx.measureText(text).width > maxWidth) {
    s -= 1
    ctx.font = `${weight} ${s}px sans-serif`.trim()
  }
  return s
}

/** Wraps `text` to `maxWidth`, at most `maxLines` lines, last line ellipsized. */
function wrapText(ctx, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = word
      if (lines.length === maxLines) break
    } else {
      line = test
    }
  }
  if (lines.length < maxLines && line) lines.push(line)

  // Ellipsize if we ran out of lines with words still left over.
  const used = lines.join(' ').split(/\s+/).filter(Boolean).length
  if (used < words.length && lines.length) {
    let last = lines[lines.length - 1]
    while (last && ctx.measureText(`${last}...`).width > maxWidth) {
      last = last.slice(0, -1)
    }
    lines[lines.length - 1] = `${last}...`
  }
  return lines
}

/**
 * Short form for big numbers, so a nine-figure Solars balance still reads
 * at a glance inside a 190px box. Gems keep fmtGems()' decimal handling
 * below the compaction threshold, since half-gem spin costs mean a gems
 * balance genuinely can be 0.5 (see lib/format.js).
 */
function compact(n) {
  const v = Number(n) || 0
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1).replace(/\.0$/, '')}B`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(v))
}

function gemsText(n) {
  const v = Number(n) || 0
  return Math.abs(v) >= 1e4 ? compact(v) : fmtGems(v)
}

/**
 * The card's @handle is the player's own account id (player.id, a WhatsApp
 * JID), stripped of the server half and any :device suffix. Players who
 * somehow have no id on record (partial/legacy save) show "@unknown" rather
 * than an empty line.
 */
function handleFor(player) {
  const local = String(player?.id ?? '').split('@')[0].split(':')[0].trim()
  return local ? `@${local}` : '@unknown'
}

// ── Theme derivation ──────────────────────────────────────────────────────

/** RGB → HSL, all components 0-1 (h wraps as a fraction of 360deg). */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h, s
  const l = (max + min) / 2
  if (max === min) {
    h = s = 0
  } else {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break
      case g: h = (b - r) / d + 2; break
      default: h = (r - g) / d + 4
    }
    h /= 6
  }
  return { h, s, l }
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  }
}

function rgbToHex({ r, g, b }) {
  const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/**
 * Draws `img` onto a small offscreen canvas and returns its raw pixel data,
 * so colors can be sampled without touching the card canvas. Downscaled to
 * `sampleSize` — full resolution is not needed to find an average color,
 * and this runs on every .me.
 */
function getPixelSamples(img, sampleSize = 48) {
  const c = createCanvas(sampleSize, sampleSize)
  const cctx = c.getContext('2d')
  cctx.drawImage(img, 0, 0, sampleSize, sampleSize)
  return cctx.getImageData(0, 0, sampleSize, sampleSize).data
}

/**
 * Finds a representative theme color from one image's pixels: averages
 * hue/saturation/lightness, but SKIPS near-white, near-black and very
 * low-saturation pixels. Those are usually sky/paper/shadow and would drag
 * the result toward grey instead of the art's actual color identity.
 */
function representativeColorFromPixels(data) {
  let sinH = 0, cosH = 0, sSum = 0, lSum = 0, n = 0
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
    if (a < 200) continue
    const { h, s, l } = rgbToHsl(r, g, b)
    if (l < 0.08 || l > 0.93) continue // near-black / near-white
    if (s < 0.15) continue             // greys
    const angle = h * Math.PI * 2
    sinH += Math.sin(angle) * s
    cosH += Math.cos(angle) * s
    sSum += s
    lSum += l
    n++
  }
  if (n === 0) {
    // Nothing saturated enough (a greyscale pfp) — average everything unfiltered.
    let r = 0, g = 0, b = 0, count = 0
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]; g += data[i + 1]; b += data[i + 2]; count++
    }
    if (!count) return { h: 0.62, s: 0.55, l: 0.5 }
    return rgbToHsl(r / count, g / count, b / count)
  }
  const avgAngle = Math.atan2(sinH, cosH)
  return { h: (avgAngle / (Math.PI * 2) + 1) % 1, s: sSum / n, l: lSum / n }
}

/** Averages two HSL colors, wrapping hue so 350deg + 10deg gives 0deg, not 180deg. */
function averageHsl(a, b) {
  const angleA = a.h * Math.PI * 2, angleB = b.h * Math.PI * 2
  const sinH = Math.sin(angleA) + Math.sin(angleB)
  const cosH = Math.cos(angleA) + Math.cos(angleB)
  return {
    h: ((Math.atan2(sinH, cosH) / (Math.PI * 2)) + 1) % 1,
    s: (a.s + b.s) / 2,
    l: (a.l + b.l) / 2,
  }
}

/**
 * Builds the full theme every draw function expects from one base hue,
 * generating tints/shades and picking readable text colors against the
 * light card background.
 */
function buildThemeFromHsl({ h, s }) {
  // Clamp saturation up so pale source art still yields a punchy accent
  // rather than a muddy one.
  const accentS = Math.min(0.85, Math.max(0.55, s + 0.2))
  return {
    outerBorder: rgbToHex(hslToRgb(h, accentS, 0.48)),
    cardBg:      rgbToHex(hslToRgb(h, Math.min(0.12, s * 0.3), 0.955)),
    boxBg:       rgbToHex(hslToRgb(h, Math.min(0.12, s * 0.3), 0.955)),
    cardOutline: '#1a1a1a',
    boxOutline:  '#1a1a1a',
    accent:      rgbToHex(hslToRgb(h, accentS, 0.52)),
    accentDark:  rgbToHex(hslToRgb(h, accentS, 0.38)),
    textDark:    '#161616',
    textAccent:  rgbToHex(hslToRgb(h, Math.min(0.9, accentS + 0.05), 0.42)),
    textMuted:   '#4a4a4a',
    white:       '#ffffff',
  }
}

/**
 * Samples the banner and pfp (either may be null), averages their
 * representative colors and returns a complete theme.
 */
function deriveColorsFromImages(bannerImg, pfpImg) {
  const samples = []
  if (bannerImg) samples.push(representativeColorFromPixels(getPixelSamples(bannerImg)))
  if (pfpImg) samples.push(representativeColorFromPixels(getPixelSamples(pfpImg)))
  if (samples.length === 0) return buildThemeFromHsl({ h: 0.62, s: 0.6 })
  return buildThemeFromHsl(samples.length === 2 ? averageHsl(samples[0], samples[1]) : samples[0])
}

// ── Sections ──────────────────────────────────────────────────────────────

function drawOuterBorder(ctx, w, h, colors) {
  fillRoundedRect(ctx, 0, 0, w, h, 42, colors.outerBorder)
}

function drawCardBase(ctx, w, h, colors) {
  const card = { x: PAD, y: PAD, w: w - PAD * 2, h: h - PAD * 2 }
  withDropShadow(
    ctx,
    () => fillRoundedRect(ctx, card.x, card.y, card.w, card.h, 30, colors.cardBg),
    { blur: 18, offsetY: 10, color: 'rgba(0,0,0,0.35)' },
  )
  strokeRoundedRect(ctx, card.x, card.y, card.w, card.h, 30, colors.cardOutline, 4)
  return card
}

function drawBanner(ctx, card, bannerImg, colors, measure) {
  const region = { x: card.x, y: card.y, w: card.w, h: BANNER_H }
  if (measure) return region

  ctx.save()
  roundedRectPath(ctx, region.x, region.y, region.w, region.h, { tl: 30, tr: 30, br: 0, bl: 0 })
  ctx.clip()
  if (bannerImg) {
    drawCover(ctx, bannerImg, region.x, region.y, region.w, region.h)
  } else {
    drawBannerFallback(ctx, region.x, region.y, region.w, region.h, colors)
  }
  // Slight darkening along the top so the corner dots stay visible over
  // a bright banner.
  const veil = ctx.createLinearGradient(region.x, region.y, region.x, region.y + 90)
  veil.addColorStop(0, 'rgba(0,0,0,0.35)')
  veil.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = veil
  ctx.fillRect(region.x, region.y, region.w, 90)
  ctx.restore()

  // Three-dot indicator, top-left.
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    ctx.arc(card.x + 44 + i * 22, card.y + 40, 5, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fill()
  }
  return region
}

function drawPfp(ctx, card, bannerRegion, pfpImg, view, colors, measure) {
  const d = card.w * 0.365
  const r = d / 2
  const cx = card.x + card.w / 2
  const cy = bannerRegion.y + bannerRegion.h
  if (measure) return { cx, cy, bottomY: cy + r }

  // Backing disc with a soft shadow, so the circle still reads as raised
  // over the banner without a plate behind it.
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = 14
  ctx.shadowOffsetY = 5
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = colors.cardBg
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.clip()
  if (pfpImg) {
    drawCover(ctx, pfpImg, cx - r, cy - r, d, d)
  } else {
    // No pfp set: an accent disc with the player's initial, which reads as
    // a deliberate placeholder instead of a failed image.
    ctx.fillStyle = colors.accentDark
    ctx.fillRect(cx - r, cy - r, d, d)
    ctx.textAlign = 'center'
    ctx.font = `bold ${Math.round(d * 0.42)}px sans-serif`
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.fillText(view.initial, cx, cy + d * 0.15)
  }
  ctx.restore()

  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.strokeStyle = colors.accent
  ctx.lineWidth = 6
  ctx.stroke()

  return { cx, cy, bottomY: cy + r }
}

/** The premium check badge: a filled circle with a white tick. */
function drawVerifiedBadge(ctx, cx, cy, size, colors) {
  const r = size / 2
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = colors.accent
  ctx.fill()
  ctx.strokeStyle = colors.cardOutline
  ctx.lineWidth = 2.5
  ctx.stroke()

  ctx.strokeStyle = colors.white
  ctx.lineWidth = 2.5
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(cx - 6, cy - 1)
  ctx.lineTo(cx - 1, cy + 5)
  ctx.lineTo(cx + 8, cy - 6)
  ctx.stroke()
}

function drawNameBlock(ctx, card, pfp, view, colors) {
  const centerX = card.x + card.w / 2
  const maxW = card.w - 96
  let y = pfp.bottomY + 46

  // Name, plus the premium badge. The badge is drawn ONLY for an active
  // premium player — it is the paid mark, so it must never appear for a
  // free account (and must disappear again when a plan lapses).
  const badgeSize = 26
  const badgeGap = 12
  const nameBudget = view.verified ? maxW - badgeGap - badgeSize : maxW
  fitFont(ctx, view.name, nameBudget, { size: 34, min: 18 })
  const nameWidth = ctx.measureText(view.name).width
  const totalWidth = view.verified ? nameWidth + badgeGap + badgeSize : nameWidth
  const nameLeftX = centerX - totalWidth / 2

  ctx.textAlign = 'center'
  ctx.fillStyle = colors.textDark
  ctx.fillText(view.name, nameLeftX + nameWidth / 2, y)

  if (view.verified) {
    drawVerifiedBadge(ctx, nameLeftX + nameWidth + badgeGap + badgeSize / 2, y - 12, badgeSize, colors)
  }

  y += 32
  fitFont(ctx, view.handle, maxW, { size: 18, min: 11 })
  ctx.fillStyle = colors.textAccent
  ctx.fillText(view.handle, centerX, y)

  y += 26
  ctx.font = FONT.subtitle
  ctx.fillStyle = colors.textMuted
  ctx.fillText(view.subtitle, centerX, y)

  y += 32
  ctx.font = FONT.bio
  ctx.fillStyle = colors.textMuted
  for (const line of wrapText(ctx, view.bio, maxW, 3)) {
    ctx.fillText(line, centerX, y)
    y += 24
  }

  return y + 20
}

function drawStatBoxes(ctx, card, startY, stats, colors) {
  const gap = 16
  const marginX = 40
  const boxH = 96
  const boxW = (card.w - marginX * 2 - gap * (stats.length - 1)) / stats.length

  stats.forEach((stat, i) => {
    const x = card.x + marginX + i * (boxW + gap)
    fillRoundedRect(ctx, x, startY, boxW, boxH, 16, colors.boxBg)
    strokeRoundedRect(ctx, x, startY, boxW, boxH, 16, colors.boxOutline, 3)

    ctx.textAlign = 'center'
    fitFont(ctx, stat.value, boxW - 20, { size: 26, min: 13 })
    ctx.fillStyle = colors.textDark
    ctx.fillText(stat.value, x + boxW / 2, startY + 40)

    ctx.font = FONT.statLabel
    ctx.fillStyle = colors.textAccent
    ctx.fillText(stat.label, x + boxW / 2, startY + 68)
  })

  return startY + boxH + 22
}

/**
 * The rank bar. Shaped like the reference's primary action button, but the
 * accent fill doubles as the XP progress bar for the current level, with
 * the percentage on the right (MAX at the level ceiling). Reborn players
 * pass their raised cap, so their bar doesn't sit pinned at 100% from
 * level 100 to 150.
 */
function drawRankBar(ctx, card, startY, view, colors) {
  const marginX = 40
  const barH = 66
  const gap = 14
  const sideW = view.side ? 68 : 0
  const barW = card.w - marginX * 2 - (view.side ? sideW + gap : 0)
  const x = card.x + marginX

  fillRoundedRect(ctx, x, startY, barW, barH, 18, colors.accentDark)
  if (view.xpPct > 0) {
    ctx.save()
    roundedRectPath(ctx, x, startY, barW, barH, 18)
    ctx.clip()
    ctx.fillStyle = colors.accent
    ctx.fillRect(x, startY, barW * Math.min(1, view.xpPct), barH)
    ctx.restore()
  }
  strokeRoundedRect(ctx, x, startY, barW, barH, 18, colors.cardOutline, 3)

  ctx.font = FONT.rankPct
  const pctText = view.xpMaxed ? 'MAX' : `${Math.round(view.xpPct * 100)}%`
  const pctW = ctx.measureText(pctText).width

  ctx.textAlign = 'left'
  fitFont(ctx, view.rankTitle, barW - 52 - pctW, { size: 22, min: 13 })
  ctx.fillStyle = colors.white
  ctx.fillText(view.rankTitle, x + 26, startY + barH / 2 + 8)

  ctx.textAlign = 'right'
  ctx.font = FONT.rankPct
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  ctx.fillText(pctText, x + barW - 22, startY + barH / 2 + 7)

  // Square side box — season points. Own view only.
  if (view.side) {
    const ix = x + barW + gap
    fillRoundedRect(ctx, ix, startY, sideW, barH, 18, colors.boxBg)
    strokeRoundedRect(ctx, ix, startY, sideW, barH, 18, colors.boxOutline, 3)
    ctx.textAlign = 'center'
    fitFont(ctx, view.side.value, sideW - 14, { size: 20, min: 11 })
    ctx.fillStyle = colors.textDark
    ctx.fillText(view.side.value, ix + sideW / 2, startY + 32)
    ctx.font = FONT.sideLabel
    ctx.fillStyle = colors.textAccent
    ctx.fillText(view.side.label, ix + sideW / 2, startY + 50)
  }

  return startY + barH + 20
}

/** Four-point sparkle, carried over from the old card's pfp accents. */
function drawSparkle(ctx, x, y, size, color) {
  ctx.save()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x, y - size)
  ctx.quadraticCurveTo(x + size * 0.15, y - size * 0.15, x + size, y)
  ctx.quadraticCurveTo(x + size * 0.15, y + size * 0.15, x, y + size)
  ctx.quadraticCurveTo(x - size * 0.15, y + size * 0.15, x - size, y)
  ctx.quadraticCurveTo(x - size * 0.15, y - size * 0.15, x, y - size)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function drawBottomRow(ctx, card, startY, bottomStats, colors) {
  const marginX = 40
  const badgeW = 88
  const gap = 16
  const boxH = 100
  const boxesW = card.w - marginX * 2 - badgeW - gap
  const boxW = (boxesW - gap * (bottomStats.length - 1)) / bottomStats.length

  bottomStats.forEach((stat, i) => {
    const x = card.x + marginX + i * (boxW + gap)
    fillRoundedRect(ctx, x, startY, boxW, boxH, 16, colors.boxBg)
    strokeRoundedRect(ctx, x, startY, boxW, boxH, 16, colors.boxOutline, 3)

    ctx.textAlign = 'center'
    fitFont(ctx, stat.value, boxW - 20, { size: 22, min: 12 })
    ctx.fillStyle = colors.textDark
    ctx.fillText(stat.value, x + boxW / 2, startY + 44)

    ctx.font = FONT.bottomLabel
    ctx.fillStyle = colors.textAccent
    ctx.fillText(stat.label, x + boxW / 2, startY + 72)
  })

  const bx = card.x + marginX + boxesW + gap
  fillRoundedRect(ctx, bx, startY, badgeW, boxH, 18, colors.accent)
  strokeRoundedRect(ctx, bx, startY, badgeW, boxH, 18, colors.cardOutline, 3)
  drawSparkle(ctx, bx + badgeW / 2, startY + boxH / 2, 24, colors.white)

  return startY + boxH
}

// ── View model ────────────────────────────────────────────────────────────

/**
 * Flattens a player record into exactly the strings the card draws. Every
 * read is defensive: a legacy save missing wallet/stats/stamina still
 * renders, it just shows zeroes.
 */
function buildView(player, publicView) {
  const p = player ?? {}
  const level = Number(p.level) || 1
  const rank = getRankForLevel(level)
  const xp = Number(p.xp) || 0

  let cap = null
  try { cap = playerLevelCap(p) } catch { cap = null }
  const prog = getXpProgress(level, xp, cap)

  const className = classes[p.classId]?.name ?? p.classId ?? 'Unknown'
  const raceName = races[p.raceId]?.name ?? p.raceId ?? 'Unknown'

  const w = p.wallet ?? {}
  const st = p.stamina ?? { current: 0, max: 0 }
  const s = p.stats ?? {}
  const power = ['str', 'agi', 'int', 'def', 'lck'].reduce((sum, k) => sum + (Number(s[k]) || 0), 0)

  const view = {
    name: String(p.name ?? 'Unknown').slice(0, 28) || 'Unknown',
    handle: handleFor(p),
    // Drawn inside the circle when no pfp is set. Split by code point, not
    // by index, so a name starting with an emoji or a surrogate pair does
    // not get cut in half into a mojibake glyph.
    initial: ([...String(p.name ?? '').trim()][0] ?? '?').toUpperCase(),
    subtitle: `${className}  ·  ${raceName}`,
    bio: p.bio ? String(p.bio) : 'No bio set yet.',
    // Premium only. Free accounts get no badge at all.
    verified: (() => { try { return isPremiumActive(p) } catch { return false } })(),
    rankTitle: rank.title,
    xpPct: prog.pct,
    xpMaxed: prog.maxed,
    stats: [],
    side: null,
    bottomStats: null,
  }

  if (publicView) {
    // Short public view: level and rank flavor only. No balances, no season
    // points, no bottom row — same restriction as the caption text in
    // plugins/profile.js's replyShortProfile(). The rank's epithet goes in
    // the box rather than its title, since the title is already the label
    // on the bar right below it.
    view.stats = [
      { value: String(level), label: 'Level' },
      { value: rank.epithet, label: 'Epithet' },
    ]
    return view
  }

  view.stats = [
    { value: String(level), label: 'Level' },
    { value: compact(w.solars ?? 0), label: 'Solars' },
    { value: gemsText(w.gems ?? 0), label: 'Gems' },
  ]
  view.side = { value: compact(p.seasonPoints ?? 0), label: 'SP' }
  // Three boxes rather than two, which needs no layout change: drawBottomRow
  // divides the available width by bottomStats.length and fitFont shrinks each
  // value to fit whatever box it gets.
  view.bottomStats = [
    { value: compact(power), label: 'Power' },
    { value: compact(w.monds ?? 0), label: 'Monds' },
    { value: compact(w.vault ?? 0), label: 'Vault' },
  ]
  return view
}

// ── Entry point ───────────────────────────────────────────────────────────

export async function renderProfileCard(player, opts = {}) {
  const publicView = !!opts.publicView
  const view = buildView(player, publicView)

  const [playerPfpImg, playerBannerImg] = await Promise.all([
    tryLoadPlayerFile(player?.pfp),
    tryLoadPlayerFile(player?.banner),
  ])
  const pfpImg = playerPfpImg ?? defaultPfp
  const bannerImg = playerBannerImg ?? defaultBanner

  const colors = deriveColorsFromImages(bannerImg, pfpImg)

  /**
   * One layout pass. `measure = true` skips the banner/pfp composites and
   * the outer border, since only text metrics decide the final height —
   * that keeps the sizing pass from paying for two full image draws.
   */
  const layout = (ctx, height, measure) => {
    if (!measure) drawOuterBorder(ctx, W, height, colors)
    const card = drawCardBase(ctx, W, height, colors)
    const banner = drawBanner(ctx, card, bannerImg, colors, measure)
    const pfp = drawPfp(ctx, card, banner, pfpImg, view, colors, measure)
    let y = drawNameBlock(ctx, card, pfp, view, colors)
    y = drawStatBoxes(ctx, card, y, view.stats, colors)
    y = drawRankBar(ctx, card, y, view, colors)
    if (view.bottomStats) y = drawBottomRow(ctx, card, y, view.bottomStats, colors)
    return { card, endY: y }
  }

  // Pass 1: measure on a deliberately over-tall scratch canvas.
  const scratch = createCanvas(W, 2200)
  const measured = layout(scratch.getContext('2d'), 2200, true)
  const height = Math.round(measured.endY - measured.card.y + BOTTOM_PAD)

  // Pass 2: render for real at the fitted height.
  const canvas = createCanvas(W, height)
  layout(canvas.getContext('2d'), height, false)

  return canvas.toBuffer('image/png')
}
