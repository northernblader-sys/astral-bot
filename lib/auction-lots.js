/**
 * auction-lots.js — what the Auction House is allowed to sell, and how each
 * kind of thing is handed to the winner.
 *
 * The auction used to accept ids from data/auction.json only, so the single
 * global auction could never be anything but a piece of mythic gear. Anything
 * the game has an id for can be a lot now: gear, characters, pets and summons
 * (beasts). Each kind lives in a different place on the player record, so a
 * lot carries its own grant() rather than the auction hard-coding
 * `inventory.push`.
 *
 * Resolution order matters: the mythic auction catalog wins, then gear, then
 * characters, then pets, then beasts — so `solaris_reaver` still means what it
 * always meant, and an id collision never silently changes what is being sold.
 * An owner can force a kind with `type:id` (e.g. `pet:field_mouse`) when two
 * catalogs share a name.
 */
import {
  auctionItems, allItems, characters, pets, beasts,
} from './game-data.js'
import { hasInventoryRoom } from './inventory-limits.js'
import { BEAST_MAX_OWNED } from './beast-engine.js'

export const LOT_KINDS = ['item', 'character', 'pet', 'beast']

const KIND_LABEL = {
  item:      '🗡️ Equipment',
  character: '🎴 Character',
  pet:       '🐾 Pet',
  beast:     '🐉 Summon',
}

const SLOT_LABEL = {
  weapon: '⚔️ Weapon', offhand: '🛡️ Offhand', helmet: '⛑️ Helmet',
  chestplate: '👕 Chestplate', boots: '👢 Boots', relic: '💠 Relic',
}

const RARITY_ICON = {
  common: '⬜', uncommon: '🟩', rare: '🟦', epic: '🟪',
  legendary: '🟨', mythic: '🟥',
}

