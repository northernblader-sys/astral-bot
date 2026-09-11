import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import {
  getActiveSeason,
  getSeasonRuntime,
  seasonStatus,
  formatDuration,
  seasons,
  getSeasonCatalog,
  getSeasonShopPages,
  findSeasonCatalogEntry,
  describeSeasonEntry,
  getSeasonReward,
  ensurePlayerSeasonState,
  applySeasonPoints,
  addOwnedSeasonContent,
  addSeasonPokemon,
  hasOwnedSeasonContent,
  hasOwnedSeasonPokemon,
  rewardLabel,
  seasonContentMap,
  seasonRewards,
  seasonTierProgress,
} from '../lib/season-engine.js'
import { locationsMap, seasonOffers as offerData, levelsData, classes, races, getTotalStats } from '../lib/game-data.js'
import { applyLevelUps } from '../lib/combat-engine.js'

// Banner shown on `.season offer` and `.season offer buy <id>` — purely
// cosmetic, swap freely without touching offer logic.
const SEASON_OFFER_BANNER = 'https://i.ibb.co/2YLqdknQ/download-1.jpg'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import { BEAST_MAX_OWNED } from '../lib/beast-engine.js'
import { fetchPokemonById } from '../lib/pokemon-engine.js'
import { sendImage } from '../lib/image.js'
import { renderSeasonShopPage } from '../lib/season-shop-render.mjs'
import { renderSeasonPass } from '../lib/season-pass-render.mjs'

export default {
  name: 'season',
  aliases: ['seasons', 'seasoninfo'],
  category: 'season',
  requiresPlayer: false,
  description: 'View the active season, Battle Pass progress, and Season Points',
  subcommands: [
    { cmd: 'status', desc: 'view the active season and your progress' },
    { cmd: 'shop [page]', desc: 'browse the Season Shop, one themed page at a time' },
    { cmd: 'shop buy <id>', desc: 'buy a Season Shop entry with Season Points' },
    { cmd: 'offer', desc: 'view Season money offers — gems/solars for Naira _(DM only)_' },
    { cmd: 'offer buy <id>', desc: 'buy a Season offer — DM only' },
    { cmd: 'info <name>', desc: 'full details and artwork for any shop entry' },
    { cmd: 'pass [tier]', desc: 'view the free and premium Battle Pass tracks' },
    { cmd: 'dungeon', desc: 'brief on the season dungeon — does NOT enter it' },
    { cmd: 'help', desc: 'show the season system guide' },
  ],

  async run(ctx) {
    const action = (ctx.args[0] ?? 'status').toLowerCase()
    if (action === 'help' || action === 'how') return sendHelp(ctx)
    if (action === 'lore' || action === 'story') return sendLore(ctx)
    if (action === 'shop') return handleShop(ctx)
    if (action === 'offer' || action === 'offers') return handleOffer(ctx)
    if (action === 'dungeon' || action === 'ruins') return handleSeasonDungeon(ctx)
    if (action === 'pass' || action === 'battlepass' || action === 'bp') return handlePass(ctx)
    if (action === 'premium' || action === 'unlock') return handlePremium(ctx)
    // `.season info` with a name is the item lookup; bare `.season info` keeps
    // its old meaning as an alias of `.season status`.
    if ((action === 'info' || action === 'item') && ctx.args.length > 1) return handleItemInfo(ctx)
    if (action !== 'status' && action !== 'info') {
      return ctx.reply(
        `Usage: *${config.prefix}season status* or *${config.prefix}season help*\n` +
        `_Looking for the season dungeon? *${config.prefix}season dungeon* briefs you on it; ` +
        `*${config.prefix}enter ${getActiveSeason(ctx.db)?.dungeon ?? 'season_01_ruins'}* actually goes in._`,
      )
    }

    const status = seasonStatus(ctx.db, ctx.player)
    if (!status.active) {
      const runtime = getSeasonRuntime(ctx.db)
      return ctx.reply(
        `🌙 *No active season*\n\n` +
        `The next season will begin automatically.\n` +
        (runtime.lastEndedSeasonId ? `Last completed: *${runtime.lastEndedSeasonId}*` : ''),
      )
    }

    const s = status.season
    const p = status.player
    const prog = ctx.player ? seasonTierProgress(ctx.player, s) : null
    const floors = locationsMap[s.dungeon]?.floors ?? s.floorCount ?? 50
    const lines = [
      `🌞 *SEASON ${s.number}: ${s.name.toUpperCase()}*`,
      `_${s.description}_`,
      `────────────────────`,
      `⏳ Time remaining: *${formatDuration(status.remainingMs)}*`,
      `📅 Rotation: *${s.durationDays} days*`,
      ``,
      `✨ Season Points: *${p?.points ?? 0}*`,
      `🌙 Season Level: *${p?.seasonLevel ?? 0}* · Current floor: *${p?.currentFloor ?? 1}/${floors}*`,
      `🎫 Battle Pass: *Tier ${p?.tier ?? 0}/${p?.tierCount ?? s.battlePass.tierCount}* (${p?.progressPercent ?? 0}% of the pass)`,
      prog
        ? `📈 Next tier in *${prog.toNext.toLocaleString()}* Season XP _(${prog.into.toLocaleString()}/${prog.span.toLocaleString()})_`
        : `📈 Season XP comes from cleared season floors and earned Season Points.`,
      `💎 Premium Pass: *${p?.premiumPass ? 'Unlocked' : `Locked · ${s.battlePass.premiumCost} Gems`}*`,
      `🎰 Major spins: *${p?.spins ?? 0}*`,
      ``,
      `🧙 Major: *${s.characters.major}* · Gem Spin`,
      `⚔️ Peak: *${s.characters.peak}* · Season Shop`,
      `🎁 Minor: *${s.characters.minor}* · Final Battle Pass tier`,
      `🗺️ Dungeon: *${s.dungeon}* · +${s.dungeonBoostPercent ?? 10}% XP/Fame/Solars · *${config.prefix}season dungeon*`,
      ``,
      `_Use ${config.prefix}season help for the full roadmap._`,
    ]
    return sendImage(ctx, 'season-banner.jpg', lines.join('\n'))
  },
}

