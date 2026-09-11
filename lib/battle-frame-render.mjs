/**
 * battle-frame-render.mjs
 * Renders one battle turn as a still PNG or an animated GIF.
 *
 * Dependencies:
 *   @napi-rs/canvas   — canvas rendering
 *   gif-encoder-2     — animated GIF encoding
 *
 * Assets live in lib/assets/battle/ and are installed by
 * scripts/install-battle-assets.mjs. lib/battle-sprites.mjs decides which
 * filenames a given fight needs; this file loads them and draws.
 *
 * WHAT CHANGED, AND WHY
 * This module used to load exactly seven images at import time, four of which
 * did not exist, over HTTP. That meant: one body for all nine classes, the
 * monster icon standing in for a human opponent in PvP, one forest background
 * for every fight in the game, and the idle sheet substituted for attack,
 * hurt, dead and defend on every single turn. It also meant a dead tunnel
 * produced no battle image at all. Now:
 *
 *   • assets load from disk first and the remote map is only a fallback
 *   • sheets load lazily and are cached, so 21 body sheets cost nothing
 *     until a class actually fights
 *   • frame counts come from the file (width ÷ 128), because the shipped
 *     sheets disagree: 6-frame samurai swing, 5-frame shinobi, 4-frame fighter
 *   • a PvP opponent is drawn as their own class's body, mirrored, not as a
 *     monster icon
 *   • skills and ultimates have their own animation sheets
 *   • the arena comes from battle-sprites.mjs's scene table
 *
 * export async function renderBattleFrame(state)      → Buffer (GIF)
 * export async function renderBattleFrameStill(state) → Buffer (PNG)
 * export async function pickBattleFrame(state)        → { buffer, kind }
 *
 * state shape:
 * {
 *   turn: number,
 *   isPvp: boolean,
 *   isBoss: boolean,
 *   scene: 'wager'|'pvp'|'boss'|'dungeon'|'world'  (optional, derived if absent)
 *   seed: string                                    (optional, holds the arena still)
 *   left:  { name, classId, hp, maxHp, level, isDefending, activeEffects: [{type}] },
 *   right: { name, emoji, hp, maxHp, isBoss, animeBossId, level?, classId?,
 *            isPlayer?, tier?, activeEffects: [...] },
 *   lastAction: { actor:'left'|'right', kind, damage, skillName? } | null
 * }
 *
 * kind is one of hit | crit | miss | skill | defend | ultimate (anything else
 * reads as idle). 'ultimate' triggers a 12-frame cinematic; 'miss' stamps MISS
 * instead of a burst; a side at 0 HP appends a death frame.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas'
import GifEncoder from 'gif-encoder-2'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { resolveImageSource } from './image.js'
import { classArtCandidates, monsterSpriteFile, backgroundFor } from './battle-sprites.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const ASSET = p => join(__dir, 'assets', 'battle', p)

// ── Canvas / animation constants ─────────────────────────────────────────────
const W = 480, H = 270

const CHAR_FRAME_W = 128          // every character sheet uses 128×128 frames
const CHAR_FRAME_H = 128

// Drawn size of a character on the canvas. 1:1 with the source frame, so the
// pixel art never resamples. The bodies sit in the bottom two thirds of their
// frame (feet on the frame's last row), which is why the sprite box and the
// ground line below are the same number.
const SPRITE_BOX = 128
const GROUND_Y   = H - 30         // where every fighter's feet land

const MON_FRAME  = 32             // monster icons are 32×32, drawn ×4
const MON_SCALE  = 4

const DELAY_MS = 120   // per-frame delay for normal (non-ultimate) GIFs

// ── Render mode toggle ────────────────────────────────────────────────────────
// GIFs (renderBattleFrame) are the richer, animated output but cost more to
// encode per turn. RENDER_MODE controls what pickBattleFrame() produces:
//   'gif'         — always animated
//   'still'       — always a single static PNG (lighter, faster per turn)
//   'still-first' — try a still PNG; if that somehow fails, fall back to GIF
export const RENDER_MODE = 'still-first'

// ── Ultimate cinematic (12 frames @ 80 ms = ~960 ms) ─────────────────────────
const ULT_FRAMES = 12
const ULT_DELAY  = 80

// Each row: { t, arc, sx, sy, dark, flash, aura, freeze }
//   t      — attacker travel % toward target (0–1)
//   arc    — Y offset (negative = up)
//   sx/sy  — whole-canvas shake offset
//   dark   — black overlay alpha (0 = none, 0.5 = heavy)
//   flash  — full white frame
//   aura   — draw charge aura around attacker
//   freeze — hold sprite on frame 0 (charge-up pose)
const ULT_SEQ = [
  { t:0,    arc:0,   sx:0,  sy:0,  dark:0,   flash:false, aura:false, freeze:false }, // 0  rest
  { t:0,    arc:0,   sx:0,  sy:0,  dark:0.4, flash:false, aura:false, freeze:true  }, // 1  darken
  { t:0,    arc:-4,  sx:1,  sy:-1, dark:0.5, flash:false, aura:true,  freeze:true  }, // 2  charge
  { t:0,    arc:-4,  sx:-1, sy:1,  dark:0.5, flash:false, aura:true,  freeze:true  }, // 3  charge pulse
  { t:0.35, arc:-16, sx:0,  sy:0,  dark:0.3, flash:false, aura:true,  freeze:false }, // 4  lift-off
  { t:0.65, arc:-10, sx:0,  sy:0,  dark:0.1, flash:false, aura:false, freeze:false }, // 5  dash
  { t:0.95, arc:0,   sx:2,  sy:-2, dark:0,   flash:false, aura:false, freeze:false }, // 6  IMPACT
  { t:0.95, arc:0,   sx:-3, sy:2,  dark:0,   flash:true,  aura:false, freeze:false }, // 7  WHITE FLASH
  { t:0.95, arc:0,   sx:2,  sy:-1, dark:0,   flash:false, aura:false, freeze:false }, // 8  linger
  { t:0.35, arc:-5,  sx:0,  sy:0,  dark:0,   flash:false, aura:false, freeze:false }, // 9  return arc
  { t:0,    arc:0,   sx:0,  sy:0,  dark:0,   flash:false, aura:false, freeze:false }, // 10 home
  { t:0,    arc:0,   sx:0,  sy:0,  dark:0,   flash:false, aura:false, freeze:false }, // 11 idle
]

// ── Asset loading ────────────────────────────────────────────────────────────
// Local disk wins. lib/image.js's remote map is only consulted for a filename
// that is not on disk, which after scripts/install-battle-assets.mjs has run is
// none of them — so a booting bot makes no network calls for battle art and an
// offline VPS still draws fights.
//
// This must never throw. A missing PNG used to crash a top-level await, which
// killed the *import* of this module entirely: every file importing it
// (attack.js, skill.js, defend.js, dungeon.js, pvp.js) failed to load and
// silently degraded to plain text.
async function tryLoad(file) {
  const local = ASSET(file)
  if (existsSync(local)) {
    try { return await loadImage(readFileSync(local)) }
    catch (err) { console.error(`[battle-frame-render] unreadable asset ${file}: ${err.message}`) }
  }
  const mapped = resolveImageSource(file)
  if (/^https?:\/\//i.test(mapped)) {
    try {
      const res = await fetch(mapped)
      if (res.ok) return await loadImage(Buffer.from(await res.arrayBuffer()))
      console.error(`[battle-frame-render] remote fetch failed for ${file}: HTTP ${res.status}`)
    } catch (err) {
      console.error(`[battle-frame-render] remote fetch errored for ${file}: ${err.message}`)
    }
  }
  return null
}

// filename → Image | null. A null is cached too: a file that is missing now
// will still be missing on the next turn, and re-fetching it every turn was
// exactly how a dead URL turned into a per-message network stall.
const assetCache = new Map()

async function getAsset(file) {
  if (!file) return null
  if (!assetCache.has(file)) assetCache.set(file, await tryLoad(file))
  return assetCache.get(file)
}

/** First file in `files` that loads, or null. */
async function getFirstAsset(files) {
  for (const file of files) {
    const img = await getAsset(file)
    if (img) return img
  }
  return null
}

