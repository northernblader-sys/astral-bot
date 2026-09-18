/**
 * story.js — Story Mode. Group-only interactive fiction volumes (see
 * lib/story-engine.js for progression logic, story/json-schema-spec.md
 * for the data shape, data/story-*.json for the actual volumes).
 *
 * Commands (run in the group):
 *   .story on/off           — owner or mod only. Story Mode is OFF by
 *                             default in every group (see storyEnabled in
 *                             lib/group-settings.js) — floods the chat with
 *                             sequential narrative messages, so a group has
 *                             to opt in before any of the commands below do
 *                             anything there. Checked before the admin-only
 *                             gate further down, so a regular member can see
 *                             the "Story Mode is off" reply without needing
 *                             admin rights themselves.
 *   .story-mode           — lists available volumes
 *   .story clear           — owner or mod only. Force-frees this group's
 *                            story slot regardless of who holds it — the
 *                            safety valve for when the 15-minute idle
 *                            sweep hasn't fired yet or shouldn't kick
 *                            anyone. Does not remove anyone from the group.
 *   .story enter <volume>  — enters a volume; plays the appreciation/credits
 *                            intro once per player per volume, then the
 *                            volume is ready to play via .story start
 *   .story start           — begins/resumes playing beats in the player's
 *                            current chapter for whichever volume they last
 *                            entered
 *
 * Delivery: beats are sent as separate sequential messages into the group
 * with a short delay between them (narrative pacing), never as one big
 * dump. Choice beats show numbered options and then STOP — the plugin does
 * not keep running after posting a choice. The player's next plain-text
 * message in the group (just "1", "2", or "3", no prefix) is intercepted by
 * the numeric-reply gate this file exports (wired into handler.js the same
 * way lib/pending-purchase.js's screenshot gate is), which resolves the
 * choice and then continues playing beats automatically from there. That
 * gate only fires in the ONE group where the player currently holds the
 * story slot (see hasPendingStoryChoice below) — a pending choice from a
 * different group, or from a group where Story Mode has since been turned
 * off, never hijacks a plain "1"/"2"/"3" typed anywhere else.
 */
import { config } from '../config.js'

/** Mirrors STORY_SLOT_TIMEOUT_MS in main.js — shown to players in storyGuide(). */
const STORY_IDLE_MINUTES = 15
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { storyVolumes } from '../lib/game-data.js'
import {
  getVolume,
  findVolumeByName,
  ensureStoryProgress,
  getChapter,
  getCurrentBeat,
  isLastBeatOfChapter,
  advanceBeat,
  recordChoice,
  choiceKeyFor,
  resolvePlea,
  resolveBattle,
  resolveBeatText,
  completeChapter,
  canStartChapter,
  getResolvedBeats,
  startDetourLock,
  checkDetourLock,
  clearDetourLock,
} from '../lib/story-engine.js'
import { isPremiumActive } from '../lib/premium.js'
import { sendButtons } from '../lib/interactive-buttons.js'
import { NOT_GROUP, NOT_ALLOWED } from '../lib/group-helpers.js'
import {
  getGroupSettings,
  saveGroupSettings,
  saveFailedMessage,
  isGroupOrBotOwnerOrMod,
  parseOnOff,
} from '../lib/group-settings.js'
import {
  claimStorySlot,
  touchStorySlot,
  releaseStorySlot,
  getStorySlot,
} from '../lib/moderation-state.js'

// Chapter-completion rewards. Flat per chapter for now — easy to tune later
// without touching story-engine.js's logic. 20 chapters x 5 gems = 100 gems
// for the whole volume, on top of the character/item/perk unlock chapter 20
// grants; the reward for reading is meant to be the story, not the gems.
const STORY_REWARDS = { gemsPerChapter: 5, xpPerChapter: 200 }

const BEAT_DELAY_MS = 4500
const INTRO_LINE_DELAY_MS = 3500

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Sends `text` as its own message in the group. Used for both intro lines
 * and beat text — every call is one bubble, per the "narrative, not one huge
 * message chunk" requirement. Splits on double-newline paragraph breaks
 * within a single beat is deliberately NOT done here — a beat's prose is
 * one continuous scene and stays one message; only the intro sequence and
 * beat-to-beat transitions get their own separate sends.
 */
