/**
 * board.js — the guild job board.
 *
 *   .board                 today's three slips, and the one in your hand
 *   .board take <id>       pull a slip (needs a guild)
 *   .board turnin          pin a finished slip and get paid
 *   .board abandon         put it back
 *   .board track           step by step
 *   .board guide [id]      how to finish it
 *   .board log             what you have pinned, ever
 *
 * .guild board lands here too. Motd shares this command. It is not a second board.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getGuildDef, getGuildRecord } from '../lib/guild-repo.js'
import {
  takeSlip, abandonSlip, turnIn, guideText, trackView, logView, boardView,
  findSlip, postedIds, ensureBoardState, stepLabel, TURNIN_CAP,
} from '../lib/guild-board.js'

function hallLine(ctx) {
  const id = ctx.player?.guildId
  if (!id) return { motd: '', hall: '' }
  const def = getGuildDef(id)
  const record = getGuildRecord(ctx.db, id)
  const hall = def ? `You are sworn to ${def.emoji} ${def.name}. The slips do not care which banner.` : ''
  return { motd: record?.motd ?? '', hall }
}

export async function runBoard(ctx, args = ctx.args ?? []) {
  const p = config.prefix
  const sub = (args[0] ?? '').toLowerCase()
  const rest = args.slice(1).join(' ').trim()

  if (sub === 'track' || sub === 'progress' || sub === 'status') {
    let text = ''
    await updatePlayer(ctx.db, ctx.from, player => {
      text = trackView(player, p)
      return player
    })
    return ctx.reply(text)
  }

  if (sub === 'log' || sub === 'history') {
    let text = ''
    await updatePlayer(ctx.db, ctx.from, player => {
      text = logView(player, p)
      return player
    })
    return ctx.reply(text)
  }

  if (sub === 'guide' || sub === 'how' || sub === 'help') {
    let text = ''
    await updatePlayer(ctx.db, ctx.from, player => {
      const state = ensureBoardState(player)
      const query = rest || state.activeId
      if (!query) {
        text = `📜 *Which slip?*\n\n_Take one, or name a posted id. *${p}board* shows today's three._`
        return player
      }
      const found = findSlip(query)
      if (!found || Array.isArray(found)) {
        text = `❌ No slip called *${query}*.\n_Posted ids are on *${p}board*._`
        return player
      }
      const posted = postedIds(state.day)
      if (found.id !== state.activeId && !posted.includes(found.id)) {
        text = `📌 *${found.name}* is not on the board today.\n_Sera only explains what is nailed up._`
        return player
      }
      text = guideText(found, p)
      return player
    })
    return ctx.reply(text)
  }

  if (sub === 'take' || sub === 'accept' || sub === 'pull') {
    if (!rest) return ctx.reply(`❓ *Usage:* *${p}board take <id>*\n_The ids are on *${p}board*._`)
    let outcome = null
    await updatePlayer(ctx.db, ctx.from, player => {
      outcome = takeSlip(player, rest)
      return player
    })
    if (!outcome.ok && outcome.reason === 'unknown') {
      return ctx.reply(`❌ No slip called *${rest}*.\n_Look at *${p}board*._`)
    }
    if (!outcome.ok && outcome.reason === 'many') {
      const list = outcome.matches.map(s => `  • \`${s.id}\` ${s.name}`).join('\n')
      return ctx.reply(`❓ More than one slip matches.\n${list}`)
    }
    if (!outcome.ok && outcome.reason === 'notposted') {
      return ctx.reply(`📌 *${outcome.slip.name}* is not nailed up today.\n_The board shows three. That is the list._`)
    }
    if (!outcome.ok && outcome.reason === 'level') {
      return ctx.reply(`🔒 *${outcome.slip.name}* needs level *${outcome.slip.minLevel}*. You are *${ctx.player?.level ?? 1}*.`)
    }
    if (!outcome.ok && outcome.reason === 'noguild') {
      return ctx.reply(
        `🏰 *The board is public. The slip is not.*\n\n` +
        `_Swear to a hall first, then pull it._\n` +
        `*${p}guild*  ·  *${p}guild join <name>*`,
      )
    }
    if (!outcome.ok && outcome.reason === 'cap') {
      return ctx.reply(`📜 *The hall is done with you today.*\n_${TURNIN_CAP} slips pinned. Come back after midnight._`)
    }
    if (!outcome.ok && outcome.reason === 'done') {
      return ctx.reply(`☑️ You already pinned *${outcome.slip.name}* today.`)
    }
    if (!outcome.ok && outcome.reason === 'busy') {
      return ctx.reply(
        `✋ You already hold *${outcome.active?.name ?? 'a slip'}*.\n` +
        `*${p}board abandon* to put it back, or finish it.`,
      )
    }
    const slip = outcome.slip
    return ctx.reply(
      `✋ *Slip taken:* ${slip.name}\n\n` +
      `_${slip.summary}_\n\n` +
      (outcome.ready
        ? `🎁 It was already done from where you stood. *${p}board turnin*`
        : `*${p}board guide* tells you the steps.\n*${p}board track* shows where you are.`) +
      `\n\n_One slip at a time. It comes down at midnight if you do not pin it._`,
    )
  }

  if (sub === 'abandon' || sub === 'drop' || sub === 'cancel') {
    let outcome = null
    await updatePlayer(ctx.db, ctx.from, player => {
      outcome = abandonSlip(player)
      return player
    })
    if (!outcome.ok) return ctx.reply(`📜 You are not holding a slip.`)
    return ctx.reply(`📌 *${outcome.slip?.name ?? 'The slip'}* goes back on the nail.\n_No pay. The slot is free._`)
  }

  if (sub === 'turnin' || sub === 'complete' || sub === 'pin' || sub === 'claim') {
    let outcome = null
    await updatePlayer(ctx.db, ctx.from, player => {
      outcome = turnIn(player)
      return player
    })
    if (!outcome.ok && outcome.reason === 'none') {
      return ctx.reply(`📜 *Nothing to pin.*\n_Take a slip with *${p}board take*._`)
    }
    if (!outcome.ok && outcome.reason === 'notready') {
      return ctx.reply(
        `▶️ *${outcome.slip.name}* is not finished.\n` +
        `_${outcome.step ? `Still to do: ${stepLabel(outcome.step)}` : 'Keep going.'}_\n` +
        `*${p}board track*`,
      )
    }
    if (!outcome.ok && outcome.reason === 'cap') {
      return ctx.reply(`📜 You have already pinned ${TURNIN_CAP} slips today.`)
    }
    const bits = [`☀️ *${outcome.solars}* Solars`, `🌟 *${outcome.fame}* fame`]
    if (outcome.gems) bits.push(`💎 *${outcome.gems}* Gem`)
    return ctx.reply(
      `🎁 *SLIP PINNED*\n\n` +
      `*${outcome.slip.name}*\n` +
      bits.join('  ·  ') +
      (outcome.gemSkipped ? `\n_The hall already paid a Gem today. This one pays coin and fame._` : '') +
      `\n\n_The treasury did not see this. It is yours._\n` +
      `*${p}board* for what is left on the nail.`,
    )
  }

  let text = ''
  await updatePlayer(ctx.db, ctx.from, player => {
    text = boardView(player, p, hallLine({ ...ctx, player }))
    return player
  })
  return ctx.reply(text)
}

export default {
  name: 'board',
  aliases: ['noticeboard', 'slips', 'guildboard'],
  category: 'town',
  requiresPlayer: true,
  description: 'The guild job board: three slips a day, one in your hand',
  subcommands: [
    { cmd: 'take <id>', desc: 'pull a posted slip (needs a guild)' },
    { cmd: 'track', desc: 'step by step on the slip in your hand' },
    { cmd: 'guide [id]', desc: 'how to finish a posted slip' },
    { cmd: 'turnin', desc: 'pin a finished slip and get paid' },
    { cmd: 'abandon', desc: 'put the slip back on the nail' },
    { cmd: 'log', desc: 'every slip you have pinned' },
  ],

  async run(ctx) {
    return runBoard(ctx, ctx.args ?? [])
  },
}

