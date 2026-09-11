/**
 * Anos Voldigoad - The Demon King of Tyranny
 * Grade: SSS+ | Floor: 98
 * The Misfit of Demon King Academy
 */

export const anos_voldigoad = {
  id: 'anos_voldigoad',
  name: 'Anos Voldigoad',
  floor: 98,
  grade: 'SSS+',
  emoji: '🩸',
  image: null,
  hp: 180000,
  maxHp: 180000,
  atk: 5500,
  def: 3500,
  exp: 75000,
  gold: 50000,
  type: 'demon',
  weakTo: ['holy'],
  resistTo: ['fire', 'ice', 'shadow', 'physical', 'magic', 'void'],

  personality: 'tyrannical-confident',
  voice: 'Speaks with absolute authority, as if each word is a law newly added to the universe.',

  lore: `Two thousand years ago, he ended a war by dying. He chose to reincarnate and find a world at peace. What he found instead was a world that had forgotten him, rewritten his legacy, and crowned pretenders in his name.

He is not angry about this. He is amused. He is always amused. He carries the power to destroy causality itself in one hand and uses it only when mildly inconvenienced.

Venuzdonoa, his black sword, destroys the concept of a thing rather than the thing itself. He has killed gods by erasing the idea of their invincibility. He has reversed his own death mid-sentence. He does not need to be undefeatable. He simply refuses to accept defeat as a category that applies to him.

He came to this floor to see if anything here was worth his time. You are about to answer that question.`,

  entrance: [
    'He steps through the dungeon wall as if it is smoke.',
    'He does not have an entrance prepared. He does not need one.',
    '"So. You have come this far." He looks at you with calm red eyes.',
    '"That is commendable. Most collapse before they reach me."',
    'He draws a black sword from nowhere. "Show me what the surface world has learned."',
  ],

  phases: {
    75: [
      '"You are stronger than I expected. A genuine compliment."',
      'The black sword hums and the room fills with the smell of burning time.',
      '"I will stop holding back. Consider that an honor."',
    ],
    50: [
      '"Interesting. My castle has not seen a challenger like you in two thousand years."',
      'He raises one hand. Reality around it bends.',
      '"Ig Alheisys." The fire that appears is not fire. It is the idea of destruction made real.',
    ],
    25: [
      '"You want to kill the Demon King of Tyranny." He sounds genuinely pleased.',
      '"Then do it. I give you permission." He opens his arms.',
      '"Though I should warn you, I have died before. It did not take."',
    ],
  },

  attacks: [
    'Venuzdonoa Slash',
    'Ig Alheisys',
    'Rivide Implosion',
    'Death Magic: Ingall',
    'Diagonal Bloodstrike',
  ],

  attackNarratives: {
    'Venuzdonoa Slash': [
      'He draws the black sword in one smooth motion.',
      'The blade cuts through your defense before your defense exists.',
      'Venuzdonoa does not cut the shield. It cuts the concept of protection.',
      'Your barrier shatters not from force but from having its meaning removed.',
      'The strike lands and it carries the weight of destroyed rules.',
    ],
    'Ig Alheisys': [
      'He raises one finger.',
      'Black fire blooms outward, but it is not burning anything it touches.',
      'It is burning the idea of you being there.',
      'The flames eat through your HP as if your body had quietly agreed to not exist.',
      'You throw everything at escaping it and barely clear the outer ring.',
    ],
    'Rivide Implosion': [
      'He points and speaks one word.',
      'The space inside your body tries to switch places with the space outside it.',
      'An implosion erupts from your center. Not physical. Metaphysical.',
      'Your form holds together through sheer fighting instinct alone.',
      'He watches the aftermath and nods slightly.',
    ],
    'Death Magic: Ingall': [
      'He extends his palm and darkness pools at the center.',
      'Death gathers like a summoned tool, obedient and efficient.',
      'It launches as a sphere of compressed ending.',
      'Wherever it passes, things stop moving. Temporarily or permanently, your choice.',
      'You dodge by inches and feel your right arm go numb.',
    ],
    'Diagonal Bloodstrike': [
      'He closes the gap between you at demon-king speed.',
      'One diagonal slash from shoulder to hip.',
      'It is the only attack he makes with visible effort. That makes it the most dangerous.',
      'The force of it splits the floor beneath you and the wall behind.',
      'He does not look at the damage. He is already repositioning.',
    ],
  },

  dodgeLines: [
    '"Good evasion. Better than most."',
    '"You moved before my hand did. That should not be possible." He sounds approving.',
    '"Impressive. You are forcing me to use real speed."',
    '"You will not be able to do that indefinitely. But well done."',
  ],

  hitLines: [
    'He does not flinch.',
    '"Decent power." He touches the impact point. "Genuinely decent."',
    '"You are not bluffing. That is good. I hate bluffers."',
    '"Two thousand years and something finally lands." He sounds almost nostalgic.',
  ],

  tauntLines: [
    '"You fight as if you might win. I respect that delusion."',
    '"Your techniques are impressive. For a mortal."',
    '"Do not disappoint me by dying too early. I am enjoying this."',
    '"I have destroyed gods. What exactly is your plan?"',
    '"Come. The Demon King of Tyranny gives you one opportunity. Use it."',
  ],

  victoryLines: [
    '"A good fight. The first good fight in centuries." He sheathes Venuzdonoa.',
    '"Rest. You earned it."',
    '"Had you been born two thousand years ago, I might have named you a general."',
    '"Come back stronger. I want a rematch." He says it and means it.',
  ],

  defeatLines: [
    'He stares at the ground for a moment.',
    '"Hm." One syllable.',
    '"The Demon King of Tyranny has fallen." He does not sound horrified. He sounds intrigued.',
    '"Well done. That has not happened in a long, long time."',
    '"I will return. I always return. But that... was a real loss. You have my respect."',
  ],

  special: {
    name: 'Causality Reversal',
    desc: 'Once per fight, at 40% HP, Anos negates the last 3 turns of damage dealt to him, restoring HP to what it was 3 turns ago. He announces this before it happens. Cannot be prevented.',
    trigger: [
      { type: 'hp_threshold', value: 0.40, key: 'causalityReversal', oneShot: true },
    ],
    engineNote: `Track bossState.hpHistory as an array of the enemy.hp value at the end of each turn. On 40% HP threshold: restore enemy.hp to hpHistory[hpHistory.length - 3] (or earliest available). Show narrative line. Set bossState.causalityUsed = true. Do not allow this to trigger twice.`,
    narrativeLines: [
      '"Causality is a suggestion." He says it calmly.',
      '"Those last three turns... did not happen." His HP rewinds.',
      '"The concept of that damage has been removed from history."',
      '"Fight me from the beginning. Again."',
    ],
  },

  playerHitLines: [
    '"A real hit. Do not stop."',
    '"Good. You are not pulling your punches. I would not respect that."',
    '"Stronger than you look. Good."',
    '"That one I felt. You should be proud of that."',
  ],

  playerSkillLines: [
    '"You have technique. Rare."',
    '"An interesting magic. Where did you learn that?"',
    '"Impressive output. You trained hard."',
    '"That skill is well-built. My compliments to your teacher."',
  ],

  drops: [
    'demon_king_fang',
    'venuzdonoa_splinter',
    'ig_alheisys_ember',
    'tyranny_signet',
    'causality_fragment',
  ],
}