// The three fallbacks every codepath can end up needing. Preloaded so a broken
// asset folder is reported once at boot rather than per fight.
const [baseBackground, baseCharacter, baseMonster] = await Promise.all([
  getAsset('bg_arena.png').then(i => i ?? getAsset('background_default.png')),
  getAsset('character_default.png'),
  getAsset('monster_default.png'),
])

const ASSETS_READY = !!(baseBackground && baseCharacter)
if (!ASSETS_READY) {
  console.error(
    '[battle-frame-render] DISABLED: bg_arena.png / background_default.png or ' +
    'character_default.png could not be loaded from lib/assets/battle/. Battle ' +
    'frames will not render. Fix with: node scripts/install-battle-assets.mjs --force'
  )
} else if (!baseMonster) {
  console.error('[battle-frame-render] monster_default.png missing — monsters will draw as a plate until it is restored')
}

// ── Sprite resolution ────────────────────────────────────────────────────────
/**
 * One drawable fighter. `frames` is read off the sheet, never assumed:
 *   img    the loaded sheet (or a single image when frames === 1)
 *   fw/fh  source frame size
 *   frames how many frames the sheet holds
 *   flip   draw mirrored (the right-hand side always faces left)
 *   box    drawn size on canvas, square
 */
function spriteFrom(img, { fw, fh, flip = false, box = SPRITE_BOX }) {
  if (!img) return null
  const frames = Math.max(1, Math.floor(img.width / fw))
  return { img, fw, fh, frames, flip, box }
}

