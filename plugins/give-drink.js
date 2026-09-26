/**
 * give-drink.js — `.give-drink luna @player` : wake a sleeper during The End event.
 *
 * While the End's aura floods the world, every unbanded player of level ≤ 50 is
 * dragged into a deep sleep (lib/end-event.js). Only someone wearing a Blue Band
 * can rouse them: a Luna drink buys the sleeper a 10-minute window to reach the
 * old woman in Astral Town and band up for good.
 *
 * Free to give (there's no item to farm — the point is that banded players are
 * the world's lifeline) but rate-limited per giver→target pair so it can't be
 * spammed as a wake-up alarm.
 */
import { config } from '../config.js'
import { updateAllPlayers, getPlayer } from '../lib/player-repo.js'
import { extractTarget } from '../lib/group-helpers.js'
import { formatTimeLeft } from '../lib/time-format.js'
import {
  giveLuna, isEventActive, hasBlueBand, isAsleepByEnd,
  LUNA_GRACE_MS, SLEEP_MAX_LEVEL,
} from '../lib/end-event.js'

const DRINKS = ['luna']

export default {
  name:           'give-drink',
  aliases:        ['givedrink', 'drink-give', 'luna'],
  category:       'event',
  requiresPlayer: true,
  description:    `${config.prefix}give-drink luna @player — wake a player from the End's deep sleep for ${Math.round(LUNA_GRACE_MS / 60000)} minutes (needs a Blue Band equipped)`,

  async run(ctx) {
    const p = config.prefix
    const args = (ctx.args ?? []).map((a) => String(a).toLowerCase())
    // `.luna @player` is an alias for `.give-drink luna @player`, so the drink
    // can come from the command itself rather than the arguments.
    const drink = ctx.cmd === 'luna' ? 'luna' : DRINKS.find((d) => args.some((a) => a.includes(d)))

    if (!drink) {
      return ctx.reply(
        `🍶 *Usage:* *${p}give-drink luna @player*\n\n` +
        `_Luna wakes a player from the End's deep sleep for ${Math.round(LUNA_GRACE_MS / 60000)} minutes._\n` +
        `_You must have a *Blue Band* equipped to pour it._`,
      )
    }

    if (!isEventActive(ctx.db)) {
      return ctx.reply(`🍶 The air is clean — nobody is sleeping. _Luna keeps for another time._`)
    }

    const targetId = extractTarget(ctx)
    if (!targetId) {
      return ctx.reply(
        `❌ *Who are you pouring for?*\n` +
        `_Mention them or reply to their message:_ *${p}give-drink luna @player*`,
      )
    }
    if (targetId === ctx.from) {
      return ctx.reply(`🍶 _You can't pour Luna for yourself — you'd have to be awake to drink it._`)
    }

    const targetBefore = getPlayer(ctx.db, targetId)
    if (!targetBefore) {
      return ctx.reply(`❌ That player isn't registered yet.`)
    }

    let result = null
    await updateAllPlayers(ctx.db, (users) => {
      result = giveLuna(ctx.db, users[ctx.from], users[targetId], Date.now())
      return result.ok
    })

    if (result.ok) {
      const target = getPlayer(ctx.db, targetId) ?? targetBefore
      return ctx.reply(
        `🍶 *${ctx.player.name}* tips a vial of *Luna* past *${target.name}*'s lips.\n\n` +
        `😳 _They jolt awake, gasping — the aura recoils from the Blue Band on your arm._\n` +
        `⏳ Awake for *${formatTimeLeft(LUNA_GRACE_MS)}*.\n\n` +
        `🧿 *${target.name}* — go now: *${p}travel town* → *${p}shop buy blue band* → *${p}equip blue band*.`,
      )
    }

    switch (result.reason) {
      case 'no_band':
        return ctx.reply(
          `❌ *You have no Blue Band.*\n` +
          `_The aura owns you too — you can't hold Luna steady, let alone pour it._\n` +
          `👵 _Ask the old woman in Astral Town:_ *${p}shop buy blue band*`,
        )
      case 'cooldown': {
        const left = Math.max(0, result.retryAt - Date.now())
        return ctx.reply(
          `⏳ *Too soon.* You poured for *${targetBefore.name}* recently.\n` +
          `_Try again in ${formatTimeLeft(left)}._`,
        )
      }
      case 'not_asleep': {
        if (hasBlueBand(targetBefore)) {
          return ctx.reply(`🧿 *${targetBefore.name}* already wears a Blue Band — the aura can't touch them.`)
        }
        if ((targetBefore.level ?? 1) > SLEEP_MAX_LEVEL) {
          return ctx.reply(
            `💪 *${targetBefore.name}* is too strong to sleep _(Level ${targetBefore.level})_ — ` +
            `the aura only weakens them.\n_Luna won't help; a Blue Band will._`,
          )
        }
        if (!isAsleepByEnd(ctx.db, targetBefore)) {
          return ctx.reply(`👀 *${targetBefore.name}* is already awake. _Don't waste the Luna._`)
        }
        return ctx.reply(`👀 *${targetBefore.name}* isn't sleeping.`)
      }
      case 'self':
        return ctx.reply(`🍶 _You can't pour Luna for yourself._`)
      case 'inactive':
        return ctx.reply(`🍶 The air is clean — nobody is sleeping.`)
      default:
        return ctx.reply(`❌ Couldn't pour that drink.`)
    }
  },
}
