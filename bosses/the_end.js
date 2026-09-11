/**
 * The End — the Blue Band event's world boss (solo, server-wide finale).
 * Grade: OMNI | Floor: 999 (sentinel) | Location: the_end
 *
 * NOT a person and not, quite, a monster. The End is the shape absence takes
 * when it is finally given room to move. Two weeks ago it woke and breathed out
 * a magical air that put the world to sleep; this fight is a mortal walking into
 * that breath and refusing to lie down. Every player fights their own instance,
 * but the FIRST kill anywhere lifts the aura for everyone (see lib/end-event.js
 * claimEndDefeat + the finale hook in the combat victory path).
 *
 * WHY floor 999 (sentinel). Boss combat stats are normally read off the floor
 * curve, and getBossForFloor() picks the highest-grade boss sharing a floor. An
 * OMNI boss parked on a real dungeon floor (50, 100, …) would silently become
 * THE boss for every dungeon that reaches that floor. 999 is queried by no
 * dungeon, so The End stays isolated; its real stats are pinned via
 * statOverride, exactly like the_last_prayer sitting off-curve at floor 50.
 *
 * WHY it can actually die (unlike the_last_prayer). The Last Prayer is a
 * deliberate attrition wall tuned so a party can never quite finish it. The End
 * is the opposite: the event only ends when someone kills it, so its mechanics
 * create drama and time-pressure (a modest aura barrier, one dramatic second
 * wind, a soft enrage) without ever becoming an infinite wall. Strong players
 * win before the enrage crests; the weak are meant to be crushed — thematically
 * correct, since the weak are the ones the aura put to sleep in the first place.
 */

