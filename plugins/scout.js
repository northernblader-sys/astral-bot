/**
 * scout.js — read a fighter before you commit to a duel.
 *
 * The problem this solves: `.pvp @someone` spends one of your daily challenge
 * slots and locks you both into a turn loop, with no way to find out first
 * whether it's a fight or a mugging. Scouting is free, costs no slot, and
 * needs no consent from the target — you're sizing someone up in a public
 * town square, not reading their private data.
 *
 * The numbers are REAL, not an approximation: offenseAgainst() in
 * lib/pvp-engine.js runs the same applyDefense() and calcPlayerHitChance()
 * that plugins/pvp.js will use when the blows actually land. Crit is folded
 * in as expected value rather than rolled, so the report is the average case.
 * A scout that lied would be worse than no scout at all.
 *
 * Usage:
 *   <prefix>scout @user   — full matchup read
 *   <prefix>scout         — your own combat card
 */
import { config } from '../config.js'
import { getPlayer, playerExists } from '../lib/player-repo.js'
import { classes, races } from '../lib/game-data.js'
import { getPrimaryStat } from '../lib/combat-engine.js'
import { getEffectiveStat } from '../lib/effects.js'
import {
  ensurePvp, matchup, powerScore, rankFor, ratingOf, winRate,
  streakLabel, duelsPlayed, isProvisional, EDGE_LINE, effectLine,
} from '../lib/pvp-engine.js'

function resolveTargetJid(ctx, raw) {
  const contextInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo
  if (contextInfo?.participant) return contextInfo.participant
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0]
  if (!raw) return null
  const digits = String(raw).replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

/** classes/races are keyed objects in lib/game-data.js, not arrays. */
function classLabel(player) {
  const clsName = classes[player.classId]?.name ?? player.classId ?? 'Adventurer'
  const raceName = races[player.raceId]?.name ?? player.raceId ?? ''
  return raceName ? `${raceName} ${clsName}` : clsName
}

/** The self-view — no opponent, just your own numbers laid out plainly. */
function ownCard(ctx) {
  const p = config.prefix
  const me = ctx.player
  ensurePvp(me)
  const band = rankFor(me)

  return ctx.reply(
    `🔍 *YOUR COMBAT CARD*\n\n` +
    `*${me.name}*  Lv.${me.level}\n` +
    `${classLabel(me)}\n\n` +
    `⚔️ Attack power: *${getPrimaryStat(me)}*\n` +
    `🛡️ Defense: *${getEffectiveStat(me, 'def')}*\n` +
    `❤️ HP: *${me.hp}/${me.maxHp}*   💧 MP: *${me.mp}/${me.maxMp}*\n` +
    `📊 Power score: *${powerScore(me).toLocaleString()}*\n\n` +
    `${band.emoji} *${band.name}*  ·  ${ratingOf(me)} rating\n` +
    `🥊 ${me.pvp.wins}W ${me.pvp.losses}L  _(${winRate(me)}% over ${duelsPlayed(me)})_  ·  streak ${streakLabel(me)}\n\n` +
    `_*${p}scout @user* to size someone up before challenging them._`,
  )
}

export default {
  name: 'scout',
  aliases: ['matchup', 'sizeup'],
  category: 'pvp',
  requiresPlayer: true,
  description: 'Size up another fighter before you duel them — free, costs no duel slot',
  subcommands: [
    { cmd: '@user', desc: 'full matchup: damage both ways and who wins the race' },
    { cmd: '(alone)', desc: 'your own combat card' },
  ],

  async run(ctx) {
    const p = config.prefix
    const targetJid = resolveTargetJid(ctx, ctx.args[0])
    if (!targetJid) return ownCard(ctx)
    if (targetJid === ctx.from) return ownCard(ctx)
    if (!playerExists(ctx.db, targetJid)) {
      return ctx.reply(`❌ That player isn't registered yet.`)
    }

    const me = ctx.player
    const them = getPlayer(ctx.db, targetJid)
    ensurePvp(me)
    ensurePvp(them)

    const read = matchup(me, them)
    const myBand = rankFor(me)
    const theirBand = rankFor(them)

    const busy = them.inBattle
      ? `\n⚔️ _They're already in a battle right now._`
      : them.inDungeon
        ? `\n🗺️ _They're deep in a dungeon right now._`
        : ''

    const theirEffects = effectLine(them)
    const effectsLine = theirEffects ? `\n🌀 _Currently affected by: ${theirEffects}_` : ''

    // Power gap as a percentage reads better than two raw scores side by
    // side — "18% behind" lands where "4,210 vs 5,140" doesn't.
    const gap = read.powerThem
      ? Math.round(((read.powerYou - read.powerThem) / read.powerThem) * 100)
      : 0
    const gapLine = gap === 0
      ? 'evenly matched on paper'
      : gap > 0 ? `you're *${gap}%* ahead on paper` : `you're *${Math.abs(gap)}%* behind on paper`

    return ctx.reply(
      `🔍 *SCOUTING REPORT*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `*${them.name}*  Lv.${them.level}\n` +
      `${classLabel(them)}\n` +
      `${theirBand.emoji} ${theirBand.name} · ${ratingOf(them)} rating` +
      (isProvisional(them) ? ` _(unplaced)_` : '') + `\n` +
      `🥊 ${them.pvp.wins}W ${them.pvp.losses}L · streak ${streakLabel(them)}\n` +
      busy + effectsLine + `\n\n` +

      `*THEIR NUMBERS*\n` +
      `⚔️ Attack ${getPrimaryStat(them)}  ·  🛡️ Def ${getEffectiveStat(them, 'def')}\n` +
      `❤️ ${them.hp}/${them.maxHp} HP  ·  💧 ${them.mp}/${them.maxMp} MP\n\n` +

      `*THE TRADE*  _(basic attacks, average case)_\n` +
      `➡️ You hit for *${read.yours.perHit}* at *${Math.round(read.yours.hitChance * 100)}%* accuracy\n` +
      `   → *${read.yours.turnsToKill}* turn(s) to put them down\n` +
      `⬅️ They hit for *${read.theirs.perHit}* at *${Math.round(read.theirs.hitChance * 100)}%* accuracy\n` +
      `   → *${read.theirs.turnsToKill}* turn(s) to put you down\n\n` +

      `${EDGE_LINE[read.edge]}\n` +
      `📊 Power ${read.powerYou.toLocaleString()} vs ${read.powerThem.toLocaleString()} — ${gapLine}.\n` +
      `🎲 Rating gives you *${read.ratingOdds}%* odds.\n\n` +

      `_The challenger moves first — on an even read, that's the whole match._\n` +
      `${myBand.emoji} You: ${ratingOf(me)} · ${me.pvp.wins}W ${me.pvp.losses}L\n\n` +
      `_Reply to their message with *${p}pvp* to throw down._`,
    )
  },
}