/** The pose a side should be drawn in for this turn. */
function poseForSide(state, side) {
  const me    = side === 'left' ? state.left : state.right
  const kind  = state.lastAction?.kind  ?? 'idle'
  const actor = state.lastAction?.actor ?? null
  const hurtKinds = kind === 'hit' || kind === 'crit'

  if ((me?.hp ?? 1) <= 0) return 'dead'
  if (actor === side) {
    if (kind === 'defend')   return 'defend'
    if (kind === 'ultimate') return 'ultimate'
    if (kind === 'skill')    return 'skill'
    // A whiff still swings: the attack sheet plays, the burst is replaced by the
    // MISS stamp. Leaving this on the idle pose was why a dodge read as nothing
    // happening at all.
    if (hurtKinds || kind === 'miss') return 'attack'
    return 'default'
  }
  // The other side acted. A landed blow makes this side flinch — including a
  // skill or an ultimate, which are the hardest hits in the game and used to
  // leave the target standing there idle.
  const tookDamage = (state.lastAction?.damage ?? 0) > 0
  if (hurtKinds || ((kind === 'skill' || kind === 'ultimate') && tookDamage)) return 'hurt'
  if (kind === 'defend' && me?.isDefending) return 'defend'
  return 'default'
}

/** A player-controlled fighter, from their class's sheet. */
async function resolveCharacter(who, pose, flip) {
  const img = await getFirstAsset(classArtCandidates(who?.classId, pose)) ?? baseCharacter
  return spriteFrom(img, { fw: CHAR_FRAME_W, fh: CHAR_FRAME_H, flip })
}

/**
 * A monster. Tries the per-family sprite from battle-sprites.mjs first, so the
 * procedural set from gen-battle-sprites.mjs is picked up the moment it exists,
 * then the single shared icon. Monster sheets are one frame of 32×32.
 */
async function resolveMonster(who) {
  const img = await getFirstAsset([monsterSpriteFile(who), 'monster_default.png']) ?? baseMonster
  if (!img) return null
  // A per-family sheet may be any square size; the shared icon is 32.
  const fw = img.height && img.width % img.height === 0 ? img.height : MON_FRAME
  return spriteFrom(img, { fw, fh: fw, flip: true, box: MON_FRAME * MON_SCALE })
}

/** Which arena this fight happens in. */
async function resolveBackground(state) {
  const scene = state.scene
    ?? (state.isPvp ? 'pvp' : state.isBoss ? 'boss' : state.isDungeon ? 'dungeon' : 'world')
  const seed = state.seed ?? `${state.left?.name ?? ''}|${state.right?.name ?? ''}`
  return await getAsset(backgroundFor(scene, seed)) ?? baseBackground
}

// ── Layout and timing ────────────────────────────────────────────────────────
// Both fighters stand on GROUND_Y. The attacker lunges toward the target;
// TRAVEL is capped so the two 128 px boxes overlap by about a dozen pixels at
// contact (the art is inset ~23 px on its leading edge) rather than one body
// landing on top of the other.
const L_X = 44
const R_X = W - 44 - SPRITE_BOX
const TRAVEL = Math.round((R_X - L_X) * 0.7)

/** The frame an attack sheet lands its hit on, whatever length it is. */
function impactIndex(frames) {
  if (frames <= 1) return 0
  return Math.min(frames - 1, Math.max(1, Math.round((frames - 1) * 0.6)))
}

/** Poses that move the fighter across the arena. Everything else plays in place. */
const TRAVELLING_POSES = new Set(['attack', 'skill', 'ultimate'])

/**
 * The per-frame plan for one pose: source frame, travel fraction, hop height,
 * and whether the hit lands on this frame.
 *
 * `travels` is what fixes the old bug. The sequence used to be chosen by frame
 * COUNT alone, so the shinobi's 4-frame Dead and 4-frame Shield sheets were
 * handed the attack sequence and slid across the arena while dying or blocking.
 * And the burst was stamped on a hardcoded frame 3, which is the wrong frame on
 * a 5- or 6-frame swing and does not exist at all on a 3-frame one.
 */
function makeSequence(frames, travels) {
  const imp = impactIndex(frames)
  const out = []
  for (let i = 0; i < frames; i++) {
    let t = 0
    if (travels) {
      t = i <= imp
        ? (imp === 0 ? 1 : i / imp)
        : Math.max(0, 1 - (i - imp) / Math.max(1, frames - 1 - imp))
    }
    out.push({
      f: i,
      t,
      arc: travels ? -Math.round(16 * Math.sin(Math.PI * t)) : 0,
      impact: travels && i === imp,
    })
  }
  return out
}

/**
 * Interleaves the two sides' sequences into one timeline. The sheets disagree on
 * length (a 6-frame samurai swing against a 2-frame hurt), so each side is
 * sampled proportionally across the shared step count instead of one side
 * freezing on its last frame while the other finishes.
 */
function planSteps(lSeq, rSeq) {
  const steps = Math.max(4, lSeq.length, rSeq.length)
  const pick = (seq, i) => seq[Math.min(seq.length - 1, Math.floor((i * seq.length) / steps))]
  const out = []
  for (let i = 0; i < steps; i++) out.push({ l: pick(lSeq, i), r: pick(rSeq, i) })
  return out
}

