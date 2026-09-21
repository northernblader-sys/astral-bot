/**
 * monds.js — Mond packs (Naira, screenshot-confirmed).
 *
 * Structurally a sibling of plugins/topup.js and it should stay that way: same
 * four subcommands, same bank-transfer-then-screenshot flow, same owner
 * confirm/reject pair, same shared image hook in lib/pending-purchase.js
 * (`mondPending` alongside `topupPending`). What differs is only what the
 * currency does, and lib/monds.js owns that rule.
 *
 * Naira only. There is deliberately no in-game path to a Mond: no quest, no
 * drop, no daily, no Solar or Gem exchange rate anywhere. If a way to earn one
 * is ever added, `.character buy` stops being the paid route it exists to be.
 *
 * DM ONLY. Every subcommand except the owner's confirm/reject is refused in
 * a group with a "message me privately" pointer — payment details, balances
 * and pending purchases are nobody else's business, and posting bank details
 * into a group chat is how people get scammed by copycats.
 *
 * Usage (all in DM):
 *   .monds                       pack list and your balance
 *   .monds buy <pack>            shows payment details
 *   .monds confirm <name>        owner-only, credits the Monds
 *   .monds reject <name>         owner-only, clears a pending purchase
 */
import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import {
  MOND, CHARACTER_MOND_PRICE, fmtMonds, getMonds, roundMonds,
  findMondPack, mondPackLines,
} from '../lib/monds.js'
import { sendImage, sendImageTo } from '../lib/image.js'

// Same shared top-up art as plugins/topup.js (2026-09-21 drop): the pack-list
// view uses the plans image, the confirmation DM uses the done-card.
const TOPUP_PLANS_IMAGE = 'top-up.jpg'
const PAYMENT_DONE_IMAGE = 'payment_done.jpg'

/**
 * Builds the "come to my DM" reply, with a tappable link to the bot's own
 * chat so nobody has to go hunting for the number.
 */
function dmOnlyNotice(ctx) {
  const pr = config.prefix
  const botJid = ctx.sock?.user?.id ?? ''
  const botNumber = String(botJid).split(':')[0].replace(/@.*$/, '').replace(/\D/g, '')
  const link = botNumber ? `\n🔗 wa.me/${botNumber}` : ''
  return (
    `${MOND} *Monds are DM only.*\n` +
    `─────────────────────\n` +
    `Payment details and balances don't belong in a group chat.${link}\n\n` +
    `Message me privately and run:\n` +
    `  ▸ *${pr}monds* — packs and your balance\n` +
    `  ▸ *${pr}monds buy <pack>* — payment details\n\n` +
    `_${CHARACTER_MOND_PRICE} Monds buys any spin character outright with *${pr}character buy <name>*._`
  )
}

function findPlayerByName(allUsers, query) {
  const q = query.toLowerCase()
  return allUsers.find(u => u.name?.toLowerCase() === q)
    || allUsers.find(u => u.name?.toLowerCase().includes(q))
}

function packList(pr) {
  return (
    `${mondPackLines().join('\n')}\n\n` +
    `Buy with *${pr}monds buy <pack>*.`
  )
}

/** The one thing Monds are for, restated wherever the packs are shown. */
function whatMondsDo(pr) {
  return (
    `${MOND} *${CHARACTER_MOND_PRICE} Monds buys any spin character outright*, ` +
    `no reel and no pity bar: *${pr}character buy <name>*.\n` +
    `_Monds are the only currency that can. Gems spin, Solars never could._`
  )
}

async function handleList(ctx) {
  const pr = config.prefix
  const held = ctx.player ? getMonds(ctx.player) : 0
  return sendImage(ctx, TOPUP_PLANS_IMAGE,
    `${MOND} *MOND PACKS*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${whatMondsDo(pr)}\n\n` +
    `${packList(pr)}\n\n` +
    `👛 You hold ${MOND}*${fmtMonds(held)}*.`,
  )
}

async function handleBuy(ctx) {
  const pr = config.prefix
  if (!ctx.player) return ctx.reply(`⚠️ Register first with *${pr}register*.`)

  const query = ctx.args.slice(1).join(' ')
  const pack = findMondPack(query)
  if (!pack) {
    return ctx.reply(
      `❌ Unknown pack *"${query}"*.\n\n${MOND} *Packs:*\n${packList(pr)}`,
    )
  }

  await updatePlayer(ctx.db, ctx.from, p => {
    p.mondPending = { packageId: pack.id, monds: pack.monds, state: 'awaiting_screenshot' }
  })

  const pay = config.payment
  const bonusNote = pack.bonus > 0 ? ` _(${pack.base} + ${pack.bonus} free)_` : ''
  return ctx.reply(
    `${MOND} *${pack.label}* · ${MOND}*${pack.monds} Monds*${bonusNote}\n` +
    `💰 ₦${pack.priceNaira.toLocaleString()}\n\n` +
    `💳 *Payment Details:*\n` +
    `  🏦 Bank: *${pay.bankName || '(not configured)'}*\n` +
    `  🔢 Account: *${pay.accountNumber || '(not configured)'}*\n` +
    `  👤 Name: *${pay.accountName || '(not configured)'}*\n\n` +
    `📸 Once paid, send a screenshot of the transfer *right here in this DM* to confirm.`,
  )
}

