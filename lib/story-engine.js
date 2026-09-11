/**
 * story-engine.js — beat-by-beat progression logic for Story Mode volumes
 * (e.g. data/story-beyond-the-astral.json, see story/json-schema-spec.md for
 * the data shape this reads).
 *
 * This module is pure logic: no sock.sendMessage calls live here, no
 * setTimeout delays. plugins/story.js owns delivery (sequential DM
 * messages, the appreciation intro, choice-reply gating); this file owns
 * state — what chapter/beat a player is on, whether they're allowed to
 * start the next chapter yet, and what a chapter grants on completion.
 *
 * One volume shipped so far: 'beyond-the-astral'. Future volumes are their
 * own JSON files (see game-data.js) and get their own entry in the
 * `volumes` map below — nothing here is hardcoded to a single volume id.
 */
import { storyVolumes } from './game-data.js'
import { isPremiumActive } from './premium.js'
import { roundGems } from './format.js'
import { applyLevelUps } from './combat-engine.js'
import { levelsData, classes, races, getTotalStats } from './game-data.js'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** Free players: 1 chapter per 24h since their last completion. Premium: 3. */
export function chaptersAllowedPerWindow(player) {
  return isPremiumActive(player) ? 3 : 1
}

/** { [volumeId]: volumeData } built once at load from game-data.js's export. */
export const volumeMap = Object.fromEntries(storyVolumes.map(v => [v.id, v]))

export function getVolume(volumeId) {
  return volumeMap[volumeId] ?? null
}

export function findVolumeByName(query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return null
  return storyVolumes.find(v =>
    v.id.toLowerCase() === q ||
    v.title.toLowerCase() === q ||
    v.volumeTitle.toLowerCase() === q ||
    v.title.toLowerCase().includes(q) ||
    v.volumeTitle.toLowerCase().includes(q),
  ) ?? null
}

/**
 * Ensures player.storyProgress and player.storyProgress.volumes[volumeId]
 * exist with the correct shape, mutating in place. Call inside
 * updatePlayer's mutator before reading/writing any story state.
 */
export function ensureStoryProgress(player, volumeId) {
  if (!player.storyProgress) player.storyProgress = { volumes: {} }
  if (!player.storyProgress.volumes) player.storyProgress.volumes = {}
  if (!player.storyProgress.volumes[volumeId]) {
    player.storyProgress.volumes[volumeId] = {
      currentChapter: 1,
      currentBeat: 0,       // 0 = chapter not yet started; beats render 1-indexed to the player
      completed: false,
      choices: {},          // { [chapterId]: optionId } — last pick in that chapter
      choiceKeys: {},       // { [choiceKey]: optionId } — one slot per choice beat
      lastChapterCompletedAt: null,
      chaptersCompletedInWindow: 0, // resets once 24h has passed since lastChapterCompletedAt
      seenIntro: false,     // whether the appreciation/credits sequence has played for this volume
      detourLockedUntil: null, // timestamp ms, or null — see resolveDetourChoice/checkDetourLock
      pendingDetourResume: null, // { resumeLine } queued to play once the lock clears
    }
  }
  return player.storyProgress.volumes[volumeId]
}

function getVolumeProgress(player, volumeId) {
  return player.storyProgress?.volumes?.[volumeId] ?? null
}

export function getChapter(volume, num) {
  return volume.chapters.find(c => c.num === num) ?? null
}

export function getChapterById(volume, id) {
  return volume.chapters.find(c => c.id === id) ?? null
}

/**
 * Returns { allowed: true } or { allowed: false, reason, retryAt } —
 * whether the player may begin volume.currentChapter right now, given the
 * per-24h chapter cap. A player who has never completed a chapter in this
 * volume is always allowed (nothing to cool down from yet).
 */
