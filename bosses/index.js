/**
 * bosses/index.js
 * Barrel export of all boss definitions.
 * Each boss is a named const exported from its own file.
 *
 * To access a boss by ID:
 *   import { ALL_BOSSES, getBossById } from './bosses/index.js'
 *   const boss = getBossById('gojo_satoru')
 *
 * To access the floor -> boss map:
 *   import { BOSS_BY_FLOOR } from './bosses/index.js'
 *   const boss = BOSS_BY_FLOOR[92]
 */

// ── Season 1 End boss (Floor 50, co-op) ──────────────────────────────────────
export { the_last_prayer }    from './the_last_prayer.js'

// ── Blue Band event world boss (solo finale, off-curve sentinel floor 999) ───
export { the_end }            from './the_end.js'

// ── Grade: SS (Floors 65–75) ─────────────────────────────────────────────────
export { asta }               from './asta.js'
export { jotaro_kujo }        from './jotaro_kujo.js'
export { deku_mha }           from './deku_mha.js'
export { sasuke_uchiha }      from './sasuke_uchiha.js'
export { frieren }            from './frieren.js'
export { julius_novachrono }  from './julius_novachrono.js'
export { zeno }               from './zeno.js'
export { dio_brando }         from './dio_brando.js'
export { whitebeard }         from './whitebeard.js'
export { vegeta }             from './vegeta.js'

// ── Grade: SS+ (Floors 76–85) ────────────────────────────────────────────────
export { ichigo_kurosaki }    from './ichigo_kurosaki.js'
export { shanks }             from './shanks.js'
export { all_for_one }        from './all_for_one.js'
export { sung_jinwoo }        from './sung_jinwoo.js'
export { escanor }            from './escanor.js'
export { meliodas }           from './meliodas.js'
export { aizen_sosuke }       from './aizen_sosuke.js'
export { kaido }              from './kaido.js'
export { madara_uchiha }      from './madara_uchiha.js'
export { naruto_baryon }      from './naruto_baryon.js'
export { luffy_gear5 }        from './luffy_gear5.js'
export { kaguya_otsutsuki }   from './kaguya_otsutsuki.js'
export { eren_founding }      from './eren_founding.js'
export { mahoraga_jjk }       from './mahoraga_jjk.js'

// ── Grade: SSS (Floors 86–93) ────────────────────────────────────────────────
export { isshiki_otsutsuki }  from './isshiki_otsutsuki.js'
export { hagoromo_otsutsuki } from './hagoromo_otsutsuki.js'
export { sukuna_ryomen }      from './sukuna_ryomen.js'
export { goku_ultra_instinct }from './goku_ultra_instinct.js'
export { meruem }             from './meruem.js'
export { gojo_satoru }        from './gojo_satoru.js'
export { alucard }            from './alucard.js'
export { yhwach }             from './yhwach.js'

// ── Grade: SSS+ (Floors 94–99) ───────────────────────────────────────────────
export { rimuru_tempest }     from './rimuru_tempest.js'
export { giorno_ger }         from './giorno_ger.js'
export { reinhard_van_astrea }from './reinhard_van_astrea.js'
export { satella }            from './satella.js'
export { anos_voldigoad }     from './anos_voldigoad.js'
export { madoka_kaname }      from './madoka_kaname.js'

// ── Grade: MYTHIC / OMNI (Floors 99–100) ─────────────────────────────────────
export { lain_iwakura }       from './lain_iwakura.js'
export { truth }              from './truth.js'
export { saitama }            from './saitama.js'
export { zeno as zeno_omni }  from './zeno.js'   // alias so both names resolve

// ── Original Tower Masters (Floor 100 of each of the five main dungeons) ─────
// Ascending difficulty: Syclila < Kikaru < Celestia < Bam < Esteria.
// Each pins its own stats via statOverride and carries a unique peak ability.
export { syclila }            from './syclila.js'
export { kikaru }             from './kikaru.js'
export { celestia }           from './celestia.js'
export { bam }                from './bam.js'
export { esteria }            from './esteria.js'

// ─────────────────────────────────────────────────────────────────────────────
// Runtime collections
// ─────────────────────────────────────────────────────────────────────────────

