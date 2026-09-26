import { isBattleCinematicActive } from '../lib/battle-presentation.js'
/**
 * pvp.js — player-vs-player duels.
 *
 * Reuses the exact same damage/hit-chance/effects math PvE combat uses
 * (lib/combat-engine.js, lib/effects.js) — no forked formulas. It does NOT
 * reuse lib/combat-handlers.js's handleDeath/handleVictory (those are
 * PvE-specific: gear strip, dungeon floor advance, fame, drops) — PvP has
 * its own resolution (pvpConclude below): 5% of the loser's wallet.solars
 * ONLY (never gems/vault) moves to the winner, both players are fully
 * healed, and no gear is lost either way.
 *
 * TURN MODEL: unlike PvE (where the enemy's counter-attack resolves
 * automatically within the same command), PvP alternates between two real
 * players, so each `.pvp attack|skill|ability|defend` command resolves exactly one
 * player's turn, then flips a `myTurn` flag stored on both players'
 * battleState so the next command from the WRONG player is rejected
 * ("wrong-turn move"). The challenger acts first.
 *
 * STATE: a pending challenge lives on the target's own record as
 * `player.pvpChallenge = { fromJid, expiresAt }` (no shared collection
 * needed — mirrors rob.js's nested-updatePlayer, two-party-mutation
 * pattern rather than lib/guild-repo.js's shared-store pattern, since a
 * duel is inherently a 1:1 relationship with no server-wide lookup need).
 * Once accepted, both players get `player.battleState = { type: 'pvp', ... }`
 * and `player.inBattle = true`, reusing the same fields PvE combat uses so
 * profile.js's "in battle" indicator keeps working unmodified. attack.js/
 * skill.js/defend.js explicitly refuse to run against a `type: 'pvp'`
 * battleState and point the player at these commands instead.
 *
 * Usage:
 *   <prefix>pvp on|off       — group admins: enable/disable PvP in this group
 *   <prefix>pvp @target       — challenge (reply or @mention)
 *   <prefix>pvp accept        — accept a pending challenge against you
 *   <prefix>pvp decline       — decline a pending challenge against you
 *   <prefix>pvp moves          — every move you can make this turn + a hint
 *   <prefix>pvp status         — the board, without spending a turn
 *   <prefix>pvp attack         — basic attack (your turn only)
 *   <prefix>pvp skill <name>   — skill attack (your turn only)
 *   <prefix>pvp ability <name> — use an equipped active ability (your turn only)
 *   <prefix>pvp wildcard      — Circe's Wild Card: draw one of six fates (3/battle)
 *   <prefix>pvp defend         — defensive stance, +MP, halves incoming dmg
 *   <prefix>pvp rematch        — re-challenge your last opponent
 *   <prefix>pvp claim          — take the win when an opponent has stalled out
 *   <prefix>pvp forfeit        — concede the current match
 *
 * HELPERS live in lib/pvp-engine.js — the Elo ladder, the move list, the
 * scouting math behind plugins/scout.js, and the stall timeout. None of them
 * feed back into damage: lib/combat-engine.js stays the single source of
 * truth for how hard a hit lands. Guild perks (lib/guild-engine.js) are the
 * same — spoilsPct changes the payout and duelSlots the frequency, never the
 * numbers traded in the loop.
 *
 * DAILY LIMIT: challenging costs one of the CHALLENGER's daily duel slots
 * (FREE_DAILY_PVP_LIMIT free / PREMIUM_DAILY_PVP_LIMIT premium — see
 * lib/premium.js's isPremiumActive()). Charged only at the *challenge*
 * step (not accept/attack/etc.), same "gate at the point of the action"
 * pattern daily.js uses, and only once the challenge is confirmed
 * possible (target valid, not already mid-battle/dungeon/challenged) so a
 * doomed challenge never burns a slot. The count resets on a new calendar
 * day via startOfDay(), mirroring daily.js's own streak-reset logic — no
 * separate cron/sweep needed. Being challenged (defending) never costs a
 * slot, only initiating one does.
 */
import { config } from '../config.js'
import { tickShunShunRikka } from '../lib/orihime.js'
import { sendRankUp } from '../lib/rank-up.js'
import { sendBattleTurnReply } from '../lib/battle-frame-render.mjs'
import { sendTotemReviveAnimation } from '../lib/item-art-render.mjs'
import { updatePlayer, getPlayer, playerExists } from '../lib/player-repo.js'
import { skills as allSkills, levelsData, classes, races, getTotalStats } from '../lib/game-data.js'
import {
  calcPlayerDamage,
  applyDefense,
  calcPlayerHitChance,
  findSkill,
  hpBar,
  buildEffectDef,
  applyLevelUps,
} from '../lib/combat-engine.js'
import { processStatusTurn } from '../lib/combat-handlers.js'
import { addStatusEffect, getEffectiveStat, absorbDamage, isNegativeEffect, applyReboundEffect } from '../lib/effects.js'
import { findEquippedAbility, resolveActiveAbility } from '../lib/ability-engine.js'
import { beastIntervention, awardBeastCp, BEAST_EVENT } from '../lib/beast-engine.js'
import { wearWeaponOnTurn, wearArmorOnHit, breakMessage } from '../lib/durability.js'
import { applyStruckReactions, applyPackLifestealOnDeal } from '../lib/premium-abilities.js'
import { getGroupSettings, saveGroupSettings, saveFailedMessage, isGroupOrBotOwner } from '../lib/group-settings.js'
import { NOT_GROUP, NOT_ALLOWED } from '../lib/group-helpers.js'
import { isPremiumActive } from '../lib/premium.js'
import { startOfDay } from '../lib/sleep-engine.js'
import { findActiveMatchFor, advanceMatch } from '../lib/tourney-repo.js'
import {
  findActiveWarMatchFor,
  beginWarDuel,
  pvpConcludeWar,
  settleWalkover,
} from '../lib/guild-war-repo.js'
import { WAR_KIT_TIERS, hasWarKit, removeWarKit as removeWarKitPublic } from '../lib/war-kit.js'
import { finishTourney } from './tourney.js'
import { getActiveSeason, applySeasonPoints } from '../lib/season-engine.js'
import { recordQuestEvent } from '../lib/quest-engine.js'
import {
  activateFinalForm,
  activateCinderVerdict,
  hasSecondTranscendance,
  CINDER_VERDICT_MULT,
  applyTearOnHit,
  sendFinalFormVideo,
  sendWillowAdvisory,
  tickPermanentSever,
  applyPermanentSeverOnWin,
  tickFrostbindAura,
  applyFrostlockGate,
  applyAbsoluteOneSiphon,
  rollSerpentsGrace,
  checkYoriichiCatForm,
  resolveCatFormAction,
  isCatFormActive,
  isOpponentLive,
  applyIncomingDamage,
  healCatFormPool,
  buildCatFormDefeatMessage,
  grantYoriichiExp,
  catFormAttackDamage,
  resolveCatFormDamage,
  applyAlyaStatBreak,
  megumiTurnStart,
  resolveMegumiIncoming,
  activateChimeraDomain,
  sendDomainImage,
  sendWheelSpin,
  danceOfTheRainMultiplier,
  buildDanceOfTheRainMessage,
  hasAnastasia,
  armHypnosis,
  canHypnosisRewind,
  resolveHypnosisRewind,
  restoreHypnosisSnapshot,
  hypnosisTollStep,
  buildHypnosisMessage,
  clearHypnosis,
  hasCirce,
  wildCardUsesLeft,
  drawWildCard,
  resolveWildCard,
  buildWildCardReveal,
  circeGuardStatus,
  WILD_CARD_MAX_USES,
  activateThiefsEye,
  resolveThiefsEyeDamage,
  recordEnemyMove,
  recordThiefsEyeDeny,
  applyThiefsEyeDenyGate,
  activateHollowExchange,
  buildHollowExchangeReveal,
  activateHollowPurple,
  activateUnlimitedVoid,
  UNLIMITED_VOID_STUN_TURNS,
  activateKurohitsugi,
  kurohitsugiMultiplier,
  aizenSenses,
  AIZEN_MAX_SENSES,
  activateHogyoku,
  activatePuppetStrings,
  resolvePuppetSelfHit,
  buildPuppetStringsReveal,
  PUPPET_TANGLE_TURNS,
  activateTimeStop,
  hasMontana,
  resolveMontanaCounter,
  TIME_STOP_TURNS,
  activateKurama,
  resolveKuramaDrain,
  sendKuramaSummonImage,
  armLovestruck,
  applyAweGate,
  hasGogeta,
  armFusion,
  fusionTurnsLeft,
  rollInstantTransmissionOpener,
  activateSoulPunisher,
  activateBigBangKamehameha,
  gogetaCooldowns,
  sendKamehamehaImage,
  hasWitchOfEnvy,
  advanceWondersOfEnvy,
  bypassesWondersOfEnvy,
  armWondersOfEnvy,
  applyWondersCurseOnWin,
  activateGreedTithe,
  echidnaPvpTithe,
  buildGreedTitheReveal,
  GREED_TANGLE_TURNS,
} from '../lib/character-abilities.js'
import {
  kurohitsugiCastLine, kurohitsugiImpactLine,
} from '../lib/aizen-flavor.js'
import { roundGems } from '../lib/format.js'
import {
  activateDragonUltimate,
  resolveDragonUltimateDamage,
  buildDragonUltimateSequence,
  buildDragonRestFooter,
  markDragonAsleep,
} from '../lib/dragon-engine.js'
import { sendImageTo } from '../lib/image.js'
import {
  ensurePvp, ratingOf, ratingDelta, recordWin, recordLoss, rankFor, streakLabel,
  moveOptions, suggestMove, statusBoard, effectLine,
  isStale, idleMs, formatDuration, TURN_TIMEOUT_MS,
} from '../lib/pvp-engine.js'
import { getGuildRecord, getGuildDef } from '../lib/guild-repo.js'
import { guildPerksFor } from '../lib/guild-engine.js'
import { getAbilityDef } from '../lib/ability-engine.js'
import { detectGambits, formatGambits } from '../lib/pvp-gambits.js'
// ── Wager duels (the no-turns, stake-on-the-line mode) ────────────────────
// The engine lives in lib/pvp-wager.js; this file only routes commands into it
// and owns persistence, because updatePlayer() must stay top-level (see
// runPvpTurn's header for why nesting it deadlocks).
import {
  isWagerState, makeWagerState, wagerIdleMs, WAGER_IDLE_TIMEOUT_MS,
  WAGER_MIN_STAKE, parseStake, checkPacing, notePacing, pacingMessage,
  hasUsableSkill, PACING_FORCED_NOTE,
  ppLeft, maxPpFor,
  resolveWagerAction, drinkFromKit, refillPpFromKit, mendFromKit,
  swapTotemFromKit, swapArmorFromKit, swapWeaponFromKit,
  escrowStake, refundStake, payWagerPot, clearWagerState,
  wagerBoard, kitPanel,
} from '../lib/pvp-wager.js'
import {
  PVP_KIT_SLOTS, ensureKit, kitSpace, moveToKit, takeFromKit,
} from '../lib/pvp-kit.js'
import { sendKitReply } from '../lib/pvp-kit-render.mjs'
import { getInventoryCap } from '../lib/inventory-limits.js'

const CHALLENGE_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes to accept/decline
const VICTORY_SOLARS_PCT = 0.05 // 5% of the LOSER's wallet.solars — never gems/vault

// Daily duel cap — charged to the CHALLENGER only, at challenge time.
const FREE_DAILY_PVP_LIMIT = 5
const PREMIUM_DAILY_PVP_LIMIT = 10

// ── PvP fight-length cap ─────────────────────────────────────────────────
// A single basic attack or skill can never carve away more than this fraction
// of the TARGET's max HP in one hit. This is what ends the one-tap era: at
// level 100 a focused build's primary stat (~1,300-1,800 — it rides the
// 1,500-point allocation pool + 2/level + gear) has caught up to the HP pool
// (~1,300, which only grows +10/level and CANNOT be allocated into), so an
// uncapped hit ≈ a kill and a 2-3x skill one-shots straight through defense.
//
// Capping per hit as a FRACTION OF MAX HP — rather than a flat damage scalar —
// is deliberately level-agnostic: it lengthens a duel identically at level 20
// and level 100, where a single tuned multiplier could only ever fix one end.
// Every hit BELOW the cap stays fully stat-scaled, so gear and tactics still
// decide the match: higher level is a FAVOURITE (bigger HP pool, reaches the
// cap reliably) but never a guaranteed win — a geared, well-played underdog
// who also reaches the cap trades evenly, and out-defending / out-timing /
// crit luck settles it. Elo is a favourite, not a verdict; anything can happen.
//
// Skills cap higher than basics so spending MP on a skill is a real tactical
// lever, not a same-damage reskin of a basic swing. Signature ultimates
// (Cinder Verdict, Wild Card, the dragon ultimate) and Yoriichi's cat form are
// EXEMPT — they are the rare, uncapped burst the baseline exchange is built
// around. PvP only; PvE stays balanced by the monster engine.
const PVP_BASIC_HIT_MAX_HP_FRAC = 0.15  // basic attack ceiling: 15% of target max HP
const PVP_SKILL_HIT_MAX_HP_FRAC = 0.25  // skill ceiling: 25% of target max HP

/* ───────────────────────── wager-mode aliases ─────────────────────────── */
/*
 * Short forms are the point, not a convenience. Wager duels run on a 2-second
 * cooldown with no turn order, so the winner is partly whoever types faster:
 * `.pvp atk` has to be typeable in one breath. The long forms stay accepted so
 * nobody has to relearn the commands they already know.
 */
const WAGER_ALIASES   = new Set(['wager', 'w', 'stake', 'bet'])
const STOCK_ALIASES   = new Set(['stock', 'st', 'pack'])
const UNSTOCK_ALIASES = new Set(['unstock', 'us', 'unpack'])
const KIT_ALIASES     = new Set(['inv', 'inventory', 'kit'])
const W_ATTACK        = new Set(['atk', 'a'])
const W_SKILL         = new Set(['sk', 's'])
const W_DEFEND        = new Set(['def', 'd'])
const W_DRINK         = new Set(['dr', 'drink'])
const W_TOTEM         = new Set(['tot', 'totem'])
const W_ARMOR         = new Set(['arm', 'armor', 'armour'])
const W_WEAPON        = new Set(['wpn', 'weapon'])
const W_MEND          = new Set(['mnd', 'mend', 'repair'])
const W_REFILL        = new Set(['rf', 'refill', 'vial'])

/**
 * One side's HP line for the per-turn BATTLE STATUS footer, cat-form-aware.
 * When a side has Yoriichi's cat form active, their OWN hp is deliberately
 * pinned at 1 (see checkYoriichiCatForm) while Yoriichi fights from a SEPARATE
 * pool — so `hpBar(entity.hp, entity.maxHp)` would misleadingly render "1/maxHp"
 * (the source of the "why is it showing 1/1055?" report). Show Yoriichi's own
 * pool instead, mirroring lib/pvp-engine.js's sideLine() which already does this
 * for the `.pvp status` board.
 */
function pvpStatusLine(entity, heart) {
  const cat = isCatFormActive(entity) ? entity.battleState.yoriichiCatFormActive : null
  if (cat) {
    return (
      `${heart} *${entity.name}*: 🐈‍⬛ ${hpBar(cat.hp, cat.maxHp)}  ${cat.hp}/${cat.maxHp} _cat-form HP_  💧 ${entity.mp}/${entity.maxMp} MP\n` +
      `   _Yoriichi fights in ${entity.name}'s place._`
    )
  }
  return `${heart} *${entity.name}*: ${hpBar(entity.hp, entity.maxHp)}  💧 ${entity.mp}/${entity.maxMp} MP`
}

/**
 * The full BATTLE STATUS + "turn passes to" footer, shared by the normal turn
 * path and Yoriichi's auto-answer path so both show identical, cat-form-aware
 * HP bars for the two combatants.
 *
 * Who's next is read off `battleState.myTurn` rather than assumed to be the
 * non-actor. Two reasons, and the second one is the important one:
 *
 *  - Yoriichi answers her own turns the instant the baton reaches her owner
 *    (autoResolveCatFormTurns), so the baton can come straight back to the
 *    person who just moved and "the other one" would be wrong.
 *  - It makes it STRUCTURALLY IMPOSSIBLE to print "TURN PASSES TO <owner>" for
 *    a player Yoriichi is fighting for. That line used to be the loudest way the
 *    bot handed the turn back to someone lying unconscious on the floor, and it
 *    is not something a future edit should be able to reintroduce by accident.
 */
function pvpStatusFooter(actorEntity, oppEntity) {
  const board =
    `\n🩸 *BATTLE STATUS* 🩸\n` +
    pvpStatusLine(actorEntity, '❤️') + '\n' +
    pvpStatusLine(oppEntity, '💙') + '\n\n'
  const next = oppEntity?.battleState?.myTurn
    ? oppEntity
    : actorEntity?.battleState?.myTurn
      ? actorEntity
      : oppEntity
  if (isCatFormActive(next)) {
    return board + `🐈‍⬛ *YORIICHI FIGHTS ON — ${next.name.toUpperCase()} HAS NO TURN.* 🐈‍⬛`
  }
  return board + `⏭️ *TURN PASSES TO ${next.name.toUpperCase()}!* ⏭️`
}

/**
 * The player's guild perks, or the all-zero Outpost baseline if they're
 * guildless. Read fresh at the point of the action rather than cached on the
 * player, so leaving a guild stops applying immediately and a guild that
 * levels up mid-duel takes effect on the very next one — the contract
 * lib/guild-engine.js's header sets out.
 */
function perksFor(db, player) {
  const record = player?.guildId ? getGuildRecord(db, player.guildId) : null
  return guildPerksFor(player, record)
}

/** The player's daily duel cap, including any guild-tier bonus slots. */
function pvpChallengeLimit(player, bonusSlots = 0) {
  const base = isPremiumActive(player) ? PREMIUM_DAILY_PVP_LIMIT : FREE_DAILY_PVP_LIMIT
  return base + Math.max(0, bonusSlots)
}

/** Duel slots the player has left today (resets automatically at midnight). */
function pvpChallengesRemaining(player, bonusSlots = 0) {
  const limit = pvpChallengeLimit(player, bonusSlots)
  const today = startOfDay(Date.now())
  const usedToday = player.pvpChallengeDate === today ? (player.pvpChallengesUsed ?? 0) : 0
  return Math.max(0, limit - usedToday)
}

/** Records that the player just spent one of today's duel slots. Call only
 *  once a challenge is confirmed going out (after all validity checks). */
function consumePvpChallenge(player) {
  const today = startOfDay(Date.now())
  if (player.pvpChallengeDate !== today) {
    player.pvpChallengeDate = today
    player.pvpChallengesUsed = 0
  }
  player.pvpChallengesUsed = (player.pvpChallengesUsed ?? 0) + 1
}

// Flat XP-equivalent figure fed into awardBeastCp() for a PvP win — there's
// no monster xp reward to derive from here, so this stands in for it,
// pegged near a "strong" PvE kill (see lib/xp-regulator.js's TIER_PCT) so
// beast growth from duels tracks roughly the same pace as dungeon grinding.
const PVP_WIN_XP_EQUIVALENT = 60

const EFFECT_APPLIED_LINE = {
  stun: (n) => `⚡🌀 *${n} IS STUNNED — LOCKED DOWN!*\n`,
  freeze: (n) => `❄️🧊 *${n} IS FROZEN SOLID!*\n`,
  blind: (n) => `🌑👁️ *${n} IS BLINDED — CAN'T SEE THE NEXT HIT!*\n`,
  burn: (n) => `🔥🔥 *${n} IS BURNING ALIVE!*\n`,
  poison: (n) => `☠️🟢 *${n} IS POISONED — TICKING DOWN!*\n`,
  bleed: (n) => `🩸💢 *${n} IS BLEEDING OUT!*\n`,
  weaken: (n) => `💔⬇️ *${n} IS WEAKENED — POWER DRAINED!*\n`,
  slow: (n) => `🐢⏱️ *${n} IS SLOWED TO A CRAWL!*\n`,
}

function resolveTargetJid(ctx, raw) {
  const contextInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo
  if (contextInfo?.participant) return contextInfo.participant
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0]
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

/** Small delay for the dragon ultimate's multi-message cinematic. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function inPvp(player) {
  return !!(player.inBattle && player.battleState?.type === 'pvp')
}

/**
 * warDuelKitLine(warDuel) — the one-line banner prefix for a pairing that
 * just went live: which kit tier loaded and the isolation promise. Shared by
 * the normal and wager accept paths so a war duel always announces the same
 * way however it was opened.
 */
function warDuelKitLine(warDuel) {
  const tier = warDuel?.war?.kitTier
  const kit = WAR_KIT_TIERS?.[tier]
  const size = warDuel?.war?.matchType
  const label = kit ? `${kit.emoji} *${kit.name}* (Preset 5 · Tier ${kit.tier})` : `Preset 5`
  return `🎒 ${label} loaded on both champions — war *${size ?? 'duel'}*, pairing ${((warDuel?.match?.i ?? 0) + 1)}.`
}

/** Ends a duel with no winner (both just walk away) — used by the /timeout path. */
async function clearBattle(db, jid) {
  // Belt-and-braces: if this player was mid-PAIRING when their duel died
  // without a conclusion, Preset 5 must never be left on them. removeWarKit
  // is idempotent, so calling it for an ordinary duel is free.
  await updatePlayer(db, jid, (p) => {
    if (hasWarKit(p)) removeWarKitPublic(p)
    p.inBattle = false
    p.battleState = null
  })
}

/**
 * tryHypnosisRewindPvp — the duel half of Anastasia's Hypnosis. Returns a
 * truthy value if the duel was rewound instead of concluded (in which case
 * pvpConclude must return immediately and touch nothing: no solars change
 * hands, no rating moves, no win/loss is recorded — the duel is still live),
 * or null to let the normal conclusion run.
 *
 * Both sides are unwound. The loser goes back through resolveHypnosisRewind
 * (which spends one of their two rewinds), the winner through
 * restoreHypnosisSnapshot (which spends nothing — they don't own her) and
 * then pays the 15% toll off the HP they opened the duel on. Uses the same
 * read-fresh / sequential-updatePlayer pattern as the rest of this file
 * rather than nesting, since nested updatePlayer calls deadlock on
 * player-repo's single write queue.
 */
async function tryHypnosisRewindPvp(db, winnerJid, loserJid, ctx, reasonLine) {
  if (!canHypnosisRewind(getPlayer(db, loserJid))) return null

  let rewind = null
  await updatePlayer(db, loserJid, (loser) => {
    rewind = resolveHypnosisRewind(loser)
  })
  if (!rewind?.rewound) return null

  // toll is null out of resolveHypnosisRewind here — a PvP opponent is their
  // own player record, not a battleState.enemy object — so it's applied to
  // the winner directly. hypnosisTollStep() off their RESTORED opening HP is
  // the same call the dungeon path makes, so a duel rewind and a dungeon
  // rewind chip identical amounts.
  let toll = null
  await updatePlayer(db, winnerJid, (winner) => {
    restoreHypnosisSnapshot(winner)
    const step = hypnosisTollStep(winner.hp, rewind.rewindNumber)
    winner.hp = step.after
    toll = { name: winner.name, ...step, maxHp: winner.maxHp }
  })

  const loserAfter = getPlayer(db, loserJid)
  const winnerAfter = getPlayer(db, winnerJid)
  // Whoever held the opening move holds it again — myTurn came back with the
  // rest of each side's restored battleState.
  const firstMover = loserAfter.battleState?.myTurn ? loserAfter : winnerAfter

  await ctx.reply(
    reasonLine +
    buildHypnosisMessage(loserAfter, { ...rewind, toll }) +
    `\n\n🩸 *BATTLE STATUS* 🩸\n` +
    pvpStatusLine(loserAfter, '❤️') + '\n' +
    pvpStatusLine(winnerAfter, '💙') + '\n\n' +
    `⏭️ *THE DUEL RESUMES — ${firstMover.name.toUpperCase()} MOVES FIRST!* ⏭️`,
  )
  return loserAfter
}

/**
 * pvpConclude — the ONLY PvP win/loss handler. Deliberately does not touch
 * handleDeath/handleVictory. Transfers 5% of the loser's wallet.solars
 * (never gems/vault — see plugins/vault.js's exclusion guarantee), fully
 * heals both players, clears both battleStates, no gear loss either side.
 *
 * allowRewind: whether Anastasia's Hypnosis may unwind this ending instead
 * of letting it stand. Defaults to true so a new death path added later
 * gets her for free — the failure mode that actually happened with
 * Yoriichi was an ability wired into one call site and silently missing
 * from the rest. Pass false for endings that are NOT a combat death:
 * forfeits and turn-timeout claims. Rewinding those would let a player
 * chip 15% off an opponent by quitting, and would drag someone who won on
 * time back into a duel their opponent had already abandoned.
 */
