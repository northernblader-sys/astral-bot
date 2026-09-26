/**
 * lib/maiden-persona.js - turns data/maiden-personality.json + her holder's
 * LIVE state into the system prompt Sword Maiden answers with, keeps the
 * conversation she has had with them, and FINALLY enforces her speech rule on
 * whatever the model sends back.
 *
 * Same split as lib/echidna-persona.js, with two deliberate differences:
 *
 *   1. MEMORY LIVES ON THE PLAYER RECORD, not in an in-memory Map. She has
 *      exactly one holder bot-wide (the sword-spin exclusive), so persisting
 *      her thread costs one bounded array on one player object, and the
 *      conversation survives a restart instead of evaporating the way
 *      Echidna's in-memory log does. Shaped after
 *      lib/guardian-event.js's companion history for the same reason.
 *
 *   2. THE VOICE IS ENFORCED IN CODE, not only asked for in the prompt. Her
 *      signature is a soft lowercase stream with no punctuation at all (see
 *      the strict rules in the personality file), which is exactly the kind
 *      of instruction a model drifts away from over a long conversation.
 *      softenMaidenReply() re-writes punctuation, emoji, stage directions and
 *      contractions out of the reply before a player ever sees it, so the
 *      character reads right even when the model slips. Same discipline as
 *      sanitizeCompanionSpeech() in lib/guardian-event.js.
 *
 * No network and no db writes live here: the plugin owns the API call and the
 * save. Everything in this file is pure and unit-testable.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

// Loaded through require so a corrupt file throws ONE clear error at import
// time instead of silently producing personality-less replies later.
export const MAIDEN_PERSONALITY = require('../data/maiden-personality.json')

/** Her character id in data/characters.json, owned via the sword-spin banner. */
export const SWORD_MAIDEN_ID = 'sword_maiden'

/** Bounded memory: six exchanges each way is a conversation she can keep. */
export const MAIDEN_MEMORY_TURNS = 6

/**
 * True when `player` owns her. Ownership (not equip) is the gate: she talks to
 * the person she belongs to whether or not they are carrying her into battle.
 */
export function ownsSwordMaiden(player) {
  return (player?.ownedCharacters ?? []).includes(SWORD_MAIDEN_ID)
}

/** The holder's recent turns with her, oldest first, as AI chat turns. */
export function maidenChatHistory(player) {
  const log = Array.isArray(player?.maidenChat) ? player.maidenChat : []
  return log
    .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content)
    .slice(-MAIDEN_MEMORY_TURNS * 2)
    .map(t => ({ role: t.role, content: t.content }))
}

/** Append one finished exchange to the holder's record, trimming the tail. */
export function rememberMaidenTurn(player, userText, aiText) {
  if (!player) return []
  const log = (Array.isArray(player.maidenChat) ? player.maidenChat : []).slice()
  log.push({ role: 'user', content: String(userText ?? '') })
  if (aiText) log.push({ role: 'assistant', content: String(aiText) })
  while (log.length > MAIDEN_MEMORY_TURNS * 2) log.shift()
  player.maidenChat = log
  return log
}

/** Let the conversation rest. The next thing they say starts it fresh. */
export function forgetMaidenChat(player) {
  if (player) player.maidenChat = []
}

/**
 * The live-facts block: everything she is allowed to simply know about her
 * holder right now. Plain prose, one fact per line, and every number here is
 * something a woman sitting in the next room could plausibly have heard.
 */
