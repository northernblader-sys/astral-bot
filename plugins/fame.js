/**
 * fame.js — Astral Town's word-of-mouth / clout system.
 *
 * Usage:
 *   .fame                — your own fame, tier, payout rate, recent history
 *   .fame <player name>  — view someone else's fame + public status
 *   .fame top            — top 10 most-famous players in the realm
 *   .fame gift <player> <amount> — gift some of your fame to another player
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { roundGems } from '../lib/format.js'
import {
  FAME_TIERS, getFameTier, getNextFameTier, formatFame, historyLabel,
} from '../lib/fame-engine.js'

function findPlayerByName(allUsers, query) {
  const q = query.toLowerCase()
  return allUsers.find(u => u.name?.toLowerCase() === q)
    || allUsers.find(u => u.name?.toLowerCase().includes(q))
}

export default {
  name:           'fame',
  aliases:        ['followers', 'clout'],
  category:       'social',
  requiresPlayer: true,
  description:    "View or compare Astral fame — earned from kills, bosses, and level-ups",

  async run(ctx) {
    const { player, args, reply, db } = ctx
    const p   = config.prefix
    const sub = args[0]?.toLowerCase()

    if (sub === 'top' || sub === 'leaderboard') return showTop(ctx)
    if (sub === 'gift')                          return giftFame(ctx)

    await db.read()
    const allUsers = Object.values(db.data.users ?? {})

    let target = player
    if (args.length) {
      const found = findPlayerByName(allUsers, args.join(' '))
      if (found) target = found
    }

    const fame     = target.fame || 0
    const tier     = getFameTier(fame)
    const next     = getNextFameTier(fame)
    const history  = (target.fameHistory || []).slice(0, 5)
    const isSelf   = target.id === player.id

    const nextBlock = next
      ? `📈 _Next tier at *${formatFame(next.min)}* fame${next.payout > tier.payout ? ` _(higher Solars/win payout)_` : ''}_`
      : `🏆 _You've reached the highest tier!_`

    const histBlock = history.length
      ? history.map(h => `  • ${historyLabel(h)} _(+${h.gained})_`).join('\n')
      : '  _No fame gained yet — go win some fights!_'

    return reply(
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `${tier.emoji} *${isSelf ? 'YOUR FAME' : target.name.toUpperCase() + "'S FAME"}*\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 *${target.name}*\n` +
      `${tier.emoji} *${formatFame(fame)} Fame* — ${tier.label}\n` +
      `☀️ Payout: *${tier.payout > 0 ? `20-40 Solars/win (rank ${tier.payout})` : '0 Solars/win'}*\n\n` +
      (target.fameStatus ? `📰 *Latest:* ${target.fameStatus}\n\n` : '') +
      `📊 *Recent Activity:*\n${histBlock}\n\n` +
      `${nextBlock}` +
      (isSelf ? `\n\n_Use *${p}fame top* for the leaderboard · *${p}fame gift @name <amt>* to gift fame_` : '')
    )
  },
}

async function showTop(ctx) {
  const { reply, db } = ctx
  const p = config.prefix

  await db.read()
  const allUsers = Object.values(db.data.users ?? {})

  const ranked = allUsers
    .filter(u => (u.fame || 0) > 0)
    .sort((a, b) => (b.fame || 0) - (a.fame || 0))
    .slice(0, 10)

  if (!ranked.length) {
    return reply(
      `📊 *ASTRAL FAME BOARD*\n\n` +
      `_No one has earned fame yet!_\n` +
      `_Win fights, clear floors, beat bosses — the realm is watching._`
    )
  }

  const rankEmoji = ['👑', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']
  const lines = ranked.map((u, i) => {
    const t = getFameTier(u.fame || 0)
    return `${rankEmoji[i]} *${u.name}* — ${formatFame(u.fame)} ${t.emoji}`
  }).join('\n')

  return reply(
    `🏆 *ASTRAL FAME BOARD*\n` +
    `─────────────────────\n` +
    `${lines}\n\n` +
    `_Type *${p}fame* to see your own_`
  )
}

/**
 * .fame gift <player> <amount>
 * Rules (deliberately cheap — fame gifting is a social gesture, not an economy):
 *   • Minimum gift: 20 fame
 *   • Maximum:      50% of your own fame
 *   • Cost:         1 Gem per 50 fame gifted (rounded up)
 *   • Requires at least 50 fame to gift any
 */
