/**
 * quest-engine.js — the whole quest pillar in one place.
 *
 * Two tracks, one counter store:
 *   • DAILY   — a rotating set of DAILY_COUNT quests drawn from data/quests.json's
 *               `daily` pool. The draw is SEEDED BY THE CALENDAR DAY, so every
 *               player bot-wide sees the same set on the same day and it rotates
 *               at local midnight. Progress on the daily set resets each day.
 *   • MILESTONE — a one-time ordered track (`milestone` in the catalog). Each is
 *               claimable exactly once ever, gated on a LIFETIME counter that
 *               never resets.
 *
 * Design constraints this file honours:
 *   • Single-writer discipline: recordQuestEvent() MUTATES the player object and
 *     is only ever called from inside an updatePlayer() mutator (see the hook
 *     sites in combat-handlers.js/collect.js/pokebattle/pvp). It never awaits,
 *     never writes the db itself, never sends a reply.
 *   • Rewards are only ever PAID in claimQuest(), which the player triggers with
 *     `.quest claim`. Completing a quest just unlocks the claim; nothing lands in
 *     the wallet passively. This keeps the reward moment explicit and visible.
 *
 * Player save shape (all created lazily by ensureQuestState):
 *   player.quests = {
 *     day:        <startOfDay ms of the current daily period>,
 *     daily:      { [questId]: count },   // progress on today's rotating set
 *     dailyClaimed: [questId],            // claimed today (cleared on rotation)
 *     lifetime:   { [metric]: count },    // never resets, feeds milestones
 *     milestoneClaimed: [questId],        // claimed ever (permanent)
 *   }
 *
 * Copy is player-facing: no dashes, per the house rule.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const CATALOG = require('../data/quests.json')

import { addOwnedSeasonContent } from './season-engine.js'

const DAILY = CATALOG.daily ?? []
const MILESTONE = CATALOG.milestone ?? []

/** How many quests are drawn from the daily pool each day. */
export const DAILY_COUNT = 3

const DAILY_BY_ID = Object.fromEntries(DAILY.map(q => [q.id, q]))
const MILESTONE_BY_ID = Object.fromEntries(MILESTONE.map(q => [q.id, q]))

// ── Day boundary (mirrors daily.js's startOfDay exactly) ──────────────────
function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Deterministic daily pick. The seed is the day index (ms / 86_400_000), so the
 * same DAILY_COUNT quests come up for everyone on a given day and rotate at the
 * next local midnight. A small xorshift shuffles a copy of the pool; we take the
 * first DAILY_COUNT ids. Pure, no Math.random, so it never diverges per player.
 */
export function dailyQuestIdsForDay(dayStartMs) {
  const pool = DAILY.map(q => q.id)
  if (pool.length <= DAILY_COUNT) return pool
  let seed = Math.floor(dayStartMs / 86_400_000) || 1
  const rand = () => {
    // xorshift32
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    return ((seed >>> 0) % 100000) / 100000
  }
  // Fisher-Yates on a copy
  const arr = pool.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.slice(0, DAILY_COUNT)
}

// ── State bootstrap + daily rotation ──────────────────────────────────────
/**
 * Make sure player.quests exists and its daily set matches TODAY. Rotating the
 * day wipes daily progress + daily claims but never touches lifetime counters or
 * milestone claims. Returns the quests object for convenience. Safe to call as
 * often as you like; it's a no-op once today's set is in place.
 */
export function ensureQuestState(player, now = Date.now()) {
  const today = startOfDay(now)
  if (!player.quests || typeof player.quests !== 'object') {
    player.quests = { day: today, daily: {}, dailyClaimed: [], lifetime: {}, milestoneClaimed: [] }
  }
  const q = player.quests
  q.lifetime = q.lifetime ?? {}
  q.milestoneClaimed = q.milestoneClaimed ?? []
  if (q.day !== today) {
    q.day = today
    q.daily = {}
    q.dailyClaimed = []
  }
  q.daily = q.daily ?? {}
  q.dailyClaimed = q.dailyClaimed ?? []
  return q
}

// ── Event recording (the hook the rest of the bot calls) ──────────────────
/**
 * Advance every quest that watches `metric` by `amount`. MUTATES player, returns
 * a list of quests that CROSSED their goal on this call (so the caller can nudge
 * the player: "quest ready to claim"). Never pays anything. Never awaits.
 *
 * Call from inside an updatePlayer mutator only. `metric` is one of the keys in
 * quests.json's `metrics`. Unknown metrics are recorded into lifetime harmlessly
 * (so a future quest that uses them starts counting now) but match no quest.
 */
export function recordQuestEvent(player, metric, amount = 1) {
  if (!metric || amount <= 0) return []
  const q = ensureQuestState(player)
  const justCompleted = []

  // Lifetime counter (feeds milestones). Always tracked.
  q.lifetime[metric] = (q.lifetime[metric] ?? 0) + amount

  // Daily set: only the ids drawn for today, only those watching this metric.
  const todaysIds = dailyQuestIdsForDay(q.day)
  for (const id of todaysIds) {
    const def = DAILY_BY_ID[id]
    if (!def || def.metric !== metric) continue
    const before = q.daily[id] ?? 0
    if (before >= def.goal) continue // already done today
    const after = Math.min(def.goal, before + amount)
    q.daily[id] = after
    if (before < def.goal && after >= def.goal) justCompleted.push({ track: 'daily', def })
  }

  // Milestones: check every one watching this metric that isn't claimed yet.
  for (const def of MILESTONE) {
    if (def.metric !== metric) continue
    if (q.milestoneClaimed.includes(def.id)) continue
    const before = q.lifetime[metric] - amount
    if (before < def.goal && q.lifetime[metric] >= def.goal) justCompleted.push({ track: 'milestone', def })
  }

  return justCompleted
}