async function sendHelp(ctx) {
  const active = getActiveSeason(ctx.db)
  const lines = [
    `📖 *SEASON SYSTEM*`,
    `────────────────────`,
    `Seasons are 90-day content cycles with three ways to earn exclusive rewards.`,
    ``,
    `✨ *Season Points*`,
    `Earned from season gameplay. They buy items in the Season Shop.`,
    `Spending them never costs you Battle Pass progress — the pass counts points *earned*, not points held.`,
    `At season end, leftover points convert to Solars at the configured rate.`,
    ``,
    `🎫 *Battle Pass*`,
    `50 tiers with a free track and a Gem-unlocked premium track.`,
    `Both tracks climb on the same Season XP: every cleared season dungeon floor is worth ${active?.battlePass?.xpPerSeasonLevel ?? 100} XP, and every Season Point you earn is worth 1.`,
    `Tiers get more expensive the higher you go, so the pass is built to take most of the 90 days — clearing the whole dungeon gets you roughly a third of the way.`,
    `Premium (💎${active?.battlePass?.premiumCost ?? 5}) unlocks the second reward column. It never makes you level faster.`,
    `The Minor character is awarded at the final tier.`,
    ``,
    `🎰 *Mei Spin*`,
    `${config.prefix}mei-spin <amount> uses 0.5 Gems per spin.`,
    `Odds ramp up between spin 50 and spin 100, guaranteed by spin 100.`,
    `Mei can only ever be won by ONE player bot-wide — once claimed, spinning locks for everyone else.`,
    ``,
    `🛒 *Season Shop*`,
    `42 entries across 7 themed pages — season exclusives, legendary weapons, relics, pets & beasts, Mega Stones, legendary Pokémon, and supplies.`,
    `${config.prefix}season shop <page> to browse; ${config.prefix}season info <name> for artwork and full stats on any of them.`,
    ``,
    `🗺️ *Season Dungeon*`,
    `The active season dungeon grants +${active?.dungeonBoostPercent ?? 10}% XP, Fame, and Solars, and every floor you clear is a Season Level.`,
    `${config.prefix}season dungeon briefs you on it; ${config.prefix}enter ${active?.dungeon ?? 'season_01_ruins'} is what actually takes you in.`,
    ``,
    `Commands:`,
    `• ${config.prefix}season shop [page] · [buy <id>]`,
    `• ${config.prefix}season info <name>`,
    `• ${config.prefix}season pass [tier] · [claim <tier>|claim all]`,
    `• ${config.prefix}season premium`,
    `• ${config.prefix}season dungeon`,
    `• ${config.prefix}mei-spin <amount>`,
    `• ${config.prefix}season lore`,
    `• ${config.prefix}setpearl`,
    `• ${config.prefix}openiron · ${config.prefix}opendiamond · ${config.prefix}openmythic`,
  ]
  return ctx.reply(lines.join('\n'))
}

async function sendLore(ctx) {
  return ctx.reply(
    `📖 *THE BEGINNING OF THE END*\n\n` +
    `Astral was at peace — fountains flowing and rivers singing — until the End arrived, a monster so violent that nothing could kill it. It could only be contained. ` +
    `The goddess Mei sealed herself to it, becoming the prison rather than guarding one, and paid the cost for generations.\n\n` +
    `The seal held until an unnamed bar patron accidentally activated the Ender Pearl anchoring it. It broke by accident, not sabotage. Mei and the End were released together, still bound to each other's fate. Mei remembers everything and guides the players: help her seal the End for good.\n\n` +
    `Willow is native to Astral, a strong fighter who reads enemy weaknesses. She was recruited specifically to fight the End, and her Battle Advisor is the gift that made her essential.\n\n` +
    `Urahara is a crossover character present in Astral without an in-world role. He has no plot tie to the seal — he is simply here, and his skill is available to those who equip him.`,
  )
}

