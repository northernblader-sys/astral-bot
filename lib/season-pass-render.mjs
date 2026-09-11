/**
 * lib/season-pass-render.mjs
 * Renders a window of the Battle Pass as TWO parallel tracks — free on top,
 * premium below — with a tier spine between them.
 *
 *   export async function renderSeasonPass(opts) → Buffer (PNG)
 *
 * opts: {
 *   season,        // active season (name/number/battlePass)
 *   player,        // drives tier, claimed set, premium state, points
 *   rewards,       // [{ tier, free, premium }, ...] — the FULL 50-tier list
 *   start,         // 1-based tier the window starts at (default: around
 *                  //   the player's current tier)
 *   count,         // tiers per render (default 8 — the widest that stays
 *                  //   legible on a phone screen)
 * }
 *
 * Every node is one of four states, and the state is what the render is
 * actually for — a player should be able to tell at a glance which rewards
 * are waiting for them:
 *   CLAIMED  — dim, green check
 *   READY    — bright, rarity-glowing, gold ring (tier reached, not claimed)
 *   LOCKED   — flat, padlock (tier not reached yet)
 *   PREMIUM-LOCKED — the premium row when the player has no premium pass;
 *                    drawn behind a diagonal hatch so it reads as "buyable"
 *                    rather than "unreachable".
 *
 * PNG, not SVG — see the note at the top of season-shop-render.mjs.
 */
import {
  createCanvas, fetchAll, roundedRect, truncate, drawContain, drawEmblem,
  drawSpark, drawGem, drawLock, drawCheck, drawStar, rarityPalette,
  GOLD, GOLD_DIM, INK, PANEL, PANEL_HI, TEXT, TEXT_DIM,
} from './season-render-common.mjs'
import { describePassReward, seasonTierProgress } from './season-engine.js'

const NODE = 132        // reward node width/height
const GAP = 18
const PAD = 28
const HEADER_H = 148
const SPINE_H = 62      // tier-number strip between the two tracks
const LABEL_H = 40      // track name column
const FOOTER_H = 66
const TRACK_LABEL_W = 96

const PREMIUM_TINT = '#d4af37'
const FREE_TINT = '#5fa8d3'

function trackY(index) {
  // 0 = free track, 1 = premium track
  return HEADER_H + index * (NODE + SPINE_H)
}

function drawBackdrop(ctx, w, h) {
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, w, h)
  const bloom = ctx.createLinearGradient(0, 0, w, h)
  bloom.addColorStop(0, 'rgba(95,168,211,0.08)')
  bloom.addColorStop(0.5, 'rgba(0,0,0,0)')
  bloom.addColorStop(1, 'rgba(212,175,55,0.10)')
  ctx.fillStyle = bloom
  ctx.fillRect(0, 0, w, h)

  ctx.save()
  ctx.globalAlpha = 0.05
  ctx.strokeStyle = GOLD
  ctx.lineWidth = 1
  for (let x = -h; x < w; x += 42) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x + h, h)
    ctx.stroke()
  }
  ctx.restore()
}

