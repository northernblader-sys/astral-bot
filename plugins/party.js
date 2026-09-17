/**
 * party.js — form a party of up to 3 and take on a dungeon together.
 *
 * Registered as `.dparty` (dungeon party) — the `.party` command belongs to
 * plugins/pokemon.js (Pokémon battle party). Short shortcuts `.pattack`,
 * `.pdefend`, `.pflee` live in plugins/pattack.js.
 *
 * Commands:
 *   .dparty create                    — start a party (you become leader)
 *   .dparty invite <@player>          — invite someone (leader only)
 *   .dparty accept                    — accept your pending invite
 *   .dparty decline                   — decline your pending invite
 *   .dparty leave                     — leave your current party
 *   .dparty kick <@player>            — remove a member (leader only)
 *   .dparty disband                   — dissolve the party (leader only)
 *   .dparty                           — show your party status
 *   .dparty enter <dungeonId>         — leader starts a co-op climb of a dungeon
 *   .dparty next / .descend           — leader descends the party to the next floor
 *   .dparty attack / .pattack         — attack the shared enemy (free-for-all)
 *   .dparty cinderverdict / .pcv      — Wither's once-per-battle ember sentence
 *   .dparty defend                    — brace, reduces damage taken this round
 *   .dparty flee                      — leave the party battle (forfeits your cut)
 *
 * How party combat works ("battle royale" style):
 *   The leader starts a climb (.dparty enter) and one enemy spawns for the
 *   whole party, with HP scaled up per extra member so it isn't trivial
 *   (regular floors only — bosses aren't scaled). Every member currently in
 *   the party (not just the leader) can freely send .party attack / .pattack
 *   whenever they like — there's no fixed turn order, whoever acts, acts. The
 *   enemy strikes back at a random party member (favoring whoever has drawn
 *   the most aggro by hitting hardest) after every action. When the enemy
 *   falls, XP/Solars/drops are split among everyone who landed at least one
 *   hit, weighted by damage share — and each cleared floor is banked into
 *   every present member's SOLO dungeonProgress, so co-op progress carries
 *   across modes. The leader then runs .dparty next to descend one floor
 *   deeper (1 stamina per member), repeating until the dungeon is conquered,
 *   the party wipes, or everyone runs out of stamina. The run starts at the
 *   LOWEST member's checkpoint, so a fresh member is never dropped deep.
 *
 * Climb state lives on party.run = { locationId, floor, startedAt } — the
 * cursor for the next floor to fight — while party.battle is the live fight
 * (or null between floors). The season dungeon is the one exception: it stays
 * a single fixed fight against the End on its party-boss floor.
 *
 * State lives in db.data.parties, keyed by leaderId (also the party's id).
 * Each member additionally gets `player.partyId` set to the leader's id for
 * fast lookups. This is intentionally kept separate from the existing solo
 * `player.battleState` / handleVictory / handleDeath flow in
 * combat-handlers.js — party fights are multi-actor and don't map cleanly
 * onto that single-player state machine, so re-using it risked corrupting
 * solo dungeon runs. Nothing in the existing solo combat files is modified.
 */
import { config } from '../config.js'
import { sendBattleTurnReply } from '../lib/battle-frame-render.mjs'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import {
  locationsMap,
  regularByLoc,
  bossByLocFloor,
  getAnimeBossForSlot,
  allItems,
  classes,
  races,
  skills as allSkills,
  levelsData,
  getTotalStats,
} from '../lib/game-data.js'
import { pickMonsterForFloor, refreshStamina, hpBar, calcPlayerDamage, applyDefense, calcMonsterDamage, calcPlayerHitChance, calcMonsterHitChance, rollDrops, applyLevelUps, getNewlyUnlockedSkills, rollEchoStrike } from '../lib/combat-engine.js'
// isDungeonUnlocked is a hoisted function export, so importing it here from the
// solo dungeon plugin is safe even though both are auto-loaded plugins (no
// evaluation-order cycle — it's only ever called at runtime).
import { isDungeonUnlocked } from './dungeon.js'
import {
  initBossFight,
  applyBossSpecial,
  checkBossPhase,
  buildEnemyAttack,
  incrementBossTurn,
  getBossTaunt,
  getBossHitLine,
  getBossDodgeLine,
  EVENT,
} from '../lib/boss-engine.js'
import { hasInventoryRoom } from '../lib/inventory-limits.js'
import { getModValue, applyHighDefenseCatchup } from '../lib/mods.js'
import { getActiveSeason, ensurePlayerSeasonState, applySeasonLevel } from '../lib/season-engine.js'
import { applyMeiSustainHeal, applyInfinity, activateFinalForm, applyTearOnHit, tickPermanentSever, activateCinderVerdict, activateHollowPurple, activateUnlimitedVoid, UNLIMITED_VOID_STUN_TURNS, sendFinalFormVideo, hasSecondTranscendance, activateKurama, resolveKuramaDrain, narutoBattleLine, sendKuramaSummonImage } from '../lib/character-abilities.js'
import { checkPearlSave, processStatusTurn } from '../lib/combat-handlers.js'
import { addStatusEffect } from '../lib/effects.js'

const MAX_PARTY_SIZE = 3
const INVITE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const HP_SCALE_PER_EXTRA_MEMBER = 0.6   // enemy gets +60% max HP per member beyond the first
const BOSS_COMBAT_CAPS = { hp: 50_000, atk: 4_500, def: 1_800 }

function ensurePartyStore(db) {
  if (!db.data.parties) db.data.parties = {}
  return db.data.parties
}

function getPartyByLeader(db, leaderId) {
  return ensurePartyStore(db)[leaderId] ?? null
}

/** Find the party a given player belongs to (as leader or member), or null. */
function findPartyForPlayer(db, jid) {
  const parties = ensurePartyStore(db)
  if (parties[jid]) return parties[jid]
  for (const party of Object.values(parties)) {
    if (party.members.includes(jid)) return party
  }
  return null
}

/**
 * Resolve a target jid, checking in order of reliability:
 *  1. Reply-to-message (quoting the target's own message) — the JID comes
 *     straight from WhatsApp's contextInfo.participant, so it's exact.
 *  2. @mention in the message text — same contextInfo object, mentionedJid.
 *  3. A raw phone number typed as an argument — fallback, more error-prone.
 */
function resolveTargetJid(ctx, raw) {
  const contextInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo
  if (contextInfo?.participant) return contextInfo.participant
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0]
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

function nameFor(db, jid) {
  return getPlayer(db, jid)?.name ?? jid?.split('@')[0] ?? 'unknown'
}

function memberListText(db, party) {
  return party.members
    .map(m => `  ${m === party.leaderId ? '👑' : '⚔️'} ${nameFor(db, m)}`)
    .join('\n')
}

// ── .party (status) ────────────────────────────────────────────────────
async function showStatus(ctx) {
  const p = config.prefix
  const party = findPartyForPlayer(ctx.db, ctx.from)

  if (!party) {
    return ctx.reply(
      `┌─────────────────────┐\n│   🤝 *PARTY*   │\n└─────────────────────┘\n\n` +
      `You're not in a party.\n\n` +
      `*${p}dparty create* — start one\n` +
      `_Invite friends, then *${p}dparty enter <dungeon>* to fight together._`,
    )
  }

  const inBattle = !!party.battle
  let msg = `┌─────────────────────┐\n│   🤝 *YOUR PARTY*   │\n└─────────────────────┘\n\n`
  msg += `👑 Leader: *${nameFor(ctx.db, party.leaderId)}*\n`
  msg += `👥 Members (${party.members.length}/${MAX_PARTY_SIZE}):\n${memberListText(ctx.db, party)}\n\n`
  if (party.pendingInvites?.length) {
    msg += `📨 Pending invites: ${party.pendingInvites.map(j => nameFor(ctx.db, j)).join(', ')}\n\n`
  }
  msg += inBattle
    ? `⚔️ *Currently in battle at ${locationsMap[party.battle.locationId]?.name ?? party.battle.locationId}!*\nUse *${p}dparty attack* to join in.`
    : party.run
      ? `🧗 *Climbing ${locationsMap[party.run.locationId]?.name ?? party.run.locationId}* — next up: *Floor ${party.run.floor}*.\nLeader: *${p}dparty next* to descend.`
      : `📍 Status: *Idle*\nUse *${p}dparty enter <dungeonId>* to head into a dungeon together.`

  await ctx.reply(msg)
}

// ── .party create ────────────────────────────────────────────────────────
async function createParty(ctx) {
  const p = config.prefix
  await updatePlayer(ctx.db, ctx.from, async player => {
    // Parties form freely — the co-op climb works on any main dungeon the
    // members have unlocked. The season-boss floor requirement is enforced
    // later, only when a party tries to *enter* the season dungeon itself
    // (see enterDungeon's isSeasonBoss branch).
    if (findPartyForPlayer(ctx.db, ctx.from)) {
      await ctx.reply(`⚠️ You're already in a party. Use *${p}dparty leave* first if you want to start a new one.`)
      return player
    }
    const parties = ensurePartyStore(ctx.db)
    parties[ctx.from] = {
      leaderId: ctx.from,
      members: [ctx.from],
      pendingInvites: [],
      battle: null,
      createdAt: Date.now(),
    }
    player.partyId = ctx.from
    await ctx.reply(
      `┌─────────────────────┐\n│   🤝 *PARTY CREATED*   │\n└─────────────────────┘\n\n` +
      `👑 *${player.name}* is now the party leader!\n\n` +
      `*${p}dparty invite <@player>* — invite up to ${MAX_PARTY_SIZE - 1} more members\n` +
      `*${p}dparty enter <dungeonId>* — once ready, head in together`,
    )
    return player
  })
}

// ── .party invite <@player> ──────────────────────────────────────────────
async function invite(ctx, targetRaw) {
  const p = config.prefix
  const targetJid = resolveTargetJid(ctx, targetRaw)

  const party = findPartyForPlayer(ctx.db, ctx.from)
  if (!party) return ctx.reply(`❌ You're not in a party. Use *${p}dparty create* first.`)
  if (party.leaderId !== ctx.from) return ctx.reply(`❌ Only the party leader can invite members.`)
  if (!targetJid) return ctx.reply(`❓ Usage: *${p}dparty invite <@player>*`)
  if (targetJid === ctx.from) return ctx.reply(`❌ You can't invite yourself.`)
  if (!getPlayer(ctx.db, targetJid)) return ctx.reply(`❌ That player isn't registered yet.`)
  if (party.members.includes(targetJid)) return ctx.reply(`⚠️ ${nameFor(ctx.db, targetJid)} is already in the party.`)
  if (party.members.length >= MAX_PARTY_SIZE) return ctx.reply(`❌ Party is full (${MAX_PARTY_SIZE}/${MAX_PARTY_SIZE}).`)
  if (findPartyForPlayer(ctx.db, targetJid)) return ctx.reply(`❌ ${nameFor(ctx.db, targetJid)} is already in another party.`)

  party.pendingInvites = party.pendingInvites ?? []
  if (party.pendingInvites.some(i => i.jid === targetJid)) {
    return ctx.reply(`⚠️ You've already invited ${nameFor(ctx.db, targetJid)}. Waiting on their response.`)
  }
  party.pendingInvites.push({ jid: targetJid, invitedAt: Date.now() })

  await ctx.reply(
    `📨 *Invite sent to ${nameFor(ctx.db, targetJid)}!*\n\n` +
    `They can join with *${p}dparty accept* _(expires in 5 min)_.`,
  )

  // DM to the invited player disabled on request — invite is still recorded
  // in party.pendingInvites above, so `.dparty accept`/`.decline` both still
  // work once the invitee knows to type them. Heads up: there is currently
  // no in-game way for the invitee to discover a pending invite on their own
  // — .party/.dparty status only shows invites you SENT (see showStatus()
  // above), not ones sent TO you. Without the DM, an invite is effectively
  // invisible unless the inviter tells them out of band. If that's not what
  // you want, the fix is a few lines in showStatus() to also check
  // findPendingInviteFor(ctx.from) — just say so and I'll add it.
}

// ── .party accept / decline ──────────────────────────────────────────────
async function respondInvite(ctx, accept) {
  const p = config.prefix
  const parties = ensurePartyStore(ctx.db)
  const now = Date.now()

  let foundParty = null
  for (const party of Object.values(parties)) {
    party.pendingInvites = (party.pendingInvites ?? []).filter(i => now - i.invitedAt < INVITE_TIMEOUT_MS)
    if (party.pendingInvites.some(i => i.jid === ctx.from)) { foundParty = party; break }
  }

  if (!foundParty) return ctx.reply(`❌ You don't have a pending party invite.`)

  foundParty.pendingInvites = foundParty.pendingInvites.filter(i => i.jid !== ctx.from)

  if (!accept) return ctx.reply(`🚫 Invite declined.`)

  if (foundParty.members.length >= MAX_PARTY_SIZE) {
    return ctx.reply(`❌ That party is now full.`)
  }
  if (findPartyForPlayer(ctx.db, ctx.from)) {
    return ctx.reply(`❌ You're already in a party.`)
  }

  await updatePlayer(ctx.db, ctx.from, async player => {
    foundParty.members.push(ctx.from)
    player.partyId = foundParty.leaderId
    await ctx.reply(
      `✅ *${player.name}* joined the party!\n\n` +
      `👥 Members (${foundParty.members.length}/${MAX_PARTY_SIZE}):\n${memberListText(ctx.db, foundParty)}`,
    )
    return player
  })
}