import { the_last_prayer }    from './the_last_prayer.js'
import { the_end }            from './the_end.js'
import { asta }               from './asta.js'
import { jotaro_kujo }        from './jotaro_kujo.js'
import { deku_mha }           from './deku_mha.js'
import { sasuke_uchiha }      from './sasuke_uchiha.js'
import { frieren }            from './frieren.js'
import { julius_novachrono }  from './julius_novachrono.js'
import { zeno }               from './zeno.js'
import { dio_brando }         from './dio_brando.js'
import { whitebeard }         from './whitebeard.js'
import { vegeta }             from './vegeta.js'
import { ichigo_kurosaki }    from './ichigo_kurosaki.js'
import { shanks }             from './shanks.js'
import { all_for_one }        from './all_for_one.js'
import { sung_jinwoo }        from './sung_jinwoo.js'
import { escanor }            from './escanor.js'
import { meliodas }           from './meliodas.js'
import { aizen_sosuke }       from './aizen_sosuke.js'
import { kaido }              from './kaido.js'
import { madara_uchiha }      from './madara_uchiha.js'
import { naruto_baryon }      from './naruto_baryon.js'
import { luffy_gear5 }        from './luffy_gear5.js'
import { kaguya_otsutsuki }   from './kaguya_otsutsuki.js'
import { eren_founding }      from './eren_founding.js'
import { mahoraga_jjk }       from './mahoraga_jjk.js'
import { isshiki_otsutsuki }  from './isshiki_otsutsuki.js'
import { hagoromo_otsutsuki } from './hagoromo_otsutsuki.js'
import { sukuna_ryomen }      from './sukuna_ryomen.js'
import { goku_ultra_instinct }from './goku_ultra_instinct.js'
import { meruem }             from './meruem.js'
import { gojo_satoru }        from './gojo_satoru.js'
import { alucard }            from './alucard.js'
import { yhwach }             from './yhwach.js'
import { rimuru_tempest }     from './rimuru_tempest.js'
import { giorno_ger }         from './giorno_ger.js'
import { reinhard_van_astrea }from './reinhard_van_astrea.js'
import { satella }            from './satella.js'
import { anos_voldigoad }     from './anos_voldigoad.js'
import { madoka_kaname }      from './madoka_kaname.js'
import { lain_iwakura }       from './lain_iwakura.js'
import { truth }              from './truth.js'
import { saitama }            from './saitama.js'
import { syclila }            from './syclila.js'
import { kikaru }             from './kikaru.js'
import { celestia }           from './celestia.js'
import { bam }                from './bam.js'
import { esteria }            from './esteria.js'

/** Flat array of every boss definition, sorted by floor ascending */
export const ALL_BOSSES = [
  the_last_prayer,
  the_end,
  asta,
  jotaro_kujo,
  deku_mha,
  sasuke_uchiha,
  frieren,
  julius_novachrono,
  zeno,
  dio_brando,
  whitebeard,
  vegeta,
  ichigo_kurosaki,
  shanks,
  all_for_one,
  sung_jinwoo,
  escanor,
  meliodas,
  aizen_sosuke,
  kaido,
  madara_uchiha,
  naruto_baryon,
  luffy_gear5,
  kaguya_otsutsuki,
  eren_founding,
  mahoraga_jjk,
  isshiki_otsutsuki,
  hagoromo_otsutsuki,
  sukuna_ryomen,
  goku_ultra_instinct,
  meruem,
  gojo_satoru,
  alucard,
  yhwach,
  rimuru_tempest,
  giorno_ger,
  reinhard_van_astrea,
  satella,
  anos_voldigoad,
  madoka_kaname,
  lain_iwakura,
  truth,
  saitama,
  syclila,
  kikaru,
  celestia,
  bam,
  esteria,
].sort((a, b) => a.floor - b.floor)

/**
 * Map: floor number -> boss definition[]
 *
 * Multiple bosses can share a floor (alternate encounters, sub-bosses, etc.).
 * Use getBossesForFloor(floor) to get all bosses on a floor, or
 * getBossForFloor(floor) to get the primary (highest-grade) one.
 */
export const BOSS_BY_FLOOR = ALL_BOSSES.reduce((acc, b) => {
  if (!acc[b.floor]) acc[b.floor] = []
  acc[b.floor].push(b)
  return acc
}, /** @type {Record<number, object[]>} */ ({}))

/** Map: boss id string -> boss definition */
export const BOSS_BY_ID = Object.fromEntries(
  ALL_BOSSES.map((b) => [b.id, b])
)

/**
 * Look up a boss by its string ID.
 * @param {string} id  - e.g. 'gojo_satoru'
 * @returns {object|null}
 */
export function getBossById(id) {
  return BOSS_BY_ID[id] ?? null
}

/**
 * Get all bosses assigned to a given dungeon floor.
 * Most floors have one; some high-end floors have two (alternate encounters).
 * @param {number} floor
 * @returns {object[]}
 */
export function getBossesForFloor(floor) {
  return BOSS_BY_FLOOR[floor] ?? []
}

/**
 * Get the primary boss for a floor (highest grade; first defined if tied).
 * @param {number} floor
 * @returns {object|null}
 */
export function getBossForFloor(floor) {
  const pool = BOSS_BY_FLOOR[floor]
  if (!pool?.length) return null
  if (pool.length === 1) return pool[0]
  const order = ['OMNI', 'MYTHIC', 'SSS+', 'SSS', 'SS+', 'SS']
  return pool.slice().sort((a, b) => order.indexOf(a.grade) - order.indexOf(b.grade))[0]
}

/**
 * All boss IDs, sorted by floor.
 * Useful for validation and debug output.
 */
export const BOSS_IDS = ALL_BOSSES.map((b) => b.id)
