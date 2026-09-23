/**
 * lib/command-list.js — every command a player can type, owner tools left out.
 *
 * The menu already lists sections. This is the flat list people ask for when
 * they say "all the commands". Owner gates stay out of it: the admin category,
 * the owner-only plugins that live outside that category, and owner subcommands
 * on otherwise public commands (event start, and the like).
 *
 * Copy is player-facing: no em or en dashes. Descriptions inherited from old
 * plugins are scrubbed at display time.
 */

export const OWNER_PLUGIN_NAMES = new Set(['cb', 'lockspin', 'unlockspin'])

export function cleanCopy(text) {
  return String(text ?? '').replace(/[—–]/g, ':')
}

export function isOwnerCommand(plugin) {
  if (!plugin) return true
  if (String(plugin.category ?? '').toLowerCase() === 'admin') return true
  if (OWNER_PLUGIN_NAMES.has(plugin.name)) return true
  const desc = String(plugin.description ?? '').trim()
  if (/^owner only\b/i.test(desc)) return true
  if (/^\(owner only\)/i.test(desc)) return true
  return false
}

export function isOwnerSubcommand(sc) {
  const desc = String(sc?.desc ?? '').trim()
  if (!desc) return false
  if (/^\(?owner\b/i.test(desc)) return true
  if (/\bowner only\b/i.test(desc)) return true
  return false
}

export function playerSubcommands(plugin) {
  return (plugin?.subcommands ?? []).filter(sc => !isOwnerSubcommand(sc))
}

function sectionOf(plugin, sections) {
  const cat = String(plugin.category ?? 'misc').toLowerCase()
  return sections.find(s => s.subs.some(sub => sub.cat === cat)) ?? sections[sections.length - 1]
}

/**
 * Build paginated player-command lines.
 * plugins: already platform-filtered.
 * sections: the menu's SECTIONS, so the grouping matches .menu.
 */
export function buildCommandPages(plugins, { prefix = '.', sections = [], page = 1, sectionQuery = '', pageChars = 2800 } = {}) {
  const visible = []
  const seen = new Set()
  for (const plugin of plugins) {
    if (!plugin?.name || seen.has(plugin.name)) continue
    seen.add(plugin.name)
    if (isOwnerCommand(plugin)) continue
    visible.push(plugin)
  }

  let pool = visible
  let title = 'EVERY COMMAND'
  if (sectionQuery) {
    const q = sectionQuery.toLowerCase()
    const section = sections.find(s =>
      s.key === q || s.label.toLowerCase() === q || s.subs.some(sub => sub.cat === q || sub.label.toLowerCase() === q)
    )
    if (!section) {
      return { error: 'section', total: visible.length, pages: [], page: 1, pageCount: 0 }
    }
    title = section.label.toUpperCase()
    pool = visible.filter(p => sectionOf(p, sections) === section)
  }

  const blocks = []
  const grouped = new Map()
  for (const plugin of pool) {
    const section = sectionOf(plugin, sections)
    if (!grouped.has(section.key)) grouped.set(section.key, { section, plugins: [] })
    grouped.get(section.key).plugins.push(plugin)
  }
  const order = sections.length
    ? sections.map(s => s.key).filter(k => grouped.has(k))
    : [...grouped.keys()]
  for (const key of order) {
    const group = grouped.get(key)
    const lines = [`*${group.section.emoji ?? ''} ${group.section.label}*`.trim()]
    const sorted = group.plugins.slice().sort((a, b) => a.name.localeCompare(b.name))
    for (const plugin of sorted) {
      const aliases = plugin.aliases?.length ? ` _(${plugin.aliases.join(', ')})_` : ''
      lines.push(`▹ *${prefix}${plugin.name}*${aliases}`)
      if (plugin.description) lines.push(`   ${cleanCopy(plugin.description)}`)
      for (const sc of playerSubcommands(plugin)) {
        lines.push(`   • *${prefix}${plugin.name} ${sc.cmd}*: ${cleanCopy(sc.desc)}`)
      }
    }
    blocks.push(lines.join('\n'))
  }

  const pages = []
  let cur = ''
  for (const block of blocks) {
    if (cur && cur.length + block.length + 2 > pageChars) {
      pages.push(cur)
      cur = block
    } else {
      cur = cur ? `${cur}\n\n${block}` : block
    }
  }
  if (cur) pages.push(cur)
  if (!pages.length) pages.push('_No commands in that section on this platform._')

  const pageCount = pages.length
  const clamped = Math.min(Math.max(1, page), pageCount)
  return {
    error: null,
    title,
    total: pool.length,
    hiddenOwners: visible.length ? (plugins.filter(p => p?.name && isOwnerCommand(p)).length) : 0,
    page: clamped,
    pageCount,
    text: pages[clamped - 1],
  }
}
