STORY MODE — JSON SCHEMA SPEC
For converting the prose (markdown) chapters into bot-readable data.

────────────────────────────────────────
WHERE IT LIVES
────────────────────────────────────────

One file per volume, following the same convention as every other
static content file in data/ (characters.json, locations.json, etc):

  data/story-beyond-the-astral.json

Loaded once at boot in lib/game-data.js, same pattern as everything
else there:

  export const storyBeyondTheAstral = require('../data/story-beyond-the-astral.json')

A future Book Two would be its own file, e.g.
data/story-book-two.json, never merged into this one. Each volume is
a standalone JSON document.

────────────────────────────────────────
TOP-LEVEL SHAPE
────────────────────────────────────────

{
  "id": "beyond-the-astral",
  "title": "The Boy Who Glided the Skies",
  "volumeTitle": "Beyond the Astral",
  "book": 1,
  "tagline": "Beyond that eye, what can you actually see? The injustice in this world, or the sanity we think we all have?",
  "coverImage": "https://i.ibb.co/fYFzZDzM/Book-one.jpg",
  "character": {
    "id": "monica",
    "name": "Monica",
    "unlockRewards": {
      "characterUnlock": "monica",
      "items": ["oliver-goggles"],
      "perks": ["free-travel-all-locations", "hidden-map-access"]
    }
  },
  "chapters": [ ... ]
}

Field notes:
- "id" is the volume's slug, used in commands and save data
  (player.storyProgress.volumes["beyond-the-astral"]).
- "coverImage" is the volume's book-cover art, a hosted URL following
  the same convention as character/item "image" fields. Rendered
  wherever the bot shows the volume as a whole (e.g. a `.story` list
  embed or the chapter-1 intro), not per-chapter.
- "character.id" is the character granted at the end of the volume.
  This becomes a normal entry in data/characters.json once written
  (same shape Nisha/Yoriichi use), separate from this file — this
  file only references the id and what unlocks alongside her.
- "unlockRewards.perks" are free-text tags the travel/dungeon-entry
  code checks for later (e.g. a feeGate function can check
  player.storyProgress.volumes["beyond-the-astral"].completed &&
  grants "free-travel-all-locations" before charging a travel fee).
  Exact perk-checking logic is a separate implementation pass, not
  part of this schema, this field just declares what should exist.

────────────────────────────────────────
CHAPTER SHAPE
────────────────────────────────────────

Each entry in "chapters":

{
  "num": 1,
  "id": "the-boy-who-watched-birds",
  "title": "The Boy Who Watched Birds",
  "requires": null,
  "beats": [ ... ]
}

- "num" is the chapter number, 1 through 20, also the unlock-order
  gate (clear chapter N to unlock N+1).
- "id" is a slug, matches the markdown filename minus the chNN-
  prefix, used in command routing (.story beyond-the-astral 1 or
  similar).
- "requires" is null for chapter 1, otherwise the previous chapter's
  id string. Kept explicit (rather than just inferring from "num")
  so a future volume could have non-linear unlock requirements
  without changing the shape.

────────────────────────────────────────
BEAT SHAPES — one shape per beat type
────────────────────────────────────────

Every beat has "type" and "text" at minimum. "text" is the prose
exactly as approved from the markdown chapter, no em dashes, no
edits during conversion beyond formatting.

DIALOGUE BEAT (the default, most common):

{
  "type": "dialogue",
  "text": "The window is the only part of the day that belongs to you.\n\n..."
}

CHOICE BEAT:

{
  "type": "choice",
  "key": "c02-first-told",
  "text": "He tells you the dream plainly, for the first time...",
  "options": [
    { "id": "believe", "label": "\"Then I believe you.\"",
      "beats": [ { "type": "line", "text": "..." } ] },
    { "id": "worry",   "label": "\"You're going to get yourself killed.\"" },
    { "id": "honest",  "label": "\"I want to see it too.\"" }
  ]
}

- 2 or 3 options, never more. lib/interactive-buttons.js's sendButtons
  hard-caps at three, so a fourth option would be unreachable on
  WhatsApp. build-volume.mjs rejects it.

- "key" is a stable, volume-unique id for the choice ("c02-first-told").
  It is REQUIRED on any choice that carries per-option "beats", and
  strongly recommended on all of them, because it is what later
  callbacks reference. build-volume.mjs rejects duplicates.

- Options MAY branch. An option's optional "beats" array is spliced
  into the chapter immediately after the choice, but only once the
  pick has been recorded — so a pending choice always sits at a
  stable index and indices only grow after it. Branches reconverge on
  whatever shared beats follow the choice in the parent array.

- IMPORTANT: after a branch that changes physical state, the next
  shared beat must either be branch-agnostic or carry a
  "textByOption" (see below). Otherwise one branch will contradict it.

