/**
 * <prefix>companion — your Guardian of the Innocent companion.
 *
 *   .companion                   her card: perk, bond, story progress
 *   .companion talk <message>    talk to her (AI, OpenRouter via lib/openrouter.js)
 *   .companion <message>         same as talk
 *   .companion story [n]         the chapters of her past she has told you
 *   .companion accept|reject     answer a freed companion's request
 *
 * Companions speak in lowercase with no punctuation and no emoji. The model is
 * told so in renderCompanionSystemPrompt() and sanitizeCompanionSpeech() then
 * enforces it on whatever comes back, so a model that slips still reads right.
 *
 * The network call is made OUTSIDE updatePlayer, so a slow reply never holds
 * the save queue. The turn is written back afterwards.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { askAI } from '../lib/openrouter.js'
import {
  COMPANION_MAP, TYPE_BADGE, ensureGuardianState, playerCompanion, companionStoryChapters,
  renderCompanionSystemPrompt, sanitizeCompanionSpeech, companionChatHistory,
  rememberCompanionTurn, recordCompanionTalk, acceptOffer, rejectOffer, expireOffer,
} from '../lib/guardian-event.js'
import { RULE, replyOverImage, companionCardText } from '../lib/guardian-ui.js'

const NO_COMPANION = (p) =>
  `🕊️ *You have no companion.*\n_Free enough captives in one of the ${'*Guardian of the Innocent*'} locations and whoever is held there may ask to come with you. See *${p}guardian*._`

// Short, in-character fallbacks for when the model cannot be reached. Same
// style rules as everything else a companion says.
const OFFLINE = {
  lebore: 'sorry i lost count of what i was saying give me a moment',
  minna: 'not now someone is watching the road',
  rune_lica: 'rune is signing something and lica is laughing too hard to translate it',
  yenisei: 'she looks at you and nods very small',
  tenma: 'hold that thought darling my voice needs a moment',
}

async function runTalk(ctx, text) {
  const p = config.prefix
  const c = playerCompanion(ctx.player)
  if (!c) return ctx.reply(NO_COMPANION(p))
  const msg = String(text ?? '').trim().slice(0, 500)
  if (!msg) return ctx.reply(`💬 Say something: *${p}companion talk <message>*`)
  if (!config.openrouterApiKey) return ctx.reply(`💬 *${c.name}:* ${OFFLINE[c.id] ?? '...'}`)

  const history = companionChatHistory(ctx.player)
  let answer = ''
  try {
    const res = await askAI({
      system: renderCompanionSystemPrompt(c, ctx.player, ctx.db),
      messages: [...history, { role: 'user', content: msg }],
      temperature: c.id === 'yenisei' ? 0.8 : 0.95,
      maxTokens: 300,
    })
    answer = sanitizeCompanionSpeech(res.text)
  } catch {
    answer = ''
  }
  if (!answer) return ctx.reply(`💬 *${c.name}:* ${OFFLINE[c.id] ?? 'give me a moment'}`)

  let bond = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    if (player.guardian?.companion !== c.id) return
    rememberCompanionTurn(player, msg, answer)
    bond = recordCompanionTalk(player)
  })

  const label = c.id === 'yenisei' ? 'trust' : 'bond'
  const unlockedNow = bond?.gained && c.storyUnlocks?.includes(bond.trust)
  return ctx.reply(
    `💬 *${c.name}:* ${answer}` +
    (unlockedNow ? `\n\n📖 _${c.name} trusts you enough to tell you a little more. *${p}companion story*_` : '') +
    (bond?.gained && [10, 25, 50].includes(bond.trust) && c.id === 'yenisei'
      ? `\n✨ _Her ${label} reached *${bond.trust}*. ${bond.trust === 10 ? 'She will tend your wounds after fights now.' : bond.trust === 25 ? 'She tells people what you did. Rescue fame +25%.' : 'She would step in front of a killing blow for you now.'}_`
      : ''),
  )
}

function storyText(ctx, n) {
  const p = config.prefix
  const c = playerCompanion(ctx.player)
  if (!c) return NO_COMPANION(p)
  const known = companionStoryChapters(c, ctx.player)
  if (known <= 0) return `📖 _${c.name} has not told you anything yet. Talk to ${c.pronoun === 'they' ? 'them' : 'her'}._`
  const idx = Number.isInteger(n) && n >= 1 ? Math.min(n, known) : null
  const chapters = idx ? [[idx, c.backstory[idx - 1]]] : c.backstory.slice(0, known).map((t, i) => [i + 1, t])
  const nextAt = c.storyUnlocks?.[known]
  return [
    `📖 *${c.name.toUpperCase()}*`,
    RULE,
    ...chapters.map(([i, t]) => `*${i}.* _${t}_`).flatMap(l => [l, '']),
    known < c.backstory.length
      ? `_There is more. ${c.name} is not ready yet${nextAt != null ? ` (trust ${nextAt})` : ''}._`
      : `_That is all of it. You are the only one ${c.pronoun === 'they' ? 'they have' : 'she has'} ever told._`,
  ].join('\n')
}

async function answerOffer(ctx, accept) {
  const p = config.prefix
  let res = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    const now = Date.now()
    expireOffer(player, now)
    res = accept ? acceptOffer(ctx.db, player, ctx.from, now) : rejectOffer(player, now)
  })
  if (!res || res.reason === 'none') return ctx.reply(`🕊️ Nobody is waiting on an answer from you.`)
  const c = res.companion
  if (!res.ok) {
    if (res.reason === 'taken') return ctx.reply(`💔 _Someone else reached ${c.name} first._`)
    if (res.reason === 'has_one') return ctx.reply(`💞 You already have a companion.`)
    return ctx.reply(`⏳ _The request has lapsed._`)
  }
  if (accept) {
    return replyOverImage(ctx, c.image,
      `💞 *${c.name.toUpperCase()} IS YOURS*\n${RULE}\n🗣️ _${c.accept}_\n\n✨ *${c.perk.name}:* ${c.perk.description}\n\n💬 *${p}companion talk <message>*`)
  }
  return ctx.reply(`🕊️ *You let ${c.name} go.*\n${RULE}\n🗣️ _${c.reject}_`)
}

export default {
  name: 'companion',
  aliases: ['comp', 'mycompanion'],
  category: 'event',
  requiresPlayer: true,
  description: 'Your Guardian of the Innocent companion: card, story, and talk to them',

  async run(ctx) {
    const p = config.prefix
    const args = ctx.args ?? []
    const sub = String(args[0] ?? '').toLowerCase()
    ensureGuardianState(ctx.player)

    if (sub === 'accept') return answerOffer(ctx, true)
    if (sub === 'reject') return answerOffer(ctx, false)
    if (sub === 'story' || sub === 'past' || sub === 'backstory') return ctx.reply(storyText(ctx, Number(args[1])))
    if (sub === 'talk' || sub === 'say' || sub === 'chat') return runTalk(ctx, args.slice(1).join(' '))

    const c = playerCompanion(ctx.player)
    if (!sub || sub === 'info' || sub === 'card') {
      if (!c) return ctx.reply(NO_COMPANION(p))
      return replyOverImage(ctx, c.image, companionCardText(c, ctx.player))
    }
    return runTalk(ctx, args.join(' '))
  },
}

export { storyText, OFFLINE, COMPANION_MAP, TYPE_BADGE }
