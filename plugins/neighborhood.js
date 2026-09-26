/**
 * neighborhood.js — the street, every claimed home ranked by comfort.
 *
 * Reads db.data.users directly rather than through getPlayer() because this is
 * the one housing command that is inherently a scan of everyone; going
 * one-by-one through the repo would be the same read with extra steps. It is
 * read-only — no updatePlayer() call anywhere in this file.
 *
 * Commands:
 *   .neighborhood        — the top homes, rendered
 *   .neighborhood text   — same list without the image
 */
import { config } from '../config.js'
import {
  hasHome, tierOf, comfortOf, plotCap, splitPlots,
} from '../lib/housing-engine.js'
import { renderNeighborhood } from '../lib/neighborhood-render.mjs'

const SHOWN = 12

/** Every registered player with a claimed home, best comfort first. */
function collectHouses(ctx) {
  const users = ctx.db?.data?.users ?? {}
  const houses = []

  for (const [jid, player] of Object.entries(users)) {
    if (!player || !hasHome(player)) continue
    const tier = tierOf(player)
    const { ready } = splitPlots(player)
    houses.push({
      jid,
      name: player.name ?? jid.replace(/@.*/, ''),
      tier: tier.id,
      tierName: tier.name,
      rank: tier.rank,
      comfort: comfortOf(player),
      rooms: player.home.rooms?.length ?? 0,
      decor: player.home.decor?.length ?? 0,
      plots: player.home.plots?.length ?? 0,
      plotCap: plotCap(player),
      ready: ready.length,
      isYou: jid === ctx.from,
    })
  }

  // Comfort first, then the bigger house, then rooms built — so a tie doesn't
  // shuffle between calls.
  houses.sort((a, b) =>
    b.comfort - a.comfort || b.rank - a.rank || b.rooms - a.rooms || a.name.localeCompare(b.name))
  return houses
}

function textView(ctx, houses) {
  const p = config.prefix
  if (!houses.length) {
    return (
      `🏘️ *THE NEIGHBOURHOOD*\n\n` +
      `_Nobody has claimed a home yet. Be first._\n\n` +
      `*${p}home claim* — free tent`
    )
  }

  const lines = [`🏘️ *THE NEIGHBOURHOOD*  _(${houses.length} home${houses.length === 1 ? '' : 's'})_`, '']
  houses.slice(0, SHOWN).forEach((h, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `*${i + 1}.*`
    lines.push(
      `${medal} *${h.name}*${h.isYou ? ' ← _you_' : ''}`,
      `   ${h.tierName}  ·  ✨ ${h.comfort}  ·  🚪 ${h.rooms}  ·  🖼️ ${h.decor}  ·  🌱 ${h.plots}/${h.plotCap}`,
    )
  })

  const mine = houses.findIndex(h => h.isYou)
  lines.push('')
  if (mine >= SHOWN) lines.push(`_You're #${mine + 1} on the street._`, '')
  else if (mine === -1) lines.push(`_You're not on the street yet — *${p}home claim*._`, '')

  lines.push(`*${p}homedecor* — raise your comfort`)
  lines.push(`*${p}homevisit @user* — look inside a home you're invited to`)
  return lines.join('\n')
}

export default {
  name: 'neighborhood',
  aliases: ['neighbourhood', 'street', 'homes'],
  category: 'housing',
  description: 'See every home in Astral Town ranked by comfort',
  subcommands: [
    { cmd: 'text', desc: 'the same street as plain text, no image' },
  ],
  requiresPlayer: true,

  async run(ctx) {
    const houses = collectHouses(ctx)
    const caption = textView(ctx, houses)

    const sub = (ctx.args[0] ?? '').toLowerCase()
    if (sub === 'text' || sub === 'list') return ctx.reply(caption)

    try {
      const buf = await renderNeighborhood({
        houses: houses.slice(0, SHOWN),
        viewer: ctx.player?.name ?? '',
        prefix: config.prefix,
      })
      return ctx.replyImage(buf, caption)
    } catch {
      // A render failure must never eat the data — the caption is the whole
      // list on its own.
      return ctx.reply(caption)
    }
  },
}
