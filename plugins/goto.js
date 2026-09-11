/**
 * plugins/goto.js — walk around inside an empire.
 *
 * A light navigation layer over the buildings a realm has already raised. Where
 * .empire visit moves you between empires on the world map, .goto moves you
 * between the places INSIDE the one you are standing in: the town square, the
 * market, the coffee house, the bank, the blacksmith, the barracks. It writes a
 * single per-player field (player.empireSpot) and shows the scene there plus the
 * exact command you use to act. It never touches player.location (the world map)
 * or player.visitingEmpire (the visit pointer), so travel and dungeons keep
 * working untouched. Read-mostly: the only write is your own position, and it
 * never broadcasts.
 *
 * "Where am I standing?" resolves in physical order: an empire you are visiting
 * comes first (you actually travelled there), then your own, then one you are a
 * citizen of. A saved spot the current empire lacks quietly becomes the town
 * square, so a stale position can never strand you.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getGroupSettings } from '../lib/group-settings.js'
import { ensureEmpiresInitialized, getOwnedEmpire } from '../lib/empire-repo.js'
import { findBuilding } from '../lib/empire-engine.js'

const RULE = '━━━━━━━━━━━━━━━━━━━━'

/**
 * The walkable places. Titles are article-free ("coffee house") so a template
 * can add "the" where it reads well ("you walk to the coffee house") and leave
 * it off where it does not ("has no coffee house yet"). `building` null means the
 * spot is part of every empire (the square and the market storefront); otherwise
 * the spot appears only once that building is raised. `access` records who the
 * interaction actually serves, so the hint never over-promises:
 *   all     — anyone standing here (market: the owner stocks, everyone else buys)
 *   members — the owner and sworn citizens (the bank)
 *   owner   — the ruler only (the forge, the barracks)
 */
const SPOTS = [
  {
    id: 'square', emoji: '🏛️', title: 'town square', building: null, access: 'all',
    words: ['square', 'town', 'centre', 'center', 'home', 'out', 'leave', 'back'],
    scene: 'Fountains, noticeboards, and the buzz of the day. Every road starts here.',
    hint: (rel, p) => `Look around with *${p}goto* to see everywhere you can walk.`,
  },
  {
    id: 'market', emoji: '🏪', title: 'market', building: null, access: 'all',
    words: ['market', 'stalls', 'bazaar', 'shop'],
    scene: 'Awnings, crates, and traders calling their wares across the lane.',
    hint: (rel, p) => rel === 'owner'
      ? `Stock your own stalls with *${p}empire market*.`
      : `Browse and buy with *${p}empire buy*.`,
  },
  {
    id: 'coffee', emoji: '☕', title: 'coffee house', building: 'coffee_house', access: 'all',
    words: ['coffee', 'cafe', 'café', 'coffeehouse', 'coffee_house', 'brew'],
    scene: 'Warm light, the hiss of steam, and a board of drinks above the counter.',
    hint: (rel, p) => `Read the board and order a cup with *${p}order* (or *${p}coffee*).`,
  },
  {
    id: 'bank', emoji: '🏦', title: 'bank', building: 'bank', access: 'members',
    words: ['bank', 'vault', 'counting', 'coffers'],
    scene: 'A hushed counting house, coin stacked in neat rows behind iron bars.',
    hint: (rel, p, name) => rel === 'visitor'
      ? `The vault only serves ${name}'s own people.`
      : `Store or draw your own coin with *${p}empire bank*.`,
  },
  {
    id: 'forge', emoji: '🔨', title: 'blacksmith', building: 'blacksmith', access: 'owner',
    words: ['forge', 'smith', 'blacksmith', 'anvil'],
    scene: 'Heat, sparks, and the steady ring of a hammer falling on the anvil.',
    hint: (rel, p, name) => rel === 'owner'
      ? `Have the smith forge gear from the stash with *${p}empire forge*.`
      : `Only ${name}'s ruler puts the forge to work.`,
  },
  {
    id: 'barracks', emoji: '🛡️', title: 'barracks', building: 'barracks', access: 'owner',
    words: ['barracks', 'garrison', 'muster', 'drill'],
    scene: 'A drill yard, racks of arms, and soldiers snapping to muster.',
    hint: (rel, p, name) => rel === 'owner'
      ? `Muster and drill your troops with *${p}army*.`
      : `Only ${name}'s ruler commands the garrison.`,
  },
]

const spotById = Object.fromEntries(SPOTS.map(s => [s.id, s]))

/** Is this spot part of the given empire right now? */
function spotPresent(spot, record) {
  return spot.building == null ? true : !!findBuilding(record, spot.building)
}

