/**
 * card.js — one consolidated command for the entire anime card system:
 * viewing your collection, inspecting a card, gifting/trading between
 * players, selling, setting a battle-main card, and the global player
 * marketplace (list/buy/delist), plus a top-collectors leaderboard.
 *
 * Subcommands (see USAGE below, shown by `.card` with no args):
 *   .card [page]                       — view your collection (alias: .card deck)
 *   .card info <number|name>           — inspect one of your owned cards
 *   .card give <number|id> @user       — gift a card to another player
 *   .card trade <mine> <theirs> @user  — propose a card swap
 *   .card trade accept                 — accept a pending trade proposal
 *   .card sell <number|name>           — sell a card for Solars
 *   .card main <number|id>             — set your battle-main card
 *   .card market [page]                — view the global marketplace
 *   .card list <number|id> <price>     — list one of your cards for sale
 *   .card buy <market_number>          — buy a listed card
 *   .card delist <market_number>       — pull your own listing back
 *   .card top                          — leaderboard of top collectors
 *
 * Ideas for give/trade/market/info/leaderboard flow ported from an older
 * bot's card plugin set, rewritten from scratch against this bot's actual
 * data model: player.cards[] is a plain array (not stacked-count Mongo
 * docs), cards come from the live Cards API via lib/card-engine.js (not a
 * local JSON pool), and storage is lowdb (see lib/player-repo.js and
 * lib/market-repo.js), not Mongoose. Any card-shaped object below matches
 * lib/card-engine.js's toOwnedCard() output: { id, title, imageUrl, tier,
 * series, claimedAt }.
 *
 * Multi-party mutations (give, trade, buy) use sequential updatePlayer()
 * calls — same convention as plugins/friend.js, plugins/rob.js, and
 * plugins/pvp.js — rather than a single cross-player transaction, since
 * lib/player-repo.js's write queue only guarantees safety per-call, not
 * across multiple calls. This mirrors this bot's existing pattern
 * everywhere else player-to-player mutations happen.
 */
import { config } from '../config.js'
import { getPlayer, updatePlayer, playerExists } from '../lib/player-repo.js'
import { getMarketListings, createListing, removeListing, findListing } from '../lib/market-repo.js'
import { findOwnedCard, tierStars, cardSellPrice, tierRank } from '../lib/card-engine.js'
import { cardMediaPayload } from '../lib/card-media.js'

const DECK_PAGE_SIZE   = 10
const MARKET_PAGE_SIZE = 10

// In-memory pending card-trade proposals, targetJid -> proposal. Mirrors
// lib/card-spawn-state.js's in-memory-only pattern — a proposal still
// pending when the bot restarts is simply gone, which is fine for an
// opt-in trade prompt with its own expiry anyway.
const pendingTrades = new Map()
const TRADE_EXPIRY_MS = 60_000

function resolveTargetJid(ctx, raw) {
  const contextInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo
  if (contextInfo?.participant) return contextInfo.participant
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0]
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

/** Cards sorted the same way everywhere in this file: rarest first, then alphabetical. */
function sortedCards(cards) {
  return [...cards].sort((a, b) => {
    const tierDiff = tierRank(b.tier) - tierRank(a.tier)
    if (tierDiff !== 0) return tierDiff
    return (a.title ?? '').localeCompare(b.title ?? '')
  })
}

/**
 * Resolves a "number or name" argument against a player's owned cards,
 * where "number" means the 1-indexed position in their sorted deck (same
 * ordering .card / .card info displays), matching Marin's deck-number UX.
 */
function resolveOwnedCardArg(player, arg) {
  const cards = player.cards ?? []
  if (!arg) return null
  if (/^\d+$/.test(arg)) {
    const idx = parseInt(arg, 10) - 1
    const sorted = sortedCards(cards)
    return sorted[idx] ?? null
  }
  return findOwnedCard(player, arg)
}

/**
 * Sends a card (or market listing) with its image/video, correct caption,
 * mentions, and footer. Falls back gracefully to a text-only reply if the
 * card has no image at all.
 *
 * Media shape comes from lib/card-media.js: gif URLs are transcoded to MP4
 * first (a raw .gif sent as `{ video: { url } }` silently fails to play on
 * WhatsApp — the old behavior here), real video URLs loop directly, and a
 * gif whose transcode fails still degrades to its first frame as an image.
 */
