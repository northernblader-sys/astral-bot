import { config } from '../config.js'
import { REGION_MAP, GUARDIAN, ensureGuardianState } from '../lib/guardian-event.js'
import { updatePlayer } from '../lib/player-repo.js'
import { calcMonsterDamage, hpBar } from '../lib/combat-engine.js'
import {
  processStatusTurn,
  resolvePlayerHpZero,
  checkCatFormOngoingTurn,
} from '../lib/combat-handlers.js'
import { getEffectiveStat, hasEffect } from '../lib/effects.js'
import { cleanupBossFight } from '../lib/boss-engine.js'
import { applyIncomingDamage } from '../lib/character-abilities.js'
import { resolveCatFormDefeat } from '../lib/combat-handlers.js'
import { resolveSwarmFlee } from '../lib/swarm-combat.js'

export default {
  name: 'flee', aliases: ['run', 'escape'],
  category: 'combat', requiresPlayer: true,
  description: 'Attempt to flee from the current battle',

  async run(ctx) {
    const p = config.prefix
    await updatePlayer(ctx.db, ctx.from, async player => {
      // Swarm floors (Entry Tower prototype) run the multi-monster engine in
      // lib/swarm-combat.js; the 1v1 flee below is untouched everywhere else.
      if (player.battleState?.mode === 'swarm') return resolveSwarmFlee(player, ctx)
      // Party (.dparty) combat is a separate state machine (see
      // plugins/party.js's header comment) — it sets player.inBattle=true
      // but deliberately never populates player.battleState (party fights
      // are multi-actor and don't map onto the solo battleState shape).
      // That combination (inBattle true, battleState falsy) is unique to
      // party combat — dungeon.js and pvp.js both always set a full
      // battleState alongside inBattle — so it's a safe, unambiguous
      // signal to catch here, BEFORE the generic "not in battle" check
      // below wrongly tells an actively-fighting party member the
      // opposite of what's true. Real flee logic for party fights lives
      // in battleFlee() in plugins/party.js (via .pflee / .dparty flee).
      if (player.inBattle && !player.battleState) {
        await ctx.reply(
          `👥 *You're in a party battle — use *${p}pflee* instead.*\n_(alias for *${p}dparty flee*)_`,
        )
        return player
      }
      if (!player.inBattle || !player.battleState) {
        await ctx.reply(`❌ *Not in battle.*`)
        return player
      }
      const e = player.battleState.enemy
      if (!e) {
        // battleState exists but has no `enemy` (e.g. a PvP duel, or a
        // corrupted/stale state) — flee doesn't apply here. Tell the
        // player how to actually get unstuck instead of crashing.
        await ctx.reply(
          player.battleState.type === 'pvp'
            ? `⚔️ *You're in a PvP duel — flee doesn't work here.* _Keep fighting, or use *${p}cb* to forfeit and clear your battle state._`
            : `⚠️ *No enemy found in your battle state.* _Use *${p}cb* to clear it and try again._`,
        )
        return player
      }
      const catTurn = await checkCatFormOngoingTurn(player, ctx, {
        boss: !!e.isBoss,
      })
      if (catTurn.intercepted) return catTurn.returnValue
      if (e.isBoss) {
        await ctx.reply(`⚠️ *You cannot flee from a boss!* _Defeat it or fall trying._`)
        return player
      }

      const chance = 0.35 + (player.stats.lck ?? 0) * 0.003
      if (Math.random() < chance) {
        // Successful flee — cleanupBossFight is a no-op for non-boss fights,
        // but ensures bossState is always explicitly cleared before nulling battleState.
        const rescueBs = player.battleState?.type === 'rescue' ? player.battleState.guardian : null
        cleanupBossFight(player)
        player.inBattle    = false
        player.battleState = null
        if (rescueBs) {
          // Guardian of the Innocent: running costs the day's attempt and the
          // captives stay in the cage. A captor also resets the retry gate.
          const region = REGION_MAP[rescueBs.regionId]
          const g = ensureGuardianState(player)
          if (rescueBs.isCaptor && region) {
            g.captorRetryAt[region.id] = (g.regionWins[region.id] ?? 0) + GUARDIAN.captorRetryWins
          }
          const cap = rescueBs.captives?.[0]
          await ctx.reply(
            `🏃 *${player.name}* breaks away from *${e.name}*.\n\n` +
            (cap ? `🗣️ *${cap.name}:* _\"you are leaving\" the voice goes small \"it is all right we are used to it\"_\n\n` : '') +
            `_The cage stays shut behind you._` +
            (rescueBs.isCaptor && region ? `\n_${region.captor.name} will not show again until ${GUARDIAN.captorRetryWins} more rescues here._` : '') +
            `\n_Type_ *${p}rescue* _when you are ready to go back._`,
          )
          return player
        }
        await ctx.reply(
          `🏃 *${player.name}* escapes from *${e.name}*!\n\n` +
          `📍 _Still on Floor_ *${player.dungeonFloor}*.\n` +
          `_Type_ *${p}dungeon* _to try again._`,
        )
      } else {
        if (hasEffect(e, 'stun') || hasEffect(e, 'freeze')) {
          await ctx.reply(
            `❌ *Escape failed!*\n💫 *${e.name}* is unable to act this turn!\n\n` +
            `❤️ ${hpBar(player.hp, player.maxHp)}\n\n` +
            `*${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`,
          )
        } else {
          const dmg = calcMonsterDamage(e.atk, getEffectiveStat(player, 'def'), false)
          const applied = applyIncomingDamage(player, dmg)

          if (applied.catFormDefeated) {
            return resolveCatFormDefeat(player, ctx)
          }
          if (player.hp <= 0) {
            // Dying on a failed flee — resolvePlayerHpZero() covers pearl,
            // totem, and Yoriichi's cat form before falling to real death.
            const res = await resolvePlayerHpZero(player, ctx, applied.message ?? '', {})
            if (!res.fallThrough) return res.returnValue
            // A totem fired — flee still failed this turn but the player
            // is alive again; fall through to the normal failed-flee reply
            // below, carrying the totem's line forward via sustain.message.
            applied.message = res.msg
          }

          await ctx.reply(
            (applied.message ?? '') +
            `❌ *Escape failed!*\n${e.emoji ?? '👾'} *${e.name}* catches you!\n🩸 *${applied.damage}* damage!\n\n` +
            `❤️ ${hpBar(player.hp, player.maxHp)}\n\n` +
            `*${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`,
          )
        }
      }
      return player
    })
  },
}