// ── Read model (for .quest list) ──────────────────────────────────────────
function dailyView(player) {
  const q = ensureQuestState(player)
  return dailyQuestIdsForDay(q.day).map(id => {
    const def = DAILY_BY_ID[id]
    const progress = Math.min(def.goal, q.daily[id] ?? 0)
    const claimed = q.dailyClaimed.includes(id)
    return { ...def, progress, done: progress >= def.goal, claimed }
  })
}

function milestoneView(player) {
  const q = ensureQuestState(player)
  // Surface the next unclaimed milestone per metric plus any completed-unclaimed
  // ones, so the list stays short and forward-looking instead of dumping all of
  // them. A milestone is "shown" if it's claimable now, or it's the first
  // unclaimed one for its metric.
  const firstUnclaimedByMetric = {}
  for (const def of MILESTONE) {
    if (q.milestoneClaimed.includes(def.id)) continue
    if (!(def.metric in firstUnclaimedByMetric)) firstUnclaimedByMetric[def.metric] = def.id
  }
  const shown = []
  for (const def of MILESTONE) {
    if (q.milestoneClaimed.includes(def.id)) continue
    const progress = Math.min(def.goal, q.lifetime[def.metric] ?? 0)
    const done = progress >= def.goal
    if (done || firstUnclaimedByMetric[def.metric] === def.id) {
      shown.push({ ...def, progress, done, claimed: false })
    }
  }
  return shown
}

export function getQuestBoard(player) {
  return { daily: dailyView(player), milestone: milestoneView(player) }
}

/** How many quests across both tracks are done and waiting to be claimed. */
export function claimableCount(player) {
  const { daily, milestone } = getQuestBoard(player)
  return daily.filter(q => q.done && !q.claimed).length + milestone.filter(q => q.done).length
}

// ── Claiming (the only place a reward is paid) ─────────────────────────────
function payReward(player, reward) {
  if (!reward) return null
  const amt = Math.max(0, Math.floor(Number(reward.amount) || 0))
  switch (reward.type) {
    case 'solars':
      player.wallet = player.wallet ?? {}
      player.wallet.solars = (player.wallet.solars ?? 0) + amt
      return `☀️ *${amt}* Solars`
    case 'gems':
      player.wallet = player.wallet ?? {}
      player.wallet.gems = Math.round(((player.wallet.gems ?? 0) + amt) * 100) / 100
      return `💎 *${amt}* Gems`
    case 'xp':
      player.xp = (player.xp ?? 0) + amt
      return `📈 *${amt}* XP`
    case 'seasonPoints':
      player.seasonPoints = (player.seasonPoints ?? 0) + amt
      return `✨ *${amt}* Season Points`
    case 'stamina':
      if (player.stamina) player.stamina.current = Math.min(player.stamina.max, (player.stamina.current ?? 0) + amt)
      return `⚡ *${amt}* Stamina`
    case 'item':
    case 'character':
      addOwnedSeasonContent(player, reward.type, reward.itemId, amt || 1)
      return reward.type === 'character' ? `🎴 a new character` : `🎁 an item`
    default:
      return null
  }
}

/**
 * Claim one specific quest by id, or (id omitted) claim EVERY done-unclaimed
 * quest across both tracks at once. MUTATES player, returns:
 *   { claimed: [{ name, rewardLabel }], nothing: bool }
 * Call inside an updatePlayer mutator. XP paid here does NOT auto-level; the
 * caller runs applyLevelUps afterwards if it wants that (mirrors daily.js).
 */
export function claimQuest(player, id = null) {
  const q = ensureQuestState(player)
  const board = getQuestBoard(player)
  const claimed = []

  const tryClaimDaily = (view) => {
    if (!view.done || view.claimed) return
    const label = payReward(player, view.reward)
    q.dailyClaimed.push(view.id)
    claimed.push({ name: view.name, rewardLabel: label })
  }
  const tryClaimMilestone = (view) => {
    if (!view.done) return
    if (q.milestoneClaimed.includes(view.id)) return
    const label = payReward(player, view.reward)
    q.milestoneClaimed.push(view.id)
    claimed.push({ name: view.name, rewardLabel: label })
  }

  if (id) {
    const d = board.daily.find(v => v.id === id)
    if (d) tryClaimDaily(d)
    const m = board.milestone.find(v => v.id === id)
    if (m) tryClaimMilestone(m)
  } else {
    for (const v of board.daily) tryClaimDaily(v)
    for (const v of board.milestone) tryClaimMilestone(v)
  }

  return { claimed, nothing: claimed.length === 0 }
}

export function getDailyCount() { return DAILY_COUNT }