/**
 * `.season dungeon` — a briefing, deliberately NOT an entry point.
 *
 * `.dungeon`/`.enter` (plugins/dungeon.js) is the only thing that walks a
 * player into a dungeon, season one included. This subcommand exists because
 * "season dungeon" is the obvious thing to type, and it would be worse to
 * either silently do nothing or quietly start a run from a menu command. It
 * reports your standing in the ruins and hands you the command that enters.
 */
async function handleSeasonDungeon(ctx) {
  const season = activeSeasonOrReply(ctx)
  if (!season) return
  const p = config.prefix
  const locId = season.dungeon
  const loc = locationsMap[locId]
  const floors = loc?.floors ?? season.floorCount ?? 50
  const bossFloor = season.partyBossFloor ?? floors

  const lines = [
    `🗺️ *SEASON DUNGEON*`,
    `*${loc?.name ?? locId}*`,
    `────────────────────`,
    loc?.description ? `_${loc.description}_` : '',
    ``,
    `🏰 Floors: *${floors}*  ·  💀 Boss: *Floor ${bossFloor}*`,
    `🎯 Level range: *${loc?.levelRange?.[0] ?? '?'}–${loc?.levelRange?.[1] ?? '?'}*  ·  Entry: *Lv ${loc?.entryLevel ?? '?'}*`,
    `☀️ Travel cost: *${loc?.travelCost ?? 0} Solars*  ·  📍 Checkpoints every *${loc?.checkpointInterval ?? 25}*`,
    `🌞 Bonus: *+${season.dungeonBoostPercent ?? 10}%* XP, Fame and Solars while the season runs`,
  ]

  if (ctx.player) {
    ensurePlayerSeasonState(ctx.player, season.id)
    const sp = ctx.player.seasonProgress
    const prog = seasonTierProgress(ctx.player, season)
    const best = ctx.player.dungeonProgress?.[locId]?.highestFloor ?? 0
    lines.push(
      ``,
      `📍 Your next floor: *${sp.currentFloor ?? 1}/${floors}*  ·  Best reached: *${best}*`,
      `🌙 Season Level: *${sp.seasonLevel ?? 0}* — each cleared floor is one level`,
      `🎫 Battle Pass: *Tier ${prog.tier}/${prog.tierCount}*  ·  next tier in *${prog.toNext.toLocaleString()}* Season XP`,
    )
  }

  lines.push(
    ``,
    `⚔️ *How to actually go in*`,
    `*${p}enter ${locId}* — start or resume your run`,
    `*${p}dungeon* — fight the next floor once you're inside`,
    `*${p}dungeon leave* — save and walk out`,
    `🤝 Floor *${bossFloor}* is party-gated: *${p}dparty create*, invite your allies, then *${p}dparty enter ${locId}*.`,
    ``,
    `_This command only briefs you — it never enters the dungeon._`,
  )

  return ctx.reply(lines.filter((line) => line !== '').join('\n'))
}

function activeSeasonOrReply(ctx) {  const season = getActiveSeason(ctx.db)
  if (!season) {
    ctx.reply(`🌙 There is no active season right now.`)
    return null
  }
  return season
}

function entryName(entry) {
  return describeSeasonEntry(entry).name
}

/**
 * Resolves the `[page]` argument of `.season shop`. Accepts a 1-based number
 * ("3"), a category id ("mega"), or a word from the page label ("stones"), so
 * a player who saw "💠 Mega Stones" in a caption can type either what they
 * read or the number next to it. Returns a 0-based index, or 0 if nothing
 * matched — an unrecognised page shows the first shelf rather than an error,
 * since the render itself names the page the player landed on.
 */
function resolvePageIndex(pages, raw) {
  if (raw == null || raw === '') return 0
  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && asNumber >= 1) {
    return Math.min(pages.length - 1, Math.floor(asNumber) - 1)
  }
  const q = String(raw).toLowerCase().trim()
  const byCategory = pages.findIndex((page) => page.category.toLowerCase() === q)
  if (byCategory >= 0) return byCategory
  const byLabel = pages.findIndex((page) => page.label.toLowerCase().includes(q))
  return byLabel >= 0 ? byLabel : 0
}

/**
 * Per-entry purchase state, shared by the shop render (stamps) and the text
 * listing so the two can never disagree about what a player already owns.
 */