/** The 12-frame ultimate cinematic, driven by ULT_SEQ. */
function planUltimateSteps(actorSide, lSeq, rSeq) {
  const aSeq = actorSide === 'left' ? lSeq : rSeq
  const dSeq = actorSide === 'left' ? rSeq : lSeq
  const lastA = Math.max(0, aSeq.length - 1)
  const lastD = Math.max(0, dSeq.length - 1)
  return ULT_SEQ.map((u, i) => {
    const a = {
      f: u.freeze ? 0 : Math.min(lastA, Math.round((i / (ULT_FRAMES - 1)) * lastA)),
      t: u.t, arc: u.arc, impact: i === 6,
    }
    // The target only reacts once the blow has landed.
    const d = { f: i >= 7 ? lastD : 0, t: 0, arc: 0, impact: false }
    return {
      l: actorSide === 'left' ? a : d,
      r: actorSide === 'left' ? d : a,
      sx: u.sx, sy: u.sy, dark: u.dark, flash: u.flash,
      aura: u.aura ? actorSide : null,
    }
  })
}

/** The step a still PNG should freeze on: the moment of contact, else the rest pose. */
function stillStep(steps) {
  const i = steps.findIndex(s => s.l?.impact || s.r?.impact)
  return i >= 0 ? i : 0
}

// ── Drawing primitives ───────────────────────────────────────────────────────
/** One frame of one fighter. The right-hand side is always mirrored to face left. */
function drawActor(ctx, actor, frameIdx, x, y) {
  if (!actor) return
  const f = Math.max(0, Math.min(actor.frames - 1, Math.floor(frameIdx)))
  const sx = f * actor.fw
  const sh = Math.min(actor.fh, actor.img.height)
  if (!actor.flip) {
    ctx.drawImage(actor.img, sx, 0, actor.fw, sh, x, y, actor.box, actor.box)
    return
  }
  ctx.save()
  ctx.translate(x + actor.box, y)
  ctx.scale(-1, 1)
  ctx.drawImage(actor.img, sx, 0, actor.fw, sh, 0, 0, actor.box, actor.box)
  ctx.restore()
}

/** Contact shadow, so a fighter reads as standing on the floor instead of floating. */
function drawShadow(ctx, cx, box, lift = 0) {
  const squash = Math.max(0.35, 1 - Math.abs(lift) / 40)
  ctx.save()
  ctx.globalAlpha = 0.3 * squash
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.ellipse(cx, GROUND_Y + 3, box * 0.26 * squash, 5 * squash, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function hpColor(frac) {
  if (frac > 0.5) return '#42d94f'
  if (frac > 0.25) return '#f0c033'
  return '#e5484d'
}

/** A slim HP bar with a dark trough, so it reads over any background. */
function drawHpBar(ctx, x, y, w, h, hp, maxHp) {
  const frac = Math.max(0, Math.min(1, (hp ?? 0) / Math.max(1, maxHp ?? 1)))
  ctx.fillStyle = 'rgba(0,0,0,0.62)'
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2)
  ctx.fillStyle = '#20242c'
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = hpColor(frac)
  ctx.fillRect(x, y, Math.round(w * frac), h)
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
}

/** Text with a hard drop shadow. Backgrounds vary too much for plain white. */
function drawLabel(ctx, text, x, y, { font = 'bold 13px sans-serif', align = 'left', fill = '#fff' } = {}) {
  ctx.save()
  ctx.font = font
  ctx.textAlign = align
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = 'rgba(0,0,0,0.85)'
  ctx.fillText(text, x + 1, y + 1)
  ctx.fillStyle = fill
  ctx.fillText(text, x, y)
  ctx.restore()
}

// Only the statuses a fighter can visibly carry between turns get a pip. The
// colours match the effect families in lib/effects.js.
const STATUS_COLORS = {
  burn: '#ff7a2f', poison: '#8ddb3a', freeze: '#6fd8f5', stun: '#ffd53a',
  blind: '#8a8f9c', weaken: '#c46fd8', shred_res: '#c46fd8',
  strengthen: '#ff5a5a', haste: '#5affd0', regen: '#48e07a',
  shield: '#7fb8ff', reflect: '#ffffff', tear: '#e5484d', sever: '#a01020',
}

/** A row of status pips under a name plate. */
function drawStatusBadges(ctx, effects, x, y, align = 'left') {
  const seen = []
  for (const e of effects ?? []) {
    const c = STATUS_COLORS[e?.type]
    if (c && !seen.includes(e.type)) seen.push(e.type)
    if (seen.length >= 6) break
  }
  if (!seen.length) return
  const r = 3.5, gap = 10
  seen.forEach((type, i) => {
    const cx = align === 'left' ? x + r + i * gap : x - r - (seen.length - 1 - i) * gap
    ctx.beginPath()
    ctx.arc(cx, y, r, 0, Math.PI * 2)
    ctx.fillStyle = STATUS_COLORS[type]
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.7)'
    ctx.lineWidth = 1
    ctx.stroke()
  })
}

const PLATE_W = 186
const PLATE_H = 32