async function pvpConclude(db, winnerJid, loserJid, ctx, reasonLine, { allowRewind = true } = {}) {
  // ── Guild War pairing — settles FIRST, before everything else ─────────
  // A live war pairing IS this duel. It has to run ahead of the wager branch
  // (a wager war carries a real stake AND a war point — one branch must own
  // both, or the war never scores), ahead of Hypnosis (a rewind would strand
  // Preset 5 on both fighters and un-decide a pairing that is already over),
  // and ahead of the tournament hook (a war pairing is never a bracket match).
  // Returns false only when there was nothing war-shaped about this duel, in
  // which case every older path below runs untouched.
  const warMatch = findActiveWarMatchFor(db, winnerJid, loserJid)
  if (warMatch) {
    const handled = await pvpConcludeWar(db, winnerJid, loserJid, ctx, reasonLine, warMatch)
    if (handled) return undefined
  }

  // ── Wager duels settle differently, and settle FIRST ────────────────────
  // Ahead of the Hypnosis check on purpose: wager mode disables every character
  // power (spec §1), and Anastasia unwinding a duel that has real solars in
  // escrow would be the single most exploitable thing in the mode. Ahead of the
  // tournament hook too, since a bracket match is never a wager.
  const wagerStake = wagerStakeOf(db, winnerJid, loserJid)
  if (wagerStake > 0) {
    return pvpConcludeWager(db, winnerJid, loserJid, ctx, reasonLine, wagerStake)
  }

  // ── Anastasia — Hypnosis ─────────────────────────────────────────────
  // Ahead of the tournament hook on purpose: a bracket match is still a
  // duel, and "if they lose, whether in pvp or dungeon" covers it.
  if (allowRewind) {
    const rewound = await tryHypnosisRewindPvp(db, winnerJid, loserJid, ctx, reasonLine)
    if (rewound) return rewound
  }

  // ── Tournament hook ──────────────────────────────────────────────────
  // Was this duel actually a paired bracket match from an active
  // plugins/tourney.js tournament? If so, it does NOT go through the
  // normal 5%-solars-steal ending — bracket matches settle via the
  // tournament's fixed prize payout once the final concludes, not per-duel theft.
  // Both players are still healed/cleared exactly as a normal duel would
  // be; only the "who gets paid what and what message shows" branches.
  const tourneyMatch = findActiveMatchFor(db, winnerJid, loserJid)
  if (tourneyMatch) {
    return pvpConcludeTourneyMatch(db, winnerJid, loserJid, ctx, reasonLine, tourneyMatch)
  }

  let winnerName = ''
  let loserName = ''
  let pvpRankUp = null
  let transferred = 0
  let severLine = ''
  let wondersLine = ''

  // Need the winner's equippedCharacter before the loser's activeEffects
  // gets wiped below — applyPermanentSeverOnWin() must run before that
  // wipe, since permanentSever deliberately lives outside activeEffects
  // (see lib/character-abilities.js) specifically so it survives it, but
  // the *decision* of whether to apply it at all still has to happen here.
  const winnerSnapshot = getPlayer(db, winnerJid)
  const loserSnapshot = getPlayer(db, loserJid)

  // ── Ladder ──────────────────────────────────────────────────────────────
  // The rating swing MUST be computed from both ratings as they stand right
  // now, before either side is written. Deriving it inside the mutators
  // would read one player post-update and skew the other's swing.
  ensurePvp(winnerSnapshot ?? {})
  ensurePvp(loserSnapshot ?? {})
  const winnerRatingBefore = ratingOf(winnerSnapshot)
  const loserRatingBefore = ratingOf(loserSnapshot)
  const delta = ratingDelta(winnerRatingBefore, loserRatingBefore)
  // Guild spoils are paid on top of the seizure, not carved out of it — the
  // loser never loses more than VICTORY_SOLARS_PCT because their opponent
  // happens to belong to a Citadel.
  const spoilsPct = perksFor(db, winnerSnapshot).spoilsPct
  let spoilsBonus = 0

  await updatePlayer(db, loserJid, (loser) => {
    loserName = loser.name
    loser.wallet = loser.wallet ?? {}
    transferred = Math.floor((loser.wallet.solars ?? 0) * VICTORY_SOLARS_PCT)
    loser.wallet.solars = Math.max(0, (loser.wallet.solars ?? 0) - transferred)
    loser.hp = loser.maxHp
    loser.mp = loser.maxMp
    loser.inBattle = false
    loser.battleState = null
    clearHypnosis(loser)
    recordLoss(loser, winnerSnapshot?.name ?? null, delta, transferred)
    loser.pvp.lastOpponentJid = winnerJid

    // Urahara — Tear/Reshape permanent bleed (spec §13.2, "in PvP
    // specifically the bleed becomes a PERMANENT debuff on the losing
    // player"). Must run BEFORE activeEffects is wiped below, even though
    // permanentSever itself lives on a separate field, so this line stays
    // physically adjacent to (and clearly ordered before) the wipe for
    // anyone reading/maintaining this later.
    if (winnerSnapshot) {
      const line = applyPermanentSeverOnWin(winnerSnapshot, loser)
      if (line) severLine = line
    }

    // Tella — the "even after the battle" half of Wonders of You. Keyed off
    // loser.wondersCursePending (stamped when her final form forced the loss),
    // so it fires ONLY when she actually forsook them, never on an ordinary KO.
    // Runs after the full heal above so the 5% it removes reads as a wound that
    // did not close, and sits beside the sever it mirrors.
    {
      const line = applyWondersCurseOnWin(winnerSnapshot, loser)
      if (line) wondersLine = line
    }

    loser.activeEffects = []
  })

  let beastCpMsg = ''
  let seasonMsg = ''
  let levelUpMsg = ''
  await updatePlayer(db, winnerJid, (winner) => {
    winnerName = winner.name
    winner.wallet = winner.wallet ?? {}
    spoilsBonus = Math.floor(transferred * (spoilsPct / 100))
    winner.wallet.solars = (winner.wallet.solars ?? 0) + transferred + spoilsBonus
    winner.hp = winner.maxHp
    winner.mp = winner.maxMp
    winner.inBattle = false
    winner.battleState = null
    winner.activeEffects = []
    clearHypnosis(winner)
    recordWin(winner, loserSnapshot?.name ?? null, delta, transferred + spoilsBonus)
    winner.pvp.lastOpponentJid = loserJid

    // Yoriichi's own growth track — PvP wins are worth more than dungeon
    // wins (see YORIICHI_EXP_PER_PVP_WIN in character-abilities.js). No-op
    // if she isn't the winner's equipped character.
    grantYoriichiExp(winner, 'pvp')

    // Quest progress: a duel win. Recorded before applyLevelUps below so a
    // level bought by this duel's XP is also counted (level quests).
    recordQuestEvent(winner, 'pvp_win', 1)

    // Summon Beast: the winner's active beast (if any) gains CP for the
    // win, same lever PvE kills use — see PVP_WIN_XP_EQUIVALENT above.
    beastCpMsg = awardBeastCp(winner, PVP_WIN_XP_EQUIVALENT)
    const season = getActiveSeason(db)
    if (season) {
      const result = applySeasonPoints(winner, season, season.bonuses?.winPoints)
      const seasonXp = Math.max(0, Math.floor(PVP_WIN_XP_EQUIVALENT * (Number(season.bonuses?.winXpPercent ?? 0) / 100)))
      const seasonSolars = Math.max(0, Math.floor(transferred * (Number(season.bonuses?.winSolarsPercent ?? 0) / 100)))
      winner.xp = (winner.xp ?? 0) + seasonXp
      winner.wallet.solars += seasonSolars
      seasonMsg = result.gained
        ? `\n🌞 Season bonus: +${result.gained} Season Points, +${seasonXp} XP, +${seasonSolars} Solars`
        : ''
    }

    // Duel XP has to be able to LEVEL the winner. Adding to winner.xp without
    // this call was the whole bug: player.xp is cumulative and is compared
    // against levelsData.xpTable, so XP banked past the next threshold just sat
    // there and profile.js rendered a negative "to next". Called unconditionally
    // (not just inside the season branch above) on purpose: applyLevelUps is a
    // catch-up while-loop, so a winner who already banked XP past one or more
    // thresholds while this was broken collects every pending level here, and a
    // winner with nothing pending no-ops. The full heal it does on each level is
    // consistent with the duel healing both players anyway (see above).
    const lvl = applyLevelUps(winner, levelsData, classes, races, getTotalStats)
    if (lvl.msgs.length) { levelUpMsg = `\n\n${lvl.msgs.join('\n')}`; recordQuestEvent(winner, 'level', lvl.msgs.length) }
    if (lvl.rankChange) {
      levelUpMsg += `\n\n⚔️ *RANK UP!* ${lvl.rankChange.to.emoji} *${lvl.rankChange.to.title}*\n_"${lvl.rankChange.to.epithet}"_`
      pvpRankUp = { from: lvl.rankChange.from, to: lvl.rankChange.to }
    }
  })

  const winnerAfter = getPlayer(db, winnerJid)
  const loserAfter = getPlayer(db, loserJid)
  const winnerBand = rankFor(winnerAfter)
  const loserBand = rankFor(loserAfter)
  const guildDef = winnerSnapshot?.guildId ? getGuildDef(winnerSnapshot.guildId) : null
  const spoilsLine = spoilsBonus > 0
    ? `\n🏰 *${guildDef?.name ?? 'Guild'}* spoils: *+${spoilsBonus}* extra _(${spoilsPct}% guild cut)_`
    : ''

  await ctx.reply(
    `🏆🔥 *DUEL OVER!!* 🔥🏆\n\n` +
    reasonLine + `\n\n` +
    `👑💀 *${winnerName.toUpperCase()} DEFEATS ${loserName.toUpperCase()}!* 💀👑\n` +
    `☀️💰 *+${transferred} SOLARS SEIZED!* _(5% of their wallet — gems & vault untouched)_` +
    spoilsLine + `\n\n` +
    `📈 *RATING*\n` +
    `${winnerBand.emoji} *${winnerName}*: ${ratingOf(winnerAfter)} _(+${delta})_  ·  streak ${streakLabel(winnerAfter)}\n` +
    `${loserBand.emoji} *${loserName}*: ${ratingOf(loserAfter)} _(-${delta})_  ·  streak ${streakLabel(loserAfter)}\n\n` +
    `❤️‍🩹 Both duelists are fully healed. No gear was lost.` +
    (severLine ? `\n\n${severLine}` : '') +
    (wondersLine ? `\n\n${wondersLine}` : '') +
    (beastCpMsg ? `\n\n${beastCpMsg}` : '') + seasonMsg + levelUpMsg +
    `\n\n_Rematch: *${config.prefix}pvp rematch* · Ladder: *${config.prefix}pvptop*_`,
  )

  // Rank promotion — the dedicated rank-up card, after the duel summary.
  if (pvpRankUp) await sendRankUp(ctx, winnerName, pvpRankUp.from, pvpRankUp.to)
}

/**
 * pvpConcludeTourneyMatch — the tournament-flavored twin of pvpConclude().
 * Both duelists are healed and cleared exactly as usual (no gear loss, no
 * PvP daily-limit interaction), but no solars/gems change hands here —
 * that only happens once when the whole tournament finishes, via
 * finishTourney()'s fixed prize1st/prize2nd payout. This just records the bracket
 * result and shows either an "advance to next round" or, once the final
 * resolves, hands off to finishTourney() for the full payout + title.
 */
async function pvpConcludeTourneyMatch(db, winnerJid, loserJid, ctx, reasonLine, tourneyMatch) {
  let winnerName = ''
  let loserName = ''
  let pvpRankUp = null
  let severLine = ''
  let wondersLine = ''
  const winnerSnapshot = getPlayer(db, winnerJid)
  const loserSnapshot = getPlayer(db, loserJid)

  // A bracket match is still a duel, so it still moves the ladder. Same
  // both-ratings-before-either-write rule as pvpConclude() above.
  ensurePvp(winnerSnapshot ?? {})
  ensurePvp(loserSnapshot ?? {})
  const delta = ratingDelta(ratingOf(winnerSnapshot), ratingOf(loserSnapshot))

  await updatePlayer(db, loserJid, (loser) => {
    loserName = loser.name
    loser.hp = loser.maxHp
    loser.mp = loser.maxMp
    loser.inBattle = false
    loser.battleState = null
    clearHypnosis(loser)
    recordLoss(loser, winnerSnapshot?.name ?? null, delta, 0)
    if (winnerSnapshot) {
      const line = applyPermanentSeverOnWin(winnerSnapshot, loser)
      if (line) severLine = line
    }
    // Tella — Wonders of You's lingering curse also carries into a bracket
    // match. Same placement and reasoning as in pvpConclude() above.
    {
      const line = applyWondersCurseOnWin(winnerSnapshot, loser)
      if (line) wondersLine = line
    }
    loser.activeEffects = []
  })

  let beastCpMsg = ''
  let seasonMsg = ''
  let levelUpMsg = ''
  await updatePlayer(db, winnerJid, (winner) => {
    winnerName = winner.name
    winner.hp = winner.maxHp
    winner.mp = winner.maxMp
    winner.inBattle = false
    winner.battleState = null
    winner.activeEffects = []
    clearHypnosis(winner)
    recordWin(winner, loserSnapshot?.name ?? null, delta, 0)
    grantYoriichiExp(winner, 'pvp')
    beastCpMsg = awardBeastCp(winner, PVP_WIN_XP_EQUIVALENT)
    const season = getActiveSeason(db)
    if (season) {
      const result = applySeasonPoints(winner, season, season.bonuses?.winPoints)
      const seasonXp = Math.max(0, Math.floor(PVP_WIN_XP_EQUIVALENT * (Number(season.bonuses?.winXpPercent ?? 0) / 100)))
      winner.xp = (winner.xp ?? 0) + seasonXp
      seasonMsg = result.gained
        ? `\n🌞 Season bonus: +${result.gained} Season Points, +${seasonXp} XP`
        : ''
    }

    // Same catch-up as pvpConclude() above — a bracket win is still a duel, so
    // its XP still has to be able to level the winner.
    const lvl = applyLevelUps(winner, levelsData, classes, races, getTotalStats)
    if (lvl.msgs.length) levelUpMsg = `\n\n${lvl.msgs.join('\n')}`
    if (lvl.rankChange) {
      levelUpMsg += `\n\n⚔️ *RANK UP!* ${lvl.rankChange.to.emoji} *${lvl.rankChange.to.title}*\n_"${lvl.rankChange.to.epithet}"_`
      pvpRankUp = { from: lvl.rankChange.from, to: lvl.rankChange.to }
    }
  })

  const { groupJid, roundIdx, matchIdx, tourney } = tourneyMatch
  const result = await advanceMatch(db, groupJid, roundIdx, matchIdx, winnerJid)

  if (result.finished) {
    return finishTourney(
      ctx, db, groupJid, result.tourney, result.championJid, result.runnerUpJid,
      reasonLine,
    )
  }

  await ctx.reply(
    `🏆 *${tourney.name}* — BRACKET RESULT 🏆\n\n` +
    reasonLine + `\n\n` +
    `👑 *${winnerName.toUpperCase()} DEFEATS ${loserName.toUpperCase()}!*\n` +
    `➡️ *${winnerName}* advances to the next round!\n\n` +
    `❤️‍🩹 Both duelists are fully healed. No gear or currency was lost.` +
    (severLine ? `\n\n${severLine}` : '') +
    (wondersLine ? `\n\n${wondersLine}` : '') +
    (beastCpMsg ? `\n\n${beastCpMsg}` : '') + seasonMsg + levelUpMsg +
    `\n\n_Check the bracket anytime: *${config.prefix}tourney bracket*_`,
  )

  // Rank promotion — the dedicated rank-up card, after the bracket summary.
  if (pvpRankUp) await sendRankUp(ctx, winnerName, pvpRankUp.from, pvpRankUp.to)
}

export default {
  name: 'pvp',
  aliases: ['duel'],
  category: 'pvp',
  requiresPlayer: true,
  description: `${config.prefix}pvp @target — challenge another player to a duel`,
  subcommands: [
    { cmd: '@target', desc: 'challenge someone (reply or @mention)' },
    { cmd: 'accept / decline', desc: 'answer a challenge against you' },
    { cmd: 'moves', desc: 'every move you can make this turn, and what it costs' },
    { cmd: 'status', desc: 'the current board — HP, MP, effects, whose turn' },
    { cmd: 'attack', desc: 'basic attack' },
    { cmd: 'skill <name>', desc: 'spend MP on a skill' },
    { cmd: 'ability <name>', desc: 'fire an equipped active ability' },
    { cmd: 'defend', desc: 'brace — +MP and the next hit is halved' },
    { cmd: 'rematch', desc: 'challenge your last opponent again' },
    { cmd: 'claim', desc: 'take the win if your opponent has stalled out' },
    { cmd: 'forfeit', desc: 'concede the duel' },
    { cmd: 'on / off', desc: 'group admins — allow duels in this group' },
    // ── wager mode ──
    { cmd: 'wager <amount> @target', desc: 'stake solars: no turns, no characters, loser pays in full' },
    { cmd: 'stock <item> [n]', desc: 'pack an item into your 15-slot PvP kit' },
    { cmd: 'unstock <item> [n]', desc: 'pull an item back out of the kit' },
    { cmd: 'inv', desc: 'the PvP kit, drawn as a 5x3 grid' },
    { cmd: 'atk / sk <name> / def', desc: 'wager duel moves (2s cooldown, no same move twice in a row)' },
    { cmd: 'dr <item>', desc: 'wager: drink a potion out of the kit' },
    { cmd: 'tot', desc: 'wager: slot a fresh totem into your off hand' },
    { cmd: 'arm <slot> / wpn <name>', desc: 'wager: swap in stocked gear' },
    { cmd: 'mnd arm / mnd wpn', desc: 'wager: repair half the durability lost' },
    { cmd: 'rf', desc: 'wager: Focus Vial — refill every spent skill PP' },
  ],

  async run(ctx) {
    if (isBattleCinematicActive(ctx)) return
    const { player, args, db } = ctx
    const pr = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    // ── ON / OFF (group admins only) ────────────────────────────────────────
    if (sub === 'on' || sub === 'off') {
      if (!ctx.isGroup) return ctx.reply(NOT_GROUP)
      if (!(await isGroupOrBotOwner(ctx))) return ctx.reply(NOT_ALLOWED)
      const res = await saveGroupSettings(ctx.sender, (s) => { s.pvpEnabled = (sub === 'on') })
      if (!res.ok) return ctx.reply(saveFailedMessage('PvP', res.error))
      // Reported from the stored value, not from `sub` — a confirmation built
      // out of the request is a claim with nothing behind it.
      return ctx.reply(`🥊 PvP is now *${res.settings.pvpEnabled ? 'ON' : 'OFF'}* in this group.`)
    }

    // ── KIT: stock / unstock / inv ────────────────────────────────────────
    // Deliberately ahead of the group gate below. Packing a kit is preparation,
    // not a duel: it changes nothing for anyone else in the chat, so a group
    // with PvP switched off has no reason to stop someone getting ready for a
    // duel they will fight somewhere else.
    if (STOCK_ALIASES.has(sub))   return stockKit(ctx, args.slice(1))
    if (UNSTOCK_ALIASES.has(sub)) return unstockKit(ctx, args.slice(1))
    if (KIT_ALIASES.has(sub))     return showKit(ctx)

    // ── Group gate ───────────────────────────────────────────────────────────
    // One deliberate exemption: a GUILD WAR must never be blocked by this
    // toggle. A war pairing is declared by two guild leaders, tracked by the
    // bot, and announced in the group — if `.pvp off` could wedge it, one
    // admin mute would park a live war until it voided on the sweep. The
    // exemption is narrow: only an incoming war challenge (`.pvp accept`)
    // and only while the sender is inside a war pairing.
    if (ctx.isGroup) {
      const settings = await getGroupSettings(ctx.sender)
      const warPass = !!(
        (player?.pvpChallenge?.warId)
        || (player?.battleState?.warId && player?.inBattle)
      )
      if (!settings.pvpEnabled && !warPass) {
        return ctx.reply(
          `🚫 PvP is disabled in this group.\n` +
          `_A group admin can turn it back on with *${pr}pvp on*._`,
        )
      }
    }

    // ── ACCEPT ────────────────────────────────────────────────────────────
    if (sub === 'accept') {
      const challenge = player.pvpChallenge
      if (!challenge) return ctx.reply(`❌ You have no pending duel challenge.`)
      if (Date.now() > challenge.expiresAt) {
        await updatePlayer(db, ctx.from, (p) => { p.pvpChallenge = null })
        return ctx.reply(`⏳ That challenge expired.`)
      }
      const challengerJid = challenge.fromJid
      if (!playerExists(db, challengerJid)) {
        await updatePlayer(db, ctx.from, (p) => { p.pvpChallenge = null })
        return ctx.reply(`❌ That challenger is no longer registered.`)
      }
      const challenger = getPlayer(db, challengerJid)
      if (challenger.inBattle || challenger.inDungeon) {
        await updatePlayer(db, ctx.from, (p) => { p.pvpChallenge = null })
        return ctx.reply(`❌ *${challenger.name}* is no longer available to duel.`)
      }
      if (player.inBattle || player.inDungeon) {
        return ctx.reply(`❌ You can't accept a duel while in battle or a dungeon.`)
      }

      // ── Wager duels take a different opening: both stakes are escrowed here
      // and neither side gets a turn flag. Everything above (expiry, both
      // players still free, challenger still registered) is shared, so the
      // branch sits after the checks rather than duplicating them.
      if (challenge.wagerAmount > 0) {
        return acceptWagerDuel(ctx, challengerJid, challenge.wagerAmount)
      }

      let raceAborted = false
      // Gogeta — Instant Transmission, the turn-order face of it. A duel
      // alternates strictly and the challenger opens by default, so the only
      // turn that can be seized is this one, and only the ACCEPTER has anything
      // to win by seizing it. Rolled once here, before either battleState is
      // built, so both records agree on who is holding the baton.
      const gogetaOpener = rollInstantTransmissionOpener(player)
      // Anastasia — Hypnosis. A duel rewind has to unwind BOTH sides, so if
      // either duelist holds her, both get an opening-state snapshot; the
      // winner's is what puts them back where they started before the 15%
      // toll lands. force mirrors that: when she's in the duel everyone is
      // armed, and when she isn't, armHypnosis() clears any stale snapshot
      // left on a record by an earlier fight rather than leaving it to rot.
      const duelHasAnastasia = hasAnastasia(challenger) || hasAnastasia(player)
      await updatePlayer(db, challengerJid, (c) => {
        if (c.inBattle || c.inDungeon) { raceAborted = true; return }
        c.inBattle = true
        c.battleState = { type: 'pvp', opponentJid: ctx.from, myTurn: !gogetaOpener, defending: false, turn: 1, startedAt: Date.now(), lastMoveAt: Date.now() }
        armHypnosis(c, { force: duelHasAnastasia })
        // Alexa — Lovestruck. One call arms BOTH directions for this side: if
        // the challenger holds her, the accepter's blows lose their will; if the
        // ACCEPTER holds her, the challenger's own companion stops working. The
        // opponent has to be passed in because the tier is a comparison, and
        // this is the only moment in a duel where both records are in hand.
        armLovestruck(c, player)
        // Tella — Wonders of You. Armed here beside Lovestruck so a stale
        // envy phase from an earlier duel can never ride into this one.
        armWondersOfEnvy(c)
        // Gogeta — Fusion of Equals. Armed on the same terms, and the clock
        // starts on turn 1 for whichever side holds him.
        armFusion(c)
      })
      if (raceAborted) {
        await updatePlayer(db, ctx.from, (p) => { p.pvpChallenge = null })
        return ctx.reply(`❌ *${challenger.name}* is no longer available to duel.`)
      }

      await updatePlayer(db, ctx.from, (p) => {
        p.pvpChallenge = null
        p.inBattle = true
        p.battleState = { type: 'pvp', opponentJid: challengerJid, myTurn: gogetaOpener, defending: false, turn: 1, startedAt: Date.now(), lastMoveAt: Date.now() }
        armHypnosis(p, { force: duelHasAnastasia })
        // Alexa — the accepter's half of the same arming, mirrored.
        armLovestruck(p, challenger)
        // Tella — the accepter's half of the Wonders of You arming, mirrored.
        armWondersOfEnvy(p)
        // Gogeta — the accepter's half of the fusion arming, mirrored.
        armFusion(p)
      })

      // ── GUILD WAR pairing? Isolate both fighters behind Preset 5 NOW, at
      // the exact moment the duel starts, and stamp the battleStates with the
      // war id (plugins/pvp.js's group gate above reads that stamp). No-op
      // for an ordinary duel — beginWarDuel returns null when this pair is
      // not the live war pairing.
      const warDuel = await beginWarDuel(db, challengerJid, ctx.from)
      const freshChallenger = warDuel ? getPlayer(db, challengerJid) : challenger
      const freshMe = warDuel ? getPlayer(db, ctx.from) : player

      return ctx.reply(
        (warDuel
          ? `⚔️🔥 *GUILD WAR PAIRING — LIVE!* 🔥⚔️\n` +
            `${warDuelKitLine(warDuel)}\n` +
            `_Your real inventory is stored and comes back the moment this duel ends._\n\n`
          : '') +
        `⚔️ *DUEL ACCEPTED!*\n\n` +
        `🥊 *${freshChallenger.name}* Lv.${freshChallenger.level} vs *${freshMe.name}* Lv.${freshMe.level}\n` +
        `❤️ ${freshChallenger.name}: ${freshChallenger.hp}/${freshChallenger.maxHp}   ❤️ ${freshMe.name}: ${freshMe.hp}/${freshMe.maxHp}\n\n` +
        (gogetaOpener
          ? `✨ _Instant Transmission: ${player.name} is already standing where the duel starts._\n` +
            `*${player.name}* goes first!\n`
          : `*${challenger.name}* goes first!\n`) +
        `Moves: *${pr}pvp attack* · *${pr}pvp skill <name>* · *${pr}pvp ability <name>* · *${pr}pvp defend*\n` +
        `_Not sure what you can cast? *${pr}pvp moves* lists everything._`,
      )
    }

    // ── DECLINE ───────────────────────────────────────────────────────────
    if (sub === 'decline') {
      if (!player.pvpChallenge) return ctx.reply(`❌ You have no pending duel challenge.`)
      const fromJid = player.pvpChallenge.fromJid
      await updatePlayer(db, ctx.from, (p) => { p.pvpChallenge = null })
      const fromName = playerExists(db, fromJid) ? getPlayer(db, fromJid).name : 'them'
      return ctx.reply(`🚫 You declined the duel from *${fromName}*.`)
    }

    // ── FORFEIT ───────────────────────────────────────────────────────────
    if (sub === 'forfeit' || sub === 'flee') {
      if (!inPvp(player)) return ctx.reply(`❌ You're not in a duel.`)
      const opponentJid = player.battleState.opponentJid
      // Conceding a wager duel concedes the stake. Settlement is identical
      // either way (pvpConclude routes into pvpConcludeWager), so only the line
      // that tells the chat what just happened changes — quitting must not read
      // like a free exit when it costs the full stake.
      const forfeitLine = isWagerState(player.battleState)
        ? `_${player.name} forfeits and concedes the ${(player.battleState.wagerAmount ?? 0).toLocaleString()} solar stake!_`
        : `_${player.name} forfeits the duel!_`
      // allowRewind: false — a forfeit is a choice, not a death. Rewinding it
      // would let an Anastasia owner farm 15% off an opponent by quitting
      // twice, and there is nothing to put them "back" into: they asked out.
      return pvpConclude(db, opponentJid, ctx.from, ctx, forfeitLine, { allowRewind: false })
    }

    // ── MOVES / STATUS / CLAIM ────────────────────────────────────────────
    if (sub === 'moves' || sub === 'move' || sub === 'options') return showMoves(ctx)
    if (sub === 'status' || sub === 'board' || sub === 'hp')   return showStatus(ctx)
    if (sub === 'claim' || sub === 'timeout')                   return claimStale(ctx)

    // ── WAGER MODE actions ────────────────────────────────────────────────
    // Ahead of the normal action block on purpose. A wager battleState carries
    // type: 'pvp' (so the rest of the bot's duel guards keep working), which
    // means `.pvp attack` would otherwise fall straight into runPvpTurn and
    // bring the whole character layer with it. Everything wager routes here
    // instead, and runPvpTurn refuses a wager state as a backstop.
    const wagerBs = inPvp(player) && isWagerState(player.battleState) ? player.battleState : null
    if (wagerBs) {
      if (W_ATTACK.has(sub) || sub === 'attack') return runWagerAction(ctx, 'attack', '')
      if (W_SKILL.has(sub)  || sub === 'skill')  return runWagerAction(ctx, 'skill', args.slice(1).join(' '))
      if (W_DEFEND.has(sub) || sub === 'defend') return runWagerAction(ctx, 'defend', '')
      if (W_DRINK.has(sub))  return runWagerItem(ctx, 'drink', args.slice(1).join(' '))
      if (W_TOTEM.has(sub))  return runWagerItem(ctx, 'totem', '')
      if (W_ARMOR.has(sub))  return runWagerItem(ctx, 'armor', args.slice(1).join(' '))
      if (W_WEAPON.has(sub)) return runWagerItem(ctx, 'weapon', args.slice(1).join(' '))
      if (W_MEND.has(sub))   return runWagerItem(ctx, 'mend', args.slice(1).join(' '))
      if (W_REFILL.has(sub)) return runWagerItem(ctx, 'refill', '')
    }

    // ── ATTACK / SKILL / DEFEND / ABILITY / CINDER VERDICT / ULTIMATE / WILD CARD ──
    const CINDER_ALIASES = new Set(['cinderverdict', 'cinder', 'cv', 'verdict'])
    const ULTIMATE_ALIASES = new Set(['ultimate', 'dragon'])
    const WILDCARD_ALIASES = new Set(['wildcard', 'wc', 'wild', 'card'])
    const DOMAIN_ALIASES = new Set(['domain', 'domainexpansion', 'domain-expansion', 'de', 'chimera'])
    const THIEFSEYE_ALIASES = new Set(['thiefseye', 'thiefs-eye', 'steal', 'te', 'mimic'])
    const HOLLOW_ALIASES = new Set(['hollowexchange', 'hollow-exchange', 'hollow', 'exchange', 'hx'])
    const HOLLOWPURPLE_ALIASES = new Set(['hollowpurple', 'purple', 'hollow-purple'])
    const UNLIMITEDVOID_ALIASES = new Set(['unlimitedvoid', 'unlimited-void', 'void', 'uv'])
    const SOULPUNISHER_ALIASES = new Set(['soulpunisher', 'soulpunish', 'soul-punisher', 'punisher', 'spunisher', 'kiblast'])
    const KAMEHAMEHA_ALIASES = new Set(['kamehameha', 'bbk', 'bigbang', 'bigbangkamehameha', 'kame', 'big-bang-kamehameha'])
    const PUPPET_ALIASES = new Set(['puppetstrings', 'puppet-strings', 'puppet', 'puppetry', 'strings', 'marionette'])
    const KURAMA_ALIASES = new Set(['kurama', 'baryon', 'kuramamode', 'ninetails', 'bijuu', 'krm'])
    const TIMESTOP_ALIASES = new Set(['timestop', 'time-stop', 'tms', 'stoptime'])
    const KUROHITSUGI_ALIASES = new Set(['kurohitsugi', 'kuro', 'blackcoffin', 'black-coffin', 'coffin', 'hado90'])
    const HOUGYOKU_ALIASES = new Set(['hougyoku', 'hogyoku', 'transcend', 'transcendence', 'the-one-above-all'])
    const GREED_ALIASES = new Set(['greed', 'tithe', 'greedgrab', 'gospel', 'gospelofgreed', 'witchs-grasp', 'stealgreed'])
    if (sub === 'attack' || sub === 'skill' || sub === 'defend' || sub === 'ability' || CINDER_ALIASES.has(sub) || ULTIMATE_ALIASES.has(sub) || WILDCARD_ALIASES.has(sub) || DOMAIN_ALIASES.has(sub) || THIEFSEYE_ALIASES.has(sub) || HOLLOW_ALIASES.has(sub) || HOLLOWPURPLE_ALIASES.has(sub) || UNLIMITEDVOID_ALIASES.has(sub) || SOULPUNISHER_ALIASES.has(sub) || KAMEHAMEHA_ALIASES.has(sub) || PUPPET_ALIASES.has(sub) || KURAMA_ALIASES.has(sub) || TIMESTOP_ALIASES.has(sub) || KUROHITSUGI_ALIASES.has(sub) || HOUGYOKU_ALIASES.has(sub) || GREED_ALIASES.has(sub)) {
      if (!inPvp(player)) {
        return ctx.reply(`❌ You're not in a duel. Challenge someone: *${pr}pvp @target*`)
      }
      if (!player.battleState.myTurn) {
        const waited = idleMs(player.battleState)
        return ctx.reply(
          `⏳ It's not your turn yet — wait for your opponent to move.\n` +
          (waited >= TURN_TIMEOUT_MS
            ? `_They've stalled for ${formatDuration(waited)}. Take the win with *${pr}pvp claim*._`
            : `_Stalling? You can claim the win after ${formatDuration(TURN_TIMEOUT_MS - waited)} of silence._`),
        )
      }
      const resolvedAction = CINDER_ALIASES.has(sub)
        ? 'cinderverdict'
        : ULTIMATE_ALIASES.has(sub)
          ? 'ultimate'
          : WILDCARD_ALIASES.has(sub)
            ? 'wildcard'
            : DOMAIN_ALIASES.has(sub)
              ? 'domain'
              : THIEFSEYE_ALIASES.has(sub)
                ? 'thiefseye'
                : HOLLOW_ALIASES.has(sub)
                  ? 'hollowexchange'
                  : HOLLOWPURPLE_ALIASES.has(sub)
                    ? 'hollowpurple'
                    : UNLIMITEDVOID_ALIASES.has(sub)
                      ? 'unlimitedvoid'
                      : SOULPUNISHER_ALIASES.has(sub)
                        ? 'soulpunisher'
                        : KAMEHAMEHA_ALIASES.has(sub)
                          ? 'kamehameha'
                          : PUPPET_ALIASES.has(sub)
                            ? 'puppetstrings'
                            : KURAMA_ALIASES.has(sub)
                              ? 'kurama'
                              : TIMESTOP_ALIASES.has(sub)
                                ? 'timestop'
                                : KUROHITSUGI_ALIASES.has(sub)
                                  ? 'kurohitsugi'
                                  : HOUGYOKU_ALIASES.has(sub)
                                    ? 'hougyoku'
                                    : GREED_ALIASES.has(sub)
                                      ? 'greedtithe'
                                      : sub
      return runPvpTurn(ctx, resolvedAction, args.slice(1).join(' '))
    }

    // ── CHALLENGE (default), and its WAGER variant ────────────────────────
    if (inPvp(player)) {
      return ctx.reply(
        isWagerState(player.battleState)
          ? `❌ You're already in a wager duel. *${pr}pvp status* for the board, *${pr}pvp forfeit* to concede _(you lose the stake)_.`
          : `❌ You're already in a duel. Use *${pr}pvp moves* to see your options, or *${pr}pvp forfeit* to concede.`,
      )
    }

    // A wager challenge is the same challenge with a stake attached, so it runs
    // the identical path below (daily slots, group gate, target-busy checks) and
    // only shifts where the target token sits: `pvp wager 5k @them`.
    const isWagerChallenge = WAGER_ALIASES.has(sub)
    let wagerAmount = 0
    if (isWagerChallenge) {
      const purse = player.wallet?.solars ?? 0
      wagerAmount = parseStake(args[1], purse) ?? 0
      if (!wagerAmount) {
        return ctx.reply(
          `❓ Usage: *${pr}pvp wager <amount> @target*\n` +
          `_Example:_ *${pr}pvp wager 5k @them* _· "all" stakes your whole purse._\n\n` +
          `☀️ Your purse: *${purse.toLocaleString()}* solars`,
        )
      }
      if (wagerAmount < WAGER_MIN_STAKE) {
        return ctx.reply(`❌ Minimum stake is *${WAGER_MIN_STAKE.toLocaleString()}* solars.`)
      }
      if (purse < wagerAmount) {
        return ctx.reply(
          `☀️ *Not enough solars.* You staked *${wagerAmount.toLocaleString()}* but hold *${purse.toLocaleString()}*.\n` +
          `_Gems and vault balances cannot be wagered._`,
        )
      }
    }

    // `rematch` reuses the whole challenge path below — it only substitutes
    // the target, so daily slots, group gates and busy checks all still apply.
    const isRematch = sub === 'rematch' || sub === 'again'
    if (isRematch && !player.pvp?.lastOpponentJid) {
      return ctx.reply(`❌ You haven't finished a duel yet — nobody to rematch.`)
    }
    const targetJid = isRematch
      ? player.pvp.lastOpponentJid
      : resolveTargetJid(ctx, isWagerChallenge ? args[2] : args[0])
    if (!targetJid) {
      return ctx.reply(
        isWagerChallenge
          ? `❓ Usage: *${pr}pvp wager ${wagerAmount} @target* — reply to or @mention who you want to stake against.`
          : `❓ Usage: *${pr}pvp @target* — reply to or @mention who you want to duel.`,
      )
    }
    if (targetJid === ctx.from) return ctx.reply(`❌ You can't duel yourself.`)
    if (!playerExists(db, targetJid)) return ctx.reply(`❌ That player isn't registered yet.`)
    if (player.inDungeon) return ctx.reply(`🗺️ Exit the dungeon first. Use *${pr}dungeon leave*.`)

    const perks = perksFor(db, player)
    const remaining = pvpChallengesRemaining(player, perks.duelSlots)
    if (remaining <= 0) {
      const limit = pvpChallengeLimit(player, perks.duelSlots)
      return ctx.reply(
        `⏳ You've used all *${limit}* of your duel challenges today.\n` +
        (perks.duelSlots > 0 ? `_(includes +${perks.duelSlots} from your ${perks.tier.name})_\n` : '') +
        (isPremiumActive(player)
          ? `_Come back tomorrow for ${limit} more._`
          : `_Premium members get *${PREMIUM_DAILY_PVP_LIMIT}* duels a day instead of *${FREE_DAILY_PVP_LIMIT}* — check *${pr}premium*._`) +
        (perks.duelSlots === 0 ? `\n_A guild hall grants extra slots too — see *${pr}guild perks*._` : ''),
      )
    }

    const target = getPlayer(db, targetJid)
    if (target.inBattle) return ctx.reply(`⚔️ *${target.name}* is already in a battle.`)
    if (target.inDungeon) return ctx.reply(`🗺️ *${target.name}* is deep in a dungeon right now.`)
    if (target.pvpChallenge && Date.now() < target.pvpChallenge.expiresAt) {
      return ctx.reply(`⏳ *${target.name}* already has a pending duel challenge.`)
    }
    // Checked here as a courtesy, and AGAIN at accept where the escrow actually
    // happens. Both checks are needed: this one stops a challenge nobody can
    // answer, and the one at accept is the one that is authoritative, because
    // either side can spend their purse during the two minutes in between.
    if (isWagerChallenge && (target.wallet?.solars ?? 0) < wagerAmount) {
      return ctx.reply(
        `☀️ *${target.name}* only holds *${(target.wallet?.solars ?? 0).toLocaleString()}* solars, ` +
        `so they cannot cover a *${wagerAmount.toLocaleString()}* stake.\n_Name a smaller number._`,
      )
    }

    await updatePlayer(db, targetJid, (t) => {
      t.pvpChallenge = {
        fromJid: ctx.from,
        expiresAt: Date.now() + CHALLENGE_TIMEOUT_MS,
        // 0 on a normal challenge, which is what the accept path branches on.
        wagerAmount,
      }
    })

    let remainingAfter = 0
    await updatePlayer(db, ctx.from, (p) => {
      consumePvpChallenge(p)
      remainingAfter = pvpChallengesRemaining(p, perks.duelSlots)
    })

    if (isWagerChallenge) {
      return ctx.reply(
        `💰🔥 *WAGER CHALLENGE!* 🔥💰\n\n` +
        `⚔️ *${player.name}* stakes *☀️ ${wagerAmount.toLocaleString()} solars* against *${target.name}*!\n\n` +
        `❤️ ${player.name}: ${player.hp}/${player.maxHp}   ❤️ ${target.name}: ${target.hp}/${target.maxHp}\n\n` +
        `📜 *WAGER RULES*\n` +
        `• No turns. Either fighter may swing at any moment.\n` +
        `• 2 second cooldown between your own moves.\n` +
        `• You cannot use the same move twice in a row.\n` +
        `• No character powers. Raw stats, skills and items only.\n` +
        `• The loser pays the *full* stake. Both stakes are held the moment this is accepted.\n\n` +
        `*${target.name}*, answer with *${pr}pvp accept* or *${pr}pvp decline* within 2 minutes.\n` +
        `_Pack your kit first: *${pr}pvp inv* · *${pr}pvp stock <item>*_\n\n` +
        `_🥊 Duel challenges left today: ${remainingAfter}_`,
      )
    }

    return ctx.reply(
      (isRematch ? `🔁 *REMATCH!*\n\n` : '') +
      `⚔️ *${player.name}* challenges *${target.name}* to a duel!\n\n` +
      `❤️ ${player.name}: ${player.hp}/${player.maxHp}   ❤️ ${target.name}: ${target.hp}/${target.maxHp}\n\n` +
      `*${target.name}*, use *${pr}pvp accept* or *${pr}pvp decline* within 2 minutes.\n` +
      `_Size them up first — reply to their message with *${pr}scout*._\n\n` +
      `_🥊 Duel challenges left today: ${remainingAfter}_`,
    )
  },
}

