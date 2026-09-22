/**
 * dungeon-slots.js — Group-level dungeon occupancy and idle management.
 *
 * Rules:
 *   - In a single group, at most 2 people can be in .dungeon at any one time.
 *   - Premium players bypass this cap: they can enter even if 2 people are
 *     already inside.
 *   - If someone is inside a dungeon and inactive for 10 minutes, the bot
 *     kicks them out of the dungeon (resets their dungeon state / saves their
 *     progress, without touching group membership), frees the slot, and
 *     announces in the group with a hidden tag-all (.hidetag style) so everyone
 *     knows the dungeon slot is open again.
 *   - Matching handles all forms of JID / LID: comparing canonical player IDs,
 *     phone digits, LID digits, and companion device suffixes.
 */

import { isPremiumActive } from './premium.js'
import { getPlayer, updatePlayer } from './player-repo.js'
import { getGroupMetadata } from './group-helpers.js'
import { config, logger } from '../config.js'

/** Maximum concurrent non-premium dungeon players in a single group. */
export const MAX_DUNGEON_OCCUPANCY = 2

/** Idle timeout in milliseconds before an inactive dungeon crawler is kicked (10 minutes). */
export const DUNGEON_IDLE_TIMEOUT_MS = 10 * 60_000

/** Sweep interval for checking idle dungeon players (every 30 seconds). */
export const DUNGEON_SLOT_SWEEP_INTERVAL_MS = 30_000

/**
 * In-memory registry of dungeon occupancy per group.
 * Shape:
 *   groupDungeonSlots: Map<groupJid, Map<playerId, {
 *     playerId: string,
 *     userJid: string,
 *     isPremium: boolean,
 *     enteredAt: number,
 *     lastActivityAt: number,
 *   }>>
 */
const groupDungeonSlots = new Map()

/** Normalize a JID / player ID to bare digits or raw username without server or companion device suffix. */
export function normalizeIdentityKey(id) {
  if (!id) return ''
  return String(id).replace(/@.*$/, '').split(':')[0].trim()
}

/** Check if two JIDs / player IDs represent the same user across all forms of LID / JID / device. */
export function isSameIdentity(idA, idB, db = null) {
  if (!idA || !idB) return false
  if (idA === idB) return true

  const keyA = normalizeIdentityKey(idA)
  const keyB = normalizeIdentityKey(idB)
  if (keyA && keyB && keyA === keyB) return true

  if (db?.data?.users) {
    const pA = getPlayer(db, idA) || Object.values(db.data.users).find(p => p?.id === idA || normalizeIdentityKey(p?.id) === keyA)
    const pB = getPlayer(db, idB) || Object.values(db.data.users).find(p => p?.id === idB || normalizeIdentityKey(p?.id) === keyB)
    if (pA && pB && pA.id === pB.id) return true
    if (pA?.phone && pB?.phone && String(pA.phone) === String(pB.phone)) return true
  }

  return false
}

/** Get or initialize the slot Map for a specific group. */
function getGroupSlotsMap(groupJid) {
  let slots = groupDungeonSlots.get(groupJid)
  if (!slots) {
    slots = new Map()
    groupDungeonSlots.set(groupJid, slots)
  }
  return slots
}

/**
 * Return an array of all active player slots currently occupying dungeons in this group.
 * Synchronizes with player.inDungeon: if the player is no longer in a dungeon,
 * their slot is cleaned up automatically.
 */
export function getActiveDungeonSlots(groupJid, db = null) {
  const slotsMap = getGroupSlotsMap(groupJid)
  const active = []

  for (const [key, slot] of [...slotsMap.entries()]) {
    if (db) {
      const p = getPlayer(db, slot.playerId)
      if (!p || !p.inDungeon) {
        slotsMap.delete(key)
        continue
      }
    }
    active.push(slot)
  }

  return active
}

/**
 * Check whether a player can enter a dungeon in this group.
 * Returns { allowed: true } or { allowed: false, activeCount, maxSlots: 2, reason: string }
 */