// ── .party leave ──────────────────────────────────────────────────────────
async function leave(ctx) {
  const p = config.prefix
  const party = findPartyForPlayer(ctx.db, ctx.from)
  if (!party) return ctx.reply(`❌ You're not in a party.`)

  if (party.battle) {
    return ctx.reply(`⚠️ You can't leave mid-battle. Use *${p}dparty flee* instead.`)
  }

  await updatePlayer(ctx.db, ctx.from, async player => {
    player.partyId = null
    if (party.leaderId === ctx.from) {
      // Leader leaving disbands the party entirely.
      const parties = ensurePartyStore(ctx.db)
      for (const m of party.members) {
        if (m === ctx.from) continue
        await updatePlayer(ctx.db, m, async mp => { mp.partyId = null; return mp })
      }
      delete parties[party.leaderId]
      await ctx.reply(`🚪 *${player.name}* (leader) left — the party has disbanded.`)
    } else {
      party.members = party.members.filter(m => m !== ctx.from)
      await ctx.reply(`🚪 *${player.name}* left the party.`)
    }
    return player
  })
}

// ── .party kick <@player> ─────────────────────────────────────────────────
async function kick(ctx, targetRaw) {
  const targetJid = resolveTargetJid(ctx, targetRaw)
  const party = findPartyForPlayer(ctx.db, ctx.from)
  if (!party) return ctx.reply(`❌ You're not in a party.`)
  if (party.leaderId !== ctx.from) return ctx.reply(`❌ Only the leader can kick members.`)
  if (!targetJid || !party.members.includes(targetJid)) return ctx.reply(`❌ That player isn't in your party.`)
  if (targetJid === ctx.from) return ctx.reply(`❌ You can't kick yourself — use *${config.prefix}dparty disband* instead.`)
  if (party.battle) return ctx.reply(`⚠️ Can't kick mid-battle.`)

  party.members = party.members.filter(m => m !== targetJid)
  await updatePlayer(ctx.db, targetJid, async mp => { mp.partyId = null; return mp })
  await ctx.reply(`👢 *${nameFor(ctx.db, targetJid)}* was removed from the party.`)
}

// ── .party disband ─────────────────────────────────────────────────────────
async function disband(ctx) {
  const party = findPartyForPlayer(ctx.db, ctx.from)
  if (!party) return ctx.reply(`❌ You're not in a party.`)
  if (party.leaderId !== ctx.from) return ctx.reply(`❌ Only the leader can disband the party.`)
  if (party.battle) return ctx.reply(`⚠️ Can't disband mid-battle.`)

  const parties = ensurePartyStore(ctx.db)
  for (const m of party.members) {
    await updatePlayer(ctx.db, m, async mp => { mp.partyId = null; return mp })
  }
  delete parties[party.leaderId]
  await ctx.reply(`💥 *Party disbanded.*`)
}

// ── Combat helpers ───────────────────────────────────────────────────────

function isBossFloor(locId, floor) {
  return (locationsMap[locId]?.bossFloors ?? []).includes(floor)
}

function spawnPartyEnemy(locId, floor, memberCount) {
  let base
  if (isBossFloor(locId, floor)) {
    const animeBoss = getAnimeBossForSlot(locId, floor)
    if (animeBoss) {
      const init = initBossFight({}, animeBoss.id, floor)
      if (!init.ok) return null
      base = {
        ...init.enemy,
        locationId: locId,
        floor,
        hp: init.enemy.hp,
        maxHp: init.enemy.maxHp,
        isBoss: true,
        animeBossId: animeBoss.id,
        // Conquest title for the final-floor reveal AND the title granted on
        // conquest (resolvePartyVictory). Mirrors dungeon.js spawnBoss so a
        // party clearing a dungeon's last floor earns the same title solo does.
        conquestTitle: animeBoss.conquestTitle ?? `${animeBoss.name}'s Equal`,
        // Carried alongside the enemy so battleAttack/battleCinderVerdict can
        // drive lib/boss-engine.js's mechanics (Infinity, Mahoraga adapt,
        // phase shifts, named attacks, etc.) via _withBossBattleState below.
        // Plain (non-anime) bosses from bossByLocFloor have no def.special/
        // phases/attacks, so bossState stays undefined for them and the
        // bridge below simply no-ops — same as they behave today.
        bossState: init.bossState,
      }
      // resolvePartyVictory reads enemy.rewards?.xp/solars and rollDrops(enemy.drops)
      // (which needs [{itemId,chance}]). initBossFight only sets exp/gold and a
      // string[] of drops, which that path doesn't read — so an anime boss that
      // is ALSO a monsters.json entry (same id at this loc/floor, e.g. the
      // Season 1 End boss) would otherwise award nothing. Carry the twin's
      // reward/drop fields through in the format victory resolution expects.
      // Twinless anime bosses (the floor 100–1000 roster) have no matching
      // monster entry, so this is a no-op for them.
      const twin = bossByLocFloor[locId]?.[floor]
      if (twin && twin.id === animeBoss.id) {
        base.rewards = twin.rewards
        base.drops   = twin.drops
      }
    } else {
      const boss = bossByLocFloor[locId]?.[floor]
      if (!boss) return null
      base = {
        ...boss,
        hp: Math.min(BOSS_COMBAT_CAPS.hp, boss.stats.hp),
        maxHp: Math.min(BOSS_COMBAT_CAPS.hp, boss.stats.hp),
        def: Math.min(BOSS_COMBAT_CAPS.def, boss.stats.def),
        atk: Math.min(BOSS_COMBAT_CAPS.atk, boss.stats.atk),
        isBoss: true,
      }
    }
  } else {
    base = pickMonsterForFloor(locId, floor, regularByLoc)
  }
  if (!base) return null

  // Boss HP is already balanced by floor. Only regular enemies scale for
  // party size, so multiplayer does not turn a 50k boss into a 170k wall.
  const scale = base.isBoss
    ? 1
    : 1 + (Math.max(1, memberCount) - 1) * HP_SCALE_PER_EXTRA_MEMBER
  const scaledHp = Math.round(base.maxHp * scale)
  return { ...base, hp: scaledHp, maxHp: scaledHp }
}

/**
 * Bridge for lib/boss-engine.js in party fights.
 *
 * applyBossSpecial / checkBossPhase / buildEnemyAttack all read and mutate
 * `player.battleState.enemy` / `player.battleState.bossState`. Party fights
 * don't use player.battleState — the enemy is shared across the whole party
 * on party.battle.enemy instead — so calling those functions directly during
 * a party turn would silently no-op (no battleState.enemy to find).
 *
 * This shapes a throwaway battleState-like object pointing at the *same*
 * enemy and bossState objects that live on party.battle, calls fn against
 * it, then returns fn's result untouched. Because JS objects are references,
 * any in-place mutation the boss-engine functions make (enemy.hp, bossState
 * counters, etc.) lands directly on party.battle.enemy / .bossState — no
 * copy-back step needed. Player-side effects (stat reductions, MP drain)
 * read/write `player`, which is the real per-member document already.
 *
 * @param {object} player - the acting party member's real player document
 * @param {object} enemy  - party.battle.enemy (shared boss)
 * @param {(bridgedPlayer: object) => any} fn - call one of the boss-engine
 *   functions against bridgedPlayer.battleState, e.g.
 *   `p => applyBossSpecial(p, EVENT.TURN_START, {})`
 */
function withBossBattleState(player, enemy, fn) {
  if (!enemy?.isBoss || !enemy?.bossState) return null
  const savedBattleState = player.battleState
  player.battleState = { enemy, bossState: enemy.bossState }
  try {
    return fn(player)
  } finally {
    player.battleState = savedBattleState
  }
}

/**
 * Fallback enemy-attack for a *plain* boss — `isBoss: true` but no `bossState`
 * (e.g. the Season 1 "End" boss, built by spawnPartyEnemy's bossByLocFloor
 * branch). Plain bosses have no boss-engine mechanics, so withBossBattleState()
 * above no-ops and never populates the bossAtk/dealResult that the boss-
 * retaliation blocks in battleAttack/battleDefend/battleCinderVerdict read —
 * dereferencing dealResult.modified then threw and killed the whole turn
 * (the bot reacts ⚔️ but never replies). This returns values shaped exactly
 * like buildEnemyAttack()/applyBossSpecial() would, so the boss still lands a
 * basic attacker-targeted strike (raw ATK, run through DEF downstream).
 */
function plainBossStrike(enemy) {
  return {
    bossAtk: {
      attackName: 'Strike',
      damage: enemy.atk,
      bypassDefense: false,
      doubleStrike: false,
      narrativeLines: [],
    },
    dealResult: { modified: false, damage: undefined, guaranteedHits: null, narrativeLine: null },
  }
}

// ── .dparty enter <dungeonId> ─────────────────────────────────────────────
// Starts a co-op CLIMB: the party descends floor by floor (leader steps with
// .dparty next), and each cleared floor banks into every present member's SOLO
// dungeonProgress so the run carries across modes. The season boss stays a
// single fixed fight on its party-boss floor.
async function enterDungeon(ctx, dungeonArg) {
  const p = config.prefix
  const party = findPartyForPlayer(ctx.db, ctx.from)
  if (!party) return ctx.reply(`❌ You're not in a party. Use *${p}dparty create* first.`)
  if (party.leaderId !== ctx.from) return ctx.reply(`❌ Only the party leader can lead the party into a dungeon.`)
  if (party.battle) return ctx.reply(`⚠️ Your party is already in a battle! Use *${p}dparty attack*.`)
  if (party.run) return ctx.reply(`🧗 Your party is already climbing *${locationsMap[party.run.locationId]?.name ?? party.run.locationId}*. Use *${p}dparty next* to descend, or *${p}dparty leave* to stop.`)
  if (!dungeonArg) return ctx.reply(`❓ Usage: *${p}dparty enter <dungeonId>*\nExample: *${p}dparty enter entry_tower*`)

  const locId = dungeonArg.toLowerCase().replace(/\s+/g, '_')
  const loc = locationsMap[locId]
  if (!loc || loc.type !== 'dungeon') return ctx.reply(`❌ Unknown dungeon *${locId}*.`)
  const season = getActiveSeason(ctx.db)
  const isSeasonBoss = locId === season?.dungeon
  if (isSeasonBoss) {
    // The season dungeon is intentionally narrow: a party may only enter it
    // for the End on the party-boss floor, never for the solo floors before it.
    // Fall back to the dungeon's own last floor rather than a hardcoded 50,
    // which stopped being any dungeon's depth when they all became 100 floors.
    const gateFloor = season.partyBossFloor ?? loc.floors ?? 100
    for (const jid of party.members) {
      const member = getPlayer(ctx.db, jid)
      const progress = member ? ensurePlayerSeasonState(member, season.id).seasonProgress : null
      if (!progress || progress.currentFloor < gateFloor) {
        return ctx.reply(`❌ Everyone must reach Floor ${gateFloor} before the party can challenge the End.`)
      }
    }
  }

  // Validate every member: unlocked, high enough level, and free to enter.
  for (const jid of party.members) {
    const member = getPlayer(ctx.db, jid)
    if (!member) continue
    if (member.inDungeon || member.inBattle) {
      return ctx.reply(`⚠️ *${member.name}* is busy in their own dungeon/battle. Everyone must be free to enter together.`)
    }
    if (!isSeasonBoss && !isDungeonUnlocked(member, locId)) {
      return ctx.reply(`🔒 *${member.name}* hasn't unlocked *${loc.name}* yet, everyone needs it unlocked to climb together.`)
    }
    if (member.level < loc.entryLevel) {
      return ctx.reply(`❌ *${member.name}* is below the required Level ${loc.entryLevel} for *${loc.name}*.`)
    }
  }

  // Gated start floor: begin at the LOWEST member's checkpoint, so a fresh
  // member can never be dropped straight onto a deep floor they never earned.
  // The season boss is fixed to its party-boss floor.
  let startFloor
  if (isSeasonBoss) {
    startFloor = season.partyBossFloor ?? loc.floors ?? 100
  } else {
    const checkpoints = party.members.map(jid =>
      getPlayer(ctx.db, jid)?.dungeonProgress?.[locId]?.highestFloor ?? 0)
    startFloor = Math.max(1, Math.min(...checkpoints))
  }

  // Pre-check that everyone can pay (stamina + travel) WITHOUT mutating — an
  // all-or-nothing entry must not half-charge the members who could afford it.
  const travelCost = loc.travelCost ?? 0
  for (const jid of party.members) {
    const member = getPlayer(ctx.db, jid)
    if (!member) continue
    const stam = refreshStamina({ ...member.stamina })
    if (stam.current < 1) {
      return ctx.reply(`❌ *${member.name}* has no stamina left. Entry cancelled.`)
    }
    if (travelCost > 0 && (member.wallet?.solars ?? 0) < travelCost) {
      return ctx.reply(`❌ *${member.name}* can't afford the *${travelCost} ☀️* travel cost. Entry cancelled.`)
    }
  }

  // Commit: deduct 1 stamina + travel from each member and mark them present.
  for (const jid of party.members) {
    await updatePlayer(ctx.db, jid, async member => {
      member.stamina = refreshStamina(member.stamina)
      member.stamina.current -= 1
      if (travelCost > 0) {
        member.wallet = member.wallet ?? {}
        member.wallet.solars = (member.wallet.solars ?? 0) - travelCost
      }
      member.inBattle = true
      return member
    })
  }

  party.run = { locationId: locId, floor: startFloor, startedAt: Date.now() }
  await spawnAndAnnounceFloor(ctx, party, { first: true })
}