/**
 * showMoves — every move available this turn, each tagged usable or not.
 *
 * This is the fix for the single most annoying thing about duelling over
 * chat: `.pvp skill <name>` demands a name the player cannot see, so they
 * guessed, ate "you don't know that skill", and lost tempo to a typo. The
 * costs and cooldowns printed here are read off the live battleState, so
 * what it says is usable really is usable.
 */
async function showMoves(ctx) {
  const { player, db } = ctx
  const pr = config.prefix
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel. Challenge someone: *${pr}pvp @target*`)
  }
  // A wager duel has a different move list (no abilities at all, PP instead of
  // cooldowns, item actions that cost no turn), so it gets its own panel rather
  // than a moveOptions() list half of which would be a lie here.
  if (isWagerState(player.battleState)) return showWagerMoves(ctx)
  const opponentJid = player.battleState.opponentJid
  const opponent = playerExists(db, opponentJid) ? getPlayer(db, opponentJid) : null
  if (!opponent) return ctx.reply(`❌ Your opponent is no longer registered.`)

  const knownSkills = (player.skills ?? [])
    .map(id => allSkills.find(s => s.id === id))
    .filter(Boolean)
  const equipped = (player.equippedAbilities ?? []).map(getAbilityDef).filter(Boolean)
  const moves = moveOptions(player, knownSkills, equipped, player.battleState.turn ?? 1)

  const KIND_ICON = { attack: '⚔️', skill: '✨', ability: '🌟', passive: '🔸', defend: '🛡️' }
  const lines = moves.map((m) => {
    const mark = m.usable ? '✅' : '⛔'
    const how = m.kind === 'skill' ? `${pr}pvp skill ${m.name}`
      : m.kind === 'ability' ? `${pr}pvp ability ${m.name}`
      : m.kind === 'defend' ? `${pr}pvp defend`
      : m.kind === 'attack' ? `${pr}pvp attack`
      : null
    return `${mark} ${KIND_ICON[m.kind] ?? '•'} *${m.name}* — _${m.note}_` +
      (how ? `\n    \`${how}\`` : '')
  })

  // Circe's Wild Card isn't in moveOptions() (that lives in lib/pvp-engine.js
  // and only knows skills/abilities/attack/defend), but unlike Cinder Verdict
  // it's a limited resource the player needs to be able to count mid-duel — so
  // it gets appended here when she's the equipped character.
  if (hasCirce(player)) {
    const left = wildCardUsesLeft(player)
    lines.push(
      `${left > 0 ? '✅' : '⛔'} 🃏 *Wild Card* — _one of six fates, no MP · ${left}/${WILD_CARD_MAX_USES} draws left_` +
      `\n    \`${pr}pvp wildcard\``,
    )
  }

  // Gogeta's two actives, appended for the same reason: neither is in
  // moveOptions(), and both are things the player has to be able to count
  // mid-duel — a turn cooldown each, a full energy bar on the ultimate, and a
  // fusion clock over the top of it that takes the ultimate away for good when
  // it runs out. Odds are never printed anywhere in his kit, but timers are.
  if (hasGogeta(player)) {
    const cd = gogetaCooldowns(player, player.battleState)
    const fuse = fusionTurnsLeft(player, player.battleState)
    const broken = !!player.battleState.fusionBroken
    const needed = Math.max(1, Math.ceil(player.maxMp ?? 0))
    const bbkReady = cd.kamehameha === 0 && (player.mp ?? 0) >= needed && !broken
    lines.push(
      `${cd.soulPunisher === 0 ? '✅' : '⛔'} 🔵 *Soul Punisher* — _ranged ki, no MP · ` +
      `${cd.soulPunisher === 0 ? 'ready' : `${cd.soulPunisher}t cooldown`}_` +
      `\n    \`${pr}pvp soulpunisher\``,
    )
    lines.push(
      `${bbkReady ? '✅' : '⛔'} 🔵💥 *Big Bang Kamehameha* — _ignores DEF · ` +
      (broken
        ? 'the fusion has broken, gone for this fight'
        : cd.kamehameha > 0
          ? `${cd.kamehameha}t cooldown`
          : bbkReady
            ? 'full bar, ready'
            : `needs a full bar: ${player.mp ?? 0}/${needed} MP`) +
      `_\n    \`${pr}pvp kamehameha\``,
    )
    if (fuse > 0) {
      lines.push(`🔸 🔵 *Fusion of Equals* — _+STR, +AGI · ${fuse} turn${fuse === 1 ? '' : 's'} left_`)
    }
  }

  return ctx.reply(
    `🎯 *YOUR MOVES* — turn ${player.battleState.turn ?? 1}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${lines.join('\n')}\n\n` +
    `${suggestMove(player, opponent, moves)}\n\n` +
    (player.battleState.myTurn
      ? `_It's your turn — pick one._`
      : `_Waiting on *${opponent.name}*. Nothing you pick lands until they move._`),
  )
}

/** showStatus — the board, without spending a turn to see it. */
async function showStatus(ctx) {
  const { player, db } = ctx
  const pr = config.prefix
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel. Challenge someone: *${pr}pvp @target*`)
  }
  const opponentJid = player.battleState.opponentJid
  const opponent = playerExists(db, opponentJid) ? getPlayer(db, opponentJid) : null
  if (!opponent) return ctx.reply(`❌ Your opponent is no longer registered.`)

  // Wager mode has no turn to report and three things normal PvP has no concept
  // of (the cooldown, the blocked moves, gear durability), so it prints its own
  // board. Reading it is free: no cooldown bump, no repeat-window entry.
  if (isWagerState(player.battleState)) {
    return ctx.reply(wagerBoard(player, opponent, pr))
  }

  const mine = effectLine(player)
  const theirs = effectLine(opponent)
  const waited = idleMs(player.battleState)

  return ctx.reply(
    `🩸 *DUEL STATUS* — turn ${player.battleState.turn ?? 1}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    statusBoard(player, opponent) + `\n\n` +
    (mine ? `🌀 You: ${mine}\n` : '') +
    (theirs ? `🌀 ${opponent.name}: ${theirs}\n` : '') +
    (player.battleState.defending ? `🛡️ _You're braced — the next hit is halved._\n` : '') +
    `\n${player.battleState.myTurn ? `▶️ *It's your turn.*` : `⏸️ Waiting on *${opponent.name}* _(${formatDuration(waited)} so far)_`}\n` +
    (!player.battleState.myTurn && waited >= TURN_TIMEOUT_MS
      ? `\n⌛ _They've timed out — *${pr}pvp claim* takes the win._`
      : '') +
    `\n_*${pr}pvp moves* for what you can do about it._`,
  )
}

/**
 * claimStale — the escape hatch for an abandoned duel.
 *
 * A duel writes `inBattle = true` to BOTH players and only pvpConclude()
 * clears it, so an opponent who simply walks away used to lock the other
 * player out of every inBattle-gated command with no way back. The timeout
 * is compared on read (no scheduler, survives restarts, can't fire against
 * someone mid-message) — see TURN_TIMEOUT_MS in lib/pvp-engine.js.
 */
async function claimStale(ctx) {
  const { player, db } = ctx
  const pr = config.prefix
  if (!inPvp(player)) return ctx.reply(`❌ You're not in a duel.`)

  const opponentJid = player.battleState.opponentJid

  // Opponent gone entirely — release this player rather than stranding them.
  if (!playerExists(db, opponentJid)) {
    // ── GUILD WAR pairing: the absent champion's opponent takes the point.
    // Settle the war FIRST — settleWalkover clears both fighters (Preset 5
    // and all) and drives the bracket on — before any ordinary duel cleanup.
    const warFound = findActiveWarMatchFor(db, ctx.from, opponentJid)
    if (warFound) {
      await settleWalkover(
        db, warFound.war, warFound.matchIdx, ctx.from, ctx,
        `_*The opposing champion is gone from the roster — the pairing is awarded on the spot.*_`,
      )
      return undefined
    }

    // A wager duel has real solars sitting in escrow on this player's own
    // battleState. Clearing the state without paying that back would delete
    // them, so the refund happens here, before the state is dropped.
    const stake = isWagerState(player.battleState) ? (player.battleState.wagerAmount ?? 0) : 0
    if (stake > 0) {
      let back = 0
      await updatePlayer(db, ctx.from, (p) => {
        back = refundStake(p, stake)
        clearWagerState(p)
      })
      return ctx.reply(
        `🧹 Your opponent no longer exists — wager duel voided.\n` +
        `☀️ Your *${stake.toLocaleString()}* solar stake is back. _(balance: ${back.toLocaleString()})_`,
      )
    }
    await clearBattle(db, ctx.from)
    return ctx.reply(`🧹 Your opponent no longer exists — duel cleared. You're free.`)
  }

  // ── Wager duels time out on silence, not on a turn ──────────────────────
  // Both sides carry myTurn: true in this mode, so the "it's your turn, you
  // can't claim on yourself" rule below has nothing to measure. The idle clock
  // is the only fair signal: whoever last touched the duel is still fighting.
  if (isWagerState(player.battleState)) {
    const idle = wagerIdleMs(player.battleState)
    const opp = getPlayer(db, opponentJid)
    if (idle < WAGER_IDLE_TIMEOUT_MS) {
      return ctx.reply(
        `⏳ The duel is still live — last move was ${formatDuration(idle)} ago.\n` +
        `_A wager duel is only claimable after ${formatDuration(WAGER_IDLE_TIMEOUT_MS)} of total silence._\n` +
        `_Swing instead: *${pr}pvp atk*._`,
      )
    }
    // Nobody moved for five minutes, including the claimant. Neither side wins
    // a stake off that, so both are refunded and the duel is voided.
    return voidWagerDuel(
      db, ctx, ctx.from, opponentJid,
      `⌛ *WAGER VOID* — nothing happened for ${formatDuration(idle)}.`,
      opp.name,
    )
  }

  if (player.battleState.myTurn) {
    return ctx.reply(
      `❌ It's *your* turn — you can't claim a timeout on yourself.\n` +
      `_Move with *${pr}pvp moves*, or concede with *${pr}pvp forfeit*._`,
    )
  }

  const waited = idleMs(player.battleState)
  if (!isStale(player.battleState)) {
    const opponent = getPlayer(db, opponentJid)
    return ctx.reply(
      `⏳ *${opponent.name}* still has time — they've been idle ${formatDuration(waited)}.\n` +
      `_You can claim the win after ${formatDuration(TURN_TIMEOUT_MS - waited)} more of silence._`,
    )
  }

  const opponent = getPlayer(db, opponentJid)
  // allowRewind: false — the loser here never took a fatal hit, they just
  // stopped answering. Rewinding would drag the claimant back into a duel
  // against someone who has already walked away, twice over.
  return pvpConclude(
    db, ctx.from, opponentJid, ctx,
    `_${opponent.name} stalled for ${formatDuration(waited)} and forfeits on time!_`,
    { allowRewind: false },
  )
}

/**
 * runPvpTurn — resolves exactly one player's move against their opponent.
 * Mirrors attack.js/skill.js/defend.js's per-turn structure (status ticks,
 * beast intervention at the same checkpoints, durability wear) but for two
 * real players instead of player-vs-monster.
 */
/**
 * Backstop on the loop below. Two Yoriichi owners can duel (she is `exclusive`,
 * not unique), so if both fall, both cat forms answer each other with no human
 * in the loop at all — that has to be bounded. It should never be reached: a
 * level-appropriate strike at CAT_FORM_ATTACK_MULT is a few hundred damage and
 * her pool is 3,000, so ~40 unanswered turns settles it many times
 * over. If it somehow is reached, the fight is left mid-duel and simply resumes
 * on the next command — the cap never decides a winner.
 */
const CAT_FORM_PVP_MAX_AUTO_TURNS = 40

/**
 * autoResolveCatFormTurns(db, ctx, aJid, bJid, { lead }) -> { text, concluded }
 *
 * The whole point of Yoriichi's rebuild, PvP side: the moment the turn baton
 * lands on a player she is fighting for, SHE TAKES IT. The owner is unconscious.
 * They do not get the turn, they are not asked for a move, and they are never
 * told the turn is theirs.
 *
 * Call this immediately after any flip of `battleState.myTurn`. It looks at who
 * actually holds the baton, and while that side has cat form active it resolves
 * her attack, hands the baton straight back to the other side, and looks again.
 * The loop is what handles both-sides-in-cat-form: they trade blows until one
 * pool empties, with nobody typing anything.
 *
 * Returns concluded: true when the duel is over — pvpConclude() has already run
 * and replied, so the caller must return without sending anything else. On
 * concluded: false the caller appends `text` to its own message; `lead` is the
 * narration the caller has accumulated so far, needed here only so a duel that
 * ends inside the loop still shows the turn that ended it.
 *
 * Not called from pvpAccept(): a duel starts with both sides freshly healed and
 * a brand-new battleState, so cat form cannot already be up at the opening bell.
 */
async function autoResolveCatFormTurns(db, ctx, aJid, bJid, { lead = '' } = {}) {
  let text = ''

  for (let i = 0; i < CAT_FORM_PVP_MAX_AUTO_TURNS; i++) {
    const a = getPlayer(db, aJid)
    const b = getPlayer(db, bJid)
    if (!inPvp(a) || !inPvp(b)) return { text, concluded: true }

    // Read the baton rather than being told where it is — this is called from
    // three different flip sites and one refusal path.
    const holderJid = a.battleState.myTurn ? aJid : b.battleState.myTurn ? bJid : null
    if (!holderJid) return { text, concluded: false } // nobody holds it; a conclude is in flight
    const waiterJid = holderJid === aJid ? bJid : aJid
    const holder = holderJid === aJid ? a : b
    if (!isCatFormActive(holder)) return { text, concluded: false } // a human's turn — leave it

    // ── Her turn. Same read-fresh-snapshot / one-updatePlayer-at-a-time pattern
    // the rest of this file uses instead of nesting (see runPvpTurn's header).
    let turnText =
      `\n🐈‍⬛ *YORIICHI'S TURN* — _${holder.name} is down; she answers for them._\n`
    let opponentDefeated = false
    await updatePlayer(db, waiterJid, (opp) => {
      // isOpponentLive() treats an active cat form as still standing (their
      // owner-hp is pinned on purpose) — this only skips when there is genuinely
      // nothing left for the hit to land on.
      if (!isOpponentLive(opp)) {
        opponentDefeated = true
        return
      }
      // No skill, no MP, no owner input: resolveCatFormAction() takes an actor
      // and a target and nothing else. She picks her own move.
      const action = resolveCatFormAction(holder, opp)
      turnText += action.message
      if (action.opponentDefeated) opponentDefeated = true
    })
    text += turnText

    if (opponentDefeated) {
      await pvpConclude(db, holderJid, waiterJid, ctx, (lead + text).trim())
      return { text, concluded: true }
    }

    // ── Baton straight back to the other side. It never rests on her owner.
    // lastMoveAt is stamped on both records as usual, which also means a
    // cat-form owner can no longer lose by `.pvp claim` (see claimStale) for
    // "not moving" while she is fighting for them.
    const movedAt = Date.now()
    await updatePlayer(db, holderJid, (h) => {
      if (!h.battleState) return
      h.battleState.myTurn = false
      h.battleState.turn = (h.battleState.turn ?? 1) + 1
      h.battleState.lastMoveAt = movedAt
    })
    await updatePlayer(db, waiterJid, (w) => {
      if (!w.battleState) return
      w.battleState.myTurn = true
      w.battleState.lastMoveAt = movedAt
    })
  }

  // Cap hit — both sides are cat forms that refused to die. Nothing is decided;
  // say so plainly rather than inventing a result.
  return {
    text: text + `\n_Both cat forms are still standing. The duel goes on._\n`,
    concluded: false,
  }
}

