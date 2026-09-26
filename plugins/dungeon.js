/**
 * dungeon.js — Dungeon entry, floor navigation, and session management.
 *
 * Commands:
 *   .enter <dungeonId>     — enter or resume a dungeon
 *   .dungeon               — advance to next floor / show status
 *   .dungeon leave|exit    — save progress and exit
 *
 * Daily cap: entering a dungeon spends one of a limited number of daily runs
 * (lib/dungeon-limits.js) — premium accounts get more. Floors within a run are
 * free; leaving and re-entering costs another run.
 *   .dungeon on|off        — group admins: enable/disable dungeons here
 *
 * NOTE: 'fight' was removed as an alias for this plugin — it read like a
 * combat command (attack/defend/flee/skill) but actually advanced dungeon
 * floors, which confused players. Use .travel to see/move between
 * locations, and .enter or .dungeon to work a dungeon you're unlocked for.
 */
import { config } from '../config.js'
import { consumeDungeonRun, runsRemaining, runLimitMessage, runsLine } from '../lib/dungeon-limits.js'
import { buildSwarmFloor, renderSwarmFrame } from '../lib/swarm-combat.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
  locationsMap, regularByLoc, bossByLocFloor, getAnimeBossForSlot, getAnimeBossById, skills as allSkills,
} from '../lib/game-data.js'
import {
  pickMonsterForFloor, refreshStamina, hpBar, getNewlyUnlockedSkills,
  enemyPowerRatio, scaleEnemyToPlayer, scaleBossToPlayer,
  applyVeteranScaling, veteranBanner,
} from '../lib/combat-engine.js'
import {
  NEWBIE_LOCATION_ID, NEWBIE_MAX_LEVEL, isNewbieLocation, isNewbieGraduated,
  newbieFloorsRemaining, consumeNewbieFloor, newbieFloorLimitMessage, newbieFloorsLine,
  newbieGraduatedMessage,
} from '../lib/newbie-dungeon.js'
import { initBossFight } from '../lib/boss-engine.js'
import { regulateBossXp } from '../lib/xp-regulator.js'
import { applyPassiveAbilities } from '../lib/ability-engine.js'
import { armHypnosis, armLovestruck, armFusion, armWondersOfEnvy } from '../lib/character-abilities.js'
import { sendBattleTurnReply } from '../lib/battle-frame-render.mjs'
import { sendImage } from '../lib/image.js'
import { getGroupSettings, saveGroupSettings, saveFailedMessage, isGroupOrBotOwner } from '../lib/group-settings.js'
import { NOT_GROUP, NOT_ALLOWED } from '../lib/group-helpers.js'
import { getActiveSeason, ensurePlayerSeasonState } from '../lib/season-engine.js'
import { resolvePlayerHpZero } from '../lib/combat-handlers.js'
import { canEnterDungeon, recordDungeonEntry, touchDungeonActivity, releaseDungeonSlot } from '../lib/dungeon-slots.js'
import { formatTimeLeft } from '../lib/time-format.js'
import { playerLevelCap } from '../lib/reborn-engine.js'
import { isTitled, ensurePrestige, getTierForXp } from '../lib/title-engine.js'
import {
  endPhase, endOpensAt, isAsleepByEnd, isEventActive, getEndEvent,
  THE_END_LOCATION_ID, THE_END_BOSS_ID,
} from '../lib/end-event.js'
import { entryBrief, encounterLine, tollVoice } from '../lib/dungeon-lore.js'

// The five main dungeons that run the multi-monster swarm engine on floors
// 1 to 99. Floor 100 stays a 1v1 fight against that dungeon's original master.
// Exported so the API layer (lib/api-dungeon.js) can tell the app which
// dungeons use the directional swarm verbs vs the 1v1 verbs. No logic change.
export const SWARM_DUNGEONS = new Set([
  'entry_tower', 'gambits_dungeon', 'centurions_dungeon', 'astral_tower', 'eternal_dungeon',
])

// Player-power scaling (see scaleBossToPlayer / scaleEnemyToPlayer in
// combat-engine.js). Bosses are sized to a HIT COUNT against the actual player:
// a whale who bursts the floor-100 master in three hits instead meets a wall
// tuned to BOSS_TARGET_HITS of their own strong hits, with a capped armor/attack
// bump so it reads as the wall the strongest accounts asked for. An on-curve
// climber (or a boss already hard for this player) is left untouched.
// MONSTER_SCALE / MONSTER_SCALE_1V1 keep the squishier exponent profile for the
// many-small-monsters swarm and the handful of 1v1 non-boss floors: enough HP to
// survive a couple of hits and close in from both flanks, gentle capped ATK.
const BOSS_TUNING       = { baseHits: 12, hitsRatioExp: 0.16, maxHits: 20, defExp: 0.14, atkExp: 0.2, atkCapMult: 1.75 }
const MONSTER_SCALE_1V1 = { hpExp: 0.85, atkExp: 0.4, defExp: 0.2 }

// ── helpers ───────────────────────────────────────────────────────────

