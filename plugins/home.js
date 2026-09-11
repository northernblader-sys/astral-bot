/**
 * home.js — the housing pillar's hub: claim, view, upgrade, rest, storage.
 *
 * Room building, decorating and the guest list are their own plugins
 * (homebuild.js, homedecor.js, homeinvite.js) purely so no single file owns
 * the whole pillar; they all share lib/housing-engine.js for state and rules.
 *
 * Commands:
 *   .home                        — your house, rooms, plots, comfort
 *   .home claim                  — pitch a tent, free, one per player
 *   .home upgrade                — buy the next tier up
 *   .home rest                   — recover HP/MP, 30m cooldown
 *   .home store <item> [qty]     — move item(s) into home storage
 *   .home take <item> [qty]      — take item(s) back out
 *   .home tiers                  — the upgrade ladder and what each unlocks
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { allItems } from '../lib/game-data.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import { rarityStars } from '../lib/rarity.js'
import {
  ensureHome, hasHome, tierOf, nextTier, TIER_ORDER,
  perkTotal, comfortOf, storageCap, plotCap, splitPlots,
  formatRemaining, cooldownLeft, roomMap, decorMap, cropMap,
  REST_COOLDOWN_MS,
} from '../lib/housing-engine.js'
import { getGuildRecord } from '../lib/guild-repo.js'
import { guildPerksFor } from '../lib/guild-engine.js'

const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))

/** Extra rest percentage the player's guild tier grants, 0 if guildless. */
function guildRestFor(db, player) {
  const record = player?.guildId ? getGuildRecord(db, player.guildId) : null
  return guildPerksFor(player, record).restPct
}

function findItem(query) {
  const q = query.toLowerCase().trim()
  if (itemMap[q]) return itemMap[q]
  for (const item of Object.values(itemMap)) {
    if (item.name.toLowerCase().includes(q)) return item
  }
  return undefined
}