async function runPvpTurn(ctx, action, skillQuery) {
  if (isBattleCinematicActive(ctx)) return
  const { db } = ctx
  const actorJid = ctx.from

  // ── Pre-flight checks + snapshot the actor (read-only, no lock held) ────
  // We deliberately do NOT nest updatePlayer(opponentJid, ...) inside
  // updatePlayer(actorJid, ...) below — updatePlayer() serializes every
  // call on one shared global queue (see lib/player-repo.js's writeQueue),
  // and a queued task only frees the queue once its mutatorFn resolves. A
  // nested call sits behind its own still-running outer call on that same
  // queue, so it can never run — every PvP turn deadlocked until the 20s
  // withTimeout ceiling fired and threw. Instead we run one updatePlayer
  // per player, sequentially, same top-level pattern pvpConclude uses,
  // and pass state between the two mutator calls via plain variables.
  const actorSnapshot = getPlayer(db, actorJid)
  // ── Wager mode never enters this function ───────────────────────────────
  // This is the ONE place the character layer is refused, and it is here rather
  // than at each of the twelve entry points (`.pvp attack`, `.cinderverdict`,
  // `.wildcard`, `.ultimate`, `.domain`, `.purple`, `.thiefseye`,
  // `.hollowexchange`, `.unlimitedvoid`, ...) because every one of them funnels
  // through runPvpTurn. A signature move added later cannot leak into a wager
  // duel by forgetting a guard, since there is only one guard to forget.
  if (isWagerState(actorSnapshot?.battleState)) {
    return ctx.reply(
      `🚫 *No character powers in a wager duel.*\n` +
      `_Raw stats, skills and your kit decide this one._\n\n` +
      `⚔️ *${config.prefix}pvp atk* · ✨ *${config.prefix}pvp sk <name>* · 🛡️ *${config.prefix}pvp def*\n` +
      `_Full board: *${config.prefix}pvp status*_`,
    )
  }
  if (!inPvp(actorSnapshot) || !actorSnapshot.battleState.myTurn) {
    return ctx.reply(`⏳ It's not your turn yet.`)
  }
  const opponentJid = actorSnapshot.battleState.opponentJid
  if (!playerExists(db, opponentJid)) {
    await updatePlayer(db, actorJid, (actor) => {
      actor.inBattle = false
      actor.battleState = null
    })
    return ctx.reply(`❌ Your opponent is no longer registered — duel cancelled.`)
  }

  let msg = ''
  let hpBeforeTurn = 0
  let opponentDefeated = false
  let selfDefeated = false
  let incapacitated = false
  let catFormAnswers = false // Yoriichi holds this turn — she resolves it, not the owner
  let catFormOwnDefeat = false // her own pool ran out to a DOT before she could swing
  let cinderMult = 0 // set when action === 'cinderverdict', once the charge is burned
  // ── Naruto's Baryon Mode (action === 'kurama') ──────────────────────────
  // Same shape as cinderMult: the gate burns the once-per-battle charge (AND a
  // slice of Naruto's own health, the Baryon self-cost) in the actor's own
  // updatePlayer below and hands back two numbers. kuramaMult flows through the
  // shared opponent-hit phase exactly like cinderMult, so DEF, the accuracy
  // roll, and the defender's dodge / Wheel / beast / shield all still apply.
  // kuramaDrainPct is applied there as a true-damage rider AFTER the strike,
  // a flat share of the opponent's max HP that no armour softens.
  let kuramaMult = 0
  let kuramaDrainPct = 0
  // ── Echidna's Gospel of Greed (action === 'greedtithe') ──────────────────
  // Same shape as kuramaMult: the gate burns the once-per-battle charge in
  // the actor's own updatePlayer below and rolls her MOOD; the theft itself
  // resolves in the opponent write (it has to come off their REAL wallet),
  // and the holder's credit lands in a second actor write after, the exact
  // opponent-then-actor split hollowexchange uses.
  let greedMood = null
  let greedTaken = null // { solarsTaken, gemsTaken, child } once the opp write lands
  // Carries "send the Nine Tails summon splash" out past the mutations, the same
  // way domainSplash / kamehamehaSplash do (no network I/O inside updatePlayer).
  let kuramaSplash = false
  // ── Gojo's Hollow Purple (action === 'hollowpurple') ────────────────────
  // Same shape as cinderMult: the gate burns the once-per-battle charge in the
  // actor's own updatePlayer below and hands back the 18x multiplier, which the
  // opponent-hit phase applies through calcPlayerDamage — RAW, bypassing DEF and
  // skipping the accuracy roll, exactly as plugins/purple.js does in PvE.
  let hollowPurpleMult = 0
  // ── Gogeta's two actives ────────────────────────────────────────────────
  // Same shape again. soulPunisherMult is mitigated by DEF and just skips the
  // accuracy roll; kamehamehaMult behaves exactly like hollowPurpleMult (raw,
  // no DEF, no accuracy roll). gogetaExtra carries the Instant Transmission
  // "no cooldown" line out of the gate so the turn text can show it, and
  // kamehamehaSplash carries "send the beam art" out past the mutations, the
  // same way domainSplash does below (no network I/O inside updatePlayer).
  let soulPunisherMult = 0
  let kamehamehaMult = 0
  let gogetaExtra = ''
  let kamehamehaSplash = false
  // ── Megumi's Chimera Shadow Garden (action === 'domain') ────────────────
  // Same shape as cinderMult above: the gate runs in the actor's own
  // updatePlayer below and hands back the opening-horde multiplier, which the
  // opponent-hit phase applies through calcPlayerDamage. domainSplash carries
  // "show the Domain art" out to after the mutations (no network I/O inside
  // updatePlayer). wheelSpinCaption does the same for Mahoraga's Wheel-spin
  // GIF, which is sent as its own message before the turn text.
  let domainMult = 0
  let domainSplash = null
  let wheelSpinCaption = null
  // ── Circe's Wild Card (action === 'wildcard') ──────────────────────────
  // The draw happens in the actor's own updatePlayer below, so what the card
  // turned out to be has to be carried into the opponent-hit phase through
  // plain variables — same reason cinderMult exists rather than re-deriving.
  // Only 2 of her 6 cards deal damage at all; the 3 defensive ones arm state
  // on her battleState that applyIncomingDamage() reads on the OPPONENT's
  // turn, and Vanishing Act ends the duel outright (wildCardVanished).
  let wildCardMult = 0
  let wildCardIgnoreDefense = false
  let wildCardGuaranteedHit = false
  let wildCardMoveName = 'WILD CARD'
  let wildCardVanished = false
  // ── Xiao's Thief's Eye (action === 'thiefseye') ─────────────────────────
  // Same carry-it-out-in-plain-variables shape as cinderMult/wildCardMult: the
  // gate runs in the actor's own updatePlayer below, and the opponent-hit phase
  // needs three things out of it — the multiplier, the echo floor (the damage
  // the stolen move originally did, times THIEFS_EYE_ECHO_MULT), and the move
  // itself, which is both what gets narrated and what gets denied on the
  // opponent's record. thiefsEyeEchoed carries whether the floor is what decided
  // the final number, so the narration only claims it when it's true.
  let thiefsEyeMult = 0
  let thiefsEyeFloor = 0
  let thiefsEyeMove = null
  let thiefsEyeEchoed = false
  // ── Minna's Hollow Exchange (action === 'hollowexchange') ────────────────
  // Carries the finished exchange out of the opponent phase so the actor's own
  // half can be written afterwards. THE SWAP NEEDS BOTH PLAYERS AT ONCE, which
  // no single updatePlayer gives us (see the no-nesting note at the top of this
  // function), so it runs in three steps: a dry-run gate in the actor phase that
  // refuses for free, the real call in the opponent phase where opp.hp is
  // writable, then a short updatePlayer on the actor to write her new HP and burn
  // the charge — the same opponent-then-actor pattern the dragon ultimate uses
  // for markDragonAsleep().
  let hollowRes = null
  let montanaCounter = null // Montana negated a .tms and struck back; applied to the caster below
  let turnEnded = false // set once we know the whole turn (incl. beast follow-ups) is resolved

  // ── Actor's own status tick + move resolution ───────────────────────────
  await updatePlayer(db, actorJid, (actor) => {
    hpBeforeTurn = actor.hp

    // Tella — Wonders of You reads whether the rival stood down (defended) on
    // their OWN last turn to decide the reprieve. Stamp it here at the top of
    // every actor turn, where `action` is unambiguously what they chose, so the
    // opponent can read it on their next turn (see the ambient hook below).
    if (actor.battleState) actor.battleState.lastActionWasDefend = (action === 'defend')

    // Urahara's permanent Tear — action-triggered tick, fires on every PvP
    // action same as PvE (see lib/character-abilities.js doc comment).
    const permaSeverLine = tickPermanentSever(actor)
    if (permaSeverLine) msg += permaSeverLine + '\n'
    if (actor.hp <= 0 && !isCatFormActive(actor)) {
      const catMsg = checkYoriichiCatForm(actor)
      if (catMsg) {
        // The turn the player typed belonged to the owner, who is now at 0 hp —
        // there is no move of theirs left to resolve, and there never will be
        // again this duel. Yoriichi takes over completely: skip the whole
        // action-resolution branch below and let autoResolveCatFormTurns() run
        // her turn (and every turn after it) once this mutator returns.
        msg += catMsg
        catFormAnswers = true
        return
      } else {
        selfDefeated = true
        return
      }
    }

    const hpBeforeActorTick = actor.hp
    const actorStatus = processStatusTurn(actor)
    if (actorStatus.lines.length) msg += actorStatus.lines.join('\n') + '\n'
    // Cat form: the owner's hp is pinned at 1 while Yoriichi fights, so the
    // tick's hp change is lifted back off the owner and redirected into HER
    // pool — matching the PvE driver in lib/combat-handlers.js. Without this a
    // burn ticks into a pinned hp bar that nothing reads and no check can act
    // on (the `!isCatFormActive` guard below is what skips it), so a DOT landed
    // before she stood up cost the duel exactly nothing.
    if (isCatFormActive(actor)) {
      const tickDelta = actor.hp - hpBeforeActorTick
      actor.hp = hpBeforeActorTick
      if (tickDelta < 0) {
        const applied = applyIncomingDamage(actor, -tickDelta)
        if (applied.message) msg += applied.message + '\n'
        if (applied.catFormDefeated) {
          msg += buildCatFormDefeatMessage()
          catFormOwnDefeat = true
          return
        }
      } else if (tickDelta > 0) {
        const healed = healCatFormPool(actor, tickDelta)
        if (healed > 0) msg += `🐈‍⬛💚 *Yoriichi* recovers *${healed} HP*!\n`
      }
    }
    if (actor.hp <= 0 && !isCatFormActive(actor)) {
      // Should not normally happen (PvP fully heals both sides between
      // matches), but guard anyway: a DOT ticking them to 0 is still a loss.
      const catMsg2 = checkYoriichiCatForm(actor)
      if (catMsg2) {
        msg += catMsg2
        catFormAnswers = true
        return
      } else {
        selfDefeated = true
        return
      }
    }

    // Mei's Final Form — automatic trigger at <=70% HP.
    const finalForm = activateFinalForm(actor)
    if (finalForm.ok) {
      msg += finalForm.message + '\n'
      void sendFinalFormVideo(ctx, finalForm.message, actorJid).catch(() => {})
    }

    // Orihime — Shun Shun Rikka, halved in duels so a fight against her ends.
    const rikka = tickShunShunRikka(actor, actor.battleState, { pvp: true })
    if (rikka) msg += rikka.message + '\n'

    if (actorStatus.incapacitated) {
      msg += `💫😵 *${actor.name} IS UNABLE TO ACT THIS TURN!*\n`
      actor.battleState.myTurn = false
      actor.battleState.turn = (actor.battleState.turn ?? 1) + 1
      incapacitated = true
      return
    }

    // Miyashi's Frostbind — if the opponent has Miyashi equipped and landed
    // a frostlock on the actor last turn, downgrade whatever action they
    // requested (skill/ability/cinderverdict) down to a basic attack. Does
    // NOT skip the turn (that's incapacitated, above) — the actor still
    // acts, just with a plain attack. See lib/effects.js's 'frostlock' doc
    // comment for why this needs an explicit gate instead of processStatusTurn.
    const frostGate = applyFrostlockGate(actor, action)
    if (frostGate.blocked) {
      msg += `🥶 *${actor.name}* is still locked by *Frostbind* — forced into a basic attack!\n`
      action = frostGate.action
    }

    // Alexa's Lovestruck, duel half — the opponent has the Witch of Love out,
    // and the actor's OWN companion has fallen for her. Same shape as the
    // Frostbind gate directly above: the turn is not skipped, the actor just
    // has to take it alone, because whatever they were about to call on is
    // stood there staring. Ticks down every turn and narrates itself once on
    // the way in and once on the way out. See armLovestruck()/applyAweGate().
    const aweGate = applyAweGate(actor, action)
    if (aweGate.message) msg += aweGate.message + '\n'
    if (aweGate.blocked) action = aweGate.action

    // Xiao's Thief's Eye — if the opponent has already stolen the move being
    // asked for, it does not exist for this player any more. Unlike Frostbind
    // above this does NOT downgrade to a basic attack: it refuses the command
    // and leaves the turn intact, the same way "you don't know a skill called
    // X" is handled below, because naming a move you no longer have is an
    // invalid command rather than a punished one. A basic attack is never
    // deniable, so there is always something left to do — see
    // applyThiefsEyeDenyGate() in lib/character-abilities.js.
    const denyGate = applyThiefsEyeDenyGate(
      actor,
      action,
      action === 'skill' ? findSkill(skillQuery, actor.skills ?? [], allSkills) : null,
    )
    if (denyGate.blocked) {
      msg += denyGate.message + '\n'
      turnEnded = true
      return
    }

    // Yoriichi took over on an earlier turn, and a command has arrived from the
    // owner anyway. It is refused outright: no MP spent, no skill handed to her,
    // and the turn is NOT consumed — because the turn was never the owner's to
    // consume. autoResolveCatFormTurns() below runs HER turn instead.
    //
    // This branch used to validate `.pvp skill <name>`, charge its MP, and pass
    // the move to her, on the reasoning that "the move is still the owner's to
    // choose." It isn't. That was the same defect as the old
    // "TURN PASSES TO <owner>" footer wearing a different hat, and it is the
    // reason resolveCatFormAction() no longer accepts a skill at all.
    //
    // Sits AFTER the incapacitation check and the Frostbind gate on purpose:
    // above them, a frostlocked or stunned owner could smuggle a full action
    // through. Below them, the checks that end the turn early still win.
    if (isCatFormActive(actor)) {
      msg +=
        `🐈‍⬛ *Yoriichi is fighting this duel.*\n` +
        `_${actor.name} is down. She doesn't take orders — your command is ignored._\n`
      catFormAnswers = true
      return
    }

    if (action === 'skill') {
      const skill = findSkill(skillQuery, actor.skills ?? [], allSkills)
      if (!skill) { msg += `❌ You don't know a skill called *"${skillQuery}"*.\n`; turnEnded = true; return }
      if ((actor.mp ?? 0) < skill.mpCost) { msg += `❌ Not enough MP for *${skill.name}*.\n`; turnEnded = true; return }
    }

    if (action === 'ability') {
      const ability = findEquippedAbility(actor, skillQuery)
      if (!ability) {
        msg += `❌ Ability *"${skillQuery}"* not found or not equipped.\n`; turnEnded = true; return
      }
      if (ability.type !== 'active') {
        msg += `⚠️ *${ability.name}* is passive — it's already applying automatically.\n`; turnEnded = true; return
      }
      actor.battleState.abilityCooldowns = actor.battleState.abilityCooldowns ?? {}
      const readyAtTurn = actor.battleState.abilityCooldowns[ability.id] ?? 0
      const currentTurn = actor.battleState.turn ?? 1
      if (currentTurn < readyAtTurn) {
        msg += `⏳ *${ability.name}* is on cooldown for *${readyAtTurn - currentTurn}* more turn(s).\n`
        turnEnded = true
        return
      }
    }

    // Wither's Cinder Verdict — once-per-battle, no MP. Burns the charge here
    // (activateCinderVerdict sets battleState.witherUsed); the 8x multiplier is
    // applied in the opponent-hit phase below via calcPlayerDamage. A failed
    // gate (wrong character / already used) does NOT consume the turn.
    if (action === 'cinderverdict') {
      const gate = activateCinderVerdict(actor)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
      cinderMult = gate.multiplier
    }

    // Xiao's Thief's Eye — once-per-battle, no MP. Burns the charge here
    // (activateThiefsEye sets battleState.thiefsEyeUsed) and reads what the
    // opponent last hit them with off battleState.lastEnemyMove, recorded in
    // the opponent-hit phase below. A failed gate — wrong character, already
    // used, or nothing named to copy yet — does NOT consume the turn.
    if (action === 'thiefseye') {
      const gate = activateThiefsEye(actor)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
      thiefsEyeMult = gate.multiplier
      thiefsEyeFloor = gate.echoFloor
      thiefsEyeMove = gate.move
    }

    // Minna's Hollow Exchange — once-per-battle, no MP. DRY RUN ONLY here: the
    // real call needs a writable opponent, which this mutator does not have, so
    // it happens in the opponent phase further down. What this buys is the free
    // refusal — "not hollow enough" and "nothing worth taking" both depend on HP
    // that moves every turn, so they are the refusals players will actually hit,
    // and neither should cost the turn or the charge. Read the opponent through a
    // plain getPlayer() snapshot, the same read-only way actorSnapshot is taken
    // up top; nesting updatePlayer here would deadlock the write queue.
    if (action === 'hollowexchange') {
      const dry = activateHollowExchange(actor, getPlayer(db, opponentJid), actor.battleState, { dryRun: true })
      if (!dry.ok) {
        if (dry.message) msg += dry.message + '\n'
        turnEnded = true
        return
      }
    }

    // Megumi's Chimera Shadow Garden — once-per-battle, 0 MP (canon: an
    // INCOMPLETE domain, cheap enough to maintain). Opening it doubles the
    // Thousand Shadows Swarm, grants shadow-travel dodge for the rest of the
    // duel and calls Mahoraga out; the opening horde's multiplier resolves in
    // the opponent-hit phase below. Deliberately still rolls accuracy there:
    // CSG has no barrier, so it grants NO sure-hit — the one thing that
    // separates it from a complete domain. A failed gate (wrong character /
    // already open) does NOT consume the turn.
    if (action === 'domain') {
      const gate = activateChimeraDomain(actor)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
      domainMult = gate.multiplier
      domainSplash = gate.message
      msg += gate.message + '\n\n'
    }

    // Gojo's Hollow Purple — once-per-battle, no MP. Burns the charge here
    // (activateHollowPurple sets battleState.hollowPurpleUsed); the 18x
    // multiplier lands in the opponent-hit phase below, applied RAW: it bypasses
    // DEF and never misses, the same as its PvE turn in plugins/purple.js. A
    // failed gate (wrong character / already used) does NOT consume the turn.
    if (action === 'hollowpurple') {
      const gate = activateHollowPurple(actor, actor.battleState)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
      hollowPurpleMult = gate.multiplier
    }

    // Gogeta's Soul Punisher — no MP, short cooldown. The gate commits the
    // cooldown (and Instant Transmission may refuse to start it, which is what
    // gate.extra reports); the multiplier lands in the opponent-hit phase,
    // mitigated by DEF but with no accuracy roll. A failed gate (wrong
    // character / still recharging) does NOT consume the turn.
    if (action === 'soulpunisher') {
      const gate = activateSoulPunisher(actor, actor.battleState)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
      soulPunisherMult = gate.multiplier
      if (gate.extra) gogetaExtra = gate.extra
    }

    // Gogeta's Big Bang Kamehameha — needs a full energy bar and empties it,
    // needs the fusion to still be holding, and carries a long cooldown. The
    // gate spends all three; the multiplier lands in the opponent-hit phase
    // applied RAW, bypassing DEF and never missing, the same as Hollow Purple.
    // A failed gate does NOT consume the turn.
    if (action === 'kamehameha') {
      const gate = activateBigBangKamehameha(actor, actor.battleState)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
      kamehamehaMult = gate.multiplier
      if (gate.extra) gogetaExtra = gate.extra
      kamehamehaSplash = true
    }

    // Gojo's Unlimited Void — once-per-battle, no MP, no damage. Burns the
    // charge here (activateUnlimitedVoid sets battleState.unlimitedVoidUsed); the
    // opponent-hit phase applies the hard stun (UNLIMITED_VOID_STUN_TURNS) and
    // the void spends the opponent's action, so no counter lands this turn. A
    // failed gate does NOT consume the turn.
    if (action === 'unlimitedvoid') {
      const gate = activateUnlimitedVoid(actor, actor.battleState)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
    }

    // Aizen's Kurohitsugi — once-per-battle, no MP. Burns the charge here
    // (activateKurohitsugi sets battleState.kurohitsugiUsed); the multiplier is
    // NOT carried out as a constant because it scales with his stolen senses
    // and how wounded the opponent already is — it is computed live in the
    // opponent-hit phase via kurohitsugiMultiplier(). Lands RAW: it bypasses
    // DEF and never misses, the same as its PvE turn in plugins/kurohitsugi.js.
    // A failed gate (wrong character / already used) does NOT consume the turn.
    if (action === 'kurohitsugi') {
      const gate = activateKurohitsugi(actor, actor.battleState)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
    }

    // Aizen's Hōgyoku — once-per-battle, no MP, no damage. The whole evolution
    // (heal, all five senses, rest-of-battle stat surge) resolves on the actor
    // right here inside their own mutator — it touches nobody else — and the
    // gate returns its own reveal copy. The opponent takes no hit this action
    // (skipsOpponentHit below), same as a defend turn: their answer is simply
    // their own turn against whatever he has become. A failed gate does NOT
    // consume the turn.
    if (action === 'hougyoku') {
      const gate = activateHogyoku(actor, actor.battleState)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
      if (gate.message) msg += gate.message + '\n'
    }

    // Echidna's Gospel of Greed - once per battle, no MP. Burns the charge
    // here (activateGreedTithe sets battleState.greedTitheUsed) and rolls her
    // mood; the opponent-hit phase lifts the money and gems straight off the
    // opponent's wallet (mood-shaped) and hangs them distracted for a turn,
    // then a second actor write credits the holder - same opponent-then-actor
    // split hollowexchange uses. A failed gate does NOT consume the turn.
    if (action === 'greedtithe') {
      const gate = activateGreedTithe(actor, actor.battleState)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
      greedMood = gate.mood
    }

    // Red Rose's Puppet Strings — once-per-battle, no MP. Burns the charge here
    // (activatePuppetStrings sets battleState.puppetStringsUsed); the
    // opponent-hit phase turns the opponent's own attack on themselves (floored,
    // never lethal) and tangles them for PUPPET_TANGLE_TURNS, so the actor-phase
    // incapacitation branch above skips their action while it holds — their
    // companion caught right along with them. A failed gate does NOT consume the
    // turn.
    if (action === 'puppetstrings') {
      const gate = activatePuppetStrings(actor, actor.battleState)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
    }

    // Reverie's Time Stop — once-per-battle, no MP. Burns the charge here
    // (activateTimeStop sets battleState.timeStopUsed); the opponent-hit phase
    // below freezes them for TIME_STOP_TURNS so their next moves are skipped by
    // the shared incapacitation branch — UNLESS they have Montana equipped, in
    // which case she negates the stop and answers with a counter (see the
    // 'timestop' branch further down). A failed gate does NOT consume the turn.
    if (action === 'timestop') {
      const gate = activateTimeStop(actor, actor.battleState)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
    }

    // Naruto's Baryon Mode — once-per-battle, no MP, but it costs NARUTO his own
    // health. activateKurama burns the charge (battleState.kuramaUsed) AND spends
    // a slice of his max HP to hold the fusion (floored, never self-lethal), then
    // hands back the strike multiplier and the lifespan-drain share. The strike
    // itself resolves through the shared opponent-hit phase below via kuramaMult
    // (so DEF, accuracy and the defender's dodge / Wheel / beast / shield all
    // still apply); the drain rider is added there as true damage. A failed gate
    // does NOT consume the turn. The self-cost is paid the moment it goes off, so
    // its line is shown here whether the strike then lands or misses.
    if (action === 'kurama') {
      const gate = activateKurama(actor, actor.battleState)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
      kuramaMult = gate.multiplier
      kuramaDrainPct = gate.drainPct
      kuramaSplash = true
      if (gate.selfCostLine) msg += gate.selfCostLine + '\n'
    }

    // The dragon's ultimate — Nisha's spin-exclusive standalone companion
    // (lib/dragon-engine.js). PvP-only, once-per-battle, gated to turn 4+.
    // True-damage kill applied in the opponent-hit phase below, NOT a
    // damageMultiplier like Cinder Verdict — see resolveDragonUltimateDamage().
    // A failed gate (no dragon / too early / already used / not PvP) does
    // NOT consume the turn, same as a failed Cinder Verdict gate above.
    if (action === 'ultimate') {
      const gate = activateDragonUltimate(actor)
      if (!gate.ok) {
        if (gate.message) msg += gate.message + '\n'
        turnEnded = true
        return
      }
    }

    // Circe's Wild Card — three draws per battle, no MP. The draw itself is
    // the turn: drawWildCard() spends one use and picks from the 5-card pool
    // (6 once she's at her limit — Vanishing Act only shows up then), and
    // resolveWildCard() applies whatever it landed on. A failed gate (wrong
    // character / hand empty) does NOT consume the turn, same as the two
    // gates above, and deliberately does not consume a draw either.
    //
    // Note this sits BELOW the Frostbind gate, which means a frostlocked
    // Circe has already had `action` rewritten to 'attack' by the time we get
    // here — she can't snap her fingers through a frostlock, and crucially
    // doesn't burn a draw failing to.
    if (action === 'wildcard') {
      if (!hasCirce(actor)) {
        msg += `🃏 *Wild Card* belongs to *Circe, the Jester* — equip her first.\n`
        turnEnded = true
        return
      }
      const draw = drawWildCard(actor, { allowEscape: true })
      if (!draw.ok) {
        msg += (draw.message ?? `🃏 Her hand is empty.`) + '\n'
        turnEnded = true
        return
      }
      const outcome = resolveWildCard(actor, draw.card, { isPvp: true, enemyIsBoss: false })
      msg += buildWildCardReveal(draw.card, draw, outcome.lines) + '\n'
      wildCardMoveName = draw.card.name.toUpperCase()

      if (outcome.kind === 'escape') {
        // 🦋 Vanishing Act — resolveWildCard() has already cleared her out of
        // the fight. Handled outside this mutator (the opponent needs clearing
        // too), so just flag it and stop the turn here.
        wildCardVanished = true
        turnEnded = true
        return
      }
      if (outcome.kind === 'damage') {
        wildCardMult = outcome.multiplier
        // Wishing Star's PvE execute is deliberately suppressed in duels (the
        // `isPvp: true` above is what does it) — a 1-in-6 draw should not
        // decide a rated match outright. It lands as a 12x hit instead, which
        // is still the single heaviest strike in the bot.
        wildCardIgnoreDefense = !!outcome.ignoreDefense
        wildCardGuaranteedHit = !!outcome.guaranteedHit
      }
      // 🃏 Final Dash / 🤡 Last Laugh / 🎪 Wings of a Butterfly fall through
      // with wildCardMult still 0: nothing to resolve against the opponent
      // this turn. resolveWildCard() armed flags on her own battleState, and
      // applyIncomingDamage() reads them when the opponent swings back.
    }

    if (action === 'defend' || action === 'ability' || action === 'cinderverdict' || action === 'ultimate' || action === 'wildcard' || action === 'domain' || action === 'thiefseye' || action === 'hollowexchange' || action === 'hollowpurple' || action === 'unlimitedvoid' || action === 'puppetstrings' || action === 'timestop' || action === 'kurama' || action === 'soulpunisher' || action === 'kamehameha' || action === 'kurohitsugi' || action === 'hougyoku' || action === 'greedtithe') {
      if (action === 'defend') {
        const mpRegen = Math.floor(actor.maxMp * 0.05)
        actor.mp = Math.min(actor.maxMp, actor.mp + mpRegen)
        msg += `🛡️🔰 *${actor.name} BRACES FOR IMPACT!* _(+${mpRegen} MP, next hit halved)_\n`
      }
      // 'ability'/'ultimate'/'wildcard' fall through with no weapon wear —
      // mirrors PvE's useability.js, which never touches durability for
      // ability use. Circe never draws a weapon at all, she draws a card.
      // 'thiefseye' and 'hollowexchange' are here for the same reason: Xiao
      // throws a technique she took, and Minna does not swing at anyone.
      // Gogeta's two moves are both ki thrown from a distance, so nothing in
      // his hand touches anything either. Aizen's two are the same shape:
      // Kurohitsugi is Hadō #90, a coffin dropped from a distance, and the
      // Hōgyoku is a transformation that holds no weapon at all.
    } else {
      const wWear = wearWeaponOnTurn(actor)
      msg += breakMessage(wWear)
    }
  })

  if (selfDefeated) {
    return pvpConclude(db, opponentJid, actorJid, ctx, `_${actorSnapshot.name} succumbs to lingering damage!_`)
  }
  if (catFormOwnDefeat) {
    // A lingering DOT drained her pool before she could swing. Same real loss as
    // any other, carrying the defeat cinematic into the conclude message.
    return pvpConclude(db, opponentJid, actorJid, ctx, msg.trim())
  }
  if (catFormAnswers) {
    // She holds this turn — either she stood up during it, or she was already up
    // and the owner's command was refused above. Either way the baton is still
    // on her owner's record, so autoResolveCatFormTurns() picks it up, resolves
    // her attack, and hands it to the other side. It keeps going while the baton
    // keeps landing on a cat form, which is also what makes a duel between two
    // Yoriichi owners resolve itself with nobody typing anything.
    const auto = await autoResolveCatFormTurns(db, ctx, actorJid, opponentJid, { lead: msg })
    if (auto.concluded) return
    msg += auto.text
    const actorAfterAuto = getPlayer(db, actorJid)
    const oppAfterAuto = getPlayer(db, opponentJid)
    return ctx.reply(msg.trim() + pvpStatusFooter(actorAfterAuto, oppAfterAuto))
  }
  if (incapacitated) {
    await updatePlayer(db, actorJid, (actor) => { if (actor.battleState) actor.battleState.lastMoveAt = Date.now() })
    await updatePlayer(db, opponentJid, (opp) => {
      opp.battleState.myTurn = true
      opp.battleState.lastMoveAt = Date.now()
    })
    // The baton just moved. If it landed on a side Yoriichi is fighting for, she
    // answers now — the opponent is not left waiting on a player who has no turn.
    const auto = await autoResolveCatFormTurns(db, ctx, actorJid, opponentJid, { lead: msg })
    if (auto.concluded) return
    msg += auto.text
    return ctx.reply(
      msg.trim() +
      pvpStatusFooter(getPlayer(db, actorJid), getPlayer(db, opponentJid)),
    )
  }
  if (wildCardVanished) {
    // 🦋 Vanishing Act in a duel — a clean exit, deliberately NOT routed
    // through pvpConclude(). Nobody won this match: no rating change on
    // either side, no solars seized, and nothing written to either player's
    // win/loss record or streak. She didn't beat them and they didn't beat
    // her; the show simply ended.
    //
    // Both sides are still cleared and fully healed, exactly the way every
    // other duel ending leaves them (pvpConclude, forfeit, tournament match),
    // so neither player walks into their next dungeon carrying duel damage.
    // She keeps the town relocation resolveWildCard() already did.
    let oppName = ''
    await updatePlayer(db, opponentJid, (opp) => {
      oppName = opp.name
      opp.hp = opp.maxHp
      opp.mp = opp.maxMp
      opp.inBattle = false
      opp.battleState = null
      opp.activeEffects = []
      clearHypnosis(opp)
    })
    await updatePlayer(db, actorJid, (actor) => {
      // resolveWildCard() already dropped inBattle/battleState and set her
      // location; this only tops her back up so both sides leave level.
      actor.hp = actor.maxHp
      actor.mp = actor.maxMp
      actor.activeEffects = []
      clearHypnosis(actor)
    })
    return ctx.reply(
      msg.trim() + `\n\n` +
      `🎪 *— THE SHOW'S OVER —*\n\n` +
      `_A puff of coloured smoke, and *${actorSnapshot.name}* is simply not there anymore._\n` +
      `📍 She turns up in *Astral Town*, entirely unbothered.\n\n` +
      `🤝 *No result.* Nobody won, nobody lost — no rating change, no solars, ` +
      `nothing on either record.\n` +
      `❤️‍🩹 *${oppName}* is left swinging at empty air, fully healed.\n\n` +
      `_Rematch: *${config.prefix}pvp rematch*_`,
    )
  }
  if (turnEnded) {
    // Skill lookup/MP failure — nothing happened, turn stays with the actor.
    return ctx.reply(msg)
  }

  const eHpBeforeTurn = getPlayer(db, opponentJid)?.hp ?? 0
  const actorForCalc = getPlayer(db, actorJid) // re-read post-mutation (mp spend, etc.)

  // ── Tella's Wonders of You — ambient, once per the actor's own turn, same
  // slot and the same two-call discipline as Frostbind / Absolute One below
  // (this file never nests updatePlayer). She lives on the ACTOR's battleState,
  // so her clock is advanced inside an actorJid mutator (the phase MUST persist)
  // and the plan it returns is applied to the OPPONENT in separate calls. She
  // reads whether the opponent stood down on their own last turn
  // (lastActionWasDefend, stamped at the top of every actor turn) to decide the
  // reprieve. The two world-enders are immune; nothing else in a duel is. She
  // ticks first among the ambient auras, so a forced loss concludes before the
  // rest run; skipped entirely if the opponent is already down this turn.
  const envyOppSnap = hasWitchOfEnvy(actorForCalc) ? getPlayer(db, opponentJid) : null
  if (envyOppSnap && isOpponentLive(envyOppSnap)) {
    const envyOppDefended = envyOppSnap?.battleState?.lastActionWasDefend === true
    let envyPlan = null
    await updatePlayer(db, actorJid, (actor) => {
      if (!actor.battleState) return
      envyPlan = advanceWondersOfEnvy(actor.battleState, {
        context: 'pvp',
        foeName: envyOppSnap?.name ?? 'your rival',
        ownerName: actor.name ?? 'you',
        immune: bypassesWondersOfEnvy(envyOppSnap),
        oppDefendedLast: envyOppDefended,
      })
    })
    if (envyPlan) {
      if (envyPlan.lines) msg += envyPlan.lines + '\n'
      if (envyPlan.art) {
        await sendImageTo(ctx, envyPlan.art, `🖤 ${actorForCalc?.name ?? 'The Witch of Envy'} takes her final form.`, ctx.sender)
      }
      if (envyPlan.halveFraction) {
        await updatePlayer(db, opponentJid, (opp) => {
          if (!isOpponentLive(opp)) return
          opp.hp = Math.max(1, Math.floor(opp.hp * envyPlan.halveFraction))
        })
      }
      if (envyPlan.forcedLoss) {
        await updatePlayer(db, opponentJid, (opp) => {
          opp.hp = 0
          // The "even after the battle" curse: consumed in pvpConclude AFTER the
          // loser is healed, so the 5% it removes reads as a wound that did not
          // close. Stamped only here, so it can never fire on an ordinary KO.
          opp.wondersCursePending = envyPlan.cursePct ?? 0.05
        })
        opponentDefeated = true
      }
    }
    if (opponentDefeated) {
      return pvpConclude(db, actorJid, opponentJid, ctx, msg)
    }
  }

  // ── Miyashi's Frostbind / Nisha's Absolute One — ambient, once per the
  // equipped side's own turn, independent of what action they chose. Both
  // move HP between actor and opponent simultaneously, so — same reason
  // updatePlayer() is never nested elsewhere in this file (see the top-of-
  // function comment) — each is split into two sequential updatePlayer
  // calls (drain the opponent, then apply the corresponding change to the
  // actor) with the amount passed between them as a plain variable.
  // ── Shunya — The Empty Vessel, the drain half ────────────────────────────
  // addStatusEffect() already refuses every DURATION debuff aimed at her, and
  // the secondaryEffect rebound further down hands those back to the caster.
  // These four ambient auras are the channels that bypass both: Frostbind,
  // Absolute One and the Thousand Shadows Swarm move HP directly, and Alya's
  // Stat Break was landing in the immunity gate and vanishing silently, which
  // read as "Alya's turn did nothing" rather than as the void refusing it.
  // Each now reports what it FAILED to take, and the whole bill is paid by the
  // caster in one place below — carried in these two accumulators because the
  // caster is mutated in a different updatePlayer() call than the target (this
  // file never nests them; see the top-of-function comment).
  //
  // Only ever one entry per turn in practice: a player has exactly one
  // equippedCharacter, so at most one of these four auras can fire.
  let voidReboundDmg = 0
  const voidReboundEffects = []

  // Premium ability passives (freeze/burn/sleep the attacker) + pack thorns
  // (Gemstone flame, Sicilian riposte) + Dark Monarch lifesteal are all
  // ATTACKER-side effects, but the hit resolves inside the opponent's
  // updatePlayer() where the actor is only a snapshot. Same split as the
  // void-rebound accumulators above: capture the numbers here, apply them to the
  // live actor further down in an actorJid updatePlayer call.
  let pvpDmgDealtToOpp = 0        // Dark Monarch lifesteal heals the actor by a share of this
  let pvpDefenderCanReact = false // the defender was struck AND is still standing

  let frostbindIntensified = false
  await updatePlayer(db, actorJid, (actor) => {
    // Only touched for the Absolute Zero one-way latch (battleState) — the
    // opponent's HP/effects mutation happens in the next updatePlayer call,
    // once we know here whether the aura is intensified yet.
    if (actor.equippedCharacter === 'miyashi' && actor.battleState) {
      frostbindIntensified = !!actor.battleState.miyashiIntensified
    }
  })
  await updatePlayer(db, opponentJid, (opp) => {
    if (!isOpponentLive(opp)) return
    const frostbind = tickFrostbindAura(actorForCalc, opp, { miyashiIntensified: frostbindIntensified })
    if (frostbind) {
      msg += frostbind.message + '\n'
      voidReboundDmg += frostbind.reboundDamage ?? 0
      if (frostbind.reboundEffects?.length) voidReboundEffects.push(...frostbind.reboundEffects)
      if (frostbind.intensified && !frostbindIntensified) {
        // Latch flipped this turn — persist it back onto the actor next.
        frostbindIntensified = true
      }
      if (!isCatFormActive(opp) && opp.hp <= 0) {
        const catMsg = checkYoriichiCatForm(opp)
        if (catMsg) {
          msg += catMsg
        } else {
          opponentDefeated = true
        }
      }
    }
  })
  if (frostbindIntensified) {
    await updatePlayer(db, actorJid, (actor) => {
      if (actor.battleState) actor.battleState.miyashiIntensified = true
    })
  }
  if (opponentDefeated) {
    return pvpConclude(db, actorJid, opponentJid, ctx, msg)
  }

  let siphonAmt = 0
  await updatePlayer(db, opponentJid, (opp) => {
    if (!isOpponentLive(opp)) return
    // applyAbsoluteOneSiphon mutates BOTH objects it's given — here we only
    // want its drain-from-opponent half, so pass a throwaway proxy for
    // 'player' (its .hp write below is discarded on purpose) and apply the
    // matching heal to the real actor in the next updatePlayer call.
    const proxyActor = { ...actorForCalc }
    const absoluteOne = applyAbsoluteOneSiphon(proxyActor, opp)
    if (absoluteOne) {
      msg += absoluteOne.message + '\n'
      siphonAmt = absoluteOne.drained ?? 0
      // Voided: nothing was drained, so the heal below is skipped and Nisha
      // pays what she reached for instead.
      voidReboundDmg += absoluteOne.reboundDamage ?? 0
    }
  })
  if (siphonAmt > 0) {
    await updatePlayer(db, actorJid, (actor) => {
      actor.hp = Math.min(actor.maxHp, actor.hp + siphonAmt)
    })
  }

  // ── Alya's Stat Break — ambient, once per the actor's own turn,
  // independent of which action they chose (mirrors Frostbind/Absolute
  // One above). Keyed off actorForCalc.battleState.turn since that's the
  // actor's own turn counter — opp's bs.turn tracks the OPPONENT's turns,
  // a different count entirely in PvP.
  await updatePlayer(db, opponentJid, (opp) => {
    if (!isOpponentLive(opp)) return
    const alyaBreak = applyAlyaStatBreak(actorForCalc, opp, actorForCalc.battleState)
    if (alyaBreak.triggered) msg += alyaBreak.message + '\n'
    if (alyaBreak.reboundEffects?.length) voidReboundEffects.push(...alyaBreak.reboundEffects)
  })

  // ── Megumi's Thousand Shadows Swarm — ambient, once per the actor's own
  // turn, same slot as Frostbind / Absolute One / Stat Break above. It drains
  // the opponent AND heals the actor, so it takes the same split-updatePlayer
  // treatment as Absolute One: run it against a throwaway actor proxy to get
  // the drain half, then apply the heal to the real actor next.
  //
  // The swarm's per-turn counter and the Domain/Mahoraga latches live on
  // bs.megumi, and actorForCalc is a post-mutation SNAPSHOT — mutating it
  // doesn't persist. So the mutated state is carried out in megumiStateAfter
  // and written back onto the actor's real battleState below, or the swarm
  // would restart at turn 1 every single turn.
  let swarmHeal = 0
  let megumiStateAfter = null
  await updatePlayer(db, opponentJid, (opp) => {
    if (!isOpponentLive(opp)) return
    const proxyActor = { ...actorForCalc }
    const bsProxy = actorForCalc.battleState
    const swarm = megumiTurnStart(proxyActor, opp, bsProxy)
    if (swarm) {
      msg += swarm.message + '\n'
      swarmHeal = swarm.healed ?? 0
      voidReboundDmg += swarm.reboundDamage ?? 0
      if (swarm.reboundEffects?.length) voidReboundEffects.push(...swarm.reboundEffects)
      megumiStateAfter = bsProxy?.megumi ?? null
      if (!isCatFormActive(opp) && opp.hp <= 0) {
        const catMsg = checkYoriichiCatForm(opp)
        if (catMsg) {
          msg += catMsg
        } else {
          opponentDefeated = true
        }
      }
    }
  })
  if (megumiStateAfter) {
    await updatePlayer(db, actorJid, (actor) => {
      if (!actor.battleState) return
      actor.battleState.megumi = megumiStateAfter
      if (swarmHeal > 0) actor.hp = Math.min(actor.maxHp, actor.hp + swarmHeal)
    })
  }
  // ── Shunya — The Empty Vessel: the void settles up ───────────────────────
  // Everything the four auras above failed to take is paid here, by the caster,
  // in the caster's own updatePlayer() call. Note what the void does NOT do:
  // she is not healed by a rebounded drain and the caster is not healed either
  // (applyAbsoluteOneSiphon/megumiTurnStart both report healed: 0 when voided).
  // Zero in both directions — otherwise she'd have unkillable sustain against
  // every lifesteal character in the roster.
  //
  // The damage goes through absorbDamage() + applyIncomingDamage(), the same two
  // steps a landed duel hit uses, rather than a raw hp subtraction: a rebound is
  // a real incoming hit with an unusual source, so the caster's shields, relics
  // and reborn-defense all still get their say. checkYoriichiCatForm() is
  // deliberately NOT consulted for the actor — the actor is by definition the
  // one with Miyashi/Nisha/Megumi/Alya equipped, and only one character can be
  // equipped at a time, so no other character's death-save can be live here.
  if (voidReboundDmg > 0 || voidReboundEffects.length) {
    let actorDefeated = false
    await updatePlayer(db, actorJid, (actor) => {
      for (const def of voidReboundEffects) applyReboundEffect(actor, def)
      if (voidReboundDmg > 0) {
        const absorbed = absorbDamage(actor, voidReboundDmg)
        const shielded = voidReboundDmg - absorbed
        const applied = applyIncomingDamage(actor, absorbed)
        if (applied.message) msg += applied.message + '\n'
        msg += `⭕ *${actor.name}* takes *${applied.damage}* from their own reaching hand.\n`
        if (shielded > 0) msg += `🛡️✨ *SHIELD ABSORBED ${shielded} DMG!*\n`
        if (applied.catFormDefeated || (actor.hp ?? 0) <= 0) actorDefeated = true
      }
    })
    if (actorDefeated) {
      // Killed by their own aura on their own turn — so the jids are REVERSED
      // here against every other pvpConclude() call in this function: the
      // opponent standing in the void is the winner.
      //
      // This check deliberately sits AHEAD of the opponentDefeated check below,
      // which is why the payment block moved above it. Megumi is the one case
      // where both sides can drop on the same turn — his swarm rebounds onto him
      // and his Domain's true strikes can still kill her — and the swarm's drain
      // resolves before those strikes do, so the rebound is chronologically
      // first and the void's owner takes the double-KO.
      msg += `\n⭕ _*It was never taken from her. It was only ever given back.*_\n`
      return pvpConclude(db, opponentJid, actorJid, ctx, msg)
    }
  }

  if (opponentDefeated) {
    return pvpConclude(db, actorJid, opponentJid, ctx, msg)
  }

  // ── Opponent takes the hit (skipped entirely for 'defend') ──────────────
  // The dragon's ultimate — true damage, no accuracy roll, no dodge, no
  // beast intervention, no defense math, and deliberately NEVER routed
  // through applyMeiSustainHeal(). Mei's sustain only intercepts damage
  // passed to applyMeiSustainHeal() before it's subtracted from hp (see
  // character-abilities.js) — resolveDragonUltimateDamage() sets opp.hp = 0
  // directly and never calls it, so an opponent equipped with Mei is NOT
  // saved by her sustain-heal against this hit. This is intentional: the
  // ultimate is a guaranteed kill with no exceptions, Mei included.
  // It cannot miss and cannot be mitigated (see lib/dragon-engine.js's file
  // doc comment for why). Yoriichi's cat form (checkYoriichiCatForm) is
  // likewise deliberately NOT checked here for the same reason — a
  // guaranteed kill has no exceptions, full stop. The cinematic sequence itself is sent separately,
  // BEFORE this function's normal turn-status footer, from plugins/pvp.js's
  // runPvpTurn caller — see the dragonUltimateSequence handling right after
  // this block.
  // A turn that lands nothing on the opponent: 'defend', and a Wild Card that
  // came up one of the three defensive cards (wildCardMult stays 0 for those —
  // they arm her own battleState instead of hitting anyone).
  const skipsOpponentHit = action === 'defend' || action === 'hougyoku' || (action === 'wildcard' && wildCardMult <= 0)

  let dragonUltimateSequence = null
  if (action === 'ultimate') {
    await updatePlayer(db, opponentJid, (opp) => {
      const { damage } = resolveDragonUltimateDamage(opp)
      dragonUltimateSequence = buildDragonUltimateSequence(actorForCalc.name, opp.name, damage)
      opponentDefeated = true
    })
    // The dragon belongs to the ACTOR, not the opponent — its sleep flag
    // lives on the actor's own record.
    await updatePlayer(db, actorJid, (actor) => { markDragonAsleep(actor) })
  } else if (action === 'ability') {
    // Abilities use resolveActiveAbility() — the same engine useability.js
    // uses for PvE — rather than the manual attack/skill damage math below,
    // since it already bundles primary damage + secondary effects (burn,
    // weaken, freeze, etc.) as one unit straight from data/abilities.json.
    await updatePlayer(db, opponentJid, (opp) => {
      const bs = opp.battleState
      const ability = findEquippedAbility(actorForCalc, skillQuery)

      const oppStatus = processStatusTurn(opp)
      if (oppStatus.lines.length) msg += oppStatus.lines.join('\n') + '\n'
      if (!isCatFormActive(opp) && opp.hp <= 0) {
        const catMsg = checkYoriichiCatForm(opp)
        if (catMsg) { msg += catMsg } else { opponentDefeated = true; return }
      }

      const hitChance = calcPlayerHitChance(actorForCalc, opp)
      if (Math.random() > hitChance) {
        msg += `💨❌ *${actorForCalc.name}'s ${ability.name} MISSED ${opp.name}!*\n`
        return
      }

      const wasDefending = bs.defending

      // Nisha's Serpent's Grace — checked before resolveActiveAbility() runs
      // since that function writes opp.hp directly with no return value to
      // intercept; a dodge here skips calling it entirely.
      const dodgeRoll = rollSerpentsGrace(opp, { damage: 1, trueDamage: false })
      if (dodgeRoll.dodged) {
        msg += `✨🌟 *${actorForCalc.name} UNLEASHES ${ability.name.toUpperCase()} ON ${opp.name}!* 🌟✨\n`
        msg += dodgeRoll.message + '\n'
        return
      }

      // Megumi (DEFENDER) — Mahoraga adapts to equipped abilities too, each
      // under its own identity ('skill:<abilityId>'). Checked here for the same
      // reason Serpent's Grace is: resolveActiveAbility() writes opp.hp
      // directly with no return value to intercept, so a nullified/evaded
      // ability has to skip calling it entirely rather than refund afterwards.
      const megaAbility = resolveMegumiIncoming(opp, {
        damage: 1, trueDamage: false,
        kind: 'skill', id: ability.id ?? ability.name ?? '',
        label: `*${ability.name}*`,
        bs: opp.battleState,
      })
      if (megaAbility.wheelCaption) wheelSpinCaption = megaAbility.wheelCaption
      if (megaAbility.nullified || megaAbility.dodged) {
        msg += `✨🌟 *${actorForCalc.name} UNLEASHES ${ability.name.toUpperCase()} ON ${opp.name}!* 🌟✨\n`
        if (megaAbility.message) msg += megaAbility.message + '\n'
        bs.defending = false // the turn still happened
        return
      }
      if (megaAbility.message) msg += megaAbility.message + '\n'

      // Yoriichi cat form is already active: resolveActiveAbility() below
      // writes opp.hp directly with no hook to intercept, so instead we let it
      // compute against her pool, then move whatever it took off opp.hp into
      // that pool rather than leaving it on opp.hp.
      //
      // The baseline MUST be the exact value written into opp.hp. It used to be
      // opp.maxHp while the value written was min(maxHp, catHp), so every
      // ability hit was inflated by (maxHp - catHp) — a full pool measured
      // correctly, but a chipped one took hundreds of points of phantom damage
      // and emptied in a single turn. The min(opp.maxHp, ...) clamp is gone for
      // the same reason: her pool is a flat 3,000, past a lot of owners' maxHp,
      // and clamping it truncated the ability's real damage
      // against a fake 0-hp floor.
      const wasCatFormActiveBefore = isCatFormActive(opp)
      const hpForCalc = wasCatFormActiveBefore
        ? Math.max(1, opp.battleState.yoriichiCatFormActive.hp)
        : opp.hp
      if (wasCatFormActiveBefore) opp.hp = hpForCalc

      const { lines } = resolveActiveAbility(ability, actorForCalc, opp)
      // resolveActiveAbility() writes opp.hp directly — honor 'defend' by
      // refunding half the damage it just dealt, same 0.5x rule attack/
      // skill apply via applyDefense() above. Measured off hpForCalc so that
      // defending protects Yoriichi's pool too; it used to be skipped outright
      // whenever cat form was up, meaning `.pvp defend` bought her nothing.
      if (wasDefending && hpForCalc > opp.hp) {
        const dealt = hpForCalc - opp.hp
        const refund = Math.ceil(dealt * 0.5)
        opp.hp = Math.min(wasCatFormActiveBefore ? hpForCalc : opp.maxHp, opp.hp + refund)
      }
      bs.defending = false // consumed

      msg += `✨🌟 *${actorForCalc.name} UNLEASHES ${ability.name.toUpperCase()} ON ${opp.name}!* 🌟✨\n`
      if (lines.length) msg += lines.join('\n') + '\n'

      // No armor-wear call here — mirrors PvE's useability.js, which never
      // touches durability for ability use (only attack.js/skill.js do).

      if (wasCatFormActiveBefore) {
        const dealtToCat = Math.max(0, hpForCalc - opp.hp)
        const catResult = resolveCatFormDamage(opp, dealtToCat)
        // Back to the 1 hp checkYoriichiCatForm() pins the owner at while she
        // fights — NOT 0. Setting it to 0 here made the "would this kill them"
        // check at the end of this branch fire on every single ability hit:
        // cat form is already spent by then, so checkYoriichiCatForm() returns
        // '' and the duel was declared over with her pool still nearly full.
        // That is the one-turn death in duels the owner was reporting.
        opp.hp = 1
        if (catResult.message) msg += catResult.message + '\n'
        if (catResult.defeated) {
          msg += buildCatFormDefeatMessage()
          opponentDefeated = true
        }
      }

      // Urahara — Tear/Reshape: applies on any actor hit landing in PvP too.
      if (isOpponentLive(opp)) {
        const tearLine = applyTearOnHit(actorForCalc, opp, ctx)
        if (tearLine) msg += tearLine + '\n'
      }

      if (opp.hp <= 0) {
        const catMsg = checkYoriichiCatForm(opp)
        if (catMsg) { msg += catMsg } else { opponentDefeated = true }
      }
    })
  } else if (action === 'hollowexchange') {
    // NOT A HIT, and this branch is deliberately shaped by everything it leaves
    // out: no accuracy roll, no crit, no DEF, no shields, no fight-length damage
    // cap, no on-damage hooks. She trades conditions; she does not strike. The
    // floor inside activateHollowExchange guarantees neither side can be brought
    // to 0, so there is no defeat branch for the exchange itself — the only thing
    // that can end the duel in here is the opponent's own lingering damage.
    await updatePlayer(db, opponentJid, (opp) => {
      const oppStatus = processStatusTurn(opp)
      if (oppStatus.lines.length) msg += oppStatus.lines.join('\n') + '\n'
      if (!isCatFormActive(opp) && opp.hp <= 0) {
        const catMsg = checkYoriichiCatForm(opp)
        if (catMsg) { msg += catMsg } else { opponentDefeated = true; return }
      }

      // The real call, re-running the guards the dry run already passed — which
      // CAN legitimately fail by now, because the status tick just above may have
      // dropped the opponent below the floor, leaving nothing to trade for. The
      // charge is still unburned at that point (it is spent in the actor write
      // below, not here), so the honest outcome is to say so and let the turn
      // pass rather than quietly swallow her one exchange.
      const res = activateHollowExchange(actorForCalc, opp, actorForCalc.battleState)
      if (!res.ok) {
        if (res.message) msg += res.message + '\n'
        return
      }
      hollowRes = res
      msg += buildHollowExchangeReveal(actorForCalc, opp, res)
    })

    // Her own half of the trade. activateHollowExchange wrote it onto
    // actorForCalc, which is only a snapshot (line ~1524), so this is the write
    // that actually persists — and the one place the charge is burned.
    if (hollowRes) {
      await updatePlayer(db, actorJid, (actor) => {
        actor.hp = hollowRes.after.playerHp
        if (actor.battleState) actor.battleState.hollowExchangeUsed = true
      })
    }
  } else if (action === 'unlimitedvoid') {
    // Gojo's Unlimited Void — pure control, no damage. The domain floods the
    // opponent with infinite information and locks them out for
    // UNLIMITED_VOID_STUN_TURNS of their turns; the actor-phase incapacitation
    // branch above reads that stun and skips their action each turn until it
    // lifts. Same "does not strike" shape as hollowexchange: no accuracy, no
    // crit, no DEF, no cap, no on-damage hooks, and no defeat branch — the void
    // spends the opponent's action, it does not spend their HP.
    await updatePlayer(db, opponentJid, (opp) => {
      const oppStatus = processStatusTurn(opp)
      if (oppStatus.lines.length) msg += oppStatus.lines.join('\n') + '\n'
      if (opp.hp <= 0) {
        const catMsg = checkYoriichiCatForm(opp)
        if (catMsg) { msg += catMsg } else { opponentDefeated = true; return }
      }
      msg += `🌌 *${actorForCalc.name}* opens *UNLIMITED VOID* on *${opp.name}*!\n`
      // A status-immune opponent (a Shunya owner) leaves the void nothing to
      // fill; addStatusEffect no-sells it and reports immune, same as PvE.
      const res = addStatusEffect(opp, {
        type: 'stun',
        duration: UNLIMITED_VOID_STUN_TURNS,
        sourceId: 'unlimited_void',
      })
      if (res?.immune) {
        msg += `⭕ _There is nothing in ${opp.name} to flood. The void closes on emptiness._\n`
      } else {
        msg += `🕳️ _Infinite information pours in. ${opp.name} cannot move, cannot think, cannot act._\n`
        msg += `💤 _Locked down for the next *${UNLIMITED_VOID_STUN_TURNS}* turns._\n`
      }
    })
  } else if (action === 'puppetstrings') {
    // Red Rose's Puppet Strings — the opponent's OWN attack, turned on them.
    // Not a strike of hers: no accuracy roll, no crit, no fight-length damage
    // cap, no on-damage hooks. resolvePuppetSelfHit builds it from the
    // opponent's own attack/defense and floors it at 20% of their max HP, so it
    // can never finish them — there is no defeat branch for the redirect itself,
    // only for the opponent's own lingering statuses. Then a tangle (a plain
    // stun for PUPPET_TANGLE_TURNS) skips their next turn, companion and all.
    await updatePlayer(db, opponentJid, (opp) => {
      const oppStatus = processStatusTurn(opp)
      if (oppStatus.lines.length) msg += oppStatus.lines.join('\n') + '\n'
      if (opp.hp <= 0) {
        const catMsg = checkYoriichiCatForm(opp)
        if (catMsg) { msg += catMsg } else { opponentDefeated = true; return }
      }

      const selfHit = resolvePuppetSelfHit(opp)
      opp.hp = selfHit.newHp

      const tangle = addStatusEffect(opp, {
        type: 'stun',
        duration: PUPPET_TANGLE_TURNS,
        sourceId: 'puppet_strings',
      })

      msg += buildPuppetStringsReveal(actorForCalc.name, opp.name, selfHit, {
        context: 'pvp',
        tangled: !tangle?.immune,
        immune: !!tangle?.immune,
      }) + '\n'
    })
  } else if (action === 'timestop') {
    // Reverie's Time Stop — pure control, no strike of her own. The opponent
    // FREEZES for TIME_STOP_TURNS and the actor-phase incapacitation branch skips
    // their moves until it lifts, the same shape as Unlimited Void's stun.
    //
    // The one exception is Montana: if the opponent has her equipped, she moves
    // faster than the stopped moment, so NO freeze lands — instead she answers
    // with a counter built from her summoner's own offence (resolveMontanaCounter,
    // floored non-lethal like Puppet Strings' redirect). Her HP write is on the
    // opponent record here; the caster's HP loss is deferred to the actor write
    // below, the exact opponent-then-actor split hollowexchange uses.
    await updatePlayer(db, opponentJid, (opp) => {
      const oppStatus = processStatusTurn(opp)
      if (oppStatus.lines.length) msg += oppStatus.lines.join('\n') + '\n'
      if (opp.hp <= 0) {
        const catMsg = checkYoriichiCatForm(opp)
        if (catMsg) { msg += catMsg } else { opponentDefeated = true; return }
      }

      if (hasMontana(opp)) {
        // Negated. Compute her counter against the caster snapshot (persisted on
        // the real actor record below) — never lethal, so no defeat branch.
        montanaCounter = resolveMontanaCounter(opp, actorForCalc)
        msg += `🕰️ *${opp.name}* has *Montana* — she moves before time can close on her!\n`
        msg += `⛔ _${actorForCalc.name}'s Time Stop finds no hold. The stillness never reaches her._\n`
        msg += montanaCounter.dealt > 0
          ? (montanaCounter.floored
              ? `🗡️ _Faster than the frozen moment, she strikes back for *${montanaCounter.dealt}* — pulling the blow before it can finish anyone._\n`
              : `🗡️ _Faster than the frozen moment, she strikes back for *${montanaCounter.dealt}*, matching ${opp.name} blow for blow._\n`)
          : `🗡️ _She strikes back, but there is almost nothing left of ${actorForCalc.name} to take._\n`
        return
      }

      msg += `⏱️ *${actorForCalc.name}* stops time on *${opp.name}*!\n`
      // A status-immune opponent (a Shunya owner) stands outside the stopped
      // moment; addStatusEffect no-sells the freeze and reports immune, as in PvE.
      const res = addStatusEffect(opp, {
        type: 'freeze',
        duration: TIME_STOP_TURNS,
        sourceId: 'time_stop',
      })
      if (res?.immune) {
        msg += `⭕ _${opp.name} stands outside the stopped moment. Time finds no hold on them._\n`
      } else {
        msg += `❄️ _${opp.name} freezes mid-motion, caught between one instant and the next._\n`
        msg += `🕛 _Frozen for the next *${TIME_STOP_TURNS}* turns while ${actorForCalc.name} acts alone._\n`
      }
    })

    // Montana's counter half — the caster's HP loss, written on the real actor
    // record (montanaCounter was computed against a snapshot above). Floored
    // non-lethal in resolveMontanaCounter, so this can never end the duel.
    if (montanaCounter) {
      await updatePlayer(db, actorJid, (actor) => {
        actor.hp = montanaCounter.newHp
      })
    }
  } else if (action === 'greedtithe') {
    // Echidna's Gospel of Greed - NOT A STRIKE: no accuracy roll, no crit, no
    // DEF, no fight-length damage cap, no on-damage hooks. She reaches through
    // the opponent's pockets - mood decides how much comes out (half their
    // money when amused/capricious, a quarter when displeased; gems stolen
    // from their own wallet on a mood-shaped chance, her holder's granted
    // child adding its stage-scaled cut). Both amounts are floored at zero and
    // capped at what exists - she can never push a wallet negative - so there
    // is no defeat branch for the theft itself, only for the opponent's own
    // lingering statuses. The distraction (a plain stun for
    // GREED_TANGLE_TURNS) skips their next turn, same shape as Puppet
    // Strings' tangle. The holder's credit lands on the actor record below,
    // the exact opponent-then-actor split hollowexchange uses.
    await updatePlayer(db, opponentJid, (opp) => {
      const oppStatus = processStatusTurn(opp)
      if (oppStatus.lines.length) msg += oppStatus.lines.join('\n') + '\n'
      if (opp.hp <= 0) {
        const catMsg = checkYoriichiCatForm(opp)
        if (catMsg) { msg += catMsg } else { opponentDefeated = true; return }
      }

      opp.wallet = opp.wallet ?? { solars: 0, gems: 0 }
      const res = echidnaPvpTithe(opp.wallet, greedMood, { child: actorForCalc.echidnaChild })
      opp.wallet.solars = Math.max(0, (opp.wallet.solars ?? 0) - res.solarsTaken)
      opp.wallet.gems = roundGems(Math.max(0, (opp.wallet.gems ?? 0) - res.gemsTaken))
      greedTaken = res

      const distract = addStatusEffect(opp, {
        type: 'stun',
        duration: GREED_TANGLE_TURNS,
        sourceId: 'gospel_of_greed',
      })

      msg += buildGreedTitheReveal({
        ownerName: actorForCalc.name,
        enemyName: opp.name,
        mood: greedMood,
        solars: res.solarsTaken,
        gems: res.gemsTaken,
        context: 'pvp',
        childRec: res.child,
        immune: !!distract?.immune,
      }) + '\n'
    })

    // The holder's half of the theft - credited on the real actor record, the
    // same second-write pattern hollowexchange uses. Only when the opp write
    // actually landed (greedTaken set); an opponent already down to lingering
    // damage keeps every coin, and the charge burn above is the only cost.
    if (greedTaken && !opponentDefeated && (greedTaken.solarsTaken > 0 || greedTaken.gemsTaken > 0)) {
      const tookBoth = greedTaken.solarsTaken > 0 && greedTaken.gemsTaken > 0
      await updatePlayer(db, actorJid, (actor) => {
        actor.wallet = actor.wallet ?? { solars: 0, gems: 0 }
        actor.wallet.solars = (actor.wallet.solars ?? 0) + greedTaken.solarsTaken
        actor.wallet.gems = roundGems((actor.wallet.gems ?? 0) + greedTaken.gemsTaken)
      })
      msg += `🍵 _${tookBoth ? 'Gems and coin' : 'The coin'} settle into ${actorForCalc.name}'s purse. She never looks at what she hands over._\n`
    }
  } else if (!skipsOpponentHit) {
    await updatePlayer(db, opponentJid, (opp) => {
      const bs = opp.battleState

      const oppStatus = processStatusTurn(opp)
      if (oppStatus.lines.length) msg += oppStatus.lines.join('\n') + '\n'
      if (opp.hp <= 0) {
        const catMsg = checkYoriichiCatForm(opp)
        if (catMsg) { msg += catMsg } else { opponentDefeated = true; return }
      }

      let skill = null
      if (action === 'skill') {
        skill = findSkill(skillQuery, actorForCalc.skills ?? [], allSkills)
        // (already validated above; re-resolved here just to compute damage)
      }

      const moveName = action === 'cinderverdict'
        ? 'CINDER VERDICT'
        : action === 'domain' ? 'CHIMERA SHADOW GARDEN'
        : action === 'hollowpurple' ? 'HOLLOW PURPLE'
        : action === 'kurohitsugi' ? 'KUROHITSUGI'
        : action === 'soulpunisher' ? 'SOUL PUNISHER'
        : action === 'kamehameha' ? 'BIG BANG KAMEHAMEHA'
        : action === 'kurama' ? 'BARYON RASENGAN'
        : action === 'thiefseye' ? (thiefsEyeMove?.name ?? "THIEF'S EYE")
        : action === 'wildcard' ? wildCardMoveName : (skill ? skill.name : 'ATTACK')
      const hitChance = calcPlayerHitChance(actorForCalc, opp)
      // 🎭 Fool's Gambit cannot miss — she strikes herself and swaps places, so
      // there is no aim involved. It skips the accuracy roll ONLY: the
      // defender's Serpent's Grace dodge, their beast, and their shield below
      // all still get their say, same as against any other hit. Hollow Purple is
      // the same: it never misses (its imaginary mass erases the space it crosses),
      // but the defender's Serpent's Grace / Mahoraga / shield still apply.
      // Gogeta's two moves are exempt for the reason no character move in the
      // bot rolls accuracy: the cooldown is already burned in the actor phase,
      // so a whiff would read as the command being broken.
      if (!wildCardGuaranteedHit &&
          action !== 'hollowpurple' && action !== 'kurohitsugi' && action !== 'soulpunisher' && action !== 'kamehameha' &&
          Math.random() > hitChance) {
        msg += `💨❌ *${actorForCalc.name}'s ${moveName} MISSED ${opp.name}!*\n`
        // A whiffed theft still keeps the move. The charge was already burned in
        // the actor phase, and PvE denies in the gate itself — so the deny has
        // to land here too, or a missed duel theft would quietly do nothing.
        if (action === 'thiefseye' && thiefsEyeMove) {
          recordThiefsEyeDeny(opp, thiefsEyeMove)
          msg += `🚫 _${thiefsEyeMove.name} is gone all the same. She kept it._\n`
        }
        return
      }

      // Dance of the Rain — same "just the multiplier" contract as
      // catFormAttackDamage, keyed off the actor's own turn count.
      const danceMult = danceOfTheRainMultiplier(actorForCalc, actorForCalc.battleState)
      const moveMult = action === 'cinderverdict'
        ? cinderMult
        : action === 'domain' ? domainMult
        : action === 'hollowpurple' ? hollowPurpleMult
        : action === 'kurohitsugi' ? kurohitsugiMultiplier(actorForCalc, opp)
        : action === 'soulpunisher' ? soulPunisherMult
        : action === 'kamehameha' ? kamehamehaMult
        : action === 'kurama' ? kuramaMult
        : action === 'thiefseye' ? thiefsEyeMult
        : action === 'wildcard' ? wildCardMult : 1
      const dmgMult = moveMult * catFormAttackDamage(actorForCalc) * danceMult
      const { rawDmg, isCrit } = calcPlayerDamage(actorForCalc, skill, dmgMult)
      // Fool's Gambit is their own blow redirected into them — their DEF never
      // gets to mitigate it. Their 'defend' stance below still halves it,
      // since that's a chosen stance rather than a stat. Big Bang Kamehameha is
      // here for the same reason it is in PvE: armour is not a meaningful answer
      // to it. Soul Punisher is deliberately NOT — it is a normal hit, just a
      // strong one, so DEF applies to it.
      let dmg = (wildCardIgnoreDefense || action === 'hollowpurple' || action === 'kamehameha' || action === 'kurohitsugi') ? rawDmg : applyDefense(rawDmg, getEffectiveStat(opp, 'def'))
      // Thief's Eye floors the echo at THIEFS_EYE_ECHO_MULT times the hit it was
      // copied from. Placed after applyDefense but BEFORE the defend stance on
      // the same principle the Fool's Gambit comment above states: a stolen move
      // ignores the stat, never the choice. The move was tuned against the
      // caster's defense, so re-aiming it is not re-mitigated by DEF — but the
      // opponent choosing to guard this turn still halves what lands.
      if (action === 'thiefseye') {
        const echo = resolveThiefsEyeDamage({ echoFloor: thiefsEyeFloor }, dmg)
        dmg = echo.damage
        thiefsEyeEchoed = echo.echoed
      }
      if (bs.defending) dmg = Math.max(1, Math.floor(dmg * 0.5))

      // ── Fight-length cap (see PVP_*_HIT_MAX_HP_FRAC up top) ────────────
      // Bound a basic attack / skill to a fraction of the target's MAX HP so
      // no single hit is a one-tap. Applied AFTER defense and the defend
      // stance, so both still matter below the ceiling. Gated to the baseline
      // exchange ONLY: 'cinderverdict'/'wildcard' resolve through this same
      // branch (via moveMult) but must stay uncapped, and cat form on EITHER
      // side is exempt — Yoriichi's 4k-10k pool has its own balance and would
      // be made near-unkillable if a 15%-of-owner-maxHp cap were applied to it.
      if ((action === 'attack' || action === 'skill') &&
          !isCatFormActive(actorForCalc) && !isCatFormActive(opp)) {
        const hitCap = Math.max(1, Math.floor(
          opp.maxHp * (action === 'skill' ? PVP_SKILL_HIT_MAX_HP_FRAC : PVP_BASIC_HIT_MAX_HP_FRAC),
        ))
        if (dmg > hitCap) dmg = hitCap
      }

      // Nisha's Serpent's Grace — flat dodge chance if the DEFENDER (opp)
      // has Nisha equipped. Same trueDamage exemption as PvE's usage.
      const dodgeRoll = rollSerpentsGrace(opp, { damage: dmg, trueDamage: false })
      if (dodgeRoll.dodged) {
        dmg = 0
        msg += dodgeRoll.message + '\n'
      }

      // ── Megumi (DEFENDER) — Mahoraga's Wheel + the Garden's shadow dodge ──
      // Move identity is the ACTOR's exact move, so `.pvp skill fireball` three
      // times running gets fireball mastered and dealing 0 from then on, and
      // `.pvp attack` three times running does the same to the basic attack.
      // Switching moves starts a fresh 3-count on the new one while everything
      // already mastered stays at 0. The Wheel adapts to signature moves too,
      // each under its own identity (skill:domain, skill:cinderverdict, …).
      const megaKind = action === 'attack' ? 'attack' : 'skill'
      const megaId = action === 'skill' ? (skill?.id ?? skillQuery ?? '') : action
      const mega = resolveMegumiIncoming(opp, {
        damage: dmg,
        trueDamage: false,
        kind: megaKind,
        id: megaId,
        label: `*${moveName}*`,
        bs: opp.battleState,
      })
      if (mega.wheelCaption) wheelSpinCaption = mega.wheelCaption
      if (mega.message) msg += mega.message + '\n'
      dmg = mega.damage

      // ── Summon Beast: opponent's beast may redirect this hit ──────────
      const beastResult = beastIntervention(opp, BEAST_EVENT.ENEMY_DEAL_DAMAGE, {
        enemy: actorForCalc,
        bs,
        damage: dmg,
      })
      if (beastResult.modified) {
        if (beastResult.damage !== undefined) dmg = beastResult.damage
        msg += beastResult.lines.join('\n') + '\n'
      }

      const absorbed = absorbDamage(opp, dmg)
      const shieldBlocked = dmg - absorbed
      const applied = applyIncomingDamage(opp, absorbed)
      bs.defending = false // consumed

      if (applied.message) msg += applied.message + '\n'
      if (applied.catFormDefeated) opponentDefeated = true
      const actionVerb = action === 'cinderverdict'
        ? `🔥⚖️ passes *Cinder Verdict* on`
        : action === 'domain'
          ? `🌑 floods the *Chimera Shadow Garden* over`
          : action === 'hollowpurple'
          ? `🟦🟥 brings *Hollow Purple* down on`
          : action === 'kurohitsugi'
          ? `⬛ seals a *KUROHITSUGI* over`
          : action === 'soulpunisher'
          ? `🔵 puts a *Soul Punisher* through`
          : action === 'kamehameha'
          ? `🔵💥 fires the *BIG BANG KAMEHAMEHA* into`
          : action === 'kurama'
          ? `🦊🌀 folds the Nine Tails into a strike on`
          : action === 'thiefseye'
          ? `👁️🗝️ turns *${thiefsEyeMove?.name ?? "their own move"}* back on`
          : action === 'wildcard'
          ? `${wildCardMoveName === 'WISHING STAR' ? '🌟 drops a *Wishing Star* on' : `🎭 turns *Fool's Gambit* back onto`}`
          : skill ? `unleashes *${skill.name}*` : 'attacks'
      msg += `${isCrit ? '💥🔥 *CRITICAL HIT!!* 🔥💥\n' : '⚔️ '}*${actorForCalc.name}* ${actionVerb} 👉 *${applied.damage} DMG* to *${opp.name}*! 💢\n`
      if (action === 'hollowpurple') msg += `🟪 _The clash of Blue and Red erases the space between. No armour softens it._\n`
      if (action === 'kurohitsugi') {
        // Hadō #90 in the duel: the coffin's cast and impact read from the same
        // pools the PvE turn uses (lib/aizen-flavor.js), so a duel's Kurohitsugi
        // sounds like the fight it is, with the enemy's reaction to being sealed
        // inside time that no longer agrees with them.
        const senses = aizenSenses(actorForCalc, actorForCalc.battleState)
        msg += `${kurohitsugiCastLine(senses)}\n`
        if (senses > 0) {
          msg += `_He already owns ${senses}/${AIZEN_MAX_SENSES} of their senses. The seal tightens around what remains._\n`
        }
        msg += `${kurohitsugiImpactLine({ execute: opp.hp > 0 && (opp.hp / (opp.maxHp || 1)) < 0.35, kill: opp.hp <= 0 })}\n`
      }
      if (action === 'soulpunisher') msg += `💠 _A point of ki the size of a fist, across the gap before the sound of it._\n`
      if (action === 'kamehameha') {
        msg += `🌀 _Hands together, elbows locked, and then there is no longer a between._ _(ignores DEF)_\n`
        msg += `💧 _Energy bar spent down to nothing._\n`
      }
      // Instant Transmission refusing to start a cooldown, narrated on the turn
      // the move went off so it does not look like the cooldown is broken.
      if (gogetaExtra) { msg += gogetaExtra + '\n'; gogetaExtra = '' }
      const gogetaFusionLeft = fusionTurnsLeft(actorForCalc, actorForCalc.battleState)
      if ((action === 'soulpunisher' || action === 'kamehameha') && gogetaFusionLeft > 0) {
        msg += `_Fusion of Equals: ${gogetaFusionLeft} turn${gogetaFusionLeft === 1 ? '' : 's'} left._\n`
      }
      if (shieldBlocked > 0) msg += `🛡️✨ *SHIELD ABSORBED ${shieldBlocked} DMG!*\n`

      // ── Xiao's Thief's Eye ────────────────────────────────────────────────
      if (action === 'thiefseye' && thiefsEyeMove) {
        if (thiefsEyeEchoed) msg += `👁️ _The echo lands heavier than the blow that taught it._\n`
        recordThiefsEyeDeny(opp, thiefsEyeMove)
        msg += `🚫 *${thiefsEyeMove.name}* is hers now — *${opp.name}* will not use it again this duel.\n`
      }

      // THIEF'S EYE (copy) — record the actor's move onto the DEFENDER, since
      // the defender is the side who might have Xiao equipped. Same target and
      // the same move identity resolveMegumiIncoming() above already uses.
      //
      // A plain `.pvp attack` is deliberately NOT recorded: it has no name, so
      // there is nothing to steal — matching PvE, where an ordinary monster
      // swinging without naming it writes nothing either. It also has to stay
      // undeniable, or a duelist out of MP could be left with no legal move at
      // all (see applyThiefsEyeDenyGate in lib/character-abilities.js).
      if (action !== 'attack') {
        recordEnemyMove(opp, { name: moveName, damage: applied.damage, kind: megaKind, id: megaId })
      }
      msg += buildDanceOfTheRainMessage(actorForCalc.battleState, actorForCalc)

      if (skill?.secondaryEffect) {
        const effectDef = buildEffectDef(skill.secondaryEffect, opp, skill.id)
        if (effectDef) {
          // Shunya — The Empty Vessel: a debuff aimed at her finds nothing to
          // hold and rebounds onto the caster. addStatusEffect would already
          // swallow it on `opp` (statusImmune); in a duel the void hands it
          // back instead — actorForCalc is the attacker, in scope right here.
          // If the attacker is ALSO immune, the central gate voids it again.
          if (opp.statusImmune && isNegativeEffect(effectDef.type)) {
            addStatusEffect(actorForCalc, effectDef)
            msg += `⭕ *${opp.name}* is the void — the ${skill.secondaryEffect.type} finds no purchase and *rebounds onto ${actorForCalc.name}*!\n`
          } else {
            addStatusEffect(opp, effectDef)
            msg += EFFECT_APPLIED_LINE[skill.secondaryEffect.type]?.(opp.name) ?? ''
          }
        }
      }

      const aWear = wearArmorOnHit(opp, absorbed)
      msg += breakMessage(aWear)

      // Urahara — Tear/Reshape: applies on attack/skill hits landing too.
      if (isOpponentLive(opp)) {
        const tearLine = applyTearOnHit(actorForCalc, opp, ctx)
        if (tearLine) msg += tearLine + '\n'
      }

      // Capture the landed hit for the actor-side premium/pack effects applied
      // after this mutator closes (see the accumulators up top). isOpponentLive
      // is already false if this hit downed opp, so a felled defender doesn't
      // riposte or chill — but the actor still lifesteals off the killing blow.
      pvpDmgDealtToOpp += applied.damage
      pvpDefenderCanReact = applied.damage > 0 && isOpponentLive(opp)

      // Yoriichi's cat form — check at the same "would this hit kill them"
      // point Mei's sustain already occupies, since PvP has no
      // handleDeath()/checkTotemRevive() call chain of its own to hook
      // into (see this file's top doc comment: PvP never calls
      // combat-handlers.js). If she triggers, opp.hp stays at 0 (matches
      // the narrative — the owner IS down) but opponentDefeated stays
      // false since Yoriichi is now the one fighting.
      if (opp.hp <= 0) {
        const catMsg = checkYoriichiCatForm(opp)
        if (catMsg) {
          msg += catMsg
        } else {
          opponentDefeated = true
        }
      }

      // 🦊 Baryon Mode's lifespan drain — a flat share of the opponent's MAX HP
      // as true damage no armour touches, landed AFTER the strike so the two
      // together can finish someone the strike alone left standing. Skipped when
      // the strike already downed them (isOpponentLive false), so it never
      // double-credits a kill, and it runs its own Yoriichi-aware defeat check.
      if (action === 'kurama' && isOpponentLive(opp)) {
        const drainRes = resolveKuramaDrain(opp, kuramaDrainPct)
        opp.hp = drainRes.newHp
        if (drainRes.drain > 0) {
          msg += `🦊 _The fox's touch drags the lifespan out of *${opp.name}*: *${drainRes.drain}* more, and no armour in the world softens it._\n`
        }
        if (opp.hp <= 0) {
          pvpDefenderCanReact = false
          const catMsg = checkYoriichiCatForm(opp)
          if (catMsg) { msg += catMsg } else { opponentDefeated = true }
        }
      }

      // ⚡ Second Transcendance (duel) — the equipped Transcendent strikes a
      // SECOND time. A fresh accuracy + damage roll routed through the SAME
      // defensive pipeline the primary hit used (DEF, the fight-length hit-cap,
      // Serpent's Grace, Megumi's Wheel, the Summon Beast, and shields), so no
      // defender's character ability is bypassed — the echo is treated as the
      // real extra hit it is (Mahoraga adapts to it, a mastered move zeroes it,
      // Nisha can dodge it, a shield eats it). Deliberately NONE of the one-time
      // move machinery re-runs: MP was already spent, and the skill's secondary
      // effect / Thief's Eye record / Dance line / move-record above all fired
      // once for the primary. It fires only after a LANDED primary (the miss
      // path returned above) and only for basic attack + skill — the sole
      // actions a Transcendent, being one equipped character, takes here.
      if (!opponentDefeated && isOpponentLive(opp) &&
          hasSecondTranscendance(actorForCalc) &&
          (action === 'attack' || action === 'skill')) {
        if (Math.random() > calcPlayerHitChance(actorForCalc, opp)) {
          msg += `⚡❌ *SECOND TRANSCENDANCE* — *${actorForCalc.name}*'s echo misses!\n`
        } else {
          const echoRoll = calcPlayerDamage(actorForCalc, skill, catFormAttackDamage(actorForCalc) * danceMult)
          let echoDmg = applyDefense(echoRoll.rawDmg, getEffectiveStat(opp, 'def'))
          // Same fight-length cap as the primary attack/skill hit — no one-tap.
          if (!isCatFormActive(actorForCalc) && !isCatFormActive(opp)) {
            const echoCap = Math.max(1, Math.floor(
              opp.maxHp * (action === 'skill' ? PVP_SKILL_HIT_MAX_HP_FRAC : PVP_BASIC_HIT_MAX_HP_FRAC),
            ))
            if (echoDmg > echoCap) echoDmg = echoCap
          }
          const echoDodge = rollSerpentsGrace(opp, { damage: echoDmg, trueDamage: false })
          if (echoDodge.dodged) { echoDmg = 0; msg += echoDodge.message + '\n' }
          const echoMega = resolveMegumiIncoming(opp, {
            damage: echoDmg,
            trueDamage: false,
            kind: action === 'attack' ? 'attack' : 'skill',
            id: action === 'skill' ? (skill?.id ?? skillQuery ?? '') : action,
            label: `*SECOND TRANSCENDANCE*`,
            bs: opp.battleState,
          })
          if (echoMega.wheelCaption) wheelSpinCaption = echoMega.wheelCaption
          if (echoMega.message) msg += echoMega.message + '\n'
          echoDmg = echoMega.damage
          const echoBeast = beastIntervention(opp, BEAST_EVENT.ENEMY_DEAL_DAMAGE, {
            enemy: actorForCalc, bs, damage: echoDmg,
          })
          if (echoBeast.modified) {
            if (echoBeast.damage !== undefined) echoDmg = echoBeast.damage
            msg += echoBeast.lines.join('\n') + '\n'
          }
          const echoAbsorbed = absorbDamage(opp, echoDmg)
          const echoShield = echoDmg - echoAbsorbed
          const echoApplied = applyIncomingDamage(opp, echoAbsorbed)
          if (echoApplied.message) msg += echoApplied.message + '\n'
          msg += `⚡ *SECOND TRANSCENDANCE* — *${actorForCalc.name}* strikes again 👉 *${echoApplied.damage} DMG* to *${opp.name}*!\n`
          if (echoShield > 0) msg += `🛡️✨ *SHIELD ABSORBED ${echoShield} DMG!*\n`
          if (echoApplied.catFormDefeated) opponentDefeated = true
          if (opp.hp <= 0) {
            const echoCat = checkYoriichiCatForm(opp)
            if (echoCat) { msg += echoCat } else { opponentDefeated = true }
          }
        }
      }
    })
  } else if (action === 'defend') {
    await updatePlayer(db, opponentJid, (opp) => { opp.battleState.defending = true })
  }
  // (the remaining skipsOpponentHit cases — a defensive Wild Card and Aizen's
  // Hōgyoku — have nothing to do to the opponent at all: her cards resolve on
  // THEIR swing, and the Hōgyoku is a self-evolution that touches nobody.)

  // ── Premium ability passive + pack signatures (actor-side) ───────────────
  // Applied on the live actor now that the opponent mutator has closed (see the
  // accumulators declared up top). Runs only while the duel continues: the
  // defender (opp, read fresh only for WHICH ability/pack they own) punishes the
  // attacker for landing the blow — freeze/burn/sleep chance, Gemstone flame,
  // Sicilian riposte — and the attacker heals from Dark Monarch's Dread. Riposte
  // is floored non-lethal here: this file has no attacker-death chain to hook
  // (see the cat-form note in the hit block), so a duel never ends on a reflect.
  if (!opponentDefeated && pvpDmgDealtToOpp > 0) {
    const oppSnap = pvpDefenderCanReact ? getPlayer(db, opponentJid) : null
    await updatePlayer(db, actorJid, (actor) => {
      const ls = applyPackLifestealOnDeal(actor, pvpDmgDealtToOpp)
      if (ls.heal > 0) {
        actor.hp = Math.min(actor.maxHp, actor.hp + ls.heal)
        msg += ls.lines.join('\n') + '\n'
      }
      if (oppSnap) {
        const struck = applyStruckReactions(oppSnap, actor, pvpDmgDealtToOpp)
        if (struck.lines.length) msg += struck.lines.join('\n') + '\n'
        if (struck.counterDamage > 0) actor.hp = Math.max(1, actor.hp - struck.counterDamage)
      }
    })
  }

  // ── Deduct skill MP cost now that the hit has resolved (actor-side) ─────
  if (action === 'skill') {
    await updatePlayer(db, actorJid, (actor) => {
      const skill = findSkill(skillQuery, actor.skills ?? [], allSkills)
      if (skill) actor.mp -= skill.mpCost
    })
  }

  // ── Set ability cooldown now that it has resolved (actor-side) ──────────
  // Turn-based like useability.js's PvE cooldown model — goes on cooldown
  // whether it hit or missed, since the turn was still spent.
  if (action === 'ability') {
    await updatePlayer(db, actorJid, (actor) => {
      const ability = findEquippedAbility(actor, skillQuery)
      if (ability) {
        actor.battleState.abilityCooldowns = actor.battleState.abilityCooldowns ?? {}
        const currentTurn = actor.battleState.turn ?? 1
        actor.battleState.abilityCooldowns[ability.id] = currentTurn + ability.cooldownTurns
      }
    })
  }

  // ── Megumi's media, as their own messages ───────────────────────────────
  // Sent here (after every mutation, before the turn text / any conclude) so
  // the Domain art lands whenever the Garden is opened — including on a turn
  // that ends the duel — and so the Wheel-spin GIF plays right before the
  // ordinary battle message continues, exactly like PvE's attack.js/skill.js.
  if (domainSplash) {
    await sendDomainImage(ctx, `🌑 *CHIMERA SHADOW GARDEN* — the shadows swallow the arena.`, ctx.sender)
  }
  // The beam art, sent only on the turn the gate actually passed. Same
  // "own message" treatment as the Domain splash, and the same reason: the
  // energy bar is already spent, so media must never block the turn text.
  if (kamehamehaSplash) {
    await sendKamehamehaImage(ctx, `🔵💥 *BIG BANG KAMEHAMEHA* 💥🔵`, ctx.sender)
  }
  if (wheelSpinCaption) {
    await sendWheelSpin(ctx, wheelSpinCaption, ctx.sender)
  }
  // The Nine Tails summon splash, sent only on the turn the gate passed. Same
  // "own message" treatment as the Domain and beam art: the charge (and Naruto's
  // self-cost) are already spent, so media must never block the turn text.
  if (kuramaSplash) {
    await sendKuramaSummonImage(ctx, `🦊🌀 *${actorForCalc.name} tears the seal open. KURAMA answers.*`, ctx.sender)
  }

  if (opponentDefeated) {
    // Dragon ultimate — post the cinematic as its own short-delay message
    // sequence BEFORE the normal victory summary (pvpConclude's own reply),
    // so it reads as a scene rather than one wall of text. See
    // lib/dragon-engine.js's buildDragonUltimateSequence() doc comment. The
    // final beat goes out via sendImageTo (with the 'dragon-ultimate' art
    // key from lib/image.js) instead of a plain reply, so the kill lands
    // with art once a URL is registered there — missing art safely falls
    // back to plain text, same as every other sendImageTo call in this file.
    if (dragonUltimateSequence) {
      const last = dragonUltimateSequence.length - 1
      for (let i = 0; i < dragonUltimateSequence.length; i++) {
        const part = dragonUltimateSequence[i]
        if (i === last) {
          await sendImageTo(ctx, 'dragon-ultimate', part, ctx.sender)
        } else {
          await ctx.reply(part)
        }
        await sleep(1400)
      }
      // Fight-ending dragon kill — no next turn to pass to, so the normal
      // "TURN PASSES TO ..." status footer (built further down for the
      // non-ultimate path) doesn't apply here. Replace it with the dragon's
      // own rest note instead, folded into pvpConclude's reasonLine below.
      msg += buildDragonRestFooter(actorForCalc.name)
    }
    await updatePlayer(db, actorJid, (actor) => {
      actor.inBattle = false
      actor.battleState = null
    })
    return pvpConclude(db, actorJid, opponentJid, ctx, msg.trim())
  }

  // ── Summon Beast: actor's own turn-start bonus-attack chance ──────────
  // (checked after the main action, mirroring attack.js's ordering being
  // "the active beast can pile on" rather than gating the whole turn)
  await updatePlayer(db, actorJid, (actor) => {
    const beastTs = beastIntervention(actor, BEAST_EVENT.TURN_START, { enemy: null, bs: actor.battleState })
    if (beastTs.modified) {
      msg += beastTs.lines.join('\n') + '\n'
      actor.battleState._pendingBeastDmg = beastTs.bonusDamage
    }
  })

  const actorPost = getPlayer(db, actorJid)
  const pendingBeastDmg = actorPost?.battleState?._pendingBeastDmg ?? 0
  if (pendingBeastDmg > 0) {
    let bonusApplied = 0
    let bonusCatFormDefeated = false
    await updatePlayer(db, opponentJid, (opp) => {
      const applied = applyIncomingDamage(opp, pendingBeastDmg)
      bonusApplied = opp.hp
      bonusCatFormDefeated = applied.catFormDefeated
      if (applied.message) msg += applied.message + '\n'
    })
    await updatePlayer(db, actorJid, (actor) => { delete actor.battleState._pendingBeastDmg })
    if (bonusCatFormDefeated || bonusApplied <= 0) {
      await updatePlayer(db, actorJid, (actor) => {
        actor.inBattle = false
        actor.battleState = null
      })
      return pvpConclude(db, actorJid, opponentJid, ctx, msg.trim())
    }
  }

  // ── Flip the turn ──────────────────────────────────────────────────────
  // actor.battleState.turn tracks how many turns THIS player has taken —
  // used purely for ability cooldown math (readyAtTurn comparisons above),
  // same per-player counter model useability.js uses for PvE.
  // lastMoveAt is stamped on BOTH sides: the waiting player reads their own
  // battleState to decide whether `.pvp claim` is available yet, so a stamp
  // on only one record would leave the other's timer running from accept.
  const movedAt = Date.now()

  // ── Gambit engine: name the shape of the duel, chess-commentary style ────
  // The ply log lives identically on both battleStates (mirrored on every
  // flip), so detection sees the whole game no matter who moves next. We're
  // past all the early returns here, so `action` definitely executed this turn.
  const prevLog   = actorSnapshot.battleState.gambitLog ?? []
  const prevSeen  = actorSnapshot.battleState.gambitsSeen ?? []
  const gambitLog = [...prevLog, action]
  const newGambits = detectGambits(gambitLog, prevSeen)
  const gambitsSeen = newGambits.length
    ? [...prevSeen, ...newGambits.map(g => g.name)]
    : prevSeen

  await updatePlayer(db, actorJid, (actor) => {
    actor.battleState.myTurn = false
    actor.battleState.turn = (actor.battleState.turn ?? 1) + 1
    actor.battleState.lastMoveAt = movedAt
    actor.battleState.gambitLog = gambitLog
    actor.battleState.gambitsSeen = gambitsSeen
  })
  await updatePlayer(db, opponentJid, (opp) => {
    opp.battleState.myTurn = true
    opp.battleState.lastMoveAt = movedAt
    opp.battleState.gambitLog = gambitLog
    opp.battleState.gambitsSeen = gambitsSeen
  })

  // The baton just landed on the opponent. If Yoriichi is fighting for them, she
  // takes it immediately and hands it straight back — their owner is unconscious
  // and never gets a turn, so nothing here may leave the duel waiting on them.
  // This is also the ONLY place a cat form's turn comes from in a normal duel.
  const catAuto = await autoResolveCatFormTurns(db, ctx, actorJid, opponentJid, { lead: msg })
  if (catAuto.concluded) return
  msg += catAuto.text

  // Engine annotation goes at the very top of the turn text, like a caption.
  if (newGambits.length) msg = formatGambits(newGambits) + '\n' + msg

  const actorFinal = getPlayer(db, actorJid)
  const oppSnapshot = getPlayer(db, opponentJid)
  // Circe's board state — what's still armed and how many draws she has left.
  // Only shown on her own Wild Card turns; the rest of the duel reads normally.
  if (action === 'wildcard') {
    const g = circeGuardStatus(actorFinal)
    const armed = []
    if (g.finalDash) armed.push(`🃏 _Final Dash armed_`)
    if (g.lastLaugh > 0) armed.push(`🤡 _Last Laugh ${g.lastLaugh}t_`)
    if (g.butterfly > 0) armed.push(`🎪 _Copies ${g.butterfly}t_`)
    if (armed.length) msg += armed.join(' · ') + '\n'
    msg += `🎟️ _Draws left: ${wildCardUsesLeft(actorFinal)}/${WILD_CARD_MAX_USES}_\n`
  }
  msg += pvpStatusFooter(actorFinal, oppSnapshot)

  await sendWillowAdvisory(ctx, actorFinal, oppSnapshot, false, actorJid)
  await sendBattleTurnReply(ctx, {
    player: actorFinal, e: oppSnapshot, msg,
    hpBeforeTurn, eHpBeforeTurn,
    isPvp: true,
    isDefending: action === 'defend',
  })
}

