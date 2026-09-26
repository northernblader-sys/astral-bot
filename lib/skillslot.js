/**
 * skillslot.js — view and manage your 4 equipped battle skills.
 *
 * player.skills is every active/passive skill ever unlocked (grows on
 * level-up, never shrinks). player.equippedSkills is the subset usable
 * in battle via .skill, capped at MAX_SKILL_SLOTS.
 *
 * Usage:
 *   <prefix>skillslot                — view equipped slots + unequipped pool
 *   <prefix>skillslot set <name>     — equip an owned skill into an open slot
 *   <prefix>skillslot clear <name>   — unequip a skill (stays in your pool)
 */
import { config } from '../config.js'
import { skills as allSkills } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { MAX_SKILL_SLOTS, getEquippedSkills, skillSlotsFullMessage } from '../lib/skill-slots.js'

const skillMap = Object.fromEntries(allSkills.map(s => [s.id, s]))

const TIER_EMOJI = {
  common:    '⬜',
  uncommon:  '🟩',
  rare:      '🟦',
  epic:      '🟪',
  legendary: '🟨',
}
function tierEmoji(t) { return TIER_EMOJI[t] ?? '⬜' }

const TIER_ORDER = ['legendary', 'epic', 'rare', 'uncommon', 'common']

function findSkillDef(query) {
  const q = (query ?? '').toLowerCase().trim().replace(/\s+/g, '_')
  if (!q) return null
  if (skillMap[q]) return skillMap[q]
  return allSkills.find(s => s.name.toLowerCase().replace(/\s+/g, '_') === q)
    ?? allSkills.find(s => s.name.toLowerCase().includes(query.toLowerCase().trim()))
    ?? null
}

function summarize(s) {
  const tag = s.type === 'active' ? `${s.mpCost} MP` : 'passive'
  return `${tierEmoji(s.tier)} *${s.name}* — _${tag}_`
}

function renderOwned(player) {
  const pr       = config.prefix
  const equipped = getEquippedSkills(player)
  const owned    = (player.skills ?? []).filter(id => id !== undefined)
  const unequippedActive = owned
    .filter(id => !equipped.includes(id))
    .map(id => skillMap[id])
    .filter(s => s && s.type === 'active')

  const lines = [
    `┏━━━━━━━━━━━━━━┓`,
    `┃  ✨ *SKILL LOADOUT* ✨`,
    `┗━━━━━━━━━━━━━━┛`,
    `_Equipped for battle (${equipped.length}/${MAX_SKILL_SLOTS} slots):_`,
    '',
  ]
  for (let i = 0; i < MAX_SKILL_SLOTS; i++) {
    const s = skillMap[equipped[i]]
    lines.push(s ? `  ${summarize(s)}` : `  ⬜ _— empty slot —_`)
  }

  if (unequippedActive.length) {
    lines.push('', `📦 *Unlocked, not equipped:*`)

    // Group by tier so a big pool doesn't read as one long list.
    const byTier = {}
    for (const s of unequippedActive) {
      if (!byTier[s.tier]) byTier[s.tier] = []
      byTier[s.tier].push(s)
    }
    for (const tier of TIER_ORDER) {
      const group = byTier[tier]
      if (!group?.length) continue
      lines.push(`   _${tier[0].toUpperCase()}${tier.slice(1)}_`)
      for (const s of group) lines.push(`     ${summarize(s)}`)
    }
  }

  lines.push('', `🔧 _Equip:_ *${pr}skillslot set <name>*   _Unequip:_ *${pr}skillslot clear <name>*`)
  return lines.join('\n')
}

export default {
  name: 'skillslot',
  aliases: ['skillslots', 'slots', 'skills'],
  category: 'account',
  requiresPlayer: true,
  description: `${config.prefix}skillslot — view/manage your 4 equipped battle skills`,

  async run(ctx) {
    const { player, args, db } = ctx
    const pr  = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    // ── set ─────────────────────────────────────────────────────────────
    if (sub === 'set' || sub === 'equip') {
      const query = args.slice(1).join(' ')
      if (!query) return ctx.reply(`Usage: *${pr}skillslot set <skill name>*`)
      const skill = findSkillDef(query)
      if (!skill) return ctx.reply(`❌ No skill found matching *"${query}"*.`)

      let outcome = null
      await updatePlayer(db, ctx.from, (p) => {
        const owned    = p.skills ?? []
        const equipped = getEquippedSkills(p)
        if (!owned.includes(skill.id))     { outcome = 'not_owned'; return }
        if (skill.type !== 'active')       { outcome = 'passive'; return }
        if (equipped.includes(skill.id))   { outcome = 'already'; return }
        if (equipped.length >= MAX_SKILL_SLOTS) { outcome = 'full'; return }
        equipped.push(skill.id)
        p.equippedSkills = equipped
        outcome = 'ok'
      })

      if (outcome === 'not_owned') return ctx.reply(`❌ You haven't unlocked *${skill.name}* yet.`)
      if (outcome === 'passive')   return ctx.reply(`⚠️ *${skill.name}* is passive — it applies automatically, no slot needed.`)
      if (outcome === 'already')   return ctx.reply(`⚠️ *${skill.name}* is already equipped.`)
      if (outcome === 'full')      return ctx.reply(skillSlotsFullMessage())
      return ctx.reply(`✅ *${skill.name}* equipped! Use it in battle with *${pr}skill ${skill.name}*.`)
    }

    // ── clear ───────────────────────────────────────────────────────────
    if (sub === 'clear' || sub === 'unequip') {
      const query = args.slice(1).join(' ')
      if (!query) return ctx.reply(`Usage: *${pr}skillslot clear <skill name>*`)
      const skill = findSkillDef(query)
      if (!skill) return ctx.reply(`❌ No skill found matching *"${query}"*.`)

      let outcome = null
      await updatePlayer(db, ctx.from, (p) => {
        const equipped = getEquippedSkills(p)
        if (!equipped.includes(skill.id)) { outcome = 'not_equipped'; return }
        p.equippedSkills = equipped.filter(id => id !== skill.id)
        outcome = 'ok'
      })

      if (outcome === 'not_equipped') return ctx.reply(`❌ *${skill.name}* isn't equipped.`)
      return ctx.reply(`✅ *${skill.name}* unequipped — it stays in your unlocked skills.`)
    }

    // ── default: view ──────────────────────────────────────────────────
    return ctx.reply(renderOwned(player))
  },
}