function summarize(ids) {
  const counts = new Map()
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  return [...counts.entries()]
    .map(([id, count]) => {
      const item = itemMap[id]
      const name = item?.name ?? id
      const stars = item ? rarityStars(item.rarity) : ''
      return { line: `${stars} *${name}*${count > 1 ? ` x${count}` : ''}`, name }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => e.line)
}

function parseItemAndQty(args) {
  const lastArg = args[args.length - 1]
  let qty = 1
  let queryParts = args
  if (/^\d+$/.test(lastArg) && args.length > 1) {
    qty = Math.max(1, Math.min(99, parseInt(lastArg, 10)))
    queryParts = args.slice(0, -1)
  }
  return { query: queryParts.join(' '), qty }
}

const noHome = () =>
  `🏕️ *You don't have a home yet.*\n\n` +
  `Every hero starts with a tent on the edge of Astral Town — it's free.\n\n` +
  `*${config.prefix}home claim* — pitch your tent`

// ── Main view ─────────────────────────────────────────────────────────

function homeView(ctx) {
  const p = config.prefix
  const player = ctx.player
  ensureHome(player)
  if (!hasHome(player)) return noHome()

  const tier = tierOf(player)
  const home = player.home
  const { ready, growing } = splitPlots(player)
  const comfort = comfortOf(player)
  const rest = cooldownLeft(home.lastRest, REST_COOLDOWN_MS)

  const lines = [
    `🏠 *${tier.name.toUpperCase()}*`,
    `_${tier.blurb}_`,
    '',
    `✨ Comfort: *${comfort}*   🛏️ Rest: *+${(tier.restBonus ?? 0) + perkTotal(player, 'rest') + guildRestFor(ctx.db, player)}%*`,
    `🚪 Rooms: *${home.rooms.length}/${tier.rooms}*   🖼️ Decor: *${home.decor.length}/${tier.decorSlots}*`,
    `🌱 Plots: *${home.plots.length}/${plotCap(player)}*   📦 Storage: *${home.storage.length}/${storageCap(player)}*`,
  ]

  if (home.rooms.length) {
    lines.push('', `*Rooms built*`)
    for (const id of home.rooms) {
      const room = roomMap[id]
      if (room) lines.push(`  • *${room.name}* — _${room.blurb}_`)
    }
  }

  if (home.decor.length) {
    const names = home.decor.map(id => decorMap[id]?.name ?? id)
    lines.push('', `*Decor placed*`, `  ${names.join(', ')}`)
  }

  if (ready.length || growing.length) {
    lines.push('', `*Farm*`)
    if (ready.length) lines.push(`  ✅ *${ready.length}* ready to harvest — *${p}harvest*`)
    for (const plot of growing.slice(0, 4)) {
      const crop = cropMap[plot.cropId]
      lines.push(`  🌿 ${crop?.name ?? plot.cropId} — ${formatRemaining(plot.readyAt - Date.now())}`)
    }
    if (growing.length > 4) lines.push(`  _...and ${growing.length - 4} more growing._`)
  }

  const up = nextTier(home.tier)
  lines.push('', `*Commands*`)
  lines.push(`*${p}home rest* — ${rest > 0 ? `_on cooldown, ${formatRemaining(rest)}_` : 'recover HP and MP'}`)
  lines.push(`*${p}homebuild* · *${p}homedecor* · *${p}farm* · *${p}fish*`)
  lines.push(`*${p}homeparty* · *${p}homeinvite <@user>* · *${p}homevisit <@user>*`)
  if (up) lines.push(`*${p}home upgrade* — ${up.name} for ☀️ *${up.solars.toLocaleString()}*`)
  lines.push(`*${p}home store <item>* · *${p}home take <item>*`)

  return lines.join('\n')
}

// ── Claim ─────────────────────────────────────────────────────────────

async function handleClaim(ctx) {
  const p = config.prefix
  let outcome = null

  await updatePlayer(ctx.db, ctx.from, player => {
    const home = ensureHome(player)
    if (hasHome(player)) { outcome = { reason: 'already' }; return player }
    home.tier = TIER_ORDER[0].id
    home.founded = Date.now()
    outcome = { reason: 'ok' }
    return player
  })

  if (outcome.reason === 'already') {
    return ctx.reply(`❌ You already have a home. Use *${p}home* to see it.`)
  }

  const tier = TIER_ORDER[0]
  return ctx.reply(
    `🏕️ *${tier.name} pitched!*\n\n` +
    `_${tier.blurb}_\n\n` +
    `You get *${tier.rooms}* room, *${tier.decorSlots}* decor slot and *${tier.plots}* ` +
    `growing plot to start.\n\n` +
    `*${p}homebuild* — add a room\n` +
    `*${p}farm plant wheat* — get something in the ground\n` +
    `*${p}home upgrade* — when you've saved up`,
  )
}

// ── Upgrade ───────────────────────────────────────────────────────────

async function handleUpgrade(ctx) {
  const p = config.prefix
  if (!hasHome(ctx.player)) return ctx.reply(noHome())

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureHome(player)
    const up = nextTier(player.home.tier)
    if (!up) { outcome = { reason: 'max' }; return player }

    const wallet = player.wallet ?? (player.wallet = {})
    const solars = wallet.solars ?? 0
    if (solars < up.solars) { outcome = { reason: 'poor', need: up.solars, have: solars, up }; return player }

    wallet.solars = solars - up.solars
    player.home.tier = up.id
    outcome = { reason: 'ok', up }
    return player
  })

  if (outcome.reason === 'max') {
    return ctx.reply(`🏛️ *You already own the Astral Estate* — there's nothing bigger to buy.`)
  }
  if (outcome.reason === 'poor') {
    return ctx.reply(
      `❌ *Not enough Solars.*\n` +
      `*${outcome.up.name}* costs ☀️ *${outcome.need.toLocaleString()}*.\n` +
      `You have ☀️ *${outcome.have.toLocaleString()}* — short by ☀️ *${(outcome.need - outcome.have).toLocaleString()}*.`,
    )
  }

  const up = outcome.up
  return ctx.reply(
    `🏠 *Upgraded to ${up.name}!*\n\n` +
    `_${up.blurb}_\n\n` +
    `🚪 Rooms: *${up.rooms}*   🖼️ Decor: *${up.decorSlots}*\n` +
    `🌱 Plots: *${up.plots}*   📦 Storage: *${up.storage}*\n` +
    `🛏️ Rest bonus: *+${up.restBonus}%*\n\n` +
    `New rooms and crops may have unlocked — *${p}homebuild* and *${p}farm*.`,
  )
}

