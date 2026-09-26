/**
 * Rimuru Tempest - True Dragon, Demon Lord
 * Grade: SSS+ | Floor: 95
 * That Time I Got Reincarnated as a Slime
 */

export const rimuru_tempest = {
  id: 'rimuru_tempest',
  name: 'Rimuru Tempest',
  floor: 95,
  grade: 'SSS+',
  emoji: '🌀',
  image: null,
  hp: 130000,
  maxHp: 130000,
  atk: 4500,
  def: 4000,
  exp: 65000,
  gold: 43000,
  type: 'void',
  weakTo: ['holy'],
  resistTo: ['fire', 'ice', 'physical', 'poison', 'magic', 'shadow'],

  personality: 'analytical-friendly-terrifying',
  voice: 'Calm and conversational, like someone who has already run the numbers and knows exactly how this ends.',

  lore: `He started as a corporate drone who died choking on a convenience store sandwich. He woke up as a slime with no eyes, no limbs, and one ridiculous skill: Predator.

Ten years later he is a Demon Lord, a True Dragon, and the ruler of a monster nation. He consumed the essence of the Storm Dragon Veldora and added it to himself. He consumed the skills and souls of gods. His advisor is an omniscient Great Sage who calculates combat solutions in real time.

Rimuru does not fight with brute force. He fights like a system: analyze, absorb, replicate, optimize. Every attack he takes is data. Every technique you reveal is a gift. The longer the fight goes, the worse your situation becomes.

He is also genuinely nice about it. He will apologize while ending you.`,

  entrance: [
    'Something small and blue rolls into the room.',
    'It shifts, expands, and resolves into the form of a slender person with silver-blue hair.',
    '"Hey! You are strong, I can tell already." They wave cheerfully.',
    '"My name is Rimuru Tempest, Demon Lord and ruler of the Jura Tempest Federation."',
    '"I am going to fight you for real now, so do your best, okay? Raphael, analysis start."',
  ],

  phases: {
    75: [
      '"Raphael is flagging some of your techniques as worth studying. Keep that up."',
      'The air around Rimuru shifts and a faint golden light outlines their form.',
      '"Let me try some of what you just showed me back at you."',
    ],
    50: [
      '"Okay. This is getting serious." The playful tone does not change. The power does.',
      'Silver scales trace their arms and their eyes shift to those of a dragon.',
      '"Storm Dragon mode is online. Raphael, upgrade processing speed."',
    ],
    25: [
      '"All right. Final form." They exhale slowly.',
      '"Void God Azathoth. All limiters removed." The room dims.',
      '"I really am sorry about this part. I will make it quick."',
    ],
  },

  attacks: [
    'Predator Absorption',
    'Mega Fireball Cascade',
    'Ultraspeed Clone',
    'Storm Dragon Breath',
    'Harvest Lord Pulse',
  ],

  attackNarratives: {
    'Predator Absorption': [
      'Rimuru extends one hand, palm open.',
      'A vortex of matter pulls everything within range toward that palm.',
      'It eats your attack, your energy, a piece of your momentum.',
      'They absorb it and you watch their aura shift to incorporate what you just threw.',
      '"Analyzed. Thank you for that."',
    ],
    'Mega Fireball Cascade': [
      'Twenty fireballs orbit Rimuru at low altitude.',
      'They launch in sequence, not all at once, staggered for maximum coverage.',
      'Dodging the first creates the problem of the second.',
      'The third one was already past your guard.',
      '"Replicated from a flame dragon. Pretty good heat, right?"',
    ],
    'Ultraspeed Clone': [
      'They split into six copies without warning.',
      'All six attack at the same time from different angles.',
      'Five are not real. One is. You cannot tell which.',
      'Getting it wrong hurts significantly.',
      '"Raphael said you had a sixty-three percent chance of picking wrong. She is usually right."',
    ],
    'Storm Dragon Breath': [
      'They pull their head back and the storm gathers in their throat.',
      'The breath that comes out is Veldora\'s. The full thing. The god-dragon\'s storm.',
      'It fills the width of the room and the air inside it is made of lightning.',
      'You find cover and the aftermath still scorches you through solid stone.',
      '"That one always feels intense. Sorry."',
    ],
    'Harvest Lord Pulse': [
      'They press both hands together.',
      'A dome of energy expands outward at floor level.',
      'Where it passes, your active buffs are absorbed. Your MP ticks down faster.',
      'The pulse harvests energy from everything in the room and redirects it.',
      '"Shub-Niggurath\'s ultimate. Sounds worse than it is. Actually it sounds accurate."',
    ],
  },

  dodgeLines: [
    '"Predicted but still impressive!"',
    '"Raphael had you at forty percent dodge chance on that one. Good job proving her right."',
    '"You are fast. Genuinely fast."',
    '"Nice movement. I am adding that to the database."',
  ],

  hitLines: [
    '"Ow. Okay. That was good." They brush off the impact.',
    '"Absorbed. Analyzing." They tilt their head.',
    '"Good power output. Raphael is upgrading threat assessment."',
    '"That one stung! Well done."',
  ],

  tauntLines: [
    '"Raphael says you have a twenty-two percent chance of winning. Better odds than most."',
    '"I really am rooting for you, which makes this awkward."',
    '"Each time you hit me you make the next fight with me harder. Fair warning."',
    '"I have fought gods. You are doing better than some of them."',
    '"Do not hold anything back. I have seen everything anyway."',
  ],

  victoryLines: [
    '"You fought well. Really." They crouch next to you. "Raphael gave you an A-minus."',
    '"Rest. No hard feelings."',
    '"Come to Tempest when you recover. My nation could use someone like you."',
    '"You pushed me to storm dragon form. Not many do that. Be proud."',
  ],

  defeatLines: [
    '"Oh." They blink.',
    '"Raphael? She is not responding. That is... new."',
    '"I have been defeated. Sincerely." They laugh, surprised.',
    '"Congratulations. You just beat a Demon Lord and a True Dragon and a Great Sage all at once."',
    '"I am going to tell everyone about this. The whole nation is going to hear."',
  ],

  special: {
    name: 'Predator Mimicry',
    desc: 'After a player uses any skill 2 times, Rimuru copies it. On Rimuru\'s next attack turn, he uses the copied skill against the player at 1.5x effectiveness (since his stats are higher). Each unique skill used after that adds to his arsenal.',
    trigger: [
      { type: 'on_skill_use', key: 'skillMimicry', threshold: 2, stackable: true },
    ],
    engineNote: `Track bossState.learnedSkills = [] and bossState.skillUseCount = {}. Each time the player uses a skill, increment bossState.skillUseCount[skillId]. When count >= 2, push skillId to learnedSkills. Once per attack turn (random 40% chance), if learnedSkills.length > 0, Rimuru "uses" a random learned skill against the player: apply the skill's damage formula at 1.5x multiplier. Show mimicry line. Clear that skill from learnedSkills after use.`,
    narrativeLines: [
      '"Oh that is a nice one. Predator, absorb."',
      '"Raphael analyzed the formula. Returning it at scale."',
      '"Your own technique, improved. Thank Predator."',
      '"I learned that from you. Thank you." They launch it.',
    ],
  },

  playerHitLines: [
    '"That one actually got through! Good job!"',
    '"Absorbed. Adding to combat data."',
    '"Solid hit. Raphael is upgrading your threat rating."',
    '"You are not holding back. Good. Neither am I."',
  ],

  playerSkillLines: [
    '"Ooh. Predator likes that one." They smile.',
    '"Nice technique. I will be borrowing that shortly."',
    '"Raphael just flagged that as high priority to analyze."',
    '"Good power curve on that skill. I can see why you use it."',
  ],

  drops: [
    'predator_essence',
    'great_sage_fragment',
    'storm_dragon_scale',
    'slime_core_crystal',
    'tempest_nation_seal',
  ],
}
