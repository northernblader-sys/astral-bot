/**
 * farm.js — real-time crop growing on your home's plots.
 *
 * Growth is wall-clock, not ticked: planting stores a `readyAt` timestamp and
 * harvest just compares it to Date.now(). Crops therefore keep growing while
 * the bot is offline, and a restart loses nothing — there's no scheduler to
 * lose. See lib/housing-engine.js's header for why readyAt is baked in at
 * plant time rather than recomputed on read.
 *
 * Commands:
 *   .farm                        — your plots and what's ready
 *   .farm plant <crop> [qty]     — sow one or more plots
 *   .farm harvest                — collect everything ready  (also: .harvest)
 *   .farm sell [crop]            — sell harvested produce
 *   .farm seeds                  — the seed catalog for your tier
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
  ensureHome, hasHome, availableCrops, cropMap, plotCap,
  growthMsFor, splitPlots, formatRemaining, rollYield, tierOf,
} from '../lib/housing-engine.js'

const noHome = () =>
  `🏕️ *You need a home before you can farm.*\n\n*${config.prefix}home claim* — free tent to start`

/** Produce lives in player.home.harvest as { cropId: count } — ensureHome() creates it. */

function findCrop(player, query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return undefined
  if (cropMap[q]) return cropMap[q]
  return availableCrops(player).find(c => c.name.toLowerCase().includes(q))
    ?? Object.values(cropMap).find(c => c.name.toLowerCase().includes(q))
}

// ── View ──────────────────────────────────────────────────────────────

function farmView(ctx) {
  const p = config.prefix
  const player = ctx.player
  ensureHome(player)
  if (!hasHome(player)) return noHome()

  const home = player.home
  const cap = plotCap(player)
  const { ready, growing } = splitPlots(player)
  const harvest = home.harvest
  const lines = [`🌾 *YOUR FARM*  _(${home.plots.length}/${cap} plots sown)_`, '']

  if (!home.plots.length) {
    lines.push(`_Nothing in the ground._`, '')
  } else {
    if (ready.length) {
      lines.push(`*Ready now*`)
      const counts = new Map()
      for (const plot of ready) counts.set(plot.cropId, (counts.get(plot.cropId) ?? 0) + 1)
      for (const [cropId, n] of counts) {
        lines.push(`  ✅ *${cropMap[cropId]?.name ?? cropId}*${n > 1 ? ` x${n}` : ''}`)
      }
      lines.push('')
    }
    if (growing.length) {
      lines.push(`*Growing*`)
      for (const plot of growing.sort((a, b) => a.readyAt - b.readyAt)) {
        const crop = cropMap[plot.cropId]
        lines.push(`  🌿 *${crop?.name ?? plot.cropId}* — ${formatRemaining(plot.readyAt - Date.now())}`)
      }
      lines.push('')
    }
  }

  const stored = Object.entries(harvest).filter(([, n]) => n > 0)
  if (stored.length) {
    lines.push(`*Harvested*`)
    for (const [cropId, n] of stored) {
      const crop = cropMap[cropId]
      lines.push(`  🧺 *${crop?.name ?? cropId}* x${n}  _(☀️ ${((crop?.sell ?? 0) * n).toLocaleString()})_`)
    }
    lines.push('')
  }

  if (ready.length) lines.push(`*${p}harvest* — collect ${ready.length} ready crop${ready.length === 1 ? '' : 's'}`)
  if (home.plots.length < cap) lines.push(`*${p}farm plant <crop> [qty]* — sow ${cap - home.plots.length} free plot${cap - home.plots.length === 1 ? '' : 's'}`)
  if (stored.length) lines.push(`*${p}farm sell* — sell all produce`)
  lines.push(`*${p}farm seeds* — what you can grow`)

  return lines.join('\n')
}

function seedsView(ctx) {
  const player = ctx.player
  if (!hasHome(player)) return noHome()
  const tier = tierOf(player)
  const open = availableCrops(player)
  const locked = cropMap ? Object.values(cropMap).filter(c => c.minRank > (tier?.rank ?? 0)) : []

  const lines = [`🌱 *SEEDS*  _(${tier?.name})_`, '']
  for (const crop of open) {
    lines.push(
      `*${crop.name}*  ☀️ ${crop.seedCost.toLocaleString()}`,
      `  ⏱️ ${formatRemaining(crop.minutes * 60000)}  ·  🧺 ${crop.yieldMin}-${crop.yieldMax}  ·  sells ☀️ ${crop.sell.toLocaleString()} each`,
    )
  }
  if (locked.length) {
    lines.push('', `*Locked* _(upgrade your home)_`)
    for (const crop of locked) lines.push(`  🔒 ${crop.name}`)
  }
  lines.push('', `*${config.prefix}farm plant <crop> [qty]*`)
  return lines.join('\n')
}

