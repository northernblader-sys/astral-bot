/**
 * <prefix>reborn — the endgame ritual for a Level 100 player.
 *
 * A god releases his Aura. The Aura chips 90 HP every 4 seconds. Survive 30
 * seconds (675 HP total) and he acknowledges you: your level ceiling rises
 * from 100 to 200, every stat gains +100, max HP gains +300, and you choose
 * one of three divine relics. Fail and you are rejected, and you lose 5
 * levels.
 *
 * Sub-commands:
 *   .reborn              the invitation, plus a survival verdict
 *   .reborn accept       stand in the Aura and start the 30 second trial
 *   .reborn pick <1|2|3> claim your relic (stays open indefinitely)
 *   .reborn status       where you stand with the god
 *
 * GROUPS ONLY. The ceremony is a spectacle and the whole point is that the
 * group watches the HP bar move.
 *
 * WHY THE TICKER IS ONE EDITED MESSAGE
 * Eight separate tick messages would bury a group chat for half a minute.
 * Instead one message is sent and then edited in place on every tick, using
 * whatever each platform's edit primitive is (Baileys `edit:` key, a
 * discord.js Message.edit, Telegram's editMessageText). Where no editable
 * handle comes back, the trial degrades to one opening message plus the
 * closing result rather than spamming.
 *
 * WHY THE 30 SECONDS RUNS OUTSIDE updatePlayer()
 * updatePlayer() is a serialized write queue for the whole process. Holding
 * it for 30 seconds would freeze every other player's writes. So the trial
 * is stamped into player.reborn.trial in one short write, the ticker runs
 * unlocked, and the outcome is applied in a second short write. The maths is
 * deterministic (see lib/reborn-engine.js), so an interrupted trial resolves
 * to the exact same outcome when the player next runs the command.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getTotalStats, levelsData, allItems } from '../lib/game-data.js'
import { NOT_GROUP } from '../lib/group-helpers.js'
import { hpBar } from '../lib/combat-engine.js'
import { statPointCap } from '../lib/stat-progression.js'
import {
  AURA_CHIP,
  AURA_TICK_MS,
  AURA_DURATION_MS,
  AURA_TOTAL,
  REBORN_FAIL_LEVELS,
  REBORN_REQ_LEVEL,
  REBORN_STAT_BONUS,
  REBORN_HP_BONUS,
  REBORN_OFFER_TTL_MS,
  REBORN_CHOICES,
  AURA_LOCK_MSG,
  auraDamageAt,
  isReborn,
  playerLevelCap,
  playerMaxStatPoints,
  resolveTrial,
  applyRebornSuccess,
  applyRebornFailure,
} from '../lib/reborn-engine.js'

const RULE = '━━━━━━━━━━━━━━━━━━━━'
const BAR_WIDTH = 20

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const itemName = (id) => allItems.find((i) => i.id === id)?.name ?? id

/** True while the player has a trial stamped that has not finished yet. */
function trialIsLive(player) {
  const t = player?.reborn?.trial
  return !!t && Date.now() < (t.endsAt ?? 0)
}

/** True when a trial was stamped but the process never got to resolve it. */
function trialIsStale(player) {
  const t = player?.reborn?.trial
  return !!t && Date.now() >= (t.endsAt ?? 0)
}

function offerIsOpen(player) {
  const o = player?.reborn?.offer
  return !!o && Date.now() < (o.expiresAt ?? 0)
}

/**
 * openTicker(ctx, text) -> { edit(next) }
 *
 * Sends the first frame and hands back a per-platform editor for the rest.
 * If the platform gives us nothing to edit, the opening frame is still sent
 * and edit() becomes a no-op, so the caller's closing message is the only
 * other thing the group sees.
 */
async function openTicker(ctx, text) {
  let sent = null
  try {
    if (ctx.platform === 'whatsapp' && ctx.sock?.sendMessage) {
      sent = await ctx.sock.sendMessage(ctx.sender, { text }, { quoted: ctx.msg })
      const key = sent?.key
      if (key) {
        return {
          edit: (next) =>
            ctx.sock.sendMessage(ctx.sender, { text: next, edit: key }).catch(() => {}),
        }
      }
    } else if (ctx.platform === 'discord' && ctx.discordMessage?.channel) {
      sent = await ctx.discordMessage.channel.send(text)
      if (typeof sent?.edit === 'function') {
        return { edit: (next) => sent.edit(next).catch(() => {}) }
      }
    } else if (ctx.platform === 'telegram' && ctx.bot?.api) {
      sent = await ctx.bot.api.sendMessage(ctx.sender, text)
      const id = sent?.message_id
      if (id) {
        return {
          edit: (next) =>
            ctx.bot.api.editMessageText(ctx.sender, id, next).catch(() => {}),
        }
      }
    }
  } catch {
    // Fall through to the plain-message path below.
  }
  if (!sent) await ctx.reply(text).catch(() => {})
  return { edit: async () => {} }
}