function drawHeader(ctx, w, { season, player, tier, tierCount, premium, tierProgress }) {
  ctx.save()
  const bar = ctx.createLinearGradient(0, 0, 0, HEADER_H)
  bar.addColorStop(0, 'rgba(212,175,55,0.16)')
  bar.addColorStop(1, 'rgba(212,175,55,0)')
  ctx.fillStyle = bar
  ctx.fillRect(0, 0, w, HEADER_H)

  ctx.textAlign = 'left'
  ctx.font = 'bold 15px sans-serif'
  ctx.fillStyle = GOLD_DIM
  ctx.fillText(`SEASON ${season?.number ?? 1}  ·  ${String(season?.name ?? '').toUpperCase()}`, PAD, 38)

  ctx.font = 'bold 44px sans-serif'
  ctx.fillStyle = TEXT
  ctx.fillText('BATTLE PASS', PAD, 84)

  // Premium badge next to the title
  const titleW = ctx.measureText('BATTLE PASS').width
  ctx.font = 'bold 14px sans-serif'
  const badge = premium ? 'PREMIUM' : 'FREE TRACK'
  const badgeColor = premium ? GOLD : TEXT_DIM
  const bw = ctx.measureText(badge).width + 24
  roundedRect(ctx, PAD + titleW + 18, 58, bw, 28, 8)
  ctx.fillStyle = 'rgba(7,7,10,0.7)'
  ctx.fill()
  ctx.strokeStyle = badgeColor
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.fillStyle = badgeColor
  ctx.textAlign = 'center'
  ctx.fillText(badge, PAD + titleW + 18 + bw / 2, 77)

  // Tier progress bar
  const barX = PAD
  const barY = 104
  const barW = w - PAD * 2
  const barH = 16
  roundedRect(ctx, barX, barY, barW, barH, barH / 2)
  ctx.fillStyle = 'rgba(255,255,255,0.07)'
  ctx.fill()
  const pct = tierCount ? Math.min(1, tier / tierCount) : 0
  if (pct > 0) {
    ctx.save()
    roundedRect(ctx, barX, barY, Math.max(barH, barW * pct), barH, barH / 2)
    const fill = ctx.createLinearGradient(barX, 0, barX + barW, 0)
    fill.addColorStop(0, FREE_TINT)
    fill.addColorStop(1, GOLD)
    ctx.fillStyle = fill
    ctx.shadowColor = 'rgba(212,175,55,0.55)'
    ctx.shadowBlur = 14
    ctx.fill()
    ctx.restore()
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'
  ctx.lineWidth = 1
  roundedRect(ctx, barX, barY, barW, barH, barH / 2)
  ctx.stroke()

  ctx.font = 'bold 14px sans-serif'
  ctx.fillStyle = TEXT
  ctx.textAlign = 'left'
  ctx.fillText(`TIER ${tier} / ${tierCount}`, barX + 2, barY + 34)
  // Season XP — where the tier actually comes from, so the number under the
  // bar visibly moves between tier-ups (see lib/season-engine.js battlePassCurve)
  ctx.font = '12px sans-serif'
  ctx.fillStyle = TEXT_DIM
  ctx.fillText(`SEASON XP ${(tierProgress?.xp ?? 0).toLocaleString('en-US')}`, barX + 2, barY + 50)

  // Season points, right-aligned on the same line as the title
  const points = player?.seasonPoints ?? 0
  ctx.textAlign = 'right'
  ctx.font = 'bold 30px sans-serif'
  ctx.fillStyle = GOLD
  const pointsText = points.toLocaleString('en-US')
  ctx.fillText(pointsText, w - PAD, 74)
  drawSpark(ctx, w - PAD - ctx.measureText(pointsText).width - 20, 64, 11, GOLD)
  ctx.font = '13px sans-serif'
  ctx.fillStyle = TEXT_DIM
  ctx.fillText('SEASON POINTS', w - PAD, 96)
  ctx.font = 'bold 14px sans-serif'
  ctx.fillStyle = TEXT_DIM
  ctx.fillText(`${Math.round(pct * 100)}% COMPLETE`, w - PAD - 2, barY + 34)
  if (tierProgress && tier < tierCount) {
    ctx.font = '12px sans-serif'
    ctx.fillText(`${tierProgress.toNext.toLocaleString('en-US')} XP TO TIER ${tier + 1}`, w - PAD - 2, barY + 50)
  }
  ctx.restore()
}

/** Diagonal hatch used to mark the locked premium track. */
function hatch(ctx, x, y, w, h, color = 'rgba(212,175,55,0.16)') {
  ctx.save()
  roundedRect(ctx, x, y, w, h, 14)
  ctx.clip()
  ctx.strokeStyle = color
  ctx.lineWidth = 3
  for (let i = -h; i < w; i += 11) {
    ctx.beginPath()
    ctx.moveTo(x + i, y)
    ctx.lineTo(x + i + h, y + h)
    ctx.stroke()
  }
  ctx.restore()
}

function drawNode(ctx, x, y, reward, art, { state, tint }) {
  const info = describePassReward(reward)
  const pal = rarityPalette(info.rarity)
  const accent = state === 'ready' ? GOLD : state === 'claimed' ? '#4ad07a' : pal.base
  const dim = state === 'locked' || state === 'premiumLocked' || state === 'claimed'

  ctx.save()

  roundedRect(ctx, x, y, NODE, NODE, 14)
  const panel = ctx.createLinearGradient(x, y, x, y + NODE)
  panel.addColorStop(0, PANEL_HI)
  panel.addColorStop(1, PANEL)
  ctx.fillStyle = panel
  ctx.fill()

  if (state === 'ready') {
    // The only nodes that glow — a claimable reward should be the first thing
    // the eye lands on.
    ctx.save()
    ctx.shadowColor = 'rgba(212,175,55,0.8)'
    ctx.shadowBlur = 20
    ctx.lineWidth = 2.5
    ctx.strokeStyle = GOLD
    ctx.stroke()
    ctx.restore()
  } else {
    ctx.lineWidth = 1.5
    ctx.strokeStyle = dim ? 'rgba(255,255,255,0.12)' : `${accent}aa`
    ctx.stroke()
  }

  // Artwork / emblem
  ctx.save()
  roundedRect(ctx, x + 1, y + 1, NODE - 2, NODE - 34, 13)
  ctx.clip()
  const well = ctx.createLinearGradient(x, y, x, y + NODE - 34)
  well.addColorStop(0, `${pal.base}1f`)
  well.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = well
  ctx.fillRect(x, y, NODE, NODE - 34)
  if (dim) ctx.globalAlpha = 0.42
  if (art) drawContain(ctx, art, x + 16, y + 12, NODE - 32, NODE - 60)
  else drawEmblem(ctx, x + 12, y + 8, NODE - 24, NODE - 50, info)
  ctx.globalAlpha = 1
  ctx.restore()

  // Stack count, e.g. "×3"
  if (info.count > 1) {
    ctx.font = 'bold 15px sans-serif'
    const label = `x${info.count}`
    const lw = ctx.measureText(label).width + 14
    roundedRect(ctx, x + NODE - lw - 7, y + 7, lw, 22, 7)
    ctx.fillStyle = 'rgba(7,7,10,0.82)'
    ctx.fill()
    ctx.strokeStyle = `${tint}88`
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = TEXT
    ctx.textAlign = 'center'
    ctx.fillText(label, x + NODE - lw / 2 - 7, y + 23)
  }

  // Name strip
  ctx.fillStyle = 'rgba(0,0,0,0.62)'
  ctx.save()
  roundedRect(ctx, x + 1, y + NODE - 34, NODE - 2, 33, 13)
  ctx.clip()
  ctx.fillRect(x, y + NODE - 34, NODE, 34)
  ctx.restore()
  ctx.font = 'bold 13px sans-serif'
  ctx.fillStyle = dim ? TEXT_DIM : TEXT
  ctx.textAlign = 'center'
  ctx.fillText(truncate(ctx, info.name, NODE - 14), x + NODE / 2, y + NODE - 13)

  // State overlay
  if (state === 'claimed') {
    roundedRect(ctx, x, y, NODE, NODE, 14)
    ctx.fillStyle = 'rgba(7,7,10,0.44)'
    ctx.fill()
    drawCheck(ctx, x + NODE - 22, y + 22, 14)
  } else if (state === 'locked') {
    roundedRect(ctx, x, y, NODE, NODE, 14)
    ctx.fillStyle = 'rgba(7,7,10,0.52)'
    ctx.fill()
    drawLock(ctx, x + NODE - 22, y + 22, 17, 'rgba(255,255,255,0.55)')
  } else if (state === 'premiumLocked') {
    roundedRect(ctx, x, y, NODE, NODE, 14)
    ctx.fillStyle = 'rgba(7,7,10,0.52)'
    ctx.fill()
    hatch(ctx, x, y, NODE, NODE)
    drawGem(ctx, x + NODE - 22, y + 22, 12, GOLD)
  }

  ctx.restore()
}

function drawSpine(ctx, x, y, tier, { reached, claimed, isCurrent }) {
  const cx = x + NODE / 2
  const cy = y + SPINE_H / 2
  const r = 21

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = reached ? 'rgba(212,175,55,0.16)' : 'rgba(255,255,255,0.04)'
  ctx.fill()
  ctx.lineWidth = isCurrent ? 3 : 1.5
  ctx.strokeStyle = isCurrent ? GOLD : reached ? `${GOLD}88` : 'rgba(255,255,255,0.16)'
  if (isCurrent) {
    ctx.shadowColor = 'rgba(212,175,55,0.85)'
    ctx.shadowBlur = 16
  }
  ctx.stroke()
  ctx.shadowBlur = 0

  ctx.font = `bold ${tier >= 100 ? 15 : 18}px sans-serif`
  ctx.fillStyle = reached ? TEXT : TEXT_DIM
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(tier), cx, cy + 1)
  ctx.textBaseline = 'alphabetic'

  if (claimed) {
    ctx.beginPath()
    ctx.arc(cx + r * 0.78, cy - r * 0.78, 6, 0, Math.PI * 2)
    ctx.fillStyle = '#4ad07a'
    ctx.fill()
  }
  ctx.restore()
}

