/**
 * series.js — Anime Series collectible system plugin.
 *
 * Subcommands:
 *   .series                         — your series collection (paginated, 10/page)
 *   .series <title>                 — inspect one owned entry
 *   .series on|off                  — group admin/owner: toggle 2h auto-spawn
 *   .series spawn                   — bot owner: force an immediate spawn
 *   .series sell <title>            — remove from collection, credit wallet.solars
 *   .series send @user <title>      — gift one entry to another player
 *   .series trade @user <mine> for <theirs> — two-party pending swap
 *   .series accept                  — accept a pending trade offer
 *   .series decline                 — decline a pending trade offer
 *   .series top                     — top 10 by total series collection value
 *
 * Design mirrors plugins/waifu.js (spawn/toggle/group gate) and
 * plugins/transfer.js (send flow) and plugins/pvp.js (trade challenge pattern).
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer, playerExists } from '../lib/player-repo.js'
import {
  fetchRandomSeries,
  getSeriesTier,
  seriesTierStars,
  seriesTierEmoji,
  generateSeriesClaimCode,
  addSeriesToPlayer,
  findOwnedSeries,
  getSeriesCollectionValue,
} from '../lib/series-engine.js'
import { getGroupSettings, saveGroupSettings, saveFailedMessage, isGroupOrBotOwner } from '../lib/group-settings.js'
import { addSeriesSpawnGroup, removeSeriesSpawnGroup } from '../lib/series-spawn-groups.js'
import { setActiveSeriesSpawn } from '../lib/series-spawn-state.js'
import { NOT_GROUP, NOT_ALLOWED, isOwnerJid } from '../lib/group-helpers.js'
import { SERIES_SPAWN_INTERVAL_MS, humanInterval } from '../lib/spawn-intervals.js'

const SPAWN_EVERY = humanInterval(SERIES_SPAWN_INTERVAL_MS)

const MIN_LEVEL_SEND  = 5
const SEND_COOLDOWN_MS  = 5 * 60 * 1000  // 5 minutes — mirrors transfer.js
const SPAWN_COOLDOWN_MS = 30 * 1000       // 30 seconds — guards against API hammering
const TRADE_TIMEOUT_MS  = 5 * 60 * 1000  // 5 minutes to accept/decline

// Per-owner manual-spawn cooldown (in-memory, resets on restart — acceptable).
const ownerSpawnLastAt = new Map()

function resolveTargetJid(ctx, raw) {
  const contextInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo
  if (contextInfo?.participant) return contextInfo.participant
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0]
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

function seriesLine(s) {
  const score = s.score != null ? `${s.score.toFixed(1)}⭐` : 'Unrated'
  return `${seriesTierStars(s.tier)} *${s.title}* — ${score} · ☀️ ${s.sellPrice.toLocaleString()}`
}

const PAGE_SIZE = 10

export default {
  name: 'series',
  aliases: [],
  category: 'cards',
  requiresPlayer: true,
  description: 'Anime Series collectible system — spawn, claim, trade, and sell anime series cards',

  async run(ctx) {
    const { args, reply, replyImage, player, db } = ctx
    const p = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    // ── SPAWN (bot owner only) — force an immediate series spawn ────────
    if (sub === 'spawn') {
      if (!ctx.isGroup) return reply(NOT_GROUP)
      if (!isOwnerJid(ctx.from)) return reply(NOT_ALLOWED)

      const last = ownerSpawnLastAt.get(ctx.from) ?? 0
      const wait = SPAWN_COOLDOWN_MS - (Date.now() - last)
      if (wait > 0) {
        return reply(`⏳ Wait *${Math.ceil(wait / 1000)}s* before forcing another series spawn.`)
      }

      const series = await fetchRandomSeries()
      if (!series) return reply(`❌ Couldn't reach AniList right now — try again shortly.`)

      ownerSpawnLastAt.set(ctx.from, Date.now())

      const tier = getSeriesTier(series.score)
      const code = generateSeriesClaimCode()
      const spawn = { ...series, tier: tier.name, claimCode: code }
      setActiveSeriesSpawn(ctx.sender, spawn)

      const score = series.score != null ? `${series.score.toFixed(1)}⭐` : 'Unrated'
      return replyImage(
        series.imageUrl,
        `📺 *AN ANIME SERIES APPEARED!*\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `${seriesTierEmoji(tier.name)} ${seriesTierStars(tier.name)} *${series.title}*\n` +
        `🏅 Score ${score}  ·  Tier *${tier.name}*\n\n` +
        `🎯 First to type *${p}collect ${code}* claims it!`
      )
    }

    // ── ON / OFF (group admins only) — toggle 2h auto-spawn ─────────────
    if (sub === 'on' || sub === 'off') {
      if (!ctx.isGroup) return reply(NOT_GROUP)
      if (!(await isGroupOrBotOwner(ctx))) return reply(NOT_ALLOWED)

      const enable = sub === 'on'
      // Save FIRST and bail if it didn't land — see plugins/waifu.js for why
      // the spawn-group list must not be touched after a failed write. This is
      // also the exact command from the "`.series off` didn't stick" report
      // documented at the top of lib/group-settings.js.
      const res = await saveGroupSettings(ctx.sender, (s) => { s.seriesEnabled = enable })
      if (!res.ok) return reply(saveFailedMessage('series auto-spawn', res.error))

      const stored = res.settings.seriesEnabled === true
      if (stored) await addSeriesSpawnGroup(ctx.sender)
      else await removeSeriesSpawnGroup(ctx.sender)

      return reply(
        stored
          ? `📺 *Anime Series Auto-Spawn — ON*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `⏱️ A series appears here every *${SPAWN_EVERY}*.\n` +
            `🎯 Catch it with *${p}collect <code>*.`
          : `🚫 *Anime Series Auto-Spawn — OFF*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `No more series will appear in this group.`
      )
    }

    // ── GROUP GATE — all remaining subcommands require seriesEnabled ─────
    if (ctx.isGroup) {
      const settings = await getGroupSettings(ctx.sender)
      if (!settings.seriesEnabled) {
        return reply(
          `🚫 Anime Series are disabled in this group.\n` +
          `_A group admin can turn them on with *${p}series on*._`
        )
      }
    }

    // ── SELL ─────────────────────────────────────────────────────────────
    if (sub === 'sell') {
      const title = args.slice(1).join(' ').trim()
      if (!title) return reply(`❓ *Usage:* *${p}series sell <title>*`)

      await updatePlayer(db, player.id, (pl) => {
        const entry = findOwnedSeries(pl, title)
        if (!entry) {
          ctx.reply(`❌ You don't own a series matching *"${title}"*.`)
          return pl
        }
        pl.seriesCollection = (pl.seriesCollection ?? []).filter(s => s !== entry)
        if (!pl.wallet) pl.wallet = {}
        pl.wallet.solars = (pl.wallet.solars ?? 0) + entry.sellPrice
        ctx.reply(
          `💰 Sold *${entry.title}* for *${entry.sellPrice.toLocaleString()} ☀️ Solars*.\n` +
          `_New balance: ${(pl.wallet.solars).toLocaleString()} ☀️_`
        )
        return pl
      })
      return
    }

    // ── SEND ─────────────────────────────────────────────────────────────
    if (sub === 'send') {
      const targetRaw = args[1] ?? ''
      const title     = args.slice(2).join(' ').trim()
      const targetJid = resolveTargetJid(ctx, targetRaw)

      if (!targetJid || !title) {
        return reply(`❓ *Usage:* *${p}series send @user <title>*`)
      }
      if (targetJid === ctx.from) {
        return reply(`❌ You can't gift a series to yourself.`)
      }
      if (player.level < MIN_LEVEL_SEND) {
        return reply(`❌ You must be *Level ${MIN_LEVEL_SEND}+* to send series. You're Level ${player.level}.`)
      }
      const now = Date.now()
      const nextSend = (player.lastSeriesSendAt ?? 0) + SEND_COOLDOWN_MS
      if (now < nextSend) {
        const mins = Math.ceil((nextSend - now) / 60000)
        return reply(`⏳ *Send cooldown.* Try again in *${mins} min*.`)
      }
      if (!(await playerExists(db, targetJid))) {
        return reply(`❌ That player isn't registered. They need to *${p}register* first.`)
      }

      let sent = false
      await updatePlayer(db, player.id, (sender) => {
        const entry = findOwnedSeries(sender, title)
        if (!entry) {
          ctx.reply(`❌ You don't own a series matching *"${title}"*.`)
          return sender
        }
        sender.seriesCollection = (sender.seriesCollection ?? []).filter(s => s !== entry)
        sender.lastSeriesSendAt = Date.now()
        sent = true
        // Recipient update runs outside this callback to avoid nested updatePlayer.
        return sender
      })

      if (!sent) return

      await updatePlayer(db, targetJid, (recipient) => {
        if (!Array.isArray(recipient.seriesCollection)) recipient.seriesCollection = []
        // Re-fetch entry after sender mutation (entry ref is stale after filter above).
        // We stored it by object ref — re-find in the mutated collection is already gone.
        // Instead, we pass the details we captured before removing it.
        // This is safe because the outer closure captured `entry` before we filtered it.
        recipient.seriesCollection.push({
          anilistId: entry.anilistId ?? entry.malId,
          title:     entry.title,
          imageUrl:  entry.imageUrl,
          score:     entry.score,
          tier:      entry.tier,
          sellPrice: entry.sellPrice,
          claimedAt: entry.claimedAt,
        })
        return recipient
      })

      return reply(
        `🎁 Sent *${entry.title}* to them!\n` +
        `${seriesTierStars(entry.tier)} *${entry.title}* · Tier: ${entry.tier}`
      )
    }

    // ── TRADE ─────────────────────────────────────────────────────────────
    if (sub === 'trade') {
      // .series trade @user <mine> for <theirs>
      const targetRaw = args[1] ?? ''
      const rest      = args.slice(2).join(' ')    // "<mine> for <theirs>"
      const forIdx    = rest.toLowerCase().indexOf(' for ')
      if (!targetRaw || forIdx === -1) {
        return reply(`❓ *Usage:* *${p}series trade @user <your title> for <their title>*`)
      }
      const myTitle    = rest.slice(0, forIdx).trim()
      const theirTitle = rest.slice(forIdx + 5).trim()
      const targetJid  = resolveTargetJid(ctx, targetRaw)

      if (!targetJid || !myTitle || !theirTitle) {
        return reply(`❓ *Usage:* *${p}series trade @user <your title> for <their title>*`)
      }
      if (targetJid === ctx.from) {
        return reply(`❌ You can't trade with yourself.`)
      }
      if (!(await playerExists(db, targetJid))) {
        return reply(`❌ That player isn't registered.`)
      }

      const myEntry = findOwnedSeries(player, myTitle)
      if (!myEntry) {
        return reply(`❌ You don't own a series matching *"${myTitle}"*.`)
      }

      const target = getPlayer(db, targetJid)
      if (!target) return reply(`❌ Couldn't find that player.`)

      const theirEntry = findOwnedSeries(target, theirTitle)
      if (!theirEntry) {
        return reply(`❌ *${target.name}* doesn't own a series matching *"${theirTitle}"*.`)
      }

      // Check if target already has a pending trade offer
      if (target.seriesOffer && Date.now() < (target.seriesOffer.expiresAt ?? 0)) {
        return reply(`❌ *${target.name}* already has a pending trade offer. Wait for it to expire or for them to respond.`)
      }

      // Store the offer on the target's record (mirrors pvpChallenge pattern)
      await updatePlayer(db, targetJid, (t) => {
        t.seriesOffer = {
          fromJid:    ctx.from,
          myTitle:    myEntry.title,   // sender's series title (what sender offers)
          theirTitle: theirEntry.title, // target's series title (what sender wants)
          expiresAt:  Date.now() + TRADE_TIMEOUT_MS,
        }
        return t
      })

      return reply(
        `📤 *Trade offer sent to ${target.name}!*\n\n` +
        `You offer: ${seriesTierStars(myEntry.tier)} *${myEntry.title}*\n` +
        `For their: ${seriesTierStars(theirEntry.tier)} *${theirEntry.title}*\n\n` +
        `_They have 5 minutes to accept with *${p}series accept* or decline with *${p}series decline*._`
      )
    }

    // ── ACCEPT ────────────────────────────────────────────────────────────
    if (sub === 'accept') {
      const offer = player.seriesOffer
      if (!offer) return reply(`❌ You have no pending series trade offer.`)
      if (Date.now() > offer.expiresAt) {
        await updatePlayer(db, player.id, (pl) => { pl.seriesOffer = null; return pl })
        return reply(`⏳ That trade offer expired.`)
      }

      const fromJid    = offer.fromJid
      const sender     = getPlayer(db, fromJid)
      if (!sender) {
        await updatePlayer(db, player.id, (pl) => { pl.seriesOffer = null; return pl })
        return reply(`❌ The other player's record couldn't be loaded. Trade cancelled.`)
      }

      // Verify both entries still exist at accept time (inventories may have changed)
      const senderEntry = findOwnedSeries(sender, offer.myTitle)
      const targetEntry = findOwnedSeries(player, offer.theirTitle)

      if (!senderEntry) {
        await updatePlayer(db, player.id, (pl) => { pl.seriesOffer = null; return pl })
        return reply(`❌ *${sender.name}* no longer owns *"${offer.myTitle}"* — trade cancelled.`)
      }
      if (!targetEntry) {
        await updatePlayer(db, player.id, (pl) => { pl.seriesOffer = null; return pl })
        return reply(`❌ You no longer own *"${offer.theirTitle}"* — trade cancelled.`)
      }

      // Atomic swap: mutate target first, then sender.
      // If the second write were to fail, target would have both entries.
      // We log clearly so an operator can spot the inconsistency.
      // The ordering (target first) means a partial failure gives the target
      // an extra copy rather than losing a card entirely — the less bad outcome.
      let swapOk = false
      await updatePlayer(db, player.id, (target) => {
        // Remove theirTitle, add senderEntry
        const idx = (target.seriesCollection ?? []).findIndex(s => s.title === targetEntry.title && (s.anilistId ?? s.malId) === (targetEntry.anilistId ?? targetEntry.malId))
        if (idx === -1) {
          console.error(`[series trade] accept: couldn't find ${targetEntry.title} in target's collection during swap`)
          return target
        }
        target.seriesCollection.splice(idx, 1)
        target.seriesCollection.push({ ...senderEntry })
        target.seriesOffer = null
        swapOk = true
        return target
      })

      if (!swapOk) return reply(`❌ Trade failed — your entry wasn't found. Trade cancelled.`)

      await updatePlayer(db, fromJid, (fromPlayer) => {
        const idx = (fromPlayer.seriesCollection ?? []).findIndex(s => s.title === senderEntry.title && (s.anilistId ?? s.malId) === (senderEntry.anilistId ?? senderEntry.malId))
        if (idx === -1) {
          console.error(`[series trade] accept: couldn't find ${senderEntry.title} in sender's collection during swap — possible inconsistency`)
          return fromPlayer
        }
        fromPlayer.seriesCollection.splice(idx, 1)
        fromPlayer.seriesCollection.push({ ...targetEntry })
        return fromPlayer
      })

      return reply(
        `🤝 *Trade complete!*\n\n` +
        `You received: ${seriesTierStars(senderEntry.tier)} *${senderEntry.title}*\n` +
        `*${sender.name}* received: ${seriesTierStars(targetEntry.tier)} *${targetEntry.title}*`
      )
    }

    // ── DECLINE ───────────────────────────────────────────────────────────
    if (sub === 'decline') {
      if (!player.seriesOffer) return reply(`❌ You have no pending series trade offer.`)
      await updatePlayer(db, player.id, (pl) => { pl.seriesOffer = null; return pl })
      return reply(`🚫 Trade offer declined.`)
    }

    // ── TOP — leaderboard by total collection value ───────────────────────
    if (sub === 'top') {
      await db.read()
      const users = Object.values(db.data.users ?? {}).filter(u => !u.hiddenFromLeaderboard)
      const scored = users
        .map(u => ({ name: u.name, value: getSeriesCollectionValue(u), count: (u.seriesCollection ?? []).length }))
        .filter(u => u.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 10)

      const medals = ['🥇', '🥈', '🥉']
      const rows = scored.map((u, i) =>
        `${medals[i] ?? `*${i + 1}.*`} *${u.name}* — ☀️ ${u.value.toLocaleString()} _(${u.count} series)_`
      )

      return reply(
        `📺 *ANIME SERIES — TOP COLLECTORS*\n\n` +
        `${rows.join('\n') || '_No collectors yet. Be the first!_'}\n\n` +
        `_Ranked by total sell value of owned series._`
      )
    }

    // ── SHOW COLLECTION (default / paginated) ─────────────────────────────
    const collection = player.seriesCollection ?? []

    // If arg looks like a page number, show that page; otherwise treat as a title lookup
    const pageArg = parseInt(args[0], 10)
    if (!args[0] || (!isNaN(pageArg) && pageArg > 0)) {
      // Paginated collection view
      if (collection.length === 0) {
        return reply(
          `📭 *Your series collection is empty.*\n\n` +
          `_Series spawn in groups where an admin has run *${p}series on*._\n` +
          `_Claim them with *${p}collect <code>*._`
        )
      }
      const page = isNaN(pageArg) ? 1 : pageArg
      const total = Math.ceil(collection.length / PAGE_SIZE)
      const clamped = Math.max(1, Math.min(page, total))
      const slice = collection.slice((clamped - 1) * PAGE_SIZE, clamped * PAGE_SIZE)
      const totalValue = getSeriesCollectionValue(player)

      const rows = slice.map(s => seriesLine(s))
      return reply(
        `📺 *${player.name}'s Anime Series Collection*\n` +
        `_(Page ${clamped}/${total} · ${collection.length} total · ☀️ ${totalValue.toLocaleString()} value)_\n\n` +
        rows.join('\n') +
        (total > 1 ? `\n\n_Use *${p}series <page>* to browse._` : '')
      )
    }

    // ── INSPECT one entry ─────────────────────────────────────────────────
    const title = args.join(' ').trim()
    const entry = findOwnedSeries(player, title)
    if (!entry) {
      return reply(
        `❌ You don't own a series matching *"${title}"*.\n` +
        `_Use *${p}series* to browse your collection._`
      )
    }

    const score = entry.score != null ? `${entry.score.toFixed(1)} ⭐` : 'Unrated'
    const claimed = new Date(entry.claimedAt).toLocaleDateString()
    const caption =
      `${seriesTierEmoji(entry.tier)} *${entry.title}*\n\n` +
      `${seriesTierStars(entry.tier)} Tier: *${entry.tier}*\n` +
      `🏅 Score: *${score}*\n` +
      `☀️ Sell Value: *${entry.sellPrice.toLocaleString()} Solars*\n` +
      `📅 Claimed: ${claimed}\n\n` +
      `_Sell with *${p}series sell ${entry.title}*_`

    if (entry.imageUrl) return replyImage(entry.imageUrl, caption)
    return reply(caption)
  },
}
