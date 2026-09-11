/**
 * pokemon.js — one consolidated command for the Pokémon collection system:
 * viewing your Pokédex, inspecting one, feeding/training/healing, renaming,
 * protecting from accidental release, releasing for Solars, gifting to
 * another player, and setting your main battle Pokémon.
 *
 * Registered as `.party`; `.p-poke`/`.pokemon`/`.poke`/`.pokedex` remain
 * aliases for anyone used to the old Pokémon command.
 *
 * Subcommands (see USAGE below, shown by `.party` with no args):
 *   .party                        — show your six-Pokémon battle party
 *   .party dex [page]             — view your Pokédex
 *   .party add <name>             — add a Pokémon to your battle party
 *   .party remove <name>          — remove a Pokémon from your battle party
 *   .party clear                  — clear all six battle-party slots
 *   .party info <name>            — inspect one of your Pokémon
 *   .party main <name>            — set your main battle Pokémon
 *   .party feed <name>            — feed for XP/happiness (costs Solars)
 *   .party train <name>           — train ATK/DEF (costs Solars)
 *   .party heal                   — heal your whole team to full HP (free)
 *   .party rename <name> | <nick> — give a nickname
 *   .party protect <name>         — lock/unlock against release
 *   .party release <name>         — release for Solars (level × 100)
 *   .party give <name> @user      — gift a Pokémon to another player
 *
 * Rewritten from scratch against this bot's actual data model:
 * player.pokemon[] is a plain array (not separate Mongo documents),
 * data/stats/sprites come from the live PokéAPI via lib/pokemon-engine.js
 * (not a local static pool), and storage is lowdb via lib/player-repo.js's
 * updatePlayer, not Mongoose. Cost formulas (feed: flat Solars; train:
 * level-scaled Solars; release: level-scaled Solars reward) follow the same
 * shape as this bot's other economy sinks/sources.
 */
import { config } from '../config.js'
import { updatePlayer, playerExists, getPlayer } from '../lib/player-repo.js'
import {
  findOwnedPokemon,
  setMainPokemon,
  basePokemonHp,
  formatTypes,
  typeEmoji,
} from '../lib/pokemon-engine.js'
import { getMovesForIds, getMoveById } from '../lib/move-pool.js'
import { computeBattleStats } from '../lib/pokemon-stats.js'
import { runLevelUpEvolutionCheck, findItemEvolution, applyEvolution } from '../lib/pokemon-evolution.js'
import { renderPokemonParty } from '../lib/pokemon-party-render.mjs'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const POKEMON_ITEMS = require('../data/pokemon-items.json')
const pokeItemMap = new Map(POKEMON_ITEMS.map(i => [i.id, i]))

const DEX_PAGE_SIZE = 20
const FEED_COST     = 50
const BATTLE_PARTY_SIZE = 6

function resolveTargetJid(ctx, raw) {
  const contextInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo
  if (contextInfo?.participant) return contextInfo.participant
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0]
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

const USAGE = (pr) =>
  `🐾 *Pokémon Commands*\n\n` +
  `▹ *${pr}party* — show your six-Pokémon battle party\n` +
  `▹ *${pr}party add <name>* — add a Pokémon to your battle party\n` +
  `▹ *${pr}party remove <name>* — remove a Pokémon from your battle party\n` +
  `▹ *${pr}party clear* — clear your battle party\n` +
  `▹ *${pr}party dex [page]* — view your Pokédex\n` +
  `▹ *${pr}party info <name>* — inspect a Pokémon\n` +
  `▹ *${pr}party moveset <name>* — view its 4 equipped moves\n` +
  `▹ *${pr}party main <name>* — set your main battler\n` +
  `▹ *${pr}party feed <name>* — feed for XP/happiness (${FEED_COST} Solars)\n` +
  `▹ *${pr}party train <name>* — train ATK/DEF (costs Solars)\n` +
  `▹ *${pr}party heal* — heal your team to full HP (free)\n` +
  `▹ *${pr}party rename <name> | <nickname>* — nickname it\n` +
  `▹ *${pr}party protect <name>* — lock/unlock against release\n` +
  `▹ *${pr}party release <name>* — release for Solars\n` +
  `▹ *${pr}party give <name> @user* — gift to another player\n` +
  `▹ *${pr}party evolve <name> <item>* — evolve with an evolution item\n` +
  `▹ *${pr}party hold <name> <item>* — equip a held item\n` +
  `▹ *${pr}party unhold <name>* — unequip a held item`

