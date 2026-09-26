/**
 * domain.js — Gojo's Domain Expansion: Unlimited Void, his second combat move.
 *
 * Costs no MP and fires once per battle (bs.unlimitedVoidUsed, set by
 * activateUnlimitedVoid() in lib/character-abilities.js — the same battleState
 * flag pattern the other actives use, so it resets with the fight for free).
 *
 * This one deals NO damage. It is pure control: opening the domain floods the
 * enemy with infinite information and locks them out of acting, applied as a
 * hard 'stun' for UNLIMITED_VOID_STUN_TURNS of their turns (see lib/effects.js —
 * stun/freeze are the only statuses that skip a turn outright; Miyashi's
 * frostlock merely forces a basic attack, which is why the full lockdown is
 * Gojo's alone). Because the void does the work, the enemy does not get to
 * counter on the turn it is cast: after the stun lands, this turn ends.
 *
 * The turn shape is the front half of plugins/cinderverdict.js — status tick,
 * the domain, boss ENEMY_TAKE_DAMAGE is skipped (no damage), then straight to
 * the enemy status/turn — but the enemy is stunned by construction, so it plays
 * out as "they cannot act" and the turn closes.
 *
 * PvP: in a duel this hands off to pvp.js's pvpUnlimitedVoid() (the
 * 'unlimitedvoid' action there), since this plugin only knows the PvE
 * battleState shape. Infinity still guards Gojo in a duel too, through
 * applyIncomingDamage(), which the duel engine already calls.
 *
 * Usage: <prefix>unlimitedvoid
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { hpBar } from '../lib/combat-engine.js'
import {
  handleVictory,
  processStatusTurn,
  resolvePlayerHpZero,
  checkCatFormOngoingTurn,
} from '../lib/combat-handlers.js'
import { addStatusEffect } from '../lib/effects.js'
import {
  applyBossSpecial, checkBossPhase,
  incrementBossTurn, cleanupBossFight, EVENT,
} from '../lib/boss-engine.js'
import {
  activateUnlimitedVoid,
  sendWillowAdvisory,
  tickPermanentSever,
  UNLIMITED_VOID_STUN_TURNS,
} from '../lib/character-abilities.js'
import { pvpUnlimitedVoid } from './pvp.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

// The domain itself. Sent as the caption image on the turn the void opens, not
// on the refusals above it — the duel refusal and the already-spent gate are
// both "no", and art on a "no" reads as if the domain went off.
const UNLIMITED_VOID_ART = 'https://i.ibb.co/84rwNCV5/unlimited-void.jpg'

/**
 * Sends the turn narration as a caption on the Unlimited Void art, falling back
 * to plain text if the image cannot be sent (dead URL, a platform whose ctx has
 * no replyImage). Same reasoning as plugins/purple.js: the charge is spent by
 * the time we get here, so a broken image must not swallow the turn.
 */
async function replyWithArt(ctx, text) {
  if (typeof ctx.replyImage !== 'function') return ctx.reply(text)
  try {
    return await ctx.replyImage(UNLIMITED_VOID_ART, text)
  } catch {
    return ctx.reply(text)
  }
}

/**
 * runUnlimitedVoid(ctx) — the whole Gojo domain turn, factored out of the
 * plugin object so the general `.domainexpansion` dispatcher
 * (plugins/domain-expansion.js) can call it when a Gojo player types the shared
 * command. The plugin's own run() is a thin wrapper around this.
 */