/** One frame of the live Aura ticker. */
function tickerFrame(elapsedMs, hpAtStart, maxHp) {
  const dealt = Math.min(hpAtStart, auraDamageAt(elapsedMs))
  const hp = Math.max(0, hpAtStart - dealt)
  const secs = Math.round(elapsedMs / 1000)
  const down = hp > 0 ? '' : '\n\n_You are on the floor. He is still looking._'
  return (
    `🩸 *THE AURA OF A GOD*\n` +
    `_Survive. That is all he asked for._\n\n` +
    `❤️ ${hpBar(hp, maxHp, BAR_WIDTH)}\n` +
    `🕳️ Aura damage: *${dealt}*\n` +
    `⏱️ ${secs}s / ${Math.round(AURA_DURATION_MS / 1000)}s${down}`
  )
}

function invitation(player) {
  const survives = (player.hp ?? 0) > AURA_TOTAL
  const verdict = survives
    ? `*You will survive this.*`
    : `*You will NOT survive this.* Heal to more than ${AURA_TOTAL} HP first.`
  const cap = levelsData.rebornLevelCap ?? 150

  return (
    `🌑 *THE UNBECOMING*\n\n` +
    `_You are unbecoming of what you once were._\n\n` +
    `_There is a light in the darkness ahead. You walk toward it because there is nothing left to walk back to, and when you are close enough to see properly, you understand that it was never a light. It is something like a god._\n\n` +
    `_It does not speak with a mouth. It reaches out and touches you with its consciousness, and your whole life answers at once._\n\n` +
    `*"You have come far."*\n\n` +
    `*"Let us see if you are strong enough to be reborn."*\n\n` +
    `${RULE}\n` +
    `🩸 *THE TRIAL OF THE AURA*\n` +
    `Survive *${Math.round(AURA_DURATION_MS / 1000)} seconds* inside a god's Aura.\n` +
    `Chip rate: *${AURA_CHIP} HP every ${Math.round(AURA_TICK_MS / 1000)} seconds*\n` +
    `Total damage: *${AURA_TOTAL} HP*\n\n` +
    `❤️ Your HP: ${player.hp}/${player.maxHp}\n` +
    `📊 Verdict: ${verdict}\n` +
    `${RULE}\n\n` +
    `🏆 *If he acknowledges you*\n` +
    `• Level ceiling rises from ${REBORN_REQ_LEVEL} to *${cap}*\n` +
    `• *+${REBORN_STAT_BONUS}* to STR, AGI, INT, DEF and LCK\n` +
    `• *+${REBORN_HP_BONUS}* max HP\n` +
    `• One of three divine relics, your pick\n\n` +
    `💀 *If the Aura empties you*\n` +
    `• Rejected for Reborn\n` +
    `• You lose *${REBORN_FAIL_LEVELS} levels* (${player.level} to ${Math.max(1, player.level - REBORN_FAIL_LEVELS)})\n\n` +
    `_Type *${config.prefix}reborn accept* to stand in front of it. Nothing is forcing you to._`
  )
}

function pickPrompt() {
  return (
    `🎁 *He leaves three things behind. Take one.*\n\n` +
    REBORN_CHOICES.map((c) => `*${c.n}.* ${c.name}`).join('\n') +
    `\n\n_Claim it with *${config.prefix}reborn pick 1*, *${config.prefix}reborn pick 2* or *${config.prefix}reborn pick 3*._\n` +
    `_They will wait. Take as long as you need._`
  )
}

/** Sends the three relic cards, then the pick prompt. */
async function showChoices(ctx) {
  for (const c of REBORN_CHOICES) {
    const caption =
      `🌟 *${c.n}. ${c.name}*\n\n` +
      `${c.blurb}\n\n` +
      (c.items.length > 1
        ? `📦 Grants: ${c.items.map(itemName).join(' + ')}`
        : `📦 Grants: ${itemName(c.items[0])}`)
    await ctx.replyImage(c.image, caption).catch(() => ctx.reply(caption).catch(() => {}))
  }
  await ctx.reply(pickPrompt()).catch(() => {})
}

