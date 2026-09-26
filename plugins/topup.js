/**
 * topup.js — Gem top-ups (Naira, screenshot-confirmed). Naira only — never
 * purchasable with Solars or any in-game currency.
 *
 * Usage:
 *   .topup                         — package list
 *   .topup buy <packageId>         — DM only; shows payment details
 *   .topup confirm <name>          — owner-only, credits gems
 *   .topup reject <name>           — owner-only, clears a pending purchase
 *
 * See lib/pending-purchase.js for the shared DM-screenshot flow (also used
 * by plugins/premium.js) and handler.js for the surrounding DM lock.
 */
import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { topupPackages as pkgData } from '../lib/game-data.js'
import { sendImage, sendImageTo } from '../lib/image.js'

// Shared top-up art: every package-list view (gems, monds, season offers) and
// every "you got what you paid for" confirmation DM uses these (2026-09-21
// drop, resolved via lib/image.js's remote map).
const TOPUP_PLANS_IMAGE = 'top-up.jpg'
const PAYMENT_DONE_IMAGE = 'payment_done.jpg'

function findPlayerByName(allUsers, query) {
  const q = query.toLowerCase()
  return allUsers.find(u => u.name?.toLowerCase() === q)
    || allUsers.find(u => u.name?.toLowerCase().includes(q))
}

function packageList(pr) {
  return pkgData.gemPackages
    .map(pkg => `  • *${pkg.id}* — 💎${pkg.gems} for ₦${pkg.priceNaira.toLocaleString()}`)
    .join('\n') + `\n\nBuy with *${pr}topup buy <package id>* _(DM only)_.`
}

async function handleBuy(ctx) {
  const pr = config.prefix
  if (ctx.isGroup) {
    return ctx.reply(`💬 DM me *${pr}topup buy <package id>* to see payment details.`)
  }

  const pkgId = (ctx.args[1] ?? '').toLowerCase()
  const pkg = pkgData.gemPackages.find(p => p.id === pkgId)
  if (!pkg) return ctx.reply(`❌ Unknown package *"${ctx.args[1] ?? ''}"*.\n\n📦 *Packages:*\n${packageList(pr)}`)

  await updatePlayer(ctx.db, ctx.from, p => {
    p.topupPending = { packageId: pkg.id, gems: pkg.gems, state: 'awaiting_screenshot' }
  })

  const pay = config.payment
  return ctx.reply(
    `💎 *${pkg.gems} Gems* — ₦${pkg.priceNaira.toLocaleString()}\n\n` +
    `💳 *Payment Details:*\n` +
    `  🏦 Bank: *${pay.bankName || '(not configured)'}*\n` +
    `  🔢 Account: *${pay.accountNumber || '(not configured)'}*\n` +
    `  👤 Name: *${pay.accountName || '(not configured)'}*\n\n` +
    `📸 Once paid, send a screenshot of the transfer *right here in this DM* to confirm.`,
  )
}

async function handleConfirm(ctx) {
  if (!isOwnerJid(ctx.from)) return ctx.reply(`❌ Owner only.`)

  const name = ctx.args.slice(1).join(' ')
  if (!name) return ctx.reply(`Usage: *${config.prefix}topup confirm <player name>*`)

  await ctx.db.read()
  const allUsers = Object.values(ctx.db.data.users ?? {})
  const target = findPlayerByName(allUsers, name)
  if (!target) return ctx.reply(`❌ No player found matching *"${name}"*.`)
  if (!target.topupPending) return ctx.reply(`⚠️ *${target.name}* has no pending top-up.`)

  const { gems, packageId } = target.topupPending
  await updatePlayer(ctx.db, target.id, p => {
    p.wallet.gems = roundGems((p.wallet.gems ?? 0) + gems)
    p.topupPending = null
  })

  const fresh = getPlayer(ctx.db, target.id)
  // Payment-completion image on the confirmation DM (degrades to text).
  await sendImageTo(ctx, PAYMENT_DONE_IMAGE,
    `🎉 *Top-up confirmed!* 💎${gems} gems credited (package: *${packageId}*).\nYour balance: 💎${fmtGems(fresh.wallet.gems)}.`,
    target.id,
  ).catch(() => {})

  return ctx.reply(`✅ Credited 💎${gems} to *${target.name}* (package: *${packageId}*).`)
}

async function handleReject(ctx) {
  if (!isOwnerJid(ctx.from)) return ctx.reply(`❌ Owner only.`)

  const name = ctx.args.slice(1).join(' ')
  if (!name) return ctx.reply(`Usage: *${config.prefix}topup reject <player name>*`)

  await ctx.db.read()
  const allUsers = Object.values(ctx.db.data.users ?? {})
  const target = findPlayerByName(allUsers, name)
  if (!target) return ctx.reply(`❌ No player found matching *"${name}"*.`)

  await updatePlayer(ctx.db, target.id, p => { p.topupPending = null })

  await ctx.sock.sendMessage(target.id, {
    text: `❌ Your gem top-up couldn't be confirmed. Please double-check the payment and try *${config.prefix}topup buy <package id>* again, or contact support.`,
  }).catch(() => {})

  return ctx.reply(`✅ Cleared *${target.name}*'s pending top-up.`)
}

export default {
  name: 'topup',
  aliases: ['gems', 'buygems'],
  category: 'economy',
  description: `${config.prefix}topup — buy gems with Naira via bank transfer`,

  async run(ctx) {
    const sub = (ctx.args[0] ?? '').toLowerCase()
    const pr  = config.prefix

    if (sub === 'buy')     return handleBuy(ctx)
    if (sub === 'confirm') return handleConfirm(ctx)
    if (sub === 'reject')  return handleReject(ctx)

    return sendImage(ctx, TOPUP_PLANS_IMAGE, `📦 *Gem Packages:*\n${packageList(pr)}`)
  },
}