export function canEnterDungeon(groupJid, player, userJid, db = null) {
  if (!groupJid || !player) return { allowed: true }

  const isPrem = isPremiumActive(player)
  const pId = player.id || userJid

  const slotsMap = getGroupSlotsMap(groupJid)

  // If this player is already registered in a slot in this group, they are allowed to proceed/continue
  for (const slot of slotsMap.values()) {
    if (isSameIdentity(slot.playerId, pId, db) || isSameIdentity(slot.userJid, userJid, db)) {
      return { allowed: true }
    }
  }

  // Premium players bypass the occupancy cap completely
  if (isPrem) {
    return { allowed: true, isPremium: true }
  }

  // Clean stale slots against db
  const active = getActiveDungeonSlots(groupJid, db)
  // Count non-premium users occupying standard slots
  const nonPremCount = active.filter(s => !s.isPremium).length

  if (nonPremCount >= MAX_DUNGEON_OCCUPANCY) {
    return {
      allowed: false,
      activeCount: nonPremCount,
      maxSlots: MAX_DUNGEON_OCCUPANCY,
      reason: `⚠️ The dungeon is currently at capacity in this group (*${nonPremCount}/${MAX_DUNGEON_OCCUPANCY}* players).\n` +
              `Please wait for someone to exit or finish their run!\n\n` +
              `_👑 Premium players can bypass this limit with *${config.prefix}premium*._`,
    }
  }

  return { allowed: true, activeCount: nonPremCount }
}

/**
 * Record a player entering a dungeon or refresh their slot.
 */
export function recordDungeonEntry(groupJid, player, userJid) {
  if (!groupJid || !player) return
  const slotsMap = getGroupSlotsMap(groupJid)
  const pId = player.id || userJid
  const isPrem = isPremiumActive(player)
  const now = Date.now()

  // Find if already present under any alias key
  for (const [key, slot] of slotsMap.entries()) {
    if (isSameIdentity(slot.playerId, pId) || isSameIdentity(slot.userJid, userJid)) {
      slot.lastActivityAt = now
      slot.isPremium = isPrem
      slot.userJid = userJid
      return slot
    }
  }

  const slotData = {
    playerId: pId,
    userJid: userJid,
    isPremium: isPrem,
    enteredAt: now,
    lastActivityAt: now,
  }

  slotsMap.set(pId, slotData)
  return slotData
}

/**
 * Touch a player's dungeon activity timestamp in this group (or any group they are active in).
 */
export function touchDungeonActivity(groupJid, player, userJid) {
  if (!player) return false
  const pId = player.id || userJid
  const now = Date.now()
  let touched = false

  if (groupJid) {
    const slotsMap = getGroupSlotsMap(groupJid)
    for (const slot of slotsMap.values()) {
      if (isSameIdentity(slot.playerId, pId) || isSameIdentity(slot.userJid, userJid)) {
        slot.lastActivityAt = now
        touched = true
        break
      }
    }
  } else {
    // If no groupJid provided, search across all groups
    for (const slotsMap of groupDungeonSlots.values()) {
      for (const slot of slotsMap.values()) {
        if (isSameIdentity(slot.playerId, pId) || isSameIdentity(slot.userJid, userJid)) {
          slot.lastActivityAt = now
          touched = true
        }
      }
    }
  }

  return touched
}

/**
 * Release a player from the dungeon slots in a group (e.g. on dungeon leave, defeat, or finish).
 */
export function releaseDungeonSlot(groupJid, player, userJid) {
  if (!player && !userJid) return false
  const pId = player?.id || userJid
  let removed = false

  if (groupJid) {
    const slotsMap = getGroupSlotsMap(groupJid)
    for (const [key, slot] of [...slotsMap.entries()]) {
      if (isSameIdentity(slot.playerId, pId) || isSameIdentity(slot.userJid, userJid)) {
        slotsMap.delete(key)
        removed = true
      }
    }
  } else {
    for (const slotsMap of groupDungeonSlots.values()) {
      for (const [key, slot] of [...slotsMap.entries()]) {
        if (isSameIdentity(slot.playerId, pId) || isSameIdentity(slot.userJid, userJid)) {
          slotsMap.delete(key)
          removed = true
        }
      }
    }
  }

  return removed
}