async function sendCard(sock, jid, quoted, card, { caption, mentions = [], footer } = {}) {
  if (!card?.imageUrl) {
    return sock.sendMessage(jid, { text: caption ?? '' }, { quoted })
  }
  const payload = await cardMediaPayload(card.imageUrl, caption, { mentions, footer })
  return sock.sendMessage(jid, payload, { quoted })
}

function cardBlurb(card) {
  return (
    `${tierStars(card.tier)} *${card.title}*\n` +
    `📺 _${card.series}_\n` +
    `☀️ Worth: *${cardSellPrice(card.tier)}* Solars _(if sold)_`
  )
}

const USAGE = (pr) =>
  `🎴 *Card Commands*\n\n` +
  `▹ *${pr}card [page]* — view your collection\n` +
  `▹ *${pr}card info <number|name>* — inspect a card\n` +
  `▹ *${pr}card give <number|id> @user* — gift a card\n` +
  `▹ *${pr}card trade <mine> <theirs> @user* — propose a trade\n` +
  `▹ *${pr}card trade accept* — accept a pending trade\n` +
  `▹ *${pr}card sell <number|name>* — sell for Solars\n` +
  `▹ *${pr}card main <number|id>* — set your battle-main card\n` +
  `▹ *${pr}card market [page]* — browse the global marketplace\n` +
  `▹ *${pr}card list <number|id> <price>* — list a card for sale\n` +
  `▹ *${pr}card buy <market_number>* — buy a listed card\n` +
  `▹ *${pr}card delist <market_number>* — reclaim your own listing\n` +
  `▹ *${pr}card top* — top collectors leaderboard`

export default {
  name: 'card',
  aliases: ['cards', 'cardmenu'],
  category: 'cards',
  requiresPlayer: true,
  description: 'View, gift, trade, sell, and market your anime cards — see .card for the full subcommand list',
  // Keep in sync with USAGE above — this is what plugins/menu.js expands
  // under .menu cards, USAGE above is what .card with no args shows.
  subcommands: [
    { cmd: '[page]',                          desc: 'view your collection (alias: .card deck)' },
    { cmd: 'info <number|name>',              desc: 'inspect one of your owned cards' },
    { cmd: 'give <number|id> @user',          desc: 'gift a card to another player' },
    { cmd: 'trade <mine> <theirs> @user',     desc: 'propose a card swap' },
    { cmd: 'trade accept',                    desc: 'accept a pending trade proposal' },
    { cmd: 'sell <number|name>',              desc: 'sell a card for Solars' },
    { cmd: 'main <number|id>',                desc: 'set your battle-main card' },
    { cmd: 'market [page]',                   desc: 'view the global marketplace' },
    { cmd: 'list <number|id> <price>',        desc: 'list one of your cards for sale' },
    { cmd: 'buy <market_number>',             desc: 'buy a listed card' },
    { cmd: 'delist <market_number>',          desc: "pull your own listing back" },
    { cmd: 'top',                             desc: 'leaderboard of top collectors' },
  ],

  async run(ctx) {
    const { args, reply, player, db, sock, msg } = ctx
    const pr  = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    // ── DECK (default, no subcommand, or explicit "deck") ─────────────────
    if (!sub || sub === 'deck' || /^\d+$/.test(sub)) {
      const pageArg = /^\d+$/.test(sub) ? sub : args[1]
      return handleDeck(ctx, pageArg)
    }

    if (sub === 'info')   return handleInfo(ctx)
    if (sub === 'give')   return handleGive(ctx)
    if (sub === 'trade')  return handleTrade(ctx)
    if (sub === 'sell')   return handleSell(ctx)
    if (sub === 'main')   return handleMain(ctx)
    if (sub === 'market') return handleMarket(ctx)
    if (sub === 'list')   return handleList(ctx)
    if (sub === 'buy')    return handleBuy(ctx)
    if (sub === 'delist') return handleDelist(ctx)
    if (sub === 'top' || sub === 'leaderboard') return handleTop(ctx)

    return reply(USAGE(pr))
  },
}

