/**
 * menu — the ten-section command map, auto-built from the plugin registry.
 * No hardcoded command list.
 *   <prefix>menu                 → the ten sections
 *   <prefix>menu <section>      → every command in that section
 * Aliases: help, commands — prefix is config.prefix, never hardcoded.
 *
 * ── Why ten and not twenty-four (2026-09-21 rework) ─────────────────────────
 * The overview used to list one line per plugin CATEGORY: 24 of them, with
 * thin ones like "Season Packs" (1 command) sitting beside "Combat" (40).
 * That is not how the game is played: nobody hunts for "Progression", they
 * hunt for their character, their fights, their season. So the overview is
 * now exactly TEN sections, and the old categories survive as SUB-SECTIONS
 * inside the drill-downs, which is where the answer to "why is Season Packs
 * separate from Season?" lives: it isn't anymore. `.menu Season` shows the
 * Season commands, the Season Packs commands, and the Events commands, under
 * their own little headers. `.menu season packs` still finds it too, because
 * every folded name still matches.
 *
 * SUBCOMMAND EXPANSION: a plugin can optionally export a `subcommands`
 * array on its default export — [{ cmd: 'give <n> @user', desc: 'gift a
 * card' }, ...] — and the drill-down lists each one indented under that
 * plugin's entry. Opt-in and additive: plugins without `subcommands` render
 * name + one description line. See plugins/card.js for the convention.
 */
import { listPluginsFor } from '../lib/plugin-manager.js'
import { config } from '../config.js'
import { sendImage } from '../lib/image.js'

// Per-instance banner: the whole menu (overview AND every section
// drill-down) shows ONE image depending on which of the bot's two numbers
// answered. Mirrors instanceIdentity's sun/moon detection below.
const SUN_BANNER  = 'https://i.ibb.co/hFkjx64z/Sun-2026-09-01-01-59-04-908052.webp'
const MOON_BANNER = 'https://i.ibb.co/DH9RDjBC/moonn.webp'
// Fallback if botName is ever neither (shouldn't happen with the two
// configured numbers, but keeps sendImage from getting a bad url).
const MENU_BANNER = SUN_BANNER

function bannerFor(botName) {
  const n = (botName ?? '').toLowerCase()
  if (n.includes('moon')) return MOON_BANNER
  if (n.includes('sun'))  return SUN_BANNER
  return MENU_BANNER
}

/**
 * The ten sections, in overview order. Each carries the sub-sections it
 * absorbed: `cat` is the plugin's raw `category` value (the registry keeps
 * tagging exactly as before, this is purely presentation), `label` is the
 * header the drill-down groups under. A plugin whose category matches no
 * sub anywhere falls into Utility's Misc sub, so a future category can
 * never orphan itself out of the menu.
 */
export const SECTIONS = [
  {
    key: 'adventurer', emoji: '🧳', label: 'Adventurer',
    blurb: 'Your identity in the Sun World: profile, quests, and the people you share it with.',
    subs: [
      { cat: 'account',     label: 'Adventurer' },
      { cat: 'progression', label: 'Progression' },
      { cat: 'social',      label: 'Social' },
    ],
  },
  {
    key: 'character', emoji: '🎭', label: 'Character',
    blurb: 'Spin for and claim iconic characters and anime cards to fight beside you.',
    subs: [
      { cat: 'character', label: 'Character' },
      { cat: 'cards',     label: 'Cards' },
    ],
  },
  {
    key: 'pokemon', emoji: '🐾', label: 'Pokémon',
    blurb: 'Wild Pokémon roam Astral too: catch them, raise them, evolve them, battle them.',
    subs: [
      { cat: 'pokemon',   label: 'Pokémon' },
      { cat: 'evolution', label: 'Evolution' },
    ],
  },
  {
    key: 'combat', emoji: '⚔️', label: 'Combat',
    blurb: 'Where blades meet, glory is forged. Every way to fight: monsters, bosses, party runs, and duels.',
    subs: [
      { cat: 'combat', label: 'Combat' },
      { cat: 'battle', label: 'Battle' },
      { cat: 'party',  label: 'Party' },
      { cat: 'pvp',    label: 'PvP' },
    ],
  },
  {
    key: 'dungeon', emoji: '🗺️', label: 'Dungeon',
    blurb: 'Deep beneath Astral, ancient rifts hide treasure and terror in equal measure. The story unfolds on the way down.',
    subs: [
      { cat: 'dungeon', label: 'Dungeon' },
      { cat: 'story',   label: 'Story' },
    ],
  },
  {
    key: 'economy', emoji: '💰', label: 'Economy',
    blurb: 'Solars make the world go round: pay, tip, bank, trade, and carry everything you earn.',
    subs: [
      { cat: 'economy',   label: 'Economy' },
      { cat: 'inventory', label: 'Inventory' },
      { cat: 'town',      label: 'Town' },
    ],
  },
  {
    key: 'empire', emoji: '🏰', label: 'Empire',
    blurb: 'Found your own empire, raise it up, and rule it. Build rooms, furnish them, and make a home of it.',
    subs: [
      { cat: 'empire',  label: 'Empire' },
      { cat: 'housing', label: 'Housing' },
    ],
  },
  {
    key: 'season', emoji: '🌸', label: 'Season',
    blurb: 'All things seasonal in one place: passes, checkpoints, packs, limited spins, and the events that come with them.',
    subs: [
      { cat: 'season', label: 'Season' },
      { cat: 'packs',  label: 'Season Packs' },
      { cat: 'event',  label: 'Events' },
    ],
  },
  {
    key: 'sanctum', emoji: '🛠️', label: 'Sanctum',
    blurb: 'The caretaker layer: group tools, moderation, and the controls kept behind the scenes.',
    subs: [
      { cat: 'group',      label: 'Group' },
      { cat: 'moderation', label: 'Moderation' },
      { cat: 'admin',      label: 'Sanctum' },
    ],
  },
  {
    key: 'utility', emoji: '🔧', label: 'Utility',
    blurb: 'The tools that keep your journey running: downloads, media, and everything else under the sun.',
    subs: [
      { cat: 'utility',  label: 'Utility' },
      { cat: 'media',    label: 'Media' },
      { cat: 'download', label: 'Download' },
      { cat: 'misc',     label: 'Misc' },
    ],
  },
]

