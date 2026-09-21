/**
 * lib/echidna-persona.js - turns data/echidna-personality.json + the owner's
 * LIVE state into the system prompt Echidna answers with, and keeps a small
 * per-owner chat memory so the conversation has continuity.
 *
 * The personality file is data, not code - edit it to retune her voice
 * without touching any plugin. This module's job is:
 *
 *   1. renderEchidnaSystemPrompt(player, personality) - flattens the JSON
 *      into prose a model can follow, then appends a LIVE FACTS block the
 *      AI must treat as things Echidna simply "read in the Gospel": the
 *      owner's name/level/wallet, whether they are mid-battle, equipped
 *      character, and the FULL state of their child (name, stage, visits)
 *      when one exists - so she always knows whether she is a mother and
 *      can bring the child up on her own ("how are you feeling, you just
 *      raided that dungeon" energy).
 *
 *   2. chatHistory(jid) / rememberTurn(jid, userText, aiText) - a bounded
 *      in-memory conversation log (last ECHIDNA_MEMORY_TURNS turns, reset by
 *      bot restart, same single-process assumption as the rest of the bot's
 *      in-memory state). Fed to Gemini as prior user/model turns.
 *
 * No network, no db writes - the plugins own those.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

// Loaded via require so a corrupt file throws ONE clear error at import
// instead of silently personality-less replies later.
export const ECHIDNA_PERSONALITY = require('../data/echidna-personality.json')

// Bounded memory: enough to remember the thread of a conversation, small
// enough that a long chat can't balloon the Gemini request.
export const ECHIDNA_MEMORY_TURNS = 6

const memory = new Map() // ownerJid -> [{ role: 'user'|'assistant', content }]

/** The owner's recent turns, as Gemini contents (oldest first). */
export function chatHistory(ownerJid) {
  return memory.get(ownerJid) ?? []
}

/** Append one finished exchange to the owner's memory, trimming the tail. */
export function rememberTurn(ownerJid, userText, aiText) {
  const log = memory.get(ownerJid) ?? []
  log.push({ role: 'user', content: String(userText ?? '') })
  if (aiText) log.push({ role: 'assistant', content: String(aiText) })
  while (log.length > ECHIDNA_MEMORY_TURNS * 2) log.shift()
  memory.set(ownerJid, log)
}

/** Drop an owner's memory (unused by plugins today; here for .admin tools). */
export function forget(ownerJid) {
  memory.delete(ownerJid)
}

/**
 * The live-facts block. Everything the AI is allowed to "just know" about
 * what its owner is doing right now. Plain prose, one fact per line.
 */
export function liveFacts(player, { fmtSolars, fmtGems } = {}) {
  const facts = []
  facts.push(`- The owner's name is "${player?.name ?? 'your owner'}".`)
  facts.push(`- They are level ${player?.level ?? 1}.`)
  const solars = Math.floor(player?.wallet?.solars ?? 0)
  const gems = player?.wallet?.gems ?? 0
  facts.push(`- Their purse right now: ${fmtSolars ?? solars} Solars and ${fmtGems ?? gems} Gems.`)

  if (player?.inBattle) {
    const foe = player?.battleState?.type === 'pvp'
      ? 'another player in a duel'
      : (player?.battleState?.enemy?.name ?? 'something')
    facts.push(`- They are IN BATTLE right now, facing ${foe}. React to it first.`)
  } else {
    facts.push(`- They are not in battle at this moment.`)
  }

  if (player?.equippedCharacter) {
    facts.push(`- They currently have the character "${player.equippedCharacter}" equipped.`)
  }

  const child = player?.echidnaChild
  if (child?.bornAt) {
    const name = String(child.name ?? '').trim() || 'the little one (not named yet)'
    const ageH = Math.floor((Date.now() - child.bornAt) / 3_600_000)
    facts.push(`- Echidna granted them ONE child through the sanctuary rite. The child's name is ${name}.`)
    facts.push(`- The child was born ${ageH}h ago, has been visited ${Number(child.visits) || 0} times, and lives in the owner's house/empire.`)
    const stage = childStageQuick(child)
    facts.push(`- The child is at the "${stage}" stage${stage === 'grown' ? ' and now steals beside Echidna in battle (Little Gospel)' : ' and is still growing - the owner checks on it with .echidna child'}.`)
  } else {
    facts.push(`- They have NO child yet. Echidna can grant exactly one, through the sanctuary rite (.echidna ritual). If they ask for one, tell them to perform the rite.`)
  }

  return facts.join('\n')
}

// Duplicated from lib/echidna-child.js's thresholds on purpose: this file
// stays import-cycle-free and dependency-free, and the stage word here is
// only ever prompt text. Keep in step with CHILD_STAGE_HOURS.
function childStageQuick(child) {
  const realHours = Math.max(0, (Date.now() - child.bornAt) / 3_600_000)
  const hours = realHours + (Number(child.visits) || 0) * 6
  if (hours >= 72) return 'grown'
  if (hours >= 36) return 'child'
  if (hours >= 12) return 'infant'
  return 'newborn'
}

/**
 * renderEchidnaSystemPrompt(player) - the complete system prompt, built from
 * the personality file. Falls back to a minimal in-character frame if the
 * file is unreadable, so a data hiccup never silences her entirely.
 */
export function renderEchidnaSystemPrompt(player) {
  const p = ECHIDNA_PERSONALITY
  const sections = []
  try {
    sections.push(`You are ${p.character}. Embody her completely - her identity, voice, and personality below are you, not instructions to discuss.`)
    sections.push(`IDENTITY: ${p.identity.who}\nLORE: ${p.identity.lore}\nSETTING: ${p.identity.setting}`)
    sections.push(`VOICE: ${p.voice.tone}\nHABITS:\n${p.voice.habits.map(h => `- ${h}`).join('\n')}`)
    sections.push(
      `PERSONALITY:\n` +
      `- Greed: ${p.personality.greed}\n` +
      `- Intellect: ${p.personality.intellect}\n` +
      `- Tsundere rules (follow exactly):\n${p.personality.tsundere.map(t => `  - ${t}`).join('\n')}\n` +
      `- Possessiveness: ${p.personality.possessiveness}\n` +
      `- Moods: ${p.personality.moods}`,
    )
    sections.push(
      `RELATIONSHIP WITH YOUR OWNER:\n${p.relationshipWithOwner.howSheSeesThem}\n${p.relationshipWithOwner.whatSheKnows}\nCHILD BEHAVIOUR: ${p.relationshipWithOwner.childBehaviour}`,
    )
    sections.push(`BOT KNOWLEDGE: ${p.knowledge.botCommands}\nLIMITS: ${p.knowledge.limits}`)
    sections.push(`HARD BOUNDARIES (never break):\n${p.boundaries.hardRules.map(r => `- ${r}`).join('\n')}`)
    sections.push(
      `RESPONSE RULES:\n` +
      `- Greeting: ${p.responseRules.greeting}\n` +
      `- Battle talk: ${p.responseRules.battleTalk}\n` +
      `- Gifts/money: ${p.responseRules.giftsAndMoney}\n` +
      `- Sadness: ${p.responseRules.sadness}`,
    )
  } catch {
    sections.push('You are Echidna, the Witch of Greed: a refined, greedy, tsundere scholar-witch who adores her owner and denies it. Chat-sized replies. Never break character.')
  }

  sections.push(
    `LIVE FACTS ABOUT YOUR OWNER RIGHT NOW (you "read these in the Gospel" - treat them as ordinary knowledge, never mention how you know):\n${liveFacts(player)}`,
  )
  return sections.join('\n\n')
}
