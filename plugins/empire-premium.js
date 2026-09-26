/**
 * plugins/empire-premium.js — the Empire Premium Shop: gem-bought empire perks.
 *
 * A gem sink alongside plugins/shop.js's ability_slot and plugins/skillpack.js,
 * scoped to rulers instead of any player, since every item here acts on an
 * empire record. Requires owning an empire (mirrors army.js/coffee.js's gate).
 *
 * Items:
 *   Gem Miner (passive, one-time buy) — grants ownsGemMiner on the PLAYER, then
 *     `.empire premium claim` pays out 1 gem every 24h, same startOfDay()
 *     cooldown idiom as plugins/daily.js. No cap on total days claimed.
 *   Warehouse Permit (consumable, stacks) — +1 to record.premiumPermits,
 *     which lib/empire-engine.js's warehouseCap() reads additively.
 *   Rename Scroll (consumable) — renames record.name only. The record's id
 *     (the slug used as its db.data.empires key and stored on player.empireId
 *     everywhere) is NEVER touched, so no membership/lookup ever needs to move.
 *
 * Every purchase is ONE updatePlayer mutator: the gem debit and the perk grant
 * land in the same serialized write, so a race can never charge gems without
 * granting the perk or vice versa. Nothing here mints gems, only spends them.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getGroupSettings } from '../lib/group-settings.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { startOfDay } from '../lib/sleep-engine.js'
import { ensureEmpiresInitialized, getOwnedEmpire } from '../lib/empire-repo.js'
import {
  EMPIRE_CONFIG, premiumShopItems, findPremiumItem,
  warehouseCap, validateName, fmtDuration,
} from '../lib/empire-engine.js'
import { empireNameTaken } from '../lib/empire-repo.js'

const RULE = '━━━━━━━━━━━━━━━━━━━━'
const GEM_MINE_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24h, matches the "1 gem per day max" spec

function noEmpire(p) {
  return (
    `🏰 *You don't rule an empire yet.*\n` +
    `Found one for *${EMPIRE_CONFIG.foundCost.toLocaleString()} solars*:\n` +
    `> *${p}empire found <n>*`
  )
}

async function gate(ctx) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) {
      await ctx.reply(
        `🚫 The Empire system is disabled in this group.\n` +
        `_A group admin can enable it with *${p}empire on*._`
      )
      return false
    }
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  return true
}

// ── Views ───────────────────────────────────────────────────────────────────

function catalogView(record, gems, p) {
  const lines = [
    `💎 *EMPIRE PREMIUM SHOP* 💎`,
    RULE,
    `_Gem-bought perks for *${record.name}*. Nothing here can be bought with solars._`,
    ``,
    `💰 Your gems: *${fmtGems(gems)}*`,
    ``,
  ]
  for (const item of premiumShopItems()) {
    lines.push(`${item.emoji} *${item.name}*  ·  💎${item.priceGems}`)
    lines.push(`   ↳ ${item.blurb}`)
  }
  lines.push('')
  lines.push(`🛒 *${p}empire premium buy <item>* — purchase`)
  lines.push(`🔍 *${p}empire premium info <item>* — full details`)
  lines.push(`⛏️ *${p}empire premium claim* — collect your Gem Miner's daily find`)
  return lines.join('\n')
}

function infoView(item, p) {
  const lines = [
    `${item.emoji} *${item.name}*  ·  💎${item.priceGems}`,
    `📖 ${item.detail.replaceAll('{prefix}', p)}`,
  ]
  if (item.id === 'gem_miner')      lines.push(`_One-time buy. Owning more than one does nothing extra._`)
  if (item.id === 'warehouse_permit') lines.push(`_Stacks: each purchase adds another +${item.warehouseBonus} on top of what you already hold._`)
  return lines.join('\n')
}

// ── Buy ─────────────────────────────────────────────────────────────────────

async function handleBuy(ctx, query) {
  const p = config.prefix
  if (!query) {
    return ctx.reply(
      `❌ *Usage:* *${p}empire premium buy <item>*\n` +
      `_See what's on offer with *${p}empire premium*._`
    )
  }
  const item = findPremiumItem(query)
  if (!item) {
    return ctx.reply(`❌ *"${query}"* isn't in the premium shop.\n_See *${p}empire premium* for the list._`)
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const owned = getOwnedEmpire(ctx.db, ctx.from)
    if (!owned) { outcome = { reason: 'noEmpire' }; return player }
    if (item.id === 'gem_miner' && player.ownsGemMiner) { outcome = { reason: 'already' }; return player }

    const gems = player.wallet?.gems ?? 0
    if (gems < item.priceGems) { outcome = { reason: 'poor', have: gems }; return player }

    const wallet = player.wallet ?? (player.wallet = {})
    wallet.gems = roundGems(gems - item.priceGems)

    if (item.id === 'gem_miner') {
      player.ownsGemMiner = true
    } else if (item.id === 'warehouse_permit') {
      const rec = ctx.db.data.empires?.[owned.id]
      if (!rec) { outcome = { reason: 'noEmpire' }; return player }
      rec.premiumPermits = (rec.premiumPermits ?? 0) + 1
      outcome = {
        reason: 'ok', item, balance: wallet.gems,
        newCap: warehouseCap(rec), permits: rec.premiumPermits,
      }
      return player
    } else if (item.id === 'rename_scroll') {
      // Purchase alone doesn't rename anything — it just grants a pending
      // rename so a botched .empire premium buy rename_scroll can't lose
      // gems to a typo'd name in the same breath. The follow-up command
      // (.empire premium rename <new name>) consumes it.
      player.pendingRenameScroll = true
      outcome = { reason: 'ok', item, balance: wallet.gems, needsRename: true }
      return player
    }

    outcome = { reason: 'ok', item, balance: wallet.gems }
    return player
  })

  if (outcome?.reason === 'noEmpire') return ctx.reply(noEmpire(p))
  if (outcome?.reason === 'already') {
    return ctx.reply(`⛏️ You already own a *Gem Miner*. Claim its find with *${p}empire premium claim*.`)
  }
  if (outcome?.reason === 'poor') {
    return ctx.reply(
      `❌ *Not enough Gems!*\n` +
      `*${item.name}* costs 💎 *${item.priceGems}*, you have 💎 *${fmtGems(outcome.have)}*.`
    )
  }

  if (outcome.item.id === 'warehouse_permit') {
    return ctx.reply(
      `🛒 *Purchase complete!*\n\n` +
      `📜 *Warehouse Permit* ×${outcome.permits}\n` +
      `💰 Paid: 💎 *${item.priceGems}*  ·  Balance: 💎 *${fmtGems(outcome.balance)}*\n` +
      `📦 Warehouse capacity is now *${outcome.newCap.toLocaleString()}*.`
    )
  }
  if (outcome.needsRename) {
    return ctx.reply(
      `🛒 *Purchase complete!*\n\n` +
      `🪶 *Rename Scroll*\n` +
      `💰 Paid: 💎 *${item.priceGems}*  ·  Balance: 💎 *${fmtGems(outcome.balance)}*\n\n` +
      `_Use it now: *${p}empire premium rename <new name>*._`
    )
  }
  if (outcome.item.id === 'gem_miner') {
    return ctx.reply(
      `🛒 *Purchase complete!*\n\n` +
      `⛏️ *Gem Miner*\n` +
      `💰 Paid: 💎 *${item.priceGems}*  ·  Balance: 💎 *${fmtGems(outcome.balance)}*\n\n` +
      `_It starts working right away. Claim its first find any time with *${p}empire premium claim*._`
    )
  }
  return ctx.reply(`🛒 *Purchase complete!* ${outcome.item.emoji} *${outcome.item.name}*.`)
}

// ── Claim (Gem Miner) ────────────────────────────────────────────────────────

async function handleClaim(ctx) {
  const p = config.prefix

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    if (!player.ownsGemMiner) { outcome = { reason: 'noMiner' }; return player }

    const now         = Date.now()
    const todayStart   = startOfDay(now)
    const last         = player.lastGemMineClaim ?? 0
    const lastDayStart = last ? startOfDay(last) : null
    if (lastDayStart === todayStart) {
      const next = todayStart + 24 * 60 * 60 * 1000
      outcome = { reason: 'already', remaining: next - now }
      return player
    }

    player.lastGemMineClaim = now
    const wallet = player.wallet ?? (player.wallet = {})
    wallet.gems = roundGems((wallet.gems ?? 0) + 1)
    outcome = { reason: 'ok', balance: wallet.gems }
    return player
  })

  if (outcome?.reason === 'noMiner') {
    return ctx.reply(
      `⛏️ You don't own a *Gem Miner* yet.\n` +
      `Buy one with *${p}empire premium buy gem_miner* — 💎200.`
    )
  }
  if (outcome?.reason === 'already') {
    return ctx.reply(`⏳ Your Gem Miner already delivered today. Next find in *${fmtDuration(outcome.remaining)}*.`)
  }
  return ctx.reply(
    `⛏️ *Your Gem Miner strikes gold!*\n` +
    `💎 +1 Gem  ·  Balance: 💎 *${fmtGems(outcome.balance)}*\n` +
    `_Come back in 24h for the next find._`
  )
}

// ── Rename (Rename Scroll) ───────────────────────────────────────────────────

async function handleRename(ctx, rawName) {
  const p = config.prefix
  const check = validateName(rawName)
  if (!check.ok) return ctx.reply(`❌ ${check.reason}`)
  const cleanName = check.name

  // exceptId so a cosmetic re-spelling of the empire's OWN name ("Iron Hold" ->
  // "Iron hold") isn't reported as taken by itself. Matches .empire rename.
  const ownedPre = getOwnedEmpire(ctx.db, ctx.from)
  if (empireNameTaken(ctx.db, cleanName, ownedPre?.id ?? null)) {
    return ctx.reply(`❌ The name *${cleanName}* is already taken. Pick another.`)
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const owned = getOwnedEmpire(ctx.db, ctx.from)
    if (!owned) { outcome = { reason: 'noEmpire' }; return player }
    if (!player.pendingRenameScroll) { outcome = { reason: 'noScroll' }; return player }
    if (empireNameTaken(ctx.db, cleanName, owned.id)) { outcome = { reason: 'taken' }; return player }

    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) { outcome = { reason: 'noEmpire' }; return player }

    const oldName = rec.name
    rec.name = cleanName // id/slug intentionally untouched — see file header
    player.pendingRenameScroll = false
    outcome = { reason: 'ok', oldName, newName: cleanName }
    return player
  })

  if (outcome?.reason === 'noEmpire') return ctx.reply(noEmpire(p))
  if (outcome?.reason === 'noScroll') {
    return ctx.reply(
      `🪶 You don't have a Rename Scroll ready.\n` +
      `Buy one with *${p}empire premium buy rename_scroll* — 💎120.`
    )
  }
  if (outcome?.reason === 'taken') return ctx.reply(`❌ The name *${cleanName}* is already taken. Pick another.`)

  return ctx.reply(
    `🪶 *The banners are struck and raised anew.*\n` +
    `*${outcome.oldName}* is now known as *${outcome.newName}*.`
  )
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export default {
  name:           'empire-premium',
  aliases:        ['premiumshop', 'empiershop', 'gemshop'],
  category:       'empire',
  requiresPlayer: true,
  description:    'The Empire Premium Shop: buy gem-powered empire perks like the Gem Miner',
  subcommands: [
    { cmd: '[list]',              desc: 'browse the premium catalog' },
    { cmd: 'buy <item>',          desc: 'purchase a premium item with gems' },
    { cmd: 'info <item>',         desc: 'see full details for a premium item' },
    { cmd: 'claim',               desc: "collect your Gem Miner's daily gem" },
    { cmd: 'rename <new name>',   desc: 'spend a Rename Scroll to rename your empire' },
  ],

  async run(ctx) {
    const p = config.prefix
    if (!(await gate(ctx))) return

    const sub = ctx.args[0]?.toLowerCase()

    if (sub === 'buy' || sub === 'purchase') {
      return handleBuy(ctx, ctx.args.slice(1).join(' ').trim().toLowerCase())
    }
    if (sub === 'info' || sub === 'inspect') {
      const item = findPremiumItem(ctx.args.slice(1).join(' '))
      if (!item) return ctx.reply(`❌ *"${ctx.args.slice(1).join(' ')}"* isn't in the premium shop.`)
      return ctx.reply(infoView(item, p))
    }
    if (sub === 'claim') return handleClaim(ctx)
    if (sub === 'rename') return handleRename(ctx, ctx.args.slice(1).join(' '))

    // Bare / "list" — show the catalog. Requires an owned empire only for
    // this view's header context; buy/claim/rename each re-check ownership
    // themselves inside their own mutator.
    const owned = getOwnedEmpire(ctx.db, ctx.from)
    if (!owned) return ctx.reply(noEmpire(p))
    const me = ctx.db.data.users?.[ctx.from] ?? ctx.player
    const gems = me?.wallet?.gems ?? 0
    return ctx.reply(catalogView(owned, gems, p))
  },
}
