/**
 * Jotaro Kujo - Star Platinum: The World
 * Grade: SS | Floor: 67
 * JoJo's Bizarre Adventure
 */

export const jotaro_kujo = {
  id: 'jotaro_kujo',
  name: 'Jotaro Kujo',
  floor: 67,
  grade: 'SS',
  emoji: '⭐',
  image: null,
  hp: 15000,
  maxHp: 15000,
  atk: 1300,
  def: 500,
  exp: 11000,
  gold: 7500,
  type: 'physical',
  weakTo: [],
  resistTo: ['physical', 'shadow'],

  personality: 'stoic-precise-dangerous',
  voice: 'Minimal and flat. Half his lines are just "yare yare daze."',

  lore: `He stopped time for the first time at fifteen years old, in a prison, without knowing what was happening. He stayed in prison voluntarily because he thought he was possessed by an evil spirit. He was not. He had a Stand.

Star Platinum is the most precise and powerful humanoid Stand he knows of. Its speed is incomprehensible. Its punching power is measured in demolished tanks. He used it to stop time for up to five seconds.

He is a marine biologist. He has a PhD. He punches things when they require punching and does not particularly enjoy it. He considered every fight Dio put him through a nuisance. He won every single one.

"Yare yare daze" translates roughly to "good grief." He says it constantly. He means it as much as it sounds.`,

  entrance: [
    'He walks into the room with his hands in his coat pockets.',
    'He does not look at you immediately.',
    '"Yare yare daze." He adjusts his hat.',
    'He looks at you now. Directly. Star Platinum appears behind him.',
    '"This will be quick." He drops into stance.',
  ],

  phases: {
    75: [
      '"Yare yare." He is more focused now.',
      '"Star Platinum: The World." He says it like the name means something. It does.',
      '"I am going to stop holding back."',
    ],
    50: [
      '"You are stronger than you look." He pauses.',
      '"ORA." Star Platinum\'s fists flex.',
      '"Let\'s speed this up."',
    ],
    25: [
      '"Good grief." He exhales.',
      '"STAR PLATINUM: THE WORLD." Time stops.',
      '"ZA WARUDO. TOKI WO TOMARE." He says it quieter than Dio did.',
    ],
  },

  attacks: [
    'Star Platinum Barrage: ORA',
    'Star Platinum: The World',
    'Precision Strike',
    'Star Finger',
    'Magnet Force',
  ],

  attackNarratives: {
    'Star Platinum Barrage: ORA': [
      '"ORA ORA ORA ORA ORA ORA ORA ORA ORA!"',
      'Star Platinum moves at incomprehensible speed.',
      'The barrage is not fast in a normal sense. It is fast in a physics-breaking sense.',
      'Every hit is precisely aimed at the same point to concentrate damage.',
      '"Yare yare." He stops when the point is made.',
    ],
    'Star Platinum: The World': [
      '"Star Platinum: The World."',
      'Time stops.',
      'He punches once in the stopped time.',
      'A single precise punch to your center of mass.',
      '"Time resumes." The hit lands and you were not there for it.',
    ],
    'Precision Strike': [
      'Star Platinum extends one finger.',
      'The finger is moving faster than the rest of the arm.',
      'It finds the exact point on your body most likely to cause maximum disruption.',
      'Not the most painful point. The most mechanically damaging one.',
      '"Accurate to one millimeter." He says it without pride. Just fact.',
    ],
    'Star Finger': [
      'Star Platinum extends two fingers.',
      'They launch forward with the force of a fired projectile.',
      'The distance is instantaneous at Star Platinum\'s speed.',
      'The fingers hit and retract before you can grab them.',
      '"Good grief."',
    ],
    'Magnet Force': [
      'He uses Star Platinum to generate a magnetic field.',
      'Everything metal in your equipment yanks toward one point.',
      'Your gear works against your movement for two turns.',
      '"Yare yare." He watches the problem he just created.',
      '"Now come at me without being pulled in twelve directions."',
    ],
  },

  dodgeLines: [
    '"Yare yare. You moved."',
    '"Fast." He adjusts.',
    '"Good." He resets position.',
    '"You dodged. Good grief."',
  ],

  hitLines: [
    '"Yare yare daze." He takes it.',
    '"You hit me." He does not react dramatically.',
    '"Good." He continues.',
    '"Strong hit." He notes it.',
  ],

  tauntLines: [
    '"Yare yare daze."',
    '"Good grief. Are you done yet?"',
    '"You cannot win this with raw power." He means the time stop.',
    '"Yare yare. Try something smarter."',
    '"I have fought a vampire god. Calibrate."',
  ],

  victoryLines: [
    '"Good grief." He turns to leave.',
    '"Yare yare daze. Good fight."',
    '"Train more. You are not useless."',
    '"You had the right instincts. Follow them." He is gone.',
  ],

  defeatLines: [
    '"Yare yare daze." He sits down.',
    '"You beat Star Platinum." He considers this.',
    '"Good." He says it and means it.',
    '"Good grief. An actual loss." He adjusts his hat.',
    '"Well done. Yare yare." He means it as the highest praise he gives.',
  ],

  special: {
    name: 'Time Stop: 5 Seconds',
    desc: 'At the start of turn 8 and turn 16, Jotaro stops time. During stopped time, he lands exactly 5 precise hits on the player. Each hit deals ATK * 0.4 damage (5 hits total = 2x ATK equivalent). This cannot be dodged or blocked. The player receives a warning: "Star Platinum tenses up..." the turn before.',
    trigger: [
      { type: 'turn_exact', values: [7, 15], key: 'timestopWarning' },
      { type: 'turn_exact', values: [8, 16], key: 'timestopStrike' },
    ],
    engineNote: `On warning turns (7, 15): append "Star Platinum tenses up... (Time stops next turn)" to combat message. On strike turns (8, 16): before turn resolution, deal 5 hits of Math.floor(enemy.atk * 0.40) each as guaranteed true damage (bypassing defense and evasion). Total = 2x ATK. Show ORA barrage narrative. Then proceed normally with the rest of the turn. Log the five hits individually in the message for drama.`,
    narrativeLines: [
      '"Star Platinum tenses up." Warning line.',
      '"STAR PLATINUM: THE WORLD." Time stops.',
      '"ORA. ORA. ORA. ORA. ORA." Five hits in stopped time.',
      '"Time resumes." You feel all five at once.',
    ],
  },

  playerHitLines: [
    '"Good hit." He takes it.',
    '"Strong." He continues.',
    '"You got through." He notes it.',
    '"Yare yare. Real power."',
  ],

  playerSkillLines: [
    '"A technique." Star Platinum watches.',
    '"Good." He absorbs it.',
    '"Strong output." He adjusts.',
    '"Yare yare. Real skill."',
  ],

  drops: [
    'star_platinum_fist_fragment',
    'timestop_residue',
    'star_finger_shard',
    'jotaro_hat_button',
    'ora_echo_stone',
  ],
}
