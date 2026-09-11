/**
 * Aizen Sosuke - The Great Pretender
 * Grade: SS+ | Floor: 81
 * Bleach
 */

export const aizen_sosuke = {
  id: 'aizen_sosuke',
  name: 'Aizen Sosuke',
  floor: 81,
  grade: 'SS+',
  emoji: '🦋',
  image: null,
  hp: 58000,
  maxHp: 58000,
  atk: 2900,
  def: 2200,
  exp: 29000,
  gold: 20000,
  type: 'shadow',
  weakTo: [],
  resistTo: ['physical', 'magic', 'shadow', 'holy', 'fire', 'ice'],

  personality: 'supremely-calm-manipulative',
  voice: 'Silken and precise. He sounds like someone teaching a class in a building he is about to burn down.',

  lore: `He planned for a century. Not approximate century-level plans: a specific, authored, hundred-year arc with himself at the top. He fooled every captain in the Gotei 13 for that entire time. He killed the man they all thought was the enemy before any of them realized who the real enemy was.

Kyoka Suigetsu is total hypnosis. Anyone who has seen his Zanpakuto release activates it automatically. He can control all five senses: make you see, hear, feel, smell, or taste anything he chooses. He once made an army fight each other by making them perceive different enemies.

The Hogyoku evolved him beyond that. He does not need hypnosis anymore. His reiatsu density is strong enough to kill a captain on proximity alone. He regenerates. He transcends. He is bored by limits.

He came to this floor because it offered something more entertaining than everything else available to him. That thing is you.`,

  entrance: [
    'He is already standing in the center of the room when you enter.',
    'His arms are folded behind his back.',
    '"You have been expected." He turns around.',
    '"I must say, you are more interesting up close." He studies you.',
    '"Shall we begin? I promise this will be more educational than you expect."',
  ],

  phases: {
    75: [
      '"Excellent. You are competent." He allows a small smile.',
      '"Kyoka Suigetsu has already been released. At some point in the past." He adds this casually.',
      '"The question is: what have you been seeing since then?"',
    ],
    50: [
      '"Hogyoku: evolving." The butterfly-like reishi pattern around him shifts.',
      '"My body is transcending the limits of Shinigami and Hollow." He watches himself.',
      '"This is what it feels like to surpass definition."',
    ],
    25: [
      '"Transcendence complete." He is perfectly still.',
      '"What I am now has no category." He says it with satisfaction.',
      '"Come. I want to see if you can touch what I have become."',
    ],
  },

  attacks: [
    'Kyoka Suigetsu Illusion',
    'Reiatsu Pressure Wave',
    'Hado 90: Kurohitsugi',
    'Hogyoku Regeneration Strike',
    'Transcendent Blade',
  ],

  attackNarratives: {
    'Kyoka Suigetsu Illusion': [
      '"Your senses are mine." He says it conversationally.',
      'The attack comes from a direction that is not the direction he is standing.',
      'You hit the after-image he left in your perception.',
      'He hits you from the real direction.',
      '"Complete hypnosis. You cannot trust what you see."',
    ],
    'Reiatsu Pressure Wave': [
      'He does not move.',
      'His reiatsu expands outward.',
      'The spiritual pressure of a transcendent being physically compresses you.',
      'Your HP does not go down from a strike. It goes down from proximity to something too vast.',
      '"I do not need to hit you with technique. I hit you with what I am."',
    ],
    'Hado 90: Kurohitsugi': [
      '"Hado 90." He raises one finger.',
      '"Black Coffin." The space around you fills with black reishi.',
      'A box of compressed gravity and darkness forms around your position.',
      'The internal pressure of the Black Coffin does its work.',
      '"Incidentally, I used no incantation. The Hogyoku made incantations redundant."',
    ],
    'Hogyoku Regeneration Strike': [
      'You land a significant hit.',
      'He heals completely in the same second.',
      '"The Hogyoku evolved my body beyond conventional injury." He continues fighting.',
      'The counter he follows with carries the frustration of your wasted effort.',
      '"You have to do something the Hogyoku cannot repair." He says this helpfully.',
    ],
    'Transcendent Blade': [
      'He draws Kyoka Suigetsu.',
      'The blade does not look different. The force behind it is.',
      'He is beyond Shinigami and Hollow and what that means for his striking power is: more.',
      'The blade cuts through the space you are in and the space you were about to be in.',
      '"Transcendence. A blade with no ceiling strikes without ceiling."',
    ],
  },

  dodgeLines: [
    '"Good evasion." He acknowledges it. "Was it real?"',
    '"You moved. Or did I let you think you moved?"',
    '"Excellent reaction. Genuine or induced? Interesting question."',
    '"You evaded correctly. That is real. I confirm it." He sounds gracious.',
  ],

  hitLines: [
    '"A real hit." He straightens his glasses.',
    '"Good output." He does not react physically beyond acknowledgment.',
    '"That one reached me before the Hogyoku compensated." He notes the timing.',
    '"Strong technique." He evaluates it like a collector assessing an interesting piece.',
  ],

  tauntLines: [
    '"Everything you have done since entering this room may be exactly what I intended you to do."',
    '"I am not lying to you now. I have no reason to. Everything I say is therefore suspect."',
    '"My reiatsu is dense enough to cause injury through proximity. Stay close."',
    '"You cannot defeat someone who planned for every contingency. Can you find the one I missed?"',
    '"Interesting technique. I have been studying it since you first arrived. Thank you for the demonstration."',
  ],

  victoryLines: [
    '"As intended." He smoothes his sleeve.',
    '"You fought intelligently. That is the highest compliment I can offer."',
    '"Come back. I want to see what you choose to try next time."',
    '"You are an interesting variable." He departs.',
  ],

  defeatLines: [
    'He is quiet for a long moment.',
    '"You found the contingency I missed." He says it without anger.',
    '"I did not plan for you." A pause. "That is remarkable."',
    '"All these centuries of planning." He looks at his hand. "You are not in my plans."',
    '"Interesting." He settles. "Very interesting." He sounds like he is starting to plan again.',
  ],

  special: {
    name: 'Complete Hypnosis',
    desc: 'Once per fight (at 60% HP), Aizen activates Kyoka Suigetsu. For 3 turns, the player\'s dodge chance is reversed: hits that would have missed now land, and hits that would have landed now miss. This represents sensory inversion. The player can "break" hypnosis by defending for one full turn (closing their eyes removes the visual dependency).',
    trigger: [
      { type: 'hp_threshold', value: 0.60, key: 'completeHypnosis', oneShot: true },
    ],
    engineNote: `On trigger: set bossState.hypnosisActive = true, bossState.hypnosisTurns = 3. While active: invert player hit/miss calculation (if roll > calcPlayerHitChance, it hits instead of misses; if roll < calcPlayerHitChance, it misses instead of hits). Also invert enemy hit/miss: flip the outcome of calcMonsterHitChance. Decrement hypnosisTurns each turn. On player defend: clear hypnosisActive, show hypnosis-break line. Show hypnosis announce and turn reminder.`,
    narrativeLines: [
      '"Kyoka Suigetsu: completely hypnotize." Your senses invert.',
      '"You cannot trust what you see right now." His voice comes from everywhere.',
      '"Your defense clears your head." The hypnosis breaks.',
      '"Three turns of unreliable perception." He watches.',
    ],
  },

  playerHitLines: [
    '"A real hit. Acknowledged."',
    '"That one was genuine." He files it.',
    '"Good technique." He studies the result.',
    '"Strong output. Hogyoku is noting it."',
  ],

  playerSkillLines: [
    '"An interesting technique. I have been analyzing it."',
    '"Strong skill. Well executed."',
    '"Your technique has real output. Acknowledged."',
    '"Impressive form." He means this sincerely.',
  ],

  drops: [
    'kyoka_suigetsu_shard',
    'hogyoku_fragment',
    'kurohitsugi_residue',
    'transcendence_crystal',
    'aizen_captain_badge',
  ],
}
