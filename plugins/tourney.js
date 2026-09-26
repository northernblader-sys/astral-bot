/**
 * tourney.js — group-wide PvP bracket tournaments.
 *
 * One tournament can be running per group at a time (see lib/tourney-repo.js,
 * keyed by groupJid). Admin creates it, players join with an entry fee,
 * admin starts it (random shuffle → bracket), and from then on paired
 * players just run the normal `.pvp @opponent` duel — plugins/pvp.js
 * detects the pairing via findActiveMatchFor() and tags/advances the
 * bracket on conclusion instead of running its usual solars-transfer
 * victory line. See the hook block near the top of pvpConclude() in
 * plugins/pvp.js.
 *
 * Usage:
 *   <prefix>tourney create <name> | <feeCurrency> | <fee> | <6|8> | <prizeCurrency> | <prize1st> | <prize2nd>
 *   <prefix>tourney join
 *   <prefix>tourney leave              — leave your own open-tourney spot
 *   <prefix>tourney kick @player        — (admin) remove a player, open or active
 *   <prefix>tourney start               — (admin) shuffle + build bracket
 *   <prefix>tourney bracket             — view the current bracket board
 *   <prefix>tourney title <name>        — (admin) rename the running tournament
 *   <prefix>tourney cancel              — (admin) cancel + refund everyone
 *
 * Entry fee and prize money are fully independent. The entry fee is just
 * a cost to join — it's deducted from the joiner's wallet and discarded;
 * it does NOT fund the prize pool. Prize amounts (prize1st/prize2nd) and
 * prize currency are set directly by the admin at creation time and are
 * paid out in full to the champion/runner-up regardless of how many
 * players joined or what currency the entry fee used.
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer, playerExists } from '../lib/player-repo.js'
import { NOT_GROUP, extractTarget, isOwnerJid } from '../lib/group-helpers.js'
import {
  getTourney,
  hasOpenTourney,
  hasActiveTourney,
  isValidBracketSize,
  createTourney,
  joinTourney,
  isJoined,
  kickFromOpenTourney,
  kickFromActiveTourney,
  startTourney,
  cancelTourney,
} from '../lib/tourney-repo.js'
import { renderBracketImage } from '../lib/tourney-bracket-render.mjs'

const CURRENCY_EMOJI = { solars: '☀️', gems: '💎' }

// The tournament is realm-wide: ONE bracket shared across every group, not one
// per group. All tourney commands operate on this single fixed key instead of
// ctx.sender, so `.tourney join` / `bracket` / `start` hit the same tournament
// no matter which group they're typed in. findActiveMatchFor() in
// tourney-repo.js already scans every stored key, so two paired players can
// duel in any group they share and the result resolves into this bracket.
const GLOBAL_TOURNEY_KEY = '__global_tourney__'

// Managing the one shared bracket is owner-only: otherwise any admin of any
// group could cancel/kick/rename a tournament that players from other groups
// joined. Player actions (join / leave / bracket) stay open to everyone.
const OWNER_ONLY = '❌ Only the bot owner can manage the global tournament.'

function resolveTargetJid(ctx, raw) {
  const target = extractTarget(ctx)
  if (target) return target
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

export default {
  name: 'tourney',
  aliases: ['tournament', 'tourny'],
  category: 'pvp',
  requiresPlayer: true,
  description: `${config.prefix}tourney create|join|leave|kick|start|bracket|title|cancel — PvP bracket tournaments`,

  async run(ctx) {
    const { player, args, db } = ctx
    const pr = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    if (!ctx.isGroup) return ctx.reply(NOT_GROUP)
    // One realm-wide bracket, keyed globally rather than by ctx.sender — every
    // group reaches the same tournament (see GLOBAL_TOURNEY_KEY above).
    const groupJid = GLOBAL_TOURNEY_KEY

    // ── CREATE (admin only) ─────────────────────────────────────────────
    if (sub === 'create') {
      if (!isOwnerJid(ctx.from)) return ctx.reply(OWNER_ONLY)
      if (hasOpenTourney(db, groupJid) || hasActiveTourney(db, groupJid)) {
        return ctx.reply(`❌ A global tournament is already running. Use *${pr}tourney cancel* first if you want to replace it.`)
      }

      // Everything after "create" is one pipe-delimited string:
      // name | feeCurrency | fee | 6|8 | prizeCurrency | prize1st | prize2nd
      const raw = args.slice(1).join(' ')
      const parts = raw.split('|').map(s => s.trim()).filter(Boolean)
      if (parts.length < 7) {
        return ctx.reply(
          `❓ Usage:\n*${pr}tourney create <name> | <solars|gems> | <entryFee> | <6|8> | <solars|gems> | <prize1st> | <prize2nd>*\n\n` +
          `_Entry fee and prize money are separate — the fee just costs to join, the prize is paid out on top of that regardless._\n\n` +
          `_Example:_ ${pr}tourney create Astral Cup | solars | 500 | 8 | gems | 200 | 80`,
        )
      }

      const [name, currencyRaw, feeRaw, sizeRaw, prizeCurrencyRaw, prize1stRaw, prize2ndRaw] = parts
      const currency = currencyRaw.toLowerCase()
      const entryFee = Math.floor(Number(feeRaw))
      const maxPlayers = Math.floor(Number(sizeRaw))
      const prizeCurrency = prizeCurrencyRaw.toLowerCase()
      const prize1st = Math.floor(Number(prize1stRaw))
      const prize2nd = Math.floor(Number(prize2ndRaw))

      if (currency !== 'solars' && currency !== 'gems') {
        return ctx.reply(`❌ Entry fee currency must be *solars* or *gems*.`)
      }
      if (!entryFee || entryFee <= 0) {
        return ctx.reply(`❌ Entry fee must be a positive number.`)
      }
      if (!isValidBracketSize(maxPlayers)) {
        return ctx.reply(`❌ Bracket size must be *6* or *8* players.`)
      }
      if (prizeCurrency !== 'solars' && prizeCurrency !== 'gems') {
        return ctx.reply(`❌ Prize currency must be *solars* or *gems*.`)
      }
      if (!prize1st || prize1st <= 0) {
        return ctx.reply(`❌ 1st place prize must be a positive number.`)
      }
      if (prize2nd < 0) {
        return ctx.reply(`❌ 2nd place prize can't be negative.`)
      }

      await createTourney(db, groupJid, {
        name, currency, entryFee, maxPlayers,
        prizeCurrency, prize1st, prize2nd,
        createdBy: ctx.from,
      })

      return ctx.reply(
        `🏆 *${name}* tournament created!\n\n` +
        `💰 Entry fee: *${entryFee} ${CURRENCY_EMOJI[currency]}*\n` +
        `👥 Bracket size: *${maxPlayers} players*\n` +
        `🥇 1st prize: *${prize1st} ${CURRENCY_EMOJI[prizeCurrency]}*\n` +
        `🥈 2nd prize: *${prize2nd} ${CURRENCY_EMOJI[prizeCurrency]}*\n\n` +
        `Players, join with *${pr}tourney join*!`,
      )
    }

    // ── TITLE / RENAME (admin only) ──────────────────────────────────────
    if (sub === 'title' || sub === 'rename') {
      if (!isOwnerJid(ctx.from)) return ctx.reply(OWNER_ONLY)
      const t = getTourney(db, groupJid)
      if (!t || (t.status !== 'open' && t.status !== 'active')) {
        return ctx.reply(`❌ There's no open or active tournament to rename.`)
      }

      const newName = args.slice(1).join(' ').trim()
      if (!newName) {
        return ctx.reply(`❓ Usage: *${pr}tourney title <new name>*`)
      }

      const oldName = t.name
      t.name = newName
      await db.write()

      return ctx.reply(`✏️ Tournament renamed: *${oldName}* → *${newName}*`)
    }

    // ── JOIN ─────────────────────────────────────────────────────────────
    if (sub === 'join') {
      const t = getTourney(db, groupJid)
      if (!t || t.status !== 'open') {
        return ctx.reply(`❌ There's no tournament open for joining right now.`)
      }
      if (isJoined(db, groupJid, ctx.from)) {
        return ctx.reply(`❌ You're already in *${t.name}*.`)
      }
      if (t.players.length >= t.maxPlayers) {
        return ctx.reply(`❌ *${t.name}* is already full (${t.maxPlayers}/${t.maxPlayers}).`)
      }

      const wallet = player.wallet ?? {}
      if ((wallet[t.currency] ?? 0) < t.entryFee) {
        return ctx.reply(`❌ You need *${t.entryFee} ${CURRENCY_EMOJI[t.currency]}* to join — you have *${wallet[t.currency] ?? 0}*.`)
      }

      // Deduct fee first, then register the joiner — mirrors shop.js's
      // "pay, then grant" ordering so a mid-flight failure never leaves
      // someone registered without having actually paid.
      await updatePlayer(db, ctx.from, (p) => {
        p.wallet = p.wallet ?? {}
        p.wallet[t.currency] -= t.entryFee
      })
      const joined = await joinTourney(db, groupJid, ctx.from, player.name)
      if (!joined) {
        // Lost a join-full race — refund immediately.
        await updatePlayer(db, ctx.from, (p) => {
          p.wallet = p.wallet ?? {}
          p.wallet[t.currency] = (p.wallet[t.currency] ?? 0) + t.entryFee
        })
        return ctx.reply(`❌ *${t.name}* just filled up — your fee was refunded.`)
      }

      return ctx.reply(
        `✅ *${player.name}* joined *${t.name}*! (${joined.players.length}/${t.maxPlayers})\n` +
        (joined.players.length >= t.maxPlayers
          ? `\n🔥 Bracket is full! The owner can now run *${pr}tourney start*.`
          : ''),
      )
    }

    // ── LEAVE (self, open phase only) ───────────────────────────────────
    if (sub === 'leave') {
      const t = getTourney(db, groupJid)
      if (!t || t.status !== 'open') {
        return ctx.reply(`❌ You can only leave during the open join phase. Ask the owner for *${pr}tourney cancel* if the bracket already started.`)
      }
      const result = await kickFromOpenTourney(db, groupJid, ctx.from)
      if (!result) return ctx.reply(`❌ You're not in *${t.name}*.`)

      await updatePlayer(db, ctx.from, (p) => {
        p.wallet = p.wallet ?? {}
        p.wallet[t.currency] = (p.wallet[t.currency] ?? 0) + result.refund
      })
      return ctx.reply(`👋 You left *${t.name}* — *${result.refund} ${CURRENCY_EMOJI[t.currency]}* refunded.`)
    }

    // ── KICK (admin only, open or active) ───────────────────────────────
    if (sub === 'kick') {
      if (!isOwnerJid(ctx.from)) return ctx.reply(OWNER_ONLY)
      const t = getTourney(db, groupJid)
      if (!t || (t.status !== 'open' && t.status !== 'active')) {
        return ctx.reply(`❌ There's no open or active tournament to kick someone from.`)
      }

      const targetJid = resolveTargetJid(ctx, args[1])
      if (!targetJid) {
        return ctx.reply(`❓ Usage: *${pr}tourney kick @player* — reply to or @mention who to remove.`)
      }

      const targetName = playerExists(db, targetJid) ? getPlayer(db, targetJid).name : 'That player'

      if (t.status === 'open') {
        const result = await kickFromOpenTourney(db, groupJid, targetJid)
        if (!result) return ctx.reply(`❌ ${targetName} isn't in *${t.name}*.`)
        if (playerExists(db, targetJid)) {
          await updatePlayer(db, targetJid, (p) => {
            p.wallet = p.wallet ?? {}
            p.wallet[t.currency] = (p.wallet[t.currency] ?? 0) + result.refund
          })
        }
        return ctx.reply(`🚫 Removed *${targetName}* from *${t.name}* — *${result.refund} ${CURRENCY_EMOJI[t.currency]}* refunded. (${result.tourney.players.length}/${t.maxPlayers})`)
      }

      // status === 'active' — force a loss in their current match, if any,
      // so the bracket cascades exactly like a real duel loss would.
      const result = await kickFromActiveTourney(db, groupJid, targetJid)
      if (!result) return ctx.reply(`❌ There's no active tournament to kick someone from.`)
      if (!result.matchForfeited) {
        return ctx.reply(`🚫 *${targetName}* was removed from *${t.name}*, but had no live match this round to forfeit (already eliminated or awaiting a bye).`)
      }

      const opponentName = playerExists(db, result.opponentJid) ? getPlayer(db, result.opponentJid).name : 'their opponent'

      if (result.finished) {
        return finishTourney(ctx, db, groupJid, result.tourney, result.championJid, result.runnerUpJid,
          `_${targetName} was kicked and forfeits the final to ${opponentName}!_`)
      }

      return ctx.reply(
        `🚫 *${targetName}* was kicked from *${t.name}* — their match is forfeited.\n` +
        `➡️ *${opponentName}* advances to the next round!`,
      )
    }

    // ── START (admin only) ──────────────────────────────────────────────
    if (sub === 'start') {
      if (!isOwnerJid(ctx.from)) return ctx.reply(OWNER_ONLY)
      const t = getTourney(db, groupJid)
      if (!t || t.status !== 'open') {
        return ctx.reply(`❌ There's no open tournament ready to start.`)
      }
      if (t.players.length < 2) {
        return ctx.reply(`❌ Need at least 2 players joined to start (currently ${t.players.length}).`)
      }

      const started = await startTourney(db, groupJid)
      const board = await renderBracketImage(started)
      return ctx.replyImage(
        board,
        `🔥 *${started.name}* has begun! Bracket shuffled and locked in.\n\n` +
        `_Paired players: just run *${pr}pvp @opponent* like a normal duel — the tournament tracks the result automatically._`,
      )
    }

    // ── BRACKET (view) ──────────────────────────────────────────────────
    if (sub === 'bracket' || sub === 'board') {
      const t = getTourney(db, groupJid)
      if (!t) return ctx.reply(`❌ No global tournament has been created yet. _${pr}tourney create_`)
      if (t.status === 'open') {
        return ctx.reply(
          `🏆 *${t.name}* — OPEN FOR JOINING\n` +
          `👥 ${t.players.length}/${t.maxPlayers} joined\n` +
          (t.players.length ? t.players.map(p => `  • ${p.name}`).join('\n') + '\n' : '') +
          `💰 Entry: *${t.entryFee} ${CURRENCY_EMOJI[t.currency]}*`,
        )
      }
      const board = await renderBracketImage(t)
      return ctx.replyImage(board, `🏆 *${t.name}* — bracket board`)
    }

    // ── CANCEL (admin only) ──────────────────────────────────────────────
    if (sub === 'cancel') {
      if (!isOwnerJid(ctx.from)) return ctx.reply(OWNER_ONLY)
      const t = getTourney(db, groupJid)
      if (!t || t.status === 'done' || t.status === 'cancelled') {
        return ctx.reply(`❌ There's no active or open tournament to cancel.`)
      }

      // Refund everyone who joined (open phase) — for an already-started
      // bracket, refund every player who hasn't been eliminated is overkill
      // to compute precisely, so refund the full original roster instead;
      // simplest fair rule for an admin-initiated cancel.
      for (const p of t.players) {
        if (!playerExists(db, p.jid)) continue
        await updatePlayer(db, p.jid, (pl) => {
          pl.wallet = pl.wallet ?? {}
          pl.wallet[t.currency] = (pl.wallet[t.currency] ?? 0) + t.entryFee
        })
      }

      await cancelTourney(db, groupJid)
      return ctx.reply(`🚫 *${t.name}* cancelled — all ${t.players.length} entry fees refunded.`)
    }

    return ctx.reply(
      `❓ *Tournament commands:*\n` +
      `${pr}tourney create <name> | <solars|gems> | <fee> | <6|8> | <solars|gems> | <prize1st> | <prize2nd>\n` +
      `${pr}tourney join\n` +
      `${pr}tourney leave\n` +
      `${pr}tourney kick @player\n` +
      `${pr}tourney start\n` +
      `${pr}tourney bracket\n` +
      `${pr}tourney title <new name>\n` +
      `${pr}tourney cancel`,
    )
  },
}

/**
 * finishTourney — pays out the fixed prize1st/prize2nd amounts (set at
 * creation, in prizeCurrency — fully independent of the entry fee/currency),
 * tags both finalists with a title, and announces the champion. Shared by
 * both the kick-forfeit path above and the normal .pvp-conclusion hook in
 * plugins/pvp.js (imported from there as finishTourney too), so a
 * tournament always ends the same way no matter how the final match was
 * resolved.
 */
