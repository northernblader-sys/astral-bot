/**
 * combat-handlers.js — Shared death and victory logic used by all combat plugins.
 * No I/O except through ctx.reply(). Called after every attack/skill/defend turn.
 */
import { config } from '../config.js'
import { sendImage } from './image.js'
import { rankSlug } from './rank-engine.js'
import { locationsMap, allItems, classes, races, skills as allSkills, levelsData, getTotalStats, getAnimeBossById, characterMap } from './game-data.js'
import { rollDrops, applyLevelUps, hpBar, getNewlyUnlockedSkills, applyEquipmentBonus, calcMonsterDamage } from './combat-engine.js'
import { hasEffect, tickEffects, absorbDamage, getEffectiveStat, addStatusEffect } from './effects.js'
import { awardFame, applyFamePayout, formatFame } from './fame-engine.js'
import { cleanupBossFight, buildEnemyAttack, applyBossSpecial, EVENT, getBossVictoryLines, isLiveBossFight } from './boss-engine.js'
import { sendCinematicBody, sendBossLines } from './boss-cinematic.js'
import { updatePlayer } from './player-repo.js'
import { speedKillXp, DUNGEON_KILL_XP, LOCATION_REWARD_MULT } from './xp-regulator.js'
import { isPremiumActive, hasAutoReviveAvailable, markAutoReviveUsed } from './premium.js'
import { hasInventoryRoom } from './inventory-limits.js'
import { awardBeastCp } from './beast-engine.js'
import { playerLevelCap } from './reborn-engine.js'
import { creditPrestigeXp } from './title-engine.js'
import { hasMod, getModValue, ownsDisconnectedMod } from './mods.js'
import { resetHunger } from './hunger-engine.js'
import { getActiveSeason, applySeasonPoints, applySeasonLevel, ensurePlayerSeasonState } from './season-engine.js'
import { perkTotal } from './housing-engine.js'
import {
  claimEndDefeat, syncEndWeakenForAll, getEndEvent, THE_END_BOSS_ID,
} from './end-event.js'
import { recordQuestEvent } from './quest-engine.js'
import {
  grantYoriichiExp,
  checkYoriichiCatForm,
  resolveCatFormAction,
  applyIncomingDamage,
  healCatFormPool,
  canHypnosisRewind,
  resolveHypnosisRewind,
  buildHypnosisMessage,
  buildHypnosisSpentLine,
  clearHypnosis,
  awakenYatoTrueForm,
  tickFusion,
  montanaBreakFree,
  STREAMER_CHARACTER_ID,
} from './character-abilities.js'

/**
 * ═══ Yoriichi's cat form — the PvE driver ════════════════════════════════════
 *
 * The mechanic itself lives in lib/yoriichi.js. This section is only the part
 * that PLAYS her rounds in a dungeon fight, and the whole point of it is that
 * SHE plays them: the owner is unconscious, gets no turn, and is never offered
 * one in any message.
 *
 * That is a rewrite, not a tweak. The old driver was an *interceptor* — it sat
 * at the top of the seven combat plugins and resolved one of her turns each
 * time the owner typed `.attack`. So if the owner typed nothing she did
 * nothing, and every turn reply ended with
 * "*.attack* · *.skill <name>* · *.defend* · *.flee*", handing the turn straight
 * back to a player who is supposed to be on the floor. runCatFormAutoFight()
 * below replaces both halves of that: it resolves the fight to a real
 * conclusion the moment she stands up, and nothing it prints is a command.
 */

/**
 * Hard stop on the autonomous loop. Not expected to be reached — she hits for
 * CAT_FORM_ATTACK_MULT and dungeon enemies do not out-heal that — but the loop
 * runs inside an updatePlayer() mutator, so "unbounded" is not an option. On
 * the cap she stays up and the fight simply continues on the owner's next
 * command; the cap NEVER fabricates a win or a loss.
 */
const CAT_FORM_MAX_AUTO_ROUNDS = 60
const CAT_FORM_MAX_MESSAGES = 4
const CAT_FORM_CHUNK_CHARS = 1600

/**
 * A compact "Yoriichi's own HP pool" line. While cat form is active the owner's
 * hp is pinned at 1 (see checkYoriichiCatForm) and Yoriichi fights from this
 * separate pool, so her replies would otherwise show no HP bar at all. Returns
 * '' when cat form isn't active. Mirrors the PvP footer's cat-form line.
 */
function catFormStatusLine(player) {
  const cat = player?.battleState?.yoriichiCatFormActive
  if (!cat) return ''
  return `\n\n🐈‍⬛ *Yoriichi*: ${hpBar(cat.hp, cat.maxHp)}  _${cat.hp}/${cat.maxHp} cat-form HP_`
}

/**
 * Footer for a fight that is still going: her pool and the enemy's remaining
 * HP, and NOTHING ELSE.
 *
 * There used to be a `*.attack* · *.skill <name>* · *.defend* · *.flee*` line
 * here and an MP readout above it. Both are gone on purpose and must not come
 * back: she picks her own moves, so the owner's MP is not spent and the owner
 * has no move to type. Printing one told the player the turn was theirs, which
 * is the single most visible half of what was wrong with cat form.
 */
function catFormOngoingFooter(player, enemy = null) {
  let out = catFormStatusLine(player)
  if (enemy) out += `\n${enemy.emoji ?? '👾'} *${enemy.name}*: ${hpBar(enemy.hp, enemy.maxHp)}`
  out += `\n\n_Yoriichi is still fighting. You have no turn, she doesn't need one._`
  return out
}

/**
 * resolveCatFormRound(player, enemy, { boss, moveOnly })
 *   -> { text, outcome: null|'victory'|'defeat', dealt, taken }
 *
 * ONE round of the fight she is running, in narration order:
 *
 *   1. the owner's status effects tick — redirected into her pool (below)
 *   2. Yoriichi attacks
 *   3. the enemy's status effects tick
 *   4. the enemy swings back — into her pool
 *   5. the turn counter advances
 *
 * `moveOnly` runs step 2 alone. It is for the very first round on the trigger
 * turn: the swing that killed the owner IS what woke her, the calling plugin
 * has already ticked both status blocks for that turn, and giving the enemy a
 * second swing in the same turn would tax her for the owner's death twice.
 *
 * PURE AND SYNCHRONOUS, and that is load-bearing rather than stylistic. Every
 * caller reaches this from inside an updatePlayer() mutator, and mutators hold
 * a shared global write queue (lib/player-repo.js's runExclusive) — one await
 * on a network send or a setTimeout in here stalls every other player's
 * commands for as long as the fight runs. All I/O happens in
 * runCatFormAutoFight() after the last round has been resolved.
 */
