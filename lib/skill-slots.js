/**
 * skill-slots.js — shared active-skill loadout logic.
 *
 * `player.skills` is every active/passive skill the player has ever
 * unlocked (grows automatically on level-up, never shrinks).
 * `player.equippedSkills` is the subset actually usable in battle —
 * capped at MAX_SKILL_SLOTS, chosen by the player via .skillslot.
 *
 * Battle code (plugins/skill.js) must look up skills against
 * equippedSkills, NOT the full player.skills pool, or the 4-slot limit
 * has no effect.
 */
export const MAX_SKILL_SLOTS = 4

/**
 * Returns the player's equipped skill ids, filtered to only ones they
 * still actually own (defensive — e.g. in case of manual db edits) and
 * trimmed to MAX_SKILL_SLOTS.
 */
export function getEquippedSkills(player) {
  const owned = new Set(player.skills ?? [])
  return (player.equippedSkills ?? []).filter(id => owned.has(id)).slice(0, MAX_SKILL_SLOTS)
}

/**
 * Fills empty slots (up to MAX_SKILL_SLOTS) from the player's unlocked
 * active skills, preserving any already-equipped picks. Used on
 * register and can be reused any time we want a sane default loadout
 * instead of empty slots.
 */
export function autoFillSkillSlots(player, allSkills) {
  const activeOwnedIds = (player.skills ?? []).filter(id => {
    const def = allSkills.find(s => s.id === id)
    return def?.type === 'active'
  })

  const current = getEquippedSkills(player)
  const filled  = [...current]
  for (const id of activeOwnedIds) {
    if (filled.length >= MAX_SKILL_SLOTS) break
    if (!filled.includes(id)) filled.push(id)
  }
  player.equippedSkills = filled.slice(0, MAX_SKILL_SLOTS)
  return player.equippedSkills
}

/**
 * Standard "slot full" style message for .skillslot set, using the
 * real cap constant so wording stays consistent if it ever changes.
 */
export function skillSlotsFullMessage() {
  return `✋ All *${MAX_SKILL_SLOTS}* skill slots are full. Clear one first with *.skillslot clear <n>*.`
}
