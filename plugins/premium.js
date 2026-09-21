/**
 * premium.js — Premium subscriptions (Naira, screenshot-confirmed).
 *
 * Usage:
 *   .premium                      — status (DM/group) or plan list if inactive
 *   .premium buy <plan>           — DM only; shows payment details
 *   .premium confirm <name> <plan> — owner-only, grants premium
 *   .premium reject <name>        — owner-only, clears a pending purchase
 *   .premium on / .premium off    — owner-only, run inside the target group
 *
 * See lib/premium.js for perk logic, lib/pending-purchase.js for the shared
 * DM-screenshot flow (also used by plugins/topup.js), and handler.js for
 * the DM lock + premium-gated-group enforcement that surround this plugin.
 */
import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { saveGroupSettings, saveFailedMessage } from '../lib/group-settings.js'
import { addPremiumGroup, removePremiumGroup } from '../lib/premium-groups.js'
import { isPremiumActive, grantPremium } from '../lib/premium.js'
import { premiumPlans as plansData } from '../lib/game-data.js'
import { sendImage, sendImageTo } from '../lib/image.js'
import { attemptWeeklyAbilitySpin, grantPremiumAbility } from '../lib/premium-abilities.js'

const PLAN_KEYS = Object.keys(plansData.plans)

function findPlayerByName(allUsers, query) {
  const q = query.toLowerCase()
  return allUsers.find(u => u.name?.toLowerCase() === q)
    || allUsers.find(u => u.name?.toLowerCase().includes(q))
}

function daysLeft(expiresAt) {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000))
}

/**
 * abilitySpinLine(spin) — the buyer-facing result of the weekly one-of-one
 * ability spin (attemptWeeklyAbilitySpin), shown in the confirmation DM.
 * Empty string when there was no spin (non-weekly plan).
 */
function abilitySpinLine(spin) {
  switch (spin?.outcome) {
    case 'won': {
      const a = spin.ability
      const move = a?.activeCommand ? `Active move: *${config.prefix}${a.activeCommand}*.\n` : `Passive only, no active move.\n`
      return (
        `🎰 *ABILITY SPIN — JACKPOT!*\n` +
        `You claimed ${a?.emoji ?? '✨'} *${a?.name ?? spin.abilityId}* — one of only *5* in the whole game, and now yours alone forever.\n` +
        move +
        `${a?.passiveDesc ?? ''}`
      )
    }
    case 'no_win':
      return `🎰 *Ability Spin:* no ability this time. The 5 premium abilities are one-of-one — each weekly plan takes a single luck-based spin at whatever is still unclaimed.`
    case 'sold_out':
      return `🎰 *Ability Spin:* all 5 one-of-one abilities have already been claimed bot-wide, so there was nothing left to spin for.`
    case 'already':
      return `🎰 *Ability Spin:* you already hold *${spin.ability?.name ?? 'an ability'}* — a player can only ever hold one, so this weekly plan did not spin.`
    default:
      return ''
  }
}

/** Short owner-facing note appended to the confirm ack. */
function spinOutcomeShort(spin) {
  switch (spin?.outcome) {
    case 'won':      return `🎰 Won *${spin.ability?.name ?? spin.abilityId}*!`
    case 'no_win':   return `🎰 Spin: no ability.`
    case 'sold_out': return `🎰 Spin: all 5 claimed.`
    case 'already':  return `🎰 Spin: already holds one.`
    default:         return ''
  }
}

function planList(pr) {
  return Object.entries(plansData.plans)
    .map(([key, plan]) => `  • *${key}* — ${plan.label}, ₦${plan.priceNaira.toLocaleString()} / ${plan.durationDays}d`)
    .join('\n') +
    `\n\nBuy with *${pr}premium buy <plan>* _(DM only)_.` +
    `\n\n🎰 The *weekly* plan takes one luck-based spin at a legendary one-of-one ability — only *5* exist in the entire game, and each can be won by a single player, once, ever.`
}

function statusText(player, pr) {
  if (isPremiumActive(player)) {
    return (
      `👑 *Premium active!*\n` +
      `Plan: *${player.premium.plan}*\n` +
      `Expires in *${daysLeft(player.premium.expiresAt)} day(s)* _(${new Date(player.premium.expiresAt).toLocaleDateString()})_\n\n` +
      `Perks: ✨ 1.25× XP/Solars on kill · 💫 1 free auto-revive/day\n` +
      `🎰 Weekly plan: one spin at a one-of-one ability (only 5 exist ever)`
    )
  }
  return `🔓 *No active Premium.*\n\n📦 *Plans:*\n${planList(pr)}`
}