function resolveCatFormRound(player, e, { boss = false, moveOnly = false } = {}) {
  const bs = player.battleState
  const poolBefore = bs.yoriichiCatFormActive?.hp ?? 0
  let msg = ''
  let dealt = 0

  const done = (outcome) => ({
    text: msg,
    outcome,
    dealt,
    taken: Math.max(0, poolBefore - (bs.yoriichiCatFormActive?.hp ?? 0)),
  })

  // ── 1. The owner's status effects still tick — otherwise a shield or a burn
  // applied during cat form would never expire. But the owner's hp is pinned
  // at 1 while she fights, so the tick's hp change is lifted straight back off
  // the owner and redirected into HER pool: DOT damage goes through
  // applyIncomingDamage() like every other point of damage during cat form,
  // and regen heals the pool. Without this, burn/poison would drag the pinned
  // hp past 0 and kill the owner for real behind Yoriichi's back — cat form is
  // already spent by then, so nothing would intercept it a second time.
  let incapacitated = false
  if (!moveOnly) {
    const ownerHpBeforeTick = player.hp
    const ownerStatus = processStatusTurn(player)
    const tickDelta = player.hp - ownerHpBeforeTick
    player.hp = ownerHpBeforeTick
    incapacitated = ownerStatus.incapacitated
    if (ownerStatus.lines.length) msg += ownerStatus.lines.join('\n') + '\n'
    if (tickDelta < 0) {
      const applied = applyIncomingDamage(player, -tickDelta)
      if (applied.message) msg += applied.message + '\n'
      if (applied.catFormDefeated) return done('defeat')
    } else if (tickDelta > 0) {
      const healed = healCatFormPool(player, tickDelta)
      if (healed > 0) msg += `🐈‍⬛💚 *Yoriichi* recovers *${healed} HP*!\n`
    }
  }

  // ── 2. Her move. No `skill` is threaded in and no MP is spent: she is a
  // combatant, not a puppet the owner drives. See resolveCatFormAction().
  if (incapacitated) {
    msg += `💫 *Yoriichi* is unable to act this turn!\n`
  } else {
    const enemyHpBefore = e.hp
    const action = resolveCatFormAction(player, e)
    dealt += Math.max(0, enemyHpBefore - e.hp)
    msg += action.message
    if (action.opponentDefeated) return done('victory')
  }
  if (moveOnly) return done(null)

  // ── 3. The enemy's status effects tick before it swings back ─────────────
  const enemyStatus = processStatusTurn(e)
  if (enemyStatus.lines.length) msg += enemyStatus.lines.join('\n') + '\n'
  if (e.hp <= 0) return done('victory')

  // ── 4. Enemy counter-attack — lands on Yoriichi's pool ──────────────────
  // Mitigated by the OWNER's DEF and absorbed by the owner's shields, then
  // routed through applyIncomingDamage() which rolls her dodge and drains her
  // pool instead of the owner's hp. That's the same ordering every other
  // combat plugin uses; the only difference is who ends up eating the damage.
  if (enemyStatus.incapacitated) {
    msg += `💫 *${e.name}* is unable to attack this turn!\n`
  } else if (boss) {
    const bossAtk = buildEnemyAttack(player)
    const dealResult = applyBossSpecial(player, EVENT.ENEMY_DEAL_DAMAGE, {
      damage: bossAtk.damage,
      isHit: true,
    })
    const rawBossAtk =
      dealResult.modified && dealResult.damage !== undefined
        ? dealResult.damage
        : bossAtk.damage
    const hitList = Array.isArray(dealResult.guaranteedHits) ? dealResult.guaranteedHits : null

    let totalDmg = 0
    if (hitList) {
      msg += `${e.emoji ?? '👾'} *${e.name}* unleashes *${bossAtk.attackName}*! _(${hitList.length} hits, ignores DEF)_\n`
      for (const hDmg of hitList) {
        const applied = applyIncomingDamage(player, hDmg)
        totalDmg += applied.damage
        if (applied.message) msg += applied.message + '\n'
        if (applied.catFormDefeated) return done('defeat')
      }
      msg += `🩸 *${totalDmg}* total damage!\n`
    } else {
      const mitigate = (dmg) =>
        bossAtk.bypassDefense ? dmg : calcMonsterDamage(dmg, getEffectiveStat(player, 'def'), false)
      const hits = bossAtk.doubleStrike ? [rawBossAtk, rawBossAtk] : [rawBossAtk]
      msg += `${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*!${bossAtk.doubleStrike ? ' ⚡ *DOUBLE STRIKE!*' : ''}${bossAtk.bypassDefense ? ' _(bypasses DEF)_' : ''}\n`
      let shieldBlocked = 0
      for (const hit of hits) {
        const incoming = mitigate(hit)
        const absorbed = absorbDamage(player, incoming)
        shieldBlocked += incoming - absorbed
        const applied = applyIncomingDamage(player, absorbed)
        totalDmg += applied.damage
        if (applied.message) msg += applied.message + '\n'
        if (applied.catFormDefeated) return done('defeat')
      }
      if (shieldBlocked > 0) msg += `🛡️ Shield absorbed *${shieldBlocked}* damage!\n`
    }
    if (bossAtk.narrativeLines?.length) msg += `_${bossAtk.narrativeLines[0]}_\n`
    if (dealResult.narrativeLine) msg += `_${dealResult.narrativeLine}_\n`
    // The MP-drain and stat-drain riders on the boss's damage event are both
    // deliberately skipped now. They chew on the OWNER's stat block and MP
    // pool, and Yoriichi reads neither: she spends no MP (she casts nothing)
    // and her damage comes off her own numbers. Draining them would be an
    // invisible tax on a player who is unconscious and can't respond to it.
  } else {
    const enemyDmg = calcMonsterDamage(
      getEffectiveStat(e, 'atk'),
      getEffectiveStat(player, 'def'),
      false,
    )
    msg += `${e.emoji ?? '👾'} *${e.name}* strikes back at *Yoriichi*!\n`
    const absorbed = absorbDamage(player, enemyDmg)
    const shieldBlocked = enemyDmg - absorbed
    const applied = applyIncomingDamage(player, absorbed)
    // applied.message carries the outcome — her dodge line, or
    // resolveCatFormDamage()'s "takes N damage (x/y HP)".
    if (applied.message) msg += applied.message + '\n'
    if (shieldBlocked > 0) msg += `🛡️ Shield absorbed *${shieldBlocked}* damage!\n`
    if (applied.catFormDefeated) return done('defeat')
  }

  // The counter could still have finished the enemy off (reflect, thorns-style
  // named effects baked into the boss result) — check before advancing.
  if (e.hp <= 0) return done('victory')

  // ── 5. Advance the turn ─────────────────────────────────────────────────
  bs.turn = (bs.turn ?? 1) + 1
  return done(null)
}

/**
 * Turn the per-round narration into messages to send.
 *
 * Her fights are usually short, but a 60-round grind against a tanky boss would
 * be ~12,000 characters, which is not one message on any platform the bot talks
 * to. Over budget, the middle rounds are elided with an explicit count — the
 * alternative is silent truncation, which would read as "the fight was short"
 * when it wasn't.
 */
function renderCatFormLog(roundTexts) {
  let parts = roundTexts
  const total = parts.reduce((n, t) => n + t.length, 0)
  if (total > CAT_FORM_MAX_MESSAGES * CAT_FORM_CHUNK_CHARS && parts.length > 9) {
    const head = parts.slice(0, 4)
    const tail = parts.slice(-4)
    const elided = parts.length - head.length - tail.length
    parts = [...head, `\n_...${elided} more rounds pass. She keeps swinging._\n`, ...tail]
  }
  const msgs = []
  let cur = ''
  for (const part of parts) {
    if (cur && cur.length + part.length > CAT_FORM_CHUNK_CHARS) {
      msgs.push(cur)
      cur = ''
    }
    cur += part
  }
  if (cur) msgs.push(cur)
  return msgs.length ? msgs : ['']
}

/**
 * runCatFormAutoFight(player, ctx, { boss, preamble, moveOnlyFirstRound })
 *   -> { resolved, returnValue }
 *
 * THE thing the owner's death buys: the bot plays Yoriichi's fight out itself
 * and narrates every round of it. Rounds are resolved back to back with no
 * input from anyone until the enemy falls, her pool drains, or
 * CAT_FORM_MAX_AUTO_ROUNDS is hit, then the whole log is sent and the fight is
 * handed to handleVictory() / resolveCatFormDefeat() exactly as a normal fight
 * would be.
 *
 * resolved: false means cat form isn't active or there is no enemy on the
 * battleState — the caller should carry on with whatever it was doing.
 *
 * Why it doesn't pace the rounds with sleeps, which would obviously look
 * better: see resolveCatFormRound()'s note on the write queue. Rounds are all
 * resolved first precisely so that the awaits below are the only ones, and they
 * are no worse than the replies handleVictory() already sends from the same
 * place.
 */
export async function runCatFormAutoFight(
  player,
  ctx,
  { boss = false, preamble = '', moveOnlyFirstRound = false } = {},
) {
  const bs = player?.battleState
  const e = bs?.enemy
  if (!bs?.yoriichiCatFormActive || !e) return { resolved: false, returnValue: player }

  const roundTexts = []
  let outcome = 'capped'
  let rounds = 0
  let dealt = 0
  let taken = 0

  while (rounds < CAT_FORM_MAX_AUTO_ROUNDS) {
    const moveOnly = moveOnlyFirstRound && rounds === 0
    rounds++
    const r = resolveCatFormRound(player, e, { boss, moveOnly })
    dealt += r.dealt
    taken += r.taken
    roundTexts.push(`\n🐾 *Round ${rounds}*\n${r.text.trim()}\n`)
    if (r.outcome) {
      outcome = r.outcome
      break
    }
  }
  player.battleState = bs

  // The tally is how the bot "records" the fight in one glance — without it a
  // long log is just a wall of strikes with no scoreboard.
  const tally =
    `\n━━━━━━━━━━━━━━━━━━━━━\n` +
    `🐈‍⬛ *${rounds} round${rounds === 1 ? '' : 's'}*, Yoriichi dealt *${dealt}* and took *${taken}*.`

  const msgs = renderCatFormLog(roundTexts)
  if (preamble) msgs[0] = preamble.trimEnd() + '\n' + msgs[0]
  msgs[msgs.length - 1] +=
    tally + (outcome === 'capped' ? catFormOngoingFooter(player, e) : '')
  for (const m of msgs) await ctx.reply(m.trim())

  if (outcome === 'victory') {
    if (boss) cleanupBossFight(player)
    return { resolved: true, returnValue: await handleVictory(player, e, ctx) }
  }
  if (outcome === 'defeat') {
    return { resolved: true, returnValue: await resolveCatFormDefeat(player, ctx, { boss }) }
  }
  return { resolved: true, returnValue: player }
}

/**
 * checkCatFormOngoingTurn(player, ctx, { boss, skill }) -> { intercepted, returnValue? }
 *
 * The guard at the top of attack/defend/skill/useability/flee/cinderverdict/
 * wildcard. Same name and same contract as before so those seven files need no
 * edit, but its job is now the opposite of what it was: it does NOT resolve the
 * owner's move on Yoriichi's behalf. The owner has no move. It says so, and
 * resumes her fight.
 *
 * `skill` is still accepted so plugins/skill.js's call site keeps compiling, and
 * is deliberately IGNORED — including its MP cost, which is not deducted. The
 * old version spent the MP and let `.skill <name>` steer her, which was the
 * command-hint footer's defect wearing a different hat.
 *
 * Only reachable at all after a CAT_FORM_MAX_AUTO_ROUNDS cap or a process
 * restart mid-fight; a normal cat form has already resolved to a win or a loss
 * before the owner can type anything.
 */
