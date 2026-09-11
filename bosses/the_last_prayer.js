/**
 * The Last Prayer — Season 1 "End" boss (co-op).
 * Grade: SSS+ (for ATK scaling) | Floor: 50 | Location: season_01_ruins
 *
 * NOT a person. A choir of the drowned dead, still kneeling before an altar
 * that stopped answering centuries ago. It does not fight to kill you — it
 * fights because you have interrupted the prayer, and the prayer has never,
 * once, been allowed to end.
 *
 * Combat stats are pinned via `statOverride` (see lib/boss-engine.js) because
 * this boss sits at floor 50, far below the 65–100 boss-balance curve that
 * would otherwise clamp it to the minimum 10k HP. Its difficulty is deliberate
 * attrition — Faith Barrier, The Prayer Continues, The Tide Rises — so that
 * even a no-cooldown revive like Mei's cannot simply outlast it.
 */

export const the_last_prayer = {
  id: 'the_last_prayer',
  name: 'The Last Prayer',
  floor: 50,
  grade: 'SSS+',
  emoji: '🕯️',
  image: null,

  // Pinned combat stats — bypass the floor curve entirely (see boss-engine).
  // Tuned for a 3-player party (MAX_PARTY_SIZE) where one slot is often a Mei
  // support: ~105k effective HP after Faith Barrier + the one revive, roughly
  // 2x the hardest solo boss. Hard, but a coordinated party wins.
  statOverride: { hp: 50000, def: 400, atk: 1900 },

  hp: 50000,
  maxHp: 50000,
  atk: 1900,
  def: 400,
  exp: 12000,
  gold: 2600,
  type: 'holy',
  weakTo: [],
  resistTo: ['holy', 'physical', 'shadow'],

  personality: 'reverent-sorrowful-implacable',
  voice: 'A thousand drowned voices speaking as one, half a beat out of time — the way a congregation reads a verse it has read ten thousand times. Never angry. Only devout.',

  lore: `There was a god here once. Or something the drowned took for a god. When the water came it did not stop for the altar, and the choir did not stop for the water — they knelt and they sang as the flood filled their lungs, certain the verse would be answered before the last candle drowned.

It was not answered. The candle drowned. They kept singing.

That was six hundred years ago. The altar has heard nothing since, and the choir has not once considered that this means anything. To stop would be to admit the prayer was never heard. So they kneel in the dark under the ruins, water in their chests, and they hold the same note they held the night they died, waiting for a reply that will not come — and cannot, now, ever be allowed to be wrong.

You are not an enemy to them. You are an interruption. And an interruption, to a faith this total, is simply another thing to outlast. It has outlasted the sea. It has outlasted its god. It intends to outlast you.`,

  entrance: [
    'Candlelight that should not burn underwater gutters to life across a drowned nave.',
    'A thousand kneeling shapes do not turn to look at you. They have not turned in six hundred years.',
    '"…and deliver us," they sing, all of them, half a beat out of time, "for we have not finished asking."',
    'The note does not break as you step forward. It only makes room for you inside it.',
    '"You have come to end the prayer." A pause the size of a held breath. "Others came to end it too. Kneel, or be knelt. The verse continues either way."',
  ],

  phases: {
    75: [
      'A blade goes through the choir and the choir does not stop singing.',
      '"You strike the singers," they observe, without reproach. "The singers were never the prayer."',
      'The candlelight brightens. The water grows heavier, the way faith grows heavier when it is tested and refuses to break.',
    ],
    50: [
      'Half the choir has fallen silent. The other half sings twice as loud to cover the gap.',
      '"Do you hear? We do not falter. A voice lost is a voice the rest must carry. We have carried the drowned for six centuries. We can carry a little longer."',
      'The tide in the nave rises to your knees. It is very cold, and it is climbing.',
    ],
    25: [
      'Almost nothing left kneeling. And still — impossibly, from the black water — the note holds.',
      '"You are close now. You believe you are close." The voices are fewer, and somehow vaster. "But the prayer was never the mouths that spoke it. Cut every throat in this nave and one word will still be waiting in the dark for its answer."',
      '"Come and cut it, then. Come and try to make the silence."',
    ],
  },

  attacks: [
    'Chorus of the Drowned',
    'The Held Note',
    'Litany of the Unanswered',
    'Candle-Drowning',
    'Verse Without End',
  ],

  attackNarratives: {
    'Chorus of the Drowned': [
      'Every voice bends toward you at once.',
      'It is not sound. It is the pressure of a thousand people needing the same thing harder than you have ever needed anything.',
      'The nave floods to your chest in the space of the note.',
      'You are not struck so much as included — folded into the verse whether you consent or not.',
    ],
    'The Held Note': [
      'One voice rises out of the choir and simply does not stop.',
      'It holds. It holds past where lungs would fail, past where sound should thin.',
      'The air in front of it turns solid with insistence.',
      'The note reaches you as a wall and the wall does not ask permission.',
    ],
    'Litany of the Unanswered': [
      'They begin to list. Names. Pleas. Six hundred years of unanswered asking, spoken very fast, all at once.',
      'Each unanswered prayer is a small weight and there are more of them than there are seconds in your life.',
      'The litany falls on you like silt settling on the drowned — softly, endlessly, until you cannot lift your arms.',
    ],
    'Candle-Drowning': [
      'A candle gutters. The choir inhales as one — the breath they took the night the water came.',
      'The flood answers the breath. It rises to snuff the flame and takes the room with it.',
      'For one heartbeat you understand exactly what it is to kneel and keep singing as the water closes over your mouth.',
    ],
    'Verse Without End': [
      'They reach the last line of the prayer. They do not stop at the last line.',
      'The verse loops back into itself, gathering force each time it refuses to conclude.',
      'It rolls through you again, and again, each pass heavier than the last —',
      '"—and deliver us, and deliver us, and deliver us—" It does not resolve. It is not going to resolve.',
    ],
  },

  dodgeLines: [
    '"You move. The drowned learned to stop moving long ago."',
    '"Evasion. As if there were somewhere in this nave the water does not reach."',
    '"You dodge the singers. You cannot dodge the song."',
    '"Quick. Faith is quicker, and it never tires."',
  ],

  hitLines: [
    '"A voice falls silent." The rest do not. "Continue."',
    '"You wound the choir. The prayer does not bleed."',
    '"Yes. Strike. We have been struck by an ocean; you are a smaller sea."',
    '"That was a life you ended. We stopped counting ours centuries ago."',
  ],

  tauntLines: [
    '"How long can you keep this up? We have kept it up for six hundred years."',
    '"You fight to make us stop. We do not know how to stop. No one ever taught us the word for it."',
    '"Every blow you land, we simply pray louder. Do you see? You are helping the verse along."',
    '"You will grow tired. You will grow old. The prayer will still be here, holding the same note, waiting."',
    '"Kneel. It is easier. It was easier for all of them, in the end."',
    '"You cannot kill a thing that does not believe it is dying. We have not believed it once in six centuries."',
  ],

  victoryLines: [
    '"…and deliver us." The note closes over you gently, the way water closes over a candle.',
    '"You asked for silence. The prayer gives you the only silence it knows." The nave goes dark.',
    '"Do not struggle. You are part of the verse now. You always were."',
    '"Rest. You interrupted us for a little while. It was almost like being answered."',
  ],

  defeatLines: [
    'The last voice reaches the end of the line — and, for the first time in six hundred years, does not begin again.',
    'The candlelight steadies. The water stops climbing. Something that has been held, unbearably, for centuries, is finally set down.',
    '"…oh," says the silence where the choir was. It sounds, more than anything, relieved.',
    '"The prayer is ended." A pause with no held breath after it. "Thank you. We could not have stopped ourselves."',
    'The altar, at long last, answers — not with a god, but with quiet. It is enough. It was always going to have to be enough.',
  ],

  special: {
    name: 'The Prayer That Will Not End',
    desc: 'Faith is armor. The nearer the choir comes to death, the harder its devotion — incoming damage is reduced more sharply the lower its HP (Faith Barrier). The first blow that would silence it does not: the prayer is taken up anew, HP restored and the choir rising in fervour (The Prayer Continues, once per fight). And the drowned tide never recedes — its power climbs every turn, so a party that cannot end it quickly is worn down no matter how many times it revives its own (The Tide Rises).',
    trigger: [
      { type: 'on_incoming_damage', key: 'faithBarrier' },
      { type: 'hp_threshold', value: 0.0, key: 'prayerContinues', oneShot: true },
      { type: 'turn_start', key: 'tideRises' },
    ],
    engineNote: `case 'the_last_prayer' in applyBossSpecial (lib/boss-engine.js):
• ENEMY_TAKE_DAMAGE: reduce damage by 0.12 + (1 - hp/maxHp)*0.38, capped 0.40 (Faith Barrier). Announce narrativeLines[0] once via bossState.barrierAnnounced.
• ENEMY_TAKE_DAMAGE lethal check: if !bossState.prayerContinued and (enemy.hp - reducedDmg) <= 0 → set prayerContinued, damage 0, enemy.hp = 40% maxHp, enemy.atk += 25% baseAtk, narrativeLines[1] (The Prayer Continues).
• TURN_START: climb enemy.atk by 7% baseAtk per turn toward a 1.55x baseAtk cap (The Tide Rises). narrativeLines[2] every 3rd swell, narrativeLines[3] once when capped.
Relies on enemy.baseAtk being seeded by initBossFight (it is).`,
    narrativeLines: [
      'Your blow lands — and the water thickens around it, the choir\'s certainty hardening into something a blade struggles to part. _(Faith Barrier: the closer to death, the harder to strike.)_',
      'You strike the killing blow — and the note simply passes to the next throat. The choir surges back from the dark, water streaming from a thousand reopened mouths. "The prayer continues," they sing, louder than before. _(HP restored — The Prayer Continues.)_',
      'The tide in the nave climbs another hand-span, and the singing rises to meet it. Every voice is heavier than it was a moment ago.',
      'The drowned tide reaches its full and terrible height. The choir sings at the very top of six hundred years of grief — and it will not fall from here. _(The Tide has fully risen.)_',
    ],
  },

  playerHitLines: [
    '"That was a strong voice you silenced. It will be missed in the harmony."',
    '"You strike like someone who believes it will matter. We admire that. We remember it."',
    '"Good. Strike again. The verse has room for your effort too."',
    '"You are trying so hard to make us stop. It is almost a kind of prayer itself."',
  ],

  playerSkillLines: [
    '"A great working. The sea was a great working too, once. It did not end us."',
    '"You reach for power. We reach for the same thing you do — to be answered. We simply started earlier."',
    '"Beautiful. Terrible. Sing it again."',
    '"You spend everything on one line. We have spent centuries on one line. Whose devotion is deeper?"',
  ],

  drops: [
    'severing_elixir',
    'kisuke_benihime',
    'mei_prayer_charm',
    'astral_shard',
  ],
}