function shopEntryState(player, entry) {
  if (!player) return { owned: false, soldOut: false, left: null, affordable: true }
  const purchases = player.seasonPurchases?.[entry.id] ?? 0
  const limit = entry.purchaseLimit
  const owned = entry.rewardType === 'pokemon'
    ? hasOwnedSeasonPokemon(player, entry.dexId)
    : hasOwnedSeasonContent(player, entry.rewardType, entry.id)
  const soldOut = limit != null && purchases >= limit
  return {
    owned: owned || (soldOut && limit === 1),
    soldOut,
    left: limit == null ? null : Math.max(0, limit - purchases),
    affordable: (player.seasonPoints ?? 0) >= Number(entry.price ?? 0),
  }
}

/**
 * `.season offer` — themed, limited-time money packages (gems/solars for
 * Naira). Distinct from `.season shop`, which spends in-game Season Points
 * and stays usable in groups. This is a real-money purchase, so it follows
 * premium.js/topup.js exactly: DM-only, screenshot-confirmed via the shared
 * lib/pending-purchase.js flow (extended with a 'seasonoffer' kind).
 */
function offerList(pr) {
  return offerData.packages
    .map(pkg => {
      const reward = pkg.gems ? `💎${pkg.gems} gems` : `☀️${pkg.solars.toLocaleString()} solars`
      return `  • *${pkg.id}* — ${reward} for ₦${pkg.priceNaira.toLocaleString()}`
    })
    .join('\n') + `\n\nBuy with *${pr}season offer buy <id>* _(DM only)_.`
}

async function handleOffer(ctx) {
  const pr = config.prefix
  const sub = (ctx.args[1] ?? '').toLowerCase()

  if (sub === 'confirm') return handleOfferConfirm(ctx)
  if (sub === 'reject') return handleOfferReject(ctx)

  if (ctx.isGroup) {
    return ctx.reply(`💬 DM me *${pr}season offer* to see this season's money offers.`)
  }

  if (sub !== 'buy') {
    const caption = `🎁 *SEASON OFFERS:*\n${offerList(pr)}`
    try {
      return await ctx.replyImage(SEASON_OFFER_BANNER, caption)
    } catch {
      return ctx.reply(caption)
    }
  }

  if (!ctx.player) return ctx.reply(`⚠️ Register first with *${pr}register*.`)
  const pkgId = (ctx.args[2] ?? '').toUpperCase()
  const pkg = offerData.packages.find(p => p.id.toUpperCase() === pkgId)
  if (!pkg) return ctx.reply(`❌ Unknown offer *"${ctx.args[2] ?? ''}"*.\n\n🎁 *Season Offers:*\n${offerList(pr)}`)

  await updatePlayer(ctx.db, ctx.from, p => {
    p.seasonOfferPending = { packageId: pkg.id, gems: pkg.gems || 0, solars: pkg.solars || 0, state: 'awaiting_screenshot' }
  })

  const pay = config.payment
  const reward = pkg.gems ? `💎${pkg.gems} Gems` : `☀️${pkg.solars.toLocaleString()} Solars`
  return ctx.reply(
    `🎁 *${reward}* — ₦${pkg.priceNaira.toLocaleString()}\n\n` +
    `💳 *Payment Details:*\n` +
    `  🏦 Bank: *${pay.bankName || '(not configured)'}*\n` +
    `  🔢 Account: *${pay.accountNumber || '(not configured)'}*\n` +
    `  👤 Name: *${pay.accountName || '(not configured)'}*\n\n` +
    `📸 Once paid, send a screenshot of the transfer *right here in this DM* to confirm.`,
  )
}

function findPlayerByName(allUsers, query) {
  const q = query.toLowerCase()
  return allUsers.find(u => u.name?.toLowerCase() === q)
    || allUsers.find(u => u.name?.toLowerCase().includes(q))
}

async function handleOfferConfirm(ctx) {
  if (!isOwnerJid(ctx.from)) return ctx.reply(`❌ Owner only.`)

  const name = ctx.args.slice(2).join(' ')
  if (!name) return ctx.reply(`Usage: *${config.prefix}season offer confirm <player name>*`)

  await ctx.db.read()
  const allUsers = Object.values(ctx.db.data.users ?? {})
  const target = findPlayerByName(allUsers, name)
  if (!target) return ctx.reply(`❌ No player found matching *"${name}"*.`)
  if (!target.seasonOfferPending) return ctx.reply(`⚠️ *${target.name}* has no pending season offer.`)

  const { gems, solars, packageId } = target.seasonOfferPending
  await updatePlayer(ctx.db, target.id, p => {
    if (gems)   p.wallet.gems   = roundGems((p.wallet.gems ?? 0) + gems)
    if (solars) p.wallet.solars = (p.wallet.solars ?? 0) + solars
    p.seasonOfferPending = null
  })

  const fresh = getPlayer(ctx.db, target.id)
  const rewardText = gems ? `💎${gems} gems` : `☀️${solars.toLocaleString()} solars`
  await ctx.sock.sendMessage(target.id, {
    text: `🎉 *Season offer confirmed!* ${rewardText} credited (offer: *${packageId}*).\nBalance: 💎${fmtGems(fresh.wallet.gems)} · ☀️${fresh.wallet.solars ?? 0}.`,
  }).catch(() => {})

  return ctx.reply(`✅ Credited ${rewardText} to *${target.name}* (offer: *${packageId}*).`)
}