/**
 * pvpCinderVerdict(ctx) — entry point for the top-level `.cinderverdict`
 * command (plugins/cinderverdict.js) when the caller is in a duel rather than
 * a PvE fight. plugins/cinderverdict.js only knows the PvE battleState shape
 * (bs.enemy), so it delegates here when battleState.type === 'pvp'. This just
 * routes into the normal PvP turn engine as the 'cinderverdict' action, which
 * gates on Wither being equipped and the once-per-battle charge.
 */
export async function pvpCinderVerdict(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'cinderverdict', '')
}

/**
 * pvpKurama(ctx) — entry point for the top-level `.kurama` command
 * (plugins/kurama.js) when the caller is in a duel rather than a PvE fight.
 * plugins/kurama.js only knows the PvE battleState shape (bs.enemy), so it
 * delegates here when battleState.type === 'pvp'. This just routes into the
 * normal PvP turn engine as the 'kurama' action, which gates on Naruto being
 * equipped and burns the once-per-battle charge plus his Baryon self-cost.
 */
export async function pvpKurama(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'kurama', '')
}

/**
 * pvpDomain(ctx) — entry point for the top-level `.domain-expansion` command
 * (plugins/domain-expansion.js) when the caller is in a duel rather than a PvE
 * fight. Same delegation shape as pvpCinderVerdict() above: the PvE plugin only
 * knows the PvE battleState shape (bs.enemy), so it hands off here when
 * battleState.type === 'pvp'. Routes into the normal PvP turn engine as the
 * 'domain' action, which gates on Megumi being equipped and on the Garden not
 * already being open (see activateChimeraDomain() in lib/megumi.js).
 */
