/**
 * lib/item-art-map.js — item id/name/type -> game-icons.net icon path.
 *
 * Why this file exists: every image URL in data/items.json,
 * data/materials.json, data/named-weapons.json and the season-01 files points
 * at play.astral.qzz.io, which no longer resolves (curl: connection failed).
 * That's ~100 entries rendering as a fallback emblem in chat and as nothing at
 * all on the site, which hides anything it can't load.
 *
 * The fix is to generate the artwork from a CC-licensed icon set rather than
 * source ~100 images by hand. game-icons.net is the natural fit: it's built
 * for exactly this vocabulary (blades, ores, potions, relics), it's one
 * coherent art direction, and it's CC BY 3.0 / CC0. See vendor/game-icons for
 * the archive and NOTICE-game-icons.md for attribution.
 *
 * Matching is EXPLICIT, not fuzzy. An earlier pass tried scoring name tokens
 * against icon filenames and produced things like "Ancient Rune" -> rune-sword
 * and "Elixir" -> elixir-bottle-that-is-actually-a-bomb. When the art is
 * wrong it's worse than absent, because a wrong icon reads as a bug in the
 * game rather than as missing art. So: ids are listed one by one below, and
 * anything unlisted falls through to a type-level default, then to null —
 * and null means the caller keeps using drawEmblem(), which already looks
 * deliberate.
 */

