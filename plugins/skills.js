/**
 * skills.js — .skills [page] · view every skill you've unlocked.
 *
 * Distinct from plugins/skill.js (`.skill <name>` — USE a skill mid-battle)
 * and plugins/skillslot.js (`.skillslot` — manage your 4 equipped slots).
 * This one is the full unlocked-skill codex: every skill ever granted by
 * level-up (player.skills), styled by rarity tier and sorted highest
 * impact -> lowest, paginated so a maxed-out character's ~100-skill list
 * stays readable.
 *
 * Usage:
 *   <prefix>skills             — page 1, sorted by impact
 *   <prefix>skills 2           — jump to page 2
 *   <prefix>skills page 3      — same, explicit form (matches .shop style)
 */
import { config } from '../config.js'
import { skills as allSkills, skillTierMap, skillTierOrder } from '../lib/game-data.js'
import { getEquippedSkills } from '../lib/skill-slots.js'

const PAGE_SIZE = 12

const skillMap = Object.fromEntries(allSkills.map((s) => [s.id, s]))

// Tier rank lookup for sorting — lower rank number = higher impact.
const tierRank = Object.fromEntries(skillTierOrder.map((id, i) => [id, i]))

/** Pulls a trailing "page N" or bare number off args, returns { page }. */
function extractPage(args) {
  const parts = [...args]
  let page = 1
  const pageIdx = parts.findIndex((a) => a?.toLowerCase() === 'page')
  if (pageIdx !== -1 && parts[pageIdx + 1] && /^\d+$/.test(parts[pageIdx + 1])) {
    page = parseInt(parts[pageIdx + 1], 10)
  } else if (parts[0] && /^\d+$/.test(parts[0])) {
    page = parseInt(parts[0], 10)
  }
  return page
}

function paginate(list, page) {
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
  const clamped = Math.min(Math.max(1, page), totalPages)
  const start = (clamped - 1) * PAGE_SIZE
  return { pageItems: list.slice(start, start + PAGE_SIZE), page: clamped, totalPages }
}

function pageFooter(page, totalPages) {
  if (totalPages <= 1) return ''
  const p = config.prefix
  const nav = []
  if (page > 1) nav.push(`*${p}skills page ${page - 1}* ◀️`)
  if (page < totalPages) nav.push(`▶️ *${p}skills page ${page + 1}*`)
  return `\n\n📄 _Page ${page}/${totalPages}_${nav.length ? '   ' + nav.join('   ') : ''}`
}

function tierEmoji(tierId) {
  return skillTierMap[tierId]?.emoji ?? '⚪'
}

function typeTag(s) {
  return s.type === 'active' ? `⚔️ Active _(${s.mpCost} MP)_` : '🧬 Passive'
}

// Short, effect-specific line so two skills of the same tier read
// differently instead of both just saying "ACTIVE". Reads the skill's own
// effects[0].multiplier — NOT the tier average shown in the group header —
// so the line reflects this exact skill's real power (skills within a tier
// still vary skill-to-skill, see data/skills.json).
const EFFECT_LABEL = {
  attack: (e) => `⚔️ ${Math.round(e.multiplier * 100)}% ${(e.stat ?? 'atk').toUpperCase()} dmg`,
  heal:   (e) => `💚 Heals ${Math.round(e.multiplier * 100)}% ${(e.stat ?? 'hp').toUpperCase()}`,
  shield: (e) => `🛡️ Shields ${Math.round(e.multiplier * 100)}% HP`,
  regen:  (e) => `💫 Regens ${Math.round(e.multiplier * 100)}% HP/turn`,
  strengthen: (e) => `📈 +${Math.round(e.multiplier * 100)}% ${(e.stat ?? 'stat').toUpperCase()}`,
}

function effectSummary(s) {
  const e = s.effects?.[0]
  if (!e) return ''
  const label = EFFECT_LABEL[e.type]
  return label ? label(e) : ''
}

function formatSkillLine(s, equippedSet) {
  const star = equippedSet.has(s.id) ? ' ⭐' : ''
  const effect = effectSummary(s)
  return `${tierEmoji(s.tier)} *${s.name}*${star}\n   _${s.tier.toUpperCase()}_ · ${typeTag(s)}${effect ? ` · ${effect}` : ''}`
}

export default {
  name: 'skills',
  aliases: ['myskills', 'skilllist', 'allskills'],
  category: 'account',
  requiresPlayer: true,
  description: `View every skill you've unlocked, sorted by impact (${config.prefix}skills [page])`,

  async run(ctx) {
    const { player, args, reply } = ctx
    const p = config.prefix

    const ownedIds = (player.skills ?? []).filter((id) => id !== undefined)
    const owned = ownedIds.map((id) => skillMap[id]).filter(Boolean)

    if (!owned.length) {
      return reply(
        `✨ *Skills*\n\nYou haven't unlocked any skills yet — keep leveling up!\n` +
        `Check *${p}profile* to see your progress.`,
      )
    }

    // Sort by impact (tier rarity, highest first), then alphabetically
    // within a tier so the list is stable/scannable.
    const sorted = [...owned].sort((a, b) => {
      const rankDiff = (tierRank[a.tier] ?? 99) - (tierRank[b.tier] ?? 99)
      if (rankDiff !== 0) return rankDiff
      return a.name.localeCompare(b.name)
    })

    const equippedSet = new Set(getEquippedSkills(player))
    const reqPage = extractPage(args ?? [])
    const { pageItems, page, totalPages } = paginate(sorted, reqPage)

    // Group this page's items by tier so rarity bands stay visually clear
    // even when a tier's skills straddle a page boundary.
    const groups = []
    for (const s of pageItems) {
      const last = groups[groups.length - 1]
      if (last && last.tier === s.tier) last.items.push(s)
      else groups.push({ tier: s.tier, items: [s] })
    }

    const body = groups
      .map((g) => {
        const meta = skillTierMap[g.tier]
        const header = `${tierEmoji(g.tier)} *${g.tier.toUpperCase()}* _(x${meta?.multiplier ?? '?'} impact)_`
        const lines = g.items.map((s) => formatSkillLine(s, equippedSet)).join('\n')
        return `${header}\n${lines}`
      })
      .join('\n\n')

    const header =
      `✨ *${player.name}'s Skills* _(${owned.length} unlocked)_\n` +
      `⭐ = currently equipped\n\n`

    const footer =
      pageFooter(page, totalPages) +
      `\n\n_Manage your battle loadout with *${p}skillslot* · Use one with *${p}skill <name>*_`

    return reply(header + body + footer)
  },
}