// ── .card [page] ─────────────────────────────────────────────────────────
async function handleDeck(ctx, pageArg) {
  const { reply, player } = ctx
  const pr = config.prefix
  const cards = player.cards ?? []

  if (!cards.length) {
    return reply(
      `🎴 *${player.name}'s Deck*\n\n` +
      `_Empty._\n\n` +
      `_Cards spawn in enabled groups — grab one with *${pr}collect <code>*._`
    )
  }

  const page = Math.max(1, parseInt(pageArg, 10) || 1)
  const totalPages = Math.max(1, Math.ceil(cards.length / DECK_PAGE_SIZE))
  const clamped = Math.min(page, totalPages)
  const start = (clamped - 1) * DECK_PAGE_SIZE
  const sorted = sortedCards(cards)
  const pageItems = sorted.slice(start, start + DECK_PAGE_SIZE)

  const lines = pageItems.map((c, i) => {
    const waifuTag = player.waifuId === c.id ? ' 💘' : ''
    return `*#${start + i + 1}* ${tierStars(c.tier)} *${c.title}*${waifuTag}\n     _${c.series} · ☀️${cardSellPrice(c.tier)}_`
  })

  const footer = totalPages > 1
    ? `\n\n📄 _Page ${clamped}/${totalPages}_` + (clamped < totalPages ? `   ▶️ *${pr}card ${clamped + 1}*` : '')
    : ''

  return reply(
    `🎴 *${player.name}'s Deck* _(${cards.length} card${cards.length === 1 ? '' : 's'})_\n\n` +
    lines.join('\n\n') +
    footer +
    `\n\n_${pr}card info <#>_ · _${pr}card sell <#>_ · _${pr}card give <#> @user_`
  )
}

// ── .card info <number|name> ──────────────────────────────────────────────
async function handleInfo(ctx) {
  const { args, reply, player, sock, msg } = ctx
  const pr = config.prefix
  const query = args.slice(1).join(' ').trim()
  if (!query) return reply(`❓ Usage: *${pr}card info <number|name>*`)

  const card = resolveOwnedCardArg(player, query)
  if (!card) return reply(`❌ No card matching *"${query}"* in your deck.`)

  const caption =
    `✨ *CARD INSPECTION* ✨\n\n` +
    `🃏 *${card.title}*\n` +
    `📺 *Series:* ${card.series}\n` +
    `🔰 *Rarity:* ${tierStars(card.tier)}\n` +
    `🆔 *Card ID:* \`${card.id}\`\n` +
    `📅 *Obtained:* ${new Date(card.claimedAt).toDateString()}\n` +
    `💰 *Sell Value:* ${cardSellPrice(card.tier).toLocaleString()} Solars\n\n` +
    (player.waifuId === card.id ? `💘 _This is your current waifu._\n\n` : '') +
    `_${pr}card sell ${query}_ · _${pr}card main ${query}_`

  return sendCard(sock, msg.key.remoteJid, msg, card, { caption, footer: `${ctx.botName ?? config.botName} · Card Info` })
}

// ── .card give <number|id> @user ───────────────────────────────────────────
async function handleGive(ctx) {
  const { args, reply, player, db, sock, msg } = ctx
  const pr = config.prefix
  const cardArg = args[1]
  const targetJid = resolveTargetJid(ctx, args[2])

  if (!cardArg || !targetJid) {
    return reply(`🎁 Usage: *${pr}card give <number|id> @user*`)
  }
  if (targetJid === ctx.from) {
    return reply(`😅 You can't gift yourself a card.`)
  }
  if (!playerExists(db, targetJid)) {
    return reply(`❌ That player isn't registered yet.`)
  }

  const card = resolveOwnedCardArg(player, cardArg)
  if (!card) return reply(`🚫 You don't own a card matching *"${cardArg}"*.`)

  // Remove from sender, add to recipient — sequential updatePlayer calls,
  // same two-party pattern as plugins/friend.js.
  await updatePlayer(db, ctx.from, (p) => {
    p.cards = (p.cards ?? []).filter(c => c.id !== card.id)
    if (p.waifuId === card.id) p.waifuId = null
    return p
  })
  await updatePlayer(db, targetJid, (t) => {
    if (!Array.isArray(t.cards)) t.cards = []
    t.cards.push(card)
    return t
  })

  const targetName = getPlayer(db, targetJid)?.name ?? targetJid.split('@')[0]
  const caption =
    `🎁 *CARD GIFT SENT!*\n\n` +
    `👤 *From:* ${player.name}\n` +
    `👤 *To:* @${targetJid.split('@')[0]}\n\n` +
    cardBlurb(card)

  return sendCard(sock, msg.key.remoteJid, msg, card, {
    caption,
    mentions: [ctx.from, targetJid],
    footer: `${ctx.botName ?? config.botName} · Gift Center`,
  })
}