async function handleOfferReject(ctx) {
  if (!isOwnerJid(ctx.from)) return ctx.reply(`❌ Owner only.`)

  const name = ctx.args.slice(2).join(' ')
  if (!name) return ctx.reply(`Usage: *${config.prefix}season offer reject <player name>*`)

  await ctx.db.read()
  const allUsers = Object.values(ctx.db.data.users ?? {})
  const target = findPlayerByName(allUsers, name)
  if (!target) return ctx.reply(`❌ No player found matching *"${name}"*.`)

  await updatePlayer(ctx.db, target.id, p => { p.seasonOfferPending = null })

  await ctx.sock.sendMessage(target.id, {
    text: `❌ Your season offer couldn't be confirmed. Please double-check the payment and try *${config.prefix}season offer buy <id>* again, or contact support.`,
  }).catch(() => {})

  return ctx.reply(`✅ Cleared *${target.name}*'s pending season offer.`)
}

async function handleShop(ctx) {
  const season = activeSeasonOrReply(ctx)
  if (!season) return
  const [sub, ...rest] = ctx.args.slice(1)
  const catalog = getSeasonCatalog(season)
  if (sub?.toLowerCase() === 'buy') {
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)
    const entry = findSeasonCatalogEntry(catalog, rest.join(' '))
    if (!entry) return ctx.reply(`❌ Unknown Season Shop item. Use *${config.prefix}season shop*.`)
    return buyShopEntry(ctx, season, entry)
  }

  const pages = getSeasonShopPages(catalog)
  const pageIndex = resolvePageIndex(pages, sub)
  const page = pages[pageIndex]

  const entryState = {}
  for (const entry of page.entries) entryState[entry.id] = shopEntryState(ctx.player, entry)

  const lines = [
    `🛒 *SEASON SHOP* — page ${pageIndex + 1}/${pages.length}`,
    `${page.emoji} *${page.label}*`,
    `✨ Your Season Points: *${ctx.player?.seasonPoints ?? 0}*`,
    ``,
  ]
  for (const entry of page.entries) {
    const info = describeSeasonEntry(entry)
    const state = entryState[entry.id]
    const tag = state.owned ? ' ✅' : state.soldOut ? ' ⛔' : state.left != null ? ` _(${state.left} left)_` : ''
    lines.push(`${info.emoji} *${info.name}* — ✨${entry.price}${tag}`)
    lines.push(`   \`${entry.id}\``)
  }
  lines.push(
    ``,
    `📖 *${config.prefix}season info <name>* — full details + artwork`,
    `🛒 *${config.prefix}season shop buy <id>*`,
    `📄 *${config.prefix}season shop <1-${pages.length}>* — other shelves:`,
    pages.map((p, i) => `${i + 1}. ${p.emoji} ${p.label}`).join('\n'),
  )
  const caption = lines.join('\n')

  try {
    const buf = await renderSeasonShopPage({
      season, page, pageIndex, pageCount: pages.length,
      player: ctx.player, entryState, prefix: config.prefix,
    })
    return ctx.replyImage(buf, caption)
  } catch {
    return ctx.reply(caption)
  }
}

/**
 * `.season info <name>` — the full card for any catalog entry, of any reward
 * type. Falls back to a text sheet built from the same describeSeasonEntry()
 * data if the render throws, so the command never dead-ends on a canvas or
 * network problem.
 */