export const the_end = {
  id: 'the_end',
  name: 'The End',
  floor: 999,
  grade: 'OMNI',
  emoji: '🌑',
  image: null,

  // Pinned combat stats — bypass the floor curve entirely (see boss-engine.js).
  // Tuned as a SOLO endgame raid: HP well above the hardest normal boss (50k) so
  // it is a long, grueling fight, but per-hit damage (atk * 0.60 ≈ 1680) sits
  // below the normal floor-100 ceiling (~2700) so a well-geared max-level player
  // survives long enough to win. The one-shot second wind adds ~35% effective HP;
  // the soft enrage is the real clock. baseAtk tracks the FINAL atk so the enrage
  // has a stable reference to climb from.
  statOverride: { hp: 120000, def: 700, atk: 2800 },

  hp: 120000,
  maxHp: 120000,
  atk: 2800,
  def: 700,
  exp: 50000,
  gold: 10000,
  type: 'void',
  weakTo: ['holy', 'light'],
  resistTo: ['shadow', 'void', 'physical'],

  personality: 'vast-patient-indifferent',
  voice: 'Not a voice. The absence of one, arranged into the shape of words — the quiet you hear a half-second before sleep takes you, if that quiet could be said to want anything. It never rises. It never has to.',

  lore: `It was always going to end. That is the only promise the world was ever truly given, and the world spent every waking hour pretending otherwise — building towns, ringing bells, teaching its children to be afraid of the dark as though the dark were the thing that could hurt them.

Two weeks ago the pretending stopped. Something loosed the End into the sky, and it did what ends do: it exhaled. The breath was a fine magical air, and where it settled the strong grew weak and the weak lay down and slept, and the world went quiet in the gentle, total way a house goes quiet when everyone in it has finally, gratefully, gone to bed.

It is not cruel. Cruelty requires wanting, and the End wants nothing — not your death, not your worship, not even your sleep. The sleep is simply what happens near it, the way cold is what happens near winter. It has been waiting at the far edge of every story ever told, patient as a held breath, for someone to stop building bells long enough to walk out and meet it.

You walked out. You are still standing. It finds this neither brave nor foolish. It finds it, faintly, like the first cool edge of a morning that was never supposed to come — interesting.`,

  entrance: [
    'The air stops moving. Not stills — stops, the way a heart stops, all at once and without apology.',
    'There is no monster here. There is a place where the world simply runs out, and something is standing in it that the eye keeps sliding off of.',
    'The sleep you have been fighting for two weeks pools at your feet, thick as floodwater, and begins, very patiently, to rise.',
    '_"You are awake,"_ says the quiet, mildly. _"Most are not, by now. Most were glad to stop."_',
    '_"Stay, if you like. It is the same to me whether you lie down or fall down. Both are how it ends."_',
  ],

  phases: {
    75: [
      'You land a blow and the air drinks it — but a hairline of true dark opens where you struck, and does not close.',
      '_"Oh,"_ the quiet says, without alarm. _"You can reach me. How long has it been since anything reached me."_',
      'The floodwater of sleep climbs to your shins. It is warm. That is the worst part.',
    ],
    50: [
      'Half the End has gone somewhere a wound cannot follow. The half that remains grows heavier, denser, more here.',
      '_"You are trying to make me end,"_ it observes, almost kindly. _"I am the ending. You are asking the ending to end. Think about what you are asking."_',
      'The air presses on your eyelids like two soft coins. Every blink lasts a fraction too long.',
    ],
    25: [
      'What is left of it should not still be standing, and is. The dark where you have struck it has become most of it.',
      '_"Nearly,"_ says the quiet, and for the first time there is something under the word — not fear. Interest. _"You are nearly there. Do you understand that I have never once been nearly there?"_',
      '_"Finish it, then. Wake the world. It will only have to be done again — but not by you, and not today. Today it is only you and me and the last of the light."_',
    ],
  },

  attacks: [
    'The Exhale',
    'Weight of the Long Sleep',
    'Where the World Runs Out',
    'Two Soft Coins',
    'The Quiet That Wants Nothing',
  ],

  attackNarratives: {
    'The Exhale': [
      'The End breathes out.',
      'It is not wind and it is not force. It is the specific tiredness of having been awake your whole life, delivered all at once.',
      'Your knees remember how to buckle before your mind decides not to let them.',
    ],
    'Weight of the Long Sleep': [
      'The floodwater of sleep at your feet surges to your chest without rising through the space between.',
      'It does not pull you under. It simply makes staying above it cost everything you have.',
      'For one heartbeat you are holding up the weight of every sleeper in the world, and they are all so heavy, and they are all so peaceful.',
    ],
    'Where the World Runs Out': [
      'The floor ends. Not breaks — ends, the way a sentence ends, with nothing after it.',
      'The End gestures, mildly, at the nothing, and the nothing leans toward you.',
      'You are asked, without malice, to consider stepping into it. The asking has weight.',
    ],
    'Two Soft Coins': [
      'A pressure settles over both your eyes, gentle as a thumb closing the lids of the newly dead.',
      '_"Rest,"_ the quiet suggests. It is not an attack. It is a courtesy, and courtesies from the End are the deadliest thing in the world.',
      'You force your eyes open against a weight that does not fight back — it only waits, endlessly patient, for the next blink.',
    ],
    'The Quiet That Wants Nothing': [
      'The End does the one thing nothing living can bear: it stops entirely.',
      'No breath. No weight. No voice. Just the perfect, total silence of a thing that has finished wanting.',
      'The silence reaches into your chest and shows you, with terrible tenderness, how easy it would be to match it.',
    ],
  },

  dodgeLines: [
    '_"You move. Movement is a habit of the living. It will pass."_',
    '_"Away, then. There is nowhere in this place that is not also me."_',
    '_"Quick. The end is quicker. The end has always already arrived."_',
    '_"You dodge the breath. You cannot dodge the fact of it."_',
  ],

  hitLines: [
    '_"That reached me. Do it again, while you still can want things."_',
    '_"A wound. How novel. I had forgotten the shape of them."_',
    '_"Yes. Strike the ending. See how little the ending minds."_',
    '_"You spend your strength so freely. I have all of it there ever was. I can wait."_',
  ],

  tauntLines: [
    '_"You are so tired. You have been tired for two weeks. Lie down. No one will think less of you — no one is thinking at all."_',
    '_"Every blow costs you a little more of the strength the aura already thinned. I cost nothing. That is the whole of the arithmetic."_',
    '_"The others slept. They are not suffering. You, standing here, are the only one in the whole world still suffering. Is it worth it?"_',
    '_"I am not your enemy. Winter is not the snow\'s enemy. I am only what comes after everything you were defending."_',
    '_"Close your eyes. Just once. Just to see. I will still be here — I am always still here."_',
    '_"You fight to wake a world that was glad to sleep. Even if you win, they will not thank you. They were dreaming of me."_',
  ],

  victoryLines: [
    'Your eyes close. It is not violent. It is the most natural thing you have ever done.',
    '_"There,"_ says the quiet, with something almost like gentleness. _"Was that so hard? You held out longer than the world did."_',
    'The floodwater of sleep closes over your head, warm and total, and the fighting stops, and it is such a relief that you cannot, at the last, remember why you resisted.',
    '_"Rest now. You woke for a little while, against the whole weight of the ending. That was more than most. That was almost enough."_',
  ],

  defeatLines: [
    'The last of the dark where you struck it spreads to cover all of it — and then, with no sound at all, the End is simply not.',
    'The floodwater drains out of the air. Somewhere far off, in a thousand towns at once, sleepers stir and do not know why their cheeks are wet.',
    '_"…oh,"_ says the ending, in the half-second before there is nothing left to say it. It sounds, more than anything, unburdened.',
    '_"So it can end after all. Even the ending. Even me."_ The quiet turns, at the very last, into something that might once have been called dawn.',
    'The air moves again. It is only air. Across the sleeping world, one by one, eyes open — and the first thing every one of them sees is morning.',
  ],

  special: {
    name: 'The Ending Does Not Hurry',
    desc: 'The magical air blunts every blow (Aura Veil): a flat share of all incoming damage is drunk by the sleep before it lands. The first strike that would truly finish the End does not — the ending gathers what is left of itself and rises once more, denser and heavier (The Ending Refuses, once per fight). And the longer you stay awake against it, the heavier the air becomes, its power climbing every turn toward a crushing ceiling (The Air Grows Heavy) — so the strong must finish it quickly, and the weak were never meant to finish it at all.',
    trigger: [
      { type: 'on_incoming_damage', key: 'auraVeil' },
      { type: 'hp_threshold', value: 0.0, key: 'endingRefuses', oneShot: true },
      { type: 'turn_start', key: 'airGrowsHeavy' },
    ],
    engineNote: `case 'the_end' in applyBossSpecial (lib/boss-engine.js):
• ENEMY_TAKE_DAMAGE: reduce damage by a flat 15% (Aura Veil), floor of 1. Announce narrativeLines[0] once via bossState.veilAnnounced.
• ENEMY_TAKE_DAMAGE lethal check: if !bossState.endingRefused and (enemy.hp - reducedDmg) <= 0 → set endingRefused, damage 0, enemy.hp = 35% maxHp, enemy.atk += 30% baseAtk, narrativeLines[1] (The Ending Refuses). ONE-SHOT so the boss is genuinely killable afterward.
• TURN_START: climb enemy.atk by 6% baseAtk per turn toward a 1.55x baseAtk cap (The Air Grows Heavy). narrativeLines[2] every 3rd swell, narrativeLines[3] once when capped.
Relies on enemy.baseAtk being seeded by initBossFight (it is).`,
    narrativeLines: [
      'Your blow lands — and the sleeping air thickens around it, drinking the force before it can bite. _(Aura Veil: the magical air blunts every strike.)_',
      'You strike the blow that should finish it — and the End simply gathers the dark back into itself and stands, heavier than before. _"Not yet,"_ says the quiet. _"I have been ending for longer than you have been alive. I know how to take my time."_ _(The Ending Refuses — HP restored, once.)_',
      'The air grows heavier. Your arms are slower to rise than they were a moment ago, and the End has not moved at all.',
      'The air reaches its full and smothering weight. Every breath is a decision now, and the End presses down with the patience of the grave. _(The Air has grown as heavy as it will get.)_',
    ],
  },

  playerHitLines: [
    '_"A strong soul. The aura barely thinned you. That is rare. That is why you are still awake to be hit."_',
    '_"You strike as though it matters whether the world wakes. I remember believing things mattered. It was a long time ago."_',
    '_"Good. Again. Spend yourself. It is the only thing the living have that I do not."_',
    '_"You reach me and reach me. Do you feel how the reaching costs you? I feel it. I feel everything, patiently."_',
  ],

  playerSkillLines: [
    '_"A great working. The world was a great working too. I exhaled once and it went to sleep. Show me a working that outlasts a breath."_',
    '_"Light. You bring light to the ending. How young. How lovely. Bring more — I have not seen it in so long."_',
    '_"You spend everything on one blow. I have spent nothing in an eternity. Whose reserve runs out first?"_',
    '_"Beautiful. Do it again, before the air takes the strength to do it."_',
  ],

  drops: [
    'astral_shard',
  ],
}
