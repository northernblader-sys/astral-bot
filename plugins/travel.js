/**
 * travel.js — World map + location movement.
 *
 * Commands:
 *   .travel               — show every location (town + dungeons), locked or
 *                            unlocked, with your progress on each
 *   .travel town           — head back to Astral Town from wherever you are
 *   .travel <dungeonId>     — travel straight to an unlocked dungeon
 *                            (resumes at your checkpoint, same as .enter)
 *
 * This exists because .enter only ever pointed *into* a dungeon — there was
 * no single command that showed the whole map or let a player move on to
 * the next unlocked dungeon after conquering one. .travel is the front door;
 * it delegates to dungeon.js's handleEnter() for actual dungeon entry so the
 * unlock/stamina/checkpoint rules stay in exactly one place.
 *
 * Player-built empires large enough to matter also appear on the map, but they
 * are NOT locations: travel to one with .empire visit, which sets
 * player.visitingEmpire and leaves player.location alone. A visitor is still
 * literally in town, so every reader of player.location here and elsewhere
 * stays correct. .travel town is what ends a visit.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { locationsMap } from '../lib/game-data.js'
import { getGroupSettings } from '../lib/group-settings.js'
import { MARKET_CONFIG, tierOf } from '../lib/empire-engine.js'
import { isDungeonUnlocked, handleEnter } from './dungeon.js'
import { isNewbieLocation, isNewbieGraduated, newbieFloorsLine, NEWBIE_MAX_LEVEL } from '../lib/newbie-dungeon.js'
import { releaseDungeonSlot } from '../lib/dungeon-slots.js'
import { isEventActive, endPhase, getEndEvent, THE_END_LOCATION_ID } from '../lib/end-event.js'

const TOWN_ID = 'astral_town'

// ── Map listing ─────────────────────────────────────────────────────────

/**
 * The empires worth putting on a map: big enough to have a name that travels,
 * and hidden entirely where the group has the pillar switched off.
 */
async function visitableEmpires(ctx) {
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender).catch(() => null)
    if (!settings?.empireEnabled) return []
  }
  const minRank = MARKET_CONFIG?.mapMinRank ?? 3
  return Object.values(ctx.db?.data?.empires ?? {})
    .filter(rec => rec && !rec.dormant && tierOf(rec).rank >= minRank)
    .sort((a, b) => (b.fame ?? 0) - (a.fame ?? 0))
    .slice(0, 10)
}

function renderMap(player, db, empires = []) {
  const lines = [`🗺️ *WORLD MAP*\n`]

  for (const loc of Object.values(locationsMap)) {
    // The End exists in data/locations.json permanently. It shows on the map
    // while its event is live, and stays listed once it has been beaten, as an
    // open on-demand rematch (see dungeon.js handleEnter).
    if (loc.id === THE_END_LOCATION_ID && !(db && (isEventActive(db) || getEndEvent(db).defeated))) continue

    const here = player.location === loc.id ? ' 📍_(you are here)_' : ''

    if (loc.type === 'town') {
      lines.push(`✅ *${loc.id}* — ${loc.name}${here}`)
      continue
    }

    // The rift ignores unlock/progress rules — it's gated by the event clock,
    // and walking in early is fatal, so it gets its own line.
    if (loc.id === THE_END_LOCATION_ID) {
      lines.push(
        getEndEvent(db).defeated
          ? `🌑 *${loc.id}* — ${loc.name}  _(OPEN — rematch, no spoils)_${here}`
          : endPhase(db) === 'reckoning'
            ? `🌑 *${loc.id}* — ${loc.name}  _(OPEN — the End can be fought)_${here}`
            : `☠️ *${loc.id}* — ${loc.name}  _(lethal — the aura kills on contact)_${here}`,
      )
      continue
    }

    // The Newcomer's Hollow reads differently from every other dungeon: no
    // prerequisite, no travel cost, a LEVEL CEILING rather than a floor, and its
    // own 50-floors-a-day allowance. Showing it as one more locked tower would
    // hide the only thing a new player needs to know about it.
    if (isNewbieLocation(loc.id)) {
      lines.push(
        isNewbieGraduated(player)
          ? `🎓 *${loc.id}* — ${loc.name}  _(lv 1-${NEWBIE_MAX_LEVEL} · graduated)_${here}`
          : `🕯️ *${loc.id}* — ${loc.name}  _(lv 1-${NEWBIE_MAX_LEVEL} · ${newbieFloorsLine(player, '.')})_${here}`,
      )
      continue
    }

    const unlocked = isDungeonUnlocked(player, loc.id)
    const progress = player.dungeonProgress?.[loc.id]
    const status = progress?.conquered
      ? '🏆 Conquered'
      : progress?.highestFloor
        ? `📍 Floor ${progress.highestFloor}`
        : unlocked ? '🆕 Not started' : null

    if (!unlocked) {
      const prereqName = locationsMap[loc.prerequisite]?.name ?? loc.prerequisite
      lines.push(`🔒 *${loc.id}* — ${loc.name}  _(requires: ${prereqName})_`)
    } else {
      const costTag = loc.travelCost ? `  💰 ${loc.travelCost} ☀️` : ''
      lines.push(`🗝️ *${loc.id}* — ${loc.name}  _(${status})_${costTag}${here}`)
    }
  }

  if (empires.length) {
    lines.push(`\n🏰 *PLAYER EMPIRES*`)
    for (const rec of empires) {
      const visiting = player.visitingEmpire === rec.id ? '  📍_(visiting)_' : ''
      const shop = (rec.market?.stock?.length ?? 0) > 0 ? '  🏪 _market open_' : ''
      lines.push(`🏰 *${rec.name}*  ·  ${tierOf(rec).name}${shop}${visiting}`)
    }
    lines.push(`_Head to one with *${config.prefix}empire visit <name>*._`)
  }

  lines.push(`\nType *${config.prefix}travel <location_id>* to head there.`)
  return lines.join('\n')
}

