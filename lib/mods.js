/**
 * lib/mods.js — the mod/cheat system's core logic.
 *
 * SECURITY INVARIANT (do not break this):
 * A player-uploaded mod file is DATA, never CODE. The only field ever
 * acted on is `effect_id`, which must exactly match a key in
 * data/cheat-base.json. `flavor_code` (and every other field) is stored
 * and displayed verbatim — it is NEVER eval'd, Function()'d, parsed as
 * logic, or used to decide any effect or magnitude. If you're tempted to
 * add "smart" matching against flavor_code, don't — that turns a cosmetic
 * text field into an execution surface.
 *
 * Player schema addition (see lib/player-repo.js's top-of-file doc):
 *   mods: {
 *     owned: [
 *       {
 *         instanceId: string,   // uuid, unique per owned copy
 *         effectId:   string,   // key into cheat-base.json
 *         modName:    string,
 *         modBy:      string,
 *         flavorCode: string,
 *         acquiredAt: number,   // epoch ms
 *         source:     'created' | 'purchased',
 *       }
 *     ],
 *     active: string[],         // array of instanceId, max cheatBase.maxActiveMods
 *   },
 *   modListings: [              // this player's owned mods currently for sale
 *     { instanceId: string, price: number, listedAt: number }
 *   ]
 */
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cheatBase = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'data', 'cheat-base.json'), 'utf8'),
)

const cheatById = Object.fromEntries(cheatBase.cheats.map(c => [c.effect_id, c]))

export const MAX_ACTIVE_MODS = cheatBase.maxActiveMods

// ── Schema / lookup helpers ─────────────────────────────────────────────

/** Ensures player.mods exists with the expected shape (backfill for accounts predating this feature). */
export function ensureMods(player) {
  if (!player.mods) player.mods = { owned: [], active: [] }
  if (!Array.isArray(player.mods.owned)) player.mods.owned = []
  if (!Array.isArray(player.mods.active)) player.mods.active = []
  if (!Array.isArray(player.modListings)) player.modListings = []
  return player.mods
}

/** Returns the fixed cheat-base entry for an effect id, or undefined if not a real cheat. */
export function getCheatDef(effectId) {
  return cheatById[effectId]
}

/** Every cheat currently defined in the base (for the browsable "cheat list" / help command). */
export function listCheatDefs() {
  return cheatBase.cheats
}

/** True if the player has an active mod instance for this effect id. */
export function hasMod(player, effectId) {
  const mods = ensureMods(player)
  return mods.active.some(instanceId => {
    const inst = mods.owned.find(m => m.instanceId === instanceId)
    return inst?.effectId === effectId
  })
}

/** Returns the fixed value for an effect if the player has it active, else null. Never reads a player-supplied value. */
export function getModValue(player, effectId) {
  if (!hasMod(player, effectId)) return null
  return getCheatDef(effectId)?.value ?? null
}

/**
 * Targeted PvE catch-up for the late boss roster. It is intentionally
 * separate from damage_multiplier and never called by PvP code.
 */
export function applyHighDefenseCatchup(player, enemy, damage) {
  const boost = getModValue(player, 'boss_damage_vs_high_def')
  const defense = Number(enemy?.def ?? enemy?.stats?.def ?? 0)
  if (!boost || defense <= 3000) return damage
  return Math.max(1, Math.floor(damage * (1 + boost)))
}

// ── Validation of an uploaded mod file ──────────────────────────────────

const MAX_NAME_LEN = 40
const MAX_BY_LEN = 40
const MAX_FLAVOR_LEN = 500
const MAX_FILE_BYTES = 10 * 1024 // 10KB — these are tiny JSON files

/**
 * Validates a raw uploaded buffer against the mod file format.
 * Returns { ok: true, mod: {...} } or { ok: false, error: string }.
 * This function never executes, evals, or interprets anything from the
 * buffer beyond exact-matching effect_id against the fixed cheat base.
 */