// ── Rest ──────────────────────────────────────────────────────────────

async function handleRest(ctx) {
  if (!hasHome(ctx.player)) return ctx.reply(noHome())

  // Guild rest perk, read at the point of the action (not cached on the
  // player) so leaving a guild stops applying on the very next rest — the
  // contract lib/guild-engine.js's header sets out.
  const guildRestPct = guildRestFor(ctx.db, ctx.player)

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const home = ensureHome(player)
    const left = cooldownLeft(home.lastRest, REST_COOLDOWN_MS)
    if (left > 0) { outcome = { reason: 'cooldown', left }; return player }

    const tier = tierOf(player)
    const pct = (tier?.restBonus ?? 0) + perkTotal(player, 'rest') + guildRestPct
    const maxHp = player.maxHp ?? 100
    const maxMp = player.maxMp ?? 50
    const hpGain = Math.max(1, Math.round(maxHp * (pct / 100)))
    const mpGain = Math.max(1, Math.round(maxMp * (pct / 100)))

    const beforeHp = player.hp ?? maxHp
    const beforeMp = player.mp ?? maxMp
    player.hp = Math.min(maxHp, beforeHp + hpGain)
    player.mp = Math.min(maxMp, beforeMp + mpGain)
    home.lastRest = Date.now()

    outcome = {
      reason: 'ok', pct,
      hp: player.hp - beforeHp, mp: player.mp - beforeMp,
      curHp: player.hp, maxHp, curMp: player.mp, maxMp,
    }
    return player
  })

  if (outcome.reason === 'cooldown') {
    return ctx.reply(`😴 *You've only just got up.*\nRest again in *${formatRemaining(outcome.left)}*.`)
  }

  return ctx.reply(
    `🛏️ *Rested at home* _(+${outcome.pct}%)_\n\n` +
    `❤️ HP: *${outcome.curHp}/${outcome.maxHp}* _(+${outcome.hp})_\n` +
    `💙 MP: *${outcome.curMp}/${outcome.maxMp}* _(+${outcome.mp})_` +
    (guildRestPct > 0 ? `\n\n🏰 _+${guildRestPct}% of that came from your guild hall._` : ''),
  )
}

// ── Storage ───────────────────────────────────────────────────────────

async function handleStore(ctx, args) {
  const p = config.prefix
  if (!hasHome(ctx.player)) return ctx.reply(noHome())
  if (!args[1]) return ctx.reply(`❌ *Usage:* *${p}home store <item name or id> [qty]*`)

  const { query, qty } = parseItemAndQty(args.slice(1))
  const item = findItem(query)
  if (!item) return ctx.reply(`❌ *Item* "_${query}_" *not recognized.*`)

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const home = ensureHome(player)
    const owned = player.inventory.filter(id => id === item.id).length
    if (owned === 0) { outcome = { reason: 'none' }; return player }

    const room = storageCap(player) - home.storage.length
    if (room <= 0) { outcome = { reason: 'full', cap: storageCap(player) }; return player }

    const moved = Math.min(qty, owned, room)
    let removed = 0
    player.inventory = player.inventory.filter(id => {
      if (id === item.id && removed < moved) { removed++; return false }
      return true
    })
    for (let i = 0; i < moved; i++) home.storage.push(item.id)
    outcome = { reason: 'ok', moved, held: home.storage.length, cap: storageCap(player) }
    return player
  })

  if (outcome.reason === 'none') return ctx.reply(`❌ *You don't have any* *${item.name}*.`)
  if (outcome.reason === 'full') {
    return ctx.reply(
      `📦 *Home storage is full* _(${outcome.cap})_.\n` +
      `Build a *Cellar* with *${p}homebuild cellar* or upgrade your house for more room.`,
    )
  }
  return ctx.reply(
    `📦 *Stored ${outcome.moved}x ${item.name}* at home.\n` +
    `_Storage: ${outcome.held}/${outcome.cap}_`,
  )
}

