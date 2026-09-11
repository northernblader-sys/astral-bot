/**
 * pokemon-battle-render.mjs
 * Renders one PNG battle frame per turn for Pokémon-vs-Pokémon battles.
 *
 * Unlike lib/battle-frame-render.mjs (fixed local character/monster PNGs),
 * both combatants here are real Pokémon, so their artwork is fetched live
 * per dex id from PokéAPI's sprite CDN (same URLs lib/pokemon-engine.js
 * already builds via artworkUrl()) and cached in-memory by URL so a long
 * battle doesn't re-fetch the same two sprites every turn.
 *
 * Background: expects an image at assets/battle/pokemon_background.png
 * (relative to this file). If it's not there yet, rendering falls back to
 * a flat gradient instead of failing — drop the PNG in whenever it's ready
 * and it'll be picked up automatically, no code change needed.
 *
 * export async function renderPokemonBattleFrame(state) → Buffer (PNG)
 *
 * state shape:
 * {
 *   left:  { name, image, hp, maxHp, level, shiny },
 *   right: { name, image, hp, maxHp, level, shiny },
 *   lastAction: { actor: 'left'|'right', kind: 'hit'|'crit'|'miss', damage: number|null } | null
 * }
 */
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { resolveImageSource } from './image.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const BG_PATH = join(__dir, 'assets', 'battle', 'pokemon_background.png')

const W = 480, H = 270
const SPRITE_W = 120, SPRITE_H = 120
const L_X = 60,  L_Y = 110
const R_X = 300, R_Y = 60

// ── Background: loaded once, non-throwing if missing ────────────────────
// Checks lib/image.js's remote IMAGES map first (pokemon_background.png →
// pokemon-battle-ground.jpg on ImgBB), then falls back to local disk at
// BG_PATH, then to the flat gradient if neither is available.
let imgBackground = null
try {
  const mapped = resolveImageSource('pokemon_background.png')
  if (/^https?:\/\//i.test(mapped)) {
    const res = await fetch(mapped)
    if (res.ok) {
      imgBackground = await loadImage(Buffer.from(await res.arrayBuffer()))
    } else {
      throw new Error(`remote fetch HTTP ${res.status}`)
    }
  } else {
    imgBackground = await loadImage(readFileSync(BG_PATH))
  }
} catch (err) {
  console.error(
    `[pokemon-battle-render] no background available (${err.message}) — using a flat ` +
    `fallback gradient until one is added, drop the PNG in ${BG_PATH} and it'll be used automatically.`
  )
}

function drawFallbackBackground(ctx) {
  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, '#8fd0ea')
  grad.addColorStop(1, '#4a9e6b')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)
}

// ── Remote sprite cache (per battle process, keyed by URL) ──────────────
const spriteCache = new Map()

async function loadSprite(url) {
  if (!url) return null
  if (spriteCache.has(url)) return spriteCache.get(url)
  const p = (async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      return await loadImage(buf)
    } catch (err) {
      console.error(`[pokemon-battle-render] failed to load sprite ${url}:`, err.message)
      return null
    }
  })()
  spriteCache.set(url, p)
  return p
}

// ── HP bar ────────────────────────────────────────────────────────────────
function hpColor(pct) {
  if (pct > 0.50) return '#48c840'
  if (pct > 0.20) return '#f8d030'
  return '#f03030'
}

function drawHpBar(ctx, x, y, w, hp, maxHp) {
  const pct = Math.max(0, Math.min(1, hp / Math.max(1, maxHp)))
  ctx.fillStyle = '#303030'
  ctx.fillRect(x, y, w, 8)
  ctx.fillStyle = hpColor(pct)
  ctx.fillRect(x, y, Math.round(w * pct), 8)
  ctx.strokeStyle = '#000'
  ctx.lineWidth = 1
  ctx.strokeRect(x, y, w, 8)
}

function drawLabel(ctx, text, x, y, opts = {}) {
  const { size = 12, color = '#fff', align = 'left' } = opts
  ctx.font = `bold ${size}px sans-serif`
  ctx.textAlign = align
  ctx.fillStyle = '#000'
  ctx.fillText(text, x + 1, y + 1)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  ctx.textAlign = 'left'
}

