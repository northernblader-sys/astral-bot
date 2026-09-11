/**
 * skillpack.js — Skill Packs: gem-priced gacha pulls that grant powerful,
 * class-agnostic pack-exclusive skills straight into player.skills (same
 * "just push the id" mechanism the level-up skill grant uses — see
 * lib/combat-engine.js's getNewlyUnlockedSkills).
 *
 * Every pack purchase is `pullsPerPurchase` (3) independent weighted rolls
 * across a shared 50-skill pool (data/skills.json entries with
 * "source": "skill_pack"). Pack skills top out at a "mythic" tier, above
 * the normal common→legendary curve (see data/skill-tiers.json) — they're
 * meant to be a genuine power spike, not a cosmetic reskin.
 *
 * Pulling a skill the player already owns wastes that pull (skipped, not
 * replaced) — a purchase can net fewer than 3 new skills if unlucky.
 *
 * Commands:
 *   .skillpack                    — list available packs + your gem balance
 *   .skillpack info <pack>        — pack odds + gem price breakdown
 *   .skillpack buy <pack>         — buy 3 pulls, reveals what you got
 *
 * Also reachable via .shop buy <pack name>, same convention as ability_slot.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { sendImage } from '../lib/image.js'
import { allPacks, findPack, pullPack } from '../lib/skill-pack-engine.js'

// Shown behind every .skillpack reply (menu, info, and the buy/spin reveal)
// — same "banner + caption" convention as SHOP_BANNER in plugins/shop.js.
const SKILLPACK_BANNER = 'https://i.ibb.co/3yqGxGgW/gemini-image-2-i-want-you-to-recreate-somethng-like-this-but-the-title-shd-be-astral-skills-pac-0.jpg'

const TIER_ORDER = ['common', 'uncommon', 'rare', 'epic', 'mythic']

function fmtOdds(odds) {
  return TIER_ORDER
    .filter(t => odds[t] != null)
    .map(t => `${t[0].toUpperCase()}${t.slice(1)} ${odds[t]}%`)
    .join('  ·  ')
}

function packLine(pack) {
  const totalCost = pack.gemPrice
  return (
    `✨ *${pack.name}* — 💎 *${totalCost}* _(${pack.pullsPerPurchase} pulls)_\n` +
    `   ${pack.description}\n` +
    `   _${fmtOdds(pack.odds)}_`
  )
}

function mainMenu(player) {
  const p = config.prefix
  const gems = player.wallet?.gems ?? 0
  const lines = allPacks().map(packLine).join('\n\n')
  return (
    `┏━━━━━━━━━━━━━━┓\n` +
    `┃  🎴 *SKILL PACKS* 🎴\n` +
    `┗━━━━━━━━━━━━━━┛\n` +
    `_Pull powerful, class-agnostic skills — up to *Mythic* tier, above anything the level-up path grants._\n\n` +
    `💎 *${fmtGems(gems)}* Gems\n\n` +
    `${lines}\n\n` +
    `🛒 *${p}skillpack buy <pack>* — _e.g._ *${p}skillpack buy mythic_reliquary*\n` +
    `🔍 *${p}skillpack info <pack>* — _full odds breakdown_`
  )
}

function infoText(pack) {
  const p = config.prefix
  const totalCost = pack.gemPrice
  return (
    `🎴 *${pack.name}*\n\n` +
    `${pack.description}\n\n` +
    `💎 *${totalCost}* gems  ·  *${pack.pullsPerPurchase}* pulls per purchase\n\n` +
    `*Odds per pull:*\n${fmtOdds(pack.odds)}\n\n` +
    `⚠️ _Duplicate pulls (a skill you already own) are wasted — you may end up with fewer than ${pack.pullsPerPurchase} new skills._\n\n` +
    `🛒 *${p}skillpack buy ${pack.id}*`
  )
}

/**
 * Exported so plugins/shop.js's `.shop buy <pack>` can route straight into
 * this same purchase flow — same convention as ABILITY_SLOT_ALIASES routing
 * into handleBuyAbilitySlot, just across a file boundary since packs got
 * their own dedicated command too.
 */
export async function handleBuy(ctx, args) {
  const p = config.prefix
  const query = args.slice(1).join(' ')
  if (!query) {
    return ctx.reply(
      `❌ *Usage:* *${p}skillpack buy <pack>*\n` +
      `_Example:_ *${p}skillpack buy mythic_reliquary*\n\n` +
      `_See_ *${p}skillpack* _for the list of packs._`,
    )
  }

  const pack = findPack(query)
  if (!pack) {
    return ctx.reply(
      `❌ *Pack* "_${query}_" *not found.*\n` +
      `_See_ *${p}skillpack* _for available packs._`,
    )
  }

  if (ctx.player?.inBattle) {
    return ctx.reply(`⚔️ *You're mid-battle* — Skill Packs can't be opened right now.`)
  }

  const totalCost = pack.gemPrice
  let outcome = null

  await updatePlayer(ctx.db, ctx.from, (player) => {
    const gems = player.wallet?.gems ?? 0
    if (gems < totalCost) {
      outcome = { ok: false, reason: 'gems', gems }
      return player
    }

    const { hits, wasted } = pullPack(pack, player.skills ?? [])

    player.wallet.gems = roundGems(gems - totalCost)
    player.skills = player.skills ?? []
    for (const skill of hits) {
      player.skills.push(skill.id)
    }

    outcome = { ok: true, hits, wasted, player }
    return player
  })

  if (outcome.reason === 'gems') {
    const short = totalCost - outcome.gems
    return ctx.reply(
      `❌ *Not enough Gems!*\n` +
      `*${pack.name}* costs 💎 *${totalCost}* _(${pack.pullsPerPurchase} pulls)_.\n` +
      `You have 💎 *${fmtGems(outcome.gems)}*. You need 💎 *${fmtGems(short)}* more.`,
    )
  }

  const hitLines = outcome.hits.length
    ? outcome.hits.map(s => `  • *${s.name}* _(${s.tier})_`).join('\n')
    : '  _(none — every pull was a duplicate)_'

  return sendImage(
    ctx, SKILLPACK_BANNER,
    `🎴 *${pack.name} opened!*\n\n${hitLines}\n\n` +
    `_Equip a new skill with_ *${p}skillslot set <name>*.`,
  )
}

export default {
  name:           'skillpack',
  aliases:        ['skillpacks', 'packs'],
  category:       'economy',
  requiresPlayer: true,
  description:    'Buy gem-priced Skill Packs for a chance at powerful mythic-tier skills',

  async run(ctx) {
    const { args, player } = ctx
    const sub = args[0]?.toLowerCase()

    if (!sub)                              return sendImage(ctx, SKILLPACK_BANNER, mainMenu(player))
    if (sub === 'buy' || sub === 'open')   return handleBuy(ctx, args)
    if (sub === 'info' || sub === 'odds') {
      const pack = findPack(args.slice(1).join(' '))
      if (!pack) return sendImage(ctx, SKILLPACK_BANNER, `❌ *Pack not found.* _See_ *${config.prefix}skillpack* _for the list._`)
      return sendImage(ctx, SKILLPACK_BANNER, infoText(pack))
    }

    return sendImage(ctx, SKILLPACK_BANNER, `❌ *Unknown skillpack command* "_${sub}_".\n\n` + mainMenu(player))
  },
}