async function handleConfirm(ctx) {
  const pr = config.prefix
  if (!isOwnerJid(ctx.from)) return ctx.reply(`❌ Owner only.`)

  const name = ctx.args.slice(1).join(' ')
  if (!name) return ctx.reply(`Usage: *${pr}monds confirm <player name>*`)

  await ctx.db.read()
  const allUsers = Object.values(ctx.db.data.users ?? {})
  const target = findPlayerByName(allUsers, name)
  if (!target) return ctx.reply(`❌ No player found matching *"${name}"*.`)
  if (!target.mondPending) return ctx.reply(`⚠️ *${target.name}* has no pending Mond purchase.`)

  const { monds, packageId } = target.mondPending
  await updatePlayer(ctx.db, target.id, p => {
    p.wallet = p.wallet ?? {}
    p.wallet.monds = roundMonds((p.wallet.monds ?? 0) + monds)
    p.mondPending = null
  })

  const fresh = getPlayer(ctx.db, target.id)
  const balance = getMonds(fresh)
  const affords = Math.floor(balance / CHARACTER_MOND_PRICE)
  // Payment-completion image on the confirmation DM (degrades to text).
  await sendImageTo(ctx, PAYMENT_DONE_IMAGE,
    `🎉 *Mond purchase confirmed!*\n` +
    `${MOND}*${monds}* credited _(pack: ${packageId})_.\n` +
    `👛 Balance: ${MOND}*${fmtMonds(balance)}*\n\n` +
    (affords > 0
      ? `_That is ${affords} character${affords === 1 ? '' : 's'}. Spend it with *${pr}character buy <name>*._`
      : `_${CHARACTER_MOND_PRICE} Monds buys a character. You are ${CHARACTER_MOND_PRICE - balance} short._`),
    target.id,
  ).catch(() => {})

  return ctx.reply(`✅ Credited ${MOND}*${monds}* to *${target.name}* _(pack: ${packageId})_.`)
}

async function handleReject(ctx) {
  const pr = config.prefix
  if (!isOwnerJid(ctx.from)) return ctx.reply(`❌ Owner only.`)

  const name = ctx.args.slice(1).join(' ')
  if (!name) return ctx.reply(`Usage: *${pr}monds reject <player name>*`)

  await ctx.db.read()
  const allUsers = Object.values(ctx.db.data.users ?? {})
  const target = findPlayerByName(allUsers, name)
  if (!target) return ctx.reply(`❌ No player found matching *"${name}"*.`)

  await updatePlayer(ctx.db, target.id, p => { p.mondPending = null })

  await ctx.sock.sendMessage(target.id, {
    text:
      `❌ Your Mond purchase couldn't be confirmed. Please double-check the payment ` +
      `and try *${pr}monds buy <pack>* again, or contact support.`,
  }).catch(() => {})

  return ctx.reply(`✅ Cleared *${target.name}*'s pending Mond purchase.`)
}

export default {
  name: 'monds',
  aliases: ['mond', 'buymonds', 'mondshop'],
  category: 'economy',
  description: `${config.prefix}monds · DM only · buy Monds with Naira. ${CHARACTER_MOND_PRICE} Monds buys any spin character`,

  async run(ctx) {
    const sub = (ctx.args[0] ?? '').toLowerCase()

    // Owner moderation works anywhere — the owner confirming a payment from
    // the mod group shouldn't have to switch chats.
    const ownerOnlySub = sub === 'confirm' || sub === 'reject'

    // Everything else is DM only. One gate for the whole command, so `.monds`,
    // `.mond`, `.buymonds` and `.mondshop` all behave the same way instead of
    // only `buy` being private.
    if (ctx.isGroup && !(ownerOnlySub && isOwnerJid(ctx.from))) {
      return ctx.reply(dmOnlyNotice(ctx))
    }

    if (sub === 'buy')     return handleBuy(ctx)
    if (sub === 'confirm') return handleConfirm(ctx)
    if (sub === 'reject')  return handleReject(ctx)

    return handleList(ctx)
  },
}