/** Exact id -> icon. Highest priority, always wins. */
export const ICON_BY_ID = {
  // ── armor: body ──────────────────────────────────────────────────────
  leather_armor: 'delapouite/leather-armor',
  linen_robe: 'lorc/robe',
  cloth_vest: 'lorc/armor-vest',
  chainmail: 'lorc/mail-shirt',
  ashigaru_armor: 'delapouite/samurai-helmet',
  leather_vest: 'lorc/leather-vest',
  fur_cloak: 'lucasms/cloak',
  shadow_cloak: 'lorc/wing-cloak',

  // ── armor: shields ───────────────────────────────────────────────────
  iron_shield: 'sbed/shield',
  rough_shield: 'delapouite/attached-shield',
  guardian_shield: 'delapouite/cross-shield',

  // ── armor: tiered sets (helmet / chest / boots) ──────────────────────
  normal_boots: 'lorc/leather-boot',
  iron_helmet: 'lorc/visored-helm',
  iron_chestplate: 'delapouite/chest-armor',
  iron_boots: 'lorc/boots',
  diamond_helmet: 'delapouite/black-knight-helm',
  diamond_chestplate: 'lorc/breastplate',
  diamond_boots: 'lorc/steeltoe-boots',
  titanium_helmet: 'caro-asercion/warlord-helmet',
  titanium_chestplate: 'delapouite/abdominal-armor',
  titanium_boots: 'delapouite/metal-boot',
  divine_helmet: 'delapouite/centurion-helmet',
  divine_chestplate: 'delapouite/shoulder-armor',
  divine_boots: 'lorc/winged-leg',

  // ── consumables: potions ─────────────────────────────────────────────
  health_potion: 'delapouite/health-potion',
  mana_potion: 'delapouite/magic-potion',
  hi_health_potion: 'lorc/standing-potion',
  hi_mana_potion: 'lorc/potion-ball',
  mega_health_potion: 'caro-asercion/round-potion',
  mega_mana_potion: 'lorc/bubbling-flask',
  elixir: 'lorc/fizzing-flask',
  ether: 'lorc/round-bottom-flask',
  phoenix_down: 'lorc/feather',

  // ── consumables: cures + draughts ────────────────────────────────────
  antidote: 'sbed/vial',
  burn_salve: 'delapouite/medicine-pills',
  warm_cloth: 'delapouite/towel',
  smelling_salts: 'lorc/smoking-orb',
  clear_tonic: 'lorc/drink-me',
  full_remedy: 'lorc/heart-bottle',
  regen_herb: 'delapouite/herbs-bundle',
  warriors_draught: 'lorc/muscle-up',
  swiftness_draught: 'lorc/wingfoot',
  sages_draught: 'lorc/brain-freeze',
  stone_skin_draught: 'lorc/stone-block',
  barrier_tonic: 'lorc/bubble-field',

  // ── PvP battle consumables (wager kit) ───────────────────────────────
  // These reuse glyphs already spoken for elsewhere. That is deliberate and
  // consistent with the ore comment below: the rarity tint plus the name plate
  // already separate them on the kit grid, and there is no closer glyph in the
  // vendored set of 162.
  second_wind_draught: 'lorc/heart-bottle',
  warcry_tonic: 'lorc/fizzing-flask',
  ironskin_draught: 'lorc/bubbling-flask',
  focus_vial: 'sbed/vial',
  cracked_warplate: 'lorc/breastplate',
  honed_whetstone: 'lorc/stone-block',

  // ── relics ───────────────────────────────────────────────────────────
  totem_of_undying: 'lorc/totem-head',
  gamblers_relic: 'delapouite/rolling-dices',
  sentinels_bulwark: 'lorc/locked-fortress',
  arcane_battery: 'delapouite/energy-tank',
  berserkers_chain: 'lorc/crossed-chains',
  emberheart_core: 'lorc/burning-embers',
  phoenix_clasp: 'lorc/feather',

  // ── materials ────────────────────────────────────────────────────────
  // The three plain ores share one icon deliberately — the rarity tint and
  // the name plate already tell them apart, and three near-identical rocks
  // would be worse than one honest one.
  iron_ore: 'faithtoken/minerals',
  wood_plank: 'delapouite/planks',
  leather_scrap: 'delapouite/animal-hide',
  beast_hide: 'delapouite/fur-shirt',
  monster_fang: 'skoll/fangs',
  silver_ore: 'faithtoken/minerals',
  arcane_essence: 'lorc/magic-swirl',
  dragon_scale: 'lorc/dorsal-scales',
  mythril_ore: 'faithtoken/minerals',
  ancient_rune: 'lorc/rune-stone',
  phoenix_feather: 'lorc/two-feathers',
  void_crystal: 'lorc/crystal-cluster',
  diamond_ore: 'lorc/crystal-growth',
  astral_shard: 'lorc/crystal-shine',
  celestial_ore: 'delapouite/falling-star',
  eternity_dust: 'lorc/pollen-dust',
  titanium_ore: 'lorc/metal-bar',

  // ── named weapons: blades ────────────────────────────────────────────
  wado_ichimonji: 'delapouite/katana',
  tensa_zangetsu: 'lorc/shard-sword',
  kubikiribocho: 'lorc/meat-cleaver',
  nichirin_blade: 'lorc/sparkling-sabre',
  lostvayne_blade: 'lorc/sword-array',
  venuzdonoa: 'lorc/dark-squad',
  sovereign_blade: 'lorc/relic-blade',
  bisento_of_storms: 'delapouite/sharp-halberd',
  kyoka_suigetsu: 'lorc/mirror-mirror',
  death_scythe: 'lorc/reaper-scythe',

  // ── named weapons: worn ──────────────────────────────────────────────
  one_for_all_gauntlets: 'delapouite/gauntlet',
  divine_protection_aegis: 'delapouite/dragon-shield',
  six_eyes_blindfold: 'delapouite/blindfold',
  baryon_mode_headband: 'delapouite/headband-knot',
  dragon_sin_cuirass: 'lorc/scale-mail',
  ultra_ego_plate: 'lorc/shoulder-scales',
  shunpo_greaves: 'lorc/wingfoot',
  gate_of_babylon_core: 'delapouite/gold-stack',

  // ── weapons (data/weapons.json) ──────────────────────────────────────
  // Every entry here is `type: weapon`, so without explicit ids all 85 would
  // fall through to the ICON_BY_TYPE default and render as 85 identical
  // broadswords. Icons repeat within a weapon class on purpose — game-icons
  // has three staves and four wands against ~20 caster weapons, and the
  // rarity tint plus the name plate already tell a Training Staff from a
  // Divine Staff. What never repeats is the class: a bow is never a sword.
  iron_sword: 'lorc/pointy-sword',
  steel_sword: 'lorc/broadsword',
  longsword: 'delapouite/two-handed-sword',
  katana: 'delapouite/katana',
  silver_blade: 'lorc/shining-sword',
  centurion_blade: 'lorc/relic-blade',
  legion_broadsword: 'delapouite/sword-brandish',
  shadow_blade: 'lorc/bat-blade',
  veiled_edge: 'lorc/dripping-blade',
  tricksters_blade: 'skoll/switchblade',
  rapier: 'lorc/piercing-sword',
  moonlit_rapier: 'lorc/sparkling-sabre',
  centurions_rapier: 'lorc/crossed-sabres',
  voidtouched_katana: 'lorc/rune-sword',
  astral_sword: 'lorc/winged-sword',
  astral_katana: 'lorc/energy-sword',
  rift_blade: 'lorc/fragmented-sword',
  eternal_blade: 'lorc/zeus-sword',
  eternal_katana: 'delapouite/ancient-sword',

  rusty_dagger: 'lorc/plain-dagger',
  twin_daggers: 'lorc/daggers',
  serrated_dagger: 'lorc/broad-dagger',
  hunting_knife: 'lorc/bowie-knife',
  nightshade_dagger: 'lorc/dripping-knife',
  jesters_knives: 'lorc/thrown-daggers',
  abyssal_dagger: 'lorc/sacrificial-dagger',
  rift_dagger: 'lorc/flying-dagger',
  sable_fang: 'lorc/bestial-fangs',

  oak_staff: 'lorc/wizard-staff',
  ashwood_staff: 'lorc/wizard-staff',
  illusion_staff: 'delapouite/crescent-staff',
  void_staff: 'delapouite/skull-staff',
  end_staff: 'delapouite/skull-staff',
  novice_wand: 'lorc/fairy-wand',
  apprentice_wand: 'lorc/fairy-wand',
  arcane_rod: 'lorc/crystal-wand',
  astral_wand: 'lorc/crystal-wand',
  whispering_wand: 'delapouite/lunar-wand',
  charlatans_cane: 'delapouite/magick-trick',
  void_wand: 'lorc/vortex',
  dimensional_wand: 'lorc/magic-portal',
  astral_scepter: 'delapouite/winged-scepter',
  infinity_wand: 'willdabeast/orb-wand',

  iron_mace: 'delapouite/flanged-mace',
  guardians_mace: 'lorc/spiked-mace',
  spiked_club: 'delapouite/wood-club',
  bone_club: 'delapouite/bone-mace',
  illusive_hammer: 'lorc/flat-hammer',
  iron_sentinel_hammer: 'delapouite/warhammer',
  war_pick: 'delapouite/war-pick',
  legion_warpick: 'delapouite/war-pick',
  battle_axe: 'lorc/battle-axe',
  iron_legion_axe: 'delapouite/war-axe',
  rift_forged_axe: 'delapouite/magic-axe',
  obsidian_scythe: 'lorc/crescent-blade',
  shadow_reaper: 'lorc/scythe',
  void_reaper: 'lorc/reaper-scythe',

  bronze_spear: 'lorc/stone-spear',
  battle_spear: 'lorc/spears',
  twilight_spear: 'lorc/barbed-spear',
  centurion_spear: 'delapouite/sun-spear',
  dimensional_spear: 'lorc/spear-hook',
  eternal_spear: 'delapouite/magic-trident',

  short_bow: 'delapouite/bow-arrow',
  hunters_bow: 'delapouite/bow-string',
  phantom_bow: 'lorc/arrow-flights',
  legionnaires_bow: 'delapouite/quiver',
  astral_bow: 'lorc/arrow-cluster',
  celestial_bow: 'lorc/lightning-bow',
  rogues_crossbow: 'carl-olsen/crossbow',

  // Tiered trainers: same class, climbing rarity.
  t_sword_1: 'lorc/pointy-sword',
  t_sword_2: 'lorc/broadsword',
  t_sword_3: 'lorc/shining-sword',
  t_sword_4: 'lorc/energy-sword',
  t_sword_5: 'lorc/zeus-sword',
  t_dagger_1: 'lorc/plain-dagger',
  t_dagger_2: 'lorc/broad-dagger',
  t_dagger_3: 'lorc/curvy-knife',
  t_dagger_4: 'lorc/diving-dagger',
  t_dagger_5: 'lorc/sacrificial-dagger',
  t_staff_1: 'lorc/wizard-staff',
  t_staff_2: 'lorc/wizard-staff',
  t_staff_3: 'delapouite/crescent-staff',
  t_staff_4: 'delapouite/crescent-staff',
  // Not skull-staff, despite it being the obvious "top tier staff" pick — a
  // skull on a weapon called Divine Staff reads as the wrong faction.
  t_staff_5: 'delapouite/bird-scepter',

  // ── tools (data/tools.json) ──────────────────────────────────────────
  // All five share one icon, which is not laziness: game-icons has exactly
  // one honest pickaxe (lorc/mining). The near-misses are traps —
  // `pick-of-destiny` is a guitar plectrum, `miner` is a person, and
  // `war-pick` is already a weapon here, so borrowing it would make a tool
  // and a weapon indistinguishable in an inventory list. Rarity tint plus
  // the name plate separate Wooden from Celestial, same as the staves.
  wooden_pickaxe: 'lorc/mining',
  iron_pickaxe: 'lorc/mining',
  mythril_pickaxe: 'lorc/mining',
  diamond_pickaxe: 'lorc/mining',
  celestial_pickaxe: 'lorc/mining',

  // ── season 01 ────────────────────────────────────────────────────────
  ender_pearl: 'delapouite/oyster-pearl',
  cracked_ender_shard: 'delapouite/broken-pottery',
  astral_fountain_water: 'delapouite/water-flask',
  singing_river_charm: 'lorc/ringing-bell',
  sealbound_ash: 'lorc/dust-cloud',
  mei_prayer_bead: 'delapouite/prayer-beads',
  willow_sightline_lens: 'lorc/spectacle-lenses',
  bar_tab_receipt: 'lorc/scroll-unfurled',
  astral_dust: 'delapouite/sparkles',
  iron_box: 'skoll/open-chest',
  diamond_box: 'lorc/locked-chest',
  mythic_box: 'lorc/crown-coin',
  willow_glasses: 'lorc/spectacle-lenses',
  urahara_stick: 'lorc/wizard-staff',
}

