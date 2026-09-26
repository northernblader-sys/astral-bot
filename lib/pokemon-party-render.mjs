/**
 * lib/pokemon-party-render.mjs
 * Renders a Pokémon-themed party card showing 6 slots (3×2 grid) with
 * sprites, names, levels, and HP bars.
 *
 * export async function renderPokemonParty(player, partySlots) → Buffer (PNG)
 *
 * partySlots: array of exactly 6 items — each is a Pokémon object or null
 * Pokémon shape used: { dexId, name, nickname, level, currentHp, maxHp, shiny, id }
 * player shape used:  { name, mainPokemonId }
 */
import './fonts.js' // registers bundled fonts before any canvas draw — see lib/fonts.js
import { createCanvas, loadImage } from '@napi-rs/canvas'

const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon'

function spriteUrl(dexId, shiny = false) {
  return shiny ? `${SPRITE_BASE}/shiny/${dexId}.png` : `${SPRITE_BASE}/${dexId}.png`
}

const W = 780
const H = 510
const HEADER_H = 62
const PAD = 14

async function tryFetch(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    return await loadImage(Buffer.from(await res.arrayBuffer()))
  } catch { return null }
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y,     x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x,     y + h, r)
  ctx.arcTo(x,     y + h, x,     y,     r)
  ctx.arcTo(x,     y,     x + w, y,     r)
  ctx.closePath()
}

function drawPokeball(ctx, cx, cy, r) {
  // top half – red
  ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, 0)
  ctx.fillStyle = '#CC0000'; ctx.fill()
  // bottom half – white
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI)
  ctx.fillStyle = '#F4F4F4'; ctx.fill()
  // centre band
  ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy)
  ctx.lineWidth = Math.max(2, r * 0.25); ctx.strokeStyle = '#111'; ctx.stroke()
  // centre button
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.30, 0, Math.PI * 2)
  ctx.fillStyle = '#F4F4F4'; ctx.fill()
  ctx.lineWidth = Math.max(1.5, r * 0.18); ctx.strokeStyle = '#111'; ctx.stroke()
  // outer ring
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.lineWidth = Math.max(2, r * 0.20); ctx.strokeStyle = '#111'; ctx.stroke()
}

function hpColor(ratio) {
  if (ratio > 0.50) return '#44CC44'
  if (ratio > 0.20) return '#FFCC00'
  return '#EE2244'
}