async function handleTake(ctx, args) {
  const p = config.prefix
  if (!hasHome(ctx.player)) return ctx.reply(noHome())
  if (!args[1]) return ctx.reply(`❌ *Usage:* *${p}home take <item name or id> [qty]*`)

  const { query, qty } = parseItemAndQty(args.slice(1))
  const item = findItem(query)
  if (!item) return ctx.reply(`❌ *Item* "_${query}_" *not recognized.*`)

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const home = ensureHome(player)
    const stored = home.storage.filter(id => id === item.id).length
    if (stored === 0) { outcome = { reason: 'none' }; return player }

    const moved = Math.min(qty, stored)
    if (!hasInventoryRoom(player, moved)) { outcome = { reason: 'invfull', player }; return player }

    let removed = 0
    home.storage = home.storage.filter(id => {
      if (id === item.id && removed < moved) { removed++; return false }
      return true
    })
    for (let i = 0; i < moved; i++) player.inventory.push(item.id)
    outcome = { reason: 'ok', moved }
    return player
  })

  if (outcome.reason === 'none') return ctx.reply(`❌ *No* *${item.name}* _in home storage._`)
  if (outcome.reason === 'invfull') return ctx.reply(inventoryFullMessage(outcome.player))
  return ctx.reply(`🎒 *Took ${outcome.moved}x ${item.name}* from home storage.`)
}

// ── Tiers ─────────────────────────────────────────────────────────────

function tiersView(ctx) {
  const cur = tierOf(ctx.player)
  const lines = [`🏘️ *HOUSING TIERS*`, '']
  for (const tier of TIER_ORDER) {
    const mark = cur && cur.id === tier.id ? '  ← _you are here_' : ''
    lines.push(
      `*${tier.name}*${mark}`,
      `  ☀️ ${tier.solars ? tier.solars.toLocaleString() : 'free'}  ·  ` +
      `🚪 ${tier.rooms}  ·  🖼️ ${tier.decorSlots}  ·  🌱 ${tier.plots}  ·  📦 ${tier.storage}  ·  🛏️ +${tier.restBonus}%`,
      `  _${tier.blurb}_`,
      '',
    )
  }
  lines.push(`*${config.prefix}home upgrade* — buy the next one up`)
  return lines.join('\n')
}

// ── Entry ─────────────────────────────────────────────────────────────

export default {
  name: 'home',
  aliases: ['house'],
  category: 'housing',
  description: 'Your house: rooms, decor, farm plots, storage and rest',
  subcommands: [
    { cmd: 'claim', desc: 'pitch a free tent — one per player' },
    { cmd: 'upgrade', desc: 'buy the next tier up' },
    { cmd: 'rest', desc: 'recover HP and MP, 30m cooldown' },
    { cmd: 'store <item> [qty]', desc: 'move items into home storage' },
    { cmd: 'take <item> [qty]', desc: 'take them back out' },
    { cmd: 'tiers', desc: 'the upgrade ladder and what each unlocks' },
  ],
  requiresPlayer: true,

  async run(ctx) {
    const sub = (ctx.args[0] ?? '').toLowerCase()

    if (sub === 'claim' || sub === 'start') return handleClaim(ctx)
    if (sub === 'upgrade' || sub === 'up') return handleUpgrade(ctx)
    if (sub === 'rest' || sub === 'sleep') return handleRest(ctx)
    if (sub === 'store' || sub === 'put') return handleStore(ctx, ctx.args)
    if (sub === 'take' || sub === 'get') return handleTake(ctx, ctx.args)
    if (sub === 'tiers' || sub === 'list') return ctx.reply(tiersView(ctx))

    return ctx.reply(homeView(ctx))
  },
}
