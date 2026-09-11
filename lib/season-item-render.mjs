/**
 * lib/season-item-render.mjs
 * The `.season info <name>` card — one catalog entry blown up: large artwork,
 * rarity band, price, stat block, and the entry's own flavour text.
 *
 *   export async function renderSeasonItem(opts) → Buffer (PNG)
 *
 * opts: {
 *   season, entry,   // the decorated catalog entry (getSeasonCatalog output)
 *   player,          // optional — owned state, affordability, purchases left
 *   pageLabel,       // optional — which shop shelf it sits on
 *   prefix,
 * }
 *
 * This works for EVERY rewardType in the catalog — character, weapon, item,
 * relic, pet, beast, mega stone, legendary Pokémon, title, currency — because
 * it renders describeSeasonEntry()'s common shape rather than branching per
 * type. Anything the entry doesn't have (no stats, no artwork, no extras) is
 * simply skipped and the layout closes up around it.
 *
 * PNG, not SVG — see the note at the top of season-shop-render.mjs.
 */
import {
  createCanvas, tryFetch, roundedRect, truncate, wrapText, drawContain,
  drawEmblem, drawStars, drawSpark, drawCheck, drawLock, rarityPalette,
  GOLD, GOLD_DIM, INK, PANEL, PANEL_HI, TEXT, TEXT_DIM,
} from './season-render-common.mjs'
import { describeSeasonEntry } from './season-engine.js'

const W = 900
const H = 1180
const PAD = 34
const ART_H = 470

const STAT_LABEL = {
  str: 'STR', atk: 'ATK', def: 'DEF', agi: 'AGI', int: 'INT',
  maxHp: 'MAX HP', hp: 'HP', crit: 'CRIT', critChance: 'CRIT %',
  critDamage: 'CRIT DMG', dodge: 'DODGE', lifesteal: 'LIFESTEAL',
  xpBonus: 'XP BONUS', solarBonus: 'SOLAR BONUS', luck: 'LUCK',
}

function statLabel(key) {
  return STAT_LABEL[key] ?? String(key).replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()
}

function drawBackdrop(ctx, pal) {
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, W, H)

  // Rarity-coloured wash behind the artwork half only — the text half stays
  // near-black so the body copy keeps its contrast.
  const wash = ctx.createRadialGradient(W / 2, ART_H * 0.5, 60, W / 2, ART_H * 0.5, W * 0.85)
  wash.addColorStop(0, `${pal.base}3a`)
  wash.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = wash
  ctx.fillRect(0, 0, W, H)

  ctx.save()
  ctx.globalAlpha = 0.05
  ctx.strokeStyle = pal.base
  ctx.lineWidth = 1
  for (let x = -H; x < W; x += 40) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x + H, H)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * A rarity-tinted chip: rounded outline + centred label. Returns its width.
 *
 * The whole body is wrapped in save/restore because this sets textAlign to
 * 'center' to place its own label. Without the restore that alignment leaked
 * into every draw that followed the chip row — the description, the STATS
 * heading and the extras were all being centred on x = PAD instead of started
 * from it, which hung the left half of each line off the edge of the canvas.
 */
function chip(ctx, x, y, text, color, filled = false) {
  ctx.save()
  ctx.font = 'bold 14px sans-serif'
  const w = ctx.measureText(text).width + 26
  const h = 30
  roundedRect(ctx, x, y, w, h, 9)
  ctx.fillStyle = filled ? color : 'rgba(255,255,255,0.04)'
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.fillStyle = filled ? INK : color
  ctx.textAlign = 'center'
  ctx.fillText(text, x + w / 2, y + 20)
  ctx.restore()
  return w
}