export function parseModFile(buffer) {
  if (!Buffer.isBuffer(buffer)) return { ok: false, error: 'internal: not a buffer' }
  if (buffer.length === 0) return { ok: false, error: 'File is empty.' }
  if (buffer.length > MAX_FILE_BYTES) {
    return { ok: false, error: `File is too large (max ${MAX_FILE_BYTES / 1024}KB).` }
  }

  let data
  try {
    data = JSON.parse(buffer.toString('utf8'))
  } catch {
    return { ok: false, error: "That doesn't look like valid JSON. Check the format and try again." }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'Mod file must be a single JSON object.' }
  }

  const { mod_name, mod_by, effect_id, flavor_code } = data

  if (typeof mod_name !== 'string' || !mod_name.trim()) {
    return { ok: false, error: 'Missing or invalid "mod_name".' }
  }
  if (mod_name.length > MAX_NAME_LEN) {
    return { ok: false, error: `"mod_name" is too long (max ${MAX_NAME_LEN} chars).` }
  }

  if (typeof mod_by !== 'string' || !mod_by.trim()) {
    return { ok: false, error: 'Missing or invalid "mod_by".' }
  }
  if (mod_by.length > MAX_BY_LEN) {
    return { ok: false, error: `"mod_by" is too long (max ${MAX_BY_LEN} chars).` }
  }

  if (typeof effect_id !== 'string' || !effect_id.trim()) {
    return { ok: false, error: 'Missing or invalid "effect_id".' }
  }
  // Exact match only — no fuzzy/partial matching, ever.
  const cheat = getCheatDef(effect_id)
  if (!cheat) {
    return {
      ok: false,
      error:
        `"${effect_id}" isn't a recognized cheat effect. Use *.mod list* to see ` +
        `every valid effect_id — it must match one exactly.`,
    }
  }

  let flavorCode = ''
  if (flavor_code !== undefined) {
    if (typeof flavor_code !== 'string') {
      return { ok: false, error: '"flavor_code" must be a string.' }
    }
    flavorCode = flavor_code.slice(0, MAX_FLAVOR_LEN)
  }

  return {
    ok: true,
    mod: {
      modName: mod_name.trim(),
      modBy: mod_by.trim(),
      effectId: effect_id.trim(),
      flavorCode,
      cheatLabel: cheat.label,
    },
  }
}

// ── Mutations (call these inside updatePlayer's mutatorFn) ─────────────

/** Adds a newly-installed (self-created) mod instance to the player's collection. Does NOT auto-activate. */
export function addOwnedMod(player, parsed, source = 'created') {
  const mods = ensureMods(player)
  const instance = {
    instanceId: randomUUID(),
    effectId: parsed.effectId,
    modName: parsed.modName,
    modBy: parsed.modBy,
    flavorCode: parsed.flavorCode,
    acquiredAt: Date.now(),
    source,
  }
  mods.owned.push(instance)
  return instance
}

/** Activates an owned mod instance. Returns { ok, error? }. */
export function activateMod(player, instanceId) {
  const mods = ensureMods(player)
  const inst = mods.owned.find(m => m.instanceId === instanceId)
  if (!inst) return { ok: false, error: 'not_owned' }
  if (mods.active.includes(instanceId)) return { ok: false, error: 'already_active' }
  if (mods.active.length >= MAX_ACTIVE_MODS) return { ok: false, error: 'slots_full' }
  mods.active.push(instanceId)
  return { ok: true, instance: inst }
}

/** Deactivates an active mod instance. Returns { ok, error? }. */
export function deactivateMod(player, instanceId) {
  const mods = ensureMods(player)
  if (!mods.active.includes(instanceId)) return { ok: false, error: 'not_active' }
  mods.active = mods.active.filter(id => id !== instanceId)
  return { ok: true }
}

/** Finds an owned mod instance by case-insensitive exact or partial name match. */
export function findOwnedByName(player, query) {
  const mods = ensureMods(player)
  const q = query.toLowerCase().trim()
  return (
    mods.owned.find(m => m.modName.toLowerCase() === q) ??
    mods.owned.find(m => m.modName.toLowerCase().includes(q))
  )
}