export default {
  name: 'party',
  aliases: ['p-poke', 'pokemon', 'poke', 'pokedex'],
  category: 'pokemon',
  requiresPlayer: true,
  description: 'View, feed, train, and manage your Pokémon — see .party for the full subcommand list',
  // Keep in sync with USAGE above.
  subcommands: [
    { cmd: '',                    desc: 'show your six-Pokémon battle party' },
    { cmd: 'add <n>',             desc: 'add a Pokémon to your battle party' },
    { cmd: 'remove <n>',          desc: 'remove a Pokémon from your battle party' },
    { cmd: 'clear',               desc: 'clear your battle party' },
    { cmd: 'dex [page]',           desc: 'view your Pokédex' },
    { cmd: 'info <n>',            desc: 'inspect a Pokémon' },
    { cmd: 'moveset <n>',         desc: 'view its 4 equipped moves' },
    { cmd: 'main <n>',            desc: 'set your main battler' },
    { cmd: `feed <n>`,            desc: `feed for XP/happiness (${FEED_COST} Solars)` },
    { cmd: 'train <n>',           desc: 'train ATK/DEF (costs Solars)' },
    { cmd: 'heal',                desc: 'heal your team to full HP (free)' },
    { cmd: 'rename <n> | <nick>', desc: 'give it a nickname' },
    { cmd: 'protect <n>',         desc: 'lock/unlock against release' },
    { cmd: 'release <n>',         desc: 'release for Solars (level × 100)' },
    { cmd: 'give <n> @user',      desc: 'gift a Pokémon to another player' },
    { cmd: 'evolve <n> <item>',   desc: 'evolve with an evolution item' },
    { cmd: 'hold <n> <item>',     desc: 'equip a held item' },
    { cmd: 'unhold <n>',          desc: 'unequip a held item' },
  ],

  async run(ctx) {
    const { args, reply } = ctx
    const pr  = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    if (!sub) return handleBattleParty(ctx)
    if (sub === 'team' || sub === 'party' || sub === 'list') return handleBattleParty(ctx)
    if (sub === 'add') return handleBattlePartyAdd(ctx)
    if (sub === 'remove' || sub === 'rm') return handleBattlePartyRemove(ctx)
    if (sub === 'clear') return handleBattlePartyClear(ctx)
    if (sub === 'dex' || /^\d+$/.test(sub)) {
      const pageArg = sub === 'dex' ? args[1] : sub
      return handleDex(ctx, pageArg)
    }

    if (sub === 'info')    return handleInfo(ctx)
    if (sub === 'moveset') return handleMoveset(ctx)
    if (sub === 'main')    return handleMain(ctx)
    if (sub === 'feed')    return handleFeed(ctx)
    if (sub === 'train')   return handleTrain(ctx)
    if (sub === 'heal')    return handleHeal(ctx)
    if (sub === 'rename')  return handleRename(ctx)
    if (sub === 'protect') return handleProtect(ctx)
    if (sub === 'release') return handleRelease(ctx)
    if (sub === 'give')    return handleGive(ctx)
    if (sub === 'evolve')  return handleEvolve(ctx)
    if (sub === 'hold')    return handleHold(ctx)
    if (sub === 'unhold')  return handleUnhold(ctx)

    return reply(USAGE(pr))
  },
}

// ── .party ──────────────────────────────────────────────────────────────────
function battlePartyIds(player) {
  return Array.isArray(player.battlePartyIds) ? player.battlePartyIds : []
}

function battlePartyMembers(player) {
  const owned = player.pokemon ?? []
  return battlePartyIds(player)
    .map(id => owned.find(mon => mon.id === id))
    .filter(Boolean)
}

async function handleBattleParty(ctx) {
  const { reply, player } = ctx
  const pr = config.prefix
  const members = battlePartyMembers(player)
  const memberIds = new Set(members.map(mon => mon.id))

  // Build exactly 6 slots — filled or null
  const partySlots = Array.from({ length: BATTLE_PARTY_SIZE }, (_, i) => members[i] ?? null)

  const available = (player.pokemon ?? []).filter(mon => !memberIds.has(mon.id))
  const caption =
    `⚔️ *${player.name}'s Battle Party* — ${members.length}/${BATTLE_PARTY_SIZE} slots filled\n` +
    (available.length ? `🐾 ${available.length} Pokémon available to add\n` : '') +
    `\n*${pr}party add <name>* · *${pr}party remove <name>* · *${pr}party clear*` +
    `\n_${pr}party dex_ shows your full Pokédex.`

  try {
    const buf = await renderPokemonParty(player, partySlots)
    return ctx.replyImage(buf, caption)
  } catch (err) {
    // Fallback to text if render fails
    const lines = partySlots.map((mon, index) => {
      if (!mon) return `${index + 1}. _Empty slot_`
      const hp     = `${mon.currentHp ?? mon.maxHp}/${mon.maxHp}`
      const mainTag = player.mainPokemonId === mon.id ? ' 🛡️ Main' : ''
      return `${index + 1}. ${mon.shiny ? '✨ ' : ''}*${mon.nickname ?? mon.name}* — Lvl ${mon.level} · HP ${hp}${mainTag}`
    })
    return reply(
      `⚔️ *${player.name}'s Pokémon Battle Party* ⚔️\n\n` +
      lines.join('\n') + '\n\n' + caption,
    )
  }
}