export async function checkCatFormOngoingTurn(player, ctx, { boss = false, skill = null } = {}) {
  const bs = player?.battleState
  if (!bs?.yoriichiCatFormActive) return { intercepted: false }
  if (!bs.enemy) return { intercepted: false }

  const res = await runCatFormAutoFight(player, ctx, {
    boss,
    preamble:
      `🐈‍⬛ *Yoriichi is fighting this one.*\n` +
      `_${player.name} is down. She doesn't take orders, and she isn't finished:_\n`,
  })
  return { intercepted: true, returnValue: res.returnValue }
}

/**
 * Finish a PvE fight when damage drains Yoriichi's separate HP pool.
 * The owner's HP is intentionally not the source of truth while cat form is
 * active, so callers must use the flag returned by applyIncomingDamage().
 */
export async function resolveCatFormDefeat(player, ctx, { boss = false } = {}) {
  if (boss) cleanupBossFight(player)
  return handleDeath(player, ctx)
}

/**
 * checkTotemRevive(player) — call this at every "player.hp <= 0" check,
 * BEFORE handleDeath. Unlike handleDeath's other save mechanisms, the
 * Totem of Undying keeps the player IN the fight: it does not end the
 * battle, strip gear, or teleport them. It just restores 40% HP/MP,
 * consumes itself (offhand slot cleared), and lets the calling plugin's
 * normal turn flow continue as if the player were never at 0.
 *
 * The Phoenix Clasp is the premium variant of the same offhand slot: it
 * revives identically, then automatically pulls a fresh Totem of Undying out
 * of the player's PvP kit into the now-empty offhand, so they are covered
 * again without typing anything. Single-use per equip, same lifecycle as the
 * totem it swaps in.
 *
 * Returns a narrative line to append to the turn's message if it fired,
 * or '' if the player has no totem equipped (meaning the caller should
 * proceed to handleDeath as normal).
 */
export function checkTotemRevive(player) {
  const offhand = player.equipped?.offhand
  const isClasp = offhand === 'phoenix_clasp'
  if (offhand !== 'totem_of_undying' && !isClasp) return ''

  // Which of the two fired, for callers that show the revive animation. Read off
  // the player rather than returned, so the ~4 existing call sites that only want
  // the narrative line keep working unchanged.
  player.lastReviveWasClasp = isClasp

  player.equipped.offhand = null
  if (player.equippedDurability) delete player.equippedDurability.offhand

  player.hp = Math.max(1, Math.floor(player.maxHp * 0.40))
  player.mp = Math.max(0, Math.floor(player.maxMp * 0.40))

  // The Undying pack's signature rides on top of whatever relic just saved you:
  // the golden light burns off every effect and fills your MP back to full,
  // instead of the plain 40% restore above. Signatures live on the equipped
  // pack, so this fires no matter which death-save relic did the reviving.
  let flourishLine = ''
  if (player.activePackSignature?.type === 'undying_flourish') {
    player.activeEffects = []
    player.mp = player.maxMp
    flourishLine =
      `\n🗿 *Undying Flourish!* Every affliction is scoured away and your MP floods back in full.`
  }

  let restockLine = ''
  if (isClasp) {
    const kit = Array.isArray(player.pvpKit) ? player.pvpKit : []
    const idx = kit.indexOf('totem_of_undying')
    if (idx !== -1) {
      kit.splice(idx, 1)
      player.pvpKit = kit
      player.equipped.offhand = 'totem_of_undying'
      restockLine = `\n🔥 The Clasp burns out and slots a fresh *Totem of Undying* into your off hand!`
    } else {
      restockLine = `\n🪶 The Clasp burns out. No spare totem in your PvP kit, your off hand is empty.`
    }
  }

  return (
    `\n\n✨ *${isClasp ? 'PHOENIX CLASP' : 'TOTEM OF UNDYING'} ACTIVATES!*\n` +
    `_The ${isClasp ? 'clasp' : 'totem'} shatters, and golden light knits you back together..._\n` +
    `💫 Death cancelled, the battle continues!\n` +
    `❤️ HP restored: ${player.hp}/${player.maxHp}  💧 MP: ${player.mp}/${player.maxMp}` +
    flourishLine +
    restockLine
  )
}

/**
 * checkPearlSave(player) — call this at every "player.hp <= 0" check,
 * BEFORE handleDeath, using the same call pattern as checkTotemRevive
 * (checked first; if it returns a truthy message the caller appends it and
 * continues, otherwise the caller falls through to handleDeath as normal).
 *
 * Unlike the totem, the pearl does NOT keep the player in the fight — it
 * pulls them fully out: battle/dungeon/boss state is cleared exactly like
 * a real death, but nothing else is. No gear is stripped, no inventory is
 * lost, no stat reset happens, and HP is left at exactly whatever it was
 * the instant before the lethal hit (not floored to 1, not set to a fixed
 * value) — the pearl saves the player from the death penalty entirely, it
 * doesn't simulate surviving the hit.
 *
 * Returns a narrative line to append to the turn's message if it fired, or
 * '' if the player has no pearl placed (meaning the caller should proceed
 * to handleDeath as normal).
 */
export function checkPearlSave(player) {
  const placedPearl = player.placedPearl
  if (!placedPearl) return ''

  const index = (player.inventory ?? []).indexOf(placedPearl.itemId)
  if (index >= 0) player.inventory.splice(index, 1)
  player.placedPearl = null

  // Explicitly reset bossState before nulling battleState so no stale
  // special-mechanic counters survive the pull-out.
  cleanupBossFight(player)

  const hpBeforeSave = player.hp

  player.inBattle    = false
  player.inDungeon   = false
  player.battleState = null
  player.location    = placedPearl.location
  player.dungeonFloor = 0
  // HP is intentionally left untouched (hpBeforeSave) — no floor, no fixed
  // value, no reset. Gear, inventory, and stats are untouched entirely.

  const itemName = placedPearl.itemId === 'ender_pearl' ? 'Ender Pearl' : 'Cracked Ender Shard'

  return (
    `\n\n📍 *${itemName.toUpperCase()} ACTIVATES!*\n` +
    `_The checkpoint pulls you out just before the killing blow lands..._\n` +
    `💫 A pearl was used, you were saved and pulled out of the fight!\n` +
    `📌 Whisked to *${player.location}* with *${hpBeforeSave}/${player.maxHp}* HP intact.\n` +
    `_Your gear, inventory, and stats are untouched._`
  )
}

/**
 * resolvePlayerHpZero(player, ctx, msg, { boss }) -> { fallThrough, msg?, returnValue? }
 * Canonical "player.hp <= 0" checkpoint chain: totem -> Yoriichi cat form ->
 * Anastasia's Hypnosis rewind -> pearl -> real death. EVERY combat plugin
 * (attack, defend, skill, useability, flee, cinderverdict, finalform, ...)
 * must route every player-hp-hits-0 check through this helper rather than
 * re-implementing the chain inline — that duplication is exactly how
 * Yoriichi's cat form previously ended up wired into attack.js only and
 * silently skipped everywhere else, so a player with Yoriichi equipped
 * would still die for real on a killing blow taken via defend/skill/etc.
 *
 * Usage at every "if (player.hp <= 0)" site:
 *   if (player.hp <= 0) {
 *     const res = await resolvePlayerHpZero(player, ctx, msg, { boss })
 *     if (!res.fallThrough) return res.returnValue
 *     msg = res.msg
 *   }
 *
 * - fallThrough: true  -> a totem fired; keep playing the turn with the
 *   updated msg (totem does not end the battle).
 * - fallThrough: false -> the caller must return res.returnValue
 *   immediately (pearl-save reply already sent, Yoriichi stood up and the bot
 *   played her whole fight out to a win or a loss, or the player actually died).
 */