/** raw category key -> owning section (built from SECTIONS, plus the misc fallback). */
const SECTION_BY_CAT = new Map()
for (const section of SECTIONS) {
  for (const sub of section.subs) SECTION_BY_CAT.set(sub.cat, section)
}
const FALLBACK_SECTION = SECTIONS[SECTIONS.length - 1] // Utility (its Misc sub hosts strays)

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * Which of the bot's two WhatsApp numbers this message came in on, read off
 * ctx.botName (see handler.js's makeHandler / config.js's botName / botName2).
 * Mirrors handler.js's autoReactEmojiFor so the menu banner and the message
 * reaction always agree on sun vs moon for the same number.
 */
function instanceIdentity(botName) {
  const n = (botName ?? '').toLowerCase()
  if (n.includes('moon')) return { emoji: '🌙', name: 'Moon' }
  if (n.includes('sun'))  return { emoji: '☀️', name: 'Sun' }
  return { emoji: '🪽', name: botName || 'Astral' }
}

/**
 * The prefix a player on this platform actually types. Telegram's UI
 * autocompletes `/`, so a menu full of `.` there teaches the wrong thing —
 * same reasoning as plugins/connect.js's prefixFor().
 */
function prefixFor(platform) {
  return platform === 'telegram' ? config.telegramPrefix : config.prefix
}

/**
 * Group this platform's plugins by raw category.
 *
 * Takes the platform-filtered list, NOT the raw registry: in combined mode all
 * three platforms share one registry, so reading it directly is what put
 * WhatsApp-only entries (.mute, .setgoodbye, .antilink) and Telegram-only ones
 * (.quiz) into Discord's menu. See lib/plugin-manager.js's isPluginAvailableOn.
 */
function buildCategories(plugins) {
  const seen = new Set()
  const categories = {}
  for (const plugin of plugins) {
    if (seen.has(plugin.name)) continue
    seen.add(plugin.name)
    const cat = (plugin.category ?? 'misc').toLowerCase()
    if (!categories[cat]) categories[cat] = []
    categories[cat].push(plugin)
  }
  return categories
}

/** Resolve a user's `.menu <query>` to a section: key, section label, or any folded sub name/label. */
function matchSection(query) {
  const q = query.trim().toLowerCase()
  return SECTIONS.find((s) => {
    if (s.key === q || s.label.toLowerCase() === q) return true
    return s.subs.some((sub) => sub.cat === q || sub.label.toLowerCase() === q)
  }) ?? null
}

