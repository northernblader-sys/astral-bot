/**
 * lib/tourney-bracket-render.mjs
 * Renders the tournament bracket as an actual image instead of the text
 * board in plugins/tourney.js's renderBracket() — one rounded rectangle
 * "box" per player slot, black background, round-by-round columns with
 * thin connector lines joining each pair into the next round's box,
 * exactly like a normal bracket poster.
 *
 * Kept as a pure render function (tourney record in -> PNG buffer out),
 * same shape as renderProfileCard()/lib/battle-frame-render.mjs, so
 * plugins/tourney.js just does:
 *
 *   import { renderBracketImage } from '../lib/tourney-bracket-render.mjs'
 *   const png = await renderBracketImage(t)
 *   await ctx.replyImage(png, caption)
 *
 * No player pfps/banners are involved here — this is names-in-boxes only,
 * so there's no tryLoad()/network-fetch path like profile-card-render.mjs
 * has. That also means this never fails to render for missing assets.
 */
import './fonts.js' // registers bundled fonts before any canvas draw — see lib/fonts.js
import { createCanvas } from '@napi-rs/canvas'

// ── Layout constants ────────────────────────────────────────────────────
const BOX_W = 240
const BOX_H = 64
const COL_GAP = 90        // horizontal gap between round columns
const ROW_GAP = 28        // vertical gap between adjacent round-1 boxes
const PAD = 50            // outer canvas padding
const HEADER_H = 96       // title + pool line

const BG = '#0b0b0b'
const BOX_FILL = '#141414'
const BOX_STROKE = 'rgba(255,255,255,0.18)'
const WINNER_STROKE = '#f5c542'
const LINE_COLOR = 'rgba(255,255,255,0.28)'
const TEXT_COLOR = '#f2f2f2'
const DIM_TEXT = 'rgba(242,242,242,0.45)'
const CROWN = '#f5c542'

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Shrinks the font size until `text` fits within `maxWidth`, floor 12px. */
function fitFont(ctx, text, maxWidth, startSize) {
  let size = startSize
  ctx.font = `bold ${size}px sans-serif`
  while (ctx.measureText(text).width > maxWidth && size > 12) {
    size -= 1
    ctx.font = `bold ${size}px sans-serif`
  }
  return size
}

function roundName(totalRounds, idx) {
  const remaining = totalRounds - idx
  if (remaining === 1) return 'FINAL'
  if (remaining === 2) return 'SEMIFINALS'
  if (remaining === 3) return 'QUARTERFINALS'
  return `ROUND ${idx + 1}`
}

/**
 * Draws one player-slot box at (x, y). `label` is the player name, `—` for
 * an empty/unfilled slot, or `BYE` for an auto-passed slot. `won` draws a
 * gold border + crown to mark the round's winner for that box.
 */
function drawBox(ctx, x, y, label, { won = false, empty = false } = {}) {
  roundedRectPath(ctx, x, y, BOX_W, BOX_H, 10)
  ctx.fillStyle = BOX_FILL
  ctx.fill()
  ctx.lineWidth = won ? 2.5 : 1.5
  ctx.strokeStyle = won ? WINNER_STROKE : BOX_STROKE
  ctx.stroke()

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillStyle = empty ? DIM_TEXT : TEXT_COLOR

  const maxTextW = BOX_W - 28
  const size = fitFont(ctx, label, maxTextW, 20)
  ctx.font = `bold ${size}px sans-serif`
  ctx.fillText(label, x + BOX_W / 2, y + BOX_H / 2, maxTextW)

  if (won) {
    ctx.font = '18px sans-serif'
    ctx.fillStyle = CROWN
    ctx.fillText('👑', x + BOX_W - 18, y + 14)
  }
}

/** Straight elbow connector from a round-N box's right edge to the
 *  midpoint feeding round N+1's box left edge — classic bracket look. */
function drawConnector(ctx, fromX, fromY, toX, toY) {
  const midX = fromX + (toX - fromX) / 2
  ctx.strokeStyle = LINE_COLOR
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(fromX, fromY)
  ctx.lineTo(midX, fromY)
  ctx.lineTo(midX, toY)
  ctx.lineTo(toX, toY)
  ctx.stroke()
}