function drawTrackLabel(ctx, x, y, text, tint, sub) {
  ctx.save()
  ctx.translate(x, y + NODE / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.textAlign = 'center'
  ctx.font = 'bold 19px sans-serif'
  ctx.fillStyle = tint
  ctx.fillText(text, 0, 0)
  if (sub) {
    ctx.font = '12px sans-serif'
    ctx.fillStyle = TEXT_DIM
    ctx.fillText(sub, 0, 20)
  }
  ctx.restore()
}

function drawFooter(ctx, w, h, { prefix, start, end, tierCount, premium, premiumCost }) {
  const y = h - FOOTER_H
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(PAD, y)
  ctx.lineTo(w - PAD, y)
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.font = '15px sans-serif'
  ctx.fillStyle = TEXT_DIM
  ctx.textAlign = 'left'
  ctx.fillText(`Tiers ${start}-${end} of ${tierCount}  ·  ${prefix}season pass <tier>  ·  ${prefix}season pass claim all`, PAD, y + 30)
  ctx.fillText(
    premium
      ? 'Premium track unlocked — both rows are yours to claim.'
      : `Premium track locked — ${prefix}season premium (${premiumCost} Gems) to open the gold row.`,
    PAD, y + 50,
  )
  ctx.restore()
}

/**
 * `start` defaults to a window that keeps the player's current tier visible
 * with a little of what's already been earned behind it — landing on the pass
 * should show what's next, not tier 1 forever.
 */
function defaultStart(tier, count, tierCount) {
  const centred = Math.max(1, tier - Math.floor(count / 3))
  return Math.max(1, Math.min(centred, Math.max(1, tierCount - count + 1)))
}

export async function renderSeasonPass({
  season, player, rewards = [], start = null, count = 8, prefix = '.',
} = {}) {
  const tierCount = Math.max(1, Number(season?.battlePass?.tierCount ?? rewards.length ?? 50))
  const tier = Math.max(0, Number(player?.seasonProgress?.battlePassTier ?? 0))
  const claimed = new Set(player?.seasonProgress?.claimedTiers ?? [])
  const premium = Boolean(player?.seasonProgress?.premiumPass)
  // Season XP standing, so the header can show movement between tier-ups —
  // tiers are expensive now (90-day pace), so tier alone barely changes.
  const tierProgress = player && season ? seasonTierProgress(player, season) : null

  const perPage = Math.max(1, Math.min(12, Math.floor(count)))
  const from = Math.max(1, Math.floor(Number(start) || defaultStart(tier, perPage, tierCount)))
  const window = rewards
    .filter((r) => r && r.tier >= from && r.tier < from + perPage)
    .sort((a, b) => a.tier - b.tier)

  const cols = Math.max(1, window.length)
  const W = PAD * 2 + TRACK_LABEL_W + cols * NODE + (cols - 1) * GAP
  const H = HEADER_H + NODE * 2 + SPINE_H + LABEL_H + FOOTER_H

  // Both tracks' artwork in one flight — 16 fetches worst case, all optional.
  const urls = []
  for (const r of window) urls.push(describePassReward(r.free).image, describePassReward(r.premium).image)
  const arts = await fetchAll(urls)

  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')

  drawBackdrop(ctx, W, H)
  drawHeader(ctx, W, { season, player, tier, tierCount, premium, tierProgress })

  const gridX = PAD + TRACK_LABEL_W
  const freeY = trackY(0)
  const spineY = freeY + NODE
  const premY = trackY(1)

  drawTrackLabel(ctx, PAD + 34, freeY, 'FREE', FREE_TINT, 'everyone')
  drawTrackLabel(ctx, PAD + 34, premY, 'PREMIUM', PREMIUM_TINT, premium ? 'unlocked' : `${season?.battlePass?.premiumCost ?? 5} gems`)

  // Rails behind the nodes so the two tracks read as continuous lanes.
  for (const [y, tint] of [[freeY, FREE_TINT], [premY, PREMIUM_TINT]]) {
    ctx.save()
    roundedRect(ctx, gridX - 10, y - 10, W - gridX - PAD + 10 + 10, NODE + 20, 18)
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fill()
    ctx.strokeStyle = `${tint}33`
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()
  }

  window.forEach((reward, i) => {
    const x = gridX + i * (NODE + GAP)
    const reached = reward.tier <= tier
    const isClaimed = claimed.has(reward.tier)

    const freeState = isClaimed ? 'claimed' : reached ? 'ready' : 'locked'
    const premState = !premium
      ? 'premiumLocked'
      : isClaimed ? 'claimed' : reached ? 'ready' : 'locked'

    drawNode(ctx, x, freeY, reward.free, arts[i * 2], { state: freeState, tint: FREE_TINT })
    drawSpine(ctx, x, spineY, reward.tier, { reached, claimed: isClaimed, isCurrent: reward.tier === tier })
    drawNode(ctx, x, premY, reward.premium, arts[i * 2 + 1], { state: premState, tint: PREMIUM_TINT })
  })

  // Final-tier flourish: mark the last tier in the window if it IS the last
  // tier of the pass, since that node is the season's headline reward.
  const last = window[window.length - 1]
  if (last && last.tier === tierCount) {
    const x = gridX + (window.length - 1) * (NODE + GAP)
    ctx.save()
    drawStar(ctx, x + NODE / 2, premY + NODE + 14, 8)
    ctx.fillStyle = GOLD
    ctx.fill()
    ctx.font = 'bold 12px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('FINALE', x + NODE / 2, premY + NODE + 36)
    ctx.restore()
  }

  drawFooter(ctx, W, H, {
    prefix,
    start: window[0]?.tier ?? from,
    end: last?.tier ?? from,
    tierCount,
    premium,
    premiumCost: season?.battlePass?.premiumCost ?? 5,
  })

  return canvas.toBuffer('image/png')
}
