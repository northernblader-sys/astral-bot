/**
 * Dio Brando - The World
 * Grade: SS+ | Floor: 75
 * JoJo's Bizarre Adventure
 */

export const dio_brando = {
  id: 'dio_brando',
  name: 'Dio Brando',
  floor: 75,
  grade: 'SS+',
  emoji: '🦇',
  image: null,
  hp: 45000,
  maxHp: 45000,
  atk: 2100,
  def: 800,
  exp: 22000,
  gold: 16000,
  type: 'shadow',
  weakTo: ['holy', 'fire'],
  resistTo: ['physical', 'ice', 'shadow'],

  personality: 'grandiose-cruel-theatrical',
  voice: 'Rich and contemptuous, every word placed like a chess piece.',

  lore: `He clawed his way out of nothing. A street dog given education, given a family, given everything he did not earn and intended to take. He chose ambition over humanity literally, trading his life for immortality and never once looking back.

The World is the most powerful close-range Stand of its era. Five seconds of stopped time. In those five seconds, Dio alone can move. He loads those seconds with knives, fists, a road roller if one is available. He does not fight. He executes.

He became a vampire and then more than a vampire. He survived a century in pieces at the bottom of the ocean. He returned. He always returns. He has never accepted a single outcome he did not choose.

He will tell you this himself, at length, while punching you repeatedly.`,

  entrance: [
    '"So you have come this far." He stands with one foot up on a stone, looking down.',
    '"Impressive, in the way that dogs learning to open doors are impressive."',
    '"I am Dio." He removes his hat and sets it aside with care.',
    '"You have made it to my floor. That is all I will compliment you on."',
    '"THE WORLD." He calls his Stand and the shadows around him solidify into presence.',
  ],

  phases: {
    75: [
      '"You are getting on my nerves." He sounds irritated rather than impressed.',
      '"THE WORLD, attend."',
      '"I will stop toying with you. That was never your gift anyway."',
    ],
    50: [
      '"Interesting. You are still upright." He touches his own face.',
      '"I have not had to stop time twice in one fight in... quite some time."',
      '"Consider yourself memorable. Then consider yourself finished."',
    ],
    25: [
      '"ZA WARUDO." He says it quietly for once.',
      '"You want to end Dio? THEN COME AND END ME."',
      '"I have lived through worse than you. I have survived century-long deaths. I do not fall."',
    ],
  },

  attacks: [
    'Za Warudo: Time Stop',
    'Knife Volley',
    'Vampiric Drain',
    'Road Roller Drop',
    'Vaporization Strike',
  ],

  attackNarratives: {
    'Za Warudo: Time Stop': [
      '"ZA WARUDO." He says it like a verdict.',
      'Time stops.',
      'You cannot perceive what happens in those seconds.',
      'When time resumes you are in a different place and hurting considerably more.',
      'He stands behind you. "TOKI WO TOMARE." He sounds pleased.',
    ],
    'Knife Volley': [
      'During a moment of stopped time, knives appear.',
      'Then time resumes and all of them are already in transit.',
      'Twelve knives from twelve angles.',
      'You block some. The ones you do not find you.',
      '"Knives. Simple. Effective. I do not need complexity to defeat you."',
    ],
    'Vampiric Drain': [
      'He closes the distance faster than vision allows.',
      'One hand finds your neck.',
      'The vampiric pull is immediate. Not blood. Energy. Life.',
      'You feel the drain before you feel the grip.',
      'He takes HP. He heals for the same amount. He lets go.',
    ],
    'Road Roller Drop': [
      '"WRYYYYY!" He produces, from somewhere, a road roller.',
      'This is not a figure of speech.',
      'The impact of it on your position is followed immediately by his fists from above.',
      '"MUDA MUDA MUDA MUDA MUDA MUDA!"',
      'The combination of heavy machinery and Stand barrage is as bad as it sounds.',
    ],
    'Vaporization Strike': [
      'He channels vampiric energy through his palm.',
      'Contact vaporizes tissue on impact.',
      'He does not aim for your weapon or your armor.',
      'He aims for wherever you are most relying on being intact.',
      'The strike lands and the damage is the kind that does not look bad until suddenly it is very bad.',
    ],
  },

  dodgeLines: [
    '"You moved. Lucky."',
    '"Hmph. Spry little thing."',
    '"That was the last time I allow that to happen."',
    '"Speed means nothing inside stopped time."',
  ],

  hitLines: [
    '"Wryyy..." He is more annoyed than hurt.',
    '"You hit me. Note that this changes nothing."',
    '"An actual blow. Fine. Fine." He rolls his neck.',
    '"You have my attention now. Is that what you wanted?"',
  ],

  tauntLines: [
    '"This entire fight is beneath me and yet here we both are."',
    '"MUDAMUDAMUDAMUDA! Do you understand what that means? It means futile."',
    '"I have conquered death itself. What exactly is your plan?"',
    '"You hit like someone who has never encountered a true villain."',
    '"Kneel. I do not say that because I need you to. I say it because I want to watch you refuse."',
  ],

  victoryLines: [
    '"As expected." He straightens his collar.',
    '"You fought well for what you are. That is a compliment. Take it."',
    '"WRYYY." He says it at moderate volume. It is his version of goodbye.',
    '"I will remember your face. I remember everyone who amused me."',
  ],

  defeatLines: [
    '"Im... possible." He says it as one word.',
    '"Dio does not fall." He says it firmly.',
    'Then he falls.',
    '"WRYYY..." Quietly. Then silence.',
    '"This world... was mine to stand above..." He reaches for the ceiling.',
  ],

  special: {
    name: 'The World: Time Erasure',
    desc: 'At the start of turn 5, turn 10, and turn 15, Dio stops time. The player takes guaranteed damage equal to 25% of their current HP (cannot be dodged, cannot be defended against, cannot be reduced). This represents the knife volleys during stopped time. The player receives a one-turn warning ("Za Warudo charges...") the turn before each trigger.',
    trigger: [
      { type: 'turn_exact', values: [4, 9, 14], key: 'timestopWarning' },
      { type: 'turn_exact', values: [5, 10, 15], key: 'timestopStrike' },
    ],
    engineNote: `Track bossState.turn. On warning turns (4, 9, 14): append "ZA WARUDO... (Time stops next turn)" to the combat message. On strike turns (5, 10, 15): before any other combat resolution, deal Math.floor(player.hp * 0.25) guaranteed damage bypassing all defenses and evasion. Show time-stop narrative. Then proceed with normal turn resolution. This fires regardless of player action that turn.`,
    narrativeLines: [
      '"ZA WARUDO... time stops next turn."',
      '"ZA WARUDO. TOKI WO TOMARE." Time stops.',
      'In the stopped seconds, knives find you. Every one of them.',
      '"Time resumes." He watches you realize the damage.',
    ],
  },

  playerHitLines: [
    '"Wryyy." Mildly.'  ,
    '"You managed to hit me. Surprising."',
    '"An actual blow. Do not get comfortable with that."',
    '"Interesting technique. Ineffective ultimately."',
  ],

  playerSkillLines: [
    '"A Stand user\'s technique? No. Just a skill. Hmph."',
    '"Effective output. Irrelevant in stopped time."',
    '"Your techniques have style. I appreciate style. Not enough to lose."',
    '"Strong. You are genuinely strong. This is almost a compliment."',
  ],

  drops: [
    'the_world_fragment',
    'dio_knives',
    'vampiric_eye_stone',
    'timestop_residue',
    'brando_crest',
  ],
}