async function handleBattlePartyAdd(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix
  const query = args.slice(1).join(' ').trim()
  if (!query) return reply(`❓ Usage: *${pr}party add <name>*`)

  let outcome = null
  await updatePlayer(db, player.id, p => {
    const mon = findOwnedPokemon(p, query)
    if (!mon) { outcome = { ok: false, reason: 'missing' }; return p }
    const ids = battlePartyIds(p)
    if (ids.includes(mon.id)) { outcome = { ok: false, reason: 'already' }; return p }
    if (ids.length >= BATTLE_PARTY_SIZE) { outcome = { ok: false, reason: 'full' }; return p }
    p.battlePartyIds = [...ids, mon.id]
    outcome = { ok: true, mon }
    return p
  })

  if (!outcome?.ok) {
    if (outcome?.reason === 'missing') return reply(`🚫 You don't own a Pokémon matching *"${query}"*.`)
    if (outcome?.reason === 'already') return reply(`⚠️ *${query}* is already in your battle party.`)
    return reply(`🛑 Your battle party already has ${BATTLE_PARTY_SIZE} Pokémon.`)
  }
  return reply(`✅ *${outcome.mon.nickname ?? outcome.mon.name}* added to your battle party (${battlePartyMembers(getPlayer(db, player.id)).length}/${BATTLE_PARTY_SIZE}).`)
}

async function handleBattlePartyRemove(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix
  const query = args.slice(1).join(' ').trim()
  if (!query) return reply(`❓ Usage: *${pr}party remove <name>*`)

  let outcome = null
  await updatePlayer(db, player.id, p => {
    const mon = findOwnedPokemon(p, query)
    if (!mon) { outcome = { ok: false }; return p }
    const ids = battlePartyIds(p)
    if (!ids.includes(mon.id)) { outcome = { ok: false, notInParty: true, mon }; return p }
    p.battlePartyIds = ids.filter(id => id !== mon.id)
    outcome = { ok: true, mon }
    return p
  })

  if (!outcome?.ok) {
    if (outcome?.notInParty) return reply(`⚠️ *${outcome.mon.nickname ?? outcome.mon.name}* is not in your battle party.`)
    return reply(`🚫 You don't own a Pokémon matching *"${query}"*.`)
  }
  return reply(`✅ *${outcome.mon.nickname ?? outcome.mon.name}* removed from your battle party.`)
}

async function handleBattlePartyClear(ctx) {
  const { reply, player, db } = ctx
  await updatePlayer(db, player.id, p => {
    p.battlePartyIds = []
    return p
  })
  return reply(`🧹 Your Pokémon battle party has been cleared. Use *${config.prefix}party add <name>* to fill it again.`)
}

// ── .party dex [page] ────────────────────────────────────────────────────────
async function handleDex(ctx, pageArg) {
  const { reply, player } = ctx
  const pr = config.prefix
  const mon = player.pokemon ?? []

  if (!mon.length) {
    return reply(
      `🐾 *${player.name}'s Pokédex*\n\n` +
      `_Empty._\n\n` +
      `_Wild Pokémon spawn in enabled groups — catch one with *${pr}collect <code>*._`
    )
  }

  const sorted = [...mon].sort((a, b) => b.level - a.level)
  const page = Math.max(1, parseInt(pageArg, 10) || 1)
  const totalPages = Math.max(1, Math.ceil(sorted.length / DEX_PAGE_SIZE))
  const clamped = Math.min(page, totalPages)
  const start = (clamped - 1) * DEX_PAGE_SIZE
  const pageItems = sorted.slice(start, start + DEX_PAGE_SIZE)

  const lines = pageItems.map((m, i) => {
    const shinyTag = m.shiny ? '✨ ' : ''
    const nickTag  = m.nickname ? ` _(${m.nickname})_` : ''
    const mainTag  = player.mainPokemonId === m.id ? ' 🛡️' : ''
    return `*#${start + i + 1}* ${shinyTag}*${m.name}*${nickTag}${mainTag} — Lvl ${m.level}`
  })

  const footer = totalPages > 1
    ? `\n\n📄 _Page ${clamped}/${totalPages}_` + (clamped < totalPages ? `   ▶️ *${pr}p-poke ${clamped + 1}*` : '')
    : ''

  return reply(
    `🐾 *${player.name}'s Pokédex* _(${mon.length} caught)_\n\n` +
    lines.join('\n') +
    footer +
    `\n\n_${pr}p-poke info <name>_ · _${pr}p-poke main <name>_`
  )
}