function drawNamePlate(ctx, name, level, hp, maxHp, x, y, align) {
  drawLabel(ctx, `${name}  Lv.${level}`, x, y, { size: 13, align })
  const barX = align === 'right' ? x - 130 : x
  drawHpBar(ctx, barX, y + 6, 130, hp, maxHp)
  drawLabel(ctx, `${Math.max(0, hp)}/${maxHp}`, barX + 130, y + 24, { size: 9, align: 'right' })
}

// ── Impact burst (pixel-art starburst on a hit/crit) ──────────────────────
function drawImpactBurst(ctx, cx, cy, crit) {
  const ix = Math.round(cx), iy = Math.round(cy)
  ctx.fillStyle = crit ? '#ffd700' : '#ffffff'
  ctx.fillRect(ix - 16, iy - 2, 32, 4)
  ctx.fillRect(ix - 2, iy - 16, 4, 32)
  ctx.fillStyle = crit ? '#ff8800' : '#ffd700'
  for (const d of [8, 14]) {
    ctx.fillRect(ix + d - 1, iy + d - 1, 3, 3)
    ctx.fillRect(ix - d - 1, iy + d - 1, 3, 3)
    ctx.fillRect(ix + d - 1, iy - d - 1, 3, 3)
    ctx.fillRect(ix - d - 1, iy - d - 1, 3, 3)
  }
}

function drawMissStamp(ctx, x, y) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(-0.15)
  drawLabel(ctx, 'MISS', 0, 0, { size: 20, color: '#ddd', align: 'center' })
  ctx.restore()
}

/**
 * Renders a single PNG frame for the given turn state.
 * Never throws — on any sprite-load failure it just draws a placeholder
 * silhouette box in that spot instead of failing the whole battle turn.
 */
export async function renderPokemonBattleFrame(state) {
  const { left, right, lastAction } = state
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false

  if (imgBackground) ctx.drawImage(imgBackground, 0, 0, W, H)
  else drawFallbackBackground(ctx)

  const [leftSprite, rightSprite] = await Promise.all([
    loadSprite(left.image),
    loadSprite(right.image),
  ])

  // Left Pokémon (ground level, facing right — mirrored so it faces its opponent)
  ctx.save()
  if (leftSprite) {
    ctx.translate(L_X + SPRITE_W, L_Y)
    ctx.scale(-1, 1)
    ctx.drawImage(leftSprite, 0, 0, SPRITE_W, SPRITE_H)
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(L_X, L_Y, SPRITE_W, SPRITE_H)
  }
  ctx.restore()

  // Right Pokémon (elevated slightly, facing left — standard "wild" placement)
  if (rightSprite) {
    ctx.drawImage(rightSprite, R_X, R_Y, SPRITE_W, SPRITE_H)
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(R_X, R_Y, SPRITE_W, SPRITE_H)
  }

  // Impact effects on top of whichever side just got hit
  if (lastAction && !lastAction.miss && lastAction.kind !== 'miss') {
    const targetIsLeft = lastAction.actor === 'right'
    const cx = targetIsLeft ? L_X + SPRITE_W / 2 : R_X + SPRITE_W / 2
    const cy = targetIsLeft ? L_Y + SPRITE_H / 2 : R_Y + SPRITE_H / 2
    drawImpactBurst(ctx, cx, cy, lastAction.kind === 'crit')
  }
  if (lastAction?.kind === 'miss') {
    const targetIsLeft = lastAction.actor === 'right'
    drawMissStamp(ctx, targetIsLeft ? L_X + SPRITE_W / 2 : R_X + SPRITE_W / 2, 40)
  }

  // Name plates + HP bars
  drawNamePlate(ctx, left.name,  left.level,  left.hp,  left.maxHp,  16, H - 16, 'left')
  drawNamePlate(ctx, right.name, right.level, right.hp, right.maxHp, W - 16, 30, 'right')

  return canvas.toBuffer('image/png')
}

/**
 * sendPokemonBattleTurnReply — shared per-turn reply helper, mirrors
 * lib/battle-frame-render.mjs's sendBattleTurnReply but for Pokémon.
 * Falls back to a plain text reply if rendering fails for any reason.
 */
export async function sendPokemonBattleTurnReply(ctx, { left, right, msg, lastAction }) {
  let frame = null
  try {
    frame = await renderPokemonBattleFrame({ left, right, lastAction })
  } catch (err) {
    console.error('[pokemon-battle-render] sendPokemonBattleTurnReply render failed:', err)
  }
  if (frame) return ctx.replyImage(frame, msg)
  return ctx.reply(msg)
}