export async function renderPokemonParty(player, partySlots) {
  const canvas = createCanvas(W, H)
  const ctx    = canvas.getContext('2d')

  // ── Background — solid black ────────────────────────────────────────────
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, W, H)

  // ── Header ──────────────────────────────────────────────────────────────
  drawPokeball(ctx, 34, HEADER_H / 2, 20)
  drawPokeball(ctx, W - 34, HEADER_H / 2, 20)

  ctx.font      = 'bold 24px sans-serif'
  ctx.fillStyle = '#FFFFFF'
  ctx.textAlign = 'center'
  ctx.fillText(`${player.name}'s Battle Party`, W / 2, HEADER_H / 2 + 8)

  // Thin gray divider
  ctx.beginPath()
  ctx.moveTo(PAD, HEADER_H); ctx.lineTo(W - PAD, HEADER_H)
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#555555'; ctx.stroke()

  // ── Fetch all sprites in parallel ──────────────────────────────────────
  const sprites = await Promise.all(
    partySlots.map(mon =>
      mon?.dexId ? tryFetch(spriteUrl(mon.dexId, mon.shiny ?? false)) : Promise.resolve(null)
    )
  )

  // ── Slot layout ─────────────────────────────────────────────────────────
  const COLS = 3, ROWS = 2
  const gridW  = W - PAD * 2
  const gridH  = H - HEADER_H - PAD
  const slotGX = PAD * 0.6
  const slotGY = PAD * 0.6
  const slotW  = Math.floor((gridW - slotGX * (COLS - 1)) / COLS)
  const slotH  = Math.floor((gridH - slotGY * (ROWS - 1)) / ROWS)

  for (let i = 0; i < 6; i++) {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const sx  = PAD + col * (slotW + slotGX)
    const sy  = HEADER_H + PAD * 0.5 + row * (slotH + slotGY)
    const mon = partySlots[i]
    const spr = sprites[i]

    // Slot background
    ctx.save()
    roundedRect(ctx, sx, sy, slotW, slotH, 12)
    ctx.fillStyle = mon ? '#111111' : '#0A0A0A'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = mon ? '#888888' : '#333333'
    ctx.stroke()
    ctx.restore()

    if (!mon) {
      // Empty slot: faint Pokéball placeholder
      ctx.globalAlpha = 0.15
      drawPokeball(ctx, sx + slotW / 2, sy + slotH / 2 - 8, 26)
      ctx.globalAlpha = 1
      ctx.font      = '13px sans-serif'
      ctx.fillStyle = '#555555'
      ctx.textAlign = 'center'
      ctx.fillText('Empty', sx + slotW / 2, sy + slotH / 2 + 26)
      continue
    }

    // ── Filled slot ────────────────────────────────────────────────────
    const displayName = mon.nickname ?? mon.name
    const hp          = mon.currentHp ?? mon.maxHp ?? 1
    const maxHp       = mon.maxHp ?? 1
    const hpRatio     = Math.max(0, Math.min(1, hp / maxHp))
    const isMain      = player.mainPokemonId === mon.id

    // Slot index badge
    ctx.font      = 'bold 11px sans-serif'
    ctx.fillStyle = '#FFFFFF'
    ctx.textAlign = 'left'
    ctx.fillText(`${i + 1}`, sx + 7, sy + 16)

    // MAIN badge
    if (isMain) {
      ctx.font      = 'bold 9px sans-serif'
      ctx.fillStyle = '#44DDAA'
      ctx.textAlign = 'right'
      ctx.fillText('MAIN', sx + slotW - 7, sy + 16)
    }

    // Shiny star
    if (mon.shiny) {
      const starX = sx + slotW - (isMain ? 46 : 7)
      ctx.font      = '12px sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText('✨', starX, sy + 16)
    }

    // Sprite — bigger, takes most of the slot height
    const maxSpr = Math.min(slotW * 0.82, 118)
    const sprX   = sx + slotW / 2 - maxSpr / 2
    const sprY   = sy + 14

    if (spr) {
      ctx.drawImage(spr, sprX, sprY, maxSpr, maxSpr)
    } else {
      ctx.globalAlpha = 0.3
      drawPokeball(ctx, sx + slotW / 2, sprY + maxSpr / 2, maxSpr * 0.32)
      ctx.globalAlpha = 1
    }

    // Name — truncate if needed
    ctx.font = 'bold 13px sans-serif'
    let name = displayName
    const maxNameW = slotW - 14
    while (ctx.measureText(name).width > maxNameW && name.length > 3) {
      name = name.slice(0, -1)
    }
    if (name !== displayName) name += '…'
    ctx.fillStyle = '#FFFFFF'
    ctx.textAlign = 'center'
    ctx.fillText(name, sx + slotW / 2, sy + slotH - 48)

    // Level
    ctx.font      = '11px sans-serif'
    ctx.fillStyle = '#AAAAAA'
    ctx.fillText(`Lv.${mon.level}`, sx + slotW / 2, sy + slotH - 34)

    // HP bar
    const barW = slotW - 18
    const barH = 7
    const barX = sx + 9
    const barY = sy + slotH - 22

    ctx.fillStyle = '#222222'
    ctx.beginPath()
    roundedRect(ctx, barX, barY, barW, barH, 3)
    ctx.fill()

    const fillW = Math.max(2, Math.round(barW * hpRatio))
    ctx.fillStyle = hpColor(hpRatio)
    ctx.beginPath()
    roundedRect(ctx, barX, barY, fillW, barH, 3)
    ctx.fill()

    // HP text
    ctx.font      = '9px sans-serif'
    ctx.fillStyle = '#AAAAAA'
    ctx.textAlign = 'center'
    ctx.fillText(`${hp}/${maxHp}`, sx + slotW / 2, sy + slotH - 8)
  }

  return canvas.toBuffer('image/png')
}