/** The spots you can currently walk to in this empire, square first. */
export function presentSpots(record) {
  return SPOTS.filter(s => spotPresent(s, record))
}

/**
 * Where a player is standing, and in what relation to that empire. Physical
 * order: a visited empire wins (you travelled there), then your own, then one
 * you are sworn to. Shared with plugins/coffee.js so ordering resolves presence
 * the exact same way. Returns { record, rel } with rel null when nowhere.
 */
export function standingIn(ctx) {
  const me = ctx.db.data.users?.[ctx.from] ?? ctx.player
  const empires = ctx.db.data.empires ?? {}
  const away = me?.inDungeon || me?.inBattle
  const visiting = me?.visitingEmpire
  if (visiting && !away && empires[visiting] && empires[visiting].ownerId !== ctx.from) {
    return { record: empires[visiting], rel: 'visitor' }
  }
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (owned) return { record: owned, rel: 'owner' }
  if (me?.empireRole === 'citizen' && me?.empireId && empires[me.empireId]) {
    return { record: empires[me.empireId], rel: 'citizen' }
  }
  return { record: null, rel: null }
}

/** The spot a player is at in this empire, healing a stale one back to the square. */
export function currentSpot(record, me) {
  const saved = spotById[me?.empireSpot]
  if (saved && spotPresent(saved, record)) return saved
  return spotById.square
}

/** Match a free-text place query to a spot. { spot, present } or { spot:null }. */
function resolveSpot(query, record) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return { spot: null }
  const hit = SPOTS.find(s => s.id === q || s.words.includes(q))
    ?? SPOTS.find(s => s.title.toLowerCase().includes(q) || s.words.some(w => w.includes(q)))
  if (!hit) return { spot: null }
  return { spot: hit, present: spotPresent(hit, record) }
}

async function gate(ctx) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) {
      await ctx.reply(
        `🚫 The Empire system is disabled in this group.\n` +
        `_A group admin can enable it with *${p}empire on*._`
      )
      return false
    }
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  return true
}

function noWhere(p) {
  return (
    `🧭 You are not standing in any empire.\n` +
    `_Found one with *${p}empire found <name>*, join one with *${p}empire join <name>*, ` +
    `or travel to one with *${p}empire visit <name>*._`
  )
}

/** The no-argument look around: where you are, and where you can walk. */
function lookAround(record, rel, here, p) {
  const lines = [
    `🧭 *${record.name}*: you're at the ${here.title}.`, RULE,
    `_${here.scene}_`,
    '',
    `> ${here.hint(rel, p, record.name)}`,
    '',
    `*Places you can walk to:*`,
  ]
  for (const s of presentSpots(record)) {
    lines.push(s.id === here.id
      ? `${s.emoji} *the ${s.title}*  ·  you are here`
      : `${s.emoji} the ${s.title}  ·  *${p}goto ${s.id}*`)
  }
  lines.push('')
  lines.push(`_Walk somewhere with *${p}goto <place>*._`)
  return lines.join('\n')
}

export default {
  name:           'goto',
  aliases:        [],
  category:       'empire',
  requiresPlayer: true,
  description:    'Walk between the places inside your empire (square, market, coffee, bank, forge)',

  async run(ctx) {
    const p = config.prefix
    if (!(await gate(ctx))) return

    const { record, rel } = standingIn(ctx)
    if (!record) return ctx.reply(noWhere(p))

    const me = ctx.db.data.users?.[ctx.from] ?? ctx.player
    const query = ctx.args.join(' ').trim()

    // Bare .goto — look around from wherever you are.
    if (!query) {
      const here = currentSpot(record, me)
      return ctx.reply(lookAround(record, rel, here, p))
    }

    // .goto <place> — walk there.
    const { spot, present } = resolveSpot(query, record)
    if (!spot) {
      const names = presentSpots(record).map(s => s.id).join(', ')
      return ctx.reply(
        `🧭 Nowhere in *${record.name}* goes by *"${query}"*.\n` +
        `_You can walk to: ${names}._`
      )
    }
    if (!present) {
      return ctx.reply(
        rel === 'owner'
          ? `🧭 *${record.name}* has no ${spot.title} yet.\n` +
            `_Raise one with *${p}empire build ${spot.building}*._`
          : `🧭 *${record.name}* has no ${spot.title}.`
      )
    }

    await updatePlayer(ctx.db, ctx.from, player => {
      player.empireSpot = spot.id
      return player
    })

    return ctx.reply(
      `${spot.emoji} *You walk to the ${spot.title} in ${record.name}.*\n` +
      `_${spot.scene}_\n\n` +
      `> ${spot.hint(rel, p, record.name)}\n` +
      `_Look around with *${p}goto*, or head back with *${p}goto square*._`
    )
  },
}
