import { playerExists, createPlayer } from '../lib/player-repo.js'
import { classes, races, defaultWallet } from '../lib/game-data.js'
import { buildNewPlayer, validateRegistration } from '../lib/player-factory.js'
import { config } from '../config.js'

/**
 * register — create a player profile with class and race selection.
 *
 * Usage: <prefix>register <name> <classId> <raceId>
 *
 * The record itself is built by lib/player-factory.js so the website's
 * sign-up page (POST /api/auth/register) produces an identical player.
 */
export default {
  name: 'register',
  aliases: [],
  category: 'account',
  description: 'Register your player profile to start playing',

  async run(ctx) {
    if (playerExists(ctx.db, ctx.from)) {
      return ctx.reply(`⚠️ Already registered. Use *${config.prefix}profile* to view your stats.`)
    }

    const classIds = Object.keys(classes)
    const raceIds  = Object.keys(races)

    const classLines = classIds
      .map(id => `  • *${id}* — ${classes[id].name}: ${classes[id].description.split('.')[0]}.`)
      .join('\n')
    const raceLines = raceIds
      .map(id => `  • *${id}* — ${races[id].name}: ${races[id].description.split('.')[0]}.`)
      .join('\n')

    const helpText =
      `📖 *Registration Guide*\n` +
      `Usage: *${config.prefix}register <name> <class> <race>*\n\n` +
      `⚔️ *Classes:*\n${classLines}\n\n` +
      `🧬 *Races:*\n${raceLines}\n\n` +
      `Example: *${config.prefix}register Aragorn warrior human*`

    const [nameArg, classArg, raceArg] = ctx.args

    if (!nameArg || !classArg || !raceArg) return ctx.reply(helpText)

    const check = validateRegistration({ name: nameArg, classId: classArg, raceId: raceArg })
    if (!check.ok) {
      // Keep the original, more helpful "choose from" listings for the two
      // unknown-id cases the chat flow can hit by typo.
      if (!classIds.includes(String(classArg).toLowerCase().trim())) {
        return ctx.reply(`❌ Unknown class *${classArg}*.\n\nChoose from: ${classIds.join(', ')}`)
      }
      if (!raceIds.includes(String(raceArg).toLowerCase().trim())) {
        return ctx.reply(`❌ Unknown race *${raceArg}*.\n\nChoose from: ${raceIds.join(', ')}`)
      }
      return ctx.reply(`❌ ${check.error}`)
    }

    const { name, classId, raceId } = check
    const newPlayer = buildNewPlayer({ id: ctx.from, name, classId, raceId })

    await createPlayer(ctx.db, ctx.from, newPlayer)

    const cls  = classes[classId]
    const race = races[raceId]
    await ctx.reply(
      `✅ *Welcome, ${name}!* Your adventure begins in the World of Astral.\n\n` +
      `⚔️ Class: *${cls.name}*\n` +
      `🧬 Race: *${race.name}*\n` +
      `❤️ HP: ${newPlayer.maxHp}  💧 MP: ${newPlayer.maxMp}\n` +
      `💪 STR ${newPlayer.stats.str}  🏃 AGI ${newPlayer.stats.agi}  🧠 INT ${newPlayer.stats.int}  🛡️ DEF ${newPlayer.stats.def}  🍀 LCK ${newPlayer.stats.lck}\n` +
      `☀️ Solars: ${defaultWallet.solars}  ⚡ Stamina: 30/30\n\n` +
      `🎒 Starting gear: ${cls.startingItems.join(', ')}\n` +
      `✨ Starting skill: ${cls.startingSkills.join(', ')}\n\n` +
      `📍 Location: *Astral Town* _(safe hub)_\n\n` +
      `_Type *${config.prefix}profile* to view your stats.\nType *${config.prefix}enter entry_tower* to begin your first dungeon._`,
    )
  },
}
