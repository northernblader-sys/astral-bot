/**
 * inn.js — The Astral Town inn. Restore HP and MP for Solars.
 *
 * .inn         — show prices and current HP/MP
 * .inn rest    — full rest (costs Solars based on missing HP/MP)
 * .inn hp      — restore HP only (half price)
 * .inn mp      — restore MP only (half price)
 * .inn sleep   — free full restore (HP/MP/stamina), but locks every command
 *                for SLEEP_MINUTES and can only be done once per calendar day
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { hpBar } from '../lib/combat-engine.js'
import { beginSleep, hasSleptToday, isAsleep, SLEEP_MINUTES } from '../lib/sleep-engine.js'
import { formatTimeLeft } from '../lib/time-format.js'

const SOLAR_PER_HP = 0.5   // cost per 1 HP restored
const SOLAR_PER_MP = 0.3   // cost per 1 MP restored

export default {
  name:           'inn',
  aliases:        ['rest', 'heal', 'sleep'],
  category:       'town',
  requiresPlayer: true,
  description:    'Rest at the inn to restore HP and MP',

  async run(ctx) {
    const { args, reply } = ctx
    const p    = config.prefix
    const player = ctx.player

    if (player.inBattle) {
      return reply(`⚔️ You can't rest while in battle!`)
    }
    if (player.inDungeon) {
      return reply(`🗺️ Exit the dungeon first. Use *${p}dungeon leave*.`)
    }
    if (player.location !== 'astral_town') {
      return reply(`🏠 The inn is only available in *Astral Town*.\nYou are in *${player.location ?? 'unknown'}*.`)
    }

    const missingHp = player.maxHp - player.hp
    const missingMp = player.maxMp - player.mp
    const costHp    = Math.ceil(missingHp * SOLAR_PER_HP)
    const costMp    = Math.ceil(missingMp * SOLAR_PER_MP)
    const costFull  = costHp + costMp

    // `.sleep` is registered as an alias of this plugin, and it means "go to
    // bed" directly rather than "open the inn menu". Players were typing
    // `.sleep`, getting nothing at all (it wasn't a command), and reporting
    // that sleep was broken. `.inn sleep` still works exactly as before.
    const sub = args[0]?.toLowerCase() ?? (ctx.cmd === 'sleep' ? 'sleep' : undefined)

    // Show menu
    if (!sub || sub === 'menu') {
      return reply(
        `🏠 *ASTRAL INN*\n` +
        `_Maelin is behind the desk. The lamp is lit. This is a bed, not a menu._\n\n` +
        `👤 *${player.name}*\n` +
        `❤️ HP: ${hpBar(player.hp, player.maxHp)}\n` +
        `💧 MP: ${player.mp}/${player.maxMp}\n` +
        `☀️ Solars: ${player.wallet.solars ?? 0}\n\n` +
        `📋 *Services:*\n` +
        `  • *${p}inn rest* — Full recovery _(${costFull} ☀️)_\n` +
        `  • *${p}inn hp*   — HP only _(${costHp} ☀️)_\n` +
        `  • *${p}inn mp*   — MP only _(${costMp} ☀️)_\n` +
        `  • *${p}inn sleep* — Free full restore + stamina _(locks all commands for ${SLEEP_MINUTES}min, once/day)_`,
      )
    }

    if (sub === 'sleep') {
      if (isAsleep(player)) {
        return reply(`😴 You're already asleep. You'll wake up in *${formatTimeLeft(player.sleepUntil - Date.now())}*.`)
      }
      if (hasSleptToday(player)) {
        return reply(`⚠️ You've already slept today. Come back tomorrow.`)
      }

      let outcome = null
      await updatePlayer(ctx.db, ctx.from, p2 => {
        if (isAsleep(p2) || hasSleptToday(p2)) {
          outcome = 'already'
          return p2
        }
        beginSleep(p2)
        outcome = 'ok'
        return p2
      })

      if (outcome === 'already') {
        return reply(`⚠️ You've already slept today. Come back tomorrow.`)
      }

      return reply(
        `💤 You lie down at the inn and drift off to sleep...\n\n` +
        `You'll wake in *${SLEEP_MINUTES} minutes*, fully restored — HP, MP, and stamina.\n` +
        `⚠️ *All commands are locked until you wake up.*`,
      )
    }

    await updatePlayer(ctx.db, ctx.from, async player => {
      const solars = player.wallet.solars ?? 0

      if (sub === 'rest') {
        const missing = (player.maxHp - player.hp) + (player.maxMp - player.mp)
        if (missing === 0) { await reply(`✅ You're already at full HP and MP!`); return player }
        const cost = Math.ceil((player.maxHp - player.hp) * SOLAR_PER_HP + (player.maxMp - player.mp) * SOLAR_PER_MP)
        if (solars < cost) { await reply(`❌ Not enough Solars! Need *${cost} ☀️*, have *${solars} ☀️*.`); return player }
        player.wallet.solars -= cost
        player.hp = player.maxHp
        player.mp = player.maxMp
        await reply(`🛏️ *Fully rested!* _(-${cost} ☀️)_\n❤️ HP: ${player.maxHp}/${player.maxHp}\n💧 MP: ${player.maxMp}/${player.maxMp}`)
        return player
      }

      if (sub === 'hp') {
        const missing = player.maxHp - player.hp
        if (missing === 0) { await reply(`✅ HP is already full!`); return player }
        const cost = Math.ceil(missing * SOLAR_PER_HP)
        if (solars < cost) { await reply(`❌ Need *${cost} ☀️*, have *${solars} ☀️*.`); return player }
        player.wallet.solars -= cost
        player.hp = player.maxHp
        await reply(`💊 *HP restored!* _(-${cost} ☀️)_\n❤️ ${player.maxHp}/${player.maxHp}`)
        return player
      }

      if (sub === 'mp') {
        const missing = player.maxMp - player.mp
        if (missing === 0) { await reply(`✅ MP is already full!`); return player }
        const cost = Math.ceil(missing * SOLAR_PER_MP)
        if (solars < cost) { await reply(`❌ Need *${cost} ☀️*, have *${solars} ☀️*.`); return player }
        player.wallet.solars -= cost
        player.mp = player.maxMp
        await reply(`🔷 *MP restored!* _(-${cost} ☀️)_\n💧 ${player.maxMp}/${player.maxMp}`)
        return player
      }

      await reply(`❓ Unknown option. Use *${p}inn* to see options.`)
      return player
    })
  },
}
