/**
 * givebeast.js — .givebeast <beast name or id> [@mention | reply]
 * Standalone owner-only command (same family as .givegems/.giveitem). Grants a
 * summoned beast (the mining beasts from data/beasts.json) to a target player
 * (defaults to yourself if no @mention/reply given).
 *
 * Mirrors plugins/mine.js's beast-find acquisition exactly — same entry shapes
 * ({ beastId, cp, obtainedAt } in summonedBeasts, { beastId, obtainedAt } in
 * beastInventory, auto-equip when no active beast) — with the 4-beast roster
 * cap enforced at grant time, the same way season shop and the mining find do.
 * Duplicates are refused: a roster is one entry per beast.
 *
 * Example: .givebeast ember hatchling @player
 */
import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { beastMap } from '../lib/game-data.js'
import { BEAST_MAX_OWNED, findOwnedBeast, getBeastStats } from '../lib/beast-engine.js'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { resolveTargetId } from './admin.js'

/** Resolves a beast by id or (partial) name, so the owner can type either. */
export function findBeastDef(query) {
  const q = (query ?? '').toLowerCase().trim()
  if (!q) return null
  if (beastMap[q]) return beastMap[q]
  return Object.values(beastMap).find((b) => b.name.toLowerCase() === q)
    ?? Object.values(beastMap).find((b) => b.name.toLowerCase().includes(q))
    ?? null
}

export async function giveBeast(ctx) {
  const { args, reply, db } = ctx
  const p = config.prefix
  // Anything that looks like a mention belongs to the targeting, not the name.
  const query = args.slice(1).filter(a => a && !a.startsWith('@')).join(' ').trim()
  if (!query) {
    return reply(`❌ Usage: *${p}givebeast <beast name or id> [@user]*\n_Example: *${p}givebeast ember hatchling @player*_`)
  }

  const def = findBeastDef(query)
  if (!def) {
    const list = Object.values(beastMap)
      .map(b => `  • *${b.name}* (${b.id})`)
      .join('\n')
    return reply(`❌ No beast matching *"${query}"*.\n\n${list}`)
  }

  const targetId = resolveTargetId(ctx)
  const target = getPlayer(db, targetId)
  if (!target) return reply(`❌ That player isn't registered yet.`)

  let outcome = null
  await updatePlayer(db, targetId, (pl) => {
    if ((pl.summonedBeasts ?? []).length >= BEAST_MAX_OWNED) { outcome = { reason: 'full' }; return pl }
    if (findOwnedBeast(pl, def.id)) { outcome = { reason: 'owned' }; return pl }
    pl.beastInventory = [...(pl.beastInventory ?? []), { beastId: def.id, obtainedAt: Date.now() }]
    pl.summonedBeasts = [...(pl.summonedBeasts ?? []), { beastId: def.id, cp: def.startingCp ?? 50, obtainedAt: Date.now() }]
    if (!pl.activeBeast) pl.activeBeast = def.id
    outcome = { reason: 'ok' }
    return pl
  })

  if (outcome.reason === 'full') {
    return reply(`❌ *${target.name}'s* beast roster is full (${BEAST_MAX_OWNED}/${BEAST_MAX_OWNED}) — release one first (${p}summon).`)
  }
  if (outcome.reason === 'owned') {
    return reply(`⚠️ *${target.name}* already owns *${def.name}* — rosters hold one of each beast.`)
  }

  const stats = getBeastStats(def, def.startingCp ?? 50)
  return reply(
    `✅ Granted ${def.emoji} *${def.name}* to *${target.name}*\.\n` +
    `Lv.${stats.level} · ${def.startingCp ?? 50} CP _(${p}summon to view, ${p}equipbeast ${def.id} to activate)._`,
  )
}

export default {
  name:        'givebeast',
  aliases:     ['givebeasts', 'givepet'],
  category:    'admin',
  requiresPlayer: false,
  description: 'Owner-only: grant a summoned beast to a player',

  async run(ctx) {
    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply(`❌ This command is restricted to the bot owner.`)
    }
    return giveBeast(ctx)
  },
}
