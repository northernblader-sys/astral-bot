/**
 * fish.js — cast a line wherever you're standing.
 *
 * The minigame is one call, not a conversation: you name the spot you think
 * the float will land in *as* you cast (`.fish 3`). What bites is decided by
 * the rarity weight table, and how hard it is to land is decided by that
 * fish's difficulty — a Void Koi is a 1-in-8 call, a minnow is a coin flip.
 * Deliberately stateless, so a restart mid-cast can't strand anyone.
 *
 * Fishing does NOT scale with your house. It's the one part of the pillar that
 * stays level for everyone — see the note on rollFish() in the engine.
 *
 * Commands:
 *   .fish            — cast, the spot is picked for you
 *   .fish <n>        — cast and call the spot yourself
 *   .fish bucket     — what you've landed
 *   .fish sell [name]— sell your catch
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { locations } from '../lib/game-data.js'
import {
  ensureHome, fishMap, FISH, rollFish, castSlots,
  cooldownLeft, formatRemaining, FISH_COOLDOWN_MS,
} from '../lib/housing-engine.js'

const locationMap = Object.fromEntries(locations.map(l => [l.id, l]))

/** Flavour only — where you are changes the scenery, never the odds. */
const WATER = {
  astral_town:     'the slow river below Market Row',
  entry_tower:     'a flooded stairwell',
  gambits_dungeon: 'a black underground pool',
  centurions_dungeon: 'a cistern of still, cold water',
  astral_tower:    'rainwater pooled on a broken floor',
  eternal_dungeon: 'a channel that has no visible source',
  season_01_ruins: 'a drowned courtyard',
}

function waterFor(player) {
  const id = player?.location ?? 'astral_town'
  return WATER[id] ?? `the water near ${locationMap[id]?.name ?? 'you'}`
}

/** Catches live in player.home.bucket as { fishId: count } — ensureHome() creates it. */

function findFish(query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return undefined
  if (fishMap[q]) return fishMap[q]
  return FISH.find(f => f.name.toLowerCase().includes(q))
}

function bucketView(ctx) {
  const p = config.prefix
  const home = ensureHome(ctx.player)
  const bucket = home.bucket
  const held = Object.entries(bucket).filter(([, n]) => n > 0)

  if (!held.length) {
    return `🪣 *Your bucket is empty.*\n\n*${p}fish* — go and change that`
  }

  let worth = 0
  const lines = [`🪣 *YOUR BUCKET*`, '']
  for (const [id, n] of held) {
    const fish = fishMap[id]
    const value = (fish?.sell ?? 0) * n
    worth += value
    lines.push(`  🐟 *${fish?.name ?? id}* x${n}  _(☀️ ${value.toLocaleString()})_`)
  }
  lines.push('', `☀️ Total worth: *${worth.toLocaleString()}*`, `*${p}fish sell* — sell it all`)
  return lines.join('\n')
}

async function handleSell(ctx, args) {
  const p = config.prefix
  const query = args.join(' ').trim()
  const only = query ? findFish(query) : null
  if (query && !only) return ctx.reply(`❌ *No fish called* "_${query}_".`)

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const home = ensureHome(player)
    const bucket = home.bucket
    const targets = only ? [only.id] : Object.keys(bucket)

    let earned = 0
    const sold = []
    for (const id of targets) {
      const n = bucket[id] ?? 0
      if (n <= 0) continue
      const fish = fishMap[id]
      if (!fish) continue
      const value = fish.sell * n
      earned += value
      sold.push({ name: fish.name, n, value })
      bucket[id] = 0
    }

    if (!earned) { outcome = { reason: 'empty' }; return player }

    const wallet = player.wallet ?? (player.wallet = {})
    wallet.solars = (wallet.solars ?? 0) + earned
    outcome = { reason: 'ok', earned, sold, balance: wallet.solars }
    return player
  })

  if (outcome.reason === 'empty') {
    return ctx.reply(
      only ? `🪣 *No ${only.name} in the bucket.*` : `🪣 *Nothing to sell.*\n*${p}fish* first.`,
    )
  }

  const lines = outcome.sold.map(s => `  • *${s.name}* x${s.n} — ☀️ ${s.value.toLocaleString()}`)
  return ctx.reply(
    `💰 *Catch sold!*\n\n${lines.join('\n')}\n\n` +
    `☀️ Earned: *${outcome.earned.toLocaleString()}*\n` +
    `☀️ Balance: *${outcome.balance.toLocaleString()}*`,
  )
}

