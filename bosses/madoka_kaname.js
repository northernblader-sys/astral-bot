/**
 * Madoka Kaname - The Law Beyond Despair
 * Grade: SSS+ | Floor: 98
 * Puella Magi Madoka Magica
 */

export const madoka_kaname = {
  id: 'madoka_kaname',
  name: 'Madoka Kaname',
  floor: 98,
  grade: 'SSS+',
  emoji: '🌸',
  image: null,
  hp: 170000,
  maxHp: 170000,
  atk: 5500,
  def: 5000,
  exp: 76000,
  gold: 51000,
  type: 'divine',
  weakTo: [],
  resistTo: ['physical', 'magic', 'fire', 'ice', 'shadow', 'holy', 'void', 'time'],

  personality: 'gentle-absolute-transcendent',
  voice: 'Soft and certain. Every line sounds like it was already true before she said it.',

  lore: `She did not want power. She wanted to help. She wished for the power to erase all witches across every timeline, past and future, before they could be born. The wish was so vast that she became a concept rather than a person. She transcended the universe.

She became the Law of the Cycle: the force that collects magical girls at the moment of their death, before they can fall to despair. She gave up her individual existence to become a constant in the fabric of reality.

She can fire an infinite number of arrows simultaneously. Each arrow exists across every timeline. The wish she made was one sentence and it rewrote causality.

She is here as a concept made briefly present. She does not feel good about fighting. She will do it anyway. She will not apologize for the arrows.`,

  entrance: [
    'Pink light fills the room before she appears.',
    'She is there suddenly, not arriving, just present.',
    '"Oh." She looks at you with clear eyes. "You are still here."',
    '"I am sorry." She raises her bow. "I hope this does not hurt for long."',
    'The arrows appear. Infinite arrows. All at once. All existing.',
  ],

  phases: {
    75: [
      '"You are still here." She sounds like this is the most important thing.',
      '"I will be more careful." She focuses.',
      '"Please do not give up. But also please understand what you are fighting."',
    ],
    50: [
      '"Half." She lowers her bow for one moment.',
      '"You have exceeded what the Law projected." She raises it again.',
      '"The Cycle adjusts for you." The arrows multiply.',
    ],
    25: [
      '"You are extraordinary." She says it plainly.',
      '"I am going to give this everything." She breathes.',
      '"I am sorry." She says it one more time. "I always say that."',
    ],
  },

  attacks: [
    'Arrow of Erase',
    'Infinite Volley',
    'Law Pulse',
    'Cycle Reset',
    'Universe Bow: Final Form',
  ],

  attackNarratives: {
    'Arrow of Erase': [
      'She nocks one arrow.',
      'The arrow is pink light and the weight of a wish.',
      'She releases.',
      'The arrow exists across all timelines. Wherever you dodge to, it has already been.',
      'Evasion is a matter of which timeline you choose to exist in at the moment of impact.',
    ],
    'Infinite Volley': [
      'She draws back the bow.',
      'Every arrow she has ever fired and every arrow she ever will fire fills the sky.',
      'They fall.',
      'There is nowhere that is not an arrow.',
      'You take some of them. You cannot take none of them.',
    ],
    'Law Pulse': [
      'The Law of the Cycle pulses outward.',
      'The pulse is not an attack. It is a reminder.',
      'It reminds your body that despair is not necessary.',
      'For combat purposes: it drains MP by pulling at the dark energy fueling your skills.',
      '"This is what I do. I collect the despair. It is what the wish made me."',
    ],
    'Cycle Reset': [
      'She resets the moment.',
      'Not your HP. The moment itself.',
      'The position you were in two turns ago was better for her.',
      'She resets to it: your last action is undone.',
      '"The Cycle has adjusted." She says it with a small bow.',
    ],
    'Universe Bow: Final Form': [
      '"Everything." She says it.',
      'The bow becomes the size of a universe.',
      'The arrows that fill it are infinite and each contains a timeline\'s worth of magical power.',
      'She draws and releases.',
      'The arrow that arrives is singular. Concentrated. Everything.',
    ],
  },

  dodgeLines: [
    '"You moved." She watches.',
    '"Good evasion." She adjusts.',
    '"The arrow has already been there." She fires another.',
    '"You are fast." She sounds like she is glad.',
  ],

  hitLines: [
    '"You hit me." She does not move back.',
    '"Real power." She absorbs it.',
    '"Strong." She continues.',
    '"You reached me." She sounds like this means something.',
  ],

  tauntLines: [
    '"I did not want this fight. I want you to know that."',
    '"The arrows exist across every timeline. There is no version of you they have not found."',
    '"I am a law. Not a person. Laws do not stop."',
    '"I am sorry." She says it between attacks.',
    '"Please do not despair. That is the only thing I ask of you."',
  ],

  victoryLines: [
    '"Rest." She lowers her bow.',
    '"You did not despair." She sounds genuinely glad.',
    '"The Cycle will collect you gently when it is time." She means it as comfort.',
    '"I am sorry." She says it again.',
  ],

  defeatLines: [
    'The arrows stop.',
    'She stands without them.',
    '"The Law was exceeded." She says it with wonder.',
    '"You exceeded the Law of the Cycle." She touches her own chest.',
    '"I am glad." She says it and means it completely. "I am so glad."',
  ],

  special: {
    name: 'Law of the Cycle',
    desc: 'Madoka exists across all timelines. Three times per fight, she can "cycle" back: if she would take damage that would reduce her HP by more than 15% in a single hit, she negates 50% of that excess (absorbs it into the cycle). This is not a block. It is the universe softening the blow. Announced after the hit: "The Cycle absorbed."',
    trigger: [
      { type: 'on_incoming_large_hit', key: 'cycleAbsorb', threshold: 0.15, maxUses: 3 },
    ],
    engineNote: `Track bossState.cycleCharges (default 3). On each player hit: if finalDmg > enemy.maxHp * 0.15 AND cycleCharges > 0: calculate excess = finalDmg - Math.floor(enemy.maxHp * 0.15). Apply enemy.hp -= Math.floor(finalDmg - excess * 0.50). Decrement cycleCharges. Show cycle-absorb line. The first 15% of max HP worth of damage always applies; only the excess is halved. This prevents one-shot attempts.`,
    narrativeLines: [
      '"The Cycle absorbs." Her excess damage is halved.',
      '"The universe softened that blow." She continues.',
      '"Cycle absorbed." Charges remaining.',
      '"No more cycle charges." She is fully open now.',
    ],
  },

  playerHitLines: [
    '"You hit me." She takes it.',
    '"Strong." She continues.',
    '"Real power." She does not stop.',
    '"You reached the Law." She notes it.',
  ],

  playerSkillLines: [
    '"A strong technique." She watches.',
    '"Real output." She adjusts.',
    '"Good skill." She fires in response.',
    '"You have real power." She says it sincerely.',
  ],

  drops: [
    'infinite_arrow_shard',
    'law_of_cycle_crystal',
    'wish_fragment',
    'timeline_dust',
    'madoka_bow_piece',
  ],
}
