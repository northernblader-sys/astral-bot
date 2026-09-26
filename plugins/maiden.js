/**
 * maiden.js - speak to Sword Maiden, the blind high priestess of The Heroes.
 *
 *   <prefix>maiden <anything>    talk to her - AI powered (Groq first, the
 *                                OpenRouter key as backup, exactly the way
 *                                Echidna and the companions route their voices,
 *                                see lib/ai.js), in character, and fully aware
 *                                of her holder's live state (name, level,
 *                                purse, health, equipped character, whether a
 *                                fight is happening right now, and how many
 *                                spins she took: see lib/maiden-persona.js)
 *   <prefix>maiden               her card (mood, ownership, her commands)
 *   <prefix>maiden hug           a soft moment that costs no API call
 *   <prefix>maiden lap           same, with your head in her lap
 *   <prefix>maiden headpat       same, her hand warm on your head
 *   <prefix>maiden forget        let the conversation rest: clears the thread
 *                                she remembers and starts the next one fresh
 *
 * Ownership rules. Her voice belongs to the holder of the exclusive, the one
 * player bot-wide who won the sword-spin, i.e. ownedCharacters includes
 * sword_maiden. Everyone else gets a static, in-character dismissal and never
 * triggers an API call, a scene change, or a write. The bot owner is let
 * through the chat door so her voice can be tested live without holding her,
 * the same courtesy plugins/echidna.js extends for the same reason.
 *
 * Her speech rule (lowercase, no punctuation, no contractions, no emoji) is
 * asked for in data/maiden-personality.json AND enforced on the way out by
 * softenMaidenReply(), so a model that slips still reads like her. Her card is
 * deliberately NOT in BATTLE_ALLOWED_COMMANDS: like Echidna's hub command,
 * conversation is not a battle action, and mid-fight is not the moment.
 *
 * A note on her temper, for whoever edits her next: she is the soft ara ara
 * mother. Her boundaries in the personality file keep her tasteful and
 * non-explicit, and keep a real person in real distress pointed at a real
 * person they trust. Those rules are load bearing rather than decorative. Do
 * not loosen them to chase a spicier voice.
 */
import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { updatePlayer } from '../lib/player-repo.js'
import { askAI, hasAIKey } from '../lib/ai.js'
import { characterMap } from '../lib/game-data.js'
import { BANNERS } from '../lib/witch-heroes.js'
import {
  SWORD_MAIDEN_ID,
  ownsSwordMaiden,
  renderMaidenSystemPrompt,
  softenMaidenReply,
  maidenChatHistory,
  rememberMaidenTurn,
  forgetMaidenChat,
} from '../lib/maiden-persona.js'

const RULE = '━━━━━━━━━━━━━━━━━━━━'

/** The longest message of theirs she will read in one turn. */
const MAX_MESSAGE_CHARS = 600

/**
 * Static dismissals for everyone she does not belong to. She is blind, calm,
 * and completely uninterested in strangers, so the refusal is short and never
 * contains a hint that a real conversation was on offer. Her quoted words
 * follow her own speech rule: lowercase, no punctuation at all.
 */
const STRANGER_LINES = [
  `⚔️ _she tilts her blindfolded face toward your voice, listens for one second, and turns away again_ "you are not the one i am kept by child i have only two arms and both of them are already full"`,
  `⚔️ _"there is one of me and one of them so go on softly now i am waiting for mine" _She goes back to the window and does not listen to you again._`,
  `⚔️ _she smiles kindly at nothing at all, and it is somehow worse than being ignored_ "not you my dear i am spoken for in every way that matters"`,
]

/**
 * What she says when there is no AI key, when both providers fail, or when
 * nothing speakable survived her voice rules. Still her, still warm, never a
 * status code and never a technical word.
 */
const QUIET_LINE =
  `⚔️ _she goes still for a moment, listening to something far away, and then reaches out for you anyway_\n\n` +
  `"ara ara come here my dear i lost the thread for a moment but i have you now tell mommy again"`

/**
 * Soft moments. No API call, no cost, no cooldown: three touches of the
 * character that work even with every provider down. Narration first (bot
 * voice), then her words (her voice rule applies).
 */
const SCENES = {
  hug: [
    `🫂 _she finds you without looking. one arm comes around your back, the other settles your head against the soft wool of her cloak, and the whole room quietly gets slower._`,
    `"ara ara come here this instant my sweet child let mommy hold you properly you have been standing up straight all day and i can hear every bit of it"`,
  ].join('\n\n'),
  lap: [
    `🌸 _she sits, and pats her own thigh once, unhurried, as if the place had been kept warm for you since morning._`,
    `"ara ara lie down my precious one and rest your head here while i stroke your hair tell mommy nothing at all if you do not want to"`,
  ].join('\n\n'),
  headpat: [
    `🤍 _her hand finds the top of your head without a single miss and settles there, warm and certain, the way it has a thousand times._`,
    `"ara ara such a good child you have done enough for today my dear let mommy be proud of you out loud for a while"`,
  ].join('\n\n'),
}

const SCENE_WORDS = new Set(Object.keys(SCENES))
const FORGET_WORDS = new Set(['forget', 'reset'])
const CARD_WORDS = new Set(['status', 'info', 'help', 'card'])

/** Her card's daily mood, stable for a player within a day, like Echidna's. */
const MOODS = [
  `🤍 tender, she has already decided that today is for spoiling you`,
  `🌸 quietly playful, she intends to tease you until you turn red`,
  `🌙 sleepy, she wants you close and does not need you to say a single word`,
]

function moodOf(player, now = Date.now()) {
  const idx = (Math.floor(now / 86_400_000) + (player?.name?.length ?? 0)) % MOODS.length
  return MOODS[idx]
}

