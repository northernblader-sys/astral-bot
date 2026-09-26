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
import { skills as allSkills, skillTierMap, skillTierOrder } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { MAX_SKILL_SLOTS, getEquippedSkills, skillSlotsFullMessage } from '../lib/skill-slots.js'

const skillMap = Object.fromEntries(allSkills.map(s => [s.id, s]))

// Roman numerals for rank suffixes. Class skill trees top out around 5
// tiers of the same name in practice (see data/skills.json), so this table
// covers every real case; higher counts fall back to a plain "#N" suffix
// rather than growing the table indefinitely.
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
function toRoman(n) {
  return ROMAN[n - 1] ?? `#${n}`
}

/**
 * Ascending id-suffix number: "warrior_ruin_breaker" -> 1,
 * "warrior_ruin_breaker_2" -> 2, etc. Used as the rank tiebreaker (and as
 * the sole sort key when two same-named variants share a tier — see
 * Executioner's Mark in data/skills.json, which has two entries both at
 * "epic").
 */
function idSuffixNumber(id) {
  const m = /_(\d+)$/.exec(id ?? '')
  return m ? Number(m[1]) : 1
}

/**
 * rankSkillsByName(skillList) -> Map<id, string>
 *
 * Groups the given skills by `name`. Names owned only once map to their
 * plain name unchanged (no visual noise on the common case). Names owned
 * in 2+ variants get a " I"/" II"/... suffix, ordered from lowest to
 * highest power: primarily by skillTierOrder (ascending impact), then by
 * ascending id-suffix number as a tiebreak for same-tier duplicates.
 *
 * Takes a list of skill objects (not ids) so it can be reused for both the
 * owned-skills pool and the equipped-slots list.
 */
function rankSkillsByName(skillList) {
  const byName = new Map()
  for (const s of skillList) {
    if (!byName.has(s.name)) byName.set(s.name, [])
    byName.get(s.name).push(s)
  }

  const displayName = new Map() // id -> display string
  for (const [name, group] of byName) {
    if (group.length === 1) {
      displayName.set(group[0].id, name)
      continue
    }
    const sorted = [...group].sort((a, b) => {
      const tierDiff = skillTierOrder.indexOf(a.tier) - skillTierOrder.indexOf(b.tier)
      if (tierDiff !== 0) return tierDiff
      return idSuffixNumber(a.id) - idSuffixNumber(b.id)
    })
    // skillTierOrder is highest-impact-first, so reverse for "I = weakest"
    sorted.reverse()
    sorted.forEach((s, i) => displayName.set(s.id, `${name} ${toRoman(i + 1)}`))
  }
  return displayName
}

function findSkillDef(query) {
  const q = (query ?? '').toLowerCase().trim().replace(/\s+/g, '_')
  if (!q) return null
  if (skillMap[q]) return skillMap[q]
  return allSkills.find(s => s.name.toLowerCase().replace(/\s+/g, '_') === q)
    ?? allSkills.find(s => s.name.toLowerCase().includes(query.toLowerCase().trim()))
    ?? null
}

/**
 * Resolve a skill against a player's own ranked-name map first (so
 * "Reality Break II" unambiguously matches the exact tier shown in their
 * .skillslot list). If the bare, unranked name (e.g. "Reality Break")
 * matches 2+ owned variants, that's still ambiguous — return the special
 * 'ambiguous' marker with the candidate list instead of silently picking
 * one, so the caller can ask the player to specify a rank. Only falls back
 * to the global name/id lookup once the player's own owned skills contain
 * no match at all.
 */