export async function pvpDomain(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'domain', '')
}

/**
 * inPvpDuel(player) — exported read-only check for plugins/ultimate.js so it
 * can give a friendly error without duplicating inPvp()'s logic. Same
 * definition as the private inPvp() above.
 */
export function inPvpDuel(player) {
  return inPvp(player)
}

/**
 * pvpUltimate(ctx) — entry point for the top-level `.ultimate` command
 * (plugins/ultimate.js). The dragon has no PvE path (see
 * lib/dragon-engine.js's doc comment), so unlike pvpCinderVerdict() above
 * this is the ONLY entry point — there's no PvE plugin delegating in.
 * Routes into the normal PvP turn engine as the 'ultimate' action, which
 * gates on owning the dragon, turn >= 4, and the once-per-battle charge
 * (see activateDragonUltimate() in lib/dragon-engine.js).
 */
export async function pvpUltimate(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'ultimate', '')
}

/**
 * pvpWildCard(ctx) — entry point for the top-level `.wildcard` command
 * (plugins/wildcard.js) when the caller is in a duel rather than a PvE fight.
 * Same delegation shape as pvpCinderVerdict() above: plugins/wildcard.js only
 * knows the PvE battleState shape (bs.enemy), so it hands off here when
 * battleState.type === 'pvp'. Routes into the normal PvP turn engine as the
 * 'wildcard' action, which gates on Circe being equipped and on having draws
 * left, then resolves whichever of her six cards comes up.
 *
 * Two rules differ from PvE, both by design (see the 'wildcard' gate in
 * runPvpTurn): 🌟 Wishing Star does NOT execute here, and 🦋 Vanishing Act
 * ends the duel with no result recorded for either player.
 */