/**
 * Fallback by item type, for anything added to data/ later that nobody has
 * mapped yet. Broad on purpose — a generic sword for an unmapped weapon is
 * fine; a specific wrong sword is not.
 */
export const ICON_BY_TYPE = {
  weapon: 'lorc/broadsword',
  armor: 'delapouite/chest-armor',
  consumable: 'delapouite/health-potion',
  material: 'faithtoken/minerals',
  relic: 'lorc/gem-pendant',
  tool: 'lorc/mining',
  misc: 'lorc/swap-bag',
}

/**
 * Hand-drawn raster art, by item id, living in lib/assets/items/.
 *
 * These beat everything above. The vendor SVGs are a good floor for ~100 items,
 * but a few items have real art made for them, and a real sprite should never
 * lose to a generic glyph. The value is a filename, not a path, so the art
 * directory is one fact owned by lib/item-art-render.mjs.
 *
 * A raster is drawn as-is: no rarity recolor, because recoloring a finished
 * sprite would wreck it. It still gets the rarity wash and frame around it.
 */
export const RASTER_BY_ID = {
  totem_of_undying: 'totem_of_undying.png',
}

/** The raster filename for an entry, or null when there is no hand-drawn art. */
export function rasterFor(entry = {}) {
  if (!entry) return null
  return RASTER_BY_ID[entry.id] ?? null
}

/** Resolves an entry to an icon path, or null to keep the drawn emblem. */
export function iconFor(entry = {}) {
  if (!entry) return null
  const byId = ICON_BY_ID[entry.id]
  if (byId) return byId
  const type = String(entry.type ?? entry.rewardType ?? '').toLowerCase()
  return ICON_BY_TYPE[type] ?? null
}