async function sendLine(ctx, text) {
  await ctx.sock.sendMessage(ctx.sender, { text: String(text) }).catch(err =>
    ctx.logger?.warn?.({ err: err.message }, 'story.js: sendLine failed'))
}

/**
 * Sends a choice beat's options as tappable buttons (lib/interactive-buttons.js).
 * Button ids are the option's 1-based index as a string ("1", "2", "3"),
 * matching exactly what a typed numeric reply already produces.
 *
 * That id is only ONE of the shapes a tap can come back as, though: some
 * clients never send an interactiveResponseMessage at all and instead post
 * the button's *display text* as an ordinary message. resolveChoiceOption()
 * below is what makes both land on the same option, so this function does
 * not need to care which shape it gets.
 *
 * sendButtons hard-caps at 3 buttons (lib/interactive-buttons.js), which is
 * why choice beats are authored with 2-3 options — a 4th would be silently
 * dropped from the button row while still being pickable by typing, which
 * would read as a bug. The text fallback lists every option regardless.
 */
async function sendChoiceButtons(ctx, beat) {
  try {
    await sendButtons({ ...ctx, jid: ctx.sender }, {
      body: beat.text,
      buttons: beat.options.map((o, i) => ({ id: String(i + 1), label: stripQuotes(o.label) })),
    })
  } catch (err) {
    ctx.logger?.warn?.({ err: err.message }, 'story.js: sendButtons failed')
    return sendLine(ctx, renderChoiceAsText(beat))
  }
}

/** Option labels are authored with surrounding quotes; strip them for display. */
function stripQuotes(label) {
  return String(label ?? '').replace(/^"|"$/g, '')
}

/** "1, 2, or 3" / "1 or 2" — never hardcoded, since option counts vary. */
function optionNumberList(beat) {
  const n = beat.options?.length ?? 0
  if (n <= 1) return '1'
  const nums = Array.from({ length: n }, (_, i) => String(i + 1))
  return `${nums.slice(0, -1).join(', ')} or ${nums[n - 1]}`
}

/** Plain-text rendering of a choice beat, used as the button fallback and the re-prompt. */
function renderChoiceAsText(beat) {
  const optionLines = beat.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')
  return `${beat.text}\n\n${optionLines}\n\n_Reply with ${optionNumberList(beat)}._`
}

/**
 * Sends the volume's cover image (if it has one) as its own message, with
 * the title/book number/tagline as the caption. Falls back to a plain text
 * line if coverImage is missing, so volumes without art yet never break.
 */
async function sendCover(ctx, volume) {
  const caption =
    `📖 *${volume.volumeTitle}*\n` +
    `_${volume.title}_\n` +
    `Book ${volume.book} of the Astral saga.\n\n` +
    `"${volume.tagline}"`
  if (!volume.coverImage) {
    return sendLine(ctx, caption)
  }
  await ctx.sock.sendMessage(ctx.sender, { image: { url: volume.coverImage }, caption }).catch(err =>
    ctx.logger?.warn?.({ err: err.message }, 'story.js: sendCover failed, falling back to text'))
}

/**
 * The appreciation/credits intro — plays once per player per volume, the
 * first time they `.story enter` it. Opens with the cover image + title
 * card, then each remaining line as its own message, short delay between
 * them, exactly like the brief's example ("She is the one..." / 2s /
 * "...that is with me to find the thing..").
 */
async function playIntro(ctx, volume) {
  await sendCover(ctx, volume)
  await sleep(INTRO_LINE_DELAY_MS)

  const lines = [
    `Written for the Astral bot.`,
    `Coded and brought to life by the Astral dev team.`,
    `Special thanks to everyone who read this far before it existed.`,
    `— — —`,
    `She is the one who cannot fly.`,
    `And that is with me, to find the thing that will.`,
  ]
  for (const line of lines) {
    await sendLine(ctx, line)
    await sleep(INTRO_LINE_DELAY_MS)
  }
}

function formatPleaOrBattleFollowup(text) {
  return text ? `\n\n${text}` : ''
}