export function isDungeonUnlocked(player, locId) {
  const loc = locationsMap[locId]
  if (!loc || loc.type !== 'dungeon') return false

  // After an owner-run .dungeon-reset, this player must climb the prerequisite
  // chain again from scratch: the level-eligibility bypass below is suspended
  // until each tower is re-conquered. A dungeon with no prerequisite
  // (entry_tower, season_01_ruins) stays open. Per-player flag, so only reset
  // players are gated this way; everyone else keeps the bypass.
  if (player.dungeonsRelocked) {
    const prereq = loc.prerequisite
    if (!prereq) return true
    return player.dungeonProgress?.[prereq]?.conquered === true
  }

  // Level-eligible players are never blocked by prerequisite/conquered
  // state — this covers migrated accounts with empty dungeonProgress and
  // high-level players who never formally "conquered" earlier towers.
  if ((player.level ?? 1) >= (loc.entryLevel ?? 1)) return true

  const prereq = loc.prerequisite
  if (!prereq) return true
  return player.dungeonProgress?.[prereq]?.conquered === true
}

function isBossFloor(locId, floor) {
  return (locationsMap[locId]?.bossFloors ?? []).includes(floor)
}

/**
 * Build the boss encounter for a boss floor.
 * Anime bosses (bosses/*.js, mapped via getAnimeBossForSlot) take priority
 * over the generic monsters.json bosses — every one of the 5 dungeons'
 * boss floors is mapped to an anime boss, so the monsters.json fallback
 * below should only ever fire if a slot mapping is missing.
 *
 * Returns { enemy, bossState, entranceLine } — bossState/entranceLine are
 * only present for anime bosses (used to drive special mechanics and the
 * spawn narration).
 */
function spawnBoss(locId, floor, player = null) {
  // Player-power scaling: a whale who has outgrown the floor curve meets a boss
  // sized to outlast a 3-hit blitz (BOSS_TUNING.baseHits of their own strong
  // hits, creeping up with the power gap) with a capped armor/attack bump; an
  // on-curve climber, or a boss already hard for this player, fights it exactly
  // as authored (never nerfed). scaleBossToPlayer reads the real player, so it
  // tells the weak masters (Syclila 18k HP) apart from the tanky ones (Esteria
  // 55k) instead of blindly multiplying both.
  const ratio     = player ? enemyPowerRatio(player, locId, floor) : 1
  const scaleBoss = (e) => {
    if (e && player && ratio > 1) {
      scaleBossToPlayer(e, player, ratio, BOSS_TUNING)
    }
    // Veteran tier (level 100+): a boss is taken in FULL, unlike a swarm pack —
    // one enemy on the field, so there is no pack multiplier compounding it.
    if (e && player) applyVeteranScaling(e, player)
    return e
  }
  const animeDef = getAnimeBossForSlot(locId, floor)
  if (animeDef) {
    const init = initBossFight({}, animeDef.id, floor)
    if (init.ok) {
      const enemy = {
        ...init.enemy,
        locationId:    locId,
        floor,
        tier:          'boss',
        isBoss:        true,
        image:         animeDef.image ?? null,
        animeBossId:   animeDef.id,
        // Normalize reward/drop shape to what combat-handlers.js expects
        // from a regular monster: flat xp/solars, and {itemId,chance} drops.
        // XP/solars come from the centralized xp-regulator — a boss's raw
        // exp/gold fields (from bosses/*.js) are ignored for reward purposes,
        // same as regular monsters. Grade already scales the boss's combat
        // stats (boss-engine.js GRADE_MULT); this keeps XP a flat milestone.
        ...regulateBossXp(locId, floor),
        drops:         (animeDef.drops ?? []).map(itemId => ({ itemId, chance: 0.15 })),
        conquestTitle: animeDef.conquestTitle ?? `${animeDef.name}'s Equal`,
      }
      scaleBoss(enemy)
      return { enemy, bossState: init.bossState, entranceLine: init.entranceLine }
    }
  }

  // Fallback: generic boss from monsters.json (only reached for an
  // unmapped slot — none currently exist across the 5 dungeons).
  const boss = bossByLocFloor[locId]?.[floor]
  if (!boss) return { enemy: null, bossState: null, entranceLine: null }
  const enemy = { ...boss, hp: boss.stats.hp, maxHp: boss.stats.hp, def: boss.stats.def, atk: boss.stats.atk, isBoss: true }
  scaleBoss(enemy)
  return { enemy, bossState: null, entranceLine: null }
}

function spawnEnemy(locId, floor, player = null) {
  if (isBossFloor(locId, floor)) {
    return spawnBoss(locId, floor, player)
  }
  const enemy = pickMonsterForFloor(locId, floor, regularByLoc)
  // Same player-power scaling as the swarm path (lib/swarm-combat.js), for the
  // 1v1 floors that still spawn a single monster. Squishier profile than a boss.
  if (enemy && player) {
    const ratio = enemyPowerRatio(player, locId, floor)
    if (ratio > 1) scaleEnemyToPlayer(enemy, ratio, MONSTER_SCALE_1V1)
    // Veteran tier (level 100+) — full weight on a solo monster, same as a boss.
    applyVeteranScaling(enemy, player)
  }
  return { enemy, bossState: null, entranceLine: null }
}

/** Floor progress bar: e.g. "████░░░░░░  40/100" */
function floorBar(floor, total, length = 10) {
  const pct    = total > 0 ? floor / total : 0
  const filled = Math.min(Math.round(pct * length), length)
  const bar    = '█'.repeat(filled) + '░'.repeat(length - filled)
  const pctStr = Math.floor(pct * 100)
  return `${bar}  ${floor}/${total}  (${pctStr}%)`
}

/** Find the next boss floor at or after `floor`. Returns null if none. */
function nextBossFloor(locId, floor) {
  const bosses = locationsMap[locId]?.bossFloors ?? []
  const next   = bosses.filter(f => f >= floor).sort((a, b) => a - b)[0]
  return next ?? null
}

