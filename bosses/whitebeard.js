/**
 * Edward Newgate - Whitebeard, the World's Strongest Man
 * Grade: SS | Floor: 71
 * One Piece
 */

export const whitebeard = {
  id: 'whitebeard',
  name: 'Whitebeard',
  floor: 71,
  grade: 'SS',
  emoji: '🌊',
  image: null,
  hp: 20000,
  maxHp: 20000,
  atk: 1400,
  def: 600,
  exp: 15000,
  gold: 10000,
  type: 'physical',
  weakTo: [],
  resistTo: ['physical', 'fire', 'magic'],

  personality: 'paternal-devastating-dying',
  voice: 'Deep and certain. Every word carries the weight of the man everyone agreed was the strongest.',

  lore: `He never wanted treasure. He wanted a family. He built one on the Grand Line: hundreds of sons, each one chosen, each one his. He called them all sons and he meant every instance of the word.

The Gura Gura no Mi gave him the power to create earthquakes by cracking the air itself. He tilted the world once. Not metaphorically. The sea tilted. The island moved. He cracked the air and the resulting shockwave traveled for miles.

He died at Marineford standing up. He took 267 sword wounds, 152 gunshot wounds, and 46 cannonballs. He died on his feet facing forward. He was never once knocked down.

He is not looking for a fight. He is looking to see what you are worth. He will fight you like a father tests a son: completely, without mercy, and hoping you survive it.`,

  entrance: [
    'He does not rush.',
    'He walks to the center of the room with his bisento over his shoulder.',
    '"So you made it this far." He looks at you.',
    '"I have sons who made it further." He pauses. "Not many."',
    '"Show me what you are, then." He shifts his grip.',
  ],

  phases: {
    75: [
      '"You have real strength." He adjusts.',
      '"Gura Gura no Mi: partial output." The room shakes.',
      '"I will not hold back the quake anymore."',
    ],
    50: [
      '"Good." He is satisfied.',
      '"Full quake power." The floor cracks.',
      '"This is what the world\'s strongest man looks like when he means it."',
    ],
    25: [
      '"You are still standing." He sounds proud of you.',
      '"One last quake." He raises the bisento.',
      '"Worthy of being called a son." He says it. He means it.',
    ],
  },

  attacks: [
    'Bisento Cleave',
    'Quake Bubble',
    'Seaquake Shockwave',
    'World Tilt',
    'Gura Gura: Crack',
  ],

  attackNarratives: {
    'Bisento Cleave': [
      'The bisento swings horizontal.',
      'A weapon that size moving that fast is not a weapon. It is a weather event.',
      'The air pressure ahead of the blade hits you before the blade does.',
      'The blade hits you after.',
      '"Hmph." He watches you not fly away.',
    ],
    'Quake Bubble': [
      'He twists his fist in the air.',
      'A quake bubble forms around his knuckle.',
      'He pushes it into you.',
      'The bubble detonates on contact: the earthquake inside releases at point of impact.',
      'The shockwave travels through your body rather than around it.',
    ],
    'Seaquake Shockwave': [
      'He strikes the air.',
      'The crack in reality travels outward.',
      'Everything in the shockwave\'s path vibrates at the frequency of breaking.',
      'Your guard vibrates. Your footing vibrates.',
      'The quake travels and you take it when it arrives.',
    ],
    'World Tilt': [
      'He raises both arms.',
      '"Gura Gura no Mi: full power."',
      'The room tilts. Not metaphorically.',
      'The dungeon floor lists thirty degrees to one side.',
      'You adjust your footing or you do not, and the difference matters.',
    ],
    'Gura Gura: Crack': [
      'He cracks the air directly in front of you.',
      'The crack is silent.',
      'The wave from it is not.',
      'The quake energy releases in a column centered on your position.',
      '"The world\'s strongest punch." He says it simply. "Now you know what it feels like."',
    ],
  },

  dodgeLines: [
    '"Fast." He adjusts.',
    '"Good." He means it.',
    '"You moved in time." He notes it.',
    '"Hmph. Quick feet."',
  ],

  hitLines: [
    '"Hmph." He takes it without moving.',
    '"Good hit." He continues.',
    '"You hit Whitebeard." He is not impressed. But he noted it.',
    '"Strength." He says it as a compliment.',
  ],

  tauntLines: [
    '"I have sons who hit harder than you." A pause. "Not many."',
    '"The world\'s strongest man is standing in front of you. Give it everything."',
    '"Quake power cracked the world itself. What exactly is your plan?"',
    '"Come. Show me you are worth calling a warrior."',
    '"I died standing up at Marineford. Try to knock me down."',
  ],

  victoryLines: [
    '"Hmph." He turns.',
    '"You are strong." He says it. "Grow stronger."',
    '"Come back when you are ready to be called a son." He means it as the best thing he can offer.',
    '"You fought well. That is enough." He walks away.',
  ],

  defeatLines: [
    '"Hn." He sits down heavily.',
    '"The world\'s strongest man." He touches the impact point.',
    '"Falls to you." He looks at his hands.',
    '"Good." He says it. "Good."',
    '"If I had more sons like you..." He laughs once. "Well."',
  ],

  special: {
    name: 'Quake Shockwave',
    desc: 'Every time Whitebeard attacks and deals damage, a residual quake shockwave lingers. On the player\'s next action after any Whitebeard hit, they take 8% of Whitebeard\'s ATK as ongoing shockwave damage before their action resolves. This represents the internal earthquake damage that continues after impact. Maximum one shockwave stacks at a time.',
    trigger: [
      { type: 'on_deal_damage', key: 'quakeResidue' },
      { type: 'on_player_action', key: 'quakeApply' },
    ],
    engineNote: `Track bossState.quakeResidue (bool, default false). After each enemy attack that deals damage: set bossState.quakeResidue = true. At start of player\'s action (before their attack/skill/defend resolves): if quakeResidue, deal Math.floor(enemy.atk * 0.08) true damage to player, set quakeResidue = false, show shockwave line. This means defending still triggers the shockwave, but defending reduces the main attack damage.`,
    narrativeLines: [
      'The quake residue reaches you.',
      'The shockwave from his last hit continues.',
      '"The earthquake travels. It does not stop because the first hit is over."',
      'The internal vibration from his strike fires through you.',
    ],
  },

  playerHitLines: [
    '"Good hit." He takes it.',
    '"Strength." He notes it.',
    '"Real power." He continues.',
    '"You hit Whitebeard." He says it like a distinction.',
  ],

  playerSkillLines: [
    '"A technique." He watches.',
    '"Good output." He absorbs it.',
    '"Strong skill." He adjusts.',
    '"Real technique." He notes it.',
  ],

  drops: [
    'gura_gura_shard',
    'whitebeard_bisento_fragment',
    'quake_crystal',
    'world_strongest_mark',
    'newgate_crest',
  ],
}