/**
 * Renders the full bracket board for tourney record `t` (see
 * lib/tourney-repo.js for the shape) as a black-background PNG with one
 * rounded box per player slot, columns left-to-right by round, connector
 * lines joining each pair of boxes to the box they feed into.
 */
export async function renderBracketImage(t) {
  const rounds = t.rounds
  const numRounds = rounds.length
  const round1Count = rounds[0].length * 2 // boxes, not matches

  const colWidth = BOX_W
  const totalW = PAD * 2 + numRounds * colWidth + (numRounds - 1) * COL_GAP
  const round1Height = round1Count * BOX_H + (round1Count - 1) * ROW_GAP
  const totalH = HEADER_H + round1Height + PAD * 2

  const canvas = createCanvas(Math.round(totalW), Math.round(totalH))
  const ctx = canvas.getContext('2d')

  // Background
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Header
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = TEXT_COLOR
  ctx.font = 'bold 26px sans-serif'
  ctx.fillText(`🏆 ${t.name}`, PAD, 40)

  ctx.font = '16px sans-serif'
  ctx.fillStyle = DIM_TEXT
  const prizeEmoji = t.prizeCurrency === 'gems' ? '💎' : '☀️'
  ctx.fillText(`🥇 ${t.prize1st} ${prizeEmoji}  ·  🥈 ${t.prize2nd} ${prizeEmoji}`, PAD, 66)

  // ── Compute box center-Y for every (round, slotIndex) up front ──────────
  // Round 1's boxes are evenly spread top-to-bottom by box height/gap.
  // Every later round's box center is the midpoint of the two centers
  // feeding it — that's what gives the classic "converging lines" bracket
  // look instead of every column being independently centered.
  const round1Centers = []
  for (let s = 0; s < round1Count; s++) {
    round1Centers.push(HEADER_H + PAD + s * (BOX_H + ROW_GAP) + BOX_H / 2)
  }
  const allCenters = [round1Centers]
  for (let r = 1; r < numRounds; r++) {
    const prev = allCenters[r - 1]
    const cur = []
    for (let i = 0; i < prev.length; i += 2) {
      cur.push((prev[i] + prev[i + 1]) / 2)
    }
    allCenters.push(cur)
  }

  // ── Draw each round's column ────────────────────────────────────────────
  for (let r = 0; r < numRounds; r++) {
    const x = PAD + r * (colWidth + COL_GAP)
    const round = rounds[r]
    const centers = allCenters[r]

    ctx.textAlign = 'left'
    ctx.font = 'bold 13px sans-serif'
    ctx.fillStyle = DIM_TEXT
    ctx.fillText(roundName(numRounds, r).toUpperCase(), x, HEADER_H + PAD - 14)

    round.forEach((m, mi) => {
      const p1Center = centers[mi * 2]
      const p2Center = centers[mi * 2 + 1]

      const p1Label = m.p1 ? m.p1.name : '—'
      const p2Label = m.p2 ? m.p2.name : (m.p1 ? 'BYE' : '—')
      const p1Won = !!m.winnerJid && m.p1?.jid === m.winnerJid
      const p2Won = !!m.winnerJid && m.p2?.jid === m.winnerJid

      drawBox(ctx, x, p1Center - BOX_H / 2, p1Label, { won: p1Won, empty: !m.p1 })
      drawBox(ctx, x, p2Center - BOX_H / 2, p2Label, { won: p2Won, empty: !m.p2 })

      // Connector to the next round's feed box, if there is one.
      if (r < numRounds - 1) {
        const nextX = x + colWidth + COL_GAP
        const nextCenter = allCenters[r + 1][mi]
        drawConnector(ctx, x + BOX_W, p1Center, nextX, nextCenter)
        drawConnector(ctx, x + BOX_W, p2Center, nextX, nextCenter)
      }
    })
  }

  // ── Champion banner under the final, once decided ──────────────────────
  if (t.status === 'done') {
    const finalMatch = rounds[numRounds - 1][0]
    const championName =
      finalMatch.p1?.jid === finalMatch.winnerJid ? finalMatch.p1?.name : finalMatch.p2?.name
    if (championName) {
      ctx.textAlign = 'center'
      ctx.font = 'bold 20px sans-serif'
      ctx.fillStyle = CROWN
      ctx.fillText(`👑 ${championName} — CHAMPION 👑`, canvas.width / 2, canvas.height - 18)
    }
  }

  return canvas.toBuffer('image/png')
}
