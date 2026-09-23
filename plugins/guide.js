/**
 * guide.js - .guide: a start to finish walkthrough of the whole bot.
 *
 * `.guide`            shows the full journey overview (one step per feature area).
 * `.guide <topic>`    shows a deep dive: account, gear, combat, dungeon, pvp,
 *                     collect, economy, social.
 *
 * Deliberately written with no em dashes. Commands are built from config.prefix
 * so the walkthrough always matches the bot's real prefix.
 */
import { config } from '../config.js'

const DIV = '━━━━━━━━━━━━━━━━━'

function overview(p) {
  return (
    `🌌 *ASTRAL  ·  YOUR JOURNEY*\n` +
    `${DIV}\n` +
    `_A path through everything, from your first breath to endgame. Type *${p}guide <topic>* for a deep dive on any step._\n\n` +

    `*1. Be born* 🧬\n` +
    `Run *${p}register* to set up your character and pick a race. See yourself with *${p}me*, *${p}profile*, and *${p}id*.\n\n` +

    `*2. Grow stronger* 💪\n` +
    `Spend points with *${p}stats* and *${p}train*, choose your 4 battle skills in *${p}skillslot*, and buy or equip heroes with *${p}character*.\n` +
    `_More: *${p}guide account*_\n\n` +

    `*3. Gear up* ⚔️\n` +
    `Rest at the *${p}inn*, buy from the *${p}shop*, *${p}mine* materials, then *${p}craft* gear at the *${p}table* and *${p}equip* it.\n` +
    `_More: *${p}guide gear*_\n\n` +

    `*4. Enter the rifts* 🌀\n` +
    `*${p}travel* to a dungeon, *${p}enter* it, and clear floors with *${p}attack*, *${p}defend*, *${p}skill*, and *${p}useability*. Read any foe with *${p}willow*.\n` +
    `_More: *${p}guide combat*_\n\n` +

    `*5. Break the season boss* 👑\n` +
    `Floor 50 needs a team. Form a squad with *${p}dparty* and take the final boss down together.\n` +
    `_More: *${p}guide dungeon*_\n\n` +

    `*6. Duel players* 🥊\n` +
    `Challenge anyone with *${p}pvp @player*, study them first with *${p}scout*, and learn the named lines in *${p}gambits*.\n` +
    `_More: *${p}guide pvp*_\n\n` +

    `*7. Collect the world* 🎴\n` +
    `Grab wild Pokemon, anime cards, and anime series with *${p}collect <code>* when they spawn. Show them with *${p}party*, *${p}deck*, and *${p}series*.\n` +
    `_More: *${p}guide collect*_\n\n` +

    `*8. Build wealth* ☀️\n` +
    `Claim your *${p}daily*, take a role in *${p}jobs* and *${p}work* it, run your *${p}farm*, and trade in the *${p}auction*. Bank safely with *${p}vault* and *${p}apay*.\n` +
    `_More: *${p}guide economy*_\n\n` +

    `*9. Put down roots* 🏠\n` +
    `Build and furnish a house with *${p}home*, *${p}build*, and *${p}decor*. Walk the streets with *${p}town*, take a hall slip with *${p}board*, join a *${p}guild*, grow your *${p}fame*, and go *${p}stream*.\n` +
    `_More: *${p}guide social*_\n\n` +

    `${DIV}\n` +
    `📜 Every command: *${p}menu*  ·  the flat list: *${p}allcommands*\n` +
    `📖 The duel opening book: *${p}gambits*  ·  the towers: *${p}bestiary*`
  )
}