// ── .p-poke info <name> ─────────────────────────────────────────────────────
async function handleInfo(ctx) {
  const { args, reply, player, sock, msg } = ctx
  const pr = config.prefix
  const query = args.slice(1).join(' ').trim()
  if (!query) return reply(`❓ Usage: *${pr}p-poke info <name>*`)

  const mon = findOwnedPokemon(player, query)
  if (!mon) return reply(`❌ No Pokémon matching *"${query}"* in your Pokédex.`)

  // Real IV/EV/nature-aware battle stats (overhaul addendum §9.4) — same
  // computation plugins/pokebattle.js's statsOf() uses for damage calc, so
  // what's shown here always matches what actually fights.
  const stats = computeBattleStats(mon)
  const ivs = mon.ivs ?? {}
  const evs = mon.evs ?? {}
  const evTotal = Object.values(evs).reduce((sum, v) => sum + (v ?? 0), 0)
  const natureLabel = mon.nature
    ? mon.nature.charAt(0).toUpperCase() + mon.nature.slice(1)
    : 'Unknown'

  const caption =
    `📊 *Pokémon Analysis* 📊\n\n` +
    `🦊 *Name:* ${mon.name}${mon.nickname ? ` _("${mon.nickname}")_` : ''}\n` +
    `🆙 *Level:* ${mon.level}\n` +
    `✨ *Shiny:* ${mon.shiny ? 'Yes ✨' : 'No'}\n` +
    `🎭 *Nature:* ${natureLabel}\n` +
    `${formatTypes(mon.types)}\n\n` +
    `⚔️ *Stats:*\n` +
    `🫀 HP: ${mon.currentHp}/${mon.maxHp}\n` +
    `⚔️ ATK: ${stats.atk}${mon.trainedAtk ? ` _(+${mon.trainedAtk} trained)_` : ''}\n` +
    `🛡️ DEF: ${stats.def}${mon.trainedDef ? ` _(+${mon.trainedDef} trained)_` : ''}\n` +
    `🔮 SP.ATK: ${stats.spAtk}${mon.trainedSpAtk ? ` _(+${mon.trainedSpAtk} trained)_` : ''}\n` +
    `🌙 SP.DEF: ${stats.spDef}${mon.trainedSpDef ? ` _(+${mon.trainedSpDef} trained)_` : ''}\n` +
    `💨 SPD: ${stats.spd}\n\n` +
    `🧬 *IVs:* HP ${ivs.hp ?? 0} · ATK ${ivs.atk ?? 0} · DEF ${ivs.def ?? 0} · SPA ${ivs.spAtk ?? 0} · SPD ${ivs.spDef ?? 0} · SPE ${ivs.spd ?? 0} _(/31)_\n` +
    `📈 *EVs:* HP ${evs.hp ?? 0} · ATK ${evs.atk ?? 0} · DEF ${evs.def ?? 0} · SPA ${evs.spAtk ?? 0} · SPD ${evs.spDef ?? 0} · SPE ${evs.spd ?? 0} _(${evTotal}/510)_\n\n` +
    `❤️ *Happiness:* ${mon.happiness}/100\n` +
    (mon.protected ? `🔒 _Protected — can't be released or traded._\n\n` : '\n') +
    `_${pr}p-poke feed ${mon.name}_ · _${pr}p-poke main ${mon.name}_`

  return sock.sendMessage(msg.key.remoteJid, { image: { url: mon.image }, caption }, { quoted: msg })
}

// ── .p-poke moveset <name> ──────────────────────────────────────────────────
// Read-only in v1 — no re-teaching/swapping moves (that's future scope, see
// the Pokémon overhaul master prompt §2). Just inspects the 4 moves assigned
// at catch time by lib/move-pool.js's pickDefaultMoveset().
async function handleMoveset(ctx) {
  const { args, reply, player } = ctx
  const pr = config.prefix
  const query = args.slice(1).join(' ').trim()
  if (!query) return reply(`❓ Usage: *${pr}p-poke moveset <name>*`)

  const mon = findOwnedPokemon(player, query)
  if (!mon) return reply(`❌ No Pokémon matching *"${query}"* in your Pokédex.`)

  // findOwnedPokemon() already lazy-backfills via ensurePokemonExtendedFields(),
  // so mon.moves is guaranteed to be a populated array here even for old saves.
  const moves = getMovesForIds(mon.moves)

  const lines = moves.map((mv, i) => {
    const power = mv.power != null ? mv.power : '—'
    const acc   = mv.accuracy != null ? `${mv.accuracy}%` : 'Never misses'
    const cat   = mv.category.charAt(0).toUpperCase() + mv.category.slice(1)
    return `*${i + 1}.* ${typeEmoji(mv.type)} *${mv.name}* _(${cat})_\n` +
           `   Power: ${power} · Accuracy: ${acc} · PP: ${mv.pp}`
  })

  return reply(
    `🎯 *${mon.name}'s Moveset* 🎯\n\n` +
    (lines.length ? lines.join('\n\n') : '_No moves found._') +
    `\n\n_Moveset is fixed at catch time — no re-teaching in v1._`
  )
}

// ── .p-poke main <name> ─────────────────────────────────────────────────────
async function handleMain(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix
  const query = args.slice(1).join(' ').trim()
  if (!query) return reply(`🛡️ Usage: *${pr}p-poke main <name>*`)

  const mon = findOwnedPokemon(player, query)
  if (!mon) return reply(`🚫 You don't own a Pokémon matching *"${query}"*.`)

  await updatePlayer(db, player.id, p => {
    setMainPokemon(p, mon.id)
    return p
  })

  return reply(
    `✅ *Main Fighter Updated!*\n\n` +
    `${mon.shiny ? '✨ ' : ''}*${mon.name}* (Lvl ${mon.level}) is now your buddy!\n\n` +
    `It will now fight for you in Pokémon battles.`
  )
}