function findSkillForPlayer(query, rankedNames) {
  const qNorm = (query ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
  if (!qNorm) return null

  for (const [id, display] of rankedNames) {
    if (display.toLowerCase() === qNorm) return skillMap[id]
  }

  // Bare-name match against every owned variant's underlying (unranked) name.
  const bareMatches = [...rankedNames.entries()]
    .filter(([id]) => skillMap[id]?.name.toLowerCase() === qNorm)
  if (bareMatches.length > 1) {
    return { ambiguous: true, options: bareMatches.map(([, display]) => display) }
  }
  if (bareMatches.length === 1) return skillMap[bareMatches[0][0]]

  return findSkillDef(query)
}

// Resolve a skill by 1-based position within a given ordered list of skill
// ids (either the player's owned-skills list for "set", or the equipped
// slots for "clear"). Falls back to name lookup if not a plain number.
function findSkillByNumber(query, orderedIds) {
  const n = Number((query ?? '').trim())
  if (!Number.isInteger(n) || n < 1 || n > orderedIds.length) return null
  const id = orderedIds[n - 1]
  return id ? skillMap[id] : null
}

function tierEmoji(tierId) {
  return skillTierMap[tierId]?.emoji ?? '⚪'
}

/**
 * Orders a list of skill objects the same way the unlocked-pool section of
 * .skillslot displays them: tier groups from highest impact to lowest
 * (skillTierOrder is already highest-impact-first — see game-data.js),
 * alphabetical by display name within each tier, empty tiers simply
 * contributing nothing. This is the single source of truth for pool order —
 * renderOwned() prints in this order and findSkillByNumber() (for
 * ".skillslot set <#>") indexes into this same order, so the number shown
 * on screen always resolves to the skill actually at that position.
 */
function orderPoolByTier(skillList, rankedNames) {
  const ordered = []
  for (const tierId of skillTierOrder) {
    const group = skillList
      .filter(s => s.tier === tierId)
      .sort((a, b) => (rankedNames.get(a.id) ?? a.name).localeCompare(rankedNames.get(b.id) ?? b.name))
    ordered.push(...group)
  }
  return ordered
}

// Equipped-slot line: emoji *Name* `MP` — no tier label here since the
// equipped section isn't tier-grouped (only the unequipped pool is).
function summarizeEquipped(s, rankedNames) {
  const name = rankedNames?.get(s.id) ?? s.name
  const tag  = s.type === 'active' ? `\`${s.mpCost} MP\`` : '`passive`'
  return `${tierEmoji(s.tier)} *${name}* ${tag}`
}

// Pool line: plain sequential number (backticked separately by caller,
// since numbering must stay global across tier groups, not per-tier) +
// bold name + backticked MP cost. Tier emoji is not repeated per-line
// here — the tier group header above already carries it.
function summarizePoolEntry(s, rankedNames) {
  const name = rankedNames?.get(s.id) ?? s.name
  return `*${name}* \`${s.mpCost} MP\``
}

function renderOwned(player) {
  const pr       = config.prefix
  const equipped = getEquippedSkills(player)
  const owned    = (player.skills ?? []).filter(id => id !== undefined)
  const ownedSkillObjs = owned.map(id => skillMap[id]).filter(Boolean)
  const unequippedActive = owned
    .filter(id => !equipped.includes(id))
    .map(id => skillMap[id])
    .filter(s => s && s.type === 'active')

  // Rank across every owned skill (equipped + unequipped) so an equipped
  // slot and an unequipped entry sharing a name still get consistent,
  // distinguishable ranks between the two sections of the message.
  const rankedNames = rankSkillsByName(ownedSkillObjs)

  const lines = ['『 ✦ Skill Slots ✦ 』', '']

  // ── equipped ──────────────────────────────────────────────────────────
  lines.push(`✦ ── [ equipped: \`${equipped.length}/${MAX_SKILL_SLOTS}\` ] ── ✦`)
  for (let i = 0; i < MAX_SKILL_SLOTS; i++) {
    const s = skillMap[equipped[i]]
    lines.push(s ? `▹ ${i + 1}. ${summarizeEquipped(s, rankedNames)}` : `▹ ${i + 1}. ☆☆☆☆☆ _— empty slot —_`)
  }

  // ── unlocked pool, grouped by tier (highest impact first) ──────────────
  if (unequippedActive.length) {
    lines.push('', `✦ ── [ unlocked pool: \`${unequippedActive.length}\` ] ── ✦`)

    // Global sequential numbering across the whole pool, assigned in the
    // same order orderPoolByTier() produces, so the displayed number always
    // matches the position .skillslot set <#> resolves against.
    const pooled = orderPoolByTier(unequippedActive, rankedNames)
    const numberOf = new Map(pooled.map((s, i) => [s.id, i + 1]))

    for (const tierId of skillTierOrder) {
      const group = pooled.filter(s => s.tier === tierId)
      if (!group.length) continue // skip empty tier groups

      const entries = group.map(s => `${numberOf.get(s.id)}. ${summarizePoolEntry(s, rankedNames)}`).join(' ▹ ')
      lines.push(`${tierEmoji(tierId)} ${tierId[0].toUpperCase()}${tierId.slice(1)} ▹ ${entries}`)
    }
  }

  lines.push(
    '',
    `↳ Equip: \`${pr}skillslot set <name or #>\``,
    `↳ Unequip: \`${pr}skillslot clear <name or #>\``,
    `↳ See every skill you've unlocked with \`${pr}skills\``,
  )
  return lines.join('\n')
}

export default {
  name: 'skillslot',
  aliases: ['skillslots', 'slots'],
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
      if (!query) return ctx.reply(`Usage: *${pr}skillslot set <skill name or #>*`)

      const owned = (player.skills ?? []).filter(id => id !== undefined)
      const equippedNow = getEquippedSkills(player)
      const unequippedActive = owned
        .filter(id => !equippedNow.includes(id))
        .map(id => skillMap[id])
        .filter(s => s && s.type === 'active')

      const ownedSkillObjs = owned.map(id => skillMap[id]).filter(Boolean)
      const rankedNames = rankSkillsByName(ownedSkillObjs)

      // #-lookups must resolve against the exact same tier-grouped,
      // alphabetical-within-tier order the pool is rendered in — not raw
      // player.skills insertion order — or "#N" in .skillslot set <#> would
      // equip a different skill than the one shown at position N.
      const unequippedIds = orderPoolByTier(unequippedActive, rankedNames).map(s => s.id)

      const skill = findSkillByNumber(query, unequippedIds) ?? findSkillForPlayer(query, rankedNames)
      if (!skill) return ctx.reply(`❌ No skill found matching *"${query}"*.`)
      if (skill.ambiguous) {
        return ctx.reply(
          `❓ You have multiple versions of *"${query}"*. Specify which one:\n` +
          skill.options.map(o => `   • *${o}*`).join('\n'),
        )
      }

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
      if (!query) return ctx.reply(`Usage: *${pr}skillslot clear <skill name or #>*`)

      const equippedIds = getEquippedSkills(player)
      const owned = (player.skills ?? []).filter(id => id !== undefined)
      const ownedSkillObjs = owned.map(id => skillMap[id]).filter(Boolean)
      const rankedNames = rankSkillsByName(ownedSkillObjs)

      const skill = findSkillByNumber(query, equippedIds) ?? findSkillForPlayer(query, rankedNames)
      if (!skill) return ctx.reply(`❌ No skill found matching *"${query}"*.`)
      if (skill.ambiguous) {
        return ctx.reply(
          `❓ You have multiple versions of *"${query}"*. Specify which one:\n` +
          skill.options.map(o => `   • *${o}*`).join('\n'),
        )
      }

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