/**
 * Name, level and HP for one side. Deliberately no emoji: the bundled font set
 * on a headless VPS renders most of them as tofu boxes, and a monster's emoji is
 * already in the caption text.
 */
function drawNamePlate(ctx, who, x, y, align = 'left') {
  const px = align === 'left' ? x : x - PLATE_W
  const inner = align === 'left' ? px + 7 : x - 7
  const name = String(who?.name ?? '???').slice(0, 18)
  const hp = Math.max(0, Math.round(who?.hp ?? 0))
  const maxHp = Math.max(1, Math.round(who?.maxHp ?? 1))

  ctx.fillStyle = 'rgba(8,10,14,0.5)'
  ctx.fillRect(px, y, PLATE_W, PLATE_H)
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 1
  ctx.strokeRect(px + 0.5, y + 0.5, PLATE_W - 1, PLATE_H - 1)

  drawLabel(ctx, name, inner, y + 13, { align, font: 'bold 13px sans-serif' })
  const meta = `${who?.level ? `Lv ${who.level}  ` : ''}${hp}/${maxHp}`
  drawLabel(ctx, meta, align === 'left' ? px + PLATE_W - 7 : px + 7, y + 13, {
    align: align === 'left' ? 'right' : 'left',
    font: '10px sans-serif',
    fill: 'rgba(255,255,255,0.78)',
  })
  drawHpBar(ctx, px + 7, y + 19, PLATE_W - 14, 7, hp, maxHp)
  drawStatusBadges(ctx, who?.activeEffects, inner, y + PLATE_H + 8, align)
}

/** "TURN 4" centred at the top, so a still frame still says where the fight is. */
function drawTurnCounter(ctx, turn) {
  const n = Number(turn)
  if (!Number.isFinite(n) || n <= 0) return
  drawLabel(ctx, `TURN ${n}`, W / 2, 20, {
    align: 'center', font: 'bold 12px sans-serif', fill: 'rgba(255,255,255,0.9)',
  })
}

// ── Impact effects ───────────────────────────────────────────────────────────
/** A spiked star at the point of contact. Crits get a second, wider ring. */
function drawImpactBurst(ctx, cx, cy, isCrit = false) {
  const spikes = isCrit ? 12 : 8
  const outer = isCrit ? 34 : 24
  const inner = outer * 0.44
  ctx.save()
  ctx.translate(cx, cy)
  ctx.beginPath()
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = (Math.PI * i) / spikes - Math.PI / 2
    const px = Math.cos(a) * r, py = Math.sin(a) * r
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fillStyle = isCrit ? 'rgba(255,214,64,0.92)' : 'rgba(255,255,255,0.85)'
  ctx.fill()
  ctx.strokeStyle = isCrit ? 'rgba(255,90,40,0.95)' : 'rgba(255,180,60,0.9)'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.restore()
}

/** The charge-up glow around an ultimate's caster. */
function drawChargeAura(ctx, cx, cy, r) {
  const g = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r)
  g.addColorStop(0, 'rgba(255,246,180,0.85)')
  g.addColorStop(0.45, 'rgba(255,140,40,0.42)')
  g.addColorStop(1, 'rgba(255,80,20,0)')
  ctx.save()
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** The ultimate's landing: a shockwave ring plus radiating slashes. */
function drawUltimateBurst(ctx, cx, cy) {
  ctx.save()
  ctx.translate(cx, cy)
  for (const [r, a, w] of [[62, 0.9, 5], [40, 0.7, 3], [22, 0.5, 2]]) {
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255,255,255,${a})`
    ctx.lineWidth = w
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(255,196,64,0.9)'
  ctx.lineWidth = 3
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI * 2 * i) / 10
    ctx.beginPath()
    ctx.moveTo(Math.cos(a) * 26, Math.sin(a) * 26)
    ctx.lineTo(Math.cos(a) * 74, Math.sin(a) * 74)
    ctx.stroke()
  }
  ctx.restore()
  drawImpactBurst(ctx, cx, cy, true)
}

/** The skill name banner across the middle of an ultimate frame. */
function drawUltimateLabel(ctx, text) {
  const label = String(text ?? 'ULTIMATE').toUpperCase().slice(0, 26)
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillRect(0, H / 2 - 22, W, 40)
  drawLabel(ctx, label, W / 2, H / 2 + 6, {
    align: 'center', font: 'bold 26px sans-serif', fill: '#ffd76a',
  })
  ctx.restore()
}

/** MISS, stamped over the fighter who dodged, at a jaunty angle. */
function drawMissStamp(ctx, cx, cy) {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(-0.16)
  ctx.font = 'bold 30px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 5
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.strokeText('MISS', 0, 0)
  ctx.fillStyle = '#e8eef7'
  ctx.fillText('MISS', 0, 0)
  ctx.restore()
}

/** The damage that just landed, floating over the fighter who took it. */
function drawDamageNumber(ctx, cx, cy, damage, isCrit = false) {
  const n = Math.round(Number(damage) || 0)
  if (n <= 0) return
  ctx.save()
  ctx.font = `bold ${isCrit ? 28 : 22}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 4
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.strokeText(`-${n}`, cx, cy)
  ctx.fillStyle = isCrit ? '#ffd23a' : '#ff6b6b'
  ctx.fillText(`-${n}`, cx, cy)
  ctx.restore()
}

