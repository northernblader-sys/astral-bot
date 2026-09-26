/**
 * Escanor - The Lion's Sin of Pride
 * Grade: SS+ | Floor: 78
 * The Seven Deadly Sins
 */

export const escanor = {
  id: 'escanor',
  name: 'Escanor',
  floor: 78,
  grade: 'SS+',
  emoji: '☀️',
  image: null,
  hp: 51000,
  maxHp: 51000,
  atk: 2700,
  def: 1300,
  exp: 26000,
  gold: 18000,
  type: 'divine',
  weakTo: ['ice', 'shadow'],
  resistTo: ['physical', 'fire', 'magic', 'holy'],

  personality: 'magnanimous-overwhelming-brief',
  voice: 'In The One: absolute and benevolent, like the sun commenting on clouds. At normal power: self-deprecating and mild.',

  lore: `He was born cursed: absorbing sunlight and releasing it as power. At night he was small and frail and kind and easily overlooked. At noon he was something else entirely. At noon he was The One.

The One is sixty seconds of absolute invincibility. At the peak of noon, Escanor\'s power grows so vast that he calls it by name. For those sixty seconds he cannot be harmed. His Divine Axe Rhitta swings with the weight of the sun behind it. He does not move particularly fast in The One because he does not need to.

He uses Sunshine\'s ultimate form, The One Ultimate, at the end: he burns his own life force as fuel. The output is beyond The One. He used it to fight a demon. He did not survive it at full intensity.

He knows what The One Ultimate costs. He uses it anyway.`,

  entrance: [
    'He walks in carrying Rhitta over his shoulder.',
    'He looks at you with genuine warmth.',
    '"I must admit, I did not expect someone this formidable on this floor."',
    '"It is an honor." He says it and means it.',
    '"Sunshine." The sun rises in the dungeon. His power begins to build.',
  ],

  phases: {
    75: [
      '"Sunshine approaches peak." His size increases slightly.',
      '"I apologize in advance for this next portion." He is sincere.',
      '"At noon I become... myself. The real one."',
    ],
    50: [
      '"Noon." He stands completely still.',
      '"THE ONE." He is taller. Hotter. Present.',
      '"Who decided you could stand against the sun?" He is not angry. He is asking.',
    ],
    25: [
      '"The One is fading." He shrinks slightly.',
      '"The One Ultimate then." He grips Rhitta.',
      '"I will burn what is left of my life force on this."',
    ],
  },

  attacks: [
    'Rhitta: Solar Cleave',
    'Sunshine: Prominence Burn',
    'The One: Absolute Stance',
    'Cruel Sun',
    'The One Ultimate',
  ],

  attackNarratives: {
    'Rhitta: Solar Cleave': [
      'He swings Rhitta.',
      'The divine axe is enormous and he swings it easily.',
      'The arc of the swing carries solar energy at its leading edge.',
      'The cleave detonates the solar energy at the endpoint.',
      '"I hope this was not too uncomfortable."',
    ],
    'Sunshine: Prominence Burn': [
      'Solar energy detonates from his body outward.',
      'Prominence Burn does not aim. It radiates.',
      'Everything inside the radius takes the output of concentrated sunlight.',
      'The heat is not metaphorical.',
      '"My power does not have a ceiling. Only a clock." He means noon.',
    ],
    'The One: Absolute Stance': [
      '"Who decided I could be harmed right now?"',
      'The One is active.',
      'His next defensive turn takes zero damage.',
      'His strike in The One carries the weight of absolute noon.',
      '"I am The One. For this moment I am invincible." He does not boast. He reports.',
    ],
    'Cruel Sun': [
      'He releases a sphere of concentrated solar energy.',
      '"Cruel Sun." He names it.',
      'The sphere hangs in the air for a moment.',
      'Then it detonates.',
      'The heat from its detonation fires through the room in all directions.',
    ],
    'The One Ultimate': [
      '"The One Ultimate." He says it.',
      'The sun inside him burns past its limit.',
      'He channels his own life force into the output.',
      'The resulting energy is incomprehensible.',
      '"This costs everything. I pay it willingly." He releases it.',
    ],
  },

  dodgeLines: [
    '"Good evasion!" He sounds pleased for you.',
    '"Fast! Well done!"',
    '"You dodged Rhitta. Impressive."',
    '"Good movement. I will adjust." He says it warmly.',
  ],

  hitLines: [
    '"Ow. Good hit!" He takes it without alarm.',
    '"Strong! Well done!"',
    '"That one landed well." He continues.',
    '"You hit Escanor." He says it like an achievement you deserve.',
  ],

  tauntLines: [
    '"Who decided you could beat me at noon? They were optimistic."',
    '"I am not the strongest at night. I am The One. There is a difference."',
    '"My power grows until noon and fades after. You need to beat me before I peak."',
    '"I am not arrogant. I am simply the most powerful thing in this room right now. That is different."',
    '"Come. Before noon passes. This window is brief."',
  ],

  victoryLines: [
    '"A truly worthy fight." He bows slightly.',
    '"You have made me use more than I expected." He sounds grateful.',
    '"Train. Come back. I will be here every day at noon." He smiles.',
    '"You fought beautifully." He says it and means it.',
  ],

  defeatLines: [
    '"You beat The One." He sits.',
    '"The sun was not enough." He looks at his hands.',
    '"I burned everything. The One Ultimate. My life force." He is still seated.',
    '"You beat all of it." He sounds like he is close to crying and very happy.',
    '"Merlin would want to know about you." He laughs once. "So would everyone else."',
  ],

  special: {
    name: 'Sunshine: The One Window',
    desc: 'On turns 6-8 (simulating noon), Escanor enters "The One" state: his ATK is doubled, and the first hit he takes each turn is reduced by 50% (invincibility shielding). After turn 8, The One fades and his ATK returns to normal (post-noon weakness). From turn 9+, his DEF is also halved (night vulnerability). Players who survive turns 6-8 face a much weaker version.',
    trigger: [
      { type: 'turn_exact', values: [6], key: 'theOneStart' },
      { type: 'turn_exact', values: [9], key: 'theOneFade' },
    ],
    engineNote: `On turn 6: set bossState.theOne = true, bossState.theOneShield = true per turn, enemy.atk = enemy.baseAtk * 2.0. Show The One announcement. While theOne: on first incoming hit per turn, multiply finalDmg by 0.50, show shield line, set bossState.theOneShield = false (resets next turn). On turn 9: set bossState.theOne = false, enemy.atk = enemy.baseAtk, enemy.def = Math.floor(enemy.baseDef * 0.50). Show fade line. Cache baseAtk and baseDef at fight start.`,
    narrativeLines: [
      '"NOON." He grows. "THE ONE." ATK doubles.',
      '"The first blow glances off The One." Shield reduces hit.',
      '"Noon fades." His power diminishes.',
      '"I am weaker now." He says it without shame. "This was always the truth."',
    ],
  },

  playerHitLines: [
    '"Good hit!" He accepts it.',
    '"Strong! Well done!"',
    '"You hit The One." He notes it. "Remarkable."',
    '"Real power!" He continues.',
  ],

  playerSkillLines: [
    '"A technique! Well executed!"',
    '"Strong skill!" He absorbs it.',
    '"Good output!" He notes it.',
    '"A real technique! I am impressed!" He means every word.',
  ],

  drops: [
    'rhitta_solar_shard',
    'sunshine_fragment',
    'the_one_crystal',
    'pride_sin_crest',
    'cruel_sun_ember',
  ],
}