/** One plugin's menu entry: the command line, the description, then any subcommands. */
function pluginLines(pr, p) {
  const lines = []
  const aliases = p.aliases?.length ? ` _(${p.aliases.join(', ')})_` : ''
  lines.push(`▹ *${pr}${p.name}*${aliases}`)
  lines.push(`   ↳ ${p.description}`)

  // Plugins that expose a `subcommands` array get their full subcommand list
  // expanded here too, instead of leaving the person to guess from the
  // one-line description alone. (The separator is a colon on purpose: this
  // is player-facing copy and the house rule is no em or en dashes.)
  if (Array.isArray(p.subcommands) && p.subcommands.length) {
    for (const sc of p.subcommands) {
      lines.push(`      • *${pr}${p.name} ${sc.cmd}*: ${sc.desc}`)
    }
  }
  return lines
}

export default {
  name: 'menu',
  aliases: ['help', 'commands'],
  category: 'utility',
  cooldown: 5,
  description: 'Show the ten command sections, or <prefix>menu <section> for its commands',

  async run(ctx) {
    const categories = buildCategories(listPluginsFor(ctx.platform))
    const pr         = prefixFor(ctx.platform)
    const query      = ctx.args?.join(' ').trim().toLowerCase()

    // ── Drill-down: <prefix>menu <section> ─────────────────────────────────
    if (query) {
      const section = matchSection(query)
      if (!section) {
        return ctx.reply(
          `❌ No section *"${query}"* found.\n` +
          `Use *${pr}menu* to see all ten.`,
        )
      }

      const lines = [`${section.emoji} *${section.label.toUpperCase()}*`]
      if (section.blurb) lines.push(`_${section.blurb}_`)
      lines.push('')

      // Sub-sections in declared order. On the Utility fallback section, any
      // category key no sub anywhere claimed (a future plugin inventing a new
      // category) is folded into the Misc sub's list, so it shows in ONE place
      // instead of getting its own duplicate header.
      const groups = []
      for (const sub of section.subs) {
        groups.push({ label: sub.label, plugins: [...(categories[sub.cat] ?? [])] })
      }
      if (section === FALLBACK_SECTION) {
        const claimed = new Set(section.subs.map((s) => s.cat))
        const miscGroup = groups[groups.length - 1]
        for (const cat of Object.keys(categories).sort()) {
          if (claimed.has(cat) || SECTION_BY_CAT.has(cat)) continue
          miscGroup.plugins.push(...categories[cat])
        }
      }

      let shown = 0
      for (const group of groups) {
        const plugins = group.plugins.sort((a, b) => a.name.localeCompare(b.name))
        if (!plugins.length) continue
        lines.push(`── ${group.label} ──`)
        for (const p of plugins) {
          lines.push(...pluginLines(pr, p))
          shown++
        }
        lines.push('')
      }

      if (!shown) lines.push(`_No ${section.label} commands are available on this platform._\n`)
      lines.push(`\n_Back to sections: *${pr}menu*_`)
      return sendImage(ctx, bannerFor(ctx.botName || config.botName), lines.join('\n'))
    }

    // ── Overview: <prefix>menu ──────────────────────────────────────────────
    const displayName = ctx.player?.name ?? 'traveler'
    const identity = instanceIdentity(ctx.botName || config.botName)

    const lines = [
      `─────── ${identity.emoji} *ASTRAL* ${identity.emoji} ───────`,
      `Welcome *${displayName}*. You have entered the *Sun World* of Astral.`,
      `My name is *${identity.name}*, ask me anything. I know everything tehe :)`,
      ``,
      `✦ ── [ 💫 about me! ] ── ✦`,
      `👑 Owner ⌁ *Yato*`,
      `🛠️ Made by ⌁ *team-Flow*`,
      `⌨️ Command prefix ⌁ ${pr}`,
      ``,
      `📂 *SECTIONS* 📂`,
      `↴`,
    ]

    // Exactly the ten sections. A section with nothing on THIS platform is
    // hidden rather than advertised empty (the old per-category behavior).
    for (const section of SECTIONS) {
      const hasAny = section.subs.some((sub) => (categories[sub.cat] ?? []).length > 0)
      if (!hasAny) continue
      lines.push(`${section.emoji} ▹ *${pr}menu ${section.label}*`)
    }

    lines.push('↴')
    lines.push('')
    lines.push(`> 📚 ${pr}menu <section>: every command in that section`)
    lines.push(`> 🧳 ${pr}me — view your profile`)
    lines.push(`> 🛟 ${pr}support — get help`)
    lines.push(`> 📨 ${pr}contactteam <msg> — message the dev team`)
    lines.push(`> 🌐 ${ctx.botName || config.botName} · Type *${pr}<command>* to use one directly.`)

    const overviewText = lines.join('\n')
    // Plain banner + text on every platform. (The tappable WhatsApp quick-action
    // buttons were removed by request; the sections above already cover it.)
    return sendImage(ctx, bannerFor(ctx.botName || config.botName), overviewText)
  },
}