async function handleCast(ctx, args) {
  const p = config.prefix
  const raw = args[0]
  const called = /^\d+$/.test(String(raw ?? '')) ? parseInt(raw, 10) : null

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const home = ensureHome(player)
    const left = cooldownLeft(home.lastFish, FISH_COOLDOWN_MS)
    if (left > 0) { outcome = { reason: 'cooldown', left }; return player }

    home.lastFish = Date.now()

    const fish = rollFish()
    const slots = castSlots(fish.difficulty)
    // The float lands somewhere in 1..slots. An out-of-range call (or none at
    // all) becomes a random pick, so `.fish` alone still plays — you just
    // don't get to choose.
    const landed = 1 + Math.floor(Math.random() * slots)
    const guess = called && called >= 1 && called <= slots
      ? called
      : 1 + Math.floor(Math.random() * slots)
    const won = guess === landed

    if (won) {
      const bucket = home.bucket
      bucket[fish.id] = (bucket[fish.id] ?? 0) + 1
    }

    outcome = {
      reason: 'ok', fish, slots, landed, guess, won,
      blind: !called || called < 1 || called > slots,
      caught: won ? (home.bucket[fish.id] ?? 1) : 0,
    }
    return player
  })

  if (outcome.reason === 'cooldown') {
    return ctx.reply(
      `🎣 *Your line's still in the water.*\nCast again in *${formatRemaining(outcome.left)}*.`,
    )
  }

  const { fish, slots, landed, guess, won, blind } = outcome
  const head =
    `🎣 *Cast into ${waterFor(ctx.player)}*\n` +
    `_Something pulls — a ${fish.name}, ${slots} places it could break the surface._\n\n` +
    `🎯 You called *${guess}*${blind ? ` _(picked for you)_` : ''}  ·  it surfaced at *${landed}*\n\n`

  if (!won) {
    return ctx.reply(
      head +
      `💦 *It slips the hook.*\n` +
      `_A ${fish.name} was worth ☀️ ${fish.sell.toLocaleString()}._\n\n` +
      `*${p}fish <1-${slots}>* — call your spot next time\n` +
      `_Line ready again in ${formatRemaining(FISH_COOLDOWN_MS)}._`,
    )
  }

  return ctx.reply(
    head +
    `🐟 *Landed a ${fish.name}!*\n` +
    `☀️ Worth *${fish.sell.toLocaleString()}*  ·  in bucket: *${outcome.caught}*\n\n` +
    `*${p}fish sell* — cash in\n*${p}fish bucket* — see the haul`,
  )
}

export default {
  name: 'fish',
  aliases: ['fishing', 'cast'],
  category: 'housing',
  description: 'Cast a line — a one-shot guessing game for rare fish',
  subcommands: [
    { cmd: '<number>', desc: 'cast and guess where the bite lands' },
    { cmd: 'bucket', desc: 'what you have caught and what it is worth' },
    { cmd: 'sell [fish]', desc: 'sell your catch for Solars' },
  ],
  requiresPlayer: true,

  async run(ctx) {
    const sub = (ctx.args[0] ?? '').toLowerCase()
    if (sub === 'bucket' || sub === 'catch' || sub === 'bag') return ctx.reply(bucketView(ctx))
    if (sub === 'sell') return handleSell(ctx, ctx.args.slice(1))
    return handleCast(ctx, ctx.args)
  },
}