export async function resolvePlayerHpZero(player, ctx, msg, { boss = false } = {}) {
  const totemMsg = checkTotemRevive(player)
  if (totemMsg) {
    // Show the totem going instead of the player. One await here covers every
    // PvE death checkpoint (hunt, boss, dungeon), because they all funnel through
    // this function. It cannot throw and a missing asset is a no-op, so the
    // narrative line below remains the thing that actually carries the news.
    const { sendTotemReviveAnimation } = await import('./item-art-render.mjs')
    await sendTotemReviveAnimation(ctx, player.name, { isClasp: !!player.lastReviveWasClasp })
    return { fallThrough: true, msg: msg + totemMsg }
  }
  const catMsg = checkYoriichiCatForm(player)
  if (catMsg) {
    // The owner is down and Yoriichi has just taken over. From here the BOT
    // plays the rest of the fight — she is not waiting on a command, and the
    // owner is never offered one. runCatFormAutoFight() narrates every round
    // and finishes in handleVictory() or resolveCatFormDefeat().
    //
    // moveOnlyFirstRound: the swing that killed the owner is what woke her, and
    // the calling plugin already ticked both status blocks for this turn, so her
    // first round is her strike alone. The enemy's next swing lands in round 2.
    const res = await runCatFormAutoFight(player, ctx, {
      boss,
      preamble: msg + catMsg,
      moveOnlyFirstRound: true,
    })
    if (res.resolved) return { fallThrough: false, returnValue: res.returnValue }
    // No enemy on the battleState — shouldn't happen from a combat plugin, but
    // she is up either way, so still no death and still no turn for the owner.
    await ctx.reply((msg + catMsg).trim() + catFormStatusLine(player))
    return { fallThrough: false, returnValue: player }
  }
  // Demon Lord Anastasia — Hypnosis. Sits ahead of the pearl on purpose: a
  // rewind puts the owner back into the fight from its opening state, which
  // is strictly better for them than being pulled out of it, and firing it
  // first leaves the pearl unspent for the death that finally sticks. It
  // sits BEHIND the totem for the mirror-image reason — the totem is an
  // equipped consumable bought for exactly this moment and keeps the fight
  // going without unwinding it, so there is nothing for a rewind to improve.
  // (Ordering against cat form above is academic: equippedCharacter is a
  // single id, so no one can hold Yoriichi and Anastasia at once.)
  if (canHypnosisRewind(player)) {
    const rewind = resolveHypnosisRewind(player)
    if (rewind.rewound) {
      // Everything below this point must NOT run — battleState is now the
      // one from the opening bell, and the turn that killed the owner has
      // been unmade along with it.
      const p = config.prefix
      await ctx.reply(
        msg + buildHypnosisMessage(player, rewind) +
        `\n\n*${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`,
      )
      return { fallThrough: false, returnValue: player }
    }
  }
  const pearlMsg = checkPearlSave(player)
  if (pearlMsg) {
    if (boss) cleanupBossFight(player)
    await ctx.reply(msg + pearlMsg)
    return { fallThrough: false, returnValue: player }
  }
  // Boss (tower masters): before the fight state is torn down, drip the killing
  // blow and the boss's full victory script one line at a time, so a loss reads
  // like the cinematic turns did. getBossVictoryLines() reads bossState, which
  // cleanupBossFight() is about to null, so capture it first. The accumulated
  // turn text (`msg`) is otherwise dropped on a real death, handleDeath() builds
  // its own report and never sees it, so sending it here also restores the final
  // blow that put the player down.
  if (boss) {
    // Capture the tower id before handleDeath() resets player.location, so the
    // 10-floor setback below can find the right dungeonProgress entry.
    const locId = player.battleState?.locationId ?? player.location
    const victoryLines = getBossVictoryLines(player)
    await sendCinematicBody(ctx, msg)
    await sendBossLines(ctx, victoryLines)
    // Losing a tower master costs 10 floors of saved progress, on top of the
    // full death penalty handleDeath() applies below.
    applyBossLossFloorRollback(player, locId)
    await ctx.reply(
      `🪂 *The tower drags you back 10 floors.*\n` +
      `_Your climb rewinds. You will resume lower than where you fell._`,
    ).catch(() => {})
    cleanupBossFight(player)
  }
  return { fallThrough: false, returnValue: await handleDeath(player, ctx) }
}

export async function handleDeath(player, ctx) {
  const p = config.prefix

  // Read Anastasia's state before anything below clears it — this tells the
  // owner "her clock is spent" rather than leaving them to wonder why the
  // rewind didn't fire on the death that finally stuck.
  const hypnosisSpentLine = buildHypnosisSpentLine(player)
  clearHypnosis(player)

  // Explicitly reset bossState before nulling battleState so no stale
  // special-mechanic counters survive a respawn.
  cleanupBossFight(player)

  // Totem of Undying and the Ender Pearl checkpoint are both checked
  // separately, before handleDeath is ever called — see checkTotemRevive()
  // and checkPearlSave() above. The totem keeps the player in battle; the
  // pearl pulls them fully out without going through the death penalty
  // below. By the time handleDeath runs here, both have already been
  // ruled out, so there is no pearl-respawn branch left to handle.

  // Premium perk: one free auto-revive per day — skips the gear-strip loop
  // and the 50% HP/MP cut entirely, healing to full instead. Still runs the
  // same battle-state cleanup as a normal death.
  if (hasAutoReviveAvailable(player)) {
    markAutoReviveUsed(player)
    player.hp           = player.maxHp
    player.mp            = player.maxMp
    player.inBattle      = false
    player.inDungeon     = false
    player.battleState   = null
    player.location      = 'astral_town'
    player.dungeonFloor  = 0
    player.activeEffects = []
    // A new life starts fed — also clears any Golden Apple immunity ("until you die").
    resetHunger(player)

    await ctx.reply(
      `👑 *Your Premium status saved you from death!*\n\n` +
      `_A golden light catches you before the darkness can take hold..._\n\n` +
      `✨ Fully revived at *${player.location}*, no losses, no penalty.\n` +
      `❤️ HP: ${player.hp}/${player.maxHp}  💧 MP: ${player.mp}/${player.maxMp}` +
      `\n\n_This free revive is used for today. Use *${p}inn* to recover normally next time or *${p}enter <dungeon>* to try again._`,
    )
    return player
  }

  // Cheat mod: Undying Grace (no_death_inventory_loss). Gear equip slots
  // are untouched by this cheat on purpose — it only protects the loose
  // inventory array, matching the chest's existing scope. See lib/mods.js.
  const skipInventoryLoss = hasMod(player, 'no_death_inventory_loss')

  const eq = player.equipped ?? {}
  const lost = []
  const kept = []
  const keptItems = []
  for (const slot of ['weapon', 'offhand', 'helmet', 'chestplate', 'boots', 'relic', 'tool']) {
    if (eq[slot]) {
      const it = allItems.find(i => i.id === eq[slot])
      // Reborn relics survive death. They are handed out exactly once, by a
      // god, at the end of a trial that can only be attempted at level 100 —
      // there is no way to replace one, so letting an ordinary dungeon death
      // delete it would make the whole ritual a trap. Items are flagged with
      // `reborn: true` in data/named-weapons.json; nothing else carries the
      // flag, so this exempts those four and only those four.
      if (it?.reborn) {
        kept.push(`  • ${it.name} _(${slot})_`)
        keptItems.push(it)
        continue
      }
      lost.push(`  • ${it?.name ?? eq[slot]} _(${slot})_`)
      // ── BUG FIX: remove this item's stat bonuses BEFORE clearing the slot.
      // Previously the slot was nulled without calling applyEquipmentBonus(-1),
      // so bonuses stayed on player.stats permanently. On next re-equip they
      // were added again, doubling the stats. Fixed here.
      if (it) applyEquipmentBonus(player, it, -1)
      eq[slot] = null
      if (player.equippedDurability) delete player.equippedDurability[slot]
    }
  }
  player.equipped = eq

  // ── Stat FLOOR (not a reset). baseStats is the anchor holding canonical
  // class+race+level growth plus every permanent investment with a formula
  // behind it: allocated stat points, the reborn reward, and Game Shop Stat
  // Packs. Death lifts any stat that has somehow fallen BELOW that anchor back
  // up to it, and does nothing else.
  //
  // This used to assign `stats[k] = baseStats[k]` outright, making death a hard
  // reset down to the anchor. That silently deleted every legitimately-earned
  // stat living ABOVE baseStats — most importantly job perks, since
  // plugins/jobs.js writes player.stats only. A player's job perks were
  // destroyed permanently on every single death with no way to get them back,
  // which is exactly the "I lost my stats when I died" complaint. Stats are now
  // locked down: only the things that GRANT stats may move them, and nothing
  // takes them away.
  //
  // Destroyed gear is already handled correctly by the applyEquipmentBonus(-1)
  // call in the strip loop above, so the reset's second job is redundant. A
  // legacy save still carrying residual bonuses from the old double-count bug
  // now keeps them rather than being scrubbed — strictly the better failure
  // mode, since the alternative robs honest players to catch a bug that the
  // strip loop already fixed.
  if (player.baseStats) {
    player.stats = player.stats ?? {}
    for (const k of ['str', 'agi', 'int', 'def', 'lck']) {
      player.stats[k] = Math.max(player.stats[k] ?? 0, player.baseStats[k] ?? 0)
    }
    player.maxHp = Math.max(player.maxHp ?? 0, player.baseStats.maxHp ?? 0)
    player.maxMp = Math.max(player.maxMp ?? 0, player.baseStats.maxMp ?? 0)
  }

  // Reborn relics kept above were never stripped (the loop `continue`s before
  // applyEquipmentBonus(-1)) and the floor no longer wipes gear bonuses, so
  // their stats are still on the sheet — re-adding them here would DOUBLE
  // them. keptItems is only used for the report line now. The floor runs
  // before the 50% HP cut below either way, so the cut takes the right maxHp.

  // Death wipes the ENTIRE loose inventory, not just equipped gear — the
  // only way to protect items from this is to have moved them into the
  // chest beforehand (see plugins/chest.js), or to have the
  // no_death_inventory_loss cheat mod active. player.chest.items is a
  // completely separate array and is never touched here either way.
  const inventoryLostCount = skipInventoryLoss ? 0 : (player.inventory?.length ?? 0)
  const inventoryLostNames = inventoryLostCount
    ? [...new Set((player.inventory ?? []).map(id => allItems.find(i => i.id === id)?.name ?? id))]
    : []
  if (!skipInventoryLoss) player.inventory = []

  player.hp            = Math.floor(player.maxHp * 0.50)
  player.mp            = Math.floor(player.maxMp * 0.50)
  player.inBattle      = false
  player.inDungeon     = false
  player.battleState   = null
  player.location      = 'astral_town'
  player.dungeonFloor  = 0
  player.activeEffects = []
  // A new life starts fed — also clears any Golden Apple immunity ("until you die").
  resetHunger(player)
  player.battleRecord         = player.battleRecord ?? { wins: 0, losses: 0 }
  player.battleRecord.losses  = (player.battleRecord.losses ?? 0) + 1

  // ── Yato's true form, awakened by losing.
  //
  // Anchored HERE, on the line that records the loss, because that increment is
  // the bot's own definition of "the player lost" and the rule is that he
  // ascends when they do. Everything that could have prevented this defeat has
  // already been ruled out further up the call chain — the totem, Yoriichi's cat
  // form, Anastasia's rewind and the Ender Pearl in resolvePlayerHpZero(), and
  // the Premium auto-revive that returns early at the top of this function — so
  // reaching this line means the death was real and penalised. A player the bot
  // saved did not lose and does not ascend, which is also why the auto-revive
  // branch never touches battleRecord.losses.
  //
  // Fires once ever per player and no-ops for everyone else. See
  // awakenYatoTrueForm() in lib/character-abilities.js.
  const yatoAwakening = awakenYatoTrueForm(player)

  // Transparency for the retired cheat: Undying Grace (no_death_inventory_loss)
  // is DISCONNECTED — hasMod() returns false for it, so the inventory loss above
  // ran at full force. A player who bought it before the retirement still owns
  // the mod and had no way to know why it did nothing. Say so on the death
  // report instead of leaving them to report it as a bug every time.
  const inertGrace = !skipInventoryLoss && inventoryLostCount > 0 &&
    ownsDisconnectedMod(player, 'no_death_inventory_loss')
  const inventoryLine = inventoryLostCount
    ? `\n\n🎒 *Inventory lost (${inventoryLostCount} item${inventoryLostCount === 1 ? '' : 's'}):*\n` +
      inventoryLostNames.slice(0, 12).map(n => `  • ${n}`).join('\n') +
      (inventoryLostNames.length > 12 ? `\n  _...and ${inventoryLostNames.length - 12} more_` : '') +
      `\n_Store items in *${p}chest* next time to keep them safe on death._` +
      (inertGrace
        ? `\n🧩 _Your *Undying Grace* mod is disconnected — it no longer protects your inventory. Ask the owner about a replacement._`
        : '')
    : (skipInventoryLoss ? `\n\n🧩 _Undying Grace kept your inventory safe._` : '')

  // Cheat mod: Swift Revival (death_cooldown_reduction). Nothing in this
  // function currently starts a cooldown timer itself — this value is
  // exposed for whichever plugin enforces the revive/respawn cooldown to
  // read via getModValue(player, 'death_cooldown_reduction') and apply as
  // a multiplier. Left as a no-op comment marker here since handleDeath
  // doesn't own that timer.

  await ctx.reply(
    `💀 *${player.name} HAS FALLEN!*\n\n` +
    `_The darkness swallows you whole..._\n\n` +
    `🏠 Respawned at *${player.location}* with half HP and MP.\n` +
    `❤️ HP: ${player.hp}/${player.maxHp}  💧 MP: ${player.mp}/${player.maxMp}` +
    (lost.length ? `\n\n💔 *Gear lost:*\n${lost.join('\n')}` : '') +
    (kept.length ? `\n\n🌟 *The god's gift stayed with you:*\n${kept.join('\n')}` : '') +
    inventoryLine +
    hypnosisSpentLine +
    `\n\n_Use *${p}inn* to recover or *${p}enter <dungeon>* to try again._`,
  )

  // The awakening gets its own message, after the death report. The report is
  // already long, and this is the only moment in the game where a character
  // permanently becomes a different character. Art falls back to Yato's normal
  // portrait if the true-form image isn't set yet, so this never renders blank.
  if (yatoAwakening.awakened) {
    const yato = characterMap[STREAMER_CHARACTER_ID]
    const art  = yato?.trueForm?.image || yato?.image
    if (art && typeof ctx.replyImage === 'function') {
      try {
        await ctx.replyImage(art, yatoAwakening.message)
      } catch {
        await ctx.reply(yatoAwakening.message)
      }
    } else {
      await ctx.reply(yatoAwakening.message)
    }
  }

  return player
}