export async function pvpWildCard(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'wildcard', '')
}

/**
 * pvpThiefsEye(ctx) — entry point for the top-level `.thiefseye` command
 * (plugins/thiefseye.js) when the caller is in a duel rather than a PvE fight.
 * Same delegation shape as pvpCinderVerdict() above: plugins/thiefseye.js only
 * knows the PvE battleState shape (bs.enemy), so it hands off here when
 * battleState.type === 'pvp'. Routes into the normal PvP turn engine as the
 * 'thiefseye' action, which gates on Xiao being equipped, on the
 * once-per-battle charge, and on the opponent having actually used a NAMED move
 * on her owner already — a plain `.pvp attack` is not stealable, so she has
 * nothing to take until they reach for a skill or a signature ability.
 */
export async function pvpThiefsEye(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'thiefseye', '')
}

/**
 * pvpHollowExchange(ctx) — entry point for the top-level `.hollowexchange`
 * command (plugins/hollowexchange.js) when the caller is in a duel rather than a
 * PvE fight. Same delegation shape as pvpCinderVerdict() above:
 * plugins/hollowexchange.js only knows the PvE battleState shape (bs.enemy), so
 * it hands off here when battleState.type === 'pvp'. Routes into the normal PvP
 * turn engine as the 'hollowexchange' action.
 *
 * It gates on Minna being equipped, on the once-per-battle charge, on the caller
 * being at or below 40% HP, and on the OPPONENT being above 40% — so unlike every
 * other signature move in here, whether it is legal depends on the score. The
 * three-step swap it needs (dry run, opponent write, actor write) is documented at
 * the hollowRes declaration in runPvpTurn.
 *
 * A duel is the one place this is symmetric: two Minna owners can each hold their
 * exchange, and whoever is losing badly enough to use it hands the disadvantage
 * straight to the other. Neither can be finished by it — the floor holds on both
 * sides — so it lengthens duels rather than deciding them.
 */
export async function pvpHollowExchange(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'hollowexchange', '')
}

/**
 * pvpHollowPurple(ctx) — entry point for the top-level `.hollowpurple` command
 * (plugins/purple.js) when the caller is in a duel rather than a PvE fight.
 * Same delegation shape as pvpCinderVerdict() above: plugins/purple.js only
 * knows the PvE battleState shape (bs.enemy), so it hands off here when
 * battleState.type === 'pvp'. Routes into the PvP turn engine as the
 * 'hollowpurple' action, which gates on Gojo being equipped and the
 * once-per-battle charge, then lands the 18x hit RAW: it bypasses DEF and never
 * misses, uncapped like the other signature ultimates (the fight-length hit cap
 * is gated to basic attack / skill only).
 */
export async function pvpHollowPurple(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'hollowpurple', '')
}

/**
 * pvpUnlimitedVoid(ctx) — entry point for the top-level `.unlimitedvoid` command
 * (plugins/domain.js) when the caller is in a duel rather than a PvE fight. Same
 * delegation shape as pvpCinderVerdict() above: plugins/domain.js only knows the
 * PvE battleState shape (bs.enemy), so it hands off here when
 * battleState.type === 'pvp'. Routes into the PvP turn engine as the
 * 'unlimitedvoid' action, which gates on Gojo being equipped and the
 * once-per-battle charge, then locks the opponent down with a hard stun for
 * UNLIMITED_VOID_STUN_TURNS of their turns. It deals no damage.
 */
export async function pvpUnlimitedVoid(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'unlimitedvoid', '')
}

/**
 * pvpKurohitsugi(ctx) — entry point for the top-level `.kurohitsugi` command
 * (plugins/kurohitsugi.js) when the caller is in a duel rather than a PvE
 * fight. Same delegation shape as pvpHollowPurple() above: plugins/kurohitsugi.js
 * only knows the PvE battleState shape (bs.enemy), so it hands off here when
 * battleState.type === 'pvp'. Routes into the PvP turn engine as the
 * 'kurohitsugi' action, which gates on Aizen being equipped and the
 * once-per-battle charge, then lands the coffin RAW: it bypasses DEF and never
 * misses, with the multiplier computed at hit time from his stolen senses and
 * how wounded the opponent already is (kurohitsugiMultiplier).
 */
export async function pvpKurohitsugi(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'kurohitsugi', '')
}

/**
 * pvpHogyoku(ctx) — entry point for the top-level `.hougyoku` command
 * (plugins/hogyoku.js) when the caller is in a duel. Same delegation shape as
 * pvpUnlimitedVoid() above: the PvE plugin only knows the PvE battleState shape
 * (bs.enemy), so it hands off here on battleState.type === 'pvp'. Routes in as
 * the 'hougyoku' action, which gates on Aizen being equipped and the
 * once-per-battle latch, then evolves him on the spot — heal, all five senses,
 * rest-of-battle stat surge. It deals no damage and the opponent takes no hit.
 */
export async function pvpHogyoku(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'hougyoku', '')
}

/**
 * pvpPuppetStrings(ctx) — entry point for the top-level `.puppet` command
 * (plugins/puppetry.js) when the caller is in a duel rather than a PvE fight.
 * Same delegation shape as pvpUnlimitedVoid() above: plugins/puppetry.js only
 * knows the PvE battleState shape (bs.enemy), so it hands off here when
 * battleState.type === 'pvp'. Routes into the PvP turn engine as the
 * 'puppetstrings' action, which gates on Red Rose being equipped and the
 * once-per-battle charge, then turns the opponent's own attack on themselves
 * (floored at 20% of their max HP, never lethal) and tangles them for
 * PUPPET_TANGLE_TURNS — one turn, companion and all.
 */
export async function pvpPuppetStrings(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'puppetstrings', '')
}

/**
 * pvpGreedTithe(ctx) - entry point for the top-level `.greed` command
 * (plugins/greed.js) when the caller is in a duel rather than a PvE fight.
 * Same delegation shape as pvpPuppetStrings() above: plugins/greed.js only
 * knows the PvE battleState shape (bs.enemy), so it hands off here when
 * battleState.type === 'pvp'. Routes into the PvP turn engine as the
 * 'greedtithe' action, which gates on Echidna being equipped and the
 * once-per-battle charge, then lifts a mood-shaped share of the OPPONENT'S
 * wallet (half when amused/capricious, a quarter when displeased - plus
 * gems stolen from them on a mood chance) into the caller's purse, and hangs
 * the opponent distracted for GREED_TANGLE_TURNS.
 */
export async function pvpGreedTithe(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'greedtithe', '')
}

/**
 * pvpTimeStop(ctx) — entry point for the top-level `.tms` command
 * (plugins/timestop.js) when the caller is in a duel. Same delegation shape as
 * pvpPuppetStrings() above: the PvE plugin only knows the PvE battleState shape
 * (bs.enemy), so it hands off here on battleState.type === 'pvp'. Routes in as
 * the 'timestop' action, which gates on Reverie being equipped and the
 * once-per-battle latch, then freezes the opponent — unless they own Montana,
 * who negates it and counters (see the 'timestop' resolution branch above).
 */
export async function pvpTimeStop(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'timestop', '')
}

/**
 * pvpSoulPunisher(ctx) — entry point for the top-level `.soulpunisher` command
 * (plugins/soulpunisher.js) when the caller is in a duel. Same delegation shape
 * as pvpCinderVerdict() above: the PvE plugin only knows the PvE battleState
 * shape (bs.enemy), so it hands off here on battleState.type === 'pvp'. Routes
 * in as the 'soulpunisher' action, which gates on Gogeta being equipped and on
 * the 2-turn cooldown (see activateSoulPunisher() in lib/gogeta.js).
 */
export async function pvpSoulPunisher(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'soulpunisher', '')
}

/**
 * pvpKamehameha(ctx) — entry point for the top-level `.kamehameha` command
 * (plugins/kamehameha.js) in a duel. Routes in as the 'kamehameha' action,
 * which gates on Gogeta being equipped, on the fusion still holding, on a FULL
 * energy bar (and empties it), and on the 8-turn cooldown. The beam art is sent
 * from inside the turn, on the turn it fires.
 */
export async function pvpKamehameha(ctx) {
  if (isBattleCinematicActive(ctx)) return
  const player = getPlayer(ctx.db, ctx.from)
  if (!inPvp(player)) {
    return ctx.reply(`❌ You're not in a duel.`)
  }
  return runPvpTurn(ctx, 'kamehameha', '')
}