/**
 * `db` is optional and only used to decide whether The End is listed at all —
 * it exists in data/locations.json permanently but must stay invisible until
 * the world event is actually running (lib/end-event.js).
 */
export function dungeonList(player, db) {
  return Object.values(locationsMap)
    .filter(l => l.type === 'dungeon')
    .filter(l => l.id !== THE_END_LOCATION_ID || (db && isEventActive(db)))
    .map(l => {
      const unlocked   = !player || isDungeonUnlocked(player, l.id)
      const conquered  = player?.dungeonProgress?.[l.id]?.conquered === true
      const highest    = player?.dungeonProgress?.[l.id]?.highestFloor ?? 0
      const lock       = conquered ? '✅' : unlocked ? '🔓' : '🔒'
      const progress   = unlocked && highest > 0 ? ` · Floor ${highest}/${l.floors}` : ''
      const prereqName = !unlocked && l.prerequisite
        ? ` _(requires ${locationsMap[l.prerequisite]?.name ?? l.prerequisite})_`
        : ''
      // The newbie lane is shown as itself, not as one more tower: what a
      // newcomer needs to know is the level ceiling and how many floors they
      // have left today, neither of which any other dungeon has.
      if (isNewbieLocation(l.id)) {
        const graduated = isNewbieGraduated(player)
        return (
          `  ${graduated ? '🎓' : '🕯️'} *${l.id}*  ${l.name}  (lv 1 to *${NEWBIE_MAX_LEVEL}*)` +
          (graduated
            ? ` _(graduated)_`
            : player ? ` · ${newbieFloorsLine(player, '.')}` : '')
        )
      }
      return `  ${lock} *${l.id}*  ${l.name}  (lv ${l.levelRange[0]} to ${l.levelRange[1]})${progress}${prereqName}`
    })
    .join('\n')
}

// ── Enter ─────────────────────────────────────────────────────────────