// ── .card trade <mine> <theirs> @user  /  .card trade accept ──────────────
async function handleTrade(ctx) {
  const { args, reply, player, db, sock, msg } = ctx
  const pr = config.prefix
  const sub2 = (args[1] ?? '').toLowerCase()

  // ── ACCEPT ────────────────────────────────────────────────────────────
  if (sub2 === 'accept') {
    const proposal = pendingTrades.get(ctx.from)
    if (!proposal) return reply(`❌ No pending trade requests for you!`)

    const initiatorPlayer = getPlayer(db, proposal.initiatorId)
    const myCard    = findOwnedCard(player, proposal.theirCardId)   // the card THIS player is giving up (was "their" card from the proposer's perspective)
    const theirCard = initiatorPlayer && findOwnedCard(initiatorPlayer, proposal.myCardId)

    if (!myCard || !theirCard) {
      pendingTrades.delete(ctx.from)
      return reply(`⚠️ Trade failed — one of you no longer owns the required card.`)
    }

    // Swap: sequential updatePlayer calls per side.
    await updatePlayer(db, ctx.from, (p) => {
      p.cards = (p.cards ?? []).filter(c => c.id !== myCard.id)
      if (p.waifuId === myCard.id) p.waifuId = null
      p.cards.push(theirCard)
      return p
    })
    await updatePlayer(db, proposal.initiatorId, (p) => {
      p.cards = (p.cards ?? []).filter(c => c.id !== theirCard.id)
      if (p.waifuId === theirCard.id) p.waifuId = null
      p.cards.push(myCard)
      return p
    })

    pendingTrades.delete(ctx.from)

    const caption =
      `🤝 *TRADE SUCCESSFUL!*\n\n` +
      `✨ Cards have been swapped!\n` +
      `👤 *${player.name}* received: *${theirCard.title}*\n` +
      `👤 *@${proposal.initiatorId.split('@')[0]}* received: *${myCard.title}*`

    return sendCard(sock, msg.key.remoteJid, msg, theirCard, {
      caption,
      mentions: [ctx.from, proposal.initiatorId],
      footer: `${ctx.botName ?? config.botName} · Trade Center`,
    })
  }

  // ── PROPOSE ───────────────────────────────────────────────────────────
  const myCardArg = args[1]
  const theirCardArg = args[2]
  const targetJid = resolveTargetJid(ctx, args[3])

  if (!myCardArg || !theirCardArg || !targetJid) {
    return reply(`🤝 Usage: *${pr}card trade <your_card> <their_card> @user*`)
  }
  if (targetJid === ctx.from) return reply(`😐 You can't trade with yourself.`)
  if (!playerExists(db, targetJid)) return reply(`❌ That player isn't registered yet.`)

  const myCard = resolveOwnedCardArg(player, myCardArg)
  if (!myCard) return reply(`🚫 You don't own the card you're offering.`)

  const targetPlayer = getPlayer(db, targetJid)
  const theirCard = findOwnedCard(targetPlayer, theirCardArg)
  if (!theirCard) return reply(`🚫 Target player doesn't own that card.`)

  pendingTrades.set(targetJid, {
    initiatorId: ctx.from,
    myCardId: myCard.id,
    theirCardId: theirCard.id,
  })
  setTimeout(() => {
    const current = pendingTrades.get(targetJid)
    if (current?.initiatorId === ctx.from) pendingTrades.delete(targetJid)
  }, TRADE_EXPIRY_MS)

  const caption =
    `🔄 *TRADE PROPOSAL!*\n\n` +
    `👤 *From:* ${player.name}\n` +
    `📤 *Offers:* ${myCard.title} (${tierStars(myCard.tier)})\n\n` +
    `👤 *To:* @${targetJid.split('@')[0]}\n` +
    `📥 *Wants:* ${theirCard.title} (${tierStars(theirCard.tier)})\n\n` +
    `✨ Accept with *${pr}card trade accept* within 60 seconds!`

  return sendCard(sock, msg.key.remoteJid, msg, myCard, {
    caption,
    mentions: [targetJid],
    footer: `${ctx.botName ?? config.botName} · Trade Center`,
  })
}

