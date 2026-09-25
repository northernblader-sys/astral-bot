/**
 * <prefix>rescue — Guardian of the Innocent: raid the pens at your current
 * event location and fight the slaver holding 1-3 beastkin captives.
 *
 * The fight is an ordinary PvE battle (battleState.type = 'rescue') so
 * .attack / .skill / .defend / .flee and every character power work on it.
 * lib/combat-handlers.js takes over on the result: handleRescueWin() on a win,
 * handleRescueLoss() on a loss (no death penalty). The captives talk every
 * turn through lib/battle-frame-render.mjs (rescueChatter).
 *
 * After 30 wins in a region that holds a companion, the next rescue there is
 * the captor fight instead, unless that companion is already someone's, or the
 * player already has a companion, or turned this one down.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { applyPassiveAbilities } from '../lib/ability-engine.js'
import { armHypnosis, armLovestruck, armFusion, armWondersOfEnvy } from '../lib/character-abilities.js'
import { sendBattleTurnReply } from '../lib/battle-frame-render.mjs'
import { hpBar } from '../lib/combat-engine.js'
import { formatTimeLeft } from '../lib/time-format.js'
import {
  GUARDIAN, REGION_MAP, COMPANION_MAP, isGuardianActive, isRegionOpen, regionOpensAt,
  ensureGuardianState, rescuesLeftToday, dailyCap, consumeRescue, nextDayAt, expireOffer,
  captorDue, buildSlaver, rollCaptives, describeCaptive, rescueIntroLine,
} from '../lib/guardian-event.js'
import { sendCompanionOffer } from '../lib/guardian-ui.js'

export default {
  name: 'rescue',
  aliases: ['freecaptives', 'rescues'],
  category: 'event',
  requiresPlayer: true,
  description: 'Guardian of the Innocent: fight the slavers at your event location and free their captives',

  async run(ctx) {
    const p = config.prefix
    if (!isGuardianActive(ctx.db)) {
      return ctx.reply(`🕊️ *Guardian of the Innocent* is not running right now.\n_Check *${p}guardian* for news._`)
    }

    let pendingOffer = null
    let expired = null
    await updatePlayer(ctx.db, ctx.from, async (player) => {
      if (player.inBattle) {
        await ctx.reply(`⚔️ *Finish your current battle first!*`)
        return player
      }
      if (player.inDungeon) {
        await ctx.reply(`🗺️ You're inside a dungeon. _Type_ *${p}dungeon leave* _first, the pens are out on the frontier._`)
        return player
      }
      if ((player.hp ?? 0) <= 0) {
        await ctx.reply(`💤 You can barely stand. Rest at the *${p}inn* first.`)
        return player
      }

      const g = ensureGuardianState(player)
      const now = Date.now()
      expired = expireOffer(player, now)
      if (g.offer) {
        pendingOffer = COMPANION_MAP[g.offer.companionId]
        return player
      }

      const left = rescuesLeftToday(ctx.db, player, now)
      const region = g.region ? REGION_MAP[g.region] : null
      if (!region) {
        await ctx.reply(`🗺️ *Pick where to go first.*\n_Type_ *${p}guardian map* _to see the locations, then_ *${p}guardian travel <name>*.`)
        return player
      }
      if (!isRegionOpen(ctx.db, region, now)) {
        await ctx.reply(`🔒 *${region.name}* opens in *${formatTimeLeft(regionOpensAt(ctx.db, region) - now)}*.\n_Type_ *${p}guardian map* _for somewhere open._`)
        return player
      }
      if (left <= 0) {
        await ctx.reply(
          `🌙 *You have done all you can today.*\n` +
          `_${dailyCap(player)} rescues is the most anyone can carry in one day. The pens will still be there tomorrow, and so will the people in them._\n\n` +
          `⏳ Next rescues in *${formatTimeLeft(nextDayAt(ctx.db, now) - now)}*`,
        )
        return player
      }

      const captor = captorDue(ctx.db, player, region, now)
      const enemy = buildSlaver(player, region, { captor })
      const captives = rollCaptives(captor ? 1 + Math.floor(Math.random() * 2) : 1 + Math.floor(Math.random() * 3))
      consumeRescue(ctx.db, player, now)

      player.inBattle = true
      player.battleState = {
        type: 'rescue',
        locationId: null,
        enemy,
        bossState: null,
        playerDefending: false,
        turn: 1,
        abilityCooldowns: {},
        lastMoveAt: now,
        guardian: { regionId: region.id, captives, isCaptor: captor, slaverName: enemy.name },
      }
      applyPassiveAbilities(player)
      armHypnosis(player)
      armLovestruck(player, enemy)
      armWondersOfEnvy(player)
      const fusionLine = armFusion(player)

      const header = captor
        ? `⛓️ ━━━ *${region.captor.title?.toUpperCase?.() ?? 'THE CAPTOR'}* ━━━ ⛓️`
        : `🕊️ *RESCUE: ${region.name.toUpperCase()}*`
      const captiveLines = captives.map(describeCaptive).join('\n')
      const comp = COMPANION_MAP[region.companionId]
      const msg =
        `${header}\n` +
        `${region.emoji} _${region.arrival}_\n\n` +
        (captor ? `${region.captor.emoji ?? '⛓️'} *${region.captor.name}:* _${region.captor.intro}_\n` +
          (comp ? `_Behind the last door, someone is listening very hard: *${comp.name}*._\n` : '') + `\n` : '') +
        `⛓️ *In the cage:*\n${captiveLines}\n\n` +
        `${rescueIntroLine(player.battleState)}\n\n` +
        `${enemy.emoji} *${enemy.name}*${captor ? ' _(Captor ⭐)_' : ''}\n` +
        `❤️ ${hpBar(enemy.hp, enemy.maxHp)}\n` +
        `⚔️ ATK: *${enemy.atk}*  🛡️ DEF: *${enemy.def}*\n\n` +
        `👤 *${player.name}* (Lv ${player.level})\n` +
        `❤️ ${hpBar(player.hp, player.maxHp)}\n` +
        `💧 MP: *${player.mp}/${player.maxMp}*\n\n` +
        (fusionLine ? `${fusionLine}\n\n` : '') +
        `🕊️ Rescues left today: *${left - 1}*/${dailyCap(player)}\n` +
        `*${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`

      await sendBattleTurnReply(ctx, {
        player, e: enemy, msg,
        hpBeforeTurn: player.hp, eHpBeforeTurn: enemy.hp,
        boss: false, lastAction: null,
      })
      return player
    })

    if (pendingOffer) {
      await ctx.reply(`⏳ *Someone is still waiting on your answer.* Answer first with *${p}guardian accept* or *${p}guardian reject*.`)
      return sendCompanionOffer(ctx, pendingOffer)
    }
    if (expired) {
      await ctx.reply(`_${expired.name} waited as long as ${expired.pronoun === 'they' ? 'they' : 'she'} could. The request has lapsed. The captor at ${REGION_MAP[expired.regionId]?.name} will be back after ${GUARDIAN.captorRetryWins} more rescues there._`).catch(() => {})
    }
  },
}
