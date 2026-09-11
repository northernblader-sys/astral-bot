/**
 * id.js — Player ID card.
 *
 * Commands:
 *   .id                          — show your Astral ID card (image)
 *   .id @player                  — view another player's public ID card
 *   .id image set <url>          — set your ID photo by URL
 *   .id color <hex>              — change accent color (title, swoosh, text)
 *   .id color border <hex>       — change card border + photo frame color
 *   .id color reset              — reset colors to default black
 *
 * Color is stored in player.idColors: { accent, border }
 * Photo: player.idImage → player.pfp → silhouette placeholder.
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { getRankForLevel } from '../lib/rank-engine.js'
import { renderPlayerIdCard } from '../lib/player-id-render.mjs'
import { extractTarget } from '../lib/group-helpers.js'

/** Pull a URL from text args. */
function urlFromArgs(args) {
  for (const a of args) {
    if (a.startsWith('http://') || a.startsWith('https://')) return a
  }
  return null
}

/** Try to pull a URL from a quoted message's text body or image caption. */
function urlFromQuote(msg) {
  const qCtx = msg?.message?.extendedTextMessage?.contextInfo
  if (!qCtx) return null
  const qm = qCtx.quotedMessage
  if (!qm) return null
  const body =
    qm.conversation ||
    qm.extendedTextMessage?.text ||
    qm.imageMessage?.caption ||
    ''
  const match = body.match(/https?:\/\/\S+/)
  return match ? match[0] : null
}

/** Basic hex color validation — must be #RGB or #RRGGBB. */
function isValidHex(str) {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(str)
}

/** Normalize short #RGB to #RRGGBB. */
function normalizeHex(hex) {
  if (hex.length === 4) {
    return '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
  }
  return hex.toUpperCase()
}

export default {
  name: 'id',
  aliases: ['playerid', 'pid'],
  category: 'account',
  requiresPlayer: true,
  description: 'Show your Astral ID card — .id color / .id color border to customize',

  async run(ctx) {
    const { args, reply, player, db, msg } = ctx
    const pr  = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    // ── .id image set <url> ────────────────────────────────────────────────
    if (sub === 'image' && args[1]?.toLowerCase() === 'set') {
      const url = urlFromArgs(args.slice(2)) ?? urlFromQuote(msg)
      if (!url) {
        return reply(
          `📸 *Set ID Photo*\n\n` +
          `*${pr}id image set <url>*\n\n` +
          `Upload your image to imgbb.com and paste the direct link.\n` +
          `_Or reply to a message that contains an image URL._`,
        )
      }
      await updatePlayer(db, ctx.from, async p => { p.idImage = url; return p })
      return reply(`✅ *ID photo updated!* Type *${pr}id* to see your card.`)
    }

    // ── .id color … ───────────────────────────────────────────────────────
    if (sub === 'color' || sub === 'colour') {
      const target2 = args[1]?.toLowerCase() ?? ''

      // .id color reset
      if (target2 === 'reset') {
        await updatePlayer(db, ctx.from, async p => { p.idColors = {}; return p })
        return reply(`🔄 ID colors reset to default.`)
      }

      // .id color border <hex>
      if (target2 === 'border') {
        const hex = args[2]?.startsWith('#') ? args[2] : (args[2] ? '#' + args[2] : null)
        if (!hex || !isValidHex(hex)) {
          const cur = player.idColors?.border ?? '#111111'
          return reply(
            `🖊️ *ID Border Color*\n\n` +
            `Current: *${cur}*\n\n` +
            `*${pr}id color border <#hex>*\n` +
            `Example: *${pr}id color border #CC0000*`,
          )
        }
        const clean = normalizeHex(hex)
        await updatePlayer(db, ctx.from, async p => {
          p.idColors = { ...(p.idColors ?? {}), border: clean }
          return p
        })
        return reply(`✅ ID border color set to *${clean}*`)
      }

      // .id color <hex>  → accent color
      const hex = target2.startsWith('#') ? target2 : (target2 ? '#' + target2 : null)
      if (!hex || !isValidHex(hex)) {
        const curAcc = player.idColors?.accent ?? '#111111'
        const curBrd = player.idColors?.border ?? '#111111'
        return reply(
          `🎨 *ID Card Colors*\n\n` +
          `Accent (title/text): *${curAcc}*\n` +
          `Border: *${curBrd}*\n\n` +
          `*${pr}id color <#hex>* — set accent color\n` +
          `*${pr}id color border <#hex>* — set border color\n` +
          `*${pr}id color reset* — reset to default black`,
        )
      }
      const clean = normalizeHex(hex)
      await updatePlayer(db, ctx.from, async p => {
        p.idColors = { ...(p.idColors ?? {}), accent: clean }
        return p
      })
      return reply(`✅ ID accent color set to *${clean}*`)
    }

    // ── .id @player ── view someone else ──────────────────────────────────
    const mentionedId = extractTarget(ctx)
    const targetId    = (mentionedId && mentionedId !== ctx.from) ? mentionedId : ctx.from
    const target      = getPlayer(db, targetId)
    if (!target) return reply(`❌ That player isn't registered yet.`)

    const rank = getRankForLevel(target.level)

    try {
      const buf = await renderPlayerIdCard(target, rank)
      const caption =
        `🪪 *${target.name}'s Astral ID*\n` +
        `${rank.emoji} ${rank.title}  •  Level ${target.level}\n` +
        (target.username ? `🏷️ @${target.username}` : `_No username set — use ${pr}username add_`)
      return ctx.replyImage(buf, caption)
    } catch (err) {
      return reply(
        `🪪 *${target.name}'s Astral ID*\n\n` +
        `🏷️ Username: ${target.username ? `@${target.username}` : '—'}\n` +
        `🐾 Pokémon: ${(target.pokemon ?? []).length}\n` +
        `🏅 Level: ${target.level}\n` +
        `${rank.emoji} Rank: ${rank.title}\n` +
        `⚔️ Battles Won: ${target.battleRecord?.wins ?? 0}`,
      )
    }
  },
}