/**
 * Plays beats starting from the player's current position until it hits a
 * choice beat (stops and waits for the numeric reply) or the chapter ends
 * (grants rewards, reports completion, stops). Never plays past a single
 * chapter boundary in one call — completing a chapter always ends the
 * .story start invocation, even if the cooldown would otherwise allow
 * another chapter immediately, so the player gets a clear stopping point
 * and a clean rewards message rather than chapters blurring together.
 */
async function playFromCurrentPosition(ctx, volumeId) {
  const volume = getVolume(volumeId)
  if (!volume) { await releaseStorySlot(ctx.sender); return ctx.reply(`❌ That volume no longer exists.`) }

  let player = getPlayer(ctx.db, ctx.from)
  const progress = player.storyProgress?.volumes?.[volumeId]
  if (!progress) { await releaseStorySlot(ctx.sender); return ctx.reply(`You haven't entered *${volume.volumeTitle}* yet. Try *${config.prefix}story enter ${volume.volumeTitle}*.`) }
  if (progress.completed) { await releaseStorySlot(ctx.sender); return ctx.reply(`✅ You've already completed *${volume.volumeTitle}*. Nothing left to play here.`) }

  const detourLock = checkDetourLock(player, volumeId)
  if (detourLock.locked) {
    await releaseStorySlot(ctx.sender)
    const mins = Math.ceil((detourLock.retryAt - Date.now()) / 60000)
    const hrs = Math.floor(mins / 60)
    const remMins = mins % 60
    return ctx.reply(`💤 Not yet. Try again in *${hrs}h ${remMins}m*.`)
  }

  let resumeLine = null
  await updatePlayer(ctx.db, ctx.from, p => {
    resumeLine = clearDetourLock(p, volumeId)
  })
  if (resumeLine) {
    await sendLine(ctx, resumeLine)
    await sleep(BEAT_DELAY_MS)
    player = getPlayer(ctx.db, ctx.from)
  }

  const gate = canStartChapter(player, volumeId)
  if (!gate.allowed) {
    await releaseStorySlot(ctx.sender)
    if (gate.reason === 'cooldown') {
      const mins = Math.ceil((gate.retryAt - Date.now()) / 60000)
      const hrs = Math.floor(mins / 60)
      const remMins = mins % 60
      return ctx.reply(
        `⏳ *Next chapter isn't ready yet.*\n` +
        `You've used today's chapter${isPremiumActive(player) ? 's' : ''} (${isPremiumActive(player) ? '3/day with premium' : '1/day'}).\n` +
        `Try again in *${hrs}h ${remMins}m*.`,
      )
    }
    return ctx.reply(`This volume is finished for you.`)
  }

  const chapter = getChapter(volume, progress.currentChapter)
  if (!chapter) { await releaseStorySlot(ctx.sender); return ctx.reply(`❌ Chapter data missing for chapter ${progress.currentChapter}. Tell the bot owner.`) }
  const beats = getResolvedBeats(volume, player, volumeId, chapter)

  if (progress.currentBeat === 0) {
    await sendLine(ctx, `📖 *Chapter ${chapter.num}: ${chapter.title}*`)
    await sleep(BEAT_DELAY_MS)
  }

  let beatIndex = progress.currentBeat
  while (beatIndex < beats.length) {
    const beat = beats[beatIndex]

    if (beat.type === 'choice') {
      await sendChoiceButtons(ctx, beat)
      // Stop here. The numeric-reply gate (handleStoryChoiceReply) picks
      // this back up once the player answers — currentBeat has NOT been
      // advanced yet, so the gate knows exactly which choice beat this was.
      return
    }

    if (beat.type === 'plea') {
      const oddsLine = beat.stakes.scripted
        ? ''
        : `\n\n_Odds: ${Math.round(beat.stakes.chance * 100)}%._`
      await sendLine(ctx, `${beat.text}${oddsLine}`)
      await sleep(BEAT_DELAY_MS)
      const result = resolvePlea(beat)
      await sendLine(ctx, `${result.success ? '✅' : '❌'}${formatPleaOrBattleFollowup(result.text)}`)
    } else if (beat.type === 'battle') {
      const oddsLine = beat.encounter.onLose == null
        ? ''
        : `\n\n_Odds: 70%._`
      await sendLine(ctx, `${beat.text}${oddsLine}`)
      await sleep(BEAT_DELAY_MS)
      const result = resolveBattle(beat)
      await sendLine(ctx, `${result.success ? '✅' : '❌'}${formatPleaOrBattleFollowup(result.text)}`)
    } else {
      await sendLine(ctx, resolveBeatText(beat, player, volumeId, chapter.id))
    }

    const wasLastBeat = isLastBeatOfChapter(beats, beatIndex)

    if (wasLastBeat) {
      await finishChapter(ctx, volumeId, chapter)
      return
    }

    await sleep(BEAT_DELAY_MS)
    beatIndex += 1
    await updatePlayer(ctx.db, ctx.from, p => {
      advanceBeat(p, volumeId)
    })
  }
}