async function handleItemInfo(ctx) {
  const season = activeSeasonOrReply(ctx)
  if (!season) return
  const catalog = getSeasonCatalog(season)
  const query = ctx.args.slice(1).join(' ')
  const entry = findSeasonCatalogEntry(catalog, query)
  if (!entry) {
    return ctx.reply(
      `❌ No Season Shop entry matches *${query}*.\n` +
      `Browse the shelves with *${config.prefix}season shop*.`,
    )
  }

  const info = describeSeasonEntry(entry)
  const pages = getSeasonShopPages(catalog)
  const pageIndex = pages.findIndex((page) => page.entries.some((e) => e.id === entry.id))
  const page = pages[pageIndex] ?? null
  const state = shopEntryState(ctx.player, entry)

  const stats = Object.entries(info.stats ?? {}).filter(([, v]) => v != null && v !== 0)
  const lines = [
    `${info.emoji} *${info.name.toUpperCase()}*`,
    `_${info.kind}${info.rarity ? ` · ${info.rarity}` : ''}_`,
    `────────────────────`,
    info.description ? `${info.description}\n` : '',
    stats.length ? `📊 *Stats*\n${stats.map(([k, v]) => `• ${k}: ${v > 0 ? '+' : ''}${v}`).join('\n')}\n` : '',
    info.extra?.length ? `${info.extra.filter(Boolean).map((line) => `• ${line}`).join('\n')}\n` : '',
    `✨ Price: *${entry.price}* Season Points`,
    entry.purchaseLimit == null ? `🔁 Unlimited purchases` : `🎟️ Limit ${entry.purchaseLimit} per season${state.left != null ? ` · ${state.left} left for you` : ''}`,
    state.owned ? `✅ You already own this.` : `🛒 *${config.prefix}season shop buy ${entry.id}*`,
    page ? `📄 Found on shop page ${pageIndex + 1} — ${page.emoji} ${page.label}` : '',
  ].filter((line) => line !== '')
  const caption = lines.join('\n')

  // Deliberately NOT a composed render. Only the shop grid
  // (renderSeasonShopPage) draws cards; an item lookup should show the
  // entry's own artwork plainly, unobstructed by a frame, stat block or
  // price panel — all of which are already in the caption above. Entries
  // whose artwork is null (describeSeasonEntry returns a best-effort URL)
  // fall back to the text sheet alone.
  if (!info.image) return ctx.reply(caption)
  try {
    return await ctx.replyImage(info.image, caption)
  } catch {
    return ctx.reply(caption)
  }
}

async function buyShopEntry(ctx, season, entry) {
  // A live Pokémon needs its species data from PokéAPI, and updatePlayer's
  // mutator is synchronous (lib/player-repo.js's single-writer invariant), so
  // the fetch has to finish BEFORE the transaction opens. Doing it here also
  // means a PokéAPI outage refuses the sale instead of taking the points and
  // handing back nothing.
  let rawPokemon = null
  if (entry.rewardType === 'pokemon') {
    if (hasOwnedSeasonPokemon(ctx.player, entry.dexId)) {
      return ctx.reply(`✅ You already own *${entryName(entry)}*.`)
    }
    if ((ctx.player?.seasonPoints ?? 0) < entry.price) {
      return ctx.reply(`❌ You need ✨${entry.price} Season Points for *${entryName(entry)}*. You have ✨${ctx.player?.seasonPoints ?? 0}.`)
    }
    rawPokemon = await fetchPokemonById(entry.dexId ?? entry.id)
    if (!rawPokemon) {
      return ctx.reply(`⚠️ Couldn't reach the Pokémon archive just now — nothing was charged. Try again in a moment.`)
    }
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    ensurePlayerSeasonState(player, season.id)
    player.seasonPurchases = player.seasonPurchases ?? {}
    const count = player.seasonPurchases[entry.id] ?? 0
    if (entry.purchaseLimit != null && count >= entry.purchaseLimit) {
      outcome = { reason: 'limit' }
      return
    }
    if (entry.rewardType === 'pokemon'
      ? hasOwnedSeasonPokemon(player, entry.dexId)
      : hasOwnedSeasonContent(player, entry.rewardType, entry.id) && entry.purchaseLimit === 1) {
      outcome = { reason: 'owned' }
      return
    }
    const points = player.seasonPoints ?? 0
    if (points < entry.price) {
      outcome = { reason: 'points', points }
      return
    }
    // Mega stones and held items land in the same player.inventory as gear
    // (plugins/pokeshop.js's convention), so they need a free slot too.
    const needsInventory = entry.rewardType === 'item' || entry.rewardType === 'weapon' || entry.rewardType === 'pokemonItem'
    if (needsInventory && !hasInventoryRoom(player, 1)) {
      outcome = { reason: 'full', player }
      return
    }
    // The 4-beast roster cap is enforced on acquisition, so refuse the sale
    // before charging rather than silently dropping the beast.
    if (entry.rewardType === 'beast' && (player.summonedBeasts ?? []).length >= BEAST_MAX_OWNED) {
      outcome = { reason: 'beastsFull' }
      return
    }
    player.seasonPoints = points - entry.price
    player.seasonPurchases[entry.id] = count + 1
    if (entry.rewardType === 'gems' || entry.rewardType === 'solars' || entry.rewardType === 'seasonPoints') {
      player.wallet = player.wallet ?? {}
      player.wallet[entry.rewardType] = (player.wallet[entry.rewardType] ?? 0) + (entry.amount ?? 0)
    } else if (entry.rewardType === 'character') {
      addOwnedSeasonContent(player, 'character', entry.id)
    } else if (entry.rewardType === 'title') {
      addOwnedSeasonContent(player, 'title', entry.itemId ?? entry.id.replace(/^title:/, ''))
    } else if (entry.rewardType === 'pokemon') {
      const owned = addSeasonPokemon(player, rawPokemon, { level: entry.level ?? 5 })
      outcome = { pokemon: owned }
    } else {
      addOwnedSeasonContent(player, entry.rewardType, entry.id)
    }
    outcome = { ...(outcome ?? {}), reason: 'ok', remaining: player.seasonPoints, amount: entry.amount }
  })

  if (outcome.reason === 'limit' || outcome.reason === 'owned') {
    return ctx.reply(`✅ You already reached the purchase limit for *${entryName(entry)}*.`)
  }
  if (outcome.reason === 'points') {
    return ctx.reply(`❌ You need ✨${entry.price} Season Points for *${entryName(entry)}*. You have ✨${outcome.points}.`)
  }
  if (outcome.reason === 'beastsFull') {
    return ctx.reply(`❌ Your beast roster is full (${BEAST_MAX_OWNED}/${BEAST_MAX_OWNED}). Nothing was charged — release one with *${config.prefix}summon* first.`)
  }
  if (outcome.reason === 'full') return ctx.reply(`❌ ${inventoryFullMessage(outcome.player)}`)

  const mon = outcome.pokemon
  return ctx.reply(
    `✅ *Season Shop purchase complete!*\n` +
    `${entryName(entry)} is now yours.\n` +
    (mon ? `🔱 Level ${mon.level} · ${mon.nature ?? 'rolled'} nature — see it with *${config.prefix}party dex*\n` : '') +
    `✨ Remaining Season Points: *${outcome.remaining}*`,
  )
}