export async function handleEnter(ctx) {
  const { args, reply } = ctx
  const p = config.prefix

  if (!args.length) {
    return reply(
      `🗺️ *Available Dungeons*\n\n` +
      `${dungeonList(ctx.player, ctx.db)}\n\n` +
      `🔒 _locked_  🔓 _unlocked_  ✅ _conquered_\n\n` +
      `❓ *Usage:* *${p}enter <dungeon_id>*\n_Example:_ *${p}enter entry_tower*`,
    )
  }

  const locId = args[0].toLowerCase().replace(/\s+/g, '_')
  const loc   = locationsMap[locId]

  if (!loc || loc.type !== 'dungeon') {
    return reply(`❌ *Unknown dungeon* "_${locId}_".\n\n${dungeonList(ctx.player, ctx.db)}`)
  }

  await updatePlayer(ctx.db, ctx.from, async player => {
    if (player.inBattle) {
      ctx.reply(`⚔️ *Finish your current battle first!*`).catch(() => {})
      return player
    }
    if (player.inDungeon) {
      ctx.reply(`🗺️ *You're already in* *${locationsMap[player.location]?.name ?? player.location}*.\n_Type_ *${p}dungeon leave* _to exit first._`).catch(() => {})
      return player
    }

    // ── Group dungeon slot occupancy check (max 2, bypassed by premium) ──
    // Skipped entirely for the Newcomer's Hollow: that cap exists so two
    // accounts can't hold a SHARED dungeon room all day, and the Hollow is not
    // shared — every newcomer gets their own. Gating the tutorial behind a
    // group's climbing slots would lock out exactly the players it is for. Its
    // own 50-floors-a-day allowance is what bounds it (lib/newbie-dungeon.js).
    if (ctx.isGroup && !isNewbieLocation(locId)) {
      const slotCheck = canEnterDungeon(ctx.sender, player, ctx.from, ctx.db)
      if (!slotCheck.allowed) {
        ctx.reply(slotCheck.reason).catch(() => {})
        return player
      }
    }

    // ── The End (world-event finale) ───────────────────────────────────
    // Ahead of every generic gate on purpose: this place doesn't obey unlock,
    // level, or travel-cost rules. It obeys the event clock (lib/end-event.js).
    if (locId === THE_END_LOCATION_ID) {
      const phase = endPhase(ctx.db)

      // The rift is genuinely empty only if the event has NEVER run. Once the
      // End has been beaten server-wide (defeated), its location stays open as
      // an on-demand rematch for anyone who still wants the fight: it grants
      // nothing (see handleVictory's practice branch), writes no event state,
      // so the aura stays lifted and nothing is broadcast.
      const evState = getEndEvent(ctx.db)
      if (phase === 'off' && !evState.defeated) {
        ctx.reply(
          `🌌 *There is nothing there.*\n\n` +
          `_You reach for the rift and close your hand on empty air. Whatever ` +
          `sleeps beyond it is not stirring today._`,
        ).catch(() => {})
        return player
      }

      if (phase === 'longsleep') {
        // Literal to the lore: the aura kills on contact. Routed through
        // resolvePlayerHpZero so a Totem of Undying / Premium auto-revive still
        // gets its save — this is a death like any other, not a scripted one.
        player.hp = 0
        const opensIn = formatTimeLeft(Math.max(0, (endOpensAt(ctx.db) ?? Date.now()) - Date.now()))
        const auraMsg =
          `☠️ *YOU STEPPED INTO THE RIFT.*\n\n` +
          `_The air in here isn't air. It is the End, breathing._\n` +
          `_There is no enemy to face and no fight to lose. Your body simply ` +
          `stops agreeing to exist._\n\n`

        const res = await resolvePlayerHpZero(player, ctx, auraMsg, { boss: false })
        if (res.fallThrough) {
          // A totem fired — alive, and still not going in.
          await ctx.reply(
            res.msg +
            `\n\n🚪 _You are thrown back out of the rift, gasping._\n` +
            `⏳ _Not yet. Not for another ${opensIn}._`,
          ).catch(() => {})
        }
        return player
      }

      // phase === 'reckoning' — the rift is open and the End can be fought.
      if (isAsleepByEnd(ctx.db, player)) {
        ctx.reply(
          `😴 *You can barely stand.*\n\n` +
          `_The aura still has you. Walking in like this isn't courage, it's a queue._\n` +
          `🧿 _Get a Blue Band first:_ *${p}shop buy blue band*`,
        ).catch(() => {})
        return player
      }

      const init = initBossFight(player, THE_END_BOSS_ID)
      if (!init.ok) {
        ctx.reply(`❌ The rift won't open _(${init.error})_. Report this bug.`).catch(() => {})
        return player
      }

      const def   = getAnimeBossById(THE_END_BOSS_ID)
      const enemy = {
        ...init.enemy,
        locationId:  THE_END_LOCATION_ID,
        floor:       1,
        tier:        'boss',
        isBoss:      true,
        animeBossId: THE_END_BOSS_ID,
        // Hand-set instead of regulateBossXp'd: this is a one-time world-event
        // finale, not a floor on the dungeon curve, so it pays the boss's own
        // declared numbers. Its drop is guaranteed, not a 15% roll.
        xp:            def?.exp  ?? 50000,
        solars:        def?.gold ?? 10000,
        drops:         (def?.drops ?? []).map(itemId => ({ itemId, chance: 1 })),
        conquestTitle: def?.conquestTitle ?? 'World Ender',
      }

      // location + dungeonFloor, but deliberately NOT inDungeon: the End is one
      // fight, not a floor grind, so there is nothing for `.dungeon` to advance
      // into. dungeonFloor = 1 is what makes handleVictory's conquest check fire
      // (the_end declares floors: 1 in data/locations.json).
      player.location     = THE_END_LOCATION_ID
      player.dungeonFloor = 1
      player.inBattle     = true
      player.battleState  = {
        type:             'dungeon',
        locationId:       THE_END_LOCATION_ID,
        floor:            1,
        enemy,
        bossState:        init.bossState,
        playerDefending:  false,
        turn:             1,
        abilityCooldowns: {},
        // Boss turn clock — stamps the 5-minute idle deadline from turn 1.
        // handler.js resolves it lazily and refreshes it after each real move.
        lastMoveAt:       Date.now(),
      }

      applyPassiveAbilities(player)
      armHypnosis(player)
      // Alexa — Lovestruck. Armed on the same terms as Hypnosis (after
      // battleState and after the passives, so the comparison reads the stats
      // that are actually up at the opening bell). The End's boss is weighed
      // against the player once, right here, and the tier it lands on is what
      // applyIncomingDamage() reads for the rest of the fight.
      armLovestruck(player, enemy)
      // Tella — Wonders of You. Armed on the same terms as the two above, so
      // her clock starts fresh at the opening bell. No-op unless she is equipped.
      armWondersOfEnvy(player)
      // Gogeta — Fusion of Equals. Same placement rule: after battleState and
      // after the passives, because the buff is a share of the stats that are
      // actually up at the opening bell. The clock starts counting from here.
      const fusionLine = armFusion(player)

      ctx.reply(
        `🌑 ━━━━━ *THE END* ━━━━━ 🌑\n\n` +
        (init.entranceLine ? `_${init.entranceLine}_\n\n` : '') +
        `💀 *${enemy.name}*\n` +
        `❤️ HP: *${enemy.hp}*  ⚔️ ATK: *${enemy.atk}*  🛡️ DEF: *${enemy.def}*\n\n` +
        (fusionLine ? `${fusionLine}\n\n` : '') +
        `_There is no floor to climb and nowhere left to run. The world is ` +
        `holding its breath behind you._\n\n` +
        `*${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`,
      ).catch(() => {})
      return player
    }

    // ── Newcomer's Hollow: graduation gate + its own daily floors ───────────
    // Ahead of the generic gates because neither applies to this lane: it has no
    // prerequisite and it is open from level 1, but it CLOSES at level 31 (a
    // starter lane that stayed open would be the best XP in the game for anyone
    // under the cap) and it is rationed in floors, not runs.
    if (isNewbieLocation(locId)) {
      if (isNewbieGraduated(player)) {
        ctx.reply(newbieGraduatedMessage(player, p)).catch(() => {})
        return player
      }
      if (newbieFloorsRemaining(player) < 1) {
        ctx.reply(newbieFloorLimitMessage(player, p)).catch(() => {})
        return player
      }
    }

    if (!isDungeonUnlocked(player, locId)) {
      const prereq     = loc.prerequisite
      const prereqName = locationsMap[prereq]?.name ?? prereq
      ctx.reply(`🔒 *${loc.name}* is locked.\n_Conquer_ *${prereqName}* _first._`).catch(() => {})
      return player
    }

    if (player.level < loc.entryLevel) {
      ctx.reply(`❌ *${loc.name}* requires Level *${loc.entryLevel}*. _You are Level ${player.level}._`).catch(() => {})
      return player
    }

    // Travel cost — solars, scaled per dungeon (see data/locations.json)
    const travelCost = loc.travelCost ?? 0
    const solars     = player.wallet?.solars ?? 0
    if (travelCost > 0 && solars < travelCost) {
      ctx.reply(`❌ *Traveling to* *${loc.name}* _costs_ *${travelCost} ☀️*. _You only have_ *${solars} ☀️*.`).catch(() => {})
      return player
    }

    // Refresh stamina, check
    player.stamina = refreshStamina(player.stamina)
    if (player.stamina.current < 1) {
      const resetDate = new Date(player.stamina.resetAt)
      ctx.reply(`⚡ *No stamina left!* _(0/${player.stamina.max})_\n_Resets at midnight,_ ${resetDate.toLocaleTimeString()}.`).catch(() => {})
      return player
    }

    // Daily run cap — see lib/dungeon-limits.js. Stamina potions made stamina
    // effectively unlimited, which let a few players occupy the shared dungeon
    // groups all day; this caps how many runs anyone can START per day, with a
    // bigger allowance for premium. Checked after every other gate so a run is
    // only ever spent on an entry that actually happens.
    //
    // The Hollow is exempt: its allowance is 50 FLOORS a day (checked above),
    // which is a full lap of a 50-floor dungeon. Charging one of a newcomer's 7
    // Entry Tower runs for that — when Entry Tower is 100 floors they cannot
    // survive — would make the starter lane the worst deal in the game.
    const isNewbie = isNewbieLocation(locId)
    if (!isNewbie) {
      if (runsRemaining(player) < 1) {
        ctx.reply(runLimitMessage(player, p)).catch(() => {})
        return player
      }
      consumeDungeonRun(player)
    }

    const progress   = player.dungeonProgress?.[locId] ?? { highestFloor: 0, conquered: false }
    const checkpoint = progress.highestFloor ?? 0
    const season = getActiveSeason(ctx.db)
    const isSeasonDungeon = locId === season?.dungeon
    // Resume floor. highestFloor is banked on every cleared floor no matter what,
    // so it is the reliable source; the season's own currentFloor only advances
    // while the season is live and can sit stuck at 1 (which is what sent season
    // climbers back to Floor 1). Take the higher of the two so neither counter
    // lagging can lose progress, then clamp to the party-boss floor so a solo
    // re-entry never lands past the only party-gated floor.
    let startFloor = checkpoint > 0 ? checkpoint : 1
    // The Hollow always starts from Floor 1 once it has been cleared: its
    // checkpoint would otherwise sit on the gatekeeper's floor, and a newcomer
    // re-entering would open straight into the boss with nothing left to climb.
    // The daily floor allowance is what stops lap farming.
    if (isNewbie && progress.conquered) startFloor = 1
    if (isSeasonDungeon) {
      const seasonFloor = ensurePlayerSeasonState(player, season.id).seasonProgress.currentFloor ?? 1
      startFloor = Math.max(startFloor, seasonFloor)
      const gate = season.partyBossFloor ?? loc.floors ?? 100
      if (startFloor > gate) startFloor = gate
    }

    player.inDungeon         = true
    if (ctx.isGroup) {
      recordDungeonEntry(ctx.sender, player, ctx.from)
    }
    player.location          = locId
    player.dungeonFloor      = startFloor
    player.dungeonCheckpoint = checkpoint
    player.stamina.current  -= 1
    if (travelCost > 0) {
      if (!player.wallet) player.wallet = {}
      player.wallet.solars = (player.wallet.solars ?? 0) - travelCost
    }
    if (!player.dungeonProgress) player.dungeonProgress = {}
    player.dungeonProgress[locId] = progress

    const resuming    = checkpoint > 0
    const totalFloors = loc.floors ?? '?'
    const masterFloor = (loc.bossFloors ?? [])[(loc.bossFloors ?? []).length - 1] ?? loc.floors
    const travelLine  = travelCost > 0 ? `\n${tollVoice(locId, travelCost)}` : ''
    const shapeLine   = `🏰 Floors: *${totalFloors}*  ·  the master waits on *${masterFloor}*`
    const brief       = entryBrief(loc, startFloor, resuming)

    ctx.reply(
      `╔══ ⚔️ *${loc.name.toUpperCase()}* ══╗\n\n` +
      `📖 _${loc.description}_\n\n` +
      `🎯 Level Range: *${loc.levelRange[0]} to ${loc.levelRange[1]}*  ·  Your Level: *${player.level}*\n` +
      `${shapeLine}${travelLine}\n\n` +
      `📍 ${resuming ? `*Resuming from Floor ${startFloor}* ✅` : `*Starting at Floor 1*`}\n` +
      (veteranBanner(player) ? `${veteranBanner(player)}\n` : '') +
      (isNewbie
        ? `⚡ *No stamina cost, no run limit* — everyone gets their 50 floors a day\n`
        : `⚡ Stamina: *${player.stamina.current}/${player.stamina.max}*\n`) +
      `${isNewbie ? newbieFloorsLine(player, p) : runsLine(player, p)}\n\n` +
      (brief ? `${brief}\n\n` : '') +
      `_Type *${p}dungeon* to begin, *${p}dungeon leave* to exit._`,
    ).catch(() => {})
    return player
  })
}