async function finishChapter(ctx, volumeId, chapter) {
  const volume = getVolume(volumeId)
  let summary = null
  await updatePlayer(ctx.db, ctx.from, p => {
    summary = completeChapter(p, volume, volumeId, chapter, STORY_REWARDS)
  })

  await sleep(BEAT_DELAY_MS)

  if (summary.isFinalChapter) {
    const oc = summary.volumeCompleteReward
    await sendLine(
      ctx,
      `🌤️ *${volume.volumeTitle}: Complete.*\n\n` +
      `You've unlocked *${oc.grantsCharacter ? oc.grantsCharacter[0].toUpperCase() + oc.grantsCharacter.slice(1) : 'a new character'}*.\n` +
      (oc.items?.length ? `Item${oc.items.length > 1 ? 's' : ''} received: ${oc.items.join(', ')}\n` : '') +
      (oc.flags?.length ? `Perks unlocked: ${oc.flags.join(', ')}\n` : '') +
      `\nThank you for reading.`,
    )
    // Volume finished — free the slot immediately rather than making the
    // next group member wait out a timeout that will never fire (this
    // player has nothing left to run .story start on).
    await releaseStorySlot(ctx.sender)
    return
  }

  const chapterRewardText =
    `✅ *Chapter ${chapter.num} complete.*\n` +
    `+${STORY_REWARDS.gemsPerChapter}💎  +${STORY_REWARDS.xpPerChapter} XP` +
    (summary.levelUpMsgs?.length ? `\n\n${summary.levelUpMsgs.join('\n')}` : '')

  await sendLine(ctx, chapterRewardText)

  await sleep(1200)
  const nextGate = canStartChapter(getPlayer(ctx.db, ctx.from), volumeId)
  if (nextGate.allowed) {
    await sendLine(ctx, `Chapter ${chapter.num + 1} is ready. Run *${config.prefix}story start* to continue.`)
  } else if (nextGate.reason === 'cooldown') {
    const mins = Math.ceil((nextGate.retryAt - Date.now()) / 60000)
    const hrs = Math.floor(mins / 60)
    const remMins = mins % 60
    await sendLine(ctx, `Next chapter unlocks in *${hrs}h ${remMins}m*. Run *${config.prefix}story start* then.`)
  }
}

/**
 * Handles a player's group reply while they have a pending choice beat.
 * Wired into handler.js the same way lib/pending-purchase.js's screenshot
 * gate is — must run before the normal command-prefix check, since a bare
 * "1" has no prefix at all.
 *
 * Returns true if this message WAS consumed as a choice reply (caller
 * should stop processing it as a normal message), false otherwise.
 *
 * IMPORTANT: whenever a choice IS pending, this returns true for ANY
 * prefixless text, even text it can't match to an option. That keeps a
 * player's stray or malformed reply from falling through to ordinary group
 * message handling mid-story — it gets consumed and re-prompted inside the
 * story instead, which keeps the conversation where the player actually is.
 * Prefixed commands never reach here at all (handler.js checks that first),
 * so this doesn't trap anyone out of `.story start`, `.profile`, or anything
 * else in the group.
 */