/* ══════════════════════════════════════════════════════════════════════════
 * WAGER MODE
 *
 * Everything below serves the stake-on-the-line duel. The rules that make it a
 * different game (no turn order, a 2 second cooldown, no using the same move
 * twice in a row, no character powers, loser pays the full stake) live in
 * lib/pvp-wager.js; this half owns command routing and persistence, because
 * updatePlayer() has to stay top-level — see runPvpTurn's header for the
 * deadlock a nested call causes.
 *
 * The one rule every function here obeys: a two-player write is TWO separate,
 * sequentially-awaited updatePlayer() calls. Never nested, never Promise.all.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The trailing token of a kit command, when it is a count: `stock potion 3`.
 * Returned as [query, amount] so the item name keeps its spaces.
 */
function splitKitArgs(args) {
  const parts = [...args]
  const last = parts[parts.length - 1]
  if (parts.length > 1 && /^\d+$/.test(last ?? '')) {
    parts.pop()
    return [parts.join(' '), Math.max(1, Number(last))]
  }
  return [parts.join(' '), 1]
}

/**
 * stockKit — move copies of an item from the main inventory (or the chest) into
 * the 15-slot PvP kit. Refused mid-duel: the kit is what you brought, and being
 * able to top it up from your inventory while HP is on the line would make the
 * 15 slots meaningless.
 */
async function stockKit(ctx, args) {
  const { player, db } = ctx
  const pr = config.prefix
  const [query, amount] = splitKitArgs(args)

  if (!query) {
    const space = kitSpace(player)
    return ctx.reply(
      `❓ Usage: *${pr}pvp stock <item> [amount]*\n` +
      `_Example:_ *${pr}pvp stock health potion 5*\n\n` +
      `🎒 Kit: *${ensureKit(player).length}/${PVP_KIT_SLOTS}* slots _(${space} free)_\n` +
      `_See what's packed: *${pr}pvp inv*_`,
    )
  }
  if (inPvp(player)) {
    return ctx.reply(
      `🚫 *Not mid-duel.* The kit is whatever you packed before the bell.\n` +
      `_Use what you brought: *${pr}pvp dr <potion>* · *${pr}pvp tot* · *${pr}pvp inv*_`,
    )
  }

  let res = null
  await updatePlayer(db, ctx.from, (p) => { res = moveToKit(p, query, amount) })

  if (!res?.moved) {
    if (res?.reason === 'full') {
      return ctx.reply(
        `🎒 *Kit is full* — all ${PVP_KIT_SLOTS} slots are taken.\n` +
        `_Make room first: *${pr}pvp unstock <item>*_`,
      )
    }
    if (res?.reason === 'type') {
      return ctx.reply(
        `❌ *${res.itemName}* can't go in a PvP kit.\n` +
        `_Kits hold consumables, weapons, armour and relics. Not ${res.itemType ?? 'that'}._`,
      )
    }
    return ctx.reply(
      `❌ No *${query}* in your inventory or chest.\n` +
      `_Check *${pr}inventory*, or buy one with *${pr}shop*._`,
    )
  }

  const from = res.source === 'chest' ? 'chest' : 'inventory'
  const used = ensureKit(getPlayer(db, ctx.from)).length
  return ctx.reply(
    `🎒 Packed *${res.moved}× ${res.itemName}* into your PvP kit _(from your ${from})_.\n` +
    (res.partial ? `_Only ${res.moved} fit._\n` : '') +
    `📦 *${used}/${PVP_KIT_SLOTS}* slots  ·  *${res.count}× ${res.itemName}* now stocked\n` +
    `_View the grid: *${pr}pvp inv*_`,
  )
}

/**
 * unstockKit — the return trip. Respects the main inventory cap rather than
 * overflowing it, since the shed machinery in lib/inventory-limits.js exists
 * precisely so nothing silently vanishes over the line.
 */
async function unstockKit(ctx, args) {
  const { player, db } = ctx
  const pr = config.prefix
  const [query, amount] = splitKitArgs(args)

  if (!query) {
    return ctx.reply(
      `❓ Usage: *${pr}pvp unstock <item> [amount]*\n` +
      `_Puts it back in your inventory._\n\n` +
      kitPanel(player, pr),
    )
  }
  if (inPvp(player)) {
    return ctx.reply(`🚫 *Not mid-duel.* You can't unpack your kit while fighting out of it.`)
  }

  const cap = getInventoryCap(player)
  let res = null
  await updatePlayer(db, ctx.from, (p) => { res = takeFromKit(p, query, amount, cap) })

  if (!res?.moved) {
    if (res?.reason === 'inv-full') {
      return ctx.reply(
        `🎒 *Your inventory is full* _(${player.inventory?.length ?? 0}/${cap})_.\n` +
        `_Sell or use something first, then unstock again._`,
      )
    }
    return ctx.reply(`❌ No *${query}* in your PvP kit.\n_See what's packed: *${pr}pvp inv*_`)
  }

  const used = ensureKit(getPlayer(db, ctx.from)).length
  return ctx.reply(
    `↩️ Pulled *${res.moved}× ${res.itemName}* back into your inventory.\n` +
    (res.partial ? `_Inventory space ran out at ${res.moved}._\n` : '') +
    `📦 Kit: *${used}/${PVP_KIT_SLOTS}* slots`,
  )
}

/**
 * showKit — the kit as a drawn 5×3 grid, with the real item art in each box.
 * Falls back to the text panel if the render fails for any reason: a duel is a
 * bad moment to find out the canvas stack is unhappy, so this can never be the
 * thing that stops you seeing your own potions.
 */
async function showKit(ctx) {
  const { player } = ctx
  const pr = config.prefix
  const used = ensureKit(player).length
  const caption =
    `🎒 *PVP KIT* — ${used}/${PVP_KIT_SLOTS} slots\n` +
    `_A separate store from your inventory. Only what's in here can be used mid-duel._\n\n` +
    `📥 *${pr}pvp stock <item> [n]*  ·  📤 *${pr}pvp unstock <item> [n]*`

  try {
    const sent = await sendKitReply(ctx, player, caption)
    if (sent) return sent
  } catch (err) {
    console.error('[pvp] kit render failed:', err?.message ?? err)
  }
  return ctx.reply(kitPanel(player, pr))
}

/**
 * acceptWagerDuel — the opening bell, and the only place solars leave a wallet
 * to start a duel.
 *
 * Both stakes are escrowed here (see the ESCROW note in lib/pvp-wager.js: the
 * alternative loses to "spend your purse mid-duel and there's nothing to
 * collect"). That makes this the one function in the mode that can leave money
 * in a bad place, so the order is deliberate: charge the challenger first, and
 * if the accepter's own escrow then fails, refund the challenger before
 * returning. Nobody is ever charged for a duel that did not start.
 */
async function acceptWagerDuel(ctx, challengerJid, amount) {
  const { player, db } = ctx
  const pr = config.prefix
  const challenger = getPlayer(db, challengerJid)

  // Re-checked at the point of the charge, not trusted from challenge time:
  // two minutes is plenty to spend the purse this whole duel is built on.
  const myPurse = player.wallet?.solars ?? 0
  if (myPurse < amount) {
    await updatePlayer(db, ctx.from, (p) => { p.pvpChallenge = null })
    return ctx.reply(
      `☀️ *You can't cover that stake any more.*\n` +
      `Needed *${amount.toLocaleString()}*, you hold *${myPurse.toLocaleString()}*.\n` +
      `_Challenge declined automatically._`,
    )
  }
  if ((challenger.wallet?.solars ?? 0) < amount) {
    await updatePlayer(db, ctx.from, (p) => { p.pvpChallenge = null })
    return ctx.reply(
      `☀️ *${challenger.name}* has spent their stake money since challenging you.\n` +
      `_Wager cancelled. Nothing left your wallet._`,
    )
  }

  // ── charge the challenger ──
  let raceAborted = false
  let challengerOk = false
  await updatePlayer(db, challengerJid, (c) => {
    if (c.inBattle || c.inDungeon) { raceAborted = true; return }
    const esc = escrowStake(c, amount)
    if (!esc.ok) { raceAborted = true; return }
    challengerOk = true
    c.inBattle = true
    c.battleState = makeWagerState(ctx.from, amount)
  })
  if (raceAborted || !challengerOk) {
    await updatePlayer(db, ctx.from, (p) => { p.pvpChallenge = null })
    return ctx.reply(`❌ *${challenger.name}* is no longer able to take that wager.`)
  }

  // ── charge the accepter ──
  let mineOk = false
  await updatePlayer(db, ctx.from, (p) => {
    p.pvpChallenge = null
    const esc = escrowStake(p, amount)
    if (!esc.ok) return
    mineOk = true
    p.inBattle = true
    p.battleState = makeWagerState(challengerJid, amount)
  })
    if (!mineOk) {
      // Unwind the challenger's side. Their solars were taken a moment ago for a
      // duel that is not happening, so they go straight back.
      await updatePlayer(db, challengerJid, (c) => {
        refundStake(c, amount)
        clearWagerState(c)
      })
      return ctx.reply(`☀️ *Your stake couldn't be held.* Wager cancelled, nobody was charged.`)
    }

    // ── GUILD WAR pairing? Isolate both fighters behind Preset 5 NOW ──
    // Same contract as the normal accept path: war id stamped onto both
    // battleStates, real inventories stashed, the war kit loaded. Null for an
    // ordinary wager between two random players.
    const beforeChallenger = getPlayer(db, challengerJid)
    const beforeMe = getPlayer(db, ctx.from)
    const warDuel = await beginWarDuel(db, challengerJid, ctx.from)
    const them = warDuel ? getPlayer(db, challengerJid) : beforeChallenger
    const me = warDuel ? getPlayer(db, ctx.from) : beforeMe

    return ctx.reply(
      (warDuel
        ? `⚔️🔥 *GUILD WAR PAIRING — WAGER RULES!* 🔥⚔️\n` +
          `${warDuelKitLine(warDuel)}\n` +
          `_Your real inventory is stored and returns intact the moment this duel ends._\n\n`
        : '') +
      `💰⚔️ *WAGER DUEL — LIVE!* ⚔️💰\n\n` +
      `☀️ *${(amount * 2).toLocaleString()}* solars in the pot. Winner takes it all.\n\n` +
      `🥊 *${them.name}* Lv.${them.level}  vs  *${me.name}* Lv.${me.level}\n` +
      `❤️ ${them.name}: ${them.hp}/${them.maxHp}   ❤️ ${me.name}: ${me.hp}/${me.maxHp}\n\n` +
      `⚡ *NO TURNS.* Swing the moment you can.\n` +
      `⏱️ 2 second cooldown  ·  🚫 no same move twice in a row\n` +
      `🎭 No character powers. Stats, skills and your kit only.\n\n` +
      `⚔️ *${pr}pvp atk*  ·  ✨ *${pr}pvp sk <name>*  ·  🛡️ *${pr}pvp def*\n` +
      `🧪 *${pr}pvp dr <potion>*  ·  🪬 *${pr}pvp tot*  ·  🔧 *${pr}pvp mnd wpn*\n` +
      `_Free to check anytime: *${pr}pvp status* · *${pr}pvp moves* · *${pr}pvp inv*_\n\n` +
      `🔔 *GO.*`,
    )
}

/**
 * runWagerAction — one attack / skill / defend in a wager duel.
 *
 * The shape mirrors runPvpTurn's (snapshot both sides, resolve, then write each
 * player with its own top-level updatePlayer) but is a fraction of its size,
 * because everything runPvpTurn is long for — cat form, Hypnosis, domains, wild
 * cards, beast interventions, the tear/sever passives — is switched off here.
 * resolveWagerAction mutates the two snapshots in memory; this function's whole
 * job is to gate, persist, and narrate.
 */
async function runWagerAction(ctx, action, query) {
  const { db } = ctx
  const pr = config.prefix
  const actorJid = ctx.from

  const actor = getPlayer(db, actorJid)
  if (!inPvp(actor) || !isWagerState(actor.battleState)) {
    return ctx.reply(`❌ You're not in a wager duel.`)
  }
  const opponentJid = actor.battleState.opponentJid
  const stake = actor.battleState.wagerAmount ?? 0

  if (!playerExists(db, opponentJid)) {
    let back = 0
    await updatePlayer(db, actorJid, (p) => {
      back = refundStake(p, stake)
      clearWagerState(p)
    })
    return ctx.reply(
      `❌ Your opponent is no longer registered — wager voided.\n` +
      `☀️ Your *${stake.toLocaleString()}* solar stake is back. _(balance: ${back.toLocaleString()})_`,
    )
  }

  // ── pacing ──
  // Read-only, so a refused command costs nothing: no cooldown bump, no entry
  // in the repeat window. Being told "too fast" must never cost you tempo.
  // hasUsableSkill is passed so the window can tell a player who is holding a
  // castable skill back from one who has no third move at all: refusing the
  // latter would leave them with nothing legal and hang the duel.
  const gate = checkPacing(actor.battleState, action, { hasUsableSkill: hasUsableSkill(actor) })
  if (!gate.ok) return ctx.reply(pacingMessage(gate, pr))

  const opp = getPlayer(db, opponentJid)
  const hpBeforeTurn = actor.hp
  const eHpBeforeTurn = opp.hp

  // resolveWagerAction mutates BOTH objects. These are the live db.data records
  // (getPlayer hands back the object itself, not a copy), so the updatePlayer
  // calls below persist the same mutations rather than reapplying them — they
  // exist to put the writes through the queue and trigger the flush.
  const res = resolveWagerAction(actor, opp, action, query)
  if (!res.ok) return ctx.reply(res.msg)

  // Two writes, sequential, top-level. See the note at the top of this section.
  await updatePlayer(db, actorJid, () => {})
  await updatePlayer(db, opponentJid, () => {})

  let msg = res.msg

  // The window let a repeat through because nothing else was playable. Say so on
  // the turn it happened, so the rule never looks like it silently broke.
  if (gate.forced) msg += PACING_FORCED_NOTE

  // ── the totem ate a killing blow ──
  // Its own message, sent before the turn's frame, because the whole point is
  // that the kill did not happen. Awaited so it cannot land after the board it is
  // supposed to precede. It can never throw, and a missing GIF is a no-op: the
  // narrative line is already inside res.msg either way.
  if (res.revived) {
    const saved = res.revived === 'actor' ? actor : opp
    await sendTotemReviveAnimation(ctx, saved.name, { isClasp: !!saved.lastReviveWasClasp })
  }

  // ── did anyone fall? ──
  if (res.oppDefeated) {
    return pvpConclude(
      db, actorJid, opponentJid, ctx,
      `${msg}\n\n_${opp.name} falls with the stake on the line!_`,
      { allowRewind: false },
    )
  }
  if (res.actorDefeated) {
    return pvpConclude(
      db, opponentJid, actorJid, ctx,
      `${msg}\n\n_${actor.name} drops from their own wounds!_`,
      { allowRewind: false },
    )
  }

  const actorFinal = getPlayer(db, actorJid)
  const oppFinal = getPlayer(db, opponentJid)
  msg +=
    `\n\n━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 *WAGER* ☀️ ${stake.toLocaleString()}  ·  pot ${(stake * 2).toLocaleString()}\n` +
    `❤️ *${actorFinal.name}* ${hpBar(actorFinal.hp, actorFinal.maxHp)} ${actorFinal.hp}/${actorFinal.maxHp}\n` +
    `❤️ *${oppFinal.name}* ${hpBar(oppFinal.hp, oppFinal.maxHp)} ${oppFinal.hp}/${oppFinal.maxHp}\n` +
    `⏱️ _2s cooldown running. No turns: they can swing right now._`

  await sendBattleTurnReply(ctx, {
    player: actorFinal, e: oppFinal, msg,
    hpBeforeTurn, eHpBeforeTurn,
    isPvp: true,
    isDefending: action === 'defend',
  })
}

/**
 * runWagerItem — the free, parallel item actions: drink, totem, armour swap,
 * weapon swap, mend, PP refill.
 *
 * They bump the 2-second clock (so you cannot chain six of them in one breath)
 * but never enter the no-repeat window, because swapping a totem must never be
 * the reason you cannot attack next. They touch only the acting player, so this
 * is the one path in the mode with a single write.
 */
async function runWagerItem(ctx, kind, query) {
  const { db } = ctx
  const pr = config.prefix
  const actorJid = ctx.from

  const actor = getPlayer(db, actorJid)
  if (!inPvp(actor) || !isWagerState(actor.battleState)) {
    return ctx.reply(`❌ You're not in a wager duel.`)
  }

  const gate = checkPacing(actor.battleState, kind)
  if (!gate.ok) return ctx.reply(pacingMessage(gate, pr))

  if (kind === 'mend' && !query) {
    return ctx.reply(
      `❓ Mend what? *${pr}pvp mnd wpn* _(weapon)_ or *${pr}pvp mnd arm* _(armour)_.\n` +
      `_Restores half the durability already lost._`,
    )
  }

  let res = null
  await updatePlayer(db, actorJid, (p) => {
    switch (kind) {
      case 'drink':  res = drinkFromKit(p, query); break
      case 'totem':  res = swapTotemFromKit(p); break
      case 'armor':  res = swapArmorFromKit(p, (query.split(/\s+/)[0] ?? ''), query.split(/\s+/).slice(1).join(' ')); break
      case 'weapon': res = swapWeaponFromKit(p, query); break
      case 'mend':   res = mendFromKit(p, query); break
      case 'refill': res = refillPpFromKit(p); break
      default:       res = { ok: false, msg: `❌ Unknown item action.` }
    }
    // A refused action must not cost the cooldown either — the player got
    // nothing for it. Only a real one bumps the clock.
    if (res?.ok) notePacing(p.battleState, kind)
  })

  if (!res?.ok) return ctx.reply(res?.msg ?? `❌ That didn't work.`)

  const after = getPlayer(db, actorJid)
  return ctx.reply(
    `${res.msg}\n\n` +
    `❤️ ${after.hp}/${after.maxHp}  ·  💧 ${after.mp}/${after.maxMp}  ·  🎒 ${ensureKit(after).length}/${PVP_KIT_SLOTS}\n` +
    `_That cost you no move. Swing when the 2s clock clears._`,
  )
}

/**
 * showWagerMoves — the wager move list.
 *
 * Deliberately NOT moveOptions() from lib/pvp-engine.js: that list includes
 * equipped abilities and reads a turn flag, and in this mode both would be a
 * lie. What it shows instead is what actually decides a wager duel: PP left on
 * each skill, what the repeat rule is currently blocking, and the kit actions
 * that cost no move at all.
 */
async function showWagerMoves(ctx) {
  const { player } = ctx
  const pr = config.prefix
  const bs = player.battleState
  const cd = Math.max(0, 2000 - (Date.now() - (bs.lastCommandAt ?? 0)))
  const blocked = new Set(bs.lastActions ?? [])

  const known = (player.skills ?? [])
    .map((id) => allSkills.find((s) => s.id === id))
    .filter((s) => s && s.type !== 'passive')

  const skillLines = known.length
    ? known.slice(0, 12).map((s) => {
        const left = ppLeft(bs, s)
        const max = maxPpFor(s)
        const affordable = (player.mp ?? 0) >= (s.mpCost ?? 0)
        const usable = left > 0 && affordable && !blocked.has('skill')
        return `${usable ? '✅' : '⛔'} ✨ *${s.name}* — _${s.mpCost ?? 0} MP · PP ${left}/${max}_` +
          `\n    \`${pr}pvp sk ${s.name}\``
      })
    : [`_You know no active skills. Basic attacks only._`]

  const kit = ensureKit(player)
  return ctx.reply(
    `🎯 *WAGER MOVES* — ☀️ ${(bs.wagerAmount ?? 0).toLocaleString()} on the line\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${blocked.has('attack') ? '⛔' : '✅'} ⚔️ *Attack* — _no cost_\n    \`${pr}pvp atk\`\n` +
    `${blocked.has('defend') ? '⛔' : '✅'} 🛡️ *Defend* — _halves the next hit, +10% MP_\n    \`${pr}pvp def\`\n` +
    `${skillLines.join('\n')}\n\n` +
    `🎒 *FROM YOUR KIT* _(free, costs no move)_ — ${kit.length}/${PVP_KIT_SLOTS} packed\n` +
    `🧪 \`${pr}pvp dr <potion>\`  ·  🪬 \`${pr}pvp tot\`\n` +
    `🛡️ \`${pr}pvp arm <slot>\`  ·  ⚔️ \`${pr}pvp wpn\`\n` +
    `🔧 \`${pr}pvp mnd wpn|arm\`  ·  🌀 \`${pr}pvp rf\`\n\n` +
    `🚫 *No character powers in this mode.*\n` +
    (blocked.size ? `🚫 Cannot repeat: ${[...blocked].join(' → ')}\n` : '') +
    (cd > 0 ? `⏱️ Cooldown: ${(cd / 1000).toFixed(1)}s\n` : `⏱️ *Ready.*\n`) +
    `_No turns. Whoever moves first, moves._`,
  )
}

/**
 * wagerStakeOf — the stake riding on a duel between these two, or 0.
 *
 * Read off battleState rather than a side ledger, which is why an interrupted
 * duel can always be refunded from the state itself. Either side is enough: a
 * duel where only one record still carries the flag (a half-applied write, a
 * record restored from backup) is still a wager as far as settlement goes, and
 * paying it out is safer than silently reverting to the 5% steal.
 */
function wagerStakeOf(db, winnerJid, loserJid) {
  const w = getPlayer(db, winnerJid)
  const l = getPlayer(db, loserJid)
  if (isWagerState(w?.battleState)) return w.battleState.wagerAmount ?? 0
  if (isWagerState(l?.battleState)) return l.battleState.wagerAmount ?? 0
  return 0
}

/**
 * pvpConcludeWager — settlement.
 *
 * Both stakes are already out of both wallets (escrowed at accept), so the
 * winner collects double and the loser collects nothing: net +stake / -stake,
 * which is what "the loser pays the full stake" means. The normal ending's 5%
 * seizure does NOT also apply — the stake replaces it, it is not stacked on top.
 *
 * The ladder still moves, because a wager duel is a real duel. Everything that
 * is a reward rather than a result is deliberately left out: no guild spoils, no
 * season points, no beast CP, no XP. Those are progression, and progression you
 * can buy with solars is a treadmill, not a duel.
 */
async function pvpConcludeWager(db, winnerJid, loserJid, ctx, reasonLine, stake) {
  const pr = config.prefix
  const winnerSnapshot = getPlayer(db, winnerJid)
  const loserSnapshot = getPlayer(db, loserJid)

  // Same rule as pvpConclude: the swing is computed from both ratings as they
  // stand right now, before either side is written.
  ensurePvp(winnerSnapshot ?? {})
  ensurePvp(loserSnapshot ?? {})
  const delta = ratingDelta(ratingOf(winnerSnapshot), ratingOf(loserSnapshot))

  let winnerName = winnerSnapshot?.name ?? 'Winner'
  let loserName = loserSnapshot?.name ?? 'Loser'
  let winnerPurse = 0
  let loserPurse = 0

  await updatePlayer(db, loserJid, (loser) => {
    loserName = loser.name
    // Nothing is deducted here: the stake left this wallet at accept.
    loserPurse = loser.wallet?.solars ?? 0
    recordLoss(loser, winnerName, delta, stake)
    loser.pvp.lastOpponentJid = winnerJid
    clearWagerState(loser)
  })

  await updatePlayer(db, winnerJid, (winner) => {
    winnerName = winner.name
    winnerPurse = payWagerPot(winner, stake)
    recordWin(winner, loserName, delta, stake)
    winner.pvp.lastOpponentJid = loserJid
    clearWagerState(winner)
  })

  const winnerAfter = getPlayer(db, winnerJid)
  const loserAfter = getPlayer(db, loserJid)
  const winnerBand = rankFor(winnerAfter)
  const loserBand = rankFor(loserAfter)

  return ctx.reply(
    `💰🏆 *WAGER SETTLED!* 🏆💰\n\n` +
    reasonLine + `\n\n` +
    `👑 *${winnerName.toUpperCase()} TAKES THE POT!*\n` +
    `☀️ *+${(stake * 2).toLocaleString()}* solars collected _(their ${stake.toLocaleString()} stake back, plus ${loserName}'s)_\n` +
    `💸 *${loserName}* is down *${stake.toLocaleString()}* solars.\n\n` +
    `💼 *${winnerName}*: ☀️ ${winnerPurse.toLocaleString()}\n` +
    `💼 *${loserName}*: ☀️ ${loserPurse.toLocaleString()}\n\n` +
    `📈 *RATING*\n` +
    `${winnerBand.emoji} *${winnerName}*: ${ratingOf(winnerAfter)} _(+${delta})_  ·  streak ${streakLabel(winnerAfter)}\n` +
    `${loserBand.emoji} *${loserName}*: ${ratingOf(loserAfter)} _(-${delta})_  ·  streak ${streakLabel(loserAfter)}\n\n` +
    `❤️‍🩹 Both fighters are fully healed. No gear was lost.\n` +
    `🎒 _Whatever you didn't spend is still in your kit._\n\n` +
    `_Again: *${pr}pvp wager ${stake} @them* · Ladder: *${pr}pvptop*_`,
  )
}

/**
 * voidWagerDuel — end a wager duel with no winner and no ladder movement.
 *
 * Used when nothing anybody did decided it: a mutual timeout, or an opponent who
 * stopped existing. Refunding both sides is the only defensible outcome, since
 * awarding a stake off five minutes of shared silence would make walking away
 * from a duel you are losing a coin flip worth taking.
 */
async function voidWagerDuel(db, ctx, aJid, bJid, headline, oppName) {
  const stake = wagerStakeOf(db, aJid, bJid)
  const pr = config.prefix

  let aBack = 0
  await updatePlayer(db, aJid, (p) => {
    aBack = refundStake(p, stake)
    clearWagerState(p)
    // A GUILD WAR pairing voids its duel here too — Preset 5 comes off and
    // the real inventory returns. The pairing itself stays open (sweep or a
    // fresh accept will settle it), so the war is never decided by silence.
    if (hasWarKit(p)) removeWarKitPublic(p)
  })

  let bBack = 0
  if (playerExists(db, bJid)) {
    await updatePlayer(db, bJid, (p) => {
      bBack = refundStake(p, stake)
      clearWagerState(p)
      if (hasWarKit(p)) removeWarKitPublic(p)
    })
  }

  const me = getPlayer(db, aJid)
  return ctx.reply(
    `${headline}\n\n` +
    `☀️ Both stakes refunded in full: *${stake.toLocaleString()}* each.\n` +
    `💼 *${me.name}*: ☀️ ${aBack.toLocaleString()}\n` +
    (bBack ? `💼 *${oppName}*: ☀️ ${bBack.toLocaleString()}\n` : '') +
    `\n📊 No rating change. Nobody won this.\n` +
    `❤️‍🩹 Both fighters are healed and free.\n\n` +
    `_Try again: *${pr}pvp wager ${stake} @them*_`,
  )
}