// ─────────────────────────────────────────────────────────────────────────────
// Boss loss extras — the 10-floor setback and the turn-timeout resolver.
// Kept next to handleDeath because both hang a consequence off losing a boss.
// ─────────────────────────────────────────────────────────────────────────────

export const BOSS_TURN_TIMEOUT_MS = 5 * 60 * 1000
const BOSS_LOSS_FLOORS_BACK = 10

/**
 * Roll a player's saved progress back 10 floors after they lose a tower master.
 * The resume path reads dungeonProgress[locId].highestFloor (dungeonFloor is
 * zeroed by handleDeath), so that is the field that actually moves; the display
 * checkpoint is mirrored to match. No-ops when the boss has no dungeonProgress
 * entry (The End practice fight, or any boss reached outside a tracked tower),
 * so it never invents progress or throws.
 * @param {object} player
 * @param {string} locId
 */
export function applyBossLossFloorRollback(player, locId) {
  const prog = player.dungeonProgress?.[locId]
  if (!prog) return
  prog.highestFloor = Math.max(0, (prog.highestFloor ?? 0) - BOSS_LOSS_FLOORS_BACK)
  player.dungeonCheckpoint = prog.highestFloor
}

/**
 * Resolve a boss fight the player walked away from: if their turn has sat idle
 * past BOSS_TURN_TIMEOUT_MS, the boss finishes them. Applies the same penalty as
 * dying to the boss in combat (the full death strip via handleDeath, plus the
 * 10-floor setback). Called lazily from handler.js's in-battle gate on the next
 * command the player sends, so there is no scheduler and it survives restarts.
 *
 * Runs its own updatePlayer because, unlike the combat-death path, the caller is
 * the gate rather than a plugin already inside a write transaction.
 * @param {object} ctx
 */
export async function resolveBossTimeoutLoss(ctx) {
  let result = null
  await updatePlayer(ctx.db, ctx.from, async (player) => {
    // A second command racing in behind the first would find the fight already
    // torn down — isLiveBossFight is false then, so it can't double-penalise.
    if (!isLiveBossFight(player)) { result = player; return player }
    const locId = player.battleState?.locationId ?? player.location
    await ctx.reply(
      `⏳ *Out of time.*\n` +
      `_You let your turn sit for more than 5 minutes, and the master did not wait._`,
    ).catch(() => {})

    // Death-save chain, same doctrine as resolvePlayerHpZero: the timeout cut
    // is a lethal hit like any other, so it goes through the saves before it
    // goes through the strip. Before this fix, an idle boss fight stripped a
    // player's ENTIRE loadout — equipped Totem of Undying included — without
    // the totem ever getting its save, which is exactly the "my totem didn't
    // fire and I lost everything" report. The 10-floor rollback only applies
    // to a death that actually sticks.
    const totemMsg = checkTotemRevive(player)
    if (totemMsg) {
      // The totem keeps the player IN the fight — refresh the idle clock so
      // they get a fresh 5 minutes to act on their second life.
      if (player.battleState) player.battleState.lastMoveAt = Date.now()
      await ctx.reply(
        `👑 The master cuts you down where you stand...${totemMsg}\n\n` +
        `⏳ _The tower resets the clock. Your move._`,
      ).catch(() => {})
      result = player
      return player
    }
    const pearlMsg = checkPearlSave(player)
    if (pearlMsg) {
      await ctx.reply(`👑 The master cuts you down where you stand...${pearlMsg}`).catch(() => {})
      result = player
      return player
    }

    await ctx.reply(
      `👑 The boss cuts you down where you stand. The tower drags you back 10 floors.`,
    ).catch(() => {})
    applyBossLossFloorRollback(player, locId)
    cleanupBossFight(player)
    result = await handleDeath(player, ctx)
    return result
  })
  return result
}

/**
 * The Battle Pass half of a Season Level gain. A floor no longer buys a whole
 * tier (see lib/season-engine.js battlePassCurve — the pass is paced for 90
 * days), so this reports the tier only when it actually moved and otherwise
 * shows how much Season XP is left to the next one.
 */