async function handlePass(ctx) {
  const season = activeSeasonOrReply(ctx)
  if (!season) return
  if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)
  const player = ctx.player
  ensurePlayerSeasonState(player, season.id)
  const sub = (ctx.args[1] ?? 'status').toLowerCase()
  if (sub === 'claim') return claimPassRewards(ctx, season, ctx.args[2])

  const rewards = season.id === 'season_01'
    ? Array.from({ length: season.battlePass.tierCount }, (_, i) => getSeasonReward(season.id, i + 1)).filter(Boolean)
    : []

  // The render shows a window of 8 tiers around wherever the player is; an
  // explicit `.season pass 20` pins the window's first tier instead.
  const PER_VIEW = 8
  const explicitStart = Number(ctx.args[1])
  const start = Number.isFinite(explicitStart) && explicitStart >= 1
    ? Math.min(Math.floor(explicitStart), Math.max(1, season.battlePass.tierCount - PER_VIEW + 1))
    : null

  const claimable = rewards.filter(
    (r) => r.tier <= player.seasonProgress.battlePassTier && !player.seasonProgress.claimedTiers.includes(r.tier),
  )
  const prog = seasonTierProgress(player, season)
  const lines = [
    `🎫 *BATTLE PASS* — ${season.name}`,
    `Progress: *Tier ${prog.tier}/${prog.tierCount}* _(${prog.pct}% into this tier)_`,
    `Season XP: *${prog.xp.toLocaleString()}* · next tier in *${prog.toNext.toLocaleString()}*`,
    `Points: *${player.seasonProgress.pointsEarned} earned* · ✨${player.seasonPoints} spendable`,
    `Premium: *${player.seasonProgress.premiumPass ? 'Unlocked' : `Locked · ${season.battlePass.premiumCost} Gems`}*`,
    ``,
    claimable.length
      ? `🎁 *${claimable.length} tier${claimable.length === 1 ? '' : 's'} ready to claim* — tiers ${claimable.map((r) => r.tier).join(', ')}`
      : `⏳ Clear season dungeon floors and earn Season Points to climb. Both tracks move together — premium only adds the second reward column.`,
    ``,
    `Claim: *${config.prefix}season pass claim <tier>* or *claim all*`,
    `Jump: *${config.prefix}season pass <tier>* (1-${season.battlePass.tierCount})`,
  ]
  const caption = lines.join('\n')

  try {
    const buf = await renderSeasonPass({
      season, player, rewards, start, count: PER_VIEW, prefix: config.prefix,
    })
    return ctx.replyImage(buf, caption)
  } catch {
    // Text fallback: the same window, listed free / premium per tier.
    const from = start ?? Math.max(1, player.seasonProgress.battlePassTier - 2)
    const window = rewards.filter((r) => r.tier >= from && r.tier < from + 10)
    const rows = window.map((reward) => {
      const claimed = player.seasonProgress.claimedTiers.includes(reward.tier)
      return `*${reward.tier}.* ${rewardLabel(reward.free)} / ${rewardLabel(reward.premium)}${claimed ? ' ✅' : ''}`
    })
    return ctx.reply(`${lines.slice(0, 5).join('\n')}\n${rows.join('\n')}\n\n${lines.slice(-2).join('\n')}`)
  }
}