// ── .p-poke feed <name> ─────────────────────────────────────────────────────
async function handleFeed(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix
  const query = args.slice(1).join(' ').trim()
  if (!query) return reply(`🍓 Usage: *${pr}p-poke feed <name>*`)

  const balance = player.wallet?.solars ?? 0
  if (balance < FEED_COST) return reply(`💸 You need *${FEED_COST}* Solars to buy a Berry!`)

  let outcome = null
  await updatePlayer(db, player.id, p => {
    const mon = findOwnedPokemon(p, query)
    if (!mon) { outcome = { ok: false }; return p }

    p.wallet = p.wallet ?? {}
    p.wallet.solars = (p.wallet.solars ?? 0) - FEED_COST

    const xpGain = Math.floor(Math.random() * 50) + 20
    const happinessGain = Math.floor(Math.random() * 5) + 1
    mon.exp = (mon.exp ?? 0) + xpGain
    mon.happiness = Math.min(100, (mon.happiness ?? 0) + happinessGain)
    mon.currentHp = Math.min(mon.maxHp, mon.currentHp + 20)

    let leveledUp = false
    if (mon.exp >= mon.level * 100) {
      mon.level += 1
      mon.exp = 0
      mon.maxHp = basePokemonHp(mon.baseHp, mon.level)
      mon.currentHp = mon.maxHp
      leveledUp = true
    }

    outcome = { ok: true, mon, xpGain, leveledUp }
    return p
  })

  if (!outcome?.ok) return reply(`🚫 You don't own a Pokémon matching *"${query}"*.`)

  // Evolution check — overhaul addendum §8.2. Only worth checking when this
  // feed actually leveled the Pokémon up; a live PokéAPI fetch on every
  // single feed (even non-level-up ones) would be a wasted call almost
  // every time. Run in its own updatePlayer AFTER the feed write above has
  // already landed, since it needs its own await (PokéAPI fetch) and
  // shouldn't hold the feed's write lock open any longer than necessary.
  let evolution = null
  if (outcome.leveledUp) {
    await updatePlayer(db, player.id, async p => {
      const freshMon = findOwnedPokemon(p, query)
      if (!freshMon) return p
      evolution = await runLevelUpEvolutionCheck(freshMon)
      return p
    })
  }

  const evoLine = evolution
    ? `\n\n🎉 Your *${evolution.oldName}* is evolving! ✨\nCongratulations! Your *${evolution.oldName}* evolved into *${evolution.newName}*!`
    : ''

  return reply(
    `🍓 *Yummy!* 🍓\n\n` +
    `You fed *${outcome.mon.name}* a Berry!\n\n` +
    `✨ *XP Gained:* +${outcome.xpGain}\n` +
    `❤️ *Happiness:* ${outcome.mon.happiness}/100\n` +
    `💚 *HP Restored:* +20` +
    (outcome.leveledUp && !evolution ? `\n🆙 *LEVEL UP!* It grew to Level ${outcome.mon.level}!` : '') +
    evoLine
  )
}

// ── .p-poke train <name> ────────────────────────────────────────────────────
async function handleTrain(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix
  const query = args.slice(1).join(' ').trim()
  if (!query) return reply(`💪 Usage: *${pr}p-poke train <name>*`)

  const target = findOwnedPokemon(player, query)
  if (!target) return reply(`🚫 You don't own a Pokémon matching *"${query}"*.`)

  const cost = target.level * 200
  const balance = player.wallet?.solars ?? 0
  if (balance < cost) return reply(`💸 Training costs *${cost}* Solars! You need more Solars.`)

  let outcome = null
  await updatePlayer(db, player.id, p => {
    const mon = findOwnedPokemon(p, query)
    if (!mon) { outcome = { ok: false }; return p }

    p.wallet.solars = (p.wallet.solars ?? 0) - cost
    const atkGain = Math.floor(Math.random() * 5) + 1
    const defGain = Math.floor(Math.random() * 5) + 1
    mon.trainedAtk = (mon.trainedAtk ?? 0) + atkGain
    mon.trainedDef = (mon.trainedDef ?? 0) + defGain
    mon.exp = (mon.exp ?? 0) + 50

    let leveledUp = false
    if (mon.exp >= mon.level * 100) {
      mon.level += 1
      mon.exp = 0
      mon.maxHp = basePokemonHp(mon.baseHp, mon.level)
      mon.currentHp = mon.maxHp
      leveledUp = true
    }

    outcome = { ok: true, mon, atkGain, defGain, cost, leveledUp }
    return p
  })

  if (!outcome?.ok) return reply(`🚫 You don't own a Pokémon matching *"${query}"*.`)

  // Evolution check — overhaul addendum §8.2, same rationale as handleFeed's:
  // only bother with the live PokéAPI fetch on turns that actually leveled up.
  let evolution = null
  if (outcome.leveledUp) {
    await updatePlayer(db, player.id, async p => {
      const freshMon = findOwnedPokemon(p, query)
      if (!freshMon) return p
      evolution = await runLevelUpEvolutionCheck(freshMon)
      return p
    })
  }

  const evoLine = evolution
    ? `\n\n🎉 Your *${evolution.oldName}* is evolving! ✨\nCongratulations! Your *${evolution.oldName}* evolved into *${evolution.newName}*!`
    : ''

  return reply(
    `💪 *Training Complete!* 💪\n\n` +
    `*${outcome.mon.name}* worked hard at the gym!\n\n` +
    `⚔️ *ATK Increased:* +${outcome.atkGain}\n` +
    `🛡️ *DEF Increased:* +${outcome.defGain}\n` +
    `💸 *Cost:* ${outcome.cost} Solars` +
    (outcome.leveledUp && !evolution ? `\n🆙 *LEVEL UP!* It grew to Level ${outcome.mon.level}!` : '') +
    evoLine
  )
}