/** The chat door: her holder, and the bot owner for live testing. */
function canSpeak(ctx) {
  return ownsSwordMaiden(ctx.player) || isOwnerJid(ctx.from)
}

function dismissal(ctx) {
  return STRANGER_LINES[(ctx.from?.length ?? 0) % STRANGER_LINES.length]
}

async function runStatus(ctx) {
  const p = ctx.prefix ?? config.prefix
  const character = characterMap[SWORD_MAIDEN_ID]
  const owns = ownsSwordMaiden(ctx.player)
  const equipped = ctx.player?.equippedCharacter === SWORD_MAIDEN_ID
  const spins = Math.floor(Number(ctx.player?.swordMaidenSpins) || 0)
  const cost = BANNERS[SWORD_MAIDEN_ID]?.cost ?? 1
  const remembered = maidenChatHistory(ctx.player).filter(turn => turn.role === 'user').length

  const lines = [
    `⚔️ *${String(character?.name ?? 'Sword Maiden').toUpperCase()}*`,
    RULE,
    owns
      ? (equipped
        ? `✅ _Yours, and standing at your side in every fight right now._`
        : `✅ _Yours, always. Carry her with you: *${p}character equip ${SWORD_MAIDEN_ID}*._`)
      : `🔒 _Not yours. One player bot-wide ever wins her: *${p}sword-spin*, ${cost} gem a spin._`,
    ``,
    `🎭 Today's mood: ${moodOf(ctx.player)}`,
    `⚔️ Battle: *${p}sword* draws her five techniques, charge and MP read on *${p}ss*.`,
    `💬 Speak with her: *${p}maiden <message>*${owns ? '' : ` _(hers alone)_`}`,
    `🧸 Ask for a soft moment: *${p}maiden hug* · *${p}maiden lap* · *${p}maiden headpat*`,
    spins > 0 ? `🎡 She came home on spin *${spins}*. _She remembers every single one of them._` : null,
    remembered > 0 ? `🗂️ _She is still holding your last *${remembered}* messages and the way you said them._` : null,
    owns ? `` : null,
    owns ? `💗 _Let the conversation rest: *${p}maiden forget*_` : null,
  ]

  return ctx.reply(lines.filter(line => line !== null).join('\n'))
}

function runScene(ctx, scene) {
  if (!canSpeak(ctx)) return ctx.reply(dismissal(ctx))
  return ctx.reply(SCENES[scene])
}

async function runForget(ctx) {
  if (!canSpeak(ctx)) return ctx.reply(dismissal(ctx))

  let wiped = false
  try {
    await updatePlayer(ctx.db, ctx.from, (player) => {
      forgetMaidenChat(player)
      wiped = true
    })
  } catch {
    // Her memory is the only thing lost here, and the reply still goes out.
  }

  return ctx.reply(
    `⚔️ _she does not ask why. she simply lets the thread go, the way she lets a bad dream go at the door._\n\n` +
    (wiped
      ? `"ara ara then we begin again from here my dear come and sit with me"`
      : `"ara ara i have already forgotten it my dear come and sit with me"`),
  )
}

async function runChat(ctx, text) {
  // The AI voice belongs to the holder of the exclusive; the bot owner is let
  // through so her voice can be tested live without holding her. Scenes and
  // forget share this same door through canSpeak().
  if (!canSpeak(ctx)) return ctx.reply(dismissal(ctx))

  const message = String(text ?? '').trim().slice(0, MAX_MESSAGE_CHARS)
  if (!message) return runStatus(ctx)
  if (!hasAIKey()) return ctx.reply(QUIET_LINE)

  let answer = ''
  try {
    const { text: raw } = await askAI({
      system: renderMaidenSystemPrompt(ctx.player),
      messages: [...maidenChatHistory(ctx.player), { role: 'user', content: message }],
      temperature: 0.95,
      maxTokens: 400,
    })
    answer = softenMaidenReply(raw)
  } catch {
    // Provider diagnostics are logged by the shared client, never spoken aloud.
    answer = ''
  }
  if (!answer) return ctx.reply(QUIET_LINE)

  // The network call happens OUTSIDE updatePlayer so a slow reply never holds
  // the save lane: the exchange is written back only once it exists, exactly
  // how plugins/companion.js treats its own chat memory.
  try {
    await updatePlayer(ctx.db, ctx.from, (player) => {
      rememberMaidenTurn(player, message, answer)
    })
  } catch {
    // A missing record costs her the memory of this turn, not the reply.
  }

  return ctx.reply(answer)
}

export default {
  name: 'maiden',
  aliases: ['sword-maiden', 'swordmaiden', 'sword_maiden'],
  category: 'character',
  requiresPlayer: true,
  description: `${config.prefix}maiden <message>: talk to Sword Maiden, the blind sword of The Heroes (holder only). Subcommands: hug, lap, headpat, forget, status`,
  subcommands: [
    { cmd: '<message>', desc: 'say something to her' },
    { cmd: 'hug|lap|headpat', desc: 'a soft moment, no waiting' },
    { cmd: 'forget', desc: 'let the conversation rest' },
  ],

  async run(ctx) {
    // Subcommands only fire when the WHOLE message is the subcommand. A
    // sentence that merely starts with one ("hug me mommy i had a bad day")
    // is something they said to her, and belongs in her voice, not in a card
    // or a canned scene.
    const whole = String(ctx.args.join(' ')).trim().toLowerCase()

    if (!whole) return runStatus(ctx)
    if (CARD_WORDS.has(whole)) return runStatus(ctx)
    if (FORGET_WORDS.has(whole)) return runForget(ctx)
    if (SCENE_WORDS.has(whole)) return runScene(ctx, whole)

    return runChat(ctx, ctx.args.join(' ').trim())
  },
}
