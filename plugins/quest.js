/**
 * quest — the player-facing window on the quest pillar (lib/quest-engine.js).
 *
 *   .quest            show today's daily set + your live milestones
 *   .quest list       same as above
 *   .quest claim      claim every finished quest at once
 *   .quest claim <id> claim one finished quest by its id
 *   .quest complete   alias for claim (matches the old .quest complete button)
 *
 * Progress itself is recorded elsewhere, wherever the tracked thing happens
 * (a kill in combat-handlers.js, a catch in collect.js, a battle win in the
 * poke/pvp conclude paths). This plugin only reads the board and pays out
 * finished quests, so it never touches combat state.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { levelsData, classes, races, getTotalStats } from '../lib/game-data.js'
import { applyLevelUps } from '../lib/combat-engine.js'
import { sendRankUp } from '../lib/rank-up.js'
import {
  getQuestBoard, claimQuest, ensureQuestState, DAILY_COUNT,
} from '../lib/quest-engine.js'

function bar(progress, goal) {
  const pct = goal > 0 ? Math.min(1, progress / goal) : 1
  const filled = Math.round(pct * 10)
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled)
}

function rewardTag(reward) {
  if (!reward) return ''
  const amt = reward.amount ?? 1
  switch (reward.type) {
    case 'solars':       return `☀️ ${amt}`
    case 'gems':         return `💎 ${amt}`
    case 'xp':           return `📈 ${amt} XP`
    case 'seasonPoints': return `✨ ${amt} SP`
    case 'stamina':      return `⚡ ${amt}`
    case 'character':    return `🎴 character`
    case 'item':         return `🎁 item`
    default:             return `${amt}`
  }
}

function renderLine(q) {
  const status = q.claimed ? '☑️' : q.done ? '✅' : '⬜'
  const prog = q.done ? '' : `  _${q.progress}/${q.goal}_`
  const barStr = q.done ? '' : `\n   ${bar(q.progress, q.goal)}`
  const claimHint = q.done && !q.claimed ? `  ·  🎁 ${rewardTag(q.reward)} _(ready)_` : `  ·  ${rewardTag(q.reward)}`
  return `${status} *${q.name}*${prog}${claimHint}\n   _${q.desc}_${barStr}`
}

function renderBoard(player) {
  const { daily, milestone } = getQuestBoard(player)
  const lines = [`📜 *QUEST BOARD*\n`]

  lines.push(`☀️ *DAILY* _(rotates at midnight, ${DAILY_COUNT} a day)_`)
  if (daily.length) {
    for (const q of daily) lines.push(renderLine(q))
  } else {
    lines.push('_No daily quests today._')
  }

  if (milestone.length) {
    lines.push(`\n🏆 *MILESTONES* _(one time)_`)
    for (const q of milestone) lines.push(renderLine(q))
  }

  const ready = daily.filter(q => q.done && !q.claimed).length + milestone.filter(q => q.done).length
  lines.push(
    ready > 0
      ? `\n🎁 *${ready}* quest${ready === 1 ? '' : 's'} ready. Claim with *${config.prefix}quest claim*.`
      : `\n_Keep playing to make progress. Claim finished quests with *${config.prefix}quest claim*._`,
  )
  return lines.join('\n')
}

export default {
  name:           'quest',
  aliases:        ['quests', 'missions'],
  category:       'progression',
  requiresPlayer: true,
  description:    `${config.prefix}quest [claim] — view your daily quests and milestones, and claim finished ones.`,

  async run(ctx) {
    const { args, reply } = ctx
    const sub = (args[0] ?? '').toLowerCase()

    // ── Claim path ─────────────────────────────────────────────────────────
    if (sub === 'claim' || sub === 'complete' || sub === 'turnin') {
      const id = args[1] ? args[1].toLowerCase() : null
      let outcome = null
      let lvlMsgs = []
      let rankChange = null

      await updatePlayer(ctx.db, ctx.from, player => {
        outcome = claimQuest(player, id)
        // Quest XP can push a level, same as daily.js: settle it here so the
        // player sees the level in the same breath as the claim.
        if (!outcome.nothing) {
          const res = applyLevelUps(player, levelsData, classes, races, getTotalStats)
          lvlMsgs = res.msgs ?? []
          rankChange = res.rankChange ?? null
        }
        return player
      })

      if (outcome.nothing) {
        return reply(
          `📜 *Nothing to claim yet.*\n\n_Finish a quest first, then come back. See the board with *${config.prefix}quest*._`,
        )
      }

      const rewardLines = outcome.claimed
        .map(c => `✅ *${c.name}*  ·  ${c.rewardLabel ?? 'reward'}`)
        .join('\n')
      await reply(
        `🎁 *QUESTS CLAIMED*\n\n${rewardLines}` +
        (lvlMsgs.length ? `\n\n${lvlMsgs.join('\n')}` : '') +
        `\n\n_See what's left with *${config.prefix}quest*._`,
      )

      if (rankChange) {
        await sendRankUp(ctx, ctx.player?.name ?? 'Hunter', rankChange.from, rankChange.to)
      }
      return
    }

    // ── List path (default) ──────────────────────────────────────────────────
    // Touch state once so a brand-new player or a day rollover is persisted even
    // if they only ever look at the board.
    let board = null
    await updatePlayer(ctx.db, ctx.from, player => {
      ensureQuestState(player)
      board = renderBoard(player)
      return player
    })
    return reply(board)
  },
}