// ── .p-poke heal ─────────────────────────────────────────────────────────────
async function handleHeal(ctx) {
  const { reply, player, db } = ctx
  let healedCount = 0

  await updatePlayer(db, player.id, p => {
    const mon = p.pokemon ?? []
    if (!mon.length) return p
    for (const m of mon) {
      if (m.currentHp < m.maxHp) {
        m.currentHp = m.maxHp
        healedCount++
      }
    }
    return p
  })

  if (!(player.pokemon ?? []).length) return reply(`You have no Pokémon to heal!`)
  if (healedCount === 0) return reply(`✨ Your team is already fully healthy!`)

  return reply(
    `💊 *Pokémon Center* 💊\n\n` +
    `We healed your Pokémon.\n\n` +
    `✨ *${healedCount}* Pokémon restored to full health!`
  )
}

// ── .p-poke rename <name> | <nickname> ───────────────────────────────────────
async function handleRename(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix
  const rest = args.slice(1).join(' ')
  if (!rest.includes('|')) {
    return reply(`⚠️ Usage: *${pr}p-poke rename <name> | <nickname>*`)
  }

  const [namePart, nickPart] = rest.split('|')
  const query = namePart.trim()
  const nickname = nickPart.trim()
  if (!query || !nickname) return reply(`⚠️ Usage: *${pr}p-poke rename <name> | <nickname>*`)

  const mon = findOwnedPokemon(player, query)
  if (!mon) return reply(`🚫 You don't own a Pokémon matching *"${query}"*.`)

  await updatePlayer(db, player.id, p => {
    const m = findOwnedPokemon(p, query)
    if (m) m.nickname = nickname
    return p
  })

  return reply(`✅ Success! Your *${mon.name}* is now called *"${nickname}"*!`)
}

// ── .p-poke protect <name> ───────────────────────────────────────────────────
async function handleProtect(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix
  const query = args.slice(1).join(' ').trim()
  if (!query) return reply(`Usage: *${pr}p-poke protect <name>*`)

  const mon = findOwnedPokemon(player, query)
  if (!mon) return reply(`🚫 You don't own a Pokémon matching *"${query}"*.`)

  let nowProtected = null
  await updatePlayer(db, player.id, p => {
    const m = findOwnedPokemon(p, query)
    if (m) {
      m.protected = !m.protected
      nowProtected = m.protected
    }
    return p
  })

  return reply(
    nowProtected
      ? `🛡️ *Protected!*\n\n*${mon.name}* is now locked. You cannot release or trade it.`
      : `🔓 *Unlocked!*\n\n*${mon.name}* is no longer protected. Be careful!`
  )
}

// ── .p-poke release <name> ───────────────────────────────────────────────────
async function handleRelease(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix
  const query = args.slice(1).join(' ').trim()
  if (!query) return reply(`Which Pokémon to release? Usage: *${pr}p-poke release <name>*`)

  let outcome = null
  await updatePlayer(db, player.id, p => {
    const mon = findOwnedPokemon(p, query)
    if (!mon) { outcome = { ok: false }; return p }
    if (mon.protected) { outcome = { ok: false, isProtected: true, mon }; return p }

    const reward = mon.level * 100
    p.pokemon = (p.pokemon ?? []).filter(m => m.id !== mon.id)
    if (p.mainPokemonId === mon.id) p.mainPokemonId = null
    p.wallet = p.wallet ?? {}
    p.wallet.solars = (p.wallet.solars ?? 0) + reward

    outcome = { ok: true, mon, reward, balance: p.wallet.solars }
    return p
  })

  if (!outcome?.ok) {
    if (outcome?.isProtected) {
      return reply(`❌ *${outcome.mon.name}* is protected — unprotect it first with *${pr}p-poke protect ${outcome.mon.name}*.`)
    }
    return reply(`🚫 You don't own a Pokémon matching *"${query}"*.`)
  }

  return reply(
    `👋 *Goodbye ${outcome.mon.name}!*\n\n` +
    `You released your Pokémon back into the wild.\n` +
    `💰 You received *${outcome.reward}* Solars for your efforts!\n` +
    `☀️ Balance: *${outcome.balance}*`
  )
}