const TOPICS = {
  account: (p) =>
    `🧬 *GUIDE: YOUR CHARACTER*\n` +
    `${DIV}\n` +
    `▸ *${p}register* : create your character and choose a race.\n` +
    `▸ *${p}me* / *${p}profile* : your summary and full profile.\n` +
    `▸ *${p}id* : your ID card (*${p}id color* to restyle it).\n` +
    `▸ *${p}username* : reserve a unique name.\n` +
    `▸ *${p}stats* : allocate the stat points you earn on level up.\n` +
    `▸ *${p}train* : buy extra stat points with Solars.\n` +
    `▸ *${p}skills* : every skill you have unlocked.\n` +
    `▸ *${p}skillslot* : pick the 4 skills you carry into battle.\n` +
    `▸ *${p}character* : browse, buy, and equip heroes.\n\n` +
    `_Fast start: register, spend your stats, set your skillslots, then head to a dungeon._`,

  gear: (p) =>
    `⚔️ *GUIDE: GEAR & CRAFTING*\n` +
    `${DIV}\n` +
    `▸ *${p}inn* : rest to restore HP and MP.\n` +
    `▸ *${p}shop* : buy weapons, armor, and potions.\n` +
    `▸ *${p}gm* : the Game Shop for relics and gem offers.\n` +
    `▸ *${p}inventory* : see everything you own.\n` +
    `▸ *${p}equip* / *${p}unequip* : wield weapons, shields, armor, relics.\n` +
    `▸ *${p}inspect* : read an item's full details.\n` +
    `▸ *${p}use* : drink a potion or consume an item.\n` +
    `▸ *${p}mine* : gather crafting materials (costs stamina).\n` +
    `▸ *${p}table* / *${p}craft* : forge new gear at the blacksmith.\n` +
    `▸ *${p}chest* : safe storage that survives death.\n\n` +
    `_Mine for materials, craft the best gear you can, and always rest before a hard floor._`,

  combat: (p) =>
    `🗡️ *GUIDE: COMBAT*\n` +
    `${DIV}\n` +
    `Every fight is turn based. On your turn:\n` +
    `▸ *${p}attack* : a basic strike.\n` +
    `▸ *${p}defend* : brace to cut damage and recover 5% MP.\n` +
    `▸ *${p}skill <name>* : cast one of your equipped skills.\n` +
    `▸ *${p}useability <slot>* : trigger an equipped active ability.\n` +
    `▸ *${p}cinderverdict* : Wither's once per battle ember sentence (no MP).\n\n` +
    `Support:\n` +
    `▸ *${p}willow* : a free readout on your enemy, costs no turn.\n` +
    `▸ *${p}summon* / *${p}equipbeast* : bring a beast you found while mining.\n` +
    `▸ *${p}inn* : heal up between fights.\n\n` +
    `_Watch your MP. Defending is not passive, it buys magic back and softens the next hit._`,

  dungeon: (p) =>
    `🌀 *GUIDE: DUNGEONS*\n` +
    `${DIV}\n` +
    `▸ *${p}travel* : open the world map and move to a dungeon.\n` +
    `▸ *${p}enter* / *${p}dungeon* : step into the current rift.\n` +
    `▸ Clear each floor with the combat commands (see *${p}guide combat*).\n` +
    `▸ *${p}bestiary* : what the tower feels like, and the families that walk it.\n` +
    `▸ *${p}ranking* : the dungeon floor leaderboard.\n\n` +
    `_The master is the last floor. The floors under that are not champions._\n\n` +
    `*The season boss* 👑\n` +
    `Floor 50 is guarded by the season's final boss, built for a team and not a solo run.\n` +
    `▸ *${p}dparty* : create or join a dungeon squad (also *${p}dp*, *${p}coop*).\n` +
    `▸ Fight it together with the same combat commands.\n\n` +
    `_Note: *${p}party* is your Pokemon team. *${p}dparty* is your dungeon squad. Two different things._`,

  pvp: (p) =>
    `🥊 *GUIDE: PLAYER DUELS*\n` +
    `${DIV}\n` +
    `▸ *${p}pvp @player* : challenge someone (they reply *${p}pvp accept*).\n` +
    `▸ *${p}scout* : study an opponent before you spend a challenge.\n\n` +
    `Once a duel starts, take turns with:\n` +
    `▸ *${p}pvp attack*  ,  *${p}pvp defend*\n` +
    `▸ *${p}pvp skill <name>*  ,  *${p}pvp ability <name>*\n` +
    `▸ *${p}pvp cinderverdict*\n\n` +
    `After the dust settles:\n` +
    `▸ *${p}gambits* : the opening book of every named duel line.\n` +
    `▸ *${p}pvpstats* / *${p}pvptop* : your record and the ladder.\n` +
    `▸ *${p}tourney* : run bracket tournaments.\n` +
    `▸ *${p}curetear* : cleanse a Tear debuff left by a loss.\n\n` +
    `_The bot names the shape of your duel as you play, just like a chess engine. Learn the lines in *${p}gambits*._`,

  collect: (p) =>
    `🎴 *GUIDE: COLLECTING*\n` +
    `${DIV}\n` +
    `Wild Pokemon, anime cards, and anime series spawn in enabled groups. First to grab wins.\n` +
    `▸ *${p}collect <code>* : claim any spawn (Pokemon, card, or series).\n\n` +
    `*Pokemon* 🐾\n` +
    `▸ *${p}party* : your Pokemon team.\n` +
    `▸ *${p}move* : lock in a move during a Pokemon battle.\n` +
    `▸ Admins toggle spawns with *${p}pokeswitch on/off*.\n\n` +
    `*Anime cards* 💘\n` +
    `▸ *${p}deck* : your card collection.\n` +
    `▸ *${p}setwaifu* : pick your featured card, shown with *${p}waifu*.\n` +
    `▸ Admins toggle spawns with *${p}waifu on/off*.\n\n` +
    `*Anime series* 📺\n` +
    `▸ *${p}series* : browse, sell, send, and trade series cards.\n` +
    `▸ Admins toggle spawns with *${p}series on/off*.`,

  economy: (p) =>
    `☀️ *GUIDE: ECONOMY*\n` +
    `${DIV}\n` +
    `▸ *${p}daily* : claim your daily Solars, XP, and stamina.\n` +
    `▸ *${p}jobs* : view and apply for a job, then *${p}work* your shift.\n` +
    `▸ *${p}farm* : plant and harvest crops on your home plots.\n` +
    `▸ *${p}mine* : gather materials to craft or sell.\n` +
    `▸ *${p}auction* : bid on mythic gear in owner run rounds.\n` +
    `▸ *${p}send* : give Solars or items to another player.\n` +
    `▸ *${p}vault* : safe storage for Solars, immune to robbery and PvP.\n` +
    `▸ *${p}apay* : the AstralPay hub for pay, bank, loans, and giveaways.\n` +
    `▸ *${p}topup* : buy Gems.\n\n` +
    `_Bank what you cannot afford to lose in your *${p}vault*. Everything in your wallet is at risk in a duel._`,

  social: (p) =>
    `🏠 *GUIDE: HOME & TOWN*\n` +
    `${DIV}\n` +
    `*Your home*\n` +
    `▸ *${p}home* : your house of rooms, decor, plots, storage, and rest.\n` +
    `▸ *${p}build* : add rooms for permanent perks.\n` +
    `▸ *${p}decor* : furnish rooms and raise your comfort rating.\n` +
    `▸ *${p}farm* : work the plots on your land.\n` +
    `▸ *${p}homeinvite* : invite players over or visit theirs.\n\n` +
    `*The town*\n` +
    `▸ *${p}town* : walk the streets. *${p}where* says where you are standing.\n` +
    `▸ *${p}talk* : speak to whoever is on that street.\n` +
    `▸ *${p}board* : three guild slips a day. *${p}guild board* is the same nail.\n` +
    `▸ *${p}guild* : join and manage a guild. A hall is required to pull a slip.\n` +
    `▸ *${p}fame* : your renown from kills, bosses, and level ups.\n` +
    `▸ *${p}stream* : go live and let the town watch.\n` +
    `▸ *${p}top* / *${p}ranking* : the leaderboards.\n` +
    `▸ *${p}allcommands* : every command you can type. Owner tools are left out.`,
}