// ── Advance / spawn next encounter ───────────────────────────────────

async function handleAdvance(ctx) {
  const { reply } = ctx
  const p = config.prefix

  await updatePlayer(ctx.db, ctx.from, async player => {
    if (!player.inDungeon) {
      await reply(`❌ You're not in a dungeon.\nUse *${p}enter <id>* to enter one.\n\n${dungeonList(player, ctx.db)}`)
      return player
    }

    // Same reasoning as handleEnter: the Hollow is not a shared room, so it does
    // not consume a group dungeon slot and is never idle-kicked out of one. Its
    // own 50-floors-a-day allowance is the limit that applies.
    const inNewbieHollow = isNewbieLocation(player.location)
    if (ctx.isGroup && !inNewbieHollow) {
      const slotCheck = canEnterDungeon(ctx.sender, player, ctx.from, ctx.db)
      if (!slotCheck.allowed) {
        await reply(slotCheck.reason)
        return player
      }
      touchDungeonActivity(ctx.sender, player, ctx.from)
    }
    if (player.inBattle && player.battleState) {
      const e = player.battleState.enemy
      await reply(
        `⚔️ You're already fighting *${e.name}*!\n` +
        `Use *${p}attack*, *${p}skill <name>*, *${p}defend*, or *${p}flee*.`,
      )
      return player
    }

    player.stamina = refreshStamina(player.stamina)
    // The Hollow costs no stamina. It is capped at 50 floors a day and closes at
    // level 31; charging stamina as well made its own cap unreachable (a fresh
    // character has 30) and left newcomers on the one lane built for them with
    // nothing to do, which is the opposite of what it is for. Everywhere else
    // stamina is unchanged.
    if (!inNewbieHollow && player.stamina.current < 1) {
      const resetDate  = new Date(player.stamina.resetAt)
      const exhaustFloor = player.dungeonFloor
      player.inDungeon = false
      player.battleState = null
      releaseDungeonSlot(ctx.isGroup ? ctx.sender : null, player, ctx.from)
      await reply(
        `⚡ *Out of stamina!* *(0/${player.stamina.max})*\nYou rest and exit the dungeon.\n` +
        `📍 Progress saved at Floor ${exhaustFloor}.\nResets at midnight, ${resetDate.toLocaleTimeString()}.`,
      )
      return player
    }

    // ── Newcomer's Hollow: the daily floor allowance, spent per floor ───────
    // Checked (and spent) here rather than at entry because the allowance IS
    // the run: a newcomer gets 50 floors a day, so the wall has to land on a
    // floor boundary, not on the door. Exiting on exhaustion mirrors the
    // out-of-stamina branch above, so neither one can strand someone in a
    // dungeon they are no longer allowed to climb.
    if (inNewbieHollow) {
      if (isNewbieGraduated(player)) {
        player.inDungeon = false
        player.battleState = null
        releaseDungeonSlot(ctx.isGroup ? ctx.sender : null, player, ctx.from)
        await reply(newbieGraduatedMessage(player, p))
        return player
      }
      if (newbieFloorsRemaining(player) < 1) {
        const exhaustFloor = player.dungeonFloor
        player.inDungeon = false
        player.battleState = null
        releaseDungeonSlot(ctx.isGroup ? ctx.sender : null, player, ctx.from)
        await reply(
          newbieFloorLimitMessage(player, p) +
          `\n📍 _Your climb rests at Floor ${exhaustFloor} — tomorrow it picks up right there._`,
        )
        return player
      }
      consumeNewbieFloor(player)
    }

    const locId = player.location
    const floor = player.dungeonFloor
    const loc   = locationsMap[locId]

    if (!loc) {
      player.inDungeon = false
      releaseDungeonSlot(ctx.isGroup ? ctx.sender : null, player, ctx.from)
      await reply(`❌ Location data missing. Exiting dungeon.`)
      return player
    }
    const season = getActiveSeason(ctx.db)
    if (locId === season?.dungeon && floor >= (season.partyBossFloor ?? loc.floors ?? 100)) {
      await reply(
        `🤝 *Floor ${floor} is the End.*\n` +
        `This is the only party-gated floor. Form a party with *${p}dparty create*, invite your allies, then use *${p}dparty enter season_01_ruins*.\n` +
        `_You cannot attempt the End alone._`,
      )
      return player
    }

    // Deduct 1 stamina per encounter — except in the Hollow (see above).
    if (!inNewbieHollow) player.stamina.current -= 1

    // ── Swarm floors ─────────────────────────────────────────────────────
    // Every main dungeon runs the multi-monster telegraph engine
    // (lib/swarm-combat.js) on floors 1 to 99 instead of a 1v1 spawn. The
    // floor-100 master fight falls through to the classic 1v1 path below.
    if (SWARM_DUNGEONS.has(locId) && !isBossFloor(locId, floor)) {
      const built = buildSwarmFloor(locId, floor, player)
      if (!built) {
        await reply(`❌ No monsters found for Floor ${floor}. Report this bug.`)
        return player
      }
      player.inBattle    = true
      player.battleState = {
        type:            'dungeon',
        mode:            'swarm',
        locationId:      locId,
        floor,
        // A live monster stays parked here for dungeon.js's already-fighting
        // guard, flee.js, and resolvePlayerHpZero's cat-form branch; the engine
        // keeps it pointed at the nearest threat each turn.
        enemy:           built.monsters.find((m) => m.alive) ?? built.monsters[0],
        monsters:        built.monsters,
        isApprentice:    built.isApprentice,
        playerLane:      1,
        playerDefending: false,
        turn:            1,
        abilityCooldowns: {},
      }

      // Same arming order and rationale as the 1v1 path below: passives first,
      // then Hypnosis / Lovestruck / Fusion, all reading battleState.enemy at
      // the opening bell. No-ops unless the relevant character is equipped.
      applyPassiveAbilities(player)
      armHypnosis(player)
      armLovestruck(player, player.battleState.enemy)
      armWondersOfEnvy(player)
      const fusionLine = armFusion(player)

      const totalFloors = loc.floors ?? 0
      const checkpoint  = player.dungeonCheckpoint ?? 0
      const cpLine      = checkpoint > 0 ? `  · Checkpoint: Floor ${checkpoint}` : ''

      const header = built.isApprentice
        ? `💀 ━━━ *APPRENTICE WAVE: FLOOR ${floor}/${totalFloors}* ━━━ 💀`
        : `⚔️ *SWARM: FLOOR ${floor}/${totalFloors}*`
      const veteranLine = veteranBanner(player)
      const hollowLine  = isNewbieLocation(locId) ? newbieFloorsLine(player, p) : ''
      const family = encounterLine(locId, built.monsters.find(m => m.alive)?.name)
      const intro = built.isApprentice
        ? `\n_An apprentice of the sword holds the stair, escorts at their flanks._\n`
        : `\n_The floor is not empty. They close from more than one side._\n` +
          (family ? `_${family}_\n` : '')

      const msg =
        `${header}\n` +
        `📊 ${floorBar(floor, totalFloors)}${cpLine}\n` +
        (isNewbieLocation(locId) ? '' : `⚡ Stamina: *${player.stamina.current}/${player.stamina.max}*`) +
        (hollowLine ? `\n${hollowLine}` : '') +
        intro +
        (veteranLine ? `\n${veteranLine}` : '') +
        (fusionLine ? `\n${fusionLine}\n` : '') +
        `\n` +
        renderSwarmFrame(player.battleState, player)

      await reply(msg)
      return player
    }

    // Spawn enemy
    const { enemy, bossState, entranceLine } = spawnEnemy(locId, floor, player)
    if (!enemy) {
      await reply(`❌ No monsters found for Floor ${floor}. Report this bug.`)
      return player
    }

    player.inBattle    = true
    player.battleState = {
      type:            'dungeon',
      locationId:      locId,
      floor,
      enemy,
      bossState,
      playerDefending: false,
      turn:            1,
      abilityCooldowns: {},
      // Boss turn clock (see isLiveBossFight): stamps the 5-minute idle deadline
      // from the opening bell. Harmless on ordinary fights, which never read it.
      lastMoveAt:      Date.now(),
    }

    applyPassiveAbilities(player)

    // Anastasia — Hypnosis. Must be armed AFTER battleState is built and
    // AFTER applyPassiveAbilities(), so the snapshot the rewind restores
    // contains the enemy as rolled, the turn counter at 1, and the passive
    // effects that were up at the opening bell. No-op unless she's equipped.
    armHypnosis(player)

    // Alexa — Lovestruck. Same placement rule as Hypnosis above: the monster or
    // boss just rolled is weighed against the player once, and the tier that
    // comes out lives on battleState for the rest of the fight. No-op unless
    // she is equipped and the player is past her level gate.
    armLovestruck(player, enemy)
    armWondersOfEnvy(player)

    // Gogeta — Fusion of Equals. Same placement rule as the two above: the buff
    // is a share of the stats that are up at the opening bell, and the fusion
    // clock starts counting from this turn. No-op unless he is equipped.
    const fusionLine = armFusion(player)

    const boss      = enemy.isBoss
    const tierTag   = boss ? ` _(Boss)_` : enemy.tier === 'elite' ? ` _(Elite ⭐)_` : ''
    const totalFloors = loc.floors ?? 0
    const nextBoss  = !boss ? nextBossFloor(locId, floor + 1) : null
    const bossAlert = nextBoss ? `\n⚠️ _Boss fight at Floor ${nextBoss}_` : ''
    const checkpoint = player.dungeonCheckpoint ?? 0
    const cpLine    = checkpoint > 0 ? `  · Checkpoint: Floor ${checkpoint}` : ''

    const header = boss
      ? `💀 ━━━ *BOSS FIGHT: FLOOR ${floor}/${totalFloors}* ━━━ 💀`
      : `⚔️ *ENCOUNTER: FLOOR ${floor}/${totalFloors}*`
    const familyLine = boss ? '' : encounterLine(locId, enemy.name)
    const entranceMsg = (familyLine ? `\n_${familyLine}_\n` : '') + (entranceLine ? `\n_${entranceLine}_\n` : '')

    // ── Original tower masters: cinematic portrait + full entrance dialogue ──
    // The five image-bearing floor-100 masters (Syclila, Kikaru, Celestia, Bam,
    // Esteria) open with their portrait, carrying their WHOLE entrance script as
    // the caption, and then the battle frame below. sendImage degrades to plain
    // text if the host is unreachable (see lib/image.js), so the dialogue is
    // never lost. Every other boss has no image and keeps its single-line
    // entranceMsg inside the frame, exactly as before.
    let bossImageShown = false
    if (boss && enemy.image) {
      const fullDef = getAnimeBossById(enemy.animeBossId) ?? null
      const script  = fullDef?.entrance?.length
        ? fullDef.entrance
        : (entranceLine ? [entranceLine] : [])
      const caption =
        `💀 ━━━ *${enemy.name}* ━━━ 💀\n_Master of Floor ${floor}_\n\n` +
        script.map((l) => `_${l}_`).join('\n\n')
      await sendImage(ctx, enemy.image, caption).catch(() => {})
      bossImageShown = true
    }

    // Titled players (level 200, lib/title-engine.js) get their tier glyph
    // alongside the level in the battle status line — plain text, so no
    // canvas font concerns here (see lib/title-glyphs.js's header for why
    // that matters on the image-rendered surfaces, but not this one).
    const playerCap = playerLevelCap(player)
    const playerTitled = isTitled(player, playerCap)
    const playerBadge = playerTitled
      ? `${getTierForXp(ensurePrestige(player).xp).glyph} (Lv ${player.level})`
      : `(Lv ${player.level})`

    const msg =
      `${header}\n` +
      `📊 ${floorBar(floor, totalFloors)}${cpLine}\n` +
      (isNewbieLocation(locId)
        ? newbieFloorsLine(player, p)
        : `⚡ Stamina: *${player.stamina.current}/${player.stamina.max}*`) +
      bossAlert +
      (veteranBanner(player) ? `\n${veteranBanner(player)}` : '') +
      `\n\n` +
      `${enemy.emoji ?? '👾'} *${enemy.name}*${tierTag}\n` +
      (bossImageShown ? '' : entranceMsg) +
      `❤️ ${hpBar(enemy.hp, enemy.maxHp)}\n` +
      `⚔️ ATK: *${enemy.atk}*  🛡️ DEF: *${enemy.def}*\n\n` +
      `👤 *${player.name}* ${playerBadge}\n` +
      `❤️ ${hpBar(player.hp, player.maxHp)}\n` +
      `💧 MP: *${player.mp}/${player.maxMp}*\n\n` +
      (fusionLine ? `${fusionLine}\n\n` : '') +
      `*${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`

    // lastAction: null → idle/spawn pose (nothing has happened yet this battle)
    await sendBattleTurnReply(ctx, {
      player, e: enemy, msg,
      hpBeforeTurn: player.hp, eHpBeforeTurn: enemy.hp,
      boss, lastAction: null,
    })
    return player
  })
}