// ── .p-poke evolve <name> <item> ─────────────────────────────────────────────
// Overhaul addendum §8.3 — consumes an evolution item (category: "evolution"
// in data/pokemon-items.json) to trigger a use-item evolution.
async function handleEvolve(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix

  if (args.length < 3) {
    return reply(`❓ Usage: *${pr}p-poke evolve <name> <item>*\n_e.g._ *${pr}p-poke evolve eevee fire stone*`)
  }

  const rest = args.slice(1)
  let monQuery = null
  let itemQuery = null
  let item = null

  for (let split = 1; split < rest.length; split++) {
    const monCandidate = rest.slice(0, split).join(' ')
    const itemCandidate = rest.slice(split).join(' ')
    const mon = findOwnedPokemon(player, monCandidate)
    if (!mon) continue
    const foundItem = findEvolutionItemInInventory(player.inventory ?? [], itemCandidate)
    if (foundItem) {
      monQuery = monCandidate
      itemQuery = itemCandidate
      item = foundItem
      break
    }
  }

  if (!monQuery) {
    return reply(`🚫 Couldn't match a Pokémon and an evolution item you're holding in *"${rest.join(' ')}"*.`)
  }
  if (!item) {
    return reply(
      `❌ You don't have an evolution item matching *"${itemQuery ?? rest.join(' ')}"*.\n` +
      `Check *${pr}inventory* or buy one with *${pr}p-shop evolution*.`
    )
  }

  const mon = findOwnedPokemon(player, monQuery)
  const target = await findItemEvolution(mon, item.apiItemName)
  if (!target) {
    return reply(
      `❌ *${mon.nickname ?? mon.name}* doesn't evolve with *${item.name}* — wrong item for this species, ` +
      `or it doesn't evolve via item at all.`
    )
  }

  let outcome = null
  await updatePlayer(db, player.id, async p => {
    const inv = p.inventory ?? []
    const idx = inv.indexOf(item.id)
    if (idx === -1) { outcome = { ok: false, reason: 'gone' }; return p }

    const freshMon = findOwnedPokemon(p, monQuery)
    if (!freshMon) { outcome = { ok: false, reason: 'no_mon' }; return p }

    const evolution = await applyEvolution(freshMon, target)
    if (!evolution) { outcome = { ok: false, reason: 'fetch_failed' }; return p }

    inv.splice(idx, 1)
    p.inventory = inv
    outcome = { ok: true, evolution }
    return p
  })

  if (!outcome?.ok) {
    if (outcome?.reason === 'no_mon') return reply(`🚫 You don't own a Pokémon matching *"${monQuery}"*.`)
    if (outcome?.reason === 'fetch_failed') return reply(`❌ Couldn't reach the Pokémon data service — try again in a moment. Your item wasn't consumed.`)
    return reply(`❌ *${item.name}* is no longer in your inventory — please try again.`)
  }

  return reply(
    `🎉 Your *${outcome.evolution.oldName}* is evolving! ✨\n` +
    `Congratulations! Your *${outcome.evolution.oldName}* evolved into *${outcome.evolution.newName}*!`
  )
}

/** Finds an evolution-category item in the player's inventory by exact id or partial name. */
function findEvolutionItemInInventory(inventory, query) {
  const q = String(query ?? '').toLowerCase().trim()
  const withPrefix = q.startsWith('poke_') ? q : `poke_${q.replace(/\s+/g, '_')}`
  for (const candidate of [q, withPrefix]) {
    const item = pokeItemMap.get(candidate)
    if (item?.category === 'evolution' && inventory.includes(candidate)) return item
  }
  for (const id of inventory) {
    const item = pokeItemMap.get(id)
    if (item?.category === 'evolution' && item.name.toLowerCase().includes(q)) return item
  }
  return null
}