function drawArt(ctx, art, info, pal) {
  ctx.save()
  roundedRect(ctx, PAD, PAD, W - PAD * 2, ART_H, 24)
  ctx.clip()

  const bg = ctx.createLinearGradient(0, PAD, 0, PAD + ART_H)
  bg.addColorStop(0, `${pal.base}26`)
  bg.addColorStop(1, 'rgba(0,0,0,0.45)')
  ctx.fillStyle = bg
  ctx.fillRect(PAD, PAD, W - PAD * 2, ART_H)

  // Halo behind the subject
  const halo = ctx.createRadialGradient(W / 2, PAD + ART_H * 0.48, 30, W / 2, PAD + ART_H * 0.48, ART_H * 0.62)
  halo.addColorStop(0, `${pal.glow}33`)
  halo.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = halo
  ctx.fillRect(PAD, PAD, W - PAD * 2, ART_H)

  if (art) drawContain(ctx, art, PAD + 40, PAD + 28, W - PAD * 2 - 80, ART_H - 56)
  else drawEmblem(ctx, PAD + 40, PAD + 28, W - PAD * 2 - 80, ART_H - 56, info)
  ctx.restore()

  roundedRect(ctx, PAD, PAD, W - PAD * 2, ART_H, 24)
  ctx.save()
  ctx.shadowColor = `${pal.base}66`
  ctx.shadowBlur = 22
  ctx.lineWidth = 2
  ctx.strokeStyle = pal.base
  ctx.stroke()
  ctx.restore()
}

function drawStatGrid(ctx, x, y, w, stats, pal) {
  const rows = Object.entries(stats).filter(([, v]) => v != null && v !== 0)
  if (!rows.length) return y

  const cols = 3
  const cellW = Math.floor((w - 12 * (cols - 1)) / cols)
  const cellH = 62
  const lines = Math.ceil(rows.length / cols)

  rows.forEach(([key, value], i) => {
    const cx = x + (i % cols) * (cellW + 12)
    const cy = y + Math.floor(i / cols) * (cellH + 12)
    roundedRect(ctx, cx, cy, cellW, cellH, 12)
    ctx.fillStyle = 'rgba(255,255,255,0.035)'
    ctx.fill()
    ctx.strokeStyle = `${pal.base}44`
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.textAlign = 'left'
    ctx.font = '12px sans-serif'
    ctx.fillStyle = TEXT_DIM
    ctx.fillText(statLabel(key), cx + 14, cy + 23)

    const num = Number(value)
    const shown = Number.isFinite(num) ? (num > 0 ? `+${num}` : String(num)) : String(value)
    ctx.font = 'bold 24px sans-serif'
    ctx.fillStyle = Number.isFinite(num) && num < 0 ? '#c8606f' : pal.glow
    ctx.fillText(shown, cx + 14, cy + 48)
  })

  return y + lines * (cellH + 12)
}

