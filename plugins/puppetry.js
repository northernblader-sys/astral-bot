/**
 * puppetry.js — Red Rose's signature move: Puppet Strings.
 *
 * Once per battle, no MP (bs.puppetStringsUsed, set by activatePuppetStrings()
 * in lib/character-abilities.js — the same battleState latch every other active
 * uses, so it resets with the fight for free). She takes the strings and the
 * enemy strikes ITSELF: the blow is built from the enemy's OWN attack, run
 * through the enemy's OWN defense (resolvePuppetSelfHit), floored so it can
 * never bring the enemy below 20% of its max HP — a tempo swing and a chunk of
 * chip, never a one-button kill. Then the enemy is tangled for PUPPET_TANGLE_TURNS
 * (one), applied as a plain 'stun' so the generic processStatusTurn() skips its
 * next turn exactly the way Gojo's Unlimited Void relies on — no per-plugin
 * enemy-turn hook needed.
 *
 * The turn shape is the front half of plugins/domain.js: status tick, the
 * strike + tangle, boss ENEMY_TAKE_DAMAGE reported for the self-hit, then the
 * enemy's turn plays out as "tangled, no move comes" (the stun we just placed).
 * The enemy never counters on the turn the strings are cut — the redirect spends
 * their action for them, same discipline the void uses.
 *
 * PvP: in a duel this hands off to pvp.js's pvpPuppetStrings() (the
 * 'puppetstrings' action there), since this plugin only knows the PvE
 * battleState shape (bs.enemy).
 *
 * Usage: <prefix>puppet
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
  activatePuppetStrings,
  resolvePuppetSelfHit,
  buildPuppetStringsReveal,
  sendWillowAdvisory,
  tickPermanentSever,
  PUPPET_TANGLE_TURNS,
} from '../lib/character-abilities.js'
import { pvpPuppetStrings } from './pvp.js'
import { resolveSwarmAbility } from '../lib/swarm-combat.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

/**
 * runPuppetStrings(ctx) — the whole Red Rose puppetry turn. Kept as its own
 * exported function so a general dispatcher could call it, mirroring
 * runUnlimitedVoid() in plugins/domain.js; the plugin's run() is a thin wrapper.
 */
export async function runPuppetStrings(ctx) {
  const p = config.prefix

  // In a duel, puppetry hands off to the PvP turn engine: this plugin only
  // knows the PvE battleState shape (bs.enemy). Same handoff domain.js uses.
  if (ctx.player?.battleState?.type === 'pvp') {
    return pvpPuppetStrings(ctx)
  }

  await updatePlayer(ctx.db, ctx.from, async player => {
    const catTurn = await checkCatFormOngoingTurn(player, ctx, {
      boss: isBossFight(player),
    })
    if (catTurn.intercepted) return catTurn.returnValue

    const gate = activatePuppetStrings(player)
    if (!gate.ok) {
      if (gate.message) await ctx.reply(gate.message)
      return player
    }

    // Swarm floors: fold the puppetry into one swarm turn against the nearest
    // threat. The strings take that one monster — it strikes itself through its
    // own guard, floored so it never drops below 20% of its max HP — and hangs
    // tangled, expressed swarm-native as its wind-up cancelled and its next
    // re-aim skipped (it loses its next move). The rest of the pack still
    // closes, so she swings a floor without freezing it, and kills route
    // through the shared branch so a self-hit can never wrongly clear a floor.
    if (player.battleState?.mode === 'swarm') {
      return resolveSwarmAbility(player, ctx, (target) => {
        const selfHit = resolvePuppetSelfHit(target)
        target.hp = selfHit.newHp
        return {
          lines: [buildPuppetStringsReveal(player.name, target.name, selfHit, {
            context: 'dungeon', tangled: true, immune: false,
          })],
          cancelTelegraph: true,
          suppressReTelegraph: true,
        }
      })
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

    if (playerStatus.incapacitated) {
      // She could not raise a hand this turn, but the charge is already spent —
      // the strings are her one attempt, same discipline as the other actives.
      msg +=
        `🌹 *PUPPET STRINGS*\n` +
        `─────────────\n` +
        `💫 *${player.name}* is unable to act this turn, and the strings never go taut!\n`
    } else {
      // The self-strike. resolvePuppetSelfHit computes it against the enemy's
      // own attack/defense and floors it; we write the HP here.
      const selfHit = resolvePuppetSelfHit(e)
      e.hp = selfHit.newHp

      // The tangle. A plain stun so processStatusTurn() below skips the enemy's
      // turn for us; a status-immune enemy (a Shunya owner in an enemy slot)
      // tears free and addStatusEffect reports immune.
      const tangle = addStatusEffect(e, {
        type: 'stun',
        duration: PUPPET_TANGLE_TURNS,
        sourceId: 'puppet_strings',
      })

      msg += buildPuppetStringsReveal(player.name, e.name, selfHit, {
        context: boss ? 'boss' : 'dungeon',
        tangled: !tangle?.immune,
        immune: !!tangle?.immune,
      }) + '\n'

      if (boss) {
        // Report the self-hit to the boss engine as a landed hit so phase logic
        // watching for damage still ticks.
        const takeResult = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
          damage: selfHit.dealt, isCrit: false, isHit: true,
        })
        if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`
        const phase = checkBossPhase(player)
        if (phase?.triggered && phase.lines?.length) {
          msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.map(l => `_${l}_`).join('\n') + '\n'
        }
      }

      // The floor makes a self-kill impossible for any enemy with a normal max
      // HP, but a degenerate enemy (maxHp so small the 20% floor rounds to 0)
      // could still reach 0 — so the victory check stays honest.
      if (e.hp <= 0) {
        if (boss) cleanupBossFight(player)
        return handleVictory(player, e, ctx)
      }
    }

    // Enemy turn. Ticking their statuses counts the tangle down by one and, while
    // it holds, reports them as incapacitated — no counter lands this turn.
    const enemyStatus = processStatusTurn(e)
    if (enemyStatus.lines.length) msg += enemyStatus.lines.join('\n') + '\n'
    if (e.hp <= 0) {
      if (boss) cleanupBossFight(player)
      return handleVictory(player, e, ctx)
    }

    if (enemyStatus.incapacitated) {
      msg += `\n${e.emoji ?? '👾'} *${e.name}* is tangled in her strings. No move comes.`
    } else {
      // Only reachable if the enemy was immune to the tangle above; it took the
      // self-hit regardless, then steadies. No damage is dealt to the player
      // here — the puppetry turn is the player's action, and a real counter is
      // resolved on the next .attack, not folded into this narration.
      msg += `\n${e.emoji ?? '👾'} *${e.name}* pulls the strings loose and steadies.`
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
    await ctx.reply(msg)
    return player
  })
}

export default {
  name: 'puppet',
  aliases: ['puppetry', 'puppetstrings', 'puppet-strings', 'strings', 'marionette'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}puppet: Red Rose's once-per-battle puppetry. The enemy strikes itself and hangs tangled (no MP)`,
  run: runPuppetStrings,
}