// ── .card sell <number|name> ───────────────────────────────────────────────
// Same logic as the standalone plugins/sellcard.js — kept in sync
// deliberately; see that file's docstring.
async function handleSell(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix
  const query = args.slice(1).join(' ').trim()
  if (!query) return reply(`❌ Usage: *${pr}card sell <number|name>*`)

  let outcome = null
  await updatePlayer(db, player.id, p => {
    const card = resolveOwnedCardArg(p, query)
    if (!card) { outcome = { ok: false }; return }
    if (p.waifuId === card.id) { outcome = { ok: false, isWaifu: true, card }; return }

    const price = cardSellPrice(card.tier)
    p.cards = (p.cards ?? []).filter(c => c.id !== card.id)
    p.wallet.solars = (p.wallet?.solars ?? 0) + price

    outcome = { ok: true, card, price, balance: p.wallet.solars }
  })

  if (!outcome?.ok) {
    if (outcome?.isWaifu) {
      return reply(
        `❌ *${outcome.card.title}* is your current waifu — can't sell her.\n` +
        `_Set a different waifu first._`
      )
    }
    return reply(`❌ You don't own a card matching *"${query}"*.`)
  }

  return reply(
    `💰 *Sold!*\n\n` +
    `${tierStars(outcome.card.tier)} *${outcome.card.title}*\n` +
    `☀️ Earned: *${outcome.price}* Solars\n` +
    `☀️ Balance: *${outcome.balance}*`
  )
}

// ── .card main <number|id> ─────────────────────────────────────────────────
async function handleMain(ctx) {
  const { args, reply, player, db, sock, msg } = ctx
  const pr = config.prefix
  const cardArg = args.slice(1).join(' ').trim()
  if (!cardArg) return reply(`🛡️ Usage: *${pr}card main <number|id>*`)

  const card = resolveOwnedCardArg(player, cardArg)
  if (!card) return reply(`🚫 You don't own a card matching *"${cardArg}"*.`)

  await updatePlayer(db, player.id, p => {
    p.mainCardId = card.id
    return p
  })

  const caption =
    `🛡️ *MAIN CARD EQUIPPED!*\n\n` +
    `This card will now represent you in card battles.\n\n` +
    cardBlurb(card)

  return sendCard(sock, msg.key.remoteJid, msg, card, { caption, footer: `${ctx.botName ?? config.botName} · Barracks` })
}

// ── .card market [page] ────────────────────────────────────────────────────
async function handleMarket(ctx) {
  const { args, reply, db, sock, msg } = ctx
  const pr = config.prefix
  const listings = await getMarketListings(db)

  if (!listings.length) {
    return reply(
      `🏪 *The Market is Empty!*\n\n` +
      `Be the first to list a card:\n*${pr}card list <number|id> <price>*`
    )
  }

  const page = Math.max(1, parseInt(args[1], 10) || 1)
  const totalPages = Math.ceil(listings.length / MARKET_PAGE_SIZE)
  if (page > totalPages) return reply(`❌ Invalid page! Only *${totalPages}* pages available.`)

  const start = (page - 1) * MARKET_PAGE_SIZE
  const pageItems = listings.slice(start, start + MARKET_PAGE_SIZE)

  let text = `🏪 *GLOBAL CARD MARKET*\n📄 Page: *${page}/${totalPages}* · 📦 Listed: *${listings.length}*\n\n💳 Buy with *${pr}card buy <number>*\n━━━━━━━━━━━━━━━━━━\n`
  pageItems.forEach((listing, i) => {
    const num = start + i + 1
    text += `*#${num}* *${listing.card.title}*\n   ${tierStars(listing.card.tier)}  💰 *${listing.price.toLocaleString()}* Solars\n   👤 @${listing.sellerId.split('@')[0]}\n━━━━━━━━━━━━━━━━━━\n`
  })
  if (page < totalPages) text += `👉 Next page: *${pr}card market ${page + 1}*`

  return sock.sendMessage(msg.key.remoteJid, {
    text,
    mentions: pageItems.map(l => l.sellerId),
  }, { quoted: msg })
}

// ── .card list <number|id> <price> ─────────────────────────────────────────
async function handleList(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix
  const cardArg = args[1]
  const price = parseInt(args[2], 10)

  if (!cardArg || !price || price <= 0) {
    return reply(`🏷️ Usage: *${pr}card list <number|id> <price>*`)
  }

  const card = resolveOwnedCardArg(player, cardArg)
  if (!card) return reply(`🚫 You don't own a card matching *"${cardArg}"*.`)
  if (player.waifuId === card.id) {
    return reply(`❌ *${card.title}* is your current waifu — can't list her.`)
  }

  // Remove from the player's deck first, then create the listing —
  // if this player double-submits the same card faster than the queue
  // clears, updatePlayer's re-read-before-mutate guarantees the second
  // call simply won't find the card anymore.
  let removed = false
  await updatePlayer(db, player.id, p => {
    const before = (p.cards ?? []).length
    p.cards = (p.cards ?? []).filter(c => c.id !== card.id)
    removed = p.cards.length < before
    return p
  })
  if (!removed) return reply(`🚫 You don't own that card anymore.`)

  const listing = await createListing(db, player.id, card, price)

  return reply(
    `🏪 *Listed for sale!*\n\n` +
    `${tierStars(card.tier)} *${card.title}*\n` +
    `💰 Asking: *${price.toLocaleString()}* Solars\n\n` +
    `_Reclaim anytime with *${pr}card delist ${listing.id}*._`
  )
}

