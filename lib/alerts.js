/**
 * alerts.js — derives a player's live "alerts" feed from state that already
 * exists on their record.
 *
 * Two consumers, two audiences:
 *
 *   buildSelfAlerts(db, player)    — things YOU need to act on: unspent stat
 *                                    points, unclaimed battle-pass tiers, a
 *                                    premium sub about to lapse, a purchase
 *                                    still awaiting a screenshot. These are
 *                                    merged with the stored notifications
 *                                    (lib/notification-repo.js) to fill the
 *                                    bell on the site.
 *
 *   buildPublicAlerts(db, player)  — what OTHER people see when they tap a
 *                                    row on the leaderboard: milestones,
 *                                    conquests, recent fame events. Nothing
 *                                    here may leak a phone number, a wallet
 *                                    balance, or a pending payment.
 *
 * Nothing in this file writes. It's pure derivation over a snapshot, so it's
 * cheap enough to run per-request without touching the write queue.
 */
import { getRankForLevel, getNextRank, getXpProgress } from './rank-engine.js'
import { playerLevelCap } from './reborn-engine.js'
import { getFameTier, getNextFameTier, formatFame } from './fame-engine.js'
import { isPremiumActive } from './premium.js'
import { getActiveSeason, getSeasonRuntime, seasonProgressPercent } from './season-engine.js'
import { locationsMap, characterMap } from './game-data.js'

const DAY_MS = 86_400_000

function startOfToday() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime()
}

function alert(severity, kind, title, body, meta = null) {
  return { severity, kind, title, body, meta, derived: true }
}

/**
 * Actionable alerts for the signed-in player, ordered most-urgent first.
 * `severity` is one of 'urgent' | 'action' | 'info' | 'good'.
 */
export function buildSelfAlerts(db, player, now = Date.now()) {
  const out = []
  if (!player) return out

  // ── Health ──────────────────────────────────────────────────────────────
  const hpPct = player.maxHp ? player.hp / player.maxHp : 1
  if (player.hp <= 0) {
    out.push(alert('urgent', 'battle', 'You are down',
      'Your HP hit zero. Revive before entering another floor.'))
  } else if (hpPct <= 0.25) {
    out.push(alert('urgent', 'battle', 'Critically low HP',
      `${player.hp}/${player.maxHp} HP left — heal before your next fight.`))
  }

  // ── Pending payments (owner still has to confirm these by hand) ──────────
  if (player.premiumPending?.state === 'awaiting_screenshot') {
    out.push(alert('action', 'premium', 'Premium payment unfinished',
      `Send the transfer screenshot to the bot to activate your ${player.premiumPending.plan} plan.`))
  } else if (player.premiumPending?.state === 'pending_confirmation') {
    out.push(alert('info', 'premium', 'Premium awaiting confirmation',
      'Your screenshot is in. An admin will confirm it shortly.'))
  }
  if (player.topupPending?.state === 'awaiting_screenshot') {
    out.push(alert('action', 'reward', 'Gem top-up unfinished',
      `Send the transfer screenshot to claim ${player.topupPending.gems} gems.`))
  } else if (player.topupPending?.state === 'pending_confirmation') {
    out.push(alert('info', 'reward', 'Top-up awaiting confirmation',
      'Your screenshot is in. An admin will confirm it shortly.'))
  }

  // ── Premium expiry ──────────────────────────────────────────────────────
  if (isPremiumActive(player) && player.premium?.expiresAt) {
    const left = player.premium.expiresAt - now
    if (left < 3 * DAY_MS) {
      const days = Math.max(0, Math.ceil(left / DAY_MS))
      out.push(alert('action', 'premium', `Premium expires in ${days} day${days === 1 ? '' : 's'}`,
        'Renew to keep auto-revive, bonus rewards and the premium badge.'))
    }
  } else if (player.premium?.grantedAt && !isPremiumActive(player)) {
    out.push(alert('info', 'premium', 'Premium has lapsed',
      'Your subscription ended. Everything you unlocked is still yours.'))
  }

  // ── Unspent progression ─────────────────────────────────────────────────
  const unallocated = player.statPoints?.unallocated ?? 0
  if (unallocated > 0) {
    out.push(alert('action', 'reward', `${unallocated} stat point${unallocated === 1 ? '' : 's'} unspent`,
      'Spend them to raise STR, AGI, INT, DEF or LCK.', { statPoints: unallocated }))
  }

  // ── Battle pass ─────────────────────────────────────────────────────────
  const season = getActiveSeason(db)
  if (season) {
    const sp = player.seasonProgress ?? {}
    const claimed = new Set(sp.claimedTiers ?? [])
    const tier = sp.battlePassTier ?? 0
    const unclaimed = []
    for (let t = 1; t <= tier; t++) if (!claimed.has(t)) unclaimed.push(t)
    if (unclaimed.length) {
      out.push(alert('action', 'season', `${unclaimed.length} battle pass reward${unclaimed.length === 1 ? '' : 's'} waiting`,
        `Tier${unclaimed.length === 1 ? '' : 's'} ${unclaimed.slice(0, 6).join(', ')}${unclaimed.length > 6 ? '…' : ''} ready to claim.`,
        { tiers: unclaimed }))
    }

    const runtime = getSeasonRuntime(db)
    if (runtime.endsAt) {
      const left = runtime.endsAt - now
      if (left > 0 && left < 7 * DAY_MS) {
        const days = Math.max(1, Math.ceil(left / DAY_MS))
        out.push(alert('info', 'season', `Season ends in ${days} day${days === 1 ? '' : 's'}`,
          `${season.name} closes soon — spend your season points before they convert.`))
      }
    }
  }

  // ── Daily reward ────────────────────────────────────────────────────────
  if (!player.lastDailyClaim || player.lastDailyClaim < startOfToday()) {
    out.push(alert('action', 'reward', 'Daily reward available',
      player.dailyStreak > 0
        ? `Keep your ${player.dailyStreak}-day streak alive.`
        : 'Claim it to start a streak.'))
  }

  // ── Stamina ─────────────────────────────────────────────────────────────
  const stam = player.stamina
  if (stam && typeof stam.current === 'number' && stam.current <= 0) {
    out.push(alert('info', 'system', 'Out of stamina',
      'It refills at midnight, or rest at the inn.'))
  }

  // ── In-progress run ─────────────────────────────────────────────────────
  if (player.inBattle) {
    out.push(alert('info', 'battle', 'Battle in progress',
      'You have an unfinished fight in chat.'))
  } else if (player.inDungeon) {
    const loc = locationsMap[player.location]?.name ?? player.location
    out.push(alert('info', 'battle', 'Still inside a dungeon',
      `You are on floor ${player.dungeonFloor ?? 1} of ${loc}.`))
  }

  const order = { urgent: 0, action: 1, info: 2, good: 3 }
  return out.sort((a, b) => order[a.severity] - order[b.severity])
}