export function canStartChapter(player, volumeId) {
  const progress = getVolumeProgress(player, volumeId)
  if (!progress) return { allowed: true }
  if (progress.completed) return { allowed: false, reason: 'volume_completed' }
  if (!progress.lastChapterCompletedAt) return { allowed: true }

  const elapsed = Date.now() - progress.lastChapterCompletedAt
  const cap = chaptersAllowedPerWindow(player)

  if (elapsed >= DAY_MS) {
    // Window has fully reset — chaptersCompletedInWindow effectively back to 0.
    return { allowed: true }
  }

  if (progress.chaptersCompletedInWindow < cap) return { allowed: true }

  return {
    allowed: false,
    reason: 'cooldown',
    retryAt: progress.lastChapterCompletedAt + DAY_MS,
  }
}

/** Beats are stored 0-indexed internally; render/track 1-indexed to the player. */
export function getCurrentBeat(volume, player, volumeId) {
  const progress = getVolumeProgress(player, volumeId)
  if (!progress) return null
  const chapter = getChapter(volume, progress.currentChapter)
  if (!chapter) return null
  const beats = getResolvedBeats(volume, player, volumeId, chapter)
  const beatIndex = progress.currentBeat // 0-indexed into the resolved beats array
  return beats[beatIndex] ?? null
}

export function isLastBeatOfChapter(beats, beatIndex) {
  return beatIndex >= beats.length - 1
}

/**
 * Stable identifier for a single choice beat, used as the key its pick is
 * filed under in progress.choiceKeys.
 *
 * progress.choices is keyed by CHAPTER id, which was fine when a chapter had
 * one choice in it. Chapters 2-20 have ten each, so chapter-keyed storage
 * means choice #2 overwrites choice #1 and per-option branching can never
 * read back the right pick. choiceKeys fixes that with one slot per beat;
 * progress.choices is still written alongside it (last pick in the chapter
 * wins) so every pre-existing textByOption/branch callback keyed by chapter
 * id keeps working untouched.
 *
 * Authored choice beats in chapters 2-20 all carry an explicit "key"
 * (e.g. "c14-shield"). The option-id fallback exists for chapter 1, which
 * was authored before keys existed: it is position-independent on purpose,
 * so inserting beats around a choice never re-keys it and never invalidates
 * a save mid-chapter. Two key-less choice beats in one chapter with the same
 * option ids would collide, which is harmless for chapter 1 (none of its
 * options carry per-option beats, so nothing reads these keys back) and is
 * why every new choice beat gets a real key instead.
 */
export function choiceKeyFor(beat, chapterId) {
  if (beat?.key) return String(beat.key)
  const ids = (beat?.options ?? []).map(o => o.id).join('|')
  return `${chapterId}#${ids}`
}

/** A recorded pick, looked up by choice key first, then by chapter id. */
function lookupChoice(progress, ref) {
  if (!progress || !ref) return null
  return progress.choiceKeys?.[ref] ?? progress.choices?.[ref] ?? null
}

/**
 * Returns the beat's display text, prepending a branch-specific opener when
 * the beat has textByOption. Three shapes are supported:
 *  - Same-chapter callback: textByOption is { optionId: openerText }, keyed
 *    by the choice made earlier in THIS chapter (currentChapterId).
 *  - Choice-key callback: textByOptionRef names a specific choice beat's key
 *    (e.g. "c14-shield") and textByOption is { optionId: openerText }. This
 *    is the shape to use for anything finer-grained than "the last choice in
 *    some chapter", which is all a chapter-id ref can express.
 *  - Cross-chapter callback: textByOptionRef names an earlier chapter's id,
 *    and textByOption is { [thatChapterId]: { optionId: openerText } },
 *    keyed by the choice made back in that earlier chapter.
 * The nested vs flat shapes are told apart by looking, not by comparing ids:
 * if textByOption[ref] is itself an object it's the nested form, otherwise
 * textByOption is the flat option map.
 * Falls back to beat.text unmodified if no matching choice is on record
 * (e.g. an old save from before this beat existed), so nothing ever breaks.
 */