/** Lowercase, quote/punctuation-stripped, whitespace-collapsed form for matching. */
function normalizeChoiceText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Maps whatever the player actually sent onto one of the beat's options.
 * Accepts, in order of precedence:
 *   1. a 1-based number ("2", "2.", "#2") within the real option count
 *   2. the option's own id ("warm", "dry")
 *   3. the option's full label, with or without its authored quotes
 *   4. a single letter (a/b/c) matching the option's position
 *   5. a unique prefix or substring of exactly one label (>= 2 chars)
 * Returns the option object, or null if nothing matched unambiguously.
 *
 * Rule 3 is the one that fixes button taps on clients that post the
 * button's display text instead of a nativeFlowResponseMessage id. Rules
 * 1's upper bound is beat.options.length rather than a hardcoded 3, so a
 * choice beat is free to have 2 options (most of them do) without "3" being
 * accepted as a phantom pick.
 */
function resolveChoiceOption(beat, rawText) {
  const options = beat.options ?? []
  if (!options.length) return null
  const raw = String(rawText ?? '').trim()
  if (!raw) return null

  const numeric = raw.match(/^#?\s*(\d{1,2})\s*[.):]?$/)
  if (numeric) {
    const idx = Number(numeric[1])
    return idx >= 1 && idx <= options.length ? options[idx - 1] : null
  }

  const norm = normalizeChoiceText(raw)
  if (!norm) return null

  const byId = options.find(o => normalizeChoiceText(o.id) === norm)
  if (byId) return byId

  const byLabel = options.find(o => normalizeChoiceText(o.label) === norm)
  if (byLabel) return byLabel

  if (/^[a-z]$/.test(norm)) {
    const idx = norm.charCodeAt(0) - 96
    return idx >= 1 && idx <= options.length ? options[idx - 1] : null
  }

  if (norm.length >= 2) {
    const partial = options.filter(o => {
      const label = normalizeChoiceText(o.label)
      return label.startsWith(norm) || norm.startsWith(label) || label.includes(norm)
    })
    if (partial.length === 1) return partial[0]
  }

  return null
}

/**
 * The one place that answers "is this player sitting on a choice, and if so
 * which one" — shared by hasPendingStoryChoice (handler.js's cheap gate) and
 * handleStoryChoiceReply, so the two can never disagree about whether a
 * choice is pending. Returns null, or everything the reply handler needs.
 */
function findPendingChoice(player) {
  const volumes = player?.storyProgress?.volumes
  if (!volumes) return null
  for (const [volumeId, progress] of Object.entries(volumes)) {
    if (progress.completed) continue
    const volume = getVolume(volumeId)
    if (!volume) continue
    const chapter = getChapter(volume, progress.currentChapter)
    if (!chapter) continue
    const beats = getResolvedBeats(volume, player, volumeId, chapter)
    const beat = beats[progress.currentBeat]
    if (beat?.type === 'choice') return { volumeId, volume, chapter, beat }
  }
  return null
}

/**
 * Group-scoped check used by handler.js's bare-number bypass. A player can
 * have a pending choice on their record from ANY group they've ever played
 * Story Mode in (storyProgress carries no group tag of its own — a choice
 * is state on the player, not on the group). Without a group check here, a
 * player who once left a choice pending in Group A would have their next
 * plain "1"/"2"/"3" swallowed in Group B, Group C, a DM, etc — including
 * groups where Story Mode was never turned on — and told "Story Mode is
 * off" in a group that has nothing to do with it.
 *
 * The fix: only treat the message as a story reply when this player
 * currently holds THIS group's story slot (lib/moderation-state.js).
 * Holding the slot is proof they're the one actively playing here right
 * now — the slot is claimed by .story enter/start and can't exist at all
 * while storyEnabled is off (claimStorySlot is only ever called after that
 * gate passes, and .story off force-releases it), so this same check also
 * closes the "off" false-positive: no slot in this group means this
 * bypass simply doesn't fire here, and the message falls through to
 * normal handling instead of into the story engine.
 */
export async function hasPendingStoryChoice(player, groupJid, playerJid) {
  if (findPendingChoice(player) === null) return false
  const slot = await getStorySlot(groupJid)
  return slot?.userJid === playerJid
}

export async function handleStoryChoiceReply(ctx, player, rawText) {
  const pending = findPendingChoice(player)
  if (!pending) return false

  // Belt-and-suspenders: hasPendingStoryChoice already confirmed this
  // player holds ctx.sender's slot before handler.js ever called this, so
  // storyEnabled is guaranteed on here too (a slot can't exist while it's
  // off — see the comment on hasPendingStoryChoice above). Kept as a
  // direct check rather than trusting the caller, since a future caller of
  // this exported function might not go through that same gate.
  const settings = await getGroupSettings(ctx.sender)
  if (!settings.storyEnabled) {
    await ctx.reply(
      `🚫 Story Mode is off in this group.\n` +
      `_An owner or mod can turn it on with *${config.prefix}story on*._`,
    )
    return true
  }

  // Answering counts as activity even if the answer doesn't resolve to a
  // valid option below — it proves the holder is still there, which is
  // exactly what the 5-minute timeout sweep (main.js) needs to know. A
  // no-op if this player somehow isn't the current slot holder.
  await touchStorySlot(ctx.sender, ctx.from)

  const { volumeId, chapter, beat } = pending
  const option = resolveChoiceOption(beat, rawText)
  if (!option) {
    // Consumed on purpose — see the note above. Re-post the choice in full
    // so a player whose buttons didn't render can still answer by number.
    await ctx.reply(`_That's not one of the options._\n\n${renderChoiceAsText(beat)}`)
    return true
  }

  await updatePlayer(ctx.db, ctx.from, p => {
    recordChoice(p, volumeId, chapter.id, option.id, choiceKeyFor(beat, chapter.id))
    advanceBeat(p, volumeId)
  })

  await ctx.reply(`_"${stripQuotes(option.label)}"_`)
  await sleep(BEAT_DELAY_MS)

  if (option.detour) {
    for (const detourLine of option.detour.lines ?? []) {
      await sendLine(ctx, detourLine)
      await sleep(BEAT_DELAY_MS)
    }
    await updatePlayer(ctx.db, ctx.from, p => {
      startDetourLock(p, volumeId, option.detour)
    })
    // Detour is a "come back in N hours" wait, same as the cooldown/lock
    // early-exits in playFromCurrentPosition — free the slot now rather
    // than holding it hostage for hours while nobody's actively playing.
    await releaseStorySlot(ctx.sender)
    const hrs = option.detour.lockHours
    await sendLine(ctx, `💤 Run *${config.prefix}story start* again in ${hrs} hour${hrs === 1 ? '' : 's'} to continue.`)
    return true
  }

  await playFromCurrentPosition(ctx, volumeId)
  return true
}

/**
 * One place that explains Story Mode, used by the volume list and by the
 * "someone else is playing" reply. Players kept asking what the slot was,
 * whether they'd been kicked, and how to get back in — so the answer is
 * written down here instead of being folklore.
 */
function storyGuide(volumeLines = []) {
  const p = config.prefix
  return (
    `📖 *STORY MODE*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `_Interactive fiction, played in a group. One person plays at a time; ` +
    `everyone else reads along._\n\n` +
    (volumeLines.length ? `*Volumes*\n${volumeLines.join('\n')}\n\n` : '') +
    `*How to play*\n` +
    `  ▸ *${p}story enter <volume>* — take the slot and open a volume\n` +
    `  ▸ *${p}story start* — begin, or pick up where you stopped\n` +
    `  ▸ reply with the option number when a choice appears\n` +
    `  ▸ *${p}story* — this menu\n\n` +
    `*The slot*\n` +
    `  ▸ Only one player can be in a story at a time per group.\n` +
    `  ▸ Go quiet for ${STORY_IDLE_MINUTES} minutes and the slot frees itself for ` +
    `the next person. *You are never removed from the group*, and your chapter ` +
    `is saved exactly where you left it — *${p}story start* picks it straight back up.\n` +
    `  ▸ Admins can free a stuck slot with *${p}story clear*.\n\n` +
    `*Admins*\n` +
    `  ▸ *${p}story on* / *${p}story off* — enable or disable Story Mode here`
  )
}

export default {
  name: 'story',
  aliases: ['story-mode'],
  category: 'story',
  requiresPlayer: true,
  description: 'Interactive fiction volumes, group only. One player at a time — the slot frees itself after 15 idle minutes, nobody is ever removed from the group.',
  subcommands: [
    { cmd: 'on / off', desc: 'owner/mod: turn Story Mode on or off in this group' },
    { cmd: 'clear', desc: 'owner/mod: force-free the story slot in this group' },
    { cmd: 'enter <volume>', desc: 'enter a story volume (plays the intro once)' },
    { cmd: 'start', desc: 'begin or resume the current chapter' },
    { cmd: '(no args)', desc: 'volume list, how to play, and how the one-player slot works' },
  ],

  async run(ctx) {
    const action = (ctx.args[0] ?? '').toLowerCase()

    // ── ON / OFF (owner or bot mod only) ────────────────────────────────
    // Checked before anything else, including `list`/`volumes` below, so
    // this is the one Story Mode subcommand that works regardless of
    // whether the flag is currently on. Uses the same
    // owner-or-mod credential every other `.<feature> on/off` toggle in
    // this codebase uses (see handleBoolToggle in lib/group-settings.js).
    // This toggle is the ONLY permission Story Mode has: once it is on, every
    // player in the group can play (see the note further down).
    if (action === 'on' || action === 'off') {
      if (!ctx.isGroup) return ctx.reply(NOT_GROUP)
      if (!(await isGroupOrBotOwnerOrMod(ctx))) return ctx.reply(NOT_ALLOWED)

      const want = parseOnOff(action)
      const res = await saveGroupSettings(ctx.sender, s => { s.storyEnabled = want; return s })
      if (!res.ok) return ctx.reply(saveFailedMessage('Story Mode', res.error))

      const stored = res.settings.storyEnabled === true
      // Turning it off frees whoever currently holds the slot — otherwise
      // it'd sit claimed until the 15-minute timeout sweep got to it, even
      // though nothing they do can advance the story while it's off.
      if (!stored) await releaseStorySlot(ctx.sender)
      return ctx.reply(
        `📖 Story Mode is now *${stored ? 'ON' : 'OFF'}* in this group.\n` +
        (stored
          ? `Run *${config.prefix}story-mode* to see available volumes.`
          : `_${config.prefix}story-mode, enter, and start won't work here until it's back on._`),
      )
    }

    // ── CLEAR (owner or bot mod only) ───────────────────────────────────
    // Safety valve: force-frees this group's story slot regardless of who
    // holds it or how long they've been idle, for when the 15-minute
    // timeout sweep (main.js) hasn't fired yet — or shouldn't (someone got
    // disconnected, they went quiet before the sweep ran, etc). Same
    // owner-or-mod credential as `.story on/off` above. Unlike the sweep,
    // this never removes the holder from the group — it only releases the
    // slot so someone else can claim it; a real admin kick is a separate,
    // deliberate action via `.kick`.
    if (action === 'clear') {
      if (!ctx.isGroup) return ctx.reply(NOT_GROUP)
      if (!(await isGroupOrBotOwnerOrMod(ctx))) return ctx.reply(NOT_ALLOWED)

      const held = await getStorySlot(ctx.sender)
      if (!held) return ctx.reply(`📖 No story slot is currently held in this group.`)

      await releaseStorySlot(ctx.sender)
      const bareTag = held.userJid.replace(/@.*$/, '')
      await ctx.sock.sendMessage(ctx.sender, {
        text: `📖 Story slot cleared. @${bareTag} was holding it. Anyone can run *${config.prefix}story start* now.`,
        mentions: [held.userJid],
      }, { quoted: ctx.msg }).catch(() => ctx.reply(`📖 Story slot cleared.`))
      return
    }

    if (!action || action === 'list' || action === 'volumes') {
      if (!storyVolumes.length) {
        return ctx.reply(`📖 No story volumes are available yet.`)
      }
      const lines = storyVolumes.map(v => `  📖 *${v.volumeTitle}* — _${v.title}_ (Book ${v.book})`)
      return ctx.reply(storyGuide(lines))
    }

    if (!ctx.isGroup) {
      return ctx.reply(`📖 Story Mode is group only. Run it in a group to play.`)
    }

    // Off by default in every group — an owner or mod has to flip it on
    // with `.story on` before `enter`/`start` do anything here. This is the
    // only gate on playing: past it, any registered player in the group can
    // enter and start.
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.storyEnabled) {
      return ctx.reply(
        `🚫 Story Mode is off in this group.\n` +
        `_An owner or mod can turn it on with *${config.prefix}story on*._`,
      )
    }

    // Turning Story Mode on IS the permission. It is off by default in every
    // group and only an owner or mod can flip it (`.story on` above), so once
    // it is on, any player in the group can play: that is what enabling it
    // means. There used to be a second gate here that also required the player
    // to be a WhatsApp group admin, which made the feature look broken —
    // members were told "only a group admin can run Story Mode" in a group
    // where it had been deliberately turned on for them.
    //
    // The flood worry that gate existed for is already handled: one story slot
    // per group (claimStorySlot below) means only one run at a time, `.story
    // clear` force-frees it, and `.story off` shuts the whole thing down.
    if (action === 'enter' || action === 'start') {
      // One story slot per group — see lib/moderation-state.js. Claiming
      // refreshes lastActivityAt if this player already holds it; refuses
      // with the "let them finish" reply if someone else does. Checked
      // before the enter/start-specific logic below so neither command can
      // run for a second player while the slot is held.
      const claim = await claimStorySlot(ctx.sender, ctx.from)
      if (!claim.ok) {
        const holderTag = claim.holderJid.replace(/@.*$/, '')
        await ctx.sock.sendMessage(ctx.sender, {
          text:
            `📖 *The story slot is taken.*\n` +
            `@${holderTag} is playing right now — one player at a time per group.\n\n` +
            `_It frees up on its own after ${STORY_IDLE_MINUTES} minutes of inactivity, ` +
            `or an admin can run *${config.prefix}story clear*._`,
          mentions: [claim.holderJid],
        }, { quoted: ctx.msg }).catch(() => {})
        return
      }
    }

    if (action === 'enter') {
      const nameQuery = ctx.args.slice(1).join(' ')
      if (!nameQuery) return ctx.reply(`Usage: *${config.prefix}story enter <volume name>*`)
      const volume = findVolumeByName(nameQuery)
      if (!volume) return ctx.reply(`❌ Couldn't find a volume matching "${nameQuery}". Try *${config.prefix}story-mode* to see what's available.`)

      let alreadySeenIntro = false
      await updatePlayer(ctx.db, ctx.from, p => {
        const progress = ensureStoryProgress(p, volume.id)
        alreadySeenIntro = progress.seenIntro
        progress.seenIntro = true
      })

      if (!alreadySeenIntro) {
        await playIntro(ctx, volume)
        await sleep(BEAT_DELAY_MS)
      }

      const player = getPlayer(ctx.db, ctx.from)
      const progress = player.storyProgress.volumes[volume.id]
      if (progress.completed) {
        await releaseStorySlot(ctx.sender)
        return ctx.reply(`You've already completed *${volume.volumeTitle}*.`)
      }
      return ctx.reply(
        `You're in. Chapter ${progress.currentChapter}${progress.currentBeat > 0 ? ` (in progress)` : ''}.\n` +
        `Run *${config.prefix}story start* to ${progress.currentBeat > 0 ? 'continue' : 'begin'}.`,
      )
    }

    if (action === 'start') {
      const player = getPlayer(ctx.db, ctx.from)
      const enteredVolumes = Object.entries(player.storyProgress?.volumes ?? {})
      if (!enteredVolumes.length) {
        await releaseStorySlot(ctx.sender)
        return ctx.reply(`You haven't entered a volume yet. Try *${config.prefix}story-mode* to see what's available.`)
      }
      // Most recently entered / not-yet-completed volume, or the only one.
      const [volumeId] = enteredVolumes.find(([, p]) => !p.completed) ?? enteredVolumes[0]
      return playFromCurrentPosition(ctx, volumeId)
    }

    return ctx.reply(
      `Usage:\n` +
      `*${config.prefix}story on/off*: owner/mod, turn Story Mode on or off\n` +
      `*${config.prefix}story clear*: owner/mod, force-free the story slot\n` +
      `*${config.prefix}story-mode*: list volumes\n` +
      `*${config.prefix}story enter <volume>*: enter a volume\n` +
      `*${config.prefix}story start*: play or continue`,
    )
  },
}