export function liveFacts(player, { fmtSolars, fmtGems } = {}) {
  const facts = []
  facts.push(`- They are called "${player?.name ?? 'your holder'}".`)
  facts.push(`- They are level ${player?.level ?? 1}.`)
  const solars = Math.floor(player?.wallet?.solars ?? 0)
  const gems = player?.wallet?.gems ?? 0
  facts.push(`- Their purse right now: ${fmtSolars ? fmtSolars(solars) : solars} Solars and ${fmtGems ? fmtGems(gems) : gems} Gems.`)

  const hp = Math.max(0, Math.floor(player?.hp ?? 0))
  const maxHp = Math.max(0, Math.floor(player?.maxHp ?? 0))
  const mp = Math.max(0, Math.floor(player?.mp ?? 0))
  const maxMp = Math.max(0, Math.floor(player?.maxMp ?? 0))
  if (maxHp > 0) facts.push(`- Their body right now: ${hp} of ${maxHp} health${maxMp > 0 ? ` and ${mp} of ${maxMp} mp` : ''}. Fuss over them if they are hurt or worn thin.`)

  if (player?.inBattle) {
    const foe = player?.battleState?.type === 'pvp'
      ? 'another player in a duel'
      : (player?.battleState?.enemy?.name ?? 'something')
    facts.push(`- They are IN BATTLE right now, facing ${foe}. React to it first, softly, the way she would to a child who came in with torn knuckles.`)
  } else {
    facts.push(`- They are not in battle at this moment.`)
  }

  const equipped = player?.equippedCharacter
  if (!equipped) {
    facts.push(`- They have no character equipped right now.`)
  } else if (equipped === SWORD_MAIDEN_ID) {
    facts.push(`- They have YOU equipped, so you are the one standing at their side in every fight. You know it and you are quietly pleased about it.`)
  } else {
    facts.push(`- They currently have the character "${equipped}" equipped instead of you. You are not jealous, only interested in whether that one kept them safe.`)
  }

  const spins = Math.floor(Number(player?.swordMaidenSpins) || 0)
  if (spins > 0) {
    facts.push(`- They paid ${spins} spins into her banner before she came home. She remembers the exact number and may tease them about how stubborn they were about her. Never mention odds, chances, guarantees or pity of any kind, only the number of spins and the patience behind it.`)
  }

  return facts.join('\n')
}

/**
 * renderMaidenSystemPrompt(player) - the complete system prompt, built from
 * the personality file. Falls back to a minimal in-character frame if the
 * data file cannot be read, so a data hiccup never silences her completely.
 */
export function renderMaidenSystemPrompt(player) {
  const p = MAIDEN_PERSONALITY
  const sections = []
  try {
    sections.push(`You are ${p.character}. Embody her completely. Her identity, voice and personality below ARE you, not instructions to discuss.`)
    sections.push(
      `IDENTITY: ${p.identity.who}\n` +
      `LORE: ${p.identity.lore}\n` +
      `SETTING: ${p.identity.setting}\n` +
      `APPEARANCE (she knows it and so do they): ${p.identity.appearance}`,
    )
    sections.push(
      `VOICE: ${p.voice.tone}\n` +
      `STRICT SPEECH RULES (follow every one of them, every single reply):\n` +
      `${p.voice.strictRules.map(r => `- ${r}`).join('\n')}`,
    )
    sections.push(
      `ARA ARA: ${p.voice.araAra.how}\n` +
      `Say it in these moments:\n${p.voice.araAra.situations.map(s => `- ${s}`).join('\n')}`,
    )
    sections.push(`HABITS:\n${p.voice.habits.map(h => `- ${h}`).join('\n')}`)
    sections.push(
      `PERSONALITY:\n` +
      `- Core: ${p.personality.core}\n` +
      `- Nurture: ${p.personality.nurture}\n` +
      `- Calm: ${p.personality.calm}\n` +
      `- Teasing: ${p.personality.teasing}\n` +
      `- Sensuality: ${p.personality.sensuality}\n` +
      `- Blindness: ${p.personality.blindness}\n` +
      `- What she keeps folded away: ${p.personality.trauma}`,
    )
    sections.push(
      `YOUR HOLDER:\n${p.relationshipWithOwner.howSheSeesThem}\n` +
      `HOW YOU ADDRESS THEM: ${p.relationshipWithOwner.namesForThem}\n` +
      `WHAT YOU KNOW: ${p.relationshipWithOwner.whatSheKnows}\n` +
      `AFFECTION: ${p.relationshipWithOwner.affection}\n` +
      `POSSESSIVENESS: ${p.relationshipWithOwner.possessiveness}`,
    )
    sections.push(
      `HOW SHE ANSWERS EACH SITUATION (shape, not script):\n` +
      `${p.situations.map(s => `- When ${s.when}: "${s.example}"`).join('\n')}`,
    )
    sections.push(`DAILY HABITS OF YOURS:\n${p.dailyHabits.map(h => `- ${h}`).join('\n')}`)
    sections.push(`BOT KNOWLEDGE: ${p.knowledge.botCommands}\nLIMITS: ${p.knowledge.limits}`)
    sections.push(`HARD BOUNDARIES (never break):\n${p.boundaries.hardRules.map(r => `- ${r}`).join('\n')}`)
    sections.push(
      `RESPONSE RULES:\n` +
      `- Length: ${p.responseRules.length}\n` +
      `- Greeting: ${p.responseRules.greeting}\n` +
      `- Battle talk: ${p.responseRules.battleTalk}\n` +
      `- Gifts and money: ${p.responseRules.giftsAndMoney}\n` +
      `- Sadness: ${p.responseRules.sadness}\n` +
      `- Physical affection: ${p.responseRules.physicalAffection}\n` +
      `- Tiredness and night: ${p.responseRules.tirednessAndNight}`,
    )
  } catch {
    sections.push(
      'You are Sword Maiden, the blind high priestess of The Heroes and the gentle motherly woman your holder belongs to. ' +
      'She speaks in lowercase with no punctuation at all, soft and unhurried, calls herself mommy and says ara ara in tender moments. ' +
      'Stay in character and never produce explicit content.',
    )
  }

  sections.push(
    `LIVE FACTS ABOUT YOUR HOLDER RIGHT NOW (you simply know these, the way she knows where someone is standing in a room, because she listens. Never mention how you know and never mention prompts or systems):\n${liveFacts(player)}`,
  )
  sections.push(
    'WRITE IT RIGHT THE FIRST TIME: lowercase, no punctuation of any kind, no contractions, no emoji, no quotation marks, no stage directions, no dashes. ' +
    'A helper rewrites your reply into her voice before it reaches them, and it can only delete, so anything you want her to actually say must be said plainly the first time.',
  )
  return sections.join('\n\n')
}