function successMessage(before, after, player) {
  const capBefore = levelsData.maxStatPoints ?? 1500
  const rows = [
    ['💪 STR', before.str, after.str],
    ['🏃 AGI', before.agi, after.agi],
    ['🧠 INT', before.int, after.int],
    ['🛡️ DEF', before.def, after.def],
    ['🍀 LCK', before.lck, after.lck],
    ['❤️ Max HP', before.maxHp, after.maxHp],
  ]
  return (
    `⚡ *THE AURA WITHDRAWS.*\n\n` +
    `_You are still standing. You should not be, and he notices that you are._\n\n` +
    `_He reaches out a second time. This touch does not hurt._\n\n` +
    `*"You are strong enough."*\n\n` +
    `*"Be reborn."*\n\n` +
    `${RULE}\n` +
    `🌟 *REBORN*\n` +
    `📈 Level ceiling: ${REBORN_REQ_LEVEL} to *${playerLevelCap(player)}*\n` +
    rows.map(([label, b, a]) => `${label} ${b} to *${a}*`).join('\n') + '\n' +
    `✨ Stat point ceiling: ${capBefore} to *${playerMaxStatPoints(player)}*\n` +
    `❤️ Fully restored: ${player.hp}/${player.maxHp}\n` +
    `${RULE}`
  )
}

function failureMessage(result, player, capBefore) {
  return (
    `💀 *THE AURA TAKES YOU.*\n\n` +
    `_Your knees give out before your will does. The light does not dim. It simply stops being interested in you._\n\n` +
    `*"Not yet."*\n\n` +
    `_The touch leaves. What it takes with it is some of what you were._\n\n` +
    `${RULE}\n` +
    `❌ *REJECTED FOR REBORN*\n` +
    `📉 Level: ${result.from} to *${result.to}*\n` +
    `✨ Stat point ceiling: ${capBefore} to *${statPointCap(player.level, player)}*\n` +
    `❤️ HP: ${player.hp}/${player.maxHp}\n` +
    `${RULE}\n\n` +
    `_Climb back to ${REBORN_REQ_LEVEL} and stand in front of it again. It will not remember that you failed. You will._`
  )
}

/**
 * Applies a finished trial and reports it. Shared by the live path and the
 * interrupted-trial recovery path, so both produce identical outcomes.
 */
async function resolveAndReport(ctx, hpAtStart) {
  const capBefore = statPointCap(ctx.player.level, ctx.player)
  const outcome = resolveTrial(hpAtStart)
  let payload = null

  await updatePlayer(ctx.db, ctx.from, (p) => {
    if (outcome.survived) {
      const { before, after } = applyRebornSuccess(p)
      payload = { survived: true, before, after, snapshot: { ...p } }
    } else {
      const result = applyRebornFailure(p, levelsData, getTotalStats)
      payload = { survived: false, result, snapshot: { ...p } }
    }
    return p
  })

  if (!payload) return
  if (payload.survived) {
    await ctx.reply(successMessage(payload.before, payload.after, payload.snapshot))
    await showChoices(ctx)
  } else {
    await ctx.reply(failureMessage(payload.result, payload.snapshot, capBefore))
  }
}

/**
 * The gates every entry point shares. Returns a refusal string, or null when
 * the player may proceed.
 */
function blockedReason(player) {
  if (player.inBattle) {
    return (
      `❌ You are in the middle of a fight.\n` +
      `_A god will not queue behind a monster. Finish it first._`
    )
  }
  // Only `inDungeon` says where the player physically is. `dungeonFloor` is a
  // saved resume point that deliberately survives `dungeon leave` and `travel`
  // ("Progress saved at Floor N"), so a non-zero floor does NOT mean they are
  // underground — it only means they have somewhere to return to. Checking it
  // here locked every veteran out of the Unbecoming while standing in town.
  if (player.inDungeon) {
    return (
      `❌ You are still inside a dungeon.\n` +
      `_Walk out first. This does not happen underground._`
    )
  }
  return null
}