export function resolveBeatText(beat, player, volumeId, currentChapterId) {
  if (!beat.textByOption) return beat.text
  const progress = getVolumeProgress(player, volumeId)

  const ref = beat.textByOptionRef ?? currentChapterId
  const picked = lookupChoice(progress, ref)
  const nested = beat.textByOption[ref]
  const optionMap = nested && typeof nested === 'object' ? nested : beat.textByOption

  const opener = picked ? optionMap?.[picked] : null
  if (!opener) return beat.text
  return `${opener}\n\n${beat.text}`
}


/**
 * Advances progress.currentBeat by one. Call after a non-choice beat has
 * finished rendering, or after a choice beat's pick has been recorded.
 * Does NOT handle chapter completion — call completeChapter separately
 * once isLastBeatOfChapter was true before this call.
 */
export function advanceBeat(player, volumeId) {
  const progress = ensureStoryProgress(player, volumeId)
  progress.currentBeat += 1
}

/**
 * Records which option id the player picked at a choice beat. Written to two
 * places on purpose:
 *   progress.choices[chapterId]  — legacy, one slot per chapter, last pick in
 *                                  the chapter wins. Every textByOption /
 *                                  branch callback authored against a chapter
 *                                  id reads this.
 *   progress.choiceKeys[key]     — one slot per choice beat (see
 *                                  choiceKeyFor). This is what per-option
 *                                  branching reads, and the only one of the
 *                                  two that survives ten choices in a
 *                                  chapter without clobbering itself.
 * Choices are readable by ANY later chapter, not just the immediately next
 * beat. Recording is always the same regardless of how far a branch reaches.
 */
export function recordChoice(player, volumeId, chapterId, optionId, choiceKey = null) {
  const progress = ensureStoryProgress(player, volumeId)
  progress.choices[chapterId] = optionId
  if (!progress.choiceKeys) progress.choiceKeys = {}
  if (choiceKey) progress.choiceKeys[choiceKey] = optionId
}

/**
 * Resolves which array of beats to actually play for a chapter this
 * playthrough. Two independent branching mechanisms are folded together
 * here, and a chapter may use either, both, or neither.
 *
 * 1. PER-OPTION BEATS (the visual-novel mechanism, used by chapters 2-20).
 *    A choice beat's option can carry its own "beats" array:
 *
 *      { "type": "choice", "key": "c05-answer", "text": "...",
 *        "options": [
 *          { "id": "truth", "label": "\"...\"", "beats": [ ...only truth-pickers see these... ] },
 *          { "id": "deflect", "label": "\"...\"", "beats": [ ...only deflect-pickers see these... ] }
 *        ] }
 *
 *    Once the pick is recorded, that option's beats are spliced in directly
 *    after the choice beat and the chapter carries on into the shared beats
 *    that follow — divergence, then reconvergence, with no seam and no
 *    duplicated shared prose. Nesting works: an option's beats may contain
 *    further choice beats. Before the pick is recorded nothing is spliced,
 *    which is exactly what makes progress.currentBeat stable: the pending
 *    choice sits at the same index whether or not it has been answered, and
 *    the index only ever grows *after* it.
 *
 * 2. CHAPTER-LEVEL BRANCH (the original mechanism, used by chapter 2). A
 *    chapter can branch one stretch of itself on a choice made in an earlier
 *    chapter:
 *
 *      "beats": [ ...shared opening beats... ],
 *      "branch": {
 *        "onChapterId": "the-boy-who-watched-birds",
 *        "cases": { "worry": [ ... ], "wonder": [ ... ] },
 *        "default": [ ...anyone with no recorded choice... ],
 *        "resumeBeats": [ ...shared beats once the branch rejoins... ]
 *      }
 *
 *    "onKey" may be used instead of "onChapterId" to branch on one specific
 *    choice beat rather than whatever the chapter's last choice happened to
 *    be. The played sequence is chapter.beats, then the matching case (or
 *    default, so an old save or unexpected id never breaks), then resumeBeats.
 */