// ── Travel to town ──────────────────────────────────────────────────────

async function handleTravelToTown(ctx) {
  const { reply } = ctx
  const p = config.prefix

  await updatePlayer(ctx.db, ctx.from, player => {
    if (player.inBattle) {
      ctx.reply(`⚔️ Finish your current battle first!`).catch(() => {})
      return player
    }

    // A visitor to another player's empire never left town, so ending a visit
    // has to be handled before the already-in-town shortcut below.
    if (player.visitingEmpire) {
      const name = ctx.db.data.empires?.[player.visitingEmpire]?.name ?? 'the empire'
      player.visitingEmpire = null
      player.visitingSince = null
      player.inDungeon = false
      player.battleState = null
      player.location = TOWN_ID
      ctx.reply(
        `🚪 *${player.name}* leaves *${name}* and returns to *${locationsMap[TOWN_ID].name}*.\n` +
        `_Its market is out of reach until you visit again._`,
      ).catch(() => {})
      return player
    }

    if (player.location === TOWN_ID) {
      ctx.reply(`📍 You're already in *${locationsMap[TOWN_ID].name}*.`).catch(() => {})
      return player
    }

    const savedFloor = player.dungeonFloor ?? 0
    const wasInDungeon = player.inDungeon
    const prevLoc = player.location

    player.inDungeon    = false
    player.battleState  = null
    player.location     = TOWN_ID
    releaseDungeonSlot(ctx.isGroup ? ctx.sender : null, player, ctx.from)

    ctx.reply(
      `🚪 *${player.name}* travels back to *${locationsMap[TOWN_ID].name}*.\n` +
      (wasInDungeon
        ? `📍 Progress in *${locationsMap[prevLoc]?.name ?? prevLoc}* saved at Floor ${savedFloor}.\n`
        : '') +
      `_Type *${p}travel* to see the map, or *${p}inn* to rest up._`,
    ).catch(() => {})
    return player
  })
}

// ── Plugin export ────────────────────────────────────────────────────────

export default {
  name:           'travel',
  aliases:        ['go', 'map'],
  category:       'dungeon',
  requiresPlayer: true,
  description:    `${config.prefix}travel [location_id] — view the world map or move to a location (town or an unlocked dungeon).`,

  async run(ctx) {
    const { args, player, reply } = ctx

    if (!args.length) {
      return reply(renderMap(player, ctx.db, await visitableEmpires(ctx)))
    }

    const locId = args[0].toLowerCase().replace(/\s+/g, '_')

    if (locId === 'town' || locId === TOWN_ID) {
      return handleTravelToTown(ctx)
    }

    const loc = locationsMap[locId]
    if (!loc || loc.type !== 'dungeon') {
      return reply(`❌ Unknown location *${locId}*.\n\n${renderMap(player, ctx.db, await visitableEmpires(ctx))}`)
    }

    // Delegate straight to dungeon.js's entry logic — same unlock checks,
    // stamina cost, and checkpoint resume as !enter.
    return handleEnter(ctx)
  },
}