// ── Leave ─────────────────────────────────────────────────────────────

async function handleLeave(ctx) {
  const { reply } = ctx
  const p = config.prefix

  await updatePlayer(ctx.db, ctx.from, async player => {
    if (!player.inDungeon && !player.inBattle) {
      await reply(`❌ You're not in a dungeon.`)
      return player
    }
    if (player.inBattle && player.battleState?.enemy?.isBoss) {
      await reply(`⚠️ You cannot leave during a boss fight! Defeat it or die trying.`)
      return player
    }

    const locId      = player.location
    const loc        = locationsMap[locId]
    const floor      = player.dungeonFloor ?? 0
    const totalFloors = loc?.floors ?? 0
    const highest    = player.dungeonProgress?.[locId]?.highestFloor ?? floor
    const pct        = totalFloors > 0 ? Math.floor((highest / totalFloors) * 100) : 0

    player.inDungeon   = false
    player.inBattle    = false
    player.battleState = null
    player.location    = 'astral_town'
    releaseDungeonSlot(ctx.isGroup ? ctx.sender : null, player, ctx.from)

    await reply(
      `🚪 *${player.name}* exits the dungeon.\n\n` +
      `📍 *${loc?.name ?? locId}*\n` +
      `📊 Progress: ${floorBar(highest, totalFloors)}\n` +
      `🏆 Highest floor this run: *Floor ${floor}*\n` +
      `🎯 Overall best: *Floor ${highest}/${totalFloors}* (${pct}% complete)` +
      `\n\n_Return anytime with *${p}enter ${locId}*_`,
    )
    return player
  })
}