// ── .card buy <market_number|listing_id> ───────────────────────────────────
async function handleBuy(ctx) {
  const { args, reply, player, db, sock, msg } = ctx
  const pr = config.prefix
  const arg = args[1]
  if (!arg) return reply(`💳 Usage: *${pr}card buy <market_number>*`)

  const listings = await getMarketListings(db)
  let listing = null
  if (/^\d+$/.test(arg)) {
    listing = listings[parseInt(arg, 10) - 1] ?? null
  } else {
    listing = await findListing(db, arg)
  }
  if (!listing) return reply(`❌ No listing found at *"${arg}"*.`)
  if (listing.sellerId === player.id) {
    return reply(`😅 You can't buy your own listing! Use *${pr}card delist ${arg}* to reclaim it.`)
  }

  const price = listing.price
  const balance = player.wallet?.solars ?? 0
  if (balance < price) {
    return reply(
      `💸 *Insufficient Funds!*\n\n` +
      `Price: *${price.toLocaleString()}* Solars\n` +
      `You have: *${balance.toLocaleString()}*`
    )
  }

  // Remove the listing first so a concurrent buyer can't double-purchase it.
  const claimed = await removeListing(db, listing.id)
  if (!claimed) return reply(`❌ That listing was just bought by someone else!`)

  await updatePlayer(db, player.id, p => {
    p.wallet.solars = (p.wallet.solars ?? 0) - price
    if (!Array.isArray(p.cards)) p.cards = []
    p.cards.push(claimed.card)
    return p
  })
  await updatePlayer(db, claimed.sellerId, p => {
    p.wallet.solars = (p.wallet.solars ?? 0) + price
    return p
  })

  const caption =
    `🎉 *Purchase Successful!*\n\n` +
    cardBlurb(claimed.card) +
    `\n\n👤 *Seller:* @${claimed.sellerId.split('@')[0]}\n` +
    `🆕 *New Owner:* ${player.name}`

  return sendCard(sock, msg.key.remoteJid, msg, claimed.card, {
    caption,
    mentions: [claimed.sellerId],
    footer: `${ctx.botName ?? config.botName} · Market`,
  })
}

// ── .card delist <market_number|listing_id> ────────────────────────────────
async function handleDelist(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix
  const arg = args[1]
  if (!arg) return reply(`↩️ Usage: *${pr}card delist <market_number>*`)

  const myListings = (await getMarketListings(db)).filter(l => l.sellerId === player.id)
  let listing = null
  if (/^\d+$/.test(arg)) {
    listing = myListings[parseInt(arg, 10) - 1] ?? null
  } else {
    const found = await findListing(db, arg)
    listing = found?.sellerId === player.id ? found : null
  }
  if (!listing) return reply(`🚫 You don't have a listing matching *"${arg}"*.`)

  const removed = await removeListing(db, listing.id)
  if (!removed) return reply(`❌ That listing is already gone.`)

  await updatePlayer(db, player.id, p => {
    if (!Array.isArray(p.cards)) p.cards = []
    p.cards.push(removed.card)
    return p
  })

  return reply(
    `↩️ *Card retrieved!*\n\n` +
    `${tierStars(removed.card.tier)} *${removed.card.title}*\n` +
    `_Removed from the market and returned to your deck._`
  )
}

// ── .card top ───────────────────────────────────────────────────────────────
async function handleTop(ctx) {
  const { reply, db } = ctx
  await db.read()
  const users = Object.values(db.data.users ?? {})

  const ranked = users
    .map(p => ({ id: p.id, name: p.name, count: (p.cards ?? []).length }))
    .filter(p => p.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  if (!ranked.length) {
    return reply(`No one has collected any cards yet — be the first! 🥇`)
  }

  const medals = ['🥇', '🥈', '🥉']
  let text = `🏆 *TOP CARD COLLECTORS* 🏆\n\n`
  ranked.forEach((p, i) => {
    const rank = medals[i] ?? `*${i + 1}.*`
    text += `${rank} *${p.name}* — ${p.count} card${p.count === 1 ? '' : 's'} 🃏\n`
  })

  return reply(text)
}