function statLine(statBonuses) {
  return Object.entries(statBonuses ?? {})
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k.toUpperCase()} +${v}`)
    .join(' · ')
}

/**
 * Match strength, tried in order ACROSS every catalog before falling to the
 * next one. Catalog order alone isn't enough: a loose name match in the gear
 * list would otherwise beat an exact id in the character list, so
 * `.auction start mei` sold "Mei's Prayer Bead" instead of Mei.
 */
const MATCHERS = [
  (e, q, slug) => String(e.id).toLowerCase() === q || String(e.id).toLowerCase() === slug,
  (e, q) => String(e.name ?? '').toLowerCase() === q,
  (e, q) => String(e.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '') === q.replace(/[^a-z0-9]+/g, ''),
  (e, q) => String(e.name ?? '').toLowerCase().includes(q),
]

// ── Per-kind adapters ──────────────────────────────────────────────────────
// grant() runs INSIDE an updatePlayer mutator. It returns
// { ok: true } or { ok: false, reason } — reason is shown to the group when a
// sale can't be completed, and the escrowed bid is refunded instead.

function itemLot(def) {
  return {
    kind: 'item',
    id: def.id,
    name: def.name,
    rarity: def.rarity ?? 'rare',
    levelReq: def.levelReq ?? 1,
    image: def.image ?? null,
    description: def.description ?? null,
    startingBid: def.startingBid ?? null,
    detail: [SLOT_LABEL[def.slot] ?? def.type ?? 'Item', statLine(def.statBonuses)]
      .filter(Boolean).join(' · '),
    grant(player) {
      if (!hasInventoryRoom(player, 1)) return { ok: false, reason: 'their inventory is full' }
      player.inventory = player.inventory ?? []
      player.inventory.push(def.id)
      return { ok: true }
    },
  }
}

function characterLot(def) {
  return {
    kind: 'character',
    id: def.id,
    name: `${def.emoji ? def.emoji + ' ' : ''}${def.name}`,
    rarity: def.rarity ?? 'legendary',
    levelReq: def.levelReq ?? 1,
    image: def.image ?? null,
    description: def.description ?? null,
    startingBid: null,
    detail: [
      def.stars ? `${'★'.repeat(def.stars)}` : null,
      def.ability?.name ? `Ability: ${def.ability.name}` : null,
    ].filter(Boolean).join(' · '),
    grant(player) {
      player.ownedCharacters = player.ownedCharacters ?? []
      if (player.ownedCharacters.includes(def.id)) {
        return { ok: false, reason: `they already own ${def.name}` }
      }
      player.ownedCharacters.push(def.id)
      return { ok: true }
    },
  }
}

function petLot(def) {
  return {
    kind: 'pet',
    id: def.id,
    name: `${def.emoji ? def.emoji + ' ' : ''}${def.name}`,
    rarity: def.rarity ?? 'common',
    levelReq: def.levelReq ?? 1,
    image: def.image ?? null,
    description: def.description ?? null,
    startingBid: null,
    detail: statLine(def.statBonuses),
    grant(player) {
      player.pets = player.pets ?? []
      if (player.pets.includes(def.id)) {
        return { ok: false, reason: `they already own ${def.name}` }
      }
      player.pets.push(def.id)
      return { ok: true }
    },
  }
}

function beastLot(def) {
  return {
    kind: 'beast',
    id: def.id,
    name: `${def.emoji ? def.emoji + ' ' : ''}${def.name}`,
    rarity: def.rarity ?? 'common',
    levelReq: def.levelReq ?? 1,
    image: def.image ?? null,
    description: def.description ?? null,
    startingBid: null,
    detail: def.baseStats
      ? `ATK ${def.baseStats.atk} · DEF ${def.baseStats.def} · HP ${def.baseStats.maxHp}`
      : '',
    grant(player) {
      player.beastInventory = player.beastInventory ?? []
      player.summonedBeasts = player.summonedBeasts ?? []
      // Always recorded in the permanent collection. The live roster is capped,
      // so a full roster is not a failed sale — they keep the beast and can
      // swap it in later.
      player.beastInventory.push({ beastId: def.id, obtainedAt: Date.now() })
      if (player.summonedBeasts.length < BEAST_MAX_OWNED) {
        player.summonedBeasts.push({
          beastId: def.id,
          cp: def.startingCp ?? 0,
          obtainedAt: Date.now(),
        })
        return { ok: true }
      }
      return { ok: true, note: `roster full — added to their collection, swap it in with the beast menu` }
    },
  }
}

const CATALOGS = [
  { kind: 'item',      list: auctionItems, make: itemLot },
  { kind: 'item',      list: allItems,     make: itemLot },
  { kind: 'character', list: characters,   make: characterLot },
  { kind: 'pet',       list: pets,         make: petLot },
  { kind: 'beast',     list: beasts,       make: beastLot },
]

/**
 * Resolves an owner-supplied id/name into a lot, or null.
 * Accepts an optional `kind:` prefix to disambiguate, e.g. "pet:shadow_cat".
 */
export function resolveAuctionLot(query) {
  if (!query) return null
  let wanted = null
  let rest = String(query).trim()

  const m = rest.match(/^(item|gear|character|char|pet|beast|summon)\s*:\s*(.+)$/i)
  if (m) {
    const alias = m[1].toLowerCase()
    wanted = alias === 'gear' ? 'item'
      : alias === 'char' ? 'character'
      : alias === 'summon' ? 'beast'
      : alias
    rest = m[2].trim()
  }

  const q = rest.toLowerCase().trim()
  const slug = q.replace(/\s+/g, '_')

  for (const match of MATCHERS) {
    for (const cat of CATALOGS) {
      if (wanted && cat.kind !== wanted) continue
      const def = cat.list.find(e => match(e, q, slug))
      if (def) return cat.make(def)
    }
  }
  return null
}

export function kindLabel(kind) {
  return KIND_LABEL[kind] ?? kind
}

export function rarityIcon(rarity) {
  return RARITY_ICON[String(rarity).toLowerCase()] ?? '🟦'
}

/** Header block shared by the listing, the start announcement and bids. */
export function describeLot(lot) {
  const lines = [
    `${rarityIcon(lot.rarity)} *${lot.name}* _(${String(lot.rarity).replace(/^./, c => c.toUpperCase())})_`,
    [kindLabel(lot.kind), lot.levelReq > 1 ? `🔒 Lvl ${lot.levelReq}` : null, lot.detail || null]
      .filter(Boolean).join(' · '),
  ]
  return lines.filter(Boolean).join('\n')
}

/** A few valid ids per kind, for the usage/error text. */
export function exampleIds() {
  return {
    item: (auctionItems[0] ?? {}).id ?? 'solaris_reaver',
    character: (characters[0] ?? {}).id ?? 'mei',
    pet: (pets[0] ?? {}).id ?? 'field_mouse',
    beast: (beasts[0] ?? {}).id ?? 'ember_hatchling',
  }
}