function seasonPassLine(levelResult) {
  if (levelResult.tieredUp > 0) return ` · 🎫 *Battle Pass Tier ${levelResult.tier}!*`
  const toNext = levelResult.progress?.toNext
  return toNext ? ` · 🎫 Tier ${levelResult.tier}, ${toNext.toLocaleString()} XP to next` : ''
}

/**
 * creditKill(player, enemy, ctx, { battleType, killTurns, locId })
 *   -> { xp, solars, xpBase, onSpeedBand, season,
 *        beastCpMsg, dropMsg, lvlMsgs, rankChange, skillMsg, fameMsg, seasonMsg,
 *        titleMsg, prestigeResult }
 *
 * The per-kill reward core, lifted verbatim out of handleVictory so a swarm
 * pack (lib/swarm-combat.js) can pay each monster on exactly the same terms as
 * a 1v1 kill: the same Premium/cheat/season multiplier stack, the same XP speed
 * band, and the same fame / Season Points / beast CP credit and drop handling.
 * Mutates `player` and returns the numbers plus the prebuilt message fragments
 * the caller formats into its own reply. Does NOT touch battleState, the floor
 * counter, or HP regen: those stay in the caller (handleVictory's tail, or the
 * swarm engine's floor-clear step).
 */
export function creditKill(player, enemy, ctx, { battleType, killTurns, locId }) {
  // Rewards — Premium perk: 1.25x XP and Solars on kill (daily reward in
  // plugins/daily.js is untouched, this only applies to combat kills).
  // Cheat mods stack multiplicatively on top of Premium, not additively —
  // e.g. Premium (1.25x) + xp_boost (1.10x) = 1.375x, not 1.35x. Keeps
  // the math simple and avoids a separate "combined bonus" table.
  const premiumMultiplier = isPremiumActive(player) ? 1.25 : 1
  const combatXpMultiplier = 2
  const xpCheatMultiplier     = 1 + (getModValue(player, 'xp_boost') ?? 0)
  const solarsCheatMultiplier = 1 + (getModValue(player, 'currency_drop_boost') ?? 0)
  // Home XP perk: the Study (+3%) and Library (+5%) stack (perkTotal sums the
  // 'xp' perk across built rooms). This is the "standing XP bonus" those rooms
  // advertise, applied to every combat kill the same way the cheat boost is.
  const homeXpMultiplier      = 1 + (perkTotal(player, 'xp') ?? 0) / 100
  // Base XP. A regular dungeon monster pays on a speed band (30–60, see
  // speedKillXp in xp-regulator.js) — beat it fast and it's worth the full 60,
  // grind it down over a dozen turns and it's worth 30. Bosses keep their flat
  // milestone reward: a long boss fight is the intended shape of a boss fight,
  // and putting them on the band would pay less than a trash mob.
  const onSpeedBand = battleType === 'dungeon' && !enemy.isBoss
  const xpBase = onSpeedBand
    ? speedKillXp(killTurns)
    : Math.max(1, enemy.xp ?? enemy.rewards?.xp ?? 0)
  const season = getActiveSeason(ctx.db)
  const seasonXpPct = season ? Math.max(0, Number(season.bonuses?.killXpPercent ?? 0)) / 100 : 0
  const seasonSolarsPct = season ? Math.max(0, Number(season.bonuses?.killSolarsPercent ?? 0)) / 100 : 0
  // Season Dungeon boost (spec §6 / §11 "Season Dungeon boost: +10%
  // XP/fame/Solars vs normal dungeons") — stacks with the season-wide
  // kill bonus above (that's a flat Season Points/XP/Solars add-on for
  // ANY kill anywhere; this is specifically "grinding THIS dungeon"), so
  // it's applied as its own separate multiplier rather than folded into
  // seasonXpPct/seasonSolarsPct.
  const inSeasonDungeon = season && locId === season.dungeon
  const dungeonBoostMult = inSeasonDungeon ? 1 + Math.max(0, Number(season.dungeonBoostPercent ?? 0)) / 100 : 1
  // Per-location reward multiplier: lets one extreme location (e.g. caged_dimension)
  // pay noticeably higher rewards without touching the global balance constants.
  // Stacks multiplicatively with everything else (Premium, speed band, season, etc.).
  const locationMult = LOCATION_REWARD_MULT[locId] ?? { xp: 1, solars: 1 }
  const xpMult  = onSpeedBand ? 1 : combatXpMultiplier
  const xpFloor = onSpeedBand ? 1 : 100
  const xp = Math.max(xpFloor, Math.floor(xpBase * xpMult * premiumMultiplier * xpCheatMultiplier * homeXpMultiplier * (1 + seasonXpPct) * dungeonBoostMult * locationMult.xp))
  let solars = Math.floor((enemy.solars ?? enemy.rewards?.solars ?? 0) * premiumMultiplier * solarsCheatMultiplier * (1 + seasonSolarsPct) * dungeonBoostMult * locationMult.solars)
  const riverCharm = player.activeBoosts?.riverCharm
  const riverMultiplier = riverCharm?.fightsRemaining > 0
    ? 1 + Math.max(0, Number(riverCharm.percent) || 0) / 100
    : 1
  if (riverMultiplier !== 1) solars = Math.round(solars * riverMultiplier)

  player.xp += xp
  player.wallet.solars = (player.wallet.solars ?? 0) + solars
  const seasonPointsResult = season
    ? applySeasonPoints(player, season, enemy.isBoss ? season.bonuses?.bossKillPoints : season.bonuses?.killPoints)
    : null

  // Summon Beast: the active beast (if any) gains CP scaled off this kill's
  // XP reward, same pacing lever xp-regulator.js already tuned for the player.
  const beastCpMsg = awardBeastCp(player, xp)

  // Drops — combat loot, so a full inventory shouldn't block the victory
  // message. Grant what fits, drop the rest, and mention any losses.
  const dropped = rollDrops(enemy.drops ?? [])
  const grantedDrops = []
  const lostDrops = []
  for (const id of dropped) {
    if (!player.inventory.includes(id)) {
      if (hasInventoryRoom(player, 1)) {
        player.inventory.push(id)
        grantedDrops.push(id)
      } else {
        lostDrops.push(id)
      }
    }
  }
  let dropMsg = grantedDrops.length
    ? `\n🎁 *Drop:* ${grantedDrops.map(id => allItems.find(i => i.id === id)?.name ?? id).join(', ')}`
    : ''
  if (lostDrops.length) {
    dropMsg += `\n⚠️ *Inventory full, lost:* ${lostDrops.map(id => allItems.find(i => i.id === id)?.name ?? id).join(', ')}`
  }

  // Level ups
  const { msgs: lvlMsgs, rankChange } = applyLevelUps(player, levelsData, classes, races, getTotalStats)
  for (let i = 0; i < lvlMsgs.length; i++) awardFame(player, 'level_up', player.level)

  // Prestige (post-level-200 titles) — applyLevelUps() above already stopped
  // granting levels once player.level hit playerLevelCap(player); the xp
  // that kill just added to player.xp did nothing from that point on (see
  // plugins/admin.js's note that player.xp is cumulative and only ever
  // turned into levels). Route the SAME xp number into the prestige ladder
  // instead, so a maxed player's kills keep meaning something. creditPrestigeXp
  // itself no-ops for anyone under the cap, but the isTitled check is done
  // here too (via the level comparison inside it) rather than skipped, since
  // xp is the value being spent and this is the one place that knows it.
  const prestigeResult = creditPrestigeXp(player, xp, playerLevelCap(player))
  const titleMsg = prestigeResult?.tierChange
    ? `\n\n🏵️ *TITLE UP!* ${player.name} has ascended to ${prestigeResult.tierChange.to.glyph} *${prestigeResult.tierChange.to.name}*!`
    : ''

  // Quest progress: one kill, plus any levels that kill just bought. Recorded
  // here (not in handleVictory) so the swarm engine, which credits every monster
  // in a pack through creditKill, counts each one. Floor clears are recorded
  // separately in the floor-advance tail below / in the swarm floor-clear path.
  recordQuestEvent(player, 'kill', 1)
  if (lvlMsgs.length) recordQuestEvent(player, 'level', lvlMsgs.length)

  // New skills
  const newSkills = getNewlyUnlockedSkills(player, allSkills)
  for (const s of newSkills) player.skills.push(s.id)
  const skillMsg = newSkills.length
    ? `\n✨ *Skill unlocked:* ${newSkills.map(s => s.name).join(', ')}`
    : ''

  // Fame — word of the fight travels back to Astral Town. Season Dungeon
  // boost (spec §11) applies to fame too. GAIN_FN's kill/boss_kill formulas
  // have a large flat floor (100+) with only a small variable component
  // driven by `value`, so scaling the awardFame() input barely moves the
  // output — the boost is applied to the *result* instead, directly on
  // `gained`, which is the actually-meaningful lever.
  const fameEvent   = enemy.isBoss ? 'boss_kill' : 'kill'
  const fameResult  = awardFame(player, fameEvent, player.level, enemy.name)
  if (riverMultiplier !== 1 && fameResult.gained) {
    const boosted = Math.round(fameResult.gained * riverMultiplier)
    player.fame = (player.fame ?? 0) + boosted - fameResult.gained
    fameResult.gained = boosted
    fameResult.total = player.fame
  }
  if (dungeonBoostMult !== 1 && fameResult.gained) {
    const boosted = Math.round(fameResult.gained * dungeonBoostMult)
    const extra   = boosted - fameResult.gained
    if (extra > 0) {
      player.fame = (player.fame || 0) + extra
      fameResult.gained = boosted
      fameResult.total  = player.fame
    }
  }
  const solarPayout = applyFamePayout(player)
  const fameMsg     = fameResult.gained
    ? `\n🌟 *+${fameResult.gained} Fame*${solarPayout ? `  ☀️ *+${solarPayout} Solars*` : ''}` +
      (fameResult.tierChanged ? `\n🎭 *FAME UP!* You're now known as *${fameResult.newTier.label}* ${fameResult.newTier.emoji} _(${formatFame(fameResult.total)} fame)_` : '')
    : ''
  if (riverCharm?.fightsRemaining > 0) {
    riverCharm.fightsRemaining -= 1
    if (riverCharm.fightsRemaining <= 0) delete player.activeBoosts.riverCharm
  }
  const seasonMsg = seasonPointsResult?.gained
    ? `\n🌞 *Season bonus:* +${seasonPointsResult.gained} Season Points` +
      (seasonPointsResult.tieredUp ? ` · Battle Pass Tier ${seasonPointsResult.tier}` : '')
    : ''

  return {
    xp, solars, xpBase, onSpeedBand, season,
    beastCpMsg, dropMsg, lvlMsgs, rankChange, skillMsg, fameMsg, seasonMsg,
    titleMsg, prestigeResult,
  }
}