export function getResolvedBeats(volume, player, volumeId, chapter) {
  const progress = getVolumeProgress(player, volumeId)
  const out = []

  expandBeats(chapter.beats ?? [], progress, chapter.id, out)

  if (chapter.branch) {
    const ref = chapter.branch.onKey ?? chapter.branch.onChapterId
    const pick = lookupChoice(progress, ref)
    const branchBeats = (pick && chapter.branch.cases?.[pick]) || chapter.branch.default || []
    expandBeats(branchBeats, progress, chapter.id, out)
    expandBeats(chapter.branch.resumeBeats ?? [], progress, chapter.id, out)
  }

  return out
}

/**
 * Walks an authored beat list into the flat sequence the player actually
 * plays, splicing in the taken branch at every already-answered choice beat.
 * Recursive so an option's beats can contain their own choices. Depth-capped
 * purely as a malformed-data guard (authored nesting never goes past 2).
 */
function expandBeats(list, progress, chapterId, out, depth = 0) {
  if (depth > 8) return
  for (const beat of list) {
    out.push(beat)
    if (beat.type !== 'choice') continue
    const picked = lookupChoice(progress, choiceKeyFor(beat, chapterId))
    if (!picked) continue
    const option = (beat.options ?? []).find(o => o.id === picked)
    if (!option?.beats?.length) continue
    expandBeats(option.beats, progress, chapterId, out, depth + 1)
  }
}


/**
 * Resolves a plea beat's stakes. Scripted pleas always succeed. Real
 * pleas roll against `chance` using Math.random() — this is flavor
 * randomness for tension per the story bible, explicitly NOT the player's
 * own stats/gear/level (stakes.chance is a fixed, story-authored number).
 * Returns { success: boolean, text: string }.
 */
export function resolvePlea(beat) {
  const stakes = beat.stakes
  if (stakes.scripted) {
    return { success: true, text: null }
  }
  const success = Math.random() < stakes.chance
  return {
    success,
    text: success ? stakes.onSuccess : stakes.onFail,
  }
}

/**
 * Resolves a battle beat. Every story battle beat is fixedStats +
 * playerStatsIgnored per the schema — the player's real level/gear never
 * affects the outcome. Where a chapter allows failure (onLose is a real
 * string, not null), this still rolls; where onLose is null the beat
 * always resolves as a win (the story requires it to happen a specific
 * way to continue). Returns { success: boolean, text: string|null }.
 */
export function resolveBattle(beat) {
  const enc = beat.encounter
  if (enc.onLose == null) {
    return { success: true, text: enc.onWin }
  }
  // Fixed 70% win chance for battles that do allow a loss branch — same
  // spirit as plea beats: authored tension, not a real stat check.
  const success = Math.random() < 0.7
  return {
    success,
    text: success ? enc.onWin : enc.onLose,
  }
}

/**
 * Called once the last beat of a chapter has finished (and any plea/battle
 * on that final beat has resolved). Advances currentChapter, resets
 * currentBeat to 0, updates the cooldown window, and grants gems/XP.
 * If this was chapter 20 (or whichever chapter has onComplete), applies
 * the volume-completion reward instead of the per-chapter one and marks
 * the volume completed. Mutates player in place — call inside
 * updatePlayer's mutator. Returns a summary object for the plugin to
 * render to the player.
 */