export async function finishTourney(ctx, db, groupJid, tourney, championJid, runnerUpJid, reasonLine) {
  const firstPrize = tourney.prize1st
  const secondPrize = tourney.prize2nd
  const emoji = CURRENCY_EMOJI[tourney.prizeCurrency]

  let championName = ''
  let runnerUpName = ''

  if (playerExists(db, championJid)) {
    await updatePlayer(db, championJid, (p) => {
      championName = p.name
      p.wallet = p.wallet ?? {}
      p.wallet[tourney.prizeCurrency] = (p.wallet[tourney.prizeCurrency] ?? 0) + firstPrize
      p.title = `${tourney.name} Champion`
      p.tourneyTitles = p.tourneyTitles ?? []
      p.tourneyTitles.push({ tourneyName: tourney.name, placement: 1, wonAt: Date.now() })
    })
  }

  if (runnerUpJid && playerExists(db, runnerUpJid)) {
    await updatePlayer(db, runnerUpJid, (p) => {
      runnerUpName = p.name
      p.wallet = p.wallet ?? {}
      p.wallet[tourney.prizeCurrency] = (p.wallet[tourney.prizeCurrency] ?? 0) + secondPrize
      p.tourneyTitles = p.tourneyTitles ?? []
      p.tourneyTitles.push({ tourneyName: tourney.name, placement: 2, wonAt: Date.now() })
    })
  }

  const board = await renderBracketImage(tourney)
  return ctx.replyImage(
    board,
    `🏆🔥 *${tourney.name.toUpperCase()} — TOURNAMENT OVER!* 🔥🏆\n\n` +
    (reasonLine ? `${reasonLine}\n\n` : '') +
    `👑 *CHAMPION: ${championName.toUpperCase()}!* 👑\n` +
    `🥇 +${firstPrize} ${emoji} · new title: *"${tourney.name} Champion"*\n\n` +
    (runnerUpName
      ? `🥈 Runner-up: *${runnerUpName}* — +${secondPrize} ${emoji}\n\n`
      : '') +
    `_Start a new one anytime with *${config.prefix}tourney create*._`,
  )
}