// ── Plant ─────────────────────────────────────────────────────────────

async function handlePlant(ctx, args) {
  const p = config.prefix
  if (!hasHome(ctx.player)) return ctx.reply(noHome())
  if (!args.length) return ctx.reply(`❌ *Usage:* *${p}farm plant <crop> [qty]*\n_See_ *${p}farm seeds*`)

  const last = args[args.length - 1]
  let qty = 1
  let parts = args
  if (/^\d+$/.test(last) && args.length > 1) {
    qty = Math.max(1, Math.min(99, parseInt(last, 10)))
    parts = args.slice(0, -1)
  }

  const query = parts.join(' ')
  const crop = findCrop(ctx.player, query)
  if (!crop) return ctx.reply(`❌ *Unknown crop* "_${query}_".\n_See_ *${p}farm seeds*`)

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const home = ensureHome(player)
    const tier = tierOf(player)
    if (crop.minRank > (tier?.rank ?? 0)) { outcome = { reason: 'locked' }; return player }

    const free = plotCap(player) - home.plots.length
    if (free <= 0) { outcome = { reason: 'noplots', cap: plotCap(player) }; return player }

    const wallet = player.wallet ?? (player.wallet = {})
    const solars = wallet.solars ?? 0
    const affordable = Math.floor(solars / crop.seedCost)
    const planting = Math.min(qty, free, affordable)
    if (planting <= 0) { outcome = { reason: 'poor', need: crop.seedCost, have: solars }; return player }

    wallet.solars = solars - planting * crop.seedCost
    const now = Date.now()
    const growMs = growthMsFor(player, crop)
    for (let i = 0; i < planting; i++) {
      home.plots.push({ cropId: crop.id, plantedAt: now, readyAt: now + growMs })
    }
    outcome = {
      reason: 'ok', planting, growMs,
      spent: planting * crop.seedCost,
      capped: planting < qty,
      used: home.plots.length, cap: plotCap(player),
    }
    return player
  })

  if (outcome.reason === 'locked') {
    return ctx.reply(`🔒 *${crop.name}* needs a bigger home. _See_ *${p}home tiers*.`)
  }
  if (outcome.reason === 'noplots') {
    return ctx.reply(
      `🌱 *All ${outcome.cap} plots are already sown.*\n` +
      `Harvest with *${p}harvest*, or upgrade your home for more land.`,
    )
  }
  if (outcome.reason === 'poor') {
    return ctx.reply(
      `❌ *Not enough Solars.*\n*${crop.name}* seed costs ☀️ *${outcome.need.toLocaleString()}* each — ` +
      `you have ☀️ *${outcome.have.toLocaleString()}*.`,
    )
  }

  return ctx.reply(
    `🌱 *Planted ${outcome.planting}x ${crop.name}*${outcome.capped ? ` _(limited by plots/Solars)_` : ''}\n\n` +
    `💸 Spent: ☀️ *${outcome.spent.toLocaleString()}*\n` +
    `⏱️ Ready in *${formatRemaining(outcome.growMs)}*\n` +
    `🌾 Plots: *${outcome.used}/${outcome.cap}*\n\n` +
    `_Crops grow in real time — come back later and_ *${p}harvest*.`,
  )
}

// ── Harvest ───────────────────────────────────────────────────────────