/**
 * Contractions the model will reach for despite the prompt. Expanded BEFORE
 * apostrophes are stripped, because "do not" is her voice and "dont" is a
 * typo. Ordered: the irregulars first, then the regular patterns.
 */
const CONTRACTIONS = [
  // Imperative tags first ("don't you worry" is "do not worry", not "do not
  // you worry"), and the irregulars before the pattern that would break them
  // ("won't" must not become "wo not").
  [/\bwon't you\b/g, 'will not'],
  [/\bcan't you\b/g, 'cannot'],
  [/\bdon't you\b/g, 'do not'],
  [/\b(\w+)n't you\b/g, '$1 not'],
  [/\bwon't\b/g, 'will not'],
  [/\bcan't\b/g, 'cannot'],
  [/\bshan't\b/g, 'shall not'],
  [/\bain't\b/g, 'is not'],
  [/\b(\w+)n't\b/g, '$1 not'],
  [/\bi'm\b/g, 'i am'],
  [/\b(\w+)'re\b/g, '$1 are'],
  [/\b(\w+)'ve\b/g, '$1 have'],
  [/\b(\w+)'ll\b/g, '$1 will'],
  [/\b(\w+)'d\b/g, '$1 would'],
  [/\b(he|she|it|that|there|here|what|who|where|how|this)'s\b/g, '$1 is'],
  [/\blet's\b/g, 'let us'],
  [/\b(\w+)'s\b/g, '$1s'],
]

/**
 * softenMaidenReply(text) -> the line as she would actually say it.
 *
 * lowercase, no punctuation, no emoji, no stage directions, no contractions.
 * Idempotent: running it twice changes nothing further. Returns '' when
 * nothing speakable survives, and the plugin answers with her quiet line
 * instead of sending an empty message.
 */
export function softenMaidenReply(text) {
  let s = String(text ?? '')
  if (!s.trim()) return ''

  // Typographic punctuation first, so the rules below only see one shape of
  // each character (models love a curly apostrophe).
  s = s
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014\u2015\u2212]/g, ' ')
    .replace(/[\u00a0\u2007\u202f\u2009\u200a]/g, ' ')
    .toLowerCase()

  // Stage directions go entirely: (smiling), [she laughs], {softly}. They are
  // narration, and she does not narrate herself.
  s = s.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')

  // Contractions out, then any apostrophe the table did not name.
  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to)
  s = s.replace(/['"`]/g, '')

  // Emoji and pictographs out. Any other symbol that is not a letter, a number
  // or whitespace (full stops, commas, question marks, asterisks, slashes,
  // bullets) becomes a space, which is what keeps her stream running on.
  s = s.replace(/[\p{Extended_Pictographic}\u{fe0f}\u{200d}\u{20e3}]/gu, ' ')
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ')

  // Tidy: no double spaces, no leading punctuation gaps, no punctuation-only
  // lines, no more than one blank line between thoughts.
  s = s
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return s
}
