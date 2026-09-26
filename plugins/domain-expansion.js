/**
 * domain-expansion.js — the SHARED Domain Expansion command for every JJK
 * sorcerer. This is deliberately NOT a Megumi-only move: Domain Expansion is a
 * jujutsu technique, so the command reads whoever the player has equipped and
 * opens THAT character's domain.
 *
 *   Megumi Fushiguro -> Chimera Shadow Garden  (runMegumiDomain, below)
 *   Gojo Satoru      -> Unlimited Void         (runUnlimitedVoid, ./domain.js)
 *
 * Adding a future JJK character's domain is one line in JJK_DOMAINS: write the
 * turn as its own plugin (the way plugins/domain.js holds Gojo's), export the
 * runner, and register it here. Nothing else in the dispatcher changes.
 *
 * The dispatcher only PICKS a runner, it does not gate. Each runner still calls
 * its own activate* gate, which enforces "you must have that character
 * equipped" and the once-per-battle latch, so routing can never hand someone a
 * domain they don't own. Each runner also keeps its own PvP behaviour: both
 * Megumi and Gojo hand a duel off to pvp.js (pvpDomain / pvpUnlimitedVoid).
 *
 * MEGUMI'S BRANCH is structurally identical to plugins/cinderverdict.js
 * (Wither's signature move): accuracy-free signature burst, damage through
 * calcPlayerDamage() -> applyDefense(), boss-engine hooks when fighting an
 * anime boss, then the enemy's counter-attack. The differences are all his:
 *   • the Domain splash image is shown whenever it is opened, anywhere;
 *   • it costs 0 MP and, once open, DOUBLES the Thousand Shadows Swarm and
 *     grants shadow-travel dodge for the rest of the fight (a state change,
 *     like Mei's Final Form — see lib/megumi.js activateChimeraDomain);
 *   • the same turn also runs Megumi's swarm (megumiTurnStart) and lets
 *     Mahoraga adapt to the enemy's counter (recordMahoragaExposure), so the
 *     Garden behaves consistently with every other Megumi turn.
 *
 * Usage: <prefix>domainexpansion   (with a JJK sorcerer equipped)
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
  calcPlayerHitChance, calcMonsterHitChance, calcMonsterDamage, hpBar,
} from '../lib/combat-engine.js'
import {
  handleVictory,
  processStatusTurn,
  resolvePlayerHpZero,
  checkCatFormOngoingTurn,
  resolveCatFormDefeat,
} from '../lib/combat-handlers.js'
import { getEffectiveStat } from '../lib/effects.js'
import {
  applyBossSpecial, checkBossPhase, buildEnemyAttack,
  getBossTaunt, getBossHitLine, getBossDodgeLine,
  incrementBossTurn, cleanupBossFight, EVENT,
} from '../lib/boss-engine.js'
import {
  applyTearOnHit,
  sendWillowAdvisory,
  tickPermanentSever,
  applyIncomingDamage,
  activateChimeraDomain,
  chimeraBurstDamage,
  megumiTurnStart,
  recordMahoragaExposure,
  rollShadowDodge,
  moveKeyFor,
  sendDomainImage,
  sendWheelSpin,
} from '../lib/character-abilities.js'
import { pvpDomain } from './pvp.js'
// Gojo's domain turn. One-directional: domain.js imports nothing from here.
import { runUnlimitedVoid } from './domain.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

/**
 * runMegumiDomain(ctx) — Megumi's Chimera Shadow Garden turn, factored out so
 * the dispatcher default export below can route to it. Keeps its own PvP
 * handoff to pvp.js, exactly as before it was a plugin method.
 */
