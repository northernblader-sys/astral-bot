/**
 * premium.js — Premium subscription status + perks logic.
 * See data/premium-plans.json for plan pricing/duration, plugins/premium.js
 * for the purchase flow, and lib/combat-handlers.js for where the XP/Solars
 * multiplier and auto-revive perks actually apply.
 */
import { startOfDay } from './sleep-engine.js'

export function isPremiumActive(player) {
  return !!(player.premium?.active && player.premium.expiresAt && Date.now() < player.premium.expiresAt)
}

export function grantPremium(player, planKey, plansData) {
  const plan = plansData.plans[planKey]
  if (!plan) return false
  const now = Date.now()
  const base = isPremiumActive(player) ? player.premium.expiresAt : now // stack if renewing early
  player.premium = {
    ...player.premium,
    active: true,
    plan: planKey,
    expiresAt: base + plan.durationDays * 86400000,
    grantedAt: player.premium?.grantedAt ?? now,
  }
  if (!player.title) player.title = '👑 The Chosen'
  return true
}

export function expirePremiumIfDue(player) {
  if (player.premium?.active && player.premium.expiresAt && Date.now() >= player.premium.expiresAt) {
    player.premium.active = false
    return true // caller should know it just expired, e.g. to remove from GC
  }
  return false
}

/**
 * True if a premium player still has their free once-per-day auto-revive
 * available. Resets automatically on a new calendar day — callers don't
 * need to reset the flag themselves before checking.
 */
export function hasAutoReviveAvailable(player) {
  if (!isPremiumActive(player)) return false
  const today = startOfDay(Date.now())
  if (player.premium.autoReviveDate !== today) return true // new day, unused
  return !player.premium.autoReviveUsedToday
}

/** Marks today's free auto-revive as spent. Call only after actually using it. */
export function markAutoReviveUsed(player) {
  player.premium.autoReviveUsedToday = true
  player.premium.autoReviveDate = startOfDay(Date.now())
}