// ── .p-poke hold <name> <item> ───────────────────────────────────────────────
// Overhaul addendum §11.1 — equips a held-category item onto a Pokémon.
// Mirrors plugins/equip.js's "leaves inventory while worn" convention.
async function handleHold(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix

  if (args.length < 3) {
    return reply(`❓ Usage: *${pr}p-poke hold <name> <item>*\n_e.g._ *${pr}p-poke hold pikachu leftovers*`)
  }

  const rest = args.slice(1)
  let monQuery = null
  let item = null

  for (let split = 1; split < rest.length; split++) {
    const monCandidate = rest.slice(0, split).join(' ')
    const itemCandidate = rest.slice(split).join(' ')
    const mon = findOwnedPokemon(player, monCandidate)
    if (!mon) continue
    const foundItem = findHeldItemInInventory(player.inventory ?? [], itemCandidate)
    if (foundItem) {
      monQuery = monCandidate
      item = foundItem
      break
    }
  }

  if (!monQuery || !item) {
    return reply(
      `🚫 Couldn't match a Pokémon and a held item you're carrying in *"${rest.join(' ')}"*.\n` +
      `Check *${pr}inventory* or buy one with *${pr}p-shop held*.`
    )
  }

  let outcome = null
  await updatePlayer(db, player.id, p => {
    const inv = p.inventory ?? []
    const idx = inv.indexOf(item.id)
    if (idx === -1) { outcome = { ok: false, reason: 'gone' }; return p }

    const freshMon = findOwnedPokemon(p, monQuery)
    if (!freshMon) { outcome = { ok: false, reason: 'no_mon' }; return p }

    let returnedItemName = null
    if (freshMon.heldItem) {
      const oldItem = pokeItemMap.get(freshMon.heldItem)
      returnedItemName = oldItem?.name ?? freshMon.heldItem
      inv.push(freshMon.heldItem)
    }

    inv.splice(idx, 1)
    freshMon.heldItem = item.id
    p.inventory = inv
    outcome = { ok: true, mon: freshMon, returnedItemName }
    return p
  })

  if (!outcome?.ok) {
    if (outcome?.reason === 'no_mon') return reply(`🚫 You don't own a Pokémon matching *"${monQuery}"*.`)
    return reply(`❌ *${item.name}* is no longer in your inventory — please try again.`)
  }

  const swapLine = outcome.returnedItemName
    ? `\n↩️ *${outcome.returnedItemName}* returned to your inventory.`
    : ''

  return reply(
    `🎗️ *${outcome.mon.nickname ?? outcome.mon.name}* is now holding *${item.name}*!${swapLine}`
  )
}

// ── .p-poke unhold <name> ────────────────────────────────────────────────────
async function handleUnhold(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix
  const query = args.slice(1).join(' ').trim()
  if (!query) return reply(`❓ Usage: *${pr}p-poke unhold <name>*`)

  const mon = findOwnedPokemon(player, query)
  if (!mon) return reply(`🚫 You don't own a Pokémon matching *"${query}"*.`)
  if (!mon.heldItem) return reply(`*${mon.nickname ?? mon.name}* isn't holding anything.`)

  let outcome = null
  await updatePlayer(db, player.id, p => {
    const freshMon = findOwnedPokemon(p, query)
    if (!freshMon?.heldItem) { outcome = { ok: false }; return p }

    const itemId = freshMon.heldItem
    const item = pokeItemMap.get(itemId)
    p.inventory = p.inventory ?? []
    p.inventory.push(itemId)
    freshMon.heldItem = null

    outcome = { ok: true, mon: freshMon, itemName: item?.name ?? itemId }
    return p
  })

  if (!outcome?.ok) return reply(`*${mon.nickname ?? mon.name}* isn't holding anything.`)

  return reply(
    `↩️ *${outcome.itemName}* returned to your inventory. *${outcome.mon.nickname ?? outcome.mon.name}* is no longer holding it.`
  )
}

/** Finds a held-category item in the player's inventory by exact id or partial name. */
function findHeldItemInInventory(inventory, query) {
  const q = String(query ?? '').toLowerCase().trim()
  const withPrefix = q.startsWith('poke_') ? q : `poke_${q.replace(/\s+/g, '_')}`
  for (const candidate of [q, withPrefix]) {
    const item = pokeItemMap.get(candidate)
    if (item?.category === 'held' && inventory.includes(candidate)) return item
  }
  for (const id of inventory) {
    const item = pokeItemMap.get(id)
    if (item?.category === 'held' && item.name.toLowerCase().includes(q)) return item
  }
  return null
}

// ── .p-poke give <name> @user ────────────────────────────────────────────────
async function handleGive(ctx) {
  const { args, reply, player, db } = ctx
  const pr = config.prefix
  const nameArg = args[1]
  const targetJid = resolveTargetJid(ctx, args[2])

  if (!nameArg || !targetJid) return reply(`🎁 Usage: *${pr}p-poke give <name> @user*`)
  if (targetJid === ctx.from) return reply(`😐 You can't gift yourself a Pokémon!`)
  if (!playerExists(db, targetJid)) return reply(`❌ That player isn't registered yet.`)

  const mon = findOwnedPokemon(player, nameArg)
  if (!mon) return reply(`🚫 You don't own a Pokémon matching *"${nameArg}"*.`)
  if (mon.protected) return reply(`❌ *${mon.name}* is protected — unprotect it first with *${pr}p-poke protect ${mon.name}*.`)

  await updatePlayer(db, ctx.from, p => {
    p.pokemon = (p.pokemon ?? []).filter(m => m.id !== mon.id)
    if (p.mainPokemonId === mon.id) p.mainPokemonId = null
    return p
  })
  await updatePlayer(db, targetJid, p => {
    if (!Array.isArray(p.pokemon)) p.pokemon = []
    p.pokemon.push(mon)
    return p
  })

  const targetName = getPlayer(db, targetJid)?.name ?? targetJid.split('@')[0]
  return reply(
    `🎁 *Pokémon Transferred!*\n\n` +
    `*${player.name}* sent *${mon.name}* (Lvl ${mon.level}) to *${targetName}*!`
  )
}