async function handleBuy(ctx) {
  const pr = config.prefix
  if (ctx.isGroup) {
    return ctx.reply(`💬 DM me *${pr}premium buy <plan>* to see payment details.`)
  }

  const planKey = (ctx.args[1] ?? '').toLowerCase()
  if (!PLAN_KEYS.includes(planKey)) {
    return ctx.reply(`❌ Unknown plan *"${ctx.args[1] ?? ''}"*.\n\n${planList(pr)}`)
  }

  const plan = plansData.plans[planKey]
  await updatePlayer(ctx.db, ctx.from, p => {
    p.premiumPending = { plan: planKey, state: 'awaiting_screenshot' }
  })

  const pay = config.payment
  return ctx.reply(
    `👑 *${plan.label} Premium* — ₦${plan.priceNaira.toLocaleString()} _(${plan.durationDays} days)_\n\n` +
    `💳 *Payment Details:*\n` +
    `  🏦 Bank: *${pay.bankName || '(not configured)'}*\n` +
    `  🔢 Account: *${pay.accountNumber || '(not configured)'}*\n` +
    `  👤 Name: *${pay.accountName || '(not configured)'}*\n\n` +
    `📸 Once paid, send a screenshot of the transfer *right here in this DM* to confirm.`,
  )
}

async function handleConfirm(ctx) {
  if (!isOwnerJid(ctx.from)) return ctx.reply(`❌ Owner only.`)

  const planKey = ctx.args[ctx.args.length - 1]?.toLowerCase()
  const nameParts = ctx.args.slice(1, PLAN_KEYS.includes(planKey) ? -1 : undefined)
  const name = nameParts.join(' ')
  if (!name || !PLAN_KEYS.includes(planKey)) {
    return ctx.reply(`Usage: *${config.prefix}premium confirm <player name> <weekly|monthly|yearly>*`)
  }

  await ctx.db.read()
  const allUsers = Object.values(ctx.db.data.users ?? {})
  const target = findPlayerByName(allUsers, name)
  if (!target) return ctx.reply(`❌ No player found matching *"${name}"*.`)

  let spinResult = null
  let abilityResult = null
  await updatePlayer(ctx.db, target.id, p => {
    grantPremium(p, planKey, plansData)
    p.premiumPending = null
    // Weekly buyers get one luck-based spin at a one-of-one ability. Claimed
    // through the shared exclusive-spin registry INSIDE this mutator so the
    // claim persists atomically with the grant (see attemptWeeklyAbilitySpin).
    if (planKey === 'weekly') {
      spinResult = attemptWeeklyAbilitySpin(ctx.db, target.id, p)
    }
    // Every buyer — weekly (win or miss) or monthly/yearly — leaves with an
    // ability in their equipped slot (see grantPremiumAbility). Same mutator,
    // so the grant can never persist without the ability and vice versa.
    abilityResult = grantPremiumAbility(p, spinResult)
  })

  const fresh = getPlayer(ctx.db, target.id)
  const spinBlock = spinResult ? `\n\n${abilitySpinLine(spinResult)}` : ''

  let abilityBlock = ''
  if (abilityResult?.granted === 'spin') {
    abilityBlock = `\n\n✨ *Ability slot:* your one-of-one ability is equipped — see it on *${config.prefix}profile*.`
  } else if (abilityResult?.granted === 'new') {
    const equippedLine = abilityResult.equipped
      ? `It's equipped in your ability slot already.`
      : `All your ability slots are full — it's in your inventory, ready to equip.`
    abilityBlock = `\n\n✨ *Ability slot:* you received *Crown's Favor* (epic passive, +3 to every stat in battle). ${equippedLine} See it on *${config.prefix}profile*.`
  } else if (abilityResult?.granted === 'already') {
    abilityBlock = `\n\n✨ *Ability slot:* *Crown's Favor* is already yours from a previous purchase.`
  }

  // Payment-completion image: this DM is the moment the buyer learns they got
  // what they paid for, so it carries the done-card (sendImageTo degrades to
  // plain text if the image can't be fetched — the caption is never lost).
  await sendImageTo(ctx, 'payment_done.jpg',
    `🎉 *Premium activated!*\n` +
    `Plan: *${planKey}* — expires *${new Date(fresh.premium.expiresAt).toLocaleDateString()}*\n\n` +
    `Perks: ✨ 1.25× XP/Solars on kill · 💫 1 free auto-revive/day` +
    spinBlock + abilityBlock +
    `\n\nThank you for supporting the game!`,
    target.id,
  ).catch(() => {})

  const ownerNote = spinResult ? ` ${spinOutcomeShort(spinResult)}` : ''
  return ctx.reply(`✅ Granted *${planKey}* Premium to *${target.name}*.${ownerNote}`)
}