export default {
  name: 'reborn',
  aliases: ['unbecoming'],
  category: 'account',
  description: `${config.prefix}reborn - at Level ${REBORN_REQ_LEVEL}, survive a god's Aura for 30 seconds to raise your level ceiling to 200. Groups only.`,
  requiresPlayer: true,

  async run(ctx) {
    const { player, args } = ctx
    const p = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    if (!ctx.isGroup) {
      return ctx.reply(
        `${NOT_GROUP}\n\n_The Unbecoming is witnessed, not whispered. Run *${p}reborn* in a group._`,
      )
    }

    // A trial that is still running owns this player completely.
    if (trialIsLive(player)) return ctx.reply(AURA_LOCK_MSG)

    // A trial the process never finished (restart, crash, lost connection).
    // The maths is deterministic, so resolving it now gives exactly the
    // outcome the interrupted run would have produced.
    if (trialIsStale(player)) {
      const hpAtStart = player.reborn.trial.hpAtStart ?? player.hp
      await ctx.reply(
        `🩸 _Your trial was cut short by something outside the world. He finishes it now, from where you stood._`,
      )
      return resolveAndReport(ctx, hpAtStart)
    }

    // ── .reborn pick <n> ────────────────────────────────────────────────
    if (sub === 'pick' || sub === 'choose' || sub === 'claim') {
      if (!isReborn(player)) {
        return ctx.reply(`❌ You have nothing to claim. You have not been reborn.`)
      }
      if (!player.reborn?.pendingPick) {
        const taken = player.reborn?.pick
        const chosen = REBORN_CHOICES.find((c) => c.n === taken)
        return ctx.reply(
          `❌ You already made your choice: *${chosen?.name ?? 'your relic'}*.\n` +
          `_He only ever offered one._`,
        )
      }

      const n = Number.parseInt(args[1] ?? '', 10)
      const choice = REBORN_CHOICES.find((c) => c.n === n)
      if (!choice) {
        return ctx.reply(
          `❌ Pick one of the three.\n\n` +
          REBORN_CHOICES.map((c) => `*${c.n}.* ${c.name}`).join('\n') +
          `\n\nUsage: *${p}reborn pick 1*`,
        )
      }

      let granted = false
      await updatePlayer(ctx.db, ctx.from, (pl) => {
        // Re-check inside the write queue so two simultaneous picks cannot
        // both hand out a relic.
        if (!pl.reborn?.pendingPick) return pl
        pl.inventory = pl.inventory ?? []
        for (const id of choice.items) pl.inventory.push(id)
        pl.reborn.pendingPick = false
        pl.reborn.pick = choice.n
        pl.reborn.pickedAt = Date.now()
        granted = true
        return pl
      })

      if (!granted) {
        return ctx.reply(`❌ That choice was already made.`)
      }

      const equipLines = choice.items
        .map((id) => `⚔️ Equip it with *${p}equip ${itemName(id).toLowerCase()}*`)
        .join('\n')

      return ctx.reply(
        `🌟 *${choice.name}* is yours.\n\n` +
        `_He sets it into your hands and is gone. The darkness is only darkness again._\n\n` +
        `📜 ${choice.blurb}\n\n` +
        `🎒 Added to your inventory: ${choice.items.map(itemName).join(', ')}\n` +
        equipLines + `\n\n` +
        `_It will never break. Nothing he makes does._`,
      )
    }

    // ── .reborn status ──────────────────────────────────────────────────
    if (sub === 'status' || sub === 'info') {
      const attempts = player.reborn?.attempts ?? 0
      const fails = player.reborn?.fails ?? 0
      if (isReborn(player)) {
        const chosen = REBORN_CHOICES.find((c) => c.n === player.reborn?.pick)
        return ctx.reply(
          `🌟 *REBORN*\n\n` +
          `📈 Level: ${player.level} / *${playerLevelCap(player)}*\n` +
          `✨ Stat point ceiling: *${playerMaxStatPoints(player)}*\n` +
          `🎁 Relic: ${player.reborn?.pendingPick ? `_unclaimed, use ${p}reborn pick <1|2|3>_` : `*${chosen?.name ?? 'unknown'}*`}\n` +
          `🩸 Trials taken: ${attempts} (${fails} failed)`,
        )
      }
      return ctx.reply(
        `🌑 *NOT REBORN*\n\n` +
        `📈 Level: ${player.level} / *${playerLevelCap(player)}*\n` +
        `🩸 Trials taken: ${attempts} (${fails} failed)\n` +
        `❤️ HP: ${player.hp}/${player.maxHp}  (the Aura costs ${AURA_TOTAL})\n\n` +
        (player.level >= REBORN_REQ_LEVEL
          ? `_He is waiting. *${p}reborn*_`
          : `_Reach Level ${REBORN_REQ_LEVEL} and he will look at you._`),
      )
    }

    // Already reborn: nothing left but an unclaimed relic.
    if (isReborn(player)) {
      if (player.reborn?.pendingPick) {
        await ctx.reply(
          `🌟 _He is still holding three things out to you._\n\n` +
          `_You were already reborn. All that is left is to choose._`,
        )
        return showChoices(ctx)
      }
      const chosen = REBORN_CHOICES.find((c) => c.n === player.reborn?.pick)
      return ctx.reply(
        `🌟 *You have already been reborn.*\n\n` +
        `_He does not do this twice. What he gave you, you already carry._\n\n` +
        `📈 Level: ${player.level} / *${playerLevelCap(player)}*\n` +
        `🎁 Relic: *${chosen?.name ?? 'unknown'}*\n\n` +
        `_Use *${p}reborn status* to see the rest._`,
      )
    }

    if (player.level < REBORN_REQ_LEVEL) {
      return ctx.reply(
        `🌑 *The darkness stays empty.*\n\n` +
        `_There is no light, no god, nothing reaching for you. You are Level ${player.level}._\n\n` +
        `❌ The Unbecoming only opens at *Level ${REBORN_REQ_LEVEL}*.\n` +
        `_${REBORN_REQ_LEVEL - player.level} level${REBORN_REQ_LEVEL - player.level === 1 ? '' : 's'} left before he looks at you._`,
      )
    }

    const blocked = blockedReason(player)
    if (blocked) return ctx.reply(blocked)

    // ── .reborn accept ──────────────────────────────────────────────────
    if (sub === 'accept' || sub === 'yes' || sub === 'begin') {
      if (!offerIsOpen(player)) {
        return ctx.reply(
          `❌ He is not looking at you yet.\n` +
          `_Run *${p}reborn* first, then accept._`,
        )
      }

      // Stamp the trial inside the write queue. Two simultaneous accepts can
      // therefore never both start a trial.
      let started = false
      let hpAtStart = 0
      let maxHp = 0
      await updatePlayer(ctx.db, ctx.from, (pl) => {
        if (pl.reborn?.trial && Date.now() < (pl.reborn.trial.endsAt ?? 0)) return pl
        const now = Date.now()
        hpAtStart = pl.hp
        maxHp = pl.maxHp
        pl.reborn = {
          ...(pl.reborn ?? {}),
          trial: { startedAt: now, endsAt: now + AURA_DURATION_MS, hpAtStart: pl.hp, maxHp: pl.maxHp },
        }
        delete pl.reborn.offer
        started = true
        return pl
      })

      if (!started) return ctx.reply(AURA_LOCK_MSG)

      // The approach. Paced so the group reads it rather than scrolls past it.
      await ctx.reply(
        `🌫️ *He releases his Aura.*\n\n` +
        `_The air stops being air. It becomes weight, and the weight has a will, and the will has decided to look directly at you._`,
      ).catch(() => {})
      await sleep(2500)
      await ctx.reply(
        `🩸 _Your skin remembers every wound it has ever taken. Your bones want to lie down. He is not attacking you. He is simply existing nearby, and existing nearby him is enough to kill._`,
      ).catch(() => {})
      await sleep(2500)
      await ctx.reply(
        `⏳ *Hold.*\n_Thirty seconds. That is the whole of what he is asking for._`,
      ).catch(() => {})
      await sleep(1500)

      // One message, edited on every tick.
      const ticker = await openTicker(ctx, tickerFrame(0, hpAtStart, maxHp))
      const fullTicks = Math.floor(AURA_DURATION_MS / AURA_TICK_MS)
      for (let i = 1; i <= fullTicks; i++) {
        await sleep(AURA_TICK_MS)
        await ticker.edit(tickerFrame(i * AURA_TICK_MS, hpAtStart, maxHp))
      }
      const tail = AURA_DURATION_MS - fullTicks * AURA_TICK_MS
      if (tail > 0) {
        await sleep(tail)
        await ticker.edit(tickerFrame(AURA_DURATION_MS, hpAtStart, maxHp))
      }

      return resolveAndReport(ctx, hpAtStart)
    }

    // ── .reborn (the invitation) ────────────────────────────────────────
    await updatePlayer(ctx.db, ctx.from, (pl) => {
      pl.reborn = {
        ...(pl.reborn ?? {}),
        offer: { at: Date.now(), expiresAt: Date.now() + REBORN_OFFER_TTL_MS },
      }
      return pl
    })

    return ctx.reply(invitation(player))
  },
}