async function handleHarvest(ctx) {
  const p = config.prefix
  if (!hasHome(ctx.player)) return ctx.reply(noHome())

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const home = ensureHome(player)
    const harvest = home.harvest
    const now = Date.now()
    const ready = home.plots.filter(pl => now >= pl.readyAt)
    if (!ready.length) {
      const soonest = home.plots.reduce((min, pl) => Math.min(min, pl.readyAt), Infinity)
      outcome = {
        reason: 'none',
        sown: home.plots.length,
        wait: Number.isFinite(soonest) ? soonest - now : 0,
      }
      return player
    }

    const gained = new Map()
    for (const plot of ready) {
      const crop = cropMap[plot.cropId]
      if (!crop) continue
      const amount = rollYield(crop)
      gained.set(crop.id, (gained.get(crop.id) ?? 0) + amount)
      harvest[crop.id] = (harvest[crop.id] ?? 0) + amount
    }
    home.plots = home.plots.filter(pl => now < pl.readyAt)

    outcome = { reason: 'ok', gained: [...gained.entries()], plots: ready.length, left: home.plots.length }
    return player
  })

  if (outcome.reason === 'none') {
    if (!outcome.sown) {
      return ctx.reply(`🌱 *Nothing planted.*\n*${p}farm plant <crop>* to get started.`)
    }
    return ctx.reply(
      `🌿 *Nothing ready yet.*\n` +
      `${outcome.sown} plot${outcome.sown === 1 ? '' : 's'} still growing — next one in *${formatRemaining(outcome.wait)}*.`,
    )
  }

  const lines = outcome.gained.map(([cropId, n]) => {
    const crop = cropMap[cropId]
    return `  🧺 *${crop?.name ?? cropId}* x${n}`
  })

  return ctx.reply(
    `🌾 *Harvested ${outcome.plots} plot${outcome.plots === 1 ? '' : 's'}!*\n\n` +
    `${lines.join('\n')}\n\n` +
    `${outcome.left ? `_${outcome.left} still growing._\n` : ''}` +
    `*${p}farm sell* — turn produce into Solars\n` +
    `*${p}farm plant <crop>* — sow the empty plots`,
  )
}

// ── Sell ──────────────────────────────────────────────────────────────

async function handleSell(ctx, args) {
  const p = config.prefix
  if (!hasHome(ctx.player)) return ctx.reply(noHome())

  const query = args.join(' ').trim()
  const only = query ? findCrop(ctx.player, query) : null
  if (query && !only) return ctx.reply(`❌ *Unknown crop* "_${query}_".`)

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const home = ensureHome(player)
    const harvest = home.harvest
    const targets = only ? [only.id] : Object.keys(harvest)

    let earned = 0
    const sold = []
    for (const cropId of targets) {
      const n = harvest[cropId] ?? 0
      if (n <= 0) continue
      const crop = cropMap[cropId]
      if (!crop) continue
      const value = crop.sell * n
      earned += value
      sold.push({ name: crop.name, n, value })
      harvest[cropId] = 0
    }

    if (!earned) { outcome = { reason: 'empty' }; return player }

    const wallet = player.wallet ?? (player.wallet = {})
    wallet.solars = (wallet.solars ?? 0) + earned
    outcome = { reason: 'ok', earned, sold, balance: wallet.solars }
    return player
  })

  if (outcome.reason === 'empty') {
    return ctx.reply(
      only
        ? `🧺 *No ${only.name} to sell.*`
        : `🧺 *Nothing harvested to sell.*\n*${p}harvest* first.`,
    )
  }

  const lines = outcome.sold.map(s => `  • *${s.name}* x${s.n} — ☀️ ${s.value.toLocaleString()}`)
  return ctx.reply(
    `💰 *Produce sold!*\n\n${lines.join('\n')}\n\n` +
    `☀️ Earned: *${outcome.earned.toLocaleString()}*\n` +
    `☀️ Balance: *${outcome.balance.toLocaleString()}*`,
  )
}

// ── Entry ─────────────────────────────────────────────────────────────

export default {
  name: 'farm',
  aliases: ['plant', 'harvest', 'crops'],
  category: 'housing',
  description: 'Grow crops on your home plots in real time',
  subcommands: [
    { cmd: 'plant <crop> [qty]', desc: 'sow one or more plots' },
    { cmd: 'harvest', desc: `collect everything ready (also just .harvest)` },
    { cmd: 'sell [crop]', desc: 'sell harvested produce for Solars' },
    { cmd: 'seeds', desc: 'the seed catalog your tier unlocks' },
  ],
  requiresPlayer: true,

  async run(ctx) {
    // `.plant x` and `.harvest` are aliases, so the invoked name decides the
    // action — otherwise `.harvest` would fall through to the plot view.
    const invoked = (ctx.cmd ?? '').toLowerCase()
    if (invoked === 'harvest') return handleHarvest(ctx)
    if (invoked === 'plant') return handlePlant(ctx, ctx.args)

    const sub = (ctx.args[0] ?? '').toLowerCase()
    if (sub === 'plant' || sub === 'sow') return handlePlant(ctx, ctx.args.slice(1))
    if (sub === 'harvest' || sub === 'collect') return handleHarvest(ctx)
    if (sub === 'sell') return handleSell(ctx, ctx.args.slice(1))
    if (sub === 'seeds' || sub === 'list') return ctx.reply(seedsView(ctx))

    return ctx.reply(farmView(ctx))
  },
}