async function handleReject(ctx) {
  if (!isOwnerJid(ctx.from)) return ctx.reply(`❌ Owner only.`)

  const name = ctx.args.slice(1).join(' ')
  if (!name) return ctx.reply(`Usage: *${config.prefix}premium reject <player name>*`)

  await ctx.db.read()
  const allUsers = Object.values(ctx.db.data.users ?? {})
  const target = findPlayerByName(allUsers, name)
  if (!target) return ctx.reply(`❌ No player found matching *"${name}"*.`)

  await updatePlayer(ctx.db, target.id, p => { p.premiumPending = null })

  await ctx.sock.sendMessage(target.id, {
    text: `❌ Your Premium purchase couldn't be confirmed. Please double-check the payment and try *${config.prefix}premium buy <plan>* again, or contact support.`,
  }).catch(() => {})

  return ctx.reply(`✅ Cleared *${target.name}*'s pending Premium purchase.`)
}

async function handleOnOff(ctx, turnOn) {
  if (!isOwnerJid(ctx.from)) return ctx.reply(`❌ Owner only.`)
  if (!ctx.isGroup) return ctx.reply(`❌ Run this inside the group you want to gate.`)

  // Save FIRST and bail if it didn't land. The premium-group list and this flag
  // have to agree: adding the group to the list after a failed settings write
  // gates the group while its saved setting says it's open, and `.premium off`
  // would then read the (unsaved) flag and think there's nothing to undo.
  const res = await saveGroupSettings(ctx.sender, s => { s.premiumOnly = turnOn; return s })
  if (!res.ok) return ctx.reply(saveFailedMessage('Premium-only gating', res.error))

  const stored = res.settings.premiumOnly === true
  if (stored) await addPremiumGroup(ctx.sender)
  else await removePremiumGroup(ctx.sender)

  return ctx.reply(
    stored
      ? `🔒 This group is now *Premium-only*. Non-premium members will be rejected (not kicked) when they try to use commands here.`
      : `🔓 Premium-only gating has been removed from this group.`,
  )
}

export default {
  name: 'premium',
  aliases: ['vip'],
  category: 'economy',
  description: `${config.prefix}premium — view/buy Premium; owner-only admin subcommands`,

  async run(ctx) {
    // Premium is a WhatsApp-only, Naira/screenshot-confirmed manual purchase
    // flow (see lib/pending-purchase.js) — there's no payment or DM-proof
    // pipeline for Discord/Telegram, and building one is out of scope. The
    // command stays visible and answers on those platforms rather than
    // vanishing from .menu, but every subcommand is short-circuited here
    // before touching any real logic.
    if (ctx.platform !== 'whatsapp') {
      return ctx.reply(
        `👑 *Premium* isn't available on ${ctx.platform === 'discord' ? 'Discord' : 'Telegram'} yet — ` +
        `it's currently a WhatsApp-only feature.`,
      )
    }

    const sub = (ctx.args[0] ?? '').toLowerCase()
    const pr  = config.prefix

    if (sub === 'buy')                    return handleBuy(ctx)
    if (sub === 'confirm')                return handleConfirm(ctx)
    if (sub === 'reject')                 return handleReject(ctx)
    if (sub === 'on')                     return handleOnOff(ctx, true)
    if (sub === 'off')                    return handleOnOff(ctx, false)

    // Default: status view — needs a registered player.
    if (!ctx.player) {
      return ctx.reply(`⚠️ Register first with *${pr}register*, or *${pr}premium buy <plan>* still needs registration too.\n\n📦 *Plans:*\n${planList(pr)}`)
    }
    const caption = statusText(ctx.player, pr)
    const bodyLine = isPremiumActive(ctx.player)
      ? `Active plan: ${ctx.player.premium.plan}`
      : 'Weekly, monthly, and yearly plans available'
    return sendImage(ctx, 'premium.jpg', `*👑 Astral Premium*\n${bodyLine}\n\n${caption}`)
  },
}
