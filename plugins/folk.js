/**
 * plugins/folk.js — the people who live in an empire, by name.
 *
 * Phase 9 of the Empire pillar. Before this, an empire's residents were a single
 * number (record.npcs) that only mattered as fame and wages. This turns a
 * bounded slice of that number into actual townsfolk: a name, a trade, one
 * weapon and one armor design rolled from that trade's own pools, so no two
 * residents look or fight alike. Wander in and you can see who lives here.
 *
 * Favor is the relationship. It rises on its own while they live under your
 * banner, faster when the ruler greets them or buys a round at the coffee house
 * (see plugins/coffee.js). Fill it and that resident hands over their trade's
 * heirloom armor: one of the ten in data/empire-heirlooms.json, each with its own
 * combat passive wired in lib/named-passives.js. Once per resident, ever.
 *
 * Everything here reads through previewFolk (which mutates nothing), so looking
 * at your people is a pure read. Only greet and gift write, and each is ONE
 * updatePlayer mutator with the empire record touched inside it, the same shape
 * the coffee house uses. Never broadcasts: replies land in the chat that asked.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getGroupSettings } from '../lib/group-settings.js'
import { ensureEmpiresInitialized } from '../lib/empire-repo.js'
import { allItems } from '../lib/game-data.js'
import { rarityStars } from '../lib/rarity.js'
import { progressBar } from '../lib/combat-engine.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import {
  previewFolk, findFolkMember, greetFolkMember, claimFolkGift,
  folkCap, folkGiftFavor, folkTradeMap, FOLK_CONFIG, fmtDuration,
} from '../lib/empire-engine.js'
import { standingIn } from './goto.js'

const RULE = '━━━━━━━━━━━━━━━━━━━━'
const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))

async function gate(ctx) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) {
      await ctx.reply(
        `🚫 The Empire system is disabled in this group.\n` +
        `_A group admin can enable it with *${p}empire on*._`
      )
      return false
    }
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  return true
}

/** "🌾 Alda Ashvale" — trade emoji plus name, the way every line labels a resident. */
function label(f) {
  return `${folkTradeMap[f.trade]?.emoji ?? '👤'} *${f.name}*`
}

/** The roster: everyone living here, with how warm they are to the ruler. */
function renderRoster(record, folk, rel, p) {
  const lines = [`🏘️ *The Folk of ${record.name}*`, RULE]
  if (!folk.length) {
    lines.push(`_Nobody has settled here by name yet._`)
    lines.push('')
    lines.push(
      rel === 'owner'
        ? `_Residents move in when your housing has room for them. Raise houses, run *${p}empire collect*, and they will start arriving with names._`
        : `_This place is still too quiet for anyone to have made a name here._`
    )
    return lines.join('\n')
  }
  const ready = folk.filter(f => f.ready)
  for (const f of folk) {
    const trade = f.tradeDef
    const bar = progressBar(f.favor / f.target, 8)
    const mark = f.gifted ? ' 🎁' : f.ready ? ' ✨' : ''
    lines.push(`${label(f)} the ${trade?.name ?? 'townsfolk'}${mark}`)
    lines.push(`   ${bar} ${f.favor}/${f.target} favor`)
  }
  lines.push('')
  lines.push(`👥 *${folk.length}/${folkCap()}* named residents  ·  🏘️ ${Math.max(0, Math.floor(record.npcs ?? 0)).toLocaleString()} living here in all`)
  if (ready.length && rel === 'owner') {
    lines.push(`✨ *${ready.length}* ${ready.length === 1 ? 'has' : 'have'} something for you: *${p}folk gift <name>*`)
  }
  lines.push('')
  lines.push(`_Look closer with *${p}folk <name>*.${rel === 'owner' ? ` Win them over with *${p}folk greet <name>*.` : ''}_`)
  return lines.join('\n')
}

