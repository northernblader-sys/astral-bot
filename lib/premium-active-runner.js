/**
 * premium-active-runner.js — the shared body behind the four premium ability
 * active commands (plugins/freezeup.js, heatwave.js, nighteyes.js, daylight.js).
 *
 * Every active is a once-per-battle FREE INSTANT: it lands a status effect on
 * the current opponent (and, for Daylight, buffs the owner) and does NOT consume
 * a turn or run a turn exchange. That keeps it format-agnostic — the effect just
 * sits on the target's record and the existing processStatusTurn() in each combat
 * loop applies the skip/DoT on their next turn — so neither the PvE pipeline nor
 * the PvP turn engine needs to know these commands exist.
 *
 * The once-per-battle latch lives on battleState (battleState.premiumAbilityUsed),
 * which is rebuilt per fight, so it resets for free.
 *
 * PvE vs PvP is the only real branch: PvE has the player and bs.enemy live in one
 * updatePlayer() mutator, while PvP mutates the two fighters in two separate
 * (never nested) updatePlayer() calls, so the self-part and opponent-part are run
 * in their own mutators. See lib/premium-abilities.js for applyActiveSelf /
 * applyActiveOnOpponent.
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer, playerExists } from './player-repo.js'
import { isPremiumActive } from './premium.js'
import { premiumAbilityMap } from './game-data.js'
import { applyActiveSelf, applyActiveOnOpponent } from './premium-abilities.js'

/**
 * runPremiumActive(ctx, abilityId) — resolve one premium active for the caller.
 * Gates on registration → ownership (a player holds at most one ability, and each
 * command belongs to exactly one, so ownership is a strict equality) → active
 * Premium → in a battle → not already used this fight.
 */
export async function runPremiumActive(ctx, abilityId) {
  const pr = config.prefix
  const player = ctx.player
  const ability = premiumAbilityMap[abilityId]
  if (!ability?.active) return ctx.reply(`❌ That ability has no active move.`)

  const tag  = `${ability.emoji ?? '✨'} *${ability.name}*`
  const move = ability.activeName ?? ability.name

  if (!player) return ctx.reply(`⚠️ Register first with *${pr}register*.`)

  if (player.premiumAbility !== abilityId) {
    return ctx.reply(
      `🔒 You don't hold ${tag}. It's one of only *5* abilities in the game, each won once ever from the *weekly* Premium spin (*${pr}premium buy weekly*).`,
    )
  }
  if (!isPremiumActive(player)) {
    return ctx.reply(`👑 ${tag} sleeps while your Premium is inactive. Renew with *${pr}premium buy* to wield it again.`)
  }

  const bs = player.battleState
  const inPvp = bs?.type === 'pvp'
  const inPve = !!(player.inBattle && bs?.enemy)
  if (!inPvp && !inPve) {
    return ctx.reply(`⚔️ *${move}* can only be used during a battle.`)
  }
  if (bs.premiumAbilityUsed) {
    return ctx.reply(`♻️ You've already used *${move}* this battle. It refreshes when the next fight begins.`)
  }

  // ── PvE: player + bs.enemy live in the same mutator ──────────────────────
  if (inPve) {
    let latched = false
    let lines = []
    await updatePlayer(ctx.db, ctx.from, p => {
      const b = p.battleState
      if (!b?.enemy || b.premiumAbilityUsed) return
      // Opponent-part first so Daylight's dominance check reads base power,
      // then the self-buff (see applyAbilityActive's ordering note).
      const oppR  = applyActiveOnOpponent(p, b.enemy, abilityId)
      const selfR = applyActiveSelf(p, abilityId)
      b.premiumAbilityUsed = true
      p.battleState = b
      lines = [...selfR.lines, ...oppR.lines]
      latched = true
    })
    if (!latched) return ctx.reply(`♻️ You've already used *${move}* this battle.`)
    return ctx.reply(lines.length ? lines.join('\n') : `✨ *${move}* used.`)
  }

  // ── PvP: two records, two separate (never nested) updatePlayer calls ─────
  const opponentJid = bs.opponentJid
  const oppSnap = opponentJid && playerExists(ctx.db, opponentJid) ? getPlayer(ctx.db, opponentJid) : null

  let selfLines = []
  let latched = false
  await updatePlayer(ctx.db, ctx.from, p => {
    if (p.battleState?.premiumAbilityUsed) return
    selfLines = applyActiveSelf(p, abilityId).lines
    p.battleState.premiumAbilityUsed = true
    latched = true
  })
  if (!latched) return ctx.reply(`♻️ You've already used *${move}* this battle.`)

  let oppLines = []
  if (oppSnap) {
    // `player` is a pre-buff snapshot — applyActiveOnOpponent only READS the
    // owner (duration scaling, Daylight dominance), so this is safe and, for
    // Daylight, correctly compares base power.
    await updatePlayer(ctx.db, opponentJid, opp => {
      oppLines = applyActiveOnOpponent(player, opp, abilityId).lines
    })
  }

  const all = [...selfLines, ...oppLines]
  return ctx.reply(all.length ? all.join('\n') : `✨ *${move}* used.`)
}