export async function handleVictory(player, enemy, ctx) {
  const p     = config.prefix
  // The fight is over, so Anastasia's opening-state snapshot has nothing
  // left to restore. armHypnosis() overwrites it on the next battle start
  // anyway; this just avoids carrying a dead copy of a won fight around in
  // the save file until then.
  clearHypnosis(player)
  const locId = player.battleState?.locationId ?? player.location
  // Read these BEFORE battleState is nulled below — the speed-scaled XP band
  // needs to know how long the fight actually ran.
  const battleType = player.battleState?.type ?? null
  const killTurns  = player.battleState?.turn ?? 1

  // Explicitly reset bossState before nulling battleState.
  cleanupBossFight(player)

  player.inBattle    = false
  player.battleState = null
  player.battleRecord       = player.battleRecord ?? { wins: 0, losses: 0 }
  player.battleRecord.wins  = (player.battleRecord.wins ?? 0) + 1

  // ── The End — post-event practice rematch ────────────────────────────────
  // Once the End is dead server-wide (endEvent.defeated), its rift stays open
  // as an on-demand rematch (see dungeon.js handleEnter). This is a victory
  // lap: the fight ends cleanly (bossState + battleState cleared just above)
  // but pays NOTHING, no XP, Solars, drops, fame, title or growth, and touches
  // no event state, so the aura stays lifted and nothing is announced. The live
  // world-first kill never lands here: defeated is still false at this point
  // for that one caller (claimEndDefeat flips it further down).
  if (enemy.animeBossId === THE_END_BOSS_ID && getEndEvent(ctx.db).defeated) {
    player.location     = 'astral_town'
    player.inDungeon    = false
    player.dungeonFloor = 0
    const animeDef   = getAnimeBossById(THE_END_BOSS_ID)
    const defeatLine = animeDef?.defeatLines?.length
      ? animeDef.defeatLines[Math.floor(Math.random() * animeDef.defeatLines.length)]
      : null
    await ctx.reply(
      `✅ *THE END FALLS AGAIN.*\n\n` +
      (defeatLine ? `_${defeatLine}_\n\n` : '') +
      `_You came for the fight, not the spoils. The rift was already spent when ` +
      `you walked in, so there is nothing to carry out, only the proof that you ` +
      `can still stand against it._\n\n` +
      `❤️ HP: ${hpBar(player.hp, player.maxHp)}\n` +
      `_Return to town or enter another dungeon._`,
    )
    return player
  }

  // Yoriichi's own growth track (her dodge, 30% -> 35%; her HP pool is a flat
  // 3,000 and doesn't scale) — dungeon wins while she's equipped. No-ops if she
  // isn't equipped. PvP wins are granted separately from plugins/pvp.js's
  // pvpConclude(), not here.
  if (battleType === 'dungeon') grantYoriichiExp(player, 'dungeon')

  // ── Per-kill rewards ─────────────────────────────────────────────────────
  // The whole reward core (Premium/cheat/season multipliers, the XP speed
  // band, drops, level-ups, skill unlocks, fame, Season Points and beast CP)
  // lives in creditKill() so the swarm engine (lib/swarm-combat.js) can pay
  // every monster in a pack on exactly these terms. handleVictory keeps only
  // the floor-advance + victory-reply tail below.
  const {
    xp, solars, xpBase, onSpeedBand, season,
    beastCpMsg, dropMsg, lvlMsgs, rankChange, skillMsg, fameMsg, seasonMsg,
    titleMsg,
  } = creditKill(player, enemy, ctx, { battleType, killTurns, locId })

  // Boss: conquest + floor advance
  let conquestMsg = ''
  if (enemy.isBoss && locId) {
    const loc  = locationsMap[locId]
    if (!player.dungeonProgress) player.dungeonProgress = {}
    const prog = player.dungeonProgress[locId] ?? { highestFloor: 0, conquered: false }
    prog.highestFloor = Math.max(prog.highestFloor ?? 0, player.dungeonFloor)

    const isConquest = player.dungeonFloor >= (loc?.floors ?? 0)
    if (isConquest && !prog.conquered) {
      prog.conquered = true
      const title = enemy.conquestTitle
      if (title && !player.title) player.title = title
      conquestMsg =
        `\n\n🏆 *DUNGEON CONQUERED!*\n_${loc?.name ?? locId} cleared!_\n` +
        (title ? `🎖️ Title: *"${title}"*\n` : '') +
        `_Next dungeon unlocked!_`
    }
    player.dungeonProgress[locId] = prog
    player.dungeonCheckpoint = Math.max(player.dungeonCheckpoint ?? 0, player.dungeonFloor)
    player.dungeonFloor = (player.dungeonFloor ?? 1) + 1
    if (locId === 'season_01_ruins' && season) {
      const levelResult = applySeasonLevel(player, season, 1)
      player.seasonProgress.currentFloor = player.dungeonFloor
      conquestMsg += `\n🌙 *Season Level +1* → ${levelResult.seasonLevel}${seasonPassLine(levelResult)}`
    }
    if (prog.conquered) { player.inDungeon = false; player.dungeonFloor = 0 }
  } else {
    // Regular floor: advance and heal the flat 8%. Clamped to leave at least
    // 1 HP, because bleeding out on a floor you just won is not a fair death.
    const regen = 0.08
    player.hp = Math.max(1, Math.min(player.maxHp, player.hp + Math.floor(player.maxHp * regen)))
    player.mp = Math.max(0, Math.min(player.maxMp, player.mp + Math.floor(player.maxMp * regen)))
    player.dungeonFloor = (player.dungeonFloor ?? 1) + 1
    if (locId === 'season_01_ruins' && season) {
      const levelResult = applySeasonLevel(player, season, 1)
      player.seasonProgress.currentFloor = player.dungeonFloor
      conquestMsg += `\n🌙 *Season Level +1* → ${levelResult.seasonLevel}${seasonPassLine(levelResult)}`
    }
    player.dungeonCheckpoint = Math.max(player.dungeonCheckpoint ?? 0, player.dungeonFloor - 1)
    if (!player.dungeonProgress) player.dungeonProgress = {}
    const prog = player.dungeonProgress[locId] ?? { highestFloor: 0, conquered: false }
    prog.highestFloor = Math.max(prog.highestFloor ?? 0, player.dungeonFloor - 1)
    player.dungeonProgress[locId] = prog
  }

  // Quest progress: a 1v1 dungeon kill clears the floor it was on. (Swarm floors
  // record their own clear once the whole pack is down, in lib/swarm-combat.js.)
  if (battleType === 'dungeon') recordQuestEvent(player, 'floor', 1)

  const label = enemy.isBoss ? `💀 Boss *${enemy.name}*` : `${enemy.emoji ?? '👾'} *${enemy.name}*`
  const nextLine = player.inDungeon
    ? `\n_Type *${p}dungeon* to continue to Floor ${player.dungeonFloor}._`
    : `\n_Return to town or enter another dungeon._`

  // Anime bosses (see bosses/*.js) carry their own defeat narration.
  const animeDef      = enemy.animeBossId ? getAnimeBossById(enemy.animeBossId) : null
  const defeatLine     = animeDef?.defeatLines?.length
    ? animeDef.defeatLines[Math.floor(Math.random() * animeDef.defeatLines.length)]
    : null
  let bossDefeatMsg = defeatLine ? `\n\n_${defeatLine}_` : ''

  // ── The End — world-event finale (see lib/end-event.js) ─────────────────
  // Keyed off enemy.animeBossId rather than bossState._defId because
  // cleanupBossFight() ran at the top of this function: `enemy` is a parameter,
  // so it is the only thing here that still knows what just died.
  let endFinaleMsg = ''
  if (enemy.animeBossId === THE_END_BOSS_ID) {
    // First-writer-wins: exactly one kill server-wide flips the event down.
    const worldFirst = claimEndDefeat(ctx.db, player.id ?? ctx.from)

    // The rift closes behind them either way — nobody is left standing in it.
    player.location     = 'astral_town'
    player.inDungeon    = false
    player.dungeonFloor = 0

    if (worldFirst) {
      // Sweep the cached weaken flags directly (we're already inside the
      // updatePlayer write queue — calling updateAllPlayers here would
      // deadlock on the same exclusive lock) so idle players who never type
      // aren't left weakened when someone else reads their stats.
      syncEndWeakenForAll(ctx.db, ctx.db.data.users)

      // Announced only here, in the victory message of the group where the kill
      // landed — no fan-out to every group (WhatsApp bans that as spam).
      // Players elsewhere find the aura already lifted via .event / .profile.
      endFinaleMsg =
        `\n\n🌅 *THE AIR IS CLEAR.*\n` +
        `_You did it. The aura is gone, every sleeper in Astral just opened ` +
        `their eyes, wherever they are._`
    } else {
      endFinaleMsg =
        `\n\n🌅 _The End was already down when you struck. The sky is clear ` +
        `either way, and you can say you were there._`
    }
  }

  // Speed feedback — without this the band is invisible and a smaller XP
  // number just reads as the reward being broken.
  const speedLine = onSpeedBand
    ? `\n⚡ ${killTurns === 1 ? 'One-shot' : `${killTurns} turns`}` +
      (xpBase >= DUNGEON_KILL_XP.max ? `, _full speed bonus_`
        : xpBase <= DUNGEON_KILL_XP.min ? `, _no speed bonus, finish faster for more XP_`
        : `, _${xpBase}/${DUNGEON_KILL_XP.max} speed XP_`)
    : ''

  // Boss (tower masters): drip the full defeat script one line at a time before
  // the reward summary, matching the cinematic entrance and turns. THE END keeps
  // its single world-event finale reply, so it is excluded here. animeDef was
  // read from the surviving `enemy` param above, because cleanupBossFight() has
  // already nulled bossState by now.
  if (enemy.animeBossId && enemy.animeBossId !== THE_END_BOSS_ID && animeDef?.defeatLines?.length) {
    await sendBossLines(ctx, animeDef.defeatLines)
    bossDefeatMsg = ''
  }

  await ctx.reply(
    `✅ *VICTORY!*\n\n${label} defeated!` +
    bossDefeatMsg +
    `\n\n` +
    `✨ *+${xp} XP*  ☀️ *+${solars} Solars*` +
    speedLine +
    dropMsg +
    (lvlMsgs.length ? `\n\n${lvlMsgs.join('\n')}` : '') +
    skillMsg + fameMsg + seasonMsg + conquestMsg + titleMsg + endFinaleMsg +
    (beastCpMsg ? `\n\n${beastCpMsg}` : '') +
    `\n\n❤️ HP: ${hpBar(player.hp, player.maxHp)}` +
    nextLine,
  )

  // Rank promotion — separate message so it stands out
  if (rankChange) {
    const { from, to } = rankChange
    const promoCaption =
      `⚔️ *RANK UP!*\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `${to.emoji} *${to.title}*\n` +
      `_"${to.epithet}"_\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `*${player.name}* has ascended beyond *${from.title}*.\n` +
      `_The System acknowledges your growth. A new tier of power awaits._`
    await sendImage(ctx, `rank_${rankSlug(to.title)}.jpg`,
      `*Astral Rank Up*\n${to.emoji} Ascended to ${to.title}\n\n${promoCaption}`)
  }

  return player
}