/** One resident, close up: their work, their kit, and what they are holding for you. */
function renderMember(record, f, rel, p, now) {
  const trade = f.tradeDef
  const item = itemMap[f.heirloom]
  const given = f.name.split(' ')[0]
  const lines = [`${label(f)}`, `_${trade?.name ?? 'Townsfolk'} of ${record.name}_`, RULE]
  // trade.work is written to follow a name ("works the threshing floor"), so the
  // resident's given name goes in front of it rather than a bare sentence.
  lines.push(`🛠️ ${given} ${trade?.work ?? 'works the day away.'}`)
  lines.push(`⚔️ *Carries:* ${f.weapon}`)
  lines.push(`🛡️ *Wears:* ${f.armor?.name ?? 'plain workwear'}`)
  if (f.armor?.look) lines.push(`   _${f.armor.look}_`)
  lines.push('')
  lines.push(`💛 *Favor:* ${progressBar(f.favor / f.target, 10)} ${f.favor}/${f.target}`)

  if (item) {
    if (f.gifted) {
      lines.push(`🎁 Already gave you the *${item.name}*. That was theirs to give once.`)
    } else if (f.ready) {
      lines.push(`✨ Has the *${item.name}* ${rarityStars(item.rarity)} set aside for the ruler.`)
    } else if (rel === 'owner') {
      lines.push(`🔒 Keeps something back: *${item.name}* ${rarityStars(item.rarity)}, once they trust you.`)
    } else {
      lines.push(`🔒 Keeps a family piece back, for the ruler alone.`)
    }
  }

  if (rel === 'owner' && !f.gifted) {
    const cd = Math.max(0, Number(FOLK_CONFIG.greetCooldownHours) || 0) * 3600 * 1000
    const left = cd - (now - (f.lastGreetAt ?? 0))
    lines.push('')
    if (f.ready) lines.push(`_Take it with *${p}folk gift ${f.name.split(' ')[0].toLowerCase()}*._`)
    else if (left > 0) lines.push(`_They have had their word with you. Speak again in *${fmtDuration(left)}*._`)
    else lines.push(`_Stop and talk with *${p}folk greet ${f.name.split(' ')[0].toLowerCase()}*._`)
  }
  return lines.join('\n')
}