export async function runMegumiDomain(ctx) {
  const p = config.prefix

  // Duels run on pvp.js's engine.
  if (ctx.player?.battleState?.type === 'pvp') {
    return pvpDomain(ctx)
  }

  // Media splash is sent from OUTSIDE the mutator (no network I/O inside
  // updatePlayer) but only once we know Megumi is equipped and in battle.
  // The Wheel-spin GIF is the exception: it fires from inside, the moment
  // Mahoraga masters a move (the `void sendWheelSpin(...)` calls below —
  // same fire-and-forget shape attack.js uses for sendFinalFormVideo), so
  // it plays as its own message BEFORE the generic battle text that follows.
  let showDomainSplash = false

  await updatePlayer(ctx.db, ctx.from, async player => {
    const catTurn = await checkCatFormOngoingTurn(player, ctx, { boss: isBossFight(player) })
    if (catTurn.intercepted) return catTurn.returnValue

    const gate = activateChimeraDomain(player)
    if (!gate.ok) {
      if (gate.message) await ctx.reply(gate.message)
      return player
    }
    showDomainSplash = true

    const bs   = player.battleState
    const e    = bs.enemy
    const boss = isBossFight(player)

    bs.playerDefending = false
    let msg = gate.message + '\n\n'

    // Urahara's permanent Tear — action-triggered tick.
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

    // Thousand Shadows Swarm (doubled now that the Garden is open).
    const swarm = megumiTurnStart(player, e, bs)
    if (swarm?.message) msg += swarm.message + '\n'
    if (e.hp <= 0) { if (boss) cleanupBossFight(player); return handleVictory(player, e, ctx) }

    // Opening horde burst — stock pipeline, Domain multiplier.
    const { dmg, isCrit } = chimeraBurstDamage(player, e)
    e.hp = Math.max(0, e.hp - dmg)
    msg += `\n💥 *The horde descends!* *${dmg}* damage!${isCrit ? ' 💥 *CRITICAL!*' : ''}\n`

    if (e.hp > 0) {
      const tearLine = applyTearOnHit(player, e, ctx)
      if (tearLine) msg += tearLine + '\n'
    }

    if (boss) {
      const takeResult = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
        damage: dmg, element: 'dark', isCrit, isHit: true,
      })
      if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`
      msg += `💬 _"${getBossHitLine(player)}"_\n`
    }

    if (e.hp <= 0) {
      if (boss) cleanupBossFight(player)
      return handleVictory(player, e, ctx)
    }

    if (boss) {
      const phase = checkBossPhase(player)
      if (phase?.triggered && phase.lines?.length) {
        msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.map(l => `_${l}_`).join('\n') + '\n'
      }
    }

    // ── Enemy counter-attack ────────────────────────────────────────────
    const enemyStatus = processStatusTurn(e)
    if (enemyStatus.lines.length) msg += enemyStatus.lines.join('\n') + '\n'
    if (e.hp <= 0) { if (boss) cleanupBossFight(player); return handleVictory(player, e, ctx) }

    if (enemyStatus.incapacitated) {
      msg += `💫 *${e.name}* is unable to attack this turn!\n`
    } else if (boss) {
      const bossAtk    = buildEnemyAttack(player)
      const dealResult = applyBossSpecial(player, EVENT.ENEMY_DEAL_DAMAGE, { damage: bossAtk.damage, isHit: true })
      const rawBossAtk = (dealResult.modified && dealResult.damage !== undefined) ? dealResult.damage : bossAtk.damage
      const incoming   = bossAtk.bypassDefense
        ? rawBossAtk
        : calcMonsterDamage(rawBossAtk, getEffectiveStat(player, 'def'), false)

      // Mahoraga adaptation → then shadow-travel dodge → then real damage.
      const mora = recordMahoragaExposure(player, moveKeyFor('boss', bossAtk.attackName), bossAtk.attackName, bs)
      if (mora?.wheelSpin) void sendWheelSpin(ctx, mora.message).catch(() => {})
      if (mora?.nullified) {
        if (!mora.wheelSpin && mora.message) msg += mora.message + '\n'
        msg += `\n${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*!\n🛡️ *0* damage. Mahoraga has adapted.\n`
      } else {
        if (mora?.message) msg += mora.message + '\n'
        const dodge = rollShadowDodge(player, { damage: incoming, trueDamage: !!bossAtk.bypassDefense })
        if (dodge.dodged) {
          msg += (dodge.message ? dodge.message + '\n' : '') +
                 `\n${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*!\n💨 Missed. Nothing there to hit.\n`
        } else {
          const applied = applyIncomingDamage(player, dodge.damage)
          if (applied.message) msg += applied.message + '\n'
          msg += `\n${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*!\n🩸 *${applied.damage}* damage!${bossAtk.bypassDefense ? ' _(bypasses DEF)_' : ''}\n`
          if (dealResult.narrativeLine) msg += `_${dealResult.narrativeLine}_\n`
          if (applied.catFormDefeated) return resolveCatFormDefeat(player, ctx, { boss: true })
        }
      }
      msg += `\n💬 _"${getBossTaunt(player)}"_\n`
      if (player.hp <= 0) {
        const res = await resolvePlayerHpZero(player, ctx, msg, { boss: true })
        if (!res.fallThrough) return res.returnValue
        msg = res.msg
      }
    } else if (Math.random() > calcMonsterHitChance(e, player)) {
      msg += `\n${e.emoji ?? '👾'} *${e.name}* retaliates... and *MISSES!*`
    } else {
      const enemyDmg = calcMonsterDamage(e.atk, getEffectiveStat(player, 'def'), false)
      const mora = recordMahoragaExposure(player, moveKeyFor('enemy'), `${e.name}'s attack`, bs)
      if (mora?.wheelSpin) void sendWheelSpin(ctx, mora.message).catch(() => {})
      if (mora?.nullified) {
        if (!mora.wheelSpin && mora.message) msg += mora.message + '\n'
        msg += `\n${e.emoji ?? '👾'} *${e.name}* retaliates!\n🛡️ *0* damage. Mahoraga has adapted.`
      } else {
        if (mora?.message) msg += mora.message + '\n'
        const dodge = rollShadowDodge(player, { damage: enemyDmg })
        if (dodge.dodged) {
          msg += (dodge.message ? dodge.message + '\n' : '') + `\n${e.emoji ?? '👾'} *${e.name}* retaliates... but hits only shadow!`
        } else {
          const applied = applyIncomingDamage(player, dodge.damage)
          if (applied.message) msg += applied.message + '\n'
          msg += `\n${e.emoji ?? '👾'} *${e.name}* retaliates!\n🩸 *${applied.damage}* damage!`
          if (applied.catFormDefeated) return resolveCatFormDefeat(player, ctx)
        }
      }
      if (player.hp <= 0) {
        const res = await resolvePlayerHpZero(player, ctx, msg, {})
        if (!res.fallThrough) return res.returnValue
        msg = res.msg
      }
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

  // The Domain splash, sent after the mutation resolves.
  if (showDomainSplash) {
    await sendDomainImage(ctx, `🌑 *CHIMERA SHADOW GARDEN*. The shadows swallow the battlefield.`)
  }
}

/**
 * Every JJK sorcerer who can open a Domain, keyed by the character id stored in
 * player.equippedCharacter. `sorcerer` and `domain` are only used to write the
 * refusal message, so a new entry documents itself in the help text for free.
 */
const JJK_DOMAINS = {
  megumi: { sorcerer: 'Megumi Fushiguro', domain: 'Chimera Shadow Garden', run: runMegumiDomain },
  gojo:   { sorcerer: 'Gojo Satoru',      domain: 'Unlimited Void',        run: runUnlimitedVoid },
}

export default {
  name: 'domain-expansion',
  aliases: ['domain', 'de', 'domainexpansion', 'chimera'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}domainexpansion — open your JJK sorcerer's Domain (no MP, once per battle)`,

  async run(ctx) {
    const equipped = ctx.player?.equippedCharacter
    const entry = equipped ? JJK_DOMAINS[equipped] : null

    if (!entry) {
      const roster = Object.values(JJK_DOMAINS)
        .map(d => `  ${d.sorcerer} opens *${d.domain}*`)
        .join('\n')
      return ctx.reply(
        `🌀 *Domain Expansion is a jujutsu technique.*\n\n` +
        `_You need a sorcerer equipped to open one:_\n${roster}\n\n` +
        `_Equip with *${config.prefix}character equip <name>*, then try again._`,
      )
    }

    // The runner owns everything from here: the equip gate, the
    // once-per-battle latch, PvE vs PvP, and every reply.
    return entry.run(ctx)
  },
}