// ── Spawn + announce one floor of the climb ───────────────────────────────
// Shared by enterDungeon (first floor) and handleNext (every floor after). The
// caller has already charged stamina and set inBattle=true on the members
// joining this floor; this reads that to size the enemy and drive the announce.
// Tears the run down and returns false if no enemy could spawn.
async function spawnAndAnnounceFloor(ctx, party, { first = false } = {}) {
  const p = config.prefix
  const { locationId: locId, floor } = party.run
  const loc = locationsMap[locId]
  const present = party.members.filter(m => getPlayer(ctx.db, m)?.inBattle)
  const memberCount = present.length || 1

  const enemy = spawnPartyEnemy(locId, floor, memberCount)
  if (!enemy) {
    for (const jid of party.members) await updatePlayer(ctx.db, jid, async m => { m.inBattle = false; return m })
    party.run = null
    party.battle = null
    await ctx.reply(`❌ No monsters found for Floor ${floor} of *${loc?.name ?? locId}*. The climb ends.`)
    return false
  }

  party.battle = {
    locationId: locId,
    floor,
    enemy,
    contributions: {}, // jid -> total damage dealt
    // Per-member, once-per-battle character-ability flags (Mei's Final Form,
    // Wither's Cinder Verdict). Party fights don't use player.battleState, so
    // these stand in for it — discarded with each floor's battle object, so
    // they reset every floor for free, same as solo battleState flags.
    charState: {},
    startedAt: Date.now(),
  }

  const totalFloors = loc?.floors ?? 0
  // Full boss reveal for the season End OR any dungeon's true final floor (the
  // conquest boss). Every other boss floor gets the normal inline boss tag.
  const isFinalBoss = enemy.isBoss && (locId === getActiveSeason(ctx.db)?.dungeon || (totalFloors > 0 && floor >= totalFloors))
  const tierTag = enemy.isBoss ? ' _(Boss)_' : enemy.tier === 'elite' ? ' _(Elite ⭐)_' : ''

  let msg = isFinalBoss
    ? `╔═══ 👑 *THE FINAL BOSS* ═══╗\n\n`
    : first
      ? `╔═══ ⚔️ *PARTY CLIMB* ═══╗\n\n`
      : `╔═══ ⬇️ *FLOOR ${floor}* ═══╗\n\n`
  msg += `📍 *${loc?.name ?? locId}* — Floor ${floor}${totalFloors ? `/${totalFloors}` : ''}\n`
  msg += `👥 Party (${present.length}): ${present.map(m => nameFor(ctx.db, m)).join(', ')}\n\n`
  if (isFinalBoss) {
    // Full reveal — conquest title, lore, HP, and the loot on the line.
    msg += `${enemy.emoji ?? '👑'} *${enemy.name}*`
    if (enemy.conquestTitle) msg += ` — _"${enemy.conquestTitle}"_`
    msg += `\n`
    if (enemy.description) msg += `_${enemy.description}_\n`
    msg += `\n❤️ ${hpBar(enemy.hp, enemy.maxHp)} *(${enemy.maxHp.toLocaleString()} HP)*\n`
    msg += `⚔️ ATK: *${enemy.atk}*  🛡️ DEF: *${enemy.def}*\n`
    const dropNames = (enemy.drops ?? [])
      .map(d => allItems.find(i => i.id === d.itemId)?.name ?? d.itemId)
    if (dropNames.length) msg += `🎁 *On the line:* ${dropNames.join(', ')}\n`
    msg += `\n_This is the last floor. There is no fleeing — the whole party must break it together._\n`
  } else {
    msg += `${enemy.emoji ?? '👾'} *${enemy.name}*${tierTag} appears!\n`
    msg += `❤️ ${hpBar(enemy.hp, enemy.maxHp)}\n`
    msg += `⚔️ ATK: *${enemy.atk}*  🛡️ DEF: *${enemy.def}*\n\n`
    msg += `_It's a free-for-all — anyone in the party can act!_\n`
  }
  // battleFlee() rejects .dparty flee against ANY boss, so the footer only
  // advertises flee on regular (non-boss) floors.
  msg += enemy.isBoss
    ? `*${p}dparty attack* (or *${p}pattack*) · *${p}dparty defend*\n`
    : `*${p}dparty attack* (or *${p}pattack*) · *${p}dparty defend* · *${p}dparty flee*\n`
  msg += `_🔥 Wither: *${p}dparty cv* · 🌸 Mei's Final Form triggers automatically below 70% HP._`

  await ctx.reply(msg)
  return true
}

// ── .dparty next — leader descends the party to the next floor ─────────────
async function handleNext(ctx) {
  const p = config.prefix
  const party = findPartyForPlayer(ctx.db, ctx.from)
  if (!party) return ctx.reply(`❌ You're not in a party.`)
  if (party.leaderId !== ctx.from) return ctx.reply(`❌ Only the party leader can descend to the next floor.`)
  if (party.battle) return ctx.reply(`⚔️ Finish the current floor first — *${p}dparty attack*.`)
  if (!party.run) return ctx.reply(`❌ Your party isn't climbing. Use *${p}dparty enter <dungeonId>* to start.`)

  const locId = party.run.locationId
  const loc = locationsMap[locId]
  const floor = party.run.floor
  if (!loc) { party.run = null; return ctx.reply(`❌ Location data missing. The climb ends.`) }

  // Charge 1 stamina per member; anyone out of stamina sits this floor out
  // (they stay in the party and rejoin once stamina refreshes at midnight).
  let anyReady = false
  const rested = []
  for (const jid of party.members) {
    await updatePlayer(ctx.db, jid, async member => {
      member.stamina = refreshStamina(member.stamina)
      if (member.stamina.current < 1) { member.inBattle = false; return member }
      member.stamina.current -= 1
      member.inBattle = true
      return member
    })
    if (getPlayer(ctx.db, jid)?.inBattle) anyReady = true
    else rested.push(jid)
  }

  if (!anyReady) {
    party.run = null
    return ctx.reply(
      `⚡ *Nobody has stamina left.* The party rests — progress is saved at Floor ${floor}.\n` +
      `_Return with *${p}dparty enter ${locId}* once stamina refreshes at midnight._`,
    )
  }
  if (rested.length) {
    await ctx.reply(`😮‍💨 _${rested.map(j => nameFor(ctx.db, j)).join(', ')} ${rested.length === 1 ? 'is' : 'are'} out of stamina and sit${rested.length === 1 ? 's' : ''} this floor out._`)
  }

  await spawnAndAnnounceFloor(ctx, party)
}

// ── Party battle: attack ─────────────────────────────────────────────────
// Resolve a hit that lands on a party member. Gojo's Infinity thins the strike
// before it arrives (a no-op for anyone else); Mei's sustain catches an
// otherwise-lethal blow. A player has exactly one equipped character, so at most
// one of the two ever fires. They compose in the order damage actually resolves
// — Infinity slows the strike first, then Mei's seal decides whether to catch
// what is left — and this returns the same { damage, message } shape every
// retaliation site below already consumes, with any Infinity line folded in.
function applyPartyIncoming(target, rawDamage, cs) {
  const infinity = applyInfinity(target, rawDamage)
  const sustain = applyMeiSustainHeal(target, infinity.damage, cs)
  const message = [infinity.message, sustain.message].filter(Boolean).join('\n')
  return { ...sustain, message }
}