/** Clear all dungeon slot occupancy (primarily for testing or server reset). */
export function clearDungeonSlots() {
  groupDungeonSlots.clear()
}

/**
 * Run a background timeout sweep across all groups.
 * If any non-premium player has been inactive in a dungeon for >= 10 minutes:
 *   1. Kicks them out of the dungeon (sets inDungeon: false, cleans up battle state, saves checkpoint).
 *   2. Removes them from the dungeon slot.
 *   3. Broadcasts a message to the group announcing the open slot using a hidden tag-all
 *      (mentions every group participant invisibly so everyone is notified).
 */
export async function runDungeonIdleSweep(instances, db) {
  if (!instances || !db) return
  const now = Date.now()

  for (const [groupJid, slotsMap] of groupDungeonSlots.entries()) {
    for (const [slotKey, slot] of [...slotsMap.entries()]) {
      // The prompt rule:
      // "if those one are inside and wont come out
      // if they are not activ in dungeon for 10 mins d bot kicks them out of dungeon ( not d gc )
      // and the slot is open again d bot announces it s all knows it does a hidden tag all
      // but this rule doesnt apply to premium users"
      if (slot.isPremium) continue

      if (now - slot.lastActivityAt < DUNGEON_IDLE_TIMEOUT_MS) continue

      // Timed out! Kick them out of the dungeon (not the group).
      const playerId = slot.playerId
      const userJid = slot.userJid

      // 1. Mutate player state via updatePlayer
      let kickedPlayerName = 'Adventurer'
      try {
        await updatePlayer(db, playerId, p => {
          if (!p.inDungeon) return p
          kickedPlayerName = p.name || kickedPlayerName
          p.inDungeon = false
          p.inBattle = false
          p.battleState = null
          // Progress is retained in dungeonProgress and dungeonCheckpoint
          return p
        })
      } catch (err) {
        logger.warn({ err: err.message, playerId }, 'Dungeon idle sweep: failed to update player')
      }

      // 2. Remove the slot
      slotsMap.delete(slotKey)

      // 3. Find active socket for this group
      let sock = null
      for (const inst of instances) {
        if (!inst.activeSock) continue
        try {
          await inst.activeSock.groupMetadata(groupJid)
          sock = inst.activeSock
          break
        } catch {
          // not in this group, continue
        }
      }

      if (!sock) {
        // Fallback to any active socket
        sock = (instances ?? []).map(i => i.activeSock).find(Boolean)
      }

      if (!sock) continue

      // 4. Fetch group metadata to get all participant JIDs for hidden tag all
      let participantJids = []
      try {
        const meta = await getGroupMetadata(sock, groupJid)
        participantJids = (meta?.participants ?? []).map(p => p.id).filter(Boolean)
      } catch (err) {
        logger.warn({ err: err.message, groupJid }, 'Dungeon idle sweep: could not fetch group metadata for hidetag')
      }

      const idleMins = Math.round(DUNGEON_IDLE_TIMEOUT_MS / 60_000)
      const bareUser = userJid.replace(/@.*$/, '')
      const announcementText =
        `🏰 *DUNGEON SLOT OPEN!*\n` +
        `─────────────────────\n` +
        `@${bareUser} was inactive in the dungeon for ${idleMins} minutes and was escorted back to town.\n\n` +
        `🔓 A dungeon slot is now open! Anyone ready to climb may enter.\n\n` +
        `▸ *${config.prefix}enter <dungeon>* — enter a dungeon\n` +
        `▸ *${config.prefix}dungeon* — climb floors\n` +
        `▸ *${config.prefix}travel* — view dungeon map`

      const mentions = participantJids.length > 0 ? participantJids : [userJid]

      try {
        await sock.sendMessage(groupJid, {
          text: announcementText,
          mentions: mentions,
        })
        logger.info({ groupJid, playerId, userJid }, 'Dungeon idle sweep: kicked idle crawler and broadcasted open slot')
      } catch (err) {
        logger.warn({ err: err.message, groupJid }, 'Dungeon idle sweep: failed to send open announcement')
      }
    }
  }
}