- Picks are recorded twice: progress.choices[chapterId] (legacy, holds
  only the chapter's LAST pick) and progress.choiceKeys[key]. A
  callback that needs a SPECIFIC earlier choice must therefore use
  "textByOptionRef": "<that choice's key>", not the chapter id:

  {
    "type": "line",
    "text": "<default text, used if no pick is on record>",
    "textByOptionRef": "c05-leg",
    "textByOption": {
      "carriage": "...", "deflect": "...", "too-big": "..."
    }
  }

  The keys of "textByOption" must be option ids of the referenced
  choice. This works across chapters — ch16 reads ch05's pick this way.

PLEA BEAT:

{
  "type": "plea",
  "text": "The shopkeeper's eyes narrow on the bundle under Oliver's coat...",
  "stakes": {
    "scripted": true,
    "chance": null,
    "onFail": null
  }
}

or, for a real-stakes plea (chapters 6, 13, 18):

{
  "type": "plea",
  "text": "The Toll Man doesn't blink while you talk...",
  "stakes": {
    "scripted": false,
    "chance": 0.65,
    "onSuccess": "He waves you both off, this time.",
    "onFail": "He takes the frame. Three weeks of work, gone in his fist."
  }
}

- "scripted: true" beats always succeed narratively regardless of
  any roll, "chance"/"onFail" stay null and the bot just plays
  through to the next beat.
- "scripted: false" beats use "chance" (0 to 1) as the story's own
  fixed success probability for that specific scene, entirely
  separate from the player's real stats, gear, or level. This is
  flavor-appropriate randomness for tension, not a stat check. On
  fail, "onFail" text plays and can gate what unlocks next (a
  chapter can still continue after a failed plea, the consequence is
  narrative, not a game over, unless a specific chapter's design
  calls for a retry).

BATTLE BEAT:

{
  "type": "battle",
  "text": "The frame gives out forty feet up. Oliver's scream is swallowed by wind...",
  "encounter": {
    "enemyName": "The Fall",
    "enemyHp": 40,
    "enemyAtk": 12,
    "fixedStats": true,
    "playerStatsIgnored": true,
    "onWin": "You get him down before the crowd does.",
    "onLose": null
  }
}

- "fixedStats: true" and "playerStatsIgnored: true" are always true
  for every story battle beat, restated explicitly in the data so
  the combat engine code has an unambiguous flag to check rather
  than inferring it. This is what keeps every player getting the
  identical, balanced fight regardless of their real level or gear.
  - "enemyName" can be non-literal (e.g. "The Fall" for chapter 8's
  spectacle-danger beat, rather than a real named opponent) since not
  every battle beat is against a person.
- "onLose" is null when the story doesn't allow failure (the scene
  needs to happen a specific way to continue), or a real string
  when a loss has its own consequence text, chapter 14's battle beat
  is the one place this matters most, define its exact onLose text
  carefully since it's the loss chapter.

CHAPTER-END REWARD (attached to the chapter, not a beat):

{
  "num": 20,
  "id": "beyond-the-astral",
  "title": "Beyond the Astral",
  "requires": "the-night-before",
  "beats": [ ... ],
  "onComplete": {
    "grantsCharacter": "monica",
    "items": ["oliver-goggles"],
    "gems": 0,
    "flags": ["free-travel-all-locations", "hidden-map-access"]
  }
}

- Only chapter 20 needs a non-empty "onComplete" for this volume.
  Earlier chapters can omit "onComplete" entirely or use it for
  small filler rewards (a few gems, flavor items) if you want
  incremental rewards per chapter later, not required for the first
  build.

────────────────────────────────────────
PLAYER SAVE-DATA SHAPE (for reference, not part of this JSON file)
────────────────────────────────────────

This lives on the player record in the bot's existing lowdb store,
same convention as player.seasonState:

player.storyProgress = {
  volumes: {
    "beyond-the-astral": {
      currentChapter: 3,
      currentBeat: 5,
      completed: false,
      choices: { "nobody-owns-the-sky": "tomorrow" },
      choiceKeys: { "c02-first-told": "honest", "c02-close": "tomorrow" }
    }
  }
}

- "choiceKeys" is the authoritative record: option id keyed by the
  choice's "key". This is what per-option branching and every
  cross-chapter callback read.
- "choices" is the legacy chapter-keyed record, kept so older
  callbacks keep working. Because each chapter now has ~10 choices,
  it holds only the chapter's LAST pick — never reference it when you
  mean a specific choice.
- "completed" flips true once chapter 20's onComplete has fired,
  this is the flag other code checks for the free-travel perk.

────────────────────────────────────────
WHAT TO HAND BACK
────────────────────────────────────────

Once all 20 chapters are approved in prose, the conversion pass
should produce exactly one file, data/story-beyond-the-astral.json,
matching this schema exactly.

That file is now GENERATED, not hand-edited. Author each chapter as
story/chapters-json/chNN.json (volume metadata lives in
story/chapters-json/_volume.json) and run:

  node story/build-volume.mjs

which assembles and validates the volume and writes
data/story-beyond-the-astral.json. It exits non-zero on: a
non-sequential "num", a "requires" that isn't the previous chapter's
id, an unknown beat type, an empty "text", a plea missing "stakes", a
battle missing "encounter" or "encounter.onWin", "options" on a
non-choice beat, a choice with fewer than 2 or more than 3 options,
duplicate option ids, per-option "beats" on a choice with no "key",
or a duplicate "key" anywhere in the volume.

Per-chapter completion rewards are set in plugins/story.js
(STORY_REWARDS), not in the volume file.
