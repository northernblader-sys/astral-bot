/**
 * migrate-skillpack-ids.mjs — one-time migration for the Skill Pack v2
 * data/skills.json swap.
 *
 * All 50 old "pack_"-prefixed skills were removed. This migration:
 *   1. Renames the 35 kept-in-spirit common/uncommon/rare skills to their
 *      new "[Legacy] ..." ids (same mechanics, id/name changed only).
 *   2. Replaces the 15 removed mythic(5)+epic(10) skills with a 1:1
 *      equivalent from the new mythic(10)/epic(10) set, so no player loses
 *      a skill outright — everyone who owned an old top-tier pack skill
 *      gets a same-or-higher-tier replacement.
 *
 * Idempotent: running twice is a no-op the second time (old ids will
 * already be gone from every player.skills array).
 *
 * Usage — do NOT run this as a standalone process against db.json directly
 * while the bot is live (risk of racing the live process's own writes).
 * Instead, import applySkillpackMigration and call it once from an admin
 * command or startup hook using the bot's own live `db` instance:
 *
 *   import { applySkillpackMigration } from '../scripts/migrate-skillpack-ids.mjs'
 *   import { updateAllPlayers } from '../lib/player-repo.js'
 *   const changed = await updateAllPlayers(db, applySkillpackMigration)
 *   console.log(changed ? 'migration applied' : 'nothing to migrate')
 *
 * Re-run safe: wrap in your own admin command guarded so it can only be
 * triggered once (or just run it once manually via a REPL/one-off script
 * that requires the bot process, then delete the trigger).
 */