// Friendly aliases so near misses still land on the right page.
const TOPIC_ALIASES = {
  char: 'account', character: 'account', hero: 'account', start: 'account',
  equipment: 'gear', craft: 'gear', crafting: 'gear', shop: 'gear',
  fight: 'combat', battle: 'combat',
  dungeons: 'dungeon', rift: 'dungeon', boss: 'dungeon', party: 'dungeon',
  duel: 'pvp', duels: 'pvp', arena: 'pvp',
  collecting: 'collect', pokemon: 'collect', cards: 'collect', series: 'collect',
  money: 'economy', wealth: 'economy', econ: 'economy',
  home: 'social', house: 'social', town: 'social', guild: 'social',
}

export default {
  name: 'guide',
  aliases: ['journey', 'howto', 'getstarted'],
  category: 'utility',
  requiresPlayer: false,
  description: 'A start to finish walkthrough of the whole bot (.guide <topic> for a deep dive)',

  async run(ctx) {
    const { args, reply } = ctx
    const p = config.prefix
    const raw = (args[0] ?? '').toLowerCase()

    if (!raw) return reply(overview(p))

    const key = TOPIC_ALIASES[raw] ?? raw
    const build = TOPICS[key]
    if (!build) {
      return reply(
        `❓ No guide page called *"${raw}"*.\n` +
        `Try: ${Object.keys(TOPICS).map(t => `*${p}guide ${t}*`).join('  ·  ')}\n\n` +
        `Or just *${p}guide* for the full journey.`
      )
    }
    return reply(build(p))
  },
}