export function completeChapter(player, volume, volumeId, chapter, rewards) {
  const progress = ensureStoryProgress(player, volumeId)
  const now = Date.now()

  // Reset the rolling window if more than 24h has passed since the last
  // completion; otherwise increment within the current window.
  if (!progress.lastChapterCompletedAt || now - progress.lastChapterCompletedAt >= DAY_MS) {
    progress.chaptersCompletedInWindow = 1
  } else {
    progress.chaptersCompletedInWindow += 1
  }
  progress.lastChapterCompletedAt = now

  const gemsAward = rewards?.gemsPerChapter ?? 0
  const xpAward = rewards?.xpPerChapter ?? 0

  if (gemsAward > 0) {
    player.wallet.gems = roundGems((player.wallet.gems ?? 0) + gemsAward)
  }
  let levelUpMsgs = []
  if (xpAward > 0) {
    player.xp += xpAward
    const result = applyLevelUps(player, levelsData, classes, races, getTotalStats)
    levelUpMsgs = result ?? []
  }

  const isFinalChapter = chapter.num === volume.chapters.length
  let volumeCompleteReward = null

  if (isFinalChapter && chapter.onComplete) {
    progress.completed = true
    const oc = chapter.onComplete
    if (oc.grantsCharacter && !player.ownedCharacters.includes(oc.grantsCharacter)) {
      player.ownedCharacters.push(oc.grantsCharacter)
    }
    for (const itemId of oc.items ?? []) {
      if (!player.inventory.includes(itemId)) player.inventory.push(itemId)
    }
    if (oc.gems) {
      player.wallet.gems = roundGems((player.wallet.gems ?? 0) + oc.gems)
    }
    if (!player.storyFlags) player.storyFlags = []
    for (const flag of oc.flags ?? []) {
      if (!player.storyFlags.includes(flag)) player.storyFlags.push(flag)
    }
    volumeCompleteReward = oc
  } else {
    progress.currentChapter += 1
    progress.currentBeat = 0
  }

  return {
    gemsAward,
    xpAward,
    levelUpMsgs,
    isFinalChapter: isFinalChapter && !!chapter.onComplete,
    volumeCompleteReward,
  }
}

/** True once player.storyFlags contains the given flag (e.g. 'free-travel-all-locations'). */
export function hasStoryFlag(player, flag) {
  return Array.isArray(player.storyFlags) && player.storyFlags.includes(flag)
}

/**
 * Detour choices (an option on a choice beat with a "detour" field) don't
 * advance straight into the next shared beat. Instead: play the detour's
 * own short lines, then hard-lock this volume's play for `lockHours` real
 * hours — separate from and in addition to the daily chapter cooldown.
 * Call this (inside updatePlayer's mutator) right after playing the
 * detour's lines, once the player has picked a detour option.
 */
export function startDetourLock(player, volumeId, detour) {
  const progress = ensureStoryProgress(player, volumeId)
  progress.detourLockedUntil = Date.now() + detour.lockHours * HOUR_MS
  progress.pendingDetourResume = { resumeLine: detour.resumeLine ?? null }
}

/**
 * Returns { locked: true, retryAt } if this volume currently has an active
 * detour lock, otherwise { locked: false }. Checked by .story start before
 * canStartChapter's daily-cap check — a detour lock blocks play regardless
 * of whether a fresh chapter would otherwise be allowed, since the scene
 * itself (e.g. "he's asleep") hasn't resolved yet.
 */
export function checkDetourLock(player, volumeId) {
  const progress = getVolumeProgress(player, volumeId)
  if (!progress?.detourLockedUntil) return { locked: false }
  if (Date.now() >= progress.detourLockedUntil) return { locked: false }
  return { locked: true, retryAt: progress.detourLockedUntil }
}

/**
 * Called once a detour's lock has expired and the player runs .story start
 * again. Clears the lock/pending-resume state and returns the resume line
 * (if the detour had one) so the plugin can play it as a single narrator
 * beat before falling through to the next shared beat as normal. Mutates
 * player in place — call inside updatePlayer's mutator.
 */
export function clearDetourLock(player, volumeId) {
  const progress = ensureStoryProgress(player, volumeId)
  const resumeLine = progress.pendingDetourResume?.resumeLine ?? null
  progress.detourLockedUntil = null
  progress.pendingDetourResume = null
  return resumeLine
}