/** The defeat stamp on a side that hit 0 HP this turn. */
function drawDeathFrame(ctx, cx) {
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.34)'
  ctx.fillRect(0, 0, W, H)
  ctx.restore()
  drawLabel(ctx, 'DEFEATED', cx, GROUND_Y - SPRITE_BOX - 8, {
    align: 'center', font: 'bold 22px sans-serif', fill: '#ff5a5a',
  })
}

/** Stand-in plate for a fighter whose art could not be loaded at all. */
function drawMissingActor(ctx, who, x, box) {
  const y = GROUND_Y - box
  ctx.save()
  ctx.fillStyle = 'rgba(12,14,20,0.72)'
  ctx.fillRect(x + box * 0.2, y + box * 0.25, box * 0.6, box * 0.7)
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'
  ctx.lineWidth = 2
  ctx.strokeRect(x + box * 0.2, y + box * 0.25, box * 0.6, box * 0.7)
  ctx.restore()
  drawLabel(ctx, String(who?.name ?? '?').slice(0, 1).toUpperCase(), x + box / 2, y + box * 0.72, {
    align: 'center', font: 'bold 34px sans-serif',
  })
}

// ── Scene ────────────────────────────────────────────────────────────────────
/**
 * Everything one turn needs, resolved once. Both the GIF and the PNG path go
 * through this, so the animated and the static output can never drift apart.
 */
async function buildScene(state) {
  const kind  = state.lastAction?.kind  ?? 'idle'
  const actor = state.lastAction?.actor ?? null
  const leftPose  = poseForSide(state, 'left')
  const rightPose = poseForSide(state, 'right')
  // In a duel the opponent is another player, so they are drawn from their own
  // class sheet and mirrored. Only a real monster gets the monster art.
  const rightIsPlayer = !!(state.isPvp || state.right?.isPlayer || state.right?.classId)

  const [bg, left, right] = await Promise.all([
    resolveBackground(state),
    resolveCharacter(state.left, leftPose, false),
    rightIsPlayer ? resolveCharacter(state.right, rightPose, true) : resolveMonster(state.right),
  ])

  const lSeq = makeSequence(left?.frames ?? 1, TRAVELLING_POSES.has(leftPose))
  const rSeq = makeSequence(right?.frames ?? 1, TRAVELLING_POSES.has(rightPose))
  const isUlt = kind === 'ultimate' && (actor === 'left' || actor === 'right')
  const steps = isUlt ? planUltimateSteps(actor, lSeq, rSeq) : planSteps(lSeq, rSeq)

  return { state, bg, left, right, steps, kind, actor, isUlt }
}

/**
 * Paints one step of a scene onto a 2D context. Everything that moves lives
 * inside the shake transform; the background and the HUD stay put so a camera
 * shake never leaves a bare edge or makes the HP bars jitter.
 */