/**
 * Tick an entity's active status effects for one combat turn and report
 * whether it is incapacitated (stunned/frozen) *before* the tick — a
 * freshly-applied 1-turn stun must still block this turn's action, even
 * though tickEffects() will decrement it to 0 and remove it right after.
 */
export function processStatusTurn(entity) {
  // Montana — Faster Than Time: hard control cannot keep her summoner. Any
  // freeze/stun/sleep on a Montana owner (a Reverie time-stop rides the freeze
  // effect, so it is covered too) is torn off here, BEFORE the incapacitation
  // check reads it, so she never loses a turn to being held. A no-op for
  // monsters and for anyone without her equipped, exactly like tickFusion below.
  // See montanaBreakFree() in lib/character-abilities.js for why this is a
  // cleanse (status lands, then breaks) and not Shunya's prevention.
  const broke = montanaBreakFree(entity)
  const incapacitated = hasEffect(entity, 'stun') || hasEffect(entity, 'freeze') || hasEffect(entity, 'sleep')
  const lines = tickEffects(entity)
  if (broke?.line) lines.unshift(broke.line)
  // Gogeta's Fusion of Equals clock lives here rather than in each combat
  // plugin because this is the one function every turn in the game runs
  // through, PvE, boss and duel alike: the fusion has to time out on an
  // ordinary .attack turn exactly as it does on one of his own moves,
  // otherwise a player who never touches his actives keeps the buffs forever.
  // No-op for monsters and for anyone without him equipped.
  const fusionLine = tickFusion(entity)
  if (fusionLine) lines.push(fusionLine)
  return { incapacitated, lines }
}

/** A boss lifespan-drain stat cut wears off after this many of the player's turns. */
export const BOSS_STAT_DRAIN_TURNS = 5
const BOSS_STAT_DRAIN_SOURCE = 'boss_lifespan_drain'

/**
 * applyBossStatDrain(player, result, msg) -> updated msg
 *
 * Applies result.playerAtkReduction / result.playerDefReduction from
 * applyBossSpecial(); both arrive as decimal fractions (0.09 = 9%).
 *
 * This was three verbatim copies of a `_applyPlayerStatReductions` helper in
 * attack.js, defend.js and skill.js, each permanently subtracting from
 * player.stats. That made a boss special the only thing in the game that could
 * take a stat away from a player for keeps: there is no cure command for it and
 * no formula that rebuilds it, so a drained STR stayed drained forever — until
 * the player happened to die, because the stat floor in handleDeath was quietly
 * what undid it. Stats are locked to the things that GRANT them now, so the
 * drain is a real and dangerous but *temporary* weaken effect instead: it bites
 * for the rest of the phase and then wears off.
 *
 * Routing it through addStatusEffect() also means Shunya's Empty Vessel finally
 * covers boss drains on every combat verb. Only the skill.js copy carried her
 * immunity check, so a boss could shred the one un-debuffable character in the
 * game through .attack or .defend.
 */
export function applyBossStatDrain(player, result, msg) {
  const atkFrac = result.playerAtkReduction ?? 0
  const defFrac = result.playerDefReduction ?? 0
  if (!atkFrac && !defFrac) return msg

  // The Empty Vessel (Shunya). addStatusEffect() would refuse a weaken on her
  // anyway — this is here so the refusal gets narrated instead of the turn
  // just looking like nothing happened.
  if (player.statusImmune) {
    return msg + `⭕ _The drain reaches for ${player.name} and closes on empty air._\n`
  }

  player.activeEffects = player.activeEffects ?? []

  const bite = (key, frac) => {
    // A share of what is actually LEFT (getEffectiveStat, so prior drains
    // count), which means repeated drains bite less each time instead of
    // compounding a player straight down to zero.
    const current = getEffectiveStat(player, key)
    if (current <= 0 || frac <= 0) return 0
    const cut = Math.max(1, Math.round(current * frac))
    // One entry per stat that deepens and refreshes on re-application, rather
    // than a fresh stacking entry every time the special fires — same idiom as
    // Megumi's growing swarm cut in lib/megumi.js.
    const prior = player.activeEffects.find(
      (e) => e.type === 'weaken' &&
             e.meta?.stat === key &&
             e.sourceId === BOSS_STAT_DRAIN_SOURCE,
    )
    if (prior) {
      prior.value += cut
      prior.remaining = Math.max(prior.remaining ?? 0, BOSS_STAT_DRAIN_TURNS)
    } else {
      addStatusEffect(player, {
        type: 'weaken',
        stat: key,
        value: cut,
        duration: BOSS_STAT_DRAIN_TURNS,
        sourceId: BOSS_STAT_DRAIN_SOURCE,
      })
    }
    return cut
  }

  if (atkFrac) {
    for (const key of ['str', 'agi', 'int']) {
      const cut = bite(key, atkFrac)
      if (cut) {
        msg += `💔 *${player.name}* loses *${cut}* ${key.toUpperCase()} ` +
               `for ${BOSS_STAT_DRAIN_TURNS} turns _(lifespan drained)_!\n`
      }
    }
  }
  if (defFrac) {
    const cut = bite('def', defFrac)
    if (cut) {
      msg += `🛡️ *${player.name}* loses *${cut}* DEF for ${BOSS_STAT_DRAIN_TURNS} turns!\n`
    }
  }
  return msg
}