async function giftFame(ctx) {
  const { args, reply, db, from } = ctx
  const p = config.prefix

  await db.read()
  const allUsers = Object.values(db.data.users ?? {})

  const rest = args.slice(1)
  const amountArg = rest.filter(a => /^\d+$/.test(a)).pop()
  const nameArg   = rest.filter(a => !/^\d+$/.test(a)).join(' ')

  if (!nameArg || !amountArg) {
    return reply(
      `❌ *Usage:* ${p}fame gift <player> <amount>\n` +
      `_Example: ${p}fame gift Aria 100_`
    )
  }

  const target = findPlayerByName(allUsers, nameArg)
  if (!target)            return reply(`❌ Couldn't find a player named *"${nameArg}"*.`)
  if (target.id === from) return reply(`❌ You can't gift fame to yourself!`)

  const amount = Math.floor(Number(amountArg) || 0)

  let resultMsg = null
  await updatePlayer(db, from, sender => {
    const senderFame = sender.fame || 0

    if (senderFame < 50) {
      resultMsg = `❌ You need at least *50 fame* to gift any. You have ${formatFame(senderFame)}.`
      return sender
    }
    if (amount < 20) {
      resultMsg = `❌ Minimum gift is *20 fame*.`
      return sender
    }
    if (amount > Math.floor(senderFame * 0.5)) {
      resultMsg = `❌ You can only gift up to *50%* of your fame (max: ${formatFame(Math.floor(senderFame * 0.5))}).`
      return sender
    }

    const gemCost = Math.ceil(amount / 50)
    if ((sender.wallet?.gems ?? 0) < gemCost) {
      resultMsg = `❌ You need *${gemCost} 💎* to gift ${formatFame(amount)} fame. You have ${sender.wallet?.gems ?? 0} 💎.`
      return sender
    }

    sender.fame = senderFame - amount
    sender.wallet.gems = roundGems((sender.wallet.gems ?? 0) - gemCost)
    sender.fameStatus     = `Gifted ${formatFame(amount)} fame to *${target.name}*`
    sender.fameLastAction = Date.now()

    if (!Array.isArray(sender.fameHistory)) sender.fameHistory = []
    sender.fameHistory.unshift({ event: 'gift_out', value: amount, gained: -amount, targetName: target.name, at: Date.now() })
    if (sender.fameHistory.length > 5) sender.fameHistory.length = 5

    resultMsg = `🎁 *FAME GIFTED!*\n` +
      `👤 To: *${target.name}*\n` +
      `👥 Amount: *${formatFame(amount)}* fame\n` +
      `💎 Cost: *-${gemCost} 💎*\n\n` +
      `📊 Your new fame: ${formatFame(sender.fame)}`

    return sender
  })

  if (resultMsg && resultMsg.startsWith('❌')) return reply(resultMsg)

  // Credit the target separately (their record may not be `from`'s db entry).
  await updatePlayer(db, target.id, receiver => {
    receiver.fame = (receiver.fame || 0) + amount
    receiver.fameStatus     = `Received ${formatFame(amount)} fame from a fellow adventurer`
    receiver.fameLastAction = Date.now()
    if (!Array.isArray(receiver.fameHistory)) receiver.fameHistory = []
    receiver.fameHistory.unshift({ event: 'gift_in', value: amount, gained: amount, targetName: null, at: Date.now() })
    if (receiver.fameHistory.length > 5) receiver.fameHistory.length = 5
    return receiver
  })

  return reply(resultMsg)
}