function drawStep(c, scene, index, { final = false } = {}) {
  const { state, bg, left, right, steps, kind, actor, isUlt } = scene
  const i = Math.max(0, Math.min(steps.length - 1, index))
  const step = steps[i]

  if (bg) c.drawImage(bg, 0, 0, W, H)
  else { c.fillStyle = '#0d1017'; c.fillRect(0, 0, W, H) }
  if (step.dark) { c.fillStyle = `rgba(0,0,0,${step.dark})`; c.fillRect(0, 0, W, H) }

  const lBox = left?.box ?? SPRITE_BOX
  const rBox = right?.box ?? SPRITE_BOX
  const lx = L_X + step.l.t * TRAVEL
  const rx = R_X - step.r.t * TRAVEL
  const lcx = lx + lBox / 2
  const rcx = rx + rBox / 2

  c.save()
  c.translate(step.sx ?? 0, step.sy ?? 0)

  drawShadow(c, lcx, lBox, step.l.arc)
  drawShadow(c, rcx, rBox, step.r.arc)
  if (step.aura === 'left')  drawChargeAura(c, lcx, GROUND_Y - lBox * 0.5, lBox * 0.72)
  if (step.aura === 'right') drawChargeAura(c, rcx, GROUND_Y - rBox * 0.5, rBox * 0.72)

  // The attacker is painted last so it overlaps the fighter it is closing on.
  const paintLeft  = () => left  ? drawActor(c, left,  step.l.f, lx, GROUND_Y - lBox + step.l.arc)
                                 : drawMissingActor(c, state.left,  lx, lBox)
  const paintRight = () => right ? drawActor(c, right, step.r.f, rx, GROUND_Y - rBox + step.r.arc)
                                 : drawMissingActor(c, state.right, rx, rBox)
  if (actor === 'right') { paintLeft(); paintRight() } else { paintRight(); paintLeft() }

  // Contact. The target is whoever did not act.
  const landed = (actor === 'left' && step.l.impact) || (actor === 'right' && step.r.impact)
  if (landed) {
    const tcx = actor === 'left' ? rcx : lcx
    const tBox = actor === 'left' ? rBox : lBox
    const tcy = GROUND_Y - tBox * 0.55
    if (kind === 'miss') {
      drawMissStamp(c, tcx, tcy - 18)
    } else if (kind !== 'defend') {
      if (isUlt) drawUltimateBurst(c, tcx, tcy)
      else drawImpactBurst(c, tcx, tcy, kind === 'crit')
      // Sits close to the burst on purpose: a DEFEATED stamp lands higher up on
      // the same column and the two must not collide.
      drawDamageNumber(c, tcx, tcy - 24, state.lastAction?.damage, kind === 'crit')
    }
  }
  c.restore()

  if (step.flash) { c.fillStyle = 'rgba(255,255,255,0.9)'; c.fillRect(0, 0, W, H) }
  if (isUlt && i >= 6 && i <= 8) drawUltimateLabel(c, state.lastAction?.skillName)

  drawNamePlate(c, state.left, 10, 30, 'left')
  drawNamePlate(c, state.right, W - 10, 30, 'right')
  drawTurnCounter(c, state.turn)

  if (final) {
    if ((state.left?.hp ?? 1) <= 0) drawDeathFrame(c, lcx)
    else if ((state.right?.hp ?? 1) <= 0) drawDeathFrame(c, rcx)
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────
/**
 * renderBattleFrame(state) → Buffer (animated GIF)
 *
 * The full animated turn: normal moves get ~4 frames at 120 ms, ultimates get
 * 12 frames at 80 ms. A dead fighter appends one held frame so the DEFEATED
 * stamp is not just a blink.
 */
export async function renderBattleFrame(state) {
  if (!ASSETS_READY) return null
  const scene = await buildScene(state)
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  const delay = scene.isUlt ? ULT_DELAY : DELAY_MS
  const enc = new GifEncoder(W, H)
  enc.start()
  enc.setRepeat(0)
  enc.setDelay(delay)
  enc.setQuality(10)

  for (let i = 0; i < scene.steps.length; i++) {
    drawStep(ctx, scene, i)
    enc.addFrame(ctx)
  }
  // Death frame — held for 600 ms so it reads, then loops back to the rest pose.
  const lDead = (state.left?.hp ?? 1) <= 0
  const rDead = (state.right?.hp ?? 1) <= 0
  if (lDead || rDead) {
    drawStep(ctx, scene, 0, { final: true })
    for (let i = 0; i < Math.ceil(600 / delay); i++) enc.addFrame(ctx)
  }
  enc.finish()
  return enc.out.getData()
}

/**
 * renderBattleFrameStill(state) → Buffer (PNG)
 *
 * A single frozen frame: the moment of impact if there is one, otherwise the
 * rest pose. Lighter and faster than the GIF, so pickBattleFrame can try this
 * first and only fall back to the animated path if the PNG somehow fails.
 */
export async function renderBattleFrameStill(state) {
  if (!ASSETS_READY) return null
  const scene = await buildScene(state)
  const i = stillStep(scene.steps)
  const lDead = (state.left?.hp ?? 1) <= 0
  const rDead = (state.right?.hp ?? 1) <= 0
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  drawStep(ctx, scene, i, { final: lDead || rDead })
  return canvas.toBuffer('image/png')
}

/**
 * pickBattleFrame(state) → { buffer: Buffer | null, kind: 'gif' | 'png' | null }
 *
 * Chooses what to render based on RENDER_MODE, then does it. The mode toggle
 * exists so a production bot can cut the GIF encoder out of the hot path
 * (faster, lighter per turn) and still have the animated output available for
 * a test or a preview.
 */
export async function pickBattleFrame(state) {
  if (!ASSETS_READY) return { buffer: null, kind: null }
  if (RENDER_MODE === 'gif') return { buffer: await renderBattleFrame(state), kind: 'gif' }
  if (RENDER_MODE === 'still') return { buffer: await renderBattleFrameStill(state), kind: 'png' }
  // 'still-first' (default) — try PNG, fall back to GIF only on failure.
  try {
    const buf = await renderBattleFrameStill(state)
    if (buf) return { buffer: buf, kind: 'png' }
  } catch (err) {
    console.error('[battle-frame-render] still render failed, falling back to GIF:', err.message)
  }
  return { buffer: await renderBattleFrame(state), kind: 'gif' }
}

/**
 * What happened this turn, when the caller did not spell it out.
 *
 * Only dungeon.js passes an explicit lastAction (null, for the spawn frame).
 * attack.js, skill.js, defend.js, party.js and pvp.js pass the HP both sides
 * held before the turn plus the text they are about to send, so the pose is read
 * back out of those two. HP deltas decide WHO acted (they are engine truth and
 * always present); the text only decides the flavour on top. Without this every
 * PvE turn rendered as two fighters standing still, which is exactly the bug the
 * new pose sheets exist to fix.
 */
function deriveLastAction({ player, e, msg, hpBeforeTurn, eHpBeforeTurn, isDefending }) {
  const text  = String(msg ?? '')
  const dealt = Math.max(0, Math.round((eHpBeforeTurn ?? e?.hp ?? 0) - (e?.hp ?? 0)))
  const taken = Math.max(0, Math.round((hpBeforeTurn ?? player?.hp ?? 0) - (player?.hp ?? 0)))

  const skillName = text.match(/uses \*([^*]+)\*/)?.[1] ?? null
  const isUlt     = /\bULTIMATE\b|DOMAIN EXPANSION|UNLIMITED VOID/.test(text)
  const isSkill   = !!skillName || /✨ \*/.test(text)
  const crit      = /\*CRIT!\*/.test(text)

  if (dealt > 0) {
    const kind = isUlt ? 'ultimate' : isSkill ? 'skill' : crit ? 'crit' : 'hit'
    return { actor: 'left', kind, damage: dealt, skillName }
  }
  // Nothing landed on the enemy. Either the player whiffed, braced, or the
  // enemy's own move is the only thing that happened.
  if (/💨|attacks \*[^*]+\*\.\.\. and \*MISSES!\*/.test(text)) {
    return { actor: 'left', kind: 'miss', damage: 0 }
  }
  if (isDefending || /\* (defends|BRACES FOR IMPACT)/.test(text)) {
    return { actor: 'left', kind: 'defend', damage: 0 }
  }
  if (taken > 0) return { actor: 'right', kind: crit ? 'crit' : 'hit', damage: taken }
  if (/(strikes back|retaliates)[^\n]*\*MISSES!\*/.test(text)) {
    return { actor: 'right', kind: 'miss', damage: 0 }
  }
  return null
}

/**
 * sendBattleTurnReply(ctx, opts) — the top-level entry every plugin calls.
 *
 * Renders the frame and sends it, falling back to a plain-text reply when
 * rendering fails or ASSETS_READY is false. Every call site passes at least:
 *   player, e, msg, hpBeforeTurn, eHpBeforeTurn
 *
 * Optional fields on opts:
 *   boss            → boss engine state, sets isBoss and scene
 *   isPvp           → marks the fight as PvP, scene = 'pvp'
 *   isDefending     → the player is blocking, pose = 'defend'
 *   lastAction      → { actor: 'left'|'right', kind, damage, skillName }
 *   isDungeon       → dungeon fight, scene = 'dungeon' unless boss overrides
 *
 * PvP opponents are drawn from their own class sheet. The caller must pass
 * e.classId (and optionally e.isPlayer = true) so the right-hand side knows to
 * load a character sheet instead of a monster sprite.
 */
export async function sendBattleTurnReply(ctx, opts) {
  const { player, e, msg, hpBeforeTurn, eHpBeforeTurn, boss, isPvp, lastAction, isDungeon } = opts
  const isBoss = !!(boss?.isBoss || e?.isBoss)
  const scene = isPvp ? 'pvp' : isBoss ? 'boss' : isDungeon ? 'dungeon' : 'world'
  const turn = player?.battleState?.turn ?? boss?.turnNumber ?? 1

  const state = {
    turn,
    isPvp: !!isPvp,
    isBoss,
    isDungeon: !!isDungeon,
    scene,
    seed: isPvp ? `${player?.name ?? ''}|${e?.name ?? ''}` : `${e?.name ?? ''}|${turn}`,
    left: {
      name: player?.name,
      classId: player?.classId,
      hp: player?.hp ?? 0,
      maxHp: player?.maxHp ?? 1,
      level: player?.level,
      isDefending: opts.isDefending ?? player?.battleState?.defending ?? false,
      activeEffects: player?.activeEffects ?? [],
    },
    right: {
      name: e?.name,
      emoji: e?.emoji,
      hp: e?.hp ?? 0,
      maxHp: e?.maxHp ?? 1,
      isBoss,
      animeBossId: boss?.animeBossId,
      level: e?.level,
      classId: e?.classId,
      isPlayer: e?.isPlayer,
      tier: e?.tier,
      activeEffects: e?.activeEffects ?? [],
    },
    // An explicit lastAction always wins, including an explicit null: that is
    // dungeon.js asking for the spawn frame, where nothing has happened yet.
    lastAction: 'lastAction' in opts ? lastAction : deriveLastAction(opts),
  }

  let frame = null
  let kind = null
  try {
    const res = await pickBattleFrame(state)
    frame = res.buffer
    kind = res.kind
  } catch (err) {
    console.error('[battle-frame-render] sendBattleTurnReply render failed:', err)
  }

  if (!frame) return ctx.reply(msg)
  // A GIF has to go out as a looping video: sending an animated GIF through
  // replyImage shows the first frame only, which would silently throw away the
  // entire animation. replyGif handles the transcode and falls back to a still
  // itself, so this only has to check the method exists (test harnesses stub
  // replyImage alone).
  if (kind === 'gif' && typeof ctx.replyGif === 'function') return ctx.replyGif(frame, msg)
  return ctx.replyImage(frame, msg)
}
