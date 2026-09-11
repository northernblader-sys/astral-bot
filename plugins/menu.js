/**
 * menu — category overview with drill-down, auto-built from the plugin
 * registry. No hardcoded command list.
 *   <prefix>menu                 → category overview
 *   <prefix>menu <category>      → full command list for that category
 * Aliases: help, commands — prefix is config.prefix, never hardcoded.
 *
 * SUBCOMMAND EXPANSION: a plugin can optionally export a `subcommands`
 * array on its default export — [{ cmd: 'give <n> @user', desc: 'gift a
 * card' }, ...] — and the category drill-down will list each one indented
 * under that plugin's entry, instead of just the single description line.
 * This is opt-in and additive: plugins without `subcommands` render exactly
 * as before (name + one description line). See plugins/card.js or
 * plugins/pokemon.js for the convention in practice.
 */
import { listPluginsFor } from '../lib/plugin-manager.js'
import { config } from '../config.js'
import { sendImage } from '../lib/image.js'

// Per-instance banner: the whole menu (overview AND every category
// drill-down) now shows ONE image depending on which of the bot's two
// numbers answered — no more per-category art. Mirrors instanceIdentity's
// sun/moon detection below so the picture always matches the name.
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

// Emoji, display label, and flavor blurb per category. Any category not
// listed here still works — it falls back to a plain bullet, its raw name,
// and no blurb. (Per-category banner images were removed — see bannerFor
// above, which now supplies the one image used everywhere.)
const CATEGORY_META = {
  combat:    { emoji: '⚔️', label: 'Combat',    blurb: 'Where blades meet, glory is forged. Fight monsters, test your skills, and grow stronger with every battle.' },
  account:   { emoji: '🧳', label: 'Adventurer', blurb: 'Your identity in the Sun World — view your profile, gear, and standing among fellow adventurers.' },
  economy:   { emoji: '💰', label: 'Economy',   blurb: 'Solars make the world go round. Pay, tip, bank, take loans, run giveaways, and track every transaction with AstralPay.' },
  social:    { emoji: '👥', label: 'Social',    blurb: 'No adventurer walks alone. Connect with the community and climb the ranks together.' },
  party:     { emoji: '🤝', label: 'Party',     blurb: 'Strength in numbers. Team up with allies to take on challenges too great for one.' },
  dungeon:   { emoji: '🗺️', label: 'Dungeon',   blurb: 'Deep beneath Astral, ancient rifts hide treasure and terror in equal measure.' },
  inventory: { emoji: '🎒', label: 'Inventory', blurb: 'Everything you carry, everything you\'ve earned. Manage your gear and supplies here.' },
  town:      { emoji: '🏘️', label: 'Town',      blurb: 'The heart of Astral Town — rest, restock, and prepare for your next journey.' },
  housing:   { emoji: '🏠', label: 'Housing',   blurb: 'A place of your own on the edge of town. Build rooms, furnish them, grow crops in real time, fish the quiet water, and have people over.' },
  pvp:       { emoji: '🥊', label: 'PvP',       blurb: 'Prove yourself against other adventurers, not just monsters.' },
  cards:     { emoji: '🎴', label: 'Cards',     blurb: 'Anime cards and Anime Series spawn across Astral — claim them, trade them, and build your collection.' },
  pokemon:   { emoji: '🐾', label: 'Pokémon',   blurb: 'Wild Pokémon roam Astral too — catch, raise, and battle them.' },
  utility:   { emoji: '🔧', label: 'Utility',   blurb: 'The tools that keep your journey running smoothly.' },
  admin:     { emoji: '🛠️', label: 'Sanctum',   blurb: 'Behind-the-scenes controls reserved for the Sun World\'s caretakers.' },
  empire:    { emoji: '🏰', label: 'Empire',    blurb: 'Found your own empire, raise it up, and rule it. Build, produce, recruit, and shop the Empire Premium Shop.' },
  battle:    { emoji: '🥋', label: 'Battle',    blurb: 'Take the fight to whatever stands in front of you.' },
  character: { emoji: '🎭', label: 'Character', blurb: 'Spin for and claim iconic characters to fight beside you.' },
  event:     { emoji: '🎉', label: 'Event',     blurb: 'Limited-time happenings across Astral — join in while they last.' },
  evolution: { emoji: '🧬', label: 'Evolution', blurb: 'Raise your Pokémon up through the stages they were born to reach.' },
  group:     { emoji: '📋', label: 'Group',     blurb: 'Group-facing tools for community and group-chat management.' },
  media:     { emoji: '🎬', label: 'Media',     blurb: 'Downloads, manga, and manhwa, pulled straight into chat.' },
  moderation:{ emoji: '🛡️', label: 'Moderation', blurb: 'Keep the room in order: welcomes, guards, and cleanup tools.' },
  season:    { emoji: '🌸', label: 'Season',    blurb: 'Seasonal content: passes, checkpoints, and limited spins.' },
  story:     { emoji: '📖', label: 'Story',     blurb: 'Follow the Sun World\'s unfolding narrative, chapter by chapter.' },
}

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
 * Group this platform's commands by category.
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