// old_id -> new_id. Built from data/skills.json (before/after diff) at
// migration-authoring time — see id_migration_legacy.json and
// id_migration_replaced.json for the generation record.
export const ID_MAP = {
  // ── 35 legacy common/uncommon/rare — renamed in place, same mechanics ──
  "pack_omega_devastation_of_the_fallen_sun": "pack_legacy_omega_devastation_of_the_fallen_sun",
  "pack_celestial_wrath_of_a_thousand_suns": "pack_legacy_celestial_wrath_of_a_thousand_suns",
  "pack_divine_requiem_unbound": "pack_legacy_divine_requiem_unbound",
  "pack_divine_uprising_of_the_broken_sky": "pack_legacy_divine_uprising_of_the_broken_sky",
  "pack_void_verdict_of_the_final_hour": "pack_legacy_void_verdict_of_the_final_hour",
  "pack_infernal_verdict_of_a_thousand_suns": "pack_legacy_infernal_verdict_of_a_thousand_suns",
  "pack_radiant_requiem_of_endless_night": "pack_legacy_radiant_requiem_of_endless_night",
  "pack_nemesis_malice_of_a_thousand_suns": "pack_legacy_nemesis_malice_of_a_thousand_suns",
  "pack_thundering_rampage_of_the_astral_sea": "pack_legacy_thundering_rampage_of_the_astral_sea",
  "pack_divine_convergence_of_the_end_times": "pack_legacy_divine_convergence_of_the_end_times",
  "pack_forsaken_judgement_of_endless_night": "pack_legacy_forsaken_judgement_of_endless_night",
  "pack_frostbound_extinction_of_endless_night": "pack_legacy_frostbound_extinction_of_endless_night",
  "pack_fallen_fracture_of_endless_night": "pack_legacy_fallen_fracture_of_endless_night",
  "pack_celestial_collapse_incarnate": "pack_legacy_celestial_collapse_incarnate",
  "pack_cosmic_nova_of_endless_night": "pack_legacy_cosmic_nova_of_endless_night",
  "pack_hollow_rampage_of_the_end_times": "pack_legacy_hollow_rampage_of_the_end_times",
  "pack_primordial_ascension_of_endless_night": "pack_legacy_primordial_ascension_of_endless_night",
  "pack_ethereal_extinction_of_the_last_god": "pack_legacy_ethereal_extinction_of_the_last_god",
  "pack_thundering_judgement_of_the_last_god": "pack_legacy_thundering_judgement_of_the_last_god",
  "pack_infernal_purge_of_the_final_hour": "pack_legacy_infernal_purge_of_the_final_hour",
  "pack_primordial_rampage_of_infinite_ruin": "pack_legacy_primordial_rampage_of_infinite_ruin",
  "pack_infernal_judgement_of_the_last_god": "pack_legacy_infernal_judgement_of_the_last_god",
  "pack_astral_fracture_of_the_final_hour": "pack_legacy_astral_fracture_of_the_final_hour",
  "pack_astral_annihilation_of_the_broken_sky": "pack_legacy_astral_annihilation_of_the_broken_sky",
  "pack_hollow_requiem_incarnate": "pack_legacy_hollow_requiem_incarnate",
  "pack_celestial_devastation_incarnate": "pack_legacy_celestial_devastation_incarnate",
  "pack_fallen_cataclysm_of_a_thousand_suns": "pack_legacy_fallen_cataclysm_of_a_thousand_suns",
  "pack_abyssal_eclipse_of_endless_night": "pack_legacy_abyssal_eclipse_of_endless_night",
  "pack_infernal_nova_of_the_void_throne": "pack_legacy_infernal_nova_of_the_void_throne",
  "pack_thundering_requiem_of_a_thousand_suns": "pack_legacy_thundering_requiem_of_a_thousand_suns",
  "pack_frostbound_fracture_incarnate": "pack_legacy_frostbound_fracture_incarnate",
  "pack_apex_torment_of_the_void_throne": "pack_legacy_apex_torment_of_the_void_throne",
  "pack_omega_reckoning_unbound": "pack_legacy_omega_reckoning_unbound",
  "pack_nemesis_reckoning_of_the_shattered_realm": "pack_legacy_nemesis_reckoning_of_the_shattered_realm",
  "pack_eternal_doom_of_the_end_times": "pack_legacy_eternal_doom_of_the_end_times",

  // ── 5 old mythic -> 1:1 into new mythic set ──
  "pack_the_world_eater_s_verdict": "pack_kamehameha",
  "pack_requiem_of_the_last_star": "pack_spirit_bomb",
  "pack_sovereign_of_the_collapsing_sky": "pack_final_flash",
  "pack_godless_hour_absolute_zero": "pack_hollow_purple",
  "pack_extinction_psalm_of_the_void_throne": "pack_serious_punch",

  // ── 10 old epic -> 1:1 into new epic (formerly "legendary" list) set ──
  "pack_forsaken_devastation_of_the_astral_sea": "pack_galick_gun",
  "pack_astral_collapse_incarnate": "pack_special_beam_cannon",
  "pack_frostbound_torment_of_the_end_times": "pack_rasengan",
  "pack_forsaken_requiem_unbound": "pack_chidori",
  "pack_ethereal_fracture_of_endless_night": "pack_detroit_smash",
  "pack_thundering_nova_of_the_end_times": "pack_starburst_stream",
  "pack_hollow_malice_of_the_shattered_realm": "pack_fire_dragon_s_roar",
  "pack_radiant_purge_of_the_shattered_realm": "pack_water_surface_slash",
  "pack_frostbound_onslaught_eternal": "pack_tri_beam",
  "pack_radiant_annihilation_of_the_fallen_sun": "pack_death_beam",
}

/**
 * applySkillpackMigration(users) -> boolean
 * `users` is db.data.users (id -> player object map), matching
 * updateAllPlayers()'s mutatorFn contract exactly.
 */
export async function applySkillpackMigration(users) {
  let changed = false

  for (const id of Object.keys(users)) {
    const player = users[id]
    if (!Array.isArray(player.skills) || player.skills.length === 0) continue

    let touchedThisPlayer = false
    const remapped = player.skills.map((skillId) => {
      const newId = ID_MAP[skillId]
      if (newId) touchedThisPlayer = true
      return newId ?? skillId
    })

    if (touchedThisPlayer) {
      // De-dupe: if migration would grant an id the player already has
      // (e.g. two old ids mapping into the same new one — shouldn't happen
      // with this 1:1 map, but guard anyway), keep the array unique.
      player.skills = [...new Set(remapped)]
      changed = true
    }

    // equippedAbilities/abilityInventory are a separate system
    // (data/abilities.json is currently empty per player-repo.js's own
    // doc comment) and do not reference data/skills.json ids, so no
    // remapping needed there.
  }

  return changed
}