// ── Plugin export ─────────────────────────────────────────────────────

export default {
  name:           'dungeon',
  aliases:        ['enter', 'rift'],
  category:       'dungeon',
  requiresPlayer: true,
  description:    'Enter dungeons and advance through floors',

  async run(ctx) {
    const sub = ctx.args[0]?.toLowerCase()

    // ── ON / OFF (group admins only) ────────────────────────────────────────
    if (sub === 'on' || sub === 'off') {
      if (!ctx.isGroup) return ctx.reply(NOT_GROUP)
      if (!(await isGroupOrBotOwner(ctx))) return ctx.reply(NOT_ALLOWED)
      // Report the stored value, and say so when the write failed — see mine.js.
      const res = await saveGroupSettings(ctx.sender, (s) => { s.dungeonEnabled = (sub === 'on') })
      if (!res.ok) return ctx.reply(saveFailedMessage('dungeons', res.error))
      return ctx.reply(`🗺️ Dungeons are now *${res.settings.dungeonEnabled ? 'ON' : 'OFF'}* in this group.`)
    }

    // ── Group gate ───────────────────────────────────────────────────────────
    if (ctx.isGroup) {
      const settings = await getGroupSettings(ctx.sender)
      if (!settings.dungeonEnabled) {
        return ctx.reply(
          `🚫 Dungeons are disabled in this group.\n` +
          `_A group admin can turn them back on with *${config.prefix}dungeon on*._`,
        )
      }
    }

    if (ctx.cmd === 'enter') return handleEnter(ctx)
    if (sub === 'leave' || sub === 'exit') return handleLeave(ctx)
    if (!ctx.player.inDungeon && ctx.args.length) return handleEnter(ctx)  // .dungeon entry_tower
    return handleAdvance(ctx)
  },
}