export async function renderSeasonItem({
  season, entry, player = null, pageLabel = null, prefix = '.',
} = {}) {
  const info = describeSeasonEntry(entry)
  const pal = rarityPalette(info.rarity)
  const art = await tryFetch(info.image)

  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')

  drawBackdrop(ctx, pal)
  drawArt(ctx, art, info, pal)

  let y = PAD + ART_H + 40

  // Shelf line
  if (pageLabel) {
    ctx.textAlign = 'left'
    ctx.font = 'bold 14px sans-serif'
    ctx.fillStyle = GOLD_DIM
    ctx.fillText(`SEASON ${season?.number ?? 1} SHOP  ·  ${String(pageLabel).toUpperCase()}`, PAD, y)
    y += 26
  }

  // Name
  ctx.textAlign = 'left'
  ctx.font = 'bold 50px sans-serif'
  ctx.fillStyle = TEXT
  ctx.fillText(truncate(ctx, info.name, W - PAD * 2), PAD, y + 32)
  y += 56

  // Chip row: rarity · kind · stars
  let chipX = PAD
  if (info.rarity) {
    chipX += chip(ctx, chipX, y, String(info.rarity).toUpperCase(), pal.base, true) + 10
  }
  chipX += chip(ctx, chipX, y, String(info.kind).toUpperCase(), 'rgba(255,255,255,0.35)') + 10
  if (pal.stars) drawStars(ctx, chipX + 4, y + 8, 7, pal.stars, 6, pal.base)
  y += 52

  // Description
  if (info.description) {
    ctx.font = '19px sans-serif'
    ctx.fillStyle = TEXT_DIM
    for (const line of wrapText(ctx, info.description, W - PAD * 2, 4)) {
      ctx.fillText(line, PAD, y + 20)
      y += 28
    }
    y += 12
  }

  // Stats. Gate on the values that will actually be drawn, not the key count —
  // drawStatGrid() drops null/0 entries, so an all-zero stat block used to
  // render the heading with an empty space under it.
  const drawableStats = Object.entries(info.stats ?? {}).filter(([, v]) => v != null && v !== 0)
  if (drawableStats.length) {
    ctx.font = 'bold 14px sans-serif'
    ctx.fillStyle = GOLD_DIM
    ctx.fillText('STATS', PAD, y + 12)
    y += 26
    y = drawStatGrid(ctx, PAD, y, W - PAD * 2, Object.fromEntries(drawableStats), pal) + 8
  }

  // Extras (ability, unlock, requirements)
  if (info.extra?.length) {
    ctx.font = '17px sans-serif'
    for (const line of info.extra.filter(Boolean).slice(0, 4)) {
      ctx.fillStyle = pal.base
      ctx.fillText('•', PAD, y + 18)
      ctx.fillStyle = TEXT_DIM
      ctx.fillText(truncate(ctx, line, W - PAD * 2 - 24), PAD + 20, y + 18)
      y += 27
    }
    y += 8
  }

  // ── Price / ownership footer, pinned to the bottom ─────────────────────
  const boxH = 96
  const boxY = H - PAD - boxH
  roundedRect(ctx, PAD, boxY, W - PAD * 2, boxH, 18)
  const box = ctx.createLinearGradient(0, boxY, 0, boxY + boxH)
  box.addColorStop(0, PANEL_HI)
  box.addColorStop(1, PANEL)
  ctx.fillStyle = box
  ctx.fill()
  ctx.strokeStyle = `${pal.base}66`
  ctx.lineWidth = 1.5
  ctx.stroke()

  const price = Number(entry?.price ?? 0)
  const points = player?.seasonPoints ?? 0
  const purchases = player?.seasonPurchases?.[entry?.id] ?? 0
  const limit = entry?.purchaseLimit
  const soldOut = limit != null && purchases >= limit
  const affordable = points >= price

  ctx.textAlign = 'left'
  ctx.font = '13px sans-serif'
  ctx.fillStyle = TEXT_DIM
  ctx.fillText('PRICE', PAD + 22, boxY + 32)
  ctx.font = 'bold 38px sans-serif'
  ctx.fillStyle = soldOut ? TEXT_DIM : affordable ? GOLD : '#c8606f'
  const priceText = price.toLocaleString('en-US')
  drawSpark(ctx, PAD + 32, boxY + 58, 12, soldOut ? TEXT_DIM : affordable ? GOLD : '#c8606f')
  ctx.fillText(priceText, PAD + 52, boxY + 70)

  ctx.font = '14px sans-serif'
  ctx.fillStyle = TEXT_DIM
  ctx.textAlign = 'right'
  if (soldOut) {
    ctx.fillText('You already bought the maximum.', W - PAD - 22, boxY + 34)
    drawCheck(ctx, W - PAD - 40, boxY + 60, 16)
  } else if (!player) {
    ctx.fillText(`Register, then ${prefix}season shop buy ${entry?.id ?? ''}`, W - PAD - 22, boxY + 40)
  } else if (affordable) {
    ctx.fillText(
      limit == null
        ? `You can afford this — ✨${points.toLocaleString('en-US')} available`
        : `You can afford this — ${Math.max(0, limit - purchases)} left to buy`,
      W - PAD - 22, boxY + 34,
    )
    ctx.font = 'bold 16px sans-serif'
    ctx.fillStyle = '#4ad07a'
    ctx.fillText(`${prefix}season shop buy ${entry?.id ?? ''}`, W - PAD - 22, boxY + 64)
  } else {
    ctx.fillText(`You have ✨${points.toLocaleString('en-US')}`, W - PAD - 22, boxY + 34)
    ctx.font = 'bold 16px sans-serif'
    ctx.fillStyle = '#c8606f'
    ctx.fillText(`${(price - points).toLocaleString('en-US')} more Season Points needed`, W - PAD - 22, boxY + 64)
    drawLock(ctx, W - PAD - 30, boxY + 20, 15, '#c8606f')
  }

  return canvas.toBuffer('image/png')
}