async function claimPassRewards(ctx, season, rawTier) {
  let outcome = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    ensurePlayerSeasonState(player, season.id)
    const requested = rawTier?.toLowerCase() === 'all' ? null : Number(rawTier)
    const tiers = requested
      ? [requested]
      : Array.from({ length: player.seasonProgress.battlePassTier }, (_, i) => i + 1)
    const claimable = tiers.filter((tier) =>
      tier >= 1 &&
      tier <= player.seasonProgress.battlePassTier &&
      !player.seasonProgress.claimedTiers.includes(tier),
    )
    if (!claimable.length) {
      outcome = { reason: 'none', tier: player.seasonProgress.battlePassTier }
      return
    }
    const rewards = []
    for (const tier of claimable) {
      const tierReward = getSeasonReward(season.id, tier)
      if (!tierReward) continue
      const selected = player.seasonProgress.premiumPass
        ? [tierReward.free, tierReward.premium]
        : [tierReward.free]
      for (const reward of selected) {
        if ((reward.rewardType === 'item' || reward.rewardType === 'weapon') && !hasInventoryRoom(player, reward.amount ?? 1)) {
          outcome = { reason: 'full', player }
          return
        }
        grantPassReward(player, season, reward)
        rewards.push(rewardLabel(reward))
      }
      player.seasonProgress.claimedTiers.push(tier)
    }
    // Battle Pass tiers can pay out XP (rewardType 'xp'), and claiming "all"
    // pays several at once, so the level check runs once after the whole loop
    // rather than per reward: applyLevelUps is a catch-up while-loop and will
    // apply every level the combined XP earned.
    const lvl = applyLevelUps(player, levelsData, classes, races, getTotalStats)
    outcome = { reason: 'ok', tiers: claimable, rewards, lvlMsgs: lvl.msgs }
  })
  if (outcome.reason === 'none') {
    return ctx.reply(`ℹ️ No unclaimed Battle Pass tiers are available. You are at Tier ${outcome.tier}.`)
  }
  if (outcome.reason === 'full') return ctx.reply(`❌ ${inventoryFullMessage(outcome.player)}\nMake room before claiming these rewards.`)
  return ctx.reply(
    `🎁 *Battle Pass rewards claimed!*\nTiers: *${outcome.tiers.join(', ')}*\n${outcome.rewards.map((r) => `• ${r}`).join('\n')}` +
    (outcome.lvlMsgs?.length ? `\n\n${outcome.lvlMsgs.join('\n')}` : ''),
  )
}

function grantPassReward(player, season, reward) {
  if (reward.rewardType === 'seasonPoints') {
    // fromPass: spendable, but not counted as earned — see applySeasonPoints.
    applySeasonPoints(player, season, reward.amount, { fromPass: true })
  } else if (reward.rewardType === 'solars' || reward.rewardType === 'gems' || reward.rewardType === 'xp') {
    player.wallet = player.wallet ?? {}
    if (reward.rewardType === 'xp') player.xp = (player.xp ?? 0) + reward.amount
    else player.wallet[reward.rewardType] = (player.wallet[reward.rewardType] ?? 0) + reward.amount
  } else if (reward.rewardType === 'character') {
    addOwnedSeasonContent(player, 'character', reward.itemId)
  } else if (reward.rewardType === 'title') {
    addOwnedSeasonContent(player, 'title', reward.itemId)
  } else {
    addOwnedSeasonContent(player, reward.rewardType, reward.itemId, reward.amount)
  }
}

async function handlePremium(ctx) {
  const season = activeSeasonOrReply(ctx)
  if (!season) return
  if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)
  let outcome = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    ensurePlayerSeasonState(player, season.id)
    if (player.seasonProgress.premiumPass) {
      outcome = { reason: 'owned' }
      return
    }
    const gems = player.wallet?.gems ?? 0
    if (gems < season.battlePass.premiumCost) {
      outcome = { reason: 'gems', gems }
      return
    }
    player.wallet.gems = roundGems(gems - season.battlePass.premiumCost)
    player.seasonProgress.premiumPass = true
    if (player.seasonProgress.battlePassTier >= season.battlePass.tierCount) {
      const finalReward = getSeasonReward(season.id, season.battlePass.tierCount)?.premium
      if (finalReward?.rewardType === 'character') grantPassReward(player, season, finalReward)
    }
    outcome = { reason: 'ok', remaining: player.wallet.gems }
  })
  if (outcome.reason === 'owned') return ctx.reply(`✅ Your Premium Battle Pass is already unlocked.`)
  if (outcome.reason === 'gems') return ctx.reply(`❌ Premium costs 💎${season.battlePass.premiumCost}. You have 💎${fmtGems(outcome.gems)}.`)
  return ctx.reply(`✅ *Premium Battle Pass unlocked!*\n💎 Remaining Gems: *${fmtGems(outcome.remaining)}*\nClaim premium rewards with *${config.prefix}season pass claim all*.`)
}

