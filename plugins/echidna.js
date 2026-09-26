/**
 * echidna.js - speak to Echidna, the Witch of Greed.
 *
 *   <prefix>echidna <anything>   talk to her - AI-powered (OpenRouter), in character,
 *                                fully aware of her owner's live state
 *                                (wallet, battles, and the child if one
 *                                exists - see lib/echidna-persona.js)
 *   <prefix>echidna              her status card (today's mood, the child,
 *                                her commands)
 *   <prefix>echidna ritual       the sanctuary rite: Echidna grants her
 *                                holder ONE child (never two). A short
 *                                story plays out message by message, and
 *                                the child is born into the holder's house.
 *   <prefix>echidna child        check on the child: every visit ages them
 *                                (on a cooldown), stages them up
 *                                newborn -> infant -> child -> grown, and
 *                                they press a small gift of coin into their
 *                                parent's hand. A grown child steals beside
 *                                Echidna in battle (Little Gospel).
 *   <prefix>echidna name <name>  name the child (1-24 characters).
 *
 * Ownership rules: the AI voice and the rite belong to the holder of the
 * exclusive (the one who passed her 250 refusals). Anyone else who speaks to
 * her gets a static, in-character dismissal - never an API call.
 *
 * The AI key is config.openrouterApiKey (OPENROUTER_API_KEY overrides it);
 * the personality lives in data/echidna-personality.json.
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { ownsEchidna, ECHIDNA_CHARACTER_ID } from '../lib/character-abilities.js'
import { characterMap } from '../lib/game-data.js'
import { fmtGems } from '../lib/format.js'
import { askAI } from '../lib/openrouter.js'
import {
  renderEchidnaSystemPrompt,
  chatHistory,
  rememberTurn,
} from '../lib/echidna-persona.js'
import {
  hasChild,
  visitChild,
  nameChild,
  describeChild,
  childName,
} from '../lib/echidna-child.js'

const RULE = '━━━━━━━━━━━━━━━━━━━━'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── Static dismissals for non-holders (never an API call) ─────────────────
const STRANGER_LINES = [
  `🍵 _She glances at you over the rim of her cup._ "You are not the one who kept paying. The tea is for someone else."`,
  `🍵 "How bold. Strangers are not even worth appraising." _She turns a page of the Gospel and forgets you exist._`,
  `🍵 _She smiles without warmth._ "One person in this world gets my attention. It is not you. Do the maths."`,
]

// ── The sanctuary rite, one message at a time ─────────────────────────────
// Echidna grants ONE child via her own lore - vessels made in the sanctuary,
// a soul asked for out of the world's memory. Nothing in this scene is
// explicit: it plays as a witch's ceremony, and the bot's content rules
// (and hers, see data/echidna-personality.json) keep it that way.
//
// COPY RULE (2026-09-22): the rite carries no dash punctuation at all. Not an
// em dash, not an en dash, not the spaced " - " the rest of the bot leans on
// as its em-dash substitute. This is prose read aloud rather than a status
// line, so the beats use commas, colons and full stops. Pinned by
// test/echidna.test.mjs, because every other "just remove the dashes" cleanup
// in this repo has quietly regressed back to " - " within a session or two.
function ritualBeats(holderName) {
  return [
    `🍵 _The candles burn blue. Echidna sets a second cup across from you at the tea table, then a third, smaller one, at its edge._\n\n_"So. You want a child of mine. Sit down, ${holderName}. This is not done the common way. I am no common woman." _`,
    `📖 _"The Gospel remembers every soul that ever was. I will ask it for one that has not been written yet." _\n\n_The Tome of Wisdom opens of its own accord. Pages turn like a storm settling, and somewhere in them a very small future holds its breath._`,
    `🕯️ _"A soul needs a vessel. I have built vessels before, and you will not ask me about the sanctuary." _\n\n_Her hands move over the porcelain cup. Steam rises, thickens, and quietly begins to breathe._`,
    `🌙 _Hours pass. The tea goes cold. The candles burn to brass. And at last, cutting the sanctuary's silence, a thin, indignant, brand-new cry._`,
  ]
}

function ritualClosing(name) {
  return (
    `🍼 *A child has come into your house.*\n${RULE}\n` +
    `_Echidna looks everywhere except at you._\n` +
    `_"One. That is all you get, ever. My generosity has ledgers. ...Name the child. And don't make it embarrassing." _\n\n` +
    `👶 *${name}* is a newborn, asleep in your house.\n` +
    `· Name them: *${config.prefix}echidna name <name>*\n` +
    `· Check on them: *${config.prefix}echidna child* _(they grow as you visit)_\n` +
    `· When they are grown, they will steal beside her in battle.`
  )
}

async function runRitual(ctx) {
  if (!ownsEchidna(ctx.player)) {
    return ctx.reply(`🍵 _"The sanctuary rite is not for you. It belongs to the one I accepted." _`)
  }
  if (hasChild(ctx.player)) {
    const c = describeChild(ctx.player.echidnaChild)
    return ctx.reply(
      `🍵 *ONE child.*\n${RULE}\n` +
      `_Her eyes narrow over the teacup._\n` +
      `_"You already have one of mine: *${c.name}*, ${c.stage}. The rite happens once in a lifetime, and you have spent yours." _`,
    )
  }

  for (const beat of ritualBeats(ctx.player.name ?? 'holder')) {
    await ctx.reply(beat)
    await sleep(1500)
  }

  await updatePlayer(ctx.db, ctx.from, (player) => {
    if (player.echidnaChild?.bornAt) return // raced: keep exactly one child
    player.echidnaChild = { name: null, bornAt: Date.now(), visits: 0, lastVisitAt: 0 }
  })
  const bornName = childName(getPlayer(ctx.db, ctx.from)?.echidnaChild ?? null)
  return ctx.reply(ritualClosing(bornName))
}

const VISIT_SCENES = {
  newborn: [
    (n) => `👶 _${n} is asleep in a nest of your spare capes. One tiny fist is closed around a shiny button that was definitely yours. Echidna watches from the doorway, pretending she is not._`,
    (n) => `👶 _You check the crib. ${n} blinks up at you, decides you are acceptable, and goes back to sleep. Somewhere in the room, a coin rolls one inch on its own._`,
  ],
  infant: [
    (n) => `🍼 _${n} toddles over, trips, and upsets a cup of coins Echidna left "as an experiment". Neither of them apologises. The child hands you the biggest one._`,
    (n) => `🍼 _${n} has discovered pockets - yours. Echidna takes notes in the Gospel, calling it "early fieldwork"._`,
  ],
  child: [
    (n) => `🧒 _${n} races you to the door and almost wins. They have started practising their mother's smile. It is terrifying._`,
    (n) => `🧒 _${n} shows you today's haul: three buttons, a marble, and someone's missing earring. Echidna calls it "a promising portfolio"._`,
  ],
  grown: [
    (n) => `🧑‍🎓 _${n} is grown now, tall and quick-eyed, and already counts coins the way other people breathe. They clap your shoulder like a partner, not a child._`,
    (n) => `🧑‍🎓 _${n} hands you a full purse without a word - "the day's work". Behind you, Echidna's smugness could fill a cathedral._`,
  ],
}

async function runVisit(ctx) {
  if (!hasChild(ctx.player)) {
    return ctx.reply(
      `🍵 _"There is no child here. Yet." _\n${RULE}\n` +
      `_Perform the sanctuary rite with *${config.prefix}echidna ritual*. One child, ever._`,
    )
  }

  let visit = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    visit = visitChild(player, Date.now())
    if (visit.ok && visit.gift > 0) {
      player.wallet = player.wallet ?? { solars: 0, gems: 0 }
      player.wallet.solars = (player.wallet.solars ?? 0) + visit.gift
    }
  })

  if (!visit?.ok) {
    if (visit?.reason === 'cooldown') {
      return ctx.reply(`🍵 _${childName(ctx.player.echidnaChild)} just saw you. Let the child miss you - try again in *${visit.mins} min*._`)
    }
    return ctx.reply(`🍵 _There is no child to visit._`)
  }

  const c = describeChild(ctx.player.echidnaChild)
  const scenes = VISIT_SCENES[visit.stage] ?? VISIT_SCENES.newborn
  const scene = scenes[(Number(ctx.player.echidnaChild.visits) || 1) % scenes.length](c.name)

  const lines = [scene]
  if (visit.grewUp) {
    lines.push(``, `✨ *${c.name} has grown - ${visit.stageBefore} ➜ ${visit.stage}!*${visit.stage === 'grown' ? `\n🍵 _"Finally. They can hold a ledger." _ - from now on *${c.name}* steals beside Echidna in battle (*${config.prefix}greed*).` : ''}`)
  }
  if (visit.gift > 0) lines.push(``, `🪙 *${c.name} pressed ☀️${visit.gift} Solars into your hand.* _Children should not know how to do that. Echidna is very proud._`)
  if (visit.stage !== 'grown') {
    lines.push(``, `📈 Growth: *${c.stage}* · ${Math.max(0, Math.round(c.hoursToNext))}h of attention to the next stage _(each visit counts as 6h)_.`)
  }
  return ctx.reply(lines.join('\n'))
}

async function runName(ctx) {
  const raw = ctx.args.slice(1).join(' ')
  let res = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    res = nameChild(player, raw)
  })
  if (res?.reason === 'no_child') {
    return ctx.reply(`🍵 _"Name what? Perform the rite first: *${config.prefix}echidna ritual*. One child, ever." _`)
  }
  if (!res?.ok) {
    return ctx.reply(`❌ That name won't do${res?.reason === 'too_long' ? ' - 24 characters at most' : ''}. Try: *${config.prefix}echidna name <name>*`)
  }
  return ctx.reply(
    `🍵 *Named.*\n${RULE}\n` +
    `_Echidna repeats it once, tasting it._ _"...${res.name}. Very well. It suits them. If you tell anyone I said that, I will double your debts." _\n` +
    `_Check on *${res.name}* anytime with *${config.prefix}echidna child*._`,
  )
}

async function runStatus(ctx) {
  const p = ctx.prefix ?? config.prefix
  const character = characterMap[ECHIDNA_CHARACTER_ID]
  const equipped = ctx.player?.equippedCharacter === ECHIDNA_CHARACTER_ID
  const owns = ownsEchidna(ctx.player)
  const c = describeChild(ctx.player?.echidnaChild)
  const moodIdx = (Math.floor(Date.now() / 86_400_000) + (ctx.player?.name?.length ?? 0)) % 3
  const moods = ['😌 amused - the Gospel is open and her hands are quick', '🤨 capricious - do not bore her today', '😒 displeased - count your pockets before AND after the tea']

  const lines = [
    `🍵 *ECHIDNA, THE WITCH OF GREED*`,
    RULE,
    owns
      ? (equipped ? `✅ _Equipped and at your side._` : `✅ _Yours, forever. Equip her: *${p}character equip echidna*._`)
      : `🔒 _Not yours. One player bot-wide ever gets her - *${p}echidna-spin*, 0.9 gems a spin._`,
    ``,
    `🎭 Today's mood: ${moods[moodIdx]}`,
    `⚔️ Battle: *${p}greed* - once per fight, her mood decides how much of the enemy's money and gems she hands you.`,
    `📖 Read: *${p}wisdom* - the enemy's whole page, or your own out of battle.`,
    c
      ? `\n${c.emoji} Child: *${c.name}* - ${c.stage}${c.stage === 'grown' ? ' · steals beside her in battle' : ` · ${Math.max(0, Math.round(c.hoursToNext))}h to next stage`}\n_Check on them: *${p}echidna child* · Rename: *${p}echidna name <name>*_`
      : `\n🍼 Child: _none yet_ · Sanctuary rite: *${p}echidna ritual* _(one child, ever)_`,
    ``,
    `💬 Or simply talk to her: *${p}echidna <message>*`,
  ]
  return ctx.reply(lines.join('\n'))
}

async function runChat(ctx, text) {
  if (!ownsEchidna(ctx.player)) {
    const line = STRANGER_LINES[(ctx.from?.length ?? 0) % STRANGER_LINES.length]
    return ctx.reply(line)
  }
  if (!config.openrouterApiKey) {
    return ctx.reply(
      `🍵 _She frowns at the Gospel; the page comes back blank._\n` +
      `_(Her voice needs an OpenRouter key - set *OPENROUTER_API_KEY* in the bot's environment (\`.env\`), then restart.)_`,
    )
  }

  const history = chatHistory(ctx.from)
  const userTurn = { role: 'user', content: text }
  try {
    const { text: answer } = await askAI({
      system: renderEchidnaSystemPrompt(ctx.player),
      messages: [...history, userTurn],
      temperature: 0.95,
      maxTokens: 400,
    })
    rememberTurn(ctx.from, text, answer)
    return ctx.reply(answer)
  } catch (err) {
    if (err?.status === 401 || err?.status === 402 || err?.status === 403) {
      return ctx.reply(
        `🍵 _She taps the Gospel, irritated._ _"The connection is refused - the key the bot carries does not open the door." _\n` +
        `_(Check OPENROUTER_API_KEY - the API rejected it, status ${err.status}.)_`,
      )
    }
    return ctx.reply(`🍵 _She frowns at the Gospel; the page comes back blank._ _"Ask me again in a moment - even the world's memory stutters sometimes." _`)
  }
}

const RITUAL_WORDS = new Set(['ritual', 'ceremony', 'tea-party', 'teaparty', 'sanctuary', 'rite'])
const CHILD_WORDS = new Set(['child', 'kid', 'baby', 'son', 'daughter', 'visit', 'heir'])

export default {
  name: 'echidna',
  aliases: ['witch-of-greed', 'ech'],
  category: 'character',
  requiresPlayer: true,
  description: `${config.prefix}echidna <message>: talk to Echidna, the Witch of Greed (holder only). Subcommands: ritual, child, name <name>, status`,

  async run(ctx) {
    const sub = String(ctx.args[0] ?? '').toLowerCase()

    if (!sub) return runStatus(ctx)
    if (RITUAL_WORDS.has(sub)) return runRitual(ctx)
    if (CHILD_WORDS.has(sub)) return runVisit(ctx)
    if (sub === 'name') return runName(ctx)
    if (sub === 'status' || sub === 'info' || sub === 'help') return runStatus(ctx)

    return runChat(ctx, ctx.args.join(' ').trim())
  },
}