/**
 * Milestones and recent activity safe to show to anyone — this is what the
 * leaderboard's character detail panel renders under "Alerts".
 */
export function buildPublicAlerts(db, player, now = Date.now()) {
  const out = []
  if (!player) return out

  const rank = getRankForLevel(player.level ?? 1)
  const nextRank = getNextRank(player.level ?? 1)
  const xp = getXpProgress(player.level ?? 1, player.xp ?? 0, playerLevelCap(player))

  out.push(alert('good', 'system', `${rank.emoji} ${rank.title}`,
    nextRank
      ? `${rank.epithet} — ${Math.max(0, nextRank.min - (player.level ?? 1))} levels from ${nextRank.title}.`
      : `${rank.epithet} — the ceiling of the ladder.`))

  if (xp.maxed) {
    out.push(alert('good', 'reward', 'Level cap reached', 'Nothing left to grind on the main ladder.'))
  }

  // Dungeon conquests + deepest floor
  const conquered = []
  let deepest = { floor: 0, locId: null }
  for (const [locId, prog] of Object.entries(player.dungeonProgress ?? {})) {
    if (prog?.conquered) conquered.push(locationsMap[locId]?.name ?? locId)
    if ((prog?.highestFloor ?? 0) > deepest.floor) deepest = { floor: prog.highestFloor, locId }
  }
  if (deepest.floor > 0) {
    out.push(alert('good', 'battle', `Deepest floor: ${deepest.floor}`,
      `Reached in ${locationsMap[deepest.locId]?.name ?? deepest.locId}.`))
  }
  if (conquered.length) {
    out.push(alert('good', 'battle', `${conquered.length} dungeon${conquered.length === 1 ? '' : 's'} conquered`,
      conquered.slice(0, 4).join(', ') + (conquered.length > 4 ? '…' : '')))
  }

  // Fame
  const fame = player.fame ?? 0
  if (fame > 0) {
    const tier = getFameTier(fame)
    const next = getNextFameTier(fame)
    out.push(alert('good', 'social', `${tier.emoji} ${tier.label}`,
      next
        ? `${formatFame(fame)} fame — ${formatFame(next.min - fame)} to ${next.label}.`
        : `${formatFame(fame)} fame — nothing above this.`))
  }

  // Recent fame events double as a public activity log
  for (const ev of (player.fameHistory ?? []).slice(0, 4)) {
    out.push({
      severity: 'info',
      kind: 'social',
      title: ev.targetName ? `${ev.event} — ${ev.targetName}` : String(ev.event ?? 'Activity'),
      body: `+${formatFame(ev.gained ?? 0)} fame`,
      meta: { at: ev.at ?? null },
      derived: true,
    })
  }

  // PvP record
  const wins = player.stats?.wins ?? 0
  const losses = player.stats?.losses ?? 0
  if (wins + losses > 0) {
    const rate = Math.round((wins / (wins + losses)) * 100)
    out.push(alert('info', 'battle', `${wins}W – ${losses}L`, `${rate}% win rate in PvP.`))
  }

  // Season standing
  const season = getActiveSeason(db)
  if (season && player.seasonProgress?.seasonId === season.id) {
    const pct = seasonProgressPercent(player, season)
    out.push(alert('info', 'season', `Battle Pass tier ${player.seasonProgress.battlePassTier ?? 0}`,
      `${pct}% through ${season.name}${player.seasonProgress.premiumPass ? ' · Premium Pass' : ''}.`))
  }

  // Equipped character
  const ch = player.equippedCharacter ? characterMap[player.equippedCharacter] : null
  if (ch) {
    out.push(alert('good', 'social', `${ch.emoji ?? '✦'} Fighting alongside ${ch.name}`,
      ch.ability?.name ? `${ch.ability.name} — ${ch.ability.flavor ?? ''}`.trim() : (ch.description ?? '')))
  }

  if (isPremiumActive(player)) {
    out.push(alert('good', 'premium', 'Premium member', 'Supporting the realm.'))
  }

  const days = player.registeredAt ? Math.floor((now - player.registeredAt) / DAY_MS) : null
  if (days !== null && days >= 1) {
    out.push(alert('info', 'system', `${days} day${days === 1 ? '' : 's'} in Astral`,
      `Registered ${new Date(player.registeredAt).toISOString().slice(0, 10)}.`))
  }

  return out
}