export default {
  name:           'folk',
  aliases:        ['townsfolk', 'villagers', 'people'],
  category:       'empire',
  requiresPlayer: true,
  description:    'Meet the people living in an empire, win their favor, collect their heirloom armor',

  async run(ctx) {
    const p = config.prefix
    if (!(await gate(ctx))) return

    const { record, rel } = standingIn(ctx)
    if (!record) {
      return ctx.reply(
        `🏘️ You are not standing in any empire, so there is nobody here to meet.\n` +
        `_Travel to one with *${p}empire visit <name>*, or found your own with *${p}empire found <name>*._`
      )
    }

    const now = Date.now()
    const sub = (ctx.args[0] ?? '').toLowerCase()
    const rest = ctx.args.slice(1).join(' ').trim()

    // ── greet ────────────────────────────────────────────────────────────
    if (sub === 'greet' || sub === 'talk' || sub === 'hello') {
      if (rel !== 'owner') {
        return ctx.reply(`🏘️ The folk of *${record.name}* answer to their own ruler. Only ${record.name}'s ruler can hold court with them.`)
      }
      if (!rest) return ctx.reply(`🏘️ Greet who? _*${p}folk greet <name>*._`)

      // ONE mutator. greetFolkMember banks pending favor, checks the cooldown and
      // applies the greeting inside the same serialized write, so two greetings
      // racing each other cannot both land.
      const recId = record.id
      let outcome = null
      await updatePlayer(ctx.db, ctx.from, player => {
        const rec = ctx.db.data.empires?.[recId]
        if (!rec) { outcome = { reason: 'missing' }; return player }
        outcome = greetFolkMember(rec, rest, now)
        if (outcome.ok) rec.lastActiveAt = now
        player.empireSpot = 'square'
        return player
      })

      if (outcome?.reason === 'missing') return ctx.reply(`❌ That empire record could not be found.`)
      if (outcome?.reason === 'cooldown') {
        return ctx.reply(
          `🏘️ ${label(outcome.folk)} has already had their word with you today.\n` +
          `_Come back in *${fmtDuration(outcome.waitMs)}*._`
        )
      }
      if (outcome?.reason === 'gifted') {
        return ctx.reply(`🏘️ ${label(outcome.folk)} has already given you everything they had to give. They just nod, glad to see you.`)
      }
      if (!outcome?.ok) {
        return ctx.reply(
          `🏘️ Nobody named *"${rest}"* lives in ${record.name}.\n` +
          `_See who does with *${p}folk*._`
        )
      }

      const f = outcome.folk
      const item = itemMap[folkTradeMap[f.trade]?.heirloom]
      const target = folkGiftFavor()
      const out = [
        `🏘️ *You stop and talk with ${f.name}.*`,
        `_${f.name.split(' ')[0]} ${folkTradeMap[f.trade]?.work ?? 'sets the work down for a moment.'}_`,
        '',
        `💛 *+${outcome.gained} favor*  ${progressBar(f.favor / target, 10)} ${f.favor}/${target}`,
      ]
      if (outcome.ready && item) {
        out.push('')
        out.push(`✨ *They have something for you.* Take it with *${p}folk gift ${f.name.split(' ')[0].toLowerCase()}*.`)
      }
      return ctx.reply(out.join('\n'))
    }

    // ── gift ─────────────────────────────────────────────────────────────
    if (sub === 'gift' || sub === 'take' || sub === 'claim') {
      if (rel !== 'owner') {
        return ctx.reply(`🏘️ What the folk of *${record.name}* keep back, they keep for their own ruler.`)
      }
      if (!rest) return ctx.reply(`🏘️ Take whose gift? _*${p}folk gift <name>*._`)

      // ONE mutator again: the resident is marked gifted and the armor is pushed
      // into the bag in the same write, so the heirloom can never be handed over
      // twice or marked spent without landing.
      const recId = record.id
      let outcome = null
      await updatePlayer(ctx.db, ctx.from, player => {
        const rec = ctx.db.data.empires?.[recId]
        if (!rec) { outcome = { reason: 'missing' }; return player }
        const claim = claimFolkGift(rec, rest, now)
        if (!claim.ok) { outcome = claim; return player }
        player.inventory = player.inventory ?? []
        // Room is checked in here so a full bag leaves the heirloom with its
        // owner: they stay un-gifted and the ruler can come back after tidying.
        if (!hasInventoryRoom(player, 1)) {
          outcome = { reason: 'full', message: inventoryFullMessage(player) }
          return player
        }
        player.inventory.push(claim.itemId)
        claim.folk.gifted = true
        rec.lastActiveAt = now
        player.empireSpot = 'square'
        outcome = { ok: true, folk: claim.folk, itemId: claim.itemId }
        return player
      })

      if (outcome?.reason === 'missing') return ctx.reply(`❌ That empire record could not be found.`)
      if (outcome?.reason === 'full') return ctx.reply(`🎒 ${outcome.message}\n_The heirloom stays with its owner until you have room._`)
      if (outcome?.reason === 'already') {
        return ctx.reply(`🎁 ${label(outcome.folk)} already gave you their heirloom. A person only has the one.`)
      }
      if (outcome?.reason === 'notyet') {
        const f = outcome.folk
        return ctx.reply(
          `🔒 ${label(f)} is not ready to part with anything yet.\n` +
          `💛 ${progressBar(f.favor / folkGiftFavor(), 10)} ${f.favor}/${folkGiftFavor()} favor, *${outcome.need}* to go.\n` +
          `_Greet them with *${p}folk greet ${f.name.split(' ')[0].toLowerCase()}*, or buy the house a round with *${p}order*._`
        )
      }
      if (!outcome?.ok) {
        return ctx.reply(
          `🏘️ Nobody named *"${rest}"* lives in ${record.name}.\n` +
          `_See who does with *${p}folk*._`
        )
      }

      const item = itemMap[outcome.itemId]
      const f = outcome.folk
      return ctx.reply(
        `🎁 *${f.name} presses it into your hands.*\n` +
        `_"It has been in the family. It should be on someone who stands in front."_\n` +
        RULE + '\n' +
        `🛡️ *${item?.name ?? outcome.itemId}* ${rarityStars(item?.rarity)}\n` +
        `_${item?.description ?? ''}_\n\n` +
        `_In your bag. Put it on with *${p}equip ${item?.name?.toLowerCase() ?? outcome.itemId}*._`
      )
    }

    // ── look ─────────────────────────────────────────────────────────────
    const folk = previewFolk(record, now)
    const query = ctx.args.join(' ').trim()
    if (!query) return ctx.reply(renderRoster(record, folk, rel, p))

    const hit = findFolkMember(record, query)
    if (!hit) {
      return ctx.reply(
        `🏘️ Nobody named *"${query}"* lives in ${record.name}.\n` +
        `_See who does with *${p}folk*._`
      )
    }
    const view = folk.find(f => f.name === hit.name) ?? hit
    return ctx.reply(renderMember(record, view, rel, p, now))
  },
}