async function battleAttack(ctx) {
  const p = config.prefix
  const party = findPartyForPlayer(ctx.db, ctx.from)
  if (!party) return ctx.reply(`❌ You're not in a party.`)
  if (!party.battle) return ctx.reply(`❌ Your party isn't in a battle. Use *${p}dparty enter <dungeon>*.`)

  await updatePlayer(ctx.db, ctx.from, async player => {
    const battle = party.battle
    const e = battle.enemy

    const eHpBeforeTurn = e.hp
    const boss = e.isBoss ?? false

    // Per-member, once-per-battle character-ability flags stand in for
    // player.battleState here (party fights don't use it) — see the
    // party.battle.charState note in enterDungeon().
    battle.charState = battle.charState ?? {}
    const cs = battle.charState[ctx.from] = battle.charState[ctx.from] ?? {}

    let pre = ''

    // Urahara's permanent Tear — action-triggered tick, same as every other
    // combat entry point (attack.js / pvp.js / cinderverdict.js).
    const permaSeverLine = tickPermanentSever(player)
    if (permaSeverLine) pre += permaSeverLine + '\n'
    if (player.hp <= 0) {
      if (pre) await ctx.reply(pre)
      await handlePartyMemberDown(ctx, party, ctx.from)
      return player
    }

    // Mei's Final Form — automatic at ≤70% HP, once per battle.
    const finalForm = activateFinalForm(player, cs)
    if (finalForm.ok) {
      pre += finalForm.message + '\n'
      void sendFinalFormVideo(ctx, finalForm.message, ctx.sender).catch(() => {})
    }

    // Tick the enemy's own DOTs (e.g. Urahara's Tear/Reshape bleed) so party
    // fights honour status effects the same way solo/PvP turns do.
    const enemyStatus = processStatusTurn(e)
    if (enemyStatus.lines.length) pre += enemyStatus.lines.join('\n') + '\n'
    if (e.hp <= 0) {
      await ctx.reply(pre + `\n${e.emoji ?? '👾'} *${e.name}* succumbs to its wounds!`)
      await resolvePartyVictory(ctx, party)
      return player
    }

    // ── Boss: increment turn counter + TURN_START event ─────────────────────
    // Mirrors attack.js's turn-start boss-engine hook (Jotaro's Time Stop,
    // narrative turn-start lines, etc.) via the withBossBattleState bridge —
    // see its doc comment above spawnPartyEnemy for why this is needed.
    if (boss) {
      withBossBattleState(player, e, bp => {
        incrementBossTurn(bp)
        const tsResult = applyBossSpecial(bp, EVENT.TURN_START, {})
        if (tsResult.narrativeLine) pre += `_${tsResult.narrativeLine}_\n`
      })
      if (e.hp <= 0) {
        await ctx.reply(pre)
        await resolvePartyVictory(ctx, party)
        return player
      }
    }

    if (Math.random() > calcPlayerHitChance(player, e)) {
      let missMsg = pre + `💨 *${player.name}* attacks *${e.name}*... and *MISSES!*`
      if (boss) {
        withBossBattleState(player, e, bp => {
          const missResult = applyBossSpecial(bp, EVENT.PLAYER_MISS, { isMiss: true })
          missMsg += `\n💬 _"${getBossDodgeLine(bp)}"_`
          if (missResult.narrativeLine) missMsg += `\n_${missResult.narrativeLine}_`
        })
      }
      await sendBattleTurnReply(ctx, {
        player, e, msg: missMsg,
        hpBeforeTurn: player.hp, eHpBeforeTurn, boss,
      })
      return player
    }

    // Cheat mods (PvE only — party battles are co-op vs a shared enemy).
    const { rawDmg, isCrit } = calcPlayerDamage(
      player,
      null,
      getModValue(player, 'damage_multiplier') ?? 1,
      getModValue(player, 'crit_chance_boost') ?? 0,
    )
    let finalDmg = applyHighDefenseCatchup(player, e, applyDefense(rawDmg, e.def))

    let msg = pre
    if (boss) {
      // PLAYER_BASIC_ATTACK + ENEMY_TAKE_DAMAGE — Gojo nullifies, Mahoraga
      // adapts, Meliodas reflects, etc. Same two-call sequence attack.js uses.
      withBossBattleState(player, e, bp => {
        const basicResult = applyBossSpecial(bp, EVENT.PLAYER_BASIC_ATTACK, {
          damage: finalDmg, element: 'physical', isCrit, isHit: true,
        })
        if (basicResult.modified && basicResult.damage !== undefined) finalDmg = basicResult.damage
        if (basicResult.narrativeLine) msg += `_${basicResult.narrativeLine}_\n`

        const takeResult = applyBossSpecial(bp, EVENT.ENEMY_TAKE_DAMAGE, {
          damage: finalDmg, element: 'physical', isCrit, isHit: true,
        })
        if (takeResult.modified && takeResult.damage !== undefined) finalDmg = takeResult.damage
        if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`

        // Meliodas' Full Counter — reflect damage back at the attacker.
        if (takeResult.reflectDamage) {
          player.hp = Math.max(0, player.hp - takeResult.reflectDamage)
          msg += `🔁 *Full Counter!* Your attack is reflected!\n🩸 *${takeResult.reflectDamage}* damage back at you!\n`
        }
      })
    }

    e.hp = Math.max(0, e.hp - finalDmg)
    battle.contributions[ctx.from] = (battle.contributions[ctx.from] ?? 0) + finalDmg

    msg += `⚔️ *${player.name}* hits *${e.name}*${isCrit ? ' ⚡*CRIT!*' : ''} for *${finalDmg}* damage!\n`
    msg += `❤️ ${e.name}: ${hpBar(e.hp, e.maxHp)}\n`

    if (player.hp <= 0) {
      await ctx.reply(msg)
      await handlePartyMemberDown(ctx, party, ctx.from)
      return player
    }

    if (e.hp > 0) {
      // Urahara's Tear/Reshape — mark the enemy on a landed hit (ticks next round).
      const tearLine = applyTearOnHit(player, e)
      if (tearLine) msg += tearLine + '\n'
    }

    if (e.hp <= 0) {
      await ctx.reply(msg)
      await resolvePartyVictory(ctx, party)
      return player
    }

    if (boss) {
      // PLAYER_HIT_ENEMY — Shanks hit-streak, Aizen hypnosis, etc.
      withBossBattleState(player, e, bp => {
        const hitResult = applyBossSpecial(bp, EVENT.PLAYER_HIT_ENEMY, {
          damage: finalDmg, isCrit, element: 'physical', isHit: true,
        })
        if (hitResult.narrativeLine) msg += `_${hitResult.narrativeLine}_\n`
        if (finalDmg > 0) msg += `💬 _"${getBossHitLine(bp)}"_\n`
      })

      if (e.hp <= 0) {
        await ctx.reply(msg)
        await resolvePartyVictory(ctx, party)
        return player
      }

      // Phase transition — announce narrative when HP crosses 75/50/25%.
      withBossBattleState(player, e, bp => {
        const phase = checkBossPhase(bp)
        if (phase?.triggered && phase.lines?.length) {
          msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.join('\n') + '\n'
        }
      })
    }

    if (e.hp <= 0) {
      await ctx.reply(msg)
      await resolvePartyVictory(ctx, party)
      return player
    }

    // ⚡ Second Transcendance — the equipped Transcendent strikes a SECOND time,
    // same as solo attack.js. Damage-only echo inserted after the primary hit
    // and before the enemy retaliates; it never advances the turn counter and
    // adds no second retaliation. Routes through the withBossBattleState bridge
    // so a boss's nullify/halve/adapt still governs the 2nd hit, and credits the
    // echo's damage to this member's contribution like the primary hit does.
    if (e.hp > 0 && hasSecondTranscendance(player)) {
      const echo = rollEchoStrike(player, e)
      if (echo?.missed) {
        msg += `⚡ *SECOND TRANSCENDANCE* — *${player.name}*'s echo swings and *misses!*\n`
      } else if (echo) {
        let echoDmg = applyHighDefenseCatchup(player, e, applyDefense(echo.rawDmg, e.def))
        if (boss) {
          withBossBattleState(player, e, bp => {
            const echoTake = applyBossSpecial(bp, EVENT.ENEMY_TAKE_DAMAGE, {
              damage: echoDmg, element: 'physical', isCrit: echo.isCrit, isHit: true,
            })
            if (echoTake.modified && echoTake.damage !== undefined) echoDmg = echoTake.damage
            if (echoTake.narrativeLine) msg += `_${echoTake.narrativeLine}_\n`
          })
        }
        e.hp = Math.max(0, e.hp - echoDmg)
        battle.contributions[ctx.from] = (battle.contributions[ctx.from] ?? 0) + echoDmg
        msg += `⚡ *SECOND TRANSCENDANCE* — *${player.name}* moves again!${echo.isCrit ? ' ⚡ *CRIT!*' : ''}\n`
        msg += echoDmg > 0 ? `🩸 *${echoDmg}* damage!\n` : `🛡️ _The echo is absorbed — no damage._\n`
        msg += `❤️ ${e.name}: ${hpBar(e.hp, e.maxHp)}\n`
      }
      if (e.hp <= 0) {
        await ctx.reply(msg)
        await resolvePartyVictory(ctx, party)
        return player
      }
    }

    // A stunned or frozen enemy — most often one caught in a party member's
    // Unlimited Void — forfeits its retaliation entirely. enemyStatus was
    // ticked at the top of this turn, so the lock counts down one step per
    // party action and the enemy stays silent until it lifts.
    if (enemyStatus.incapacitated) {
      msg += `\n${e.emoji ?? '👾'} *${e.name}* is locked down and cannot act.`
      await sendBattleTurnReply(ctx, {
        player, e, msg: msg + `\n\n*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
        hpBeforeTurn: player.hp, eHpBeforeTurn, boss,
      })
      return player
    }

    // Enemy retaliates. On a boss floor, the boss's own named attack (via
    // buildEnemyAttack) always lands on the attacker — bosses in this engine
    // don't redirect their counter onto other party members. Regular enemies
    // keep the existing aggro-weighted random-target behaviour.
    if (boss) {
      const hpBeforeTurn = player.hp
      let bossAtk = null
      let dealResult = null
      withBossBattleState(player, e, bp => {
        bossAtk = buildEnemyAttack(bp)
        dealResult = applyBossSpecial(bp, EVENT.ENEMY_DEAL_DAMAGE, {
          damage: bossAtk.damage, isHit: true,
        })
      })
      if (!bossAtk) {
        const fb = plainBossStrike(e)   // plain boss: bridge above no-op'd
        bossAtk = fb.bossAtk
        dealResult = fb.dealResult
      }
      const rawBossAtk = dealResult.modified && dealResult.damage !== undefined
        ? dealResult.damage
        : bossAtk.damage

      const hitList = Array.isArray(dealResult.guaranteedHits) ? dealResult.guaranteedHits : null
      let totalPlayerDmg = 0

      if (hitList) {
        for (const rawHit of hitList) {
          // Gojo's Infinity thins each guaranteed hit as well; a no-op otherwise.
          const hDmg = applyInfinity(player, rawHit).damage
          player.hp = Math.max(0, player.hp - hDmg)
          totalPlayerDmg += hDmg
        }
        msg += `${e.emoji ?? '👾'} *${e.name}* unleashes *${bossAtk.attackName}*! _(${hitList.length} hits)_\n`
        msg += `🩸 *${totalPlayerDmg}* total damage! _(ignores DEF)_\n`
      } else {
        const primaryHit = bossAtk.bypassDefense
          ? rawBossAtk
          : calcMonsterDamage(rawBossAtk, player.stats.def, false)
        const sustain = applyPartyIncoming(player, primaryHit, cs)
        player.hp = Math.max(0, player.hp - sustain.damage)
        totalPlayerDmg = sustain.damage
        if (sustain.message) msg += sustain.message + '\n'

        if (bossAtk.doubleStrike) {
          const hit2 = bossAtk.bypassDefense
            ? rawBossAtk
            : calcMonsterDamage(rawBossAtk, player.stats.def, false)
          const sustain2 = applyPartyIncoming(player, hit2, cs)
          player.hp = Math.max(0, player.hp - sustain2.damage)
          totalPlayerDmg += sustain2.damage
          if (sustain2.message) msg += sustain2.message + '\n'
          msg += `${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*! ⚡ *DOUBLE STRIKE!*\n`
          msg += `🩸 *${totalPlayerDmg}* total damage!\n`
        } else {
          msg += `${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*!\n`
          msg += `🩸 *${totalPlayerDmg}* damage!${bossAtk.bypassDefense ? ' _(bypasses DEF)_' : ''}\n`
        }
      }

      if (bossAtk.narrativeLines?.length) msg += `_${bossAtk.narrativeLines[0]}_\n`
      if (dealResult.narrativeLine) msg += `_${dealResult.narrativeLine}_\n`

      let taunt = ''
      withBossBattleState(player, e, bp => { taunt = getBossTaunt(bp) })
      if (taunt) msg += `\n💬 _"${taunt}"_\n`
      msg += `❤️ ${player.name}: ${hpBar(player.hp, player.maxHp)}`

      await sendBattleTurnReply(ctx, {
        player, e, msg: msg + `\n\n*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
        hpBeforeTurn, eHpBeforeTurn, boss,
      })
      if (player.hp <= 0) await handlePartyMemberDown(ctx, party, ctx.from)
      return player
    }

    // Enemy retaliates against a random party member currently in battle,
    // weighted toward whoever has dealt the most damage (highest aggro).
    const combatants = party.members.filter(m => getPlayer(ctx.db, m)?.inBattle)
    const weights = combatants.map(m => 1 + (battle.contributions[m] ?? 0) / 10)
    const totalWeight = weights.reduce((a, b) => a + b, 0)
    let roll = Math.random() * totalWeight
    let targetJid = combatants[0]
    for (let i = 0; i < combatants.length; i++) {
      roll -= weights[i]
      if (roll <= 0) { targetJid = combatants[i]; break }
    }

    const hpBeforeTurn = player.hp
    if (targetJid === ctx.from) {
      // Simple case: resolve inline against the attacker.
      if (Math.random() > calcMonsterHitChance(e, player)) {
        msg += `\n${e.emoji ?? '👾'} *${e.name}* lunges at *${player.name}*... *MISSES!*`
        await sendBattleTurnReply(ctx, {
          player, e, msg: msg + `\n\n*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
          hpBeforeTurn, eHpBeforeTurn, boss,
        })
        return player
      }
      const dmg = calcMonsterDamage(e.atk, player.stats.def, false)
      const sustain = applyPartyIncoming(player, dmg, cs)
      player.hp = Math.max(0, player.hp - sustain.damage)
      if (sustain.message) msg += sustain.message + '\n'
      msg += `\n${e.emoji ?? '👾'} *${e.name}* strikes *${player.name}* for *${sustain.damage}* damage!\n`
      msg += `❤️ ${player.name}: ${hpBar(player.hp, player.maxHp)}`
      await sendBattleTurnReply(ctx, {
        player, e, msg: msg + `\n\n*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
        hpBeforeTurn, eHpBeforeTurn, boss,
      })
      if (player.hp <= 0) await handlePartyMemberDown(ctx, party, ctx.from)
      return player
    } else {
      // Target is a different party member — resolve their side out-of-band.
      const targetName = nameFor(ctx.db, targetJid)
      let hitMsg = ''
      await updatePlayer(ctx.db, targetJid, async target => {
        if (Math.random() > calcMonsterHitChance(e, target)) {
          hitMsg = `\n${e.emoji ?? '👾'} *${e.name}* lunges at *${targetName}*... *MISSES!*`
          return target
        }
        const dmg = calcMonsterDamage(e.atk, target.stats.def, false)
        // The TARGET's own per-battle character state, not the attacker's —
        // Mei's sustain counter belongs to whoever is being hit.
        const targetCs = battle.charState[targetJid] = battle.charState[targetJid] ?? {}
        const sustain = applyPartyIncoming(target, dmg, targetCs)
        target.hp = Math.max(0, target.hp - sustain.damage)
        if (sustain.message) hitMsg += sustain.message + '\n'
        hitMsg += `\n${e.emoji ?? '👾'} *${e.name}* strikes *${targetName}* for *${sustain.damage}* damage!\n❤️ ${targetName}: ${hpBar(target.hp, target.maxHp)}`
        return target
      })
      await sendBattleTurnReply(ctx, {
        player, e, msg: msg + hitMsg + `\n\n*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
        hpBeforeTurn, eHpBeforeTurn, boss,
      })
      const targetAfter = getPlayer(ctx.db, targetJid)
      if (targetAfter.hp <= 0) await handlePartyMemberDown(ctx, party, targetJid)
      return player
    }
  })
}

// ── Party battle: defend ──────────────────────────────────────────────────
async function battleDefend(ctx) {
  const p = config.prefix
  const party = findPartyForPlayer(ctx.db, ctx.from)
  if (!party) return ctx.reply(`❌ You're not in a party.`)
  if (!party.battle) return ctx.reply(`❌ Your party isn't in a battle.`)

  // Mutator only mutates and records the outcome — no network I/O (ctx.reply)
  // runs inside it. It executes on the shared global write queue (see
  // lib/player-repo.js's runExclusive); an awaited sendMessage call in here
  // would hold that queue open for the duration of a WhatsApp round-trip,
  // and if that round-trip ever hangs (e.g. mid-reconnect), every other
  // player's command stalls behind it indefinitely — the bot looks fully
  // dead (reacts ⚔️ but never replies) until the process is restarted.
  let outcome = null // 'miss' | { dmg, hp, maxHp, name, lines }
  let hpZero = false

  await updatePlayer(ctx.db, ctx.from, player => {
    const battle = party.battle
    const e = battle.enemy
    const boss = e.isBoss ?? false
    let lines = []

    // Per-member, once-per-battle character-ability state — stands in for
    // player.battleState, which party fights don't use. See the
    // party.battle.charState note in enterDungeon().
    battle.charState = battle.charState ?? {}
    const cs = battle.charState[ctx.from] = battle.charState[ctx.from] ?? {}

    if (boss) {
      // TURN_START + PLAYER_DEFEND — Aizen breaks hypnosis on defend, etc.
      // Mirrors solo defend.js's boss-engine hooks via the same bridge
      // battleAttack/battleCinderVerdict use.
      withBossBattleState(player, e, bp => {
        incrementBossTurn(bp)
        const tsResult = applyBossSpecial(bp, EVENT.TURN_START, {})
        if (tsResult.narrativeLine) lines.push(`_${tsResult.narrativeLine}_`)

        const defendResult = applyBossSpecial(bp, EVENT.PLAYER_DEFEND, {})
        if (defendResult.narrativeLine) lines.push(`_${defendResult.narrativeLine}_`)
        if (defendResult.removeEffect) {
          player.activeEffects = (player.activeEffects ?? []).filter(
            fx => fx.sourceId !== defendResult.removeEffect,
          )
        }
      })
    }

    if (boss) {
      let bossAtk = null
      let dealResult = null
      withBossBattleState(player, e, bp => {
        bossAtk = buildEnemyAttack(bp)
        dealResult = applyBossSpecial(bp, EVENT.ENEMY_DEAL_DAMAGE, { damage: bossAtk.damage, isHit: true })
      })
      if (!bossAtk) {
        const fb = plainBossStrike(e)   // plain boss: bridge above no-op'd
        bossAtk = fb.bossAtk
        dealResult = fb.dealResult
      }
      const rawBossAtk = dealResult.modified && dealResult.damage !== undefined
        ? dealResult.damage
        : bossAtk.damage

      const hitList = Array.isArray(dealResult.guaranteedHits) ? dealResult.guaranteedHits : null
      let totalPlayerDmg = 0

      if (hitList) {
        for (const rawHit of hitList) {
          // Gojo's Infinity thins each guaranteed hit as well; a no-op otherwise.
          const hDmg = applyInfinity(player, rawHit).damage
          player.hp = Math.max(0, player.hp - hDmg)
          totalPlayerDmg += hDmg
        }
        lines.push(`${e.emoji ?? '👾'} *${e.name}* unleashes *${bossAtk.attackName}*! _(${hitList.length} hits)_`)
        lines.push(`🩸 *${totalPlayerDmg}* total damage! _(ignores DEF)_`)
      } else {
        // Defending halves incoming damage (calcMonsterDamage's 3rd arg),
        // same as it does for regular enemies below.
        const primaryHit = bossAtk.bypassDefense
          ? rawBossAtk
          : calcMonsterDamage(rawBossAtk, player.stats.def, true)
        const sustain = applyPartyIncoming(player, primaryHit, cs)
        player.hp = Math.max(0, player.hp - sustain.damage)
        totalPlayerDmg = sustain.damage
        if (sustain.message) lines.push(sustain.message)

        if (bossAtk.doubleStrike) {
          const hit2 = bossAtk.bypassDefense
            ? rawBossAtk
            : calcMonsterDamage(rawBossAtk, player.stats.def, true)
          const sustain2 = applyPartyIncoming(player, hit2, cs)
          player.hp = Math.max(0, player.hp - sustain2.damage)
          totalPlayerDmg += sustain2.damage
          if (sustain2.message) lines.push(sustain2.message)
          lines.push(`${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*! ⚡ *DOUBLE STRIKE!*`)
          lines.push(`🩸 *${totalPlayerDmg}* total damage!`)
        } else {
          lines.push(`${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*!`)
          lines.push(`🩸 *${totalPlayerDmg}* damage!${bossAtk.bypassDefense ? ' _(bypasses DEF)_' : ''}`)
        }
      }

      if (bossAtk.narrativeLines?.length) lines.push(`_${bossAtk.narrativeLines[0]}_`)
      if (dealResult.narrativeLine) lines.push(`_${dealResult.narrativeLine}_`)

      let taunt = ''
      withBossBattleState(player, e, bp => { taunt = getBossTaunt(bp) })
      if (taunt) lines.push(`💬 _"${taunt}"_`)

      outcome = { dmg: totalPlayerDmg, hp: player.hp, maxHp: player.maxHp, name: player.name, lines }
      hpZero = player.hp <= 0
      return player
    }

    if (Math.random() > calcMonsterHitChance(e, player)) {
      outcome = 'miss'
      return player
    }
    const dmg = calcMonsterDamage(e.atk, player.stats.def, true)
    const sustain = applyPartyIncoming(player, dmg, cs)
    player.hp = Math.max(0, player.hp - sustain.damage)
    outcome = { dmg: sustain.damage, hp: player.hp, maxHp: player.maxHp, name: player.name, message: sustain.message }
    hpZero = player.hp <= 0
    return player
  })

  if (outcome === 'miss') {
    await ctx.reply(`🛡️ Braces for impact... the enemy *MISSES!*`)
  } else if (outcome.lines) {
    // Boss defend result — lines already carry the boss-engine narrative.
    await ctx.reply(
      `🛡️ *${outcome.name}* braces!\n` +
      outcome.lines.join('\n') + '\n' +
      `❤️ ${outcome.name}: ${hpBar(outcome.hp, outcome.maxHp)}\n\n` +
      `*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
    )
  } else {
    await ctx.reply(
      (outcome.message ?? '') +
      `🛡️ *${outcome.name}* braces and takes a reduced *${outcome.dmg}* damage!\n` +
      `❤️ ${outcome.name}: ${hpBar(outcome.hp, outcome.maxHp)}\n\n` +
      `*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
    )
  }
  if (hpZero) await handlePartyMemberDown(ctx, party, ctx.from)
}

// ── Party battle: flee ─────────────────────────────────────────────────────
// Same 35%+LCK escape chance and failed-flee damage as solo flee.js — a
// party fighter shouldn't get a strictly better (guaranteed, free) flee
// than a solo one just because they're in a party. Only real difference
// from solo: a successful flee here just pulls THIS member out (forfeiting
// their reward share) while the rest of the party keeps fighting, same as
// before — it doesn't end the whole party's battle unless everyone's gone.
async function battleFlee(ctx) {
  const p = config.prefix
  const party = findPartyForPlayer(ctx.db, ctx.from)
  if (!party) return ctx.reply(`❌ You're not in a party.`)
  if (!party.battle) return ctx.reply(`❌ Your party isn't in a battle.`)
  if (party.battle.enemy.isBoss) return ctx.reply(`⚠️ Can't flee a boss fight!`)

  const e = party.battle.enemy
  let hpZero = false

  await updatePlayer(ctx.db, ctx.from, async player => {
    const chance = 0.35 + (player.stats?.lck ?? 0) * 0.003
    if (Math.random() < chance) {
      player.inBattle = false
      await ctx.reply(`💨 *${player.name}* escapes the fight! _(forfeits any reward share)_`)

      const stillFighting = party.members.some(m => m !== ctx.from && getPlayer(ctx.db, m)?.inBattle)
      if (!stillFighting) {
        party.battle = null
        party.run = null
        await ctx.reply(`🏳️ Everyone has left the fight — the party retreats. _(Cleared floors are kept.)_`)
      }
      return player
    }

    const dmg = calcMonsterDamage(e.atk, player.stats.def, false)
    // Per-member character state (see enterDungeon's charState note) — the
    // parting blow on a failed escape can still spend a Mei sustain, so it
    // has to count against the same per-battle pool as everything else.
    party.battle.charState = party.battle.charState ?? {}
    const cs = party.battle.charState[ctx.from] = party.battle.charState[ctx.from] ?? {}
    const sustain = applyPartyIncoming(player, dmg, cs)
    player.hp = Math.max(0, player.hp - sustain.damage)
    hpZero = player.hp <= 0

    if (!hpZero) {
      await ctx.reply(
        (sustain.message ?? '') +
        `❌ *Escape failed!*\n${e.emoji ?? '👾'} *${e.name}* catches you!\n🩸 *${sustain.damage}* damage!\n\n` +
        `❤️ ${hpBar(player.hp, player.maxHp)}\n\n` +
        `*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
      )
    }
    return player
  })

  // Dying on a failed flee attempt routes through the same party-down
  // handler (respawn at half HP, pull from the fight, pearl-checkpoint
  // check) as a failed attack/defend — kept outside updatePlayer's mutator
  // since handlePartyMemberDown does its own updatePlayer call.
  if (hpZero) await handlePartyMemberDown(ctx, party, ctx.from)
}

// ── Party battle: Cinder Verdict (Wither) ───────────────────────────────────
// Wither's once-per-battle, no-MP ember sentence — the party-combat twin of
// plugins/cinderverdict.js. Same 8x damageMultiplier through the stock
// calcPlayerDamage() -> applyDefense() pipeline; the per-member witherUsed
// flag lives on party.battle.charState so it resets with the fight.
async function battleCinderVerdict(ctx) {
  const p = config.prefix
  const party = findPartyForPlayer(ctx.db, ctx.from)
  if (!party) return ctx.reply(`❌ You're not in a party.`)
  if (!party.battle) return ctx.reply(`❌ Your party isn't in a battle. Use *${p}dparty enter <dungeon>*.`)

  await updatePlayer(ctx.db, ctx.from, async player => {
    const battle = party.battle
    const e = battle.enemy
    const eHpBeforeTurn = e.hp
    const boss = e.isBoss ?? false

    battle.charState = battle.charState ?? {}
    const cs = battle.charState[ctx.from] = battle.charState[ctx.from] ?? {}

    const gate = activateCinderVerdict(player, cs)
    if (!gate.ok) {
      if (gate.message) await ctx.reply(gate.message)
      return player
    }

    let pre = ''
    const permaSeverLine = tickPermanentSever(player)
    if (permaSeverLine) pre += permaSeverLine + '\n'
    if (player.hp <= 0) {
      if (pre) await ctx.reply(pre)
      await handlePartyMemberDown(ctx, party, ctx.from)
      return player
    }

    let msg = pre +
      `🔥⚖️ *CINDER VERDICT*\n─────────────\n` +
      `_${player.name}'s Wither names *${e.name}*, and the name catches fire._\n\n`

    if (Math.random() > calcPlayerHitChance(player, e)) {
      msg += `💨 The sentence gutters out — *MISSED!*\n`
      await sendBattleTurnReply(ctx, {
        player, e, msg: msg + `\n*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
        hpBeforeTurn: player.hp, eHpBeforeTurn, boss,
      })
      return player
    }

    let { rawDmg, isCrit } = calcPlayerDamage(player, null, gate.multiplier)
    let finalDmg = applyHighDefenseCatchup(player, e, applyDefense(rawDmg, e.def))

    if (boss) {
      // Cinder Verdict counts as the player's attack for boss-special
      // purposes — same PLAYER_BASIC_ATTACK/ENEMY_TAKE_DAMAGE pair as a
      // regular hit, so Gojo/Mahoraga/Meliodas etc. still react correctly
      // when a boss is burned down with Wither's ember sentence.
      withBossBattleState(player, e, bp => {
        const basicResult = applyBossSpecial(bp, EVENT.PLAYER_BASIC_ATTACK, {
          damage: finalDmg, element: 'physical', isCrit, isHit: true,
        })
        if (basicResult.modified && basicResult.damage !== undefined) finalDmg = basicResult.damage
        if (basicResult.narrativeLine) msg += `_${basicResult.narrativeLine}_\n`

        const takeResult = applyBossSpecial(bp, EVENT.ENEMY_TAKE_DAMAGE, {
          damage: finalDmg, element: 'physical', isCrit, isHit: true,
        })
        if (takeResult.modified && takeResult.damage !== undefined) finalDmg = takeResult.damage
        if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`

        if (takeResult.reflectDamage) {
          player.hp = Math.max(0, player.hp - takeResult.reflectDamage)
          msg += `🔁 *Full Counter!* The sentence is reflected!\n🩸 *${takeResult.reflectDamage}* damage back at you!\n`
        }
      })
    }

    e.hp = Math.max(0, e.hp - finalDmg)
    battle.contributions[ctx.from] = (battle.contributions[ctx.from] ?? 0) + finalDmg

    msg += `🩸 *${finalDmg}* damage!${isCrit ? ' 💥 *CRITICAL!*' : ''}\n`
    msg += `❤️ ${e.name}: ${hpBar(e.hp, e.maxHp)}\n`

    if (player.hp <= 0) {
      await ctx.reply(msg)
      await handlePartyMemberDown(ctx, party, ctx.from)
      return player
    }

    if (e.hp <= 0) {
      await ctx.reply(msg)
      await resolvePartyVictory(ctx, party)
      return player
    }

    if (boss) {
      withBossBattleState(player, e, bp => {
        const hitResult = applyBossSpecial(bp, EVENT.PLAYER_HIT_ENEMY, {
          damage: finalDmg, isCrit, element: 'physical', isHit: true,
        })
        if (hitResult.narrativeLine) msg += `_${hitResult.narrativeLine}_\n`
        if (finalDmg > 0) msg += `💬 _"${getBossHitLine(bp)}"_\n`
      })

      if (e.hp <= 0) {
        await ctx.reply(msg)
        await resolvePartyVictory(ctx, party)
        return player
      }

      withBossBattleState(player, e, bp => {
        const phase = checkBossPhase(bp)
        if (phase?.triggered && phase.lines?.length) {
          msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.join('\n') + '\n'
        }
      })
    }

    if (e.hp <= 0) {
      await ctx.reply(msg)
      await resolvePartyVictory(ctx, party)
      return player
    }

    // Enemy retaliates against the caster (Cinder Verdict draws its attention).
    const hpBeforeTurn = player.hp
    if (boss) {
      let bossAtk = null
      let dealResult = null
      withBossBattleState(player, e, bp => {
        bossAtk = buildEnemyAttack(bp)
        dealResult = applyBossSpecial(bp, EVENT.ENEMY_DEAL_DAMAGE, {
          damage: bossAtk.damage, isHit: true,
        })
      })
      if (!bossAtk) {
        const fb = plainBossStrike(e)   // plain boss: bridge above no-op'd
        bossAtk = fb.bossAtk
        dealResult = fb.dealResult
      }
      const rawBossAtk = dealResult.modified && dealResult.damage !== undefined
        ? dealResult.damage
        : bossAtk.damage

      const hitList = Array.isArray(dealResult.guaranteedHits) ? dealResult.guaranteedHits : null
      let totalPlayerDmg = 0

      if (hitList) {
        for (const rawHit of hitList) {
          // Gojo's Infinity thins each guaranteed hit as well; a no-op otherwise.
          const hDmg = applyInfinity(player, rawHit).damage
          player.hp = Math.max(0, player.hp - hDmg)
          totalPlayerDmg += hDmg
        }
        msg += `\n${e.emoji ?? '👾'} *${e.name}* unleashes *${bossAtk.attackName}*! _(${hitList.length} hits)_\n`
        msg += `🩸 *${totalPlayerDmg}* total damage! _(ignores DEF)_\n`
      } else {
        const primaryHit = bossAtk.bypassDefense
          ? rawBossAtk
          : calcMonsterDamage(rawBossAtk, player.stats.def, false)
        const sustain = applyPartyIncoming(player, primaryHit, cs)
        player.hp = Math.max(0, player.hp - sustain.damage)
        totalPlayerDmg = sustain.damage
        if (sustain.message) msg += sustain.message + '\n'

        if (bossAtk.doubleStrike) {
          const hit2 = bossAtk.bypassDefense
            ? rawBossAtk
            : calcMonsterDamage(rawBossAtk, player.stats.def, false)
          const sustain2 = applyPartyIncoming(player, hit2, cs)
          player.hp = Math.max(0, player.hp - sustain2.damage)
          totalPlayerDmg += sustain2.damage
          if (sustain2.message) msg += sustain2.message + '\n'
          msg += `\n${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*! ⚡ *DOUBLE STRIKE!*\n`
          msg += `🩸 *${totalPlayerDmg}* total damage!\n`
        } else {
          msg += `\n${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*!\n`
          msg += `🩸 *${totalPlayerDmg}* damage!${bossAtk.bypassDefense ? ' _(bypasses DEF)_' : ''}\n`
        }
      }

      if (bossAtk.narrativeLines?.length) msg += `_${bossAtk.narrativeLines[0]}_\n`
      if (dealResult.narrativeLine) msg += `_${dealResult.narrativeLine}_\n`
      msg += `❤️ ${player.name}: ${hpBar(player.hp, player.maxHp)}`
    } else if (Math.random() > calcMonsterHitChance(e, player)) {
      msg += `\n${e.emoji ?? '👾'} *${e.name}* lashes back at *${player.name}*... *MISSES!*`
    } else {
      const dmg = calcMonsterDamage(e.atk, player.stats.def, false)
      const sustain = applyPartyIncoming(player, dmg, cs)
      player.hp = Math.max(0, player.hp - sustain.damage)
      if (sustain.message) msg += sustain.message + '\n'
      msg += `\n${e.emoji ?? '👾'} *${e.name}* strikes *${player.name}* for *${sustain.damage}* damage!\n`
      msg += `❤️ ${player.name}: ${hpBar(player.hp, player.maxHp)}`
    }

    await sendBattleTurnReply(ctx, {
      player, e, msg: msg + `\n\n*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
      hpBeforeTurn, eHpBeforeTurn, boss,
    })
    if (player.hp <= 0) await handlePartyMemberDown(ctx, party, ctx.from)
    return player
  })
}

// ── Party battle: Baryon Mode / Kurama (Naruto) ─────────────────────────────
// Naruto's once-per-battle Nine Tails summon — the party-combat twin of
// plugins/kurama.js. Same shape as battleCinderVerdict above: the strike runs
// through the stock calcPlayerDamage() -> applyDefense() -> applyHighDefenseCatchup()
// pipeline with the Baryon multiplier, and the per-member charge lives on
// party.battle.charState via activateKurama(player, cs), so it resets with the
// fight for free. Two things it adds on top: activateKurama also burns a slice of
// Naruto's OWN health (the Baryon self-cost, floored so it never downs him), and
// after the strike lands a lifespan-drain rider tears a flat share of the enemy's
// MAX HP as true damage no armour softens. The enemy then retaliates against the
// caster normally — there is no tangle, so this is a heavy finisher, not a lock.
async function battleKurama(ctx) {
  const p = config.prefix
  const party = findPartyForPlayer(ctx.db, ctx.from)
  if (!party) return ctx.reply(`❌ You're not in a party.`)
  if (!party.battle) return ctx.reply(`❌ Your party isn't in a battle. Use *${p}dparty enter <dungeon>*.`)

  await updatePlayer(ctx.db, ctx.from, async player => {
    const battle = party.battle
    const e = battle.enemy
    const eHpBeforeTurn = e.hp
    const boss = e.isBoss ?? false

    battle.charState = battle.charState ?? {}
    const cs = battle.charState[ctx.from] = battle.charState[ctx.from] ?? {}

    const gate = activateKurama(player, cs)
    if (!gate.ok) {
      if (gate.message) await ctx.reply(gate.message)
      return player
    }

    // Summon splash, its own message the moment the fusion commits, before the
    // party turn text. Never blocks the turn (media failure is swallowed).
    await sendKuramaSummonImage(ctx, `🦊🌀 *${player.name} tears the seal open. KURAMA answers.*`, ctx.from)

    let pre = ''
    const permaSeverLine = tickPermanentSever(player)
    if (permaSeverLine) pre += permaSeverLine + '\n'
    // The Baryon self-cost is already paid inside the gate; show it whether the
    // strike then lands or misses. A player the self-cost + a DoT downs is
    // handled by the hp check below, same as Cinder Verdict's permaSever tick.
    if (gate.selfCostLine) pre += gate.selfCostLine + '\n'
    if (player.hp <= 0) {
      if (pre) await ctx.reply(pre)
      await handlePartyMemberDown(ctx, party, ctx.from)
      return player
    }

    let msg = pre +
      `🦊🌀 *BARYON MODE: KURAMA*\n─────────────\n` +
      `💬 _"${narutoBattleLine('party')}"_\n` +
      `_${player.name} and the Nine Tails fold into one against *${e.name}*._\n\n`

    if (Math.random() > calcPlayerHitChance(player, e)) {
      msg += `💨 _The fusion overshoots by a hair and *MISSES!*_\n`
      await sendBattleTurnReply(ctx, {
        player, e, msg: msg + `\n*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
        hpBeforeTurn: player.hp, eHpBeforeTurn, boss,
      })
      return player
    }

    let { rawDmg, isCrit } = calcPlayerDamage(player, null, gate.multiplier)
    let finalDmg = applyHighDefenseCatchup(player, e, applyDefense(rawDmg, e.def))

    if (boss) {
      // The strike counts as the player's attack for boss-special purposes —
      // same PLAYER_BASIC_ATTACK/ENEMY_TAKE_DAMAGE pair as a regular hit, so a
      // boss can still nullify, adapt or reflect the STRIKE. The drain rider
      // below is true damage and deliberately bypasses this layer.
      withBossBattleState(player, e, bp => {
        const basicResult = applyBossSpecial(bp, EVENT.PLAYER_BASIC_ATTACK, {
          damage: finalDmg, element: 'physical', isCrit, isHit: true,
        })
        if (basicResult.modified && basicResult.damage !== undefined) finalDmg = basicResult.damage
        if (basicResult.narrativeLine) msg += `_${basicResult.narrativeLine}_\n`

        const takeResult = applyBossSpecial(bp, EVENT.ENEMY_TAKE_DAMAGE, {
          damage: finalDmg, element: 'physical', isCrit, isHit: true,
        })
        if (takeResult.modified && takeResult.damage !== undefined) finalDmg = takeResult.damage
        if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`

        if (takeResult.reflectDamage) {
          player.hp = Math.max(0, player.hp - takeResult.reflectDamage)
          msg += `🔁 *Full Counter!* The strike is reflected!\n🩸 *${takeResult.reflectDamage}* damage back at you!\n`
        }
      })
    }

    e.hp = Math.max(0, e.hp - finalDmg)
    battle.contributions[ctx.from] = (battle.contributions[ctx.from] ?? 0) + finalDmg
    msg += `🌠 *Baryon Rasengan* lands for *${finalDmg}*!${isCrit ? ' 💥 *CRITICAL!*' : ''}\n`

    // Lifespan drain rider — true damage, a flat share of the enemy's MAX HP,
    // no armour applies. Applied after the strike so the two together can finish
    // an enemy the strike alone left standing.
    const drainRes = resolveKuramaDrain(e, gate.drainPct)
    if (drainRes.drain > 0) {
      e.hp = drainRes.newHp
      battle.contributions[ctx.from] = (battle.contributions[ctx.from] ?? 0) + drainRes.drain
      msg += `🦊 _The fox's touch tears *${drainRes.drain}* more lifespan out of *${e.name}*, past any armour._\n`
    }
    msg += `❤️ ${e.name}: ${hpBar(e.hp, e.maxHp)}\n`

    if (player.hp <= 0) {
      await ctx.reply(msg)
      await handlePartyMemberDown(ctx, party, ctx.from)
      return player
    }

    if (e.hp <= 0) {
      await ctx.reply(msg)
      await resolvePartyVictory(ctx, party)
      return player
    }

    if (boss) {
      withBossBattleState(player, e, bp => {
        const hitResult = applyBossSpecial(bp, EVENT.PLAYER_HIT_ENEMY, {
          damage: finalDmg, isCrit, element: 'physical', isHit: true,
        })
        if (hitResult.narrativeLine) msg += `_${hitResult.narrativeLine}_\n`
        if (finalDmg > 0) msg += `💬 _"${getBossHitLine(bp)}"_\n`
      })

      if (e.hp <= 0) {
        await ctx.reply(msg)
        await resolvePartyVictory(ctx, party)
        return player
      }

      withBossBattleState(player, e, bp => {
        const phase = checkBossPhase(bp)
        if (phase?.triggered && phase.lines?.length) {
          msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.join('\n') + '\n'
        }
      })
    }

    if (e.hp <= 0) {
      await ctx.reply(msg)
      await resolvePartyVictory(ctx, party)
      return player
    }

    // Enemy retaliates against the caster (the summon draws its attention).
    const hpBeforeTurn = player.hp
    if (boss) {
      let bossAtk = null
      let dealResult = null
      withBossBattleState(player, e, bp => {
        bossAtk = buildEnemyAttack(bp)
        dealResult = applyBossSpecial(bp, EVENT.ENEMY_DEAL_DAMAGE, {
          damage: bossAtk.damage, isHit: true,
        })
      })
      if (!bossAtk) {
        const fb = plainBossStrike(e)   // plain boss: bridge above no-op'd
        bossAtk = fb.bossAtk
        dealResult = fb.dealResult
      }
      const rawBossAtk = dealResult.modified && dealResult.damage !== undefined
        ? dealResult.damage
        : bossAtk.damage

      const hitList = Array.isArray(dealResult.guaranteedHits) ? dealResult.guaranteedHits : null
      let totalPlayerDmg = 0

      if (hitList) {
        for (const rawHit of hitList) {
          const hDmg = applyInfinity(player, rawHit).damage
          player.hp = Math.max(0, player.hp - hDmg)
          totalPlayerDmg += hDmg
        }
        msg += `\n${e.emoji ?? '👾'} *${e.name}* unleashes *${bossAtk.attackName}*! _(${hitList.length} hits)_\n`
        msg += `🩸 *${totalPlayerDmg}* total damage! _(ignores DEF)_\n`
      } else {
        const primaryHit = bossAtk.bypassDefense
          ? rawBossAtk
          : calcMonsterDamage(rawBossAtk, player.stats.def, false)
        const sustain = applyPartyIncoming(player, primaryHit, cs)
        player.hp = Math.max(0, player.hp - sustain.damage)
        totalPlayerDmg = sustain.damage
        if (sustain.message) msg += sustain.message + '\n'

        if (bossAtk.doubleStrike) {
          const hit2 = bossAtk.bypassDefense
            ? rawBossAtk
            : calcMonsterDamage(rawBossAtk, player.stats.def, false)
          const sustain2 = applyPartyIncoming(player, hit2, cs)
          player.hp = Math.max(0, player.hp - sustain2.damage)
          totalPlayerDmg += sustain2.damage
          if (sustain2.message) msg += sustain2.message + '\n'
          msg += `\n${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*! ⚡ *DOUBLE STRIKE!*\n`
          msg += `🩸 *${totalPlayerDmg}* total damage!\n`
        } else {
          msg += `\n${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*!\n`
          msg += `🩸 *${totalPlayerDmg}* damage!${bossAtk.bypassDefense ? ' _(bypasses DEF)_' : ''}\n`
        }
      }

      if (bossAtk.narrativeLines?.length) msg += `_${bossAtk.narrativeLines[0]}_\n`
      if (dealResult.narrativeLine) msg += `_${dealResult.narrativeLine}_\n`
      msg += `❤️ ${player.name}: ${hpBar(player.hp, player.maxHp)}`
    } else if (Math.random() > calcMonsterHitChance(e, player)) {
      msg += `\n${e.emoji ?? '👾'} *${e.name}* lashes back at *${player.name}*... *MISSES!*`
    } else {
      const dmg = calcMonsterDamage(e.atk, player.stats.def, false)
      const sustain = applyPartyIncoming(player, dmg, cs)
      player.hp = Math.max(0, player.hp - sustain.damage)
      if (sustain.message) msg += sustain.message + '\n'
      msg += `\n${e.emoji ?? '👾'} *${e.name}* strikes *${player.name}* for *${sustain.damage}* damage!\n`
      msg += `❤️ ${player.name}: ${hpBar(player.hp, player.maxHp)}`
    }

    await sendBattleTurnReply(ctx, {
      player, e, msg: msg + `\n\n*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
      hpBeforeTurn, eHpBeforeTurn, boss,
    })
    if (player.hp <= 0) await handlePartyMemberDown(ctx, party, ctx.from)
    return player
  })
}

// ── Party battle: Hollow Purple (Gojo) ──────────────────────────────────────
// Gojo's once-per-battle, no-MP imaginary-mass burst — the party-combat twin of
// plugins/purple.js. Same shape as battleCinderVerdict above, with the two
// differences Hollow Purple always carries: it NEVER MISSES (no accuracy roll)
// and no armour softens it (the multiplier is applied RAW, without applyDefense
// / applyHighDefenseCatchup). A boss can still nullify, adapt or reflect it
// through its ENEMY_TAKE_DAMAGE special — the same defensive layer every hit
// passes. The per-member charge lives on party.battle.charState via
// activateHollowPurple(player, cs), so it resets with the fight for free.
async function battleHollowPurple(ctx) {
  const p = config.prefix
  const party = findPartyForPlayer(ctx.db, ctx.from)
  if (!party) return ctx.reply(`❌ You're not in a party.`)
  if (!party.battle) return ctx.reply(`❌ Your party isn't in a battle. Use *${p}dparty enter <dungeon>*.`)

  await updatePlayer(ctx.db, ctx.from, async player => {
    const battle = party.battle
    const e = battle.enemy
    const eHpBeforeTurn = e.hp
    const boss = e.isBoss ?? false

    battle.charState = battle.charState ?? {}
    const cs = battle.charState[ctx.from] = battle.charState[ctx.from] ?? {}

    const gate = activateHollowPurple(player, cs)
    if (!gate.ok) {
      if (gate.message) await ctx.reply(gate.message)
      return player
    }

    let pre = ''
    const permaSeverLine = tickPermanentSever(player)
    if (permaSeverLine) pre += permaSeverLine + '\n'
    if (player.hp <= 0) {
      if (pre) await ctx.reply(pre)
      await handlePartyMemberDown(ctx, party, ctx.from)
      return player
    }

    let msg = pre +
      `🟦🟥 *HOLLOW PURPLE*\n─────────────\n` +
      `_Blue draws *${e.name}* in. Red throws them out. *${player.name}* brings both hands together, and the two become one._\n\n`

    // No accuracy roll — Hollow Purple always lands. Multiplier from the stock
    // roll, applied RAW: no applyDefense(), so armour is meaningless here.
    let { rawDmg, isCrit } = calcPlayerDamage(player, null, gate.multiplier)
    let finalDmg = Math.max(1, Math.round(rawDmg))

    if (boss) {
      withBossBattleState(player, e, bp => {
        const basicResult = applyBossSpecial(bp, EVENT.PLAYER_BASIC_ATTACK, {
          damage: finalDmg, element: 'physical', isCrit, isHit: true,
        })
        if (basicResult.modified && basicResult.damage !== undefined) finalDmg = basicResult.damage
        if (basicResult.narrativeLine) msg += `_${basicResult.narrativeLine}_\n`

        const takeResult = applyBossSpecial(bp, EVENT.ENEMY_TAKE_DAMAGE, {
          damage: finalDmg, element: 'physical', isCrit, isHit: true,
        })
        if (takeResult.modified && takeResult.damage !== undefined) finalDmg = takeResult.damage
        if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`

        if (takeResult.reflectDamage) {
          player.hp = Math.max(0, player.hp - takeResult.reflectDamage)
          msg += `🔁 *Full Counter!* The burst is reflected!\n🩸 *${takeResult.reflectDamage}* damage back at you!\n`
        }
      })
    }

    e.hp = Math.max(0, e.hp - finalDmg)
    battle.contributions[ctx.from] = (battle.contributions[ctx.from] ?? 0) + finalDmg

    msg += `🟪 *${finalDmg}* damage! _(ignores DEF)_${isCrit ? ' 💥 *CRITICAL!*' : ''}\n`
    msg += `_Everything in the line simply stops being there._\n`
    msg += `❤️ ${e.name}: ${hpBar(e.hp, e.maxHp)}\n`

    if (player.hp <= 0) {
      await ctx.reply(msg)
      await handlePartyMemberDown(ctx, party, ctx.from)
      return player
    }
    if (e.hp <= 0) {
      await ctx.reply(msg)
      await resolvePartyVictory(ctx, party)
      return player
    }

    if (boss) {
      withBossBattleState(player, e, bp => {
        const hitResult = applyBossSpecial(bp, EVENT.PLAYER_HIT_ENEMY, {
          damage: finalDmg, isCrit, element: 'physical', isHit: true,
        })
        if (hitResult.narrativeLine) msg += `_${hitResult.narrativeLine}_\n`
        if (finalDmg > 0) msg += `💬 _"${getBossHitLine(bp)}"_\n`
      })
      if (e.hp <= 0) {
        await ctx.reply(msg)
        await resolvePartyVictory(ctx, party)
        return player
      }
      withBossBattleState(player, e, bp => {
        const phase = checkBossPhase(bp)
        if (phase?.triggered && phase.lines?.length) {
          msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.join('\n') + '\n'
        }
      })
      if (e.hp <= 0) {
        await ctx.reply(msg)
        await resolvePartyVictory(ctx, party)
        return player
      }
    }

    // Enemy retaliates against the caster. Tick its statuses first: a boss
    // caught in Unlimited Void is still locked, so it forfeits the counter,
    // and the lock counts down one step here too.
    const enemyStatus = processStatusTurn(e)
    if (enemyStatus.lines.length) msg += enemyStatus.lines.join('\n') + '\n'
    if (e.hp <= 0) {
      await ctx.reply(msg)
      await resolvePartyVictory(ctx, party)
      return player
    }

    const hpBeforeTurn = player.hp
    if (enemyStatus.incapacitated) {
      msg += `\n${e.emoji ?? '👾'} *${e.name}* is locked down and cannot act.`
    } else if (boss) {
      let bossAtk = null
      let dealResult = null
      withBossBattleState(player, e, bp => {
        bossAtk = buildEnemyAttack(bp)
        dealResult = applyBossSpecial(bp, EVENT.ENEMY_DEAL_DAMAGE, {
          damage: bossAtk.damage, isHit: true,
        })
      })
      if (!bossAtk) {
        const fb = plainBossStrike(e)   // plain boss: bridge above no-op'd
        bossAtk = fb.bossAtk
        dealResult = fb.dealResult
      }
      const rawBossAtk = dealResult.modified && dealResult.damage !== undefined
        ? dealResult.damage
        : bossAtk.damage

      const hitList = Array.isArray(dealResult.guaranteedHits) ? dealResult.guaranteedHits : null
      let totalPlayerDmg = 0

      if (hitList) {
        for (const rawHit of hitList) {
          // Gojo's Infinity thins each guaranteed hit as well; a no-op otherwise.
          const hDmg = applyInfinity(player, rawHit).damage
          player.hp = Math.max(0, player.hp - hDmg)
          totalPlayerDmg += hDmg
        }
        msg += `\n${e.emoji ?? '👾'} *${e.name}* unleashes *${bossAtk.attackName}*! _(${hitList.length} hits)_\n`
        msg += `🩸 *${totalPlayerDmg}* total damage! _(ignores DEF)_\n`
      } else {
        const primaryHit = bossAtk.bypassDefense
          ? rawBossAtk
          : calcMonsterDamage(rawBossAtk, player.stats.def, false)
        const sustain = applyPartyIncoming(player, primaryHit, cs)
        player.hp = Math.max(0, player.hp - sustain.damage)
        totalPlayerDmg = sustain.damage
        if (sustain.message) msg += sustain.message + '\n'

        if (bossAtk.doubleStrike) {
          const hit2 = bossAtk.bypassDefense
            ? rawBossAtk
            : calcMonsterDamage(rawBossAtk, player.stats.def, false)
          const sustain2 = applyPartyIncoming(player, hit2, cs)
          player.hp = Math.max(0, player.hp - sustain2.damage)
          totalPlayerDmg += sustain2.damage
          if (sustain2.message) msg += sustain2.message + '\n'
          msg += `\n${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*! ⚡ *DOUBLE STRIKE!*\n`
          msg += `🩸 *${totalPlayerDmg}* total damage!\n`
        } else {
          msg += `\n${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*!\n`
          msg += `🩸 *${totalPlayerDmg}* damage!${bossAtk.bypassDefense ? ' _(bypasses DEF)_' : ''}\n`
        }
      }

      if (bossAtk.narrativeLines?.length) msg += `_${bossAtk.narrativeLines[0]}_\n`
      if (dealResult.narrativeLine) msg += `_${dealResult.narrativeLine}_\n`
      msg += `❤️ ${player.name}: ${hpBar(player.hp, player.maxHp)}`
    } else if (Math.random() > calcMonsterHitChance(e, player)) {
      msg += `\n${e.emoji ?? '👾'} *${e.name}* lashes back at *${player.name}*... *MISSES!*`
    } else {
      const dmg = calcMonsterDamage(e.atk, player.stats.def, false)
      const sustain = applyPartyIncoming(player, dmg, cs)
      player.hp = Math.max(0, player.hp - sustain.damage)
      if (sustain.message) msg += sustain.message + '\n'
      msg += `\n${e.emoji ?? '👾'} *${e.name}* strikes *${player.name}* for *${sustain.damage}* damage!\n`
      msg += `❤️ ${player.name}: ${hpBar(player.hp, player.maxHp)}`
    }

    await sendBattleTurnReply(ctx, {
      player, e, msg: msg + `\n\n*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
      hpBeforeTurn, eHpBeforeTurn, boss,
    })
    if (player.hp <= 0) await handlePartyMemberDown(ctx, party, ctx.from)
    return player
  })
}

// ── Party battle: Unlimited Void (Gojo) ─────────────────────────────────────
// Gojo's once-per-battle, no-MP Domain Expansion — the party-combat twin of
// plugins/domain.js. Deals NO damage: it is pure control. Opening the domain
// floods the enemy and applies a hard 'stun' for UNLIMITED_VOID_STUN_TURNS, and
// the void spends the enemy's action so there is no counter on the turn it
// opens. The lockdown then plays out across the party's following turns — every
// .dparty attack (and .dparty hollowpurple) ticks the enemy's statuses, so the
// stun counts down one step per party action and the enemy stays silent until
// it lifts. Charge latched on party.battle.charState via
// activateUnlimitedVoid(player, cs).
async function battleUnlimitedVoid(ctx) {
  const p = config.prefix
  const party = findPartyForPlayer(ctx.db, ctx.from)
  if (!party) return ctx.reply(`❌ You're not in a party.`)
  if (!party.battle) return ctx.reply(`❌ Your party isn't in a battle. Use *${p}dparty enter <dungeon>*.`)

  await updatePlayer(ctx.db, ctx.from, async player => {
    const battle = party.battle
    const e = battle.enemy
    const eHpBeforeTurn = e.hp
    const boss = e.isBoss ?? false

    battle.charState = battle.charState ?? {}
    const cs = battle.charState[ctx.from] = battle.charState[ctx.from] ?? {}

    const gate = activateUnlimitedVoid(player, cs)
    if (!gate.ok) {
      if (gate.message) await ctx.reply(gate.message)
      return player
    }

    let msg = ''
    const permaSeverLine = tickPermanentSever(player)
    if (permaSeverLine) msg += permaSeverLine + '\n'
    if (player.hp <= 0) {
      if (msg) await ctx.reply(msg)
      await handlePartyMemberDown(ctx, party, ctx.from)
      return player
    }

    msg +=
      `🌌 *DOMAIN EXPANSION*\n─────────────\n` +
      `_"Unlimited Void." The world falls away, and *${e.name}* is handed every thought at once._\n\n`

    // Flood the enemy with the domain's infinite information: a hard stun. If
    // the enemy is itself status-immune, addStatusEffect no-sells it and the
    // void finds nothing to fill.
    const res = addStatusEffect(e, {
      type: 'stun',
      duration: UNLIMITED_VOID_STUN_TURNS,
      sourceId: 'unlimited_void',
    })
    if (res?.immune) {
      msg += `⭕ _There is nothing in ${e.name} to flood. The void closes on emptiness._\n`
    } else {
      msg += `🕳️ _Infinite information pours in. ${e.name} cannot move, cannot think, cannot act._\n`
      msg += `💤 _Locked down for the next *${UNLIMITED_VOID_STUN_TURNS}* turns._\n`

      if (boss) {
        // Report the domain to the boss engine as a landed, damage-less hit so
        // phase logic that watches for the player acting still ticks.
        withBossBattleState(player, e, bp => {
          const takeResult = applyBossSpecial(bp, EVENT.ENEMY_TAKE_DAMAGE, {
            damage: 0, isCrit: false, isHit: true,
          })
          if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`
          const phase = checkBossPhase(bp)
          if (phase?.triggered && phase.lines?.length) {
            msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.join('\n') + '\n'
          }
        })
      }
    }

    // No counter on the turn the domain opens — the void spends the enemy's
    // action for it, same as the solo domain.
    msg += `\n❤️ ${player.name}: ${hpBar(player.hp, player.maxHp)}`

    await sendBattleTurnReply(ctx, {
      player, e, msg: msg + `\n\n*${p}dparty attack* · *${p}dparty defend* · *${p}dparty flee*`,
      hpBeforeTurn: player.hp, eHpBeforeTurn, boss,
    })
    return player
  })
}

async function handlePartyMemberDown(ctx, party, jid) {
  await updatePlayer(ctx.db, jid, async player => {
    // Ender Pearl checkpoint is checked before the normal party-down
    // penalty, same as every other lethal-hit site — see
    // lib/combat-handlers.js's checkPearlSave().
    const pearlMsg = checkPearlSave(player)
    if (pearlMsg) {
      const name = player.name
      ctx.sock.sendMessage(ctx.sender, {
        text: `💀 *${name} has fallen!*${pearlMsg}`,
      }).catch(() => {})
      return player
    }

    player.hp = Math.floor(player.maxHp * 0.5)
    player.inBattle = false
    const name = player.name
    ctx.sock.sendMessage(ctx.sender, {
      text: `💀 *${name} has fallen!* Respawned with half HP and pulled from the fight.`,
    }).catch(() => {})
    return player
  })

  const stillFighting = party.members.some(m => getPlayer(ctx.db, m)?.inBattle)
  if (!stillFighting) {
    const wipedFloor = party.run?.floor
    party.battle = null
    party.run = null
    await ctx.reply(
      `☠️ *The whole party has been wiped out!* The climb ends.` +
      (wipedFloor ? `\n📍 _Floors you already cleared are saved — start a fresh run to pick the climb back up._` : ''),
    )
  }
}

async function resolvePartyVictory(ctx, party) {
  const p = config.prefix
  const battle = party.battle
  const season = getActiveSeason(ctx.db)
  const enemy = battle.enemy
  const locId = battle.locationId
  const clearedFloor = battle.floor
  const loc = locationsMap[locId]
  const totalFloors = loc?.floors ?? 0
  const isFinalFloor = totalFloors > 0 && clearedFloor >= totalFloors
  const contributions = battle.contributions
  const totalDmg = Object.values(contributions).reduce((a, b) => a + b, 0) || 1

  const xpTotal = enemy.xp ?? enemy.rewards?.xp ?? 0
  const solarsTotal = enemy.solars ?? enemy.rewards?.solars ?? 0
  const dropped = rollDrops(enemy.drops ?? [])

  // Members still standing at the kill (inBattle) bank this floor toward their
  // SOLO progress; participants (dealt damage) get the XP/Solars split. A
  // member is almost always both — but a fled/downed member banks nothing
  // further, and a present non-attacker still banks the floor they survived.
  const presentMembers = party.members.filter(m => getPlayer(ctx.db, m)?.inBattle)
  const participants = Object.keys(contributions)
  const relevant = [...new Set([...participants, ...presentMembers])]

  let rewardLines = []
  let seasonLines = []

  for (const jid of relevant) {
    const isParticipant = contributions[jid] != null
    const isPresent = presentMembers.includes(jid)
    const share = isParticipant ? contributions[jid] / totalDmg : 0
    const xpShare = isParticipant ? Math.max(1, Math.round(xpTotal * share)) : 0
    const solarsShare = isParticipant ? Math.max(1, Math.round(solarsTotal * share)) : 0

    await updatePlayer(ctx.db, jid, async player => {
      if (isParticipant) {
        player.xp = (player.xp ?? 0) + xpShare
        player.wallet = player.wallet ?? {}
        player.wallet.solars = (player.wallet.solars ?? 0) + solarsShare

        // Level-ups — the piece co-op fights never had. Same call solo
        // victories use (lib/combat-handlers.js handleVictory), so climbing
        // actually grows characters. applyLevelUps full-heals on each level.
        const { msgs: lvlMsgs } = applyLevelUps(player, levelsData, classes, races, getTotalStats)
        const newSkills = getNewlyUnlockedSkills(player, allSkills)
        for (const s of newSkills) player.skills.push(s.id)

        let line = `  ${nameFor(ctx.db, jid)}: +${xpShare} XP, +${solarsShare} ☀️ _(${Math.round(share * 100)}% dmg)_`
        if (lvlMsgs.length) line += `  · 🎉 *Lv ${player.level}!*`
        if (newSkills.length) line += `\n     ✨ Skill: ${newSkills.map(s => s.name).join(', ')}`
        rewardLines.push(line)
      }

      if (isPresent) {
        // Bank the cleared floor into cross-mode solo progress — the source of
        // truth handleEnter reads to resume (dungeon.js). Gated carry: because
        // the run started at the lowest member's checkpoint, nobody banks a
        // floor they weren't actually present for.
        if (!player.dungeonProgress) player.dungeonProgress = {}
        const prog = player.dungeonProgress[locId] ?? { highestFloor: 0, conquered: false }
        prog.highestFloor = Math.max(prog.highestFloor ?? 0, clearedFloor)
        if (isFinalFloor && !prog.conquered) {
          prog.conquered = true
          // Same convention as solo (combat-handlers.js): only if untitled.
          if (enemy.conquestTitle && !player.title) player.title = enemy.conquestTitle
        }
        player.dungeonProgress[locId] = prog

        if (season && locId === season.dungeon && clearedFloor >= (season.partyBossFloor ?? locationsMap[locId]?.floors ?? 100)) {
          // Season End boss keeps its own reward hook (unchanged behaviour).
          const result = applySeasonLevel(player, season, 1)
          player.seasonProgress.currentFloor = clearedFloor + 1
          seasonLines.push(
            `  ${nameFor(ctx.db, jid)}: 🌙 Season Level ${result.seasonLevel}` +
            (result.tieredUp > 0
              ? ` · 🎫 Tier ${result.tier}!`
              : ` · 🎫 Tier ${result.tier} (${(result.progress?.toNext ?? 0).toLocaleString()} XP to next)`),
          )
        } else if (!isFinalFloor) {
          // Small between-floor recovery on a regular floor — same 8% as solo.
          player.hp = Math.min(player.maxHp, player.hp + Math.floor(player.maxHp * 0.08))
          player.mp = Math.min(player.maxMp, player.mp + Math.floor(player.maxMp * 0.08))
        }
      }
      return player
    })
  }

  // Drops go to a random participant. Combat loot — a full inventory shouldn't
  // block the victory message, so grant what fits and note any losses.
  let dropMsg = ''
  if (dropped.length && participants.length) {
    const winner = participants[Math.floor(Math.random() * participants.length)]
    let granted = []
    let lost = []
    await updatePlayer(ctx.db, winner, async player => {
      for (const id of dropped) {
        if (hasInventoryRoom(player, 1)) {
          player.inventory.push(id)
          granted.push(id)
        } else {
          lost.push(id)
        }
      }
      return player
    })
    if (granted.length) {
      dropMsg = `\n🎁 *Drop:* ${granted.map(id => allItems.find(i => i.id === id)?.name ?? id).join(', ')} → ${nameFor(ctx.db, winner)}`
    }
    if (lost.length) {
      dropMsg += `\n⚠️ *${nameFor(ctx.db, winner)}'s inventory was full — lost:* ${lost.map(id => allItems.find(i => i.id === id)?.name ?? id).join(', ')}`
    }
  }

  // Free everyone from the fight, then advance the cursor or end the climb.
  for (const jid of party.members) {
    const member = getPlayer(ctx.db, jid)
    if (member?.inBattle) await updatePlayer(ctx.db, jid, async pl => { pl.inBattle = false; return pl })
  }
  party.battle = null

  let conquestMsg = ''
  if (isFinalFloor) {
    party.run = null
    conquestMsg =
      `\n\n🏆 *${(loc?.name ?? locId).toUpperCase()} CONQUERED!*\n` +
      (enemy.conquestTitle ? `🎖️ Title earned: *"${enemy.conquestTitle}"*\n` : '') +
      `_Everyone who stood at the end has the next dungeon unlocked._`
  } else if (party.run) {
    party.run.floor = clearedFloor + 1
  }

  let msg = `┌─────────────────────┐\n│   ✅ *FLOOR ${clearedFloor} CLEARED!*   │\n└─────────────────────┘\n\n`
  msg += `${enemy.emoji ?? '👾'} *${enemy.name}* defeated by the party!\n\n`
  msg += `📊 *Rewards (by damage share):*\n${rewardLines.join('\n')}`
  if (seasonLines.length) msg += `\n\n🌙 *Season progress:*\n${seasonLines.join('\n')}`
  msg += dropMsg
  msg += conquestMsg
  if (!isFinalFloor && party.run) {
    msg += `\n\n⬇️ _Leader: *${p}dparty next* to descend to Floor ${party.run.floor}._`
  }
  await ctx.reply(msg)
}

// ── Plugin export ─────────────────────────────────────────────────────────
// Registered as `.dparty` (dungeon party) — NOT `.party`, which is owned by
// plugins/pokemon.js (the Pokémon battle party). Both plugins used to export
// name:'party'; alphabetical load order let pokemon.js overwrite this one in
// the registry, so the co-op dungeon party had no reachable command. Renaming
// this to `.dparty` (+ aliases) gives it its own keys and leaves the Pokémon
// party untouched.
export default {
  name: 'dparty',
  aliases: ['dungeonparty', 'dp', 'coop'],
  category: 'party',
  requiresPlayer: true,
  description: 'Form a dungeon party and climb a dungeon together, floor by floor',

  async run(ctx) {
    const sub = ctx.args[0]?.toLowerCase()
    const p = config.prefix

    switch (sub) {
      case 'create':  return createParty(ctx)
      case 'invite':  return invite(ctx, ctx.args[1])
      case 'accept':  return respondInvite(ctx, true)
      case 'decline': return respondInvite(ctx, false)
      case 'leave':   return leave(ctx)
      case 'kick':    return kick(ctx, ctx.args[1])
      case 'disband': return disband(ctx)
      case 'enter':   return enterDungeon(ctx, ctx.args[1])
      case 'next':    case 'descend': case 'n': return handleNext(ctx)
      case 'attack':  case 'atk': return battleAttack(ctx)
      case 'cinderverdict': case 'cinder': case 'cv': case 'verdict':
        return battleCinderVerdict(ctx)
      case 'kurama': case 'baryon': case 'ninetails': case 'krm':
        return battleKurama(ctx)
      case 'hollowpurple': case 'purple': case 'hollow-purple':
        return battleHollowPurple(ctx)
      case 'unlimitedvoid': case 'void': case 'unlimited-void':
        return battleUnlimitedVoid(ctx)
      case 'defend':  return battleDefend(ctx)
      case 'flee':    return battleFlee(ctx)
      default:        return showStatus(ctx)
    }
  },
}

// Exported so plugins/pattack.js can offer shorter top-level aliases.
export { battleAttack, battleDefend, battleFlee, battleCinderVerdict, battleKurama, battleHollowPurple, battleUnlimitedVoid }