export default {
  name: 'menu',
  aliases: ['help', 'commands'],
  category: 'utility',
  cooldown: 5,
  description: 'Show command categories, or <prefix>menu <category> for details',

  async run(ctx) {
    const categories = buildCategories(listPluginsFor(ctx.platform))
    const pr         = prefixFor(ctx.platform)
    const query      = ctx.args?.join(' ').trim().toLowerCase()

    // ── Drill-down: <prefix>menu <category> ────────────────────────────────
    if (query) {
      const matchKey = Object.keys(categories).find(
        (c) => c === query || CATEGORY_META[c]?.label.toLowerCase() === query,
      )
      if (!matchKey) {
        return ctx.reply(
          `❌ No category *"${query}"* found.\n` +
          `Use *${pr}menu* to see all categories.`,
        )
      }

      const meta = CATEGORY_META[matchKey] ?? { emoji: '•', label: capitalize(matchKey), blurb: null }
      const lines = [`${meta.emoji} *${meta.label.toUpperCase()}*`]
      if (meta.blurb) lines.push(`_${meta.blurb}_`)
      lines.push('')

      for (const p of categories[matchKey].sort((a, b) => a.name.localeCompare(b.name))) {
        const aliases = p.aliases?.length ? ` _(${p.aliases.join(', ')})_` : ''
        lines.push(`▹ *${pr}${p.name}*${aliases}`)
        lines.push(`   ↳ ${p.description}`)

        // Plugins that expose a `subcommands` array (see plugin metadata
        // shape below) get their full subcommand list expanded here too,
        // instead of leaving the person to guess from the one-line
        // description alone. Plugins without one (simple, single-action
        // commands) just keep the plain description-only line as before —
        // this is additive, no existing plugin's menu entry changes shape
        // unless it opts in by adding `subcommands`.
        if (Array.isArray(p.subcommands) && p.subcommands.length) {
          for (const sc of p.subcommands) {
            lines.push(`      • *${pr}${p.name} ${sc.cmd}* — ${sc.desc}`)
          }
        }
      }
      lines.push(`\n_Back to categories: *${pr}menu*_`)
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
      `📂 *CATEGORIES* 📂`,
      `↴`,
    ]

    for (const cat of Object.keys(categories).sort()) {
      const meta = CATEGORY_META[cat] ?? { emoji: '•', label: capitalize(cat) }
      lines.push(`${meta.emoji} ▹ *${pr}menu ${meta.label}*`)
    }

    lines.push('↴')
    lines.push('')
    lines.push(`> 📚 ${pr}menu <category> — see commands in that category`)
    lines.push(`> 🧳 ${pr}me — view your profile`)
    lines.push(`> 🛟 ${pr}support — get help`)
    lines.push(`> 📨 ${pr}contactteam <msg> — message the dev team`)
    lines.push(`> 🌐 ${ctx.botName || config.botName} · Type *${pr}<command>* to use one directly.`)

    const overviewText = lines.join('\n')
    // Plain banner + text on every platform. (The tappable WhatsApp quick-action
    // buttons were removed by request; the categories above already cover it.)
    return sendImage(ctx, bannerFor(ctx.botName || config.botName), overviewText)
  },
}
