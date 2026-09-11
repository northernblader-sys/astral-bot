/**
 * plugins/empire-top.js: bot-wide Empire leaderboards (read-only).
 *
 *   .empire-top [n]                 strongest empires by overall power
 *   .army-top [n] / .soldier-top    the strongest named officers anywhere
 *
 * Pure reads: this plugin never writes a player, never mutates an empire, and
 * never broadcasts. It only reads db.data.empires and resolves owner display
 * names from db.data.users. Boards are capped so a huge server can't produce a
 * giant message.
 */
import { config } from '../config.js'
import { getGroupSettings } from '../lib/group-settings.js'
import { ensureEmpiresInitialized } from '../lib/empire-repo.js'
import { empireScore, armyPower, tierOf, soldierPowerOf, rankMap } from '../lib/empire-engine.js'

const RULE = '━━━━━━━━━━━━━━━━━━━━'
const MAX_ROWS = 25
const DEFAULT_ROWS = 10

function medal(i) {
  return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`
}

function ownerName(users, ownerId) {
  return users?.[ownerId]?.name || 'an unknown ruler'
}

function empireBoard(empires, users, n) {
  const ranked = empires
    .map(e => ({ e, score: empireScore(e) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)

  if (!ranked.length) {
    return `🏰 *No empires have been founded yet.* Be the first with *${config.prefix}empire found <name>*.`
  }
  const lines = [`🏰 *Strongest Empires*`, RULE]
  ranked.forEach(({ e, score }, i) => {
    lines.push(`${medal(i)} *${e.name}*  ·  ${tierOf(e).name}`)
    lines.push(`    power ${score.toLocaleString()}  ·  ${(e.fame ?? 0).toLocaleString()} fame  ·  ${ownerName(users, e.ownerId)}`)
  })
  return lines.join('\n')
}

function soldierBoard(empires, users, n) {
  const all = []
  for (const e of empires) {
    for (const o of e.army?.officers ?? []) {
      all.push({
        name: o.name,
        rankName: rankMap[o.rank]?.name ?? o.rank,
        power: soldierPowerOf(o),
        empireName: e.name,
        owner: ownerName(users, e.ownerId),
      })
    }
  }
  all.sort((a, b) => b.power - a.power)
  const top = all.slice(0, n)

  if (!top.length) {
    return (
      `🎖️ *No officers have risen yet.*\n` +
      `Recruit troops and promote them into the officer corps with *${config.prefix}train soldier <n>*.`
    )
  }
  const lines = [`🎖️ *Strongest Soldiers*`, RULE]
  top.forEach((s, i) => {
    lines.push(`${medal(i)} *${s.name}*  ·  ${s.rankName}`)
    lines.push(`    power ${s.power.toLocaleString()}  ·  of ${s.empireName}`)
  })
  return lines.join('\n')
}

export default {
  name:           'empire-top',
  aliases:        ['empiretop', 'army-top', 'armytop', 'soldier-top', 'soldiertop'],
  category:       'empire',
  requiresPlayer: true,
  description:    'Leaderboards: the strongest empires and soldiers bot-wide',

  async run(ctx) {
    const p = config.prefix

    if (ctx.isGroup) {
      const settings = await getGroupSettings(ctx.sender)
      if (!settings.empireEnabled) {
        return ctx.reply(
          `🚫 The Empire system is disabled in this group.\n` +
          `_A group admin can enable it with *${p}empire on*._`
        )
      }
    }

    await ctx.db.read()
    await ensureEmpiresInitialized(ctx.db)
    const empires = Object.values(ctx.db.data.empires ?? {})
    const users = ctx.db.data.users ?? {}

    const raw = parseInt(ctx.args?.[0], 10)
    const n = Math.min(MAX_ROWS, Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_ROWS)

    const cmd = (ctx.cmd ?? '').toLowerCase()
    const wantSoldiers = cmd.includes('army') || cmd.includes('soldier')
    return ctx.reply(wantSoldiers ? soldierBoard(empires, users, n) : empireBoard(empires, users, n))
  },
}