export async function runUnlimitedVoid(ctx) {
const p = config.prefix

// In a duel, Unlimited Void hands off to the PvP turn engine: this plugin only
// knows the PvE battleState shape (bs.enemy), so pvpUnlimitedVoid() resolves it
// there instead (the 'unlimitedvoid' action in pvp.js). Infinity still guards
// Gojo in a duel too, through applyIncomingDamage(), which the duel engine
// already calls.
if (ctx.player?.battleState?.type === 'pvp') {
  return pvpUnlimitedVoid(ctx)
}

await updatePlayer(ctx.db, ctx.from, async player => {
    const catTurn = await checkCatFormOngoingTurn(player, ctx, {
      boss: isBossFight(player),
    })
    if (catTurn.intercepted) return catTurn.returnValue

    const gate = activateUnlimitedVoid(player)
    if (!gate.ok) {
      if (gate.message) await ctx.reply(gate.message)
      return player
    }

    const bs   = player.battleState
    const e    = bs.enemy
    const boss = isBossFight(player)

    bs.playerDefending = false
    let msg = ''

    const permaSeverLine = tickPermanentSever(player)
    if (permaSeverLine) msg += permaSeverLine + '\n'
    if (player.hp <= 0) {
      const res = await resolvePlayerHpZero(player, ctx, msg, {})
      if (!res.fallThrough) return res.returnValue
      msg = res.msg
    }

    if (boss) {
      incrementBossTurn(player)
      const tsResult = applyBossSpecial(player, EVENT.TURN_START, {})
      if (tsResult.narrativeLine) msg += `_${tsResult.narrativeLine}_\n`
    }

    const playerStatus = processStatusTurn(player)
    if (playerStatus.lines.length) msg += playerStatus.lines.join('\n') + '\n'
    if (player.hp <= 0) {
      const res = await resolvePlayerHpZero(player, ctx, msg, { boss })
      if (!res.fallThrough) return res.returnValue
      msg = res.msg
    }

    msg +=
      `🌌 *DOMAIN EXPANSION*\n` +
      `─────────────\n` +
      `_"Unlimited Void." The world falls away, and *${e.name}* is handed every thought at once._\n\n`

    if (playerStatus.incapacitated) {
      // He could not open it this turn, but the charge is already spent — the
      // domain is his one attempt, same discipline as the other actives.
      msg += `💫 *${player.name}* is unable to act this turn, and the domain never opens!\n`
    } else {
      // The lockdown. A hard stun for a few of the enemy's turns. If the enemy
      // is itself status-immune (a Shunya owner in a co-op enemy slot, say),
      // addStatusEffect no-sells it and the void finds nothing to fill.
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
          // Report the domain to the boss engine as a landed, damage-less hit
          // so phase logic that watches for the player acting still ticks.
          const takeResult = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
            damage: 0, isCrit: false, isHit: true,
          })
          if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`
          const phase = checkBossPhase(player)
          if (phase?.triggered && phase.lines?.length) {
            msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.map(l => `_${l}_`).join('\n') + '\n'
          }
        }
      }
    }

    // Enemy turn. Tick their statuses (this counts down the stun we just
    // placed by one) and report the lockout. The enemy never counters on the
    // turn the domain opens — the void spends their action for them.
    const enemyStatus = processStatusTurn(e)
    if (enemyStatus.lines.length) msg += enemyStatus.lines.join('\n') + '\n'
    if (e.hp <= 0) {
      if (boss) cleanupBossFight(player)
      return handleVictory(player, e, ctx)
    }

    if (enemyStatus.incapacitated) {
      msg += `\n${e.emoji ?? '👾'} *${e.name}* is trapped in the void. No move comes.`
    } else {
      // Only reachable if the enemy was immune to the stun above; then they
      // act normally. No damage is dealt to the player here regardless — the
      // domain turn is the player's action, and a full counter would be
      // resolved by the next .attack, not folded into this narration.
      msg += `\n${e.emoji ?? '👾'} *${e.name}* shakes off the void and steadies.`
    }

    if (boss) {
      const teResult = applyBossSpecial(player, EVENT.TURN_END, {})
      if (teResult.narrativeLine) msg += `\n_${teResult.narrativeLine}_`
    }

    msg += `\n\n👤 *${player.name}*\n❤️ ${hpBar(player.hp, player.maxHp)}  💧 ${player.mp}/${player.maxMp} MP\n` +
           `${e.emoji ?? '👾'} *${e.name}*\n❤️ ${hpBar(e.hp, e.maxHp)}\n\n` +
           `*${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`

    bs.turn = (bs.turn ?? 1) + 1
    player.battleState = bs
    await sendWillowAdvisory(ctx, player, e, boss)
    await replyWithArt(ctx, msg)
    return player
  })
}

export default {
  name: 'unlimitedvoid',
  aliases: ['unlimited-void', 'void', 'domain-expansion-gojo'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}unlimitedvoid — Gojo's once-per-battle Domain: locks the enemy down (no MP)`,
  run: runUnlimitedVoid,
}
