/**
 * Kaido - The King of the Beasts
 * Grade: SS+ | Floor: 80
 * One Piece
 */

export const kaido = {
  id: 'kaido',
  name: 'Kaido',
  floor: 80,
  grade: 'SS+',
  emoji: '🐲',
  image: null,
  hp: 56000,
  maxHp: 56000,
  atk: 2800,
  def: 3000,
  exp: 28000,
  gold: 19000,
  type: 'physical',
  weakTo: [],
  resistTo: ['physical', 'magic', 'fire', 'shadow', 'poison'],

  personality: 'nihilistic-powerful-testing',
  voice: 'Drunk or not, he sounds like he is announcing an earthquake. Every line is a declaration.',

  lore: `He has been captured nineteen times. Executed nine times. He survived all of it. He jumped from Sky Island at 10,000 meters and walked away with a headache. He has lived by one truth: in this world, the strong survive and he is the strongest creature alive.

The Uo Uo no Mi, Model: Seiryu, gives him a massive azure dragon form. His Thunder Bagua is one strike that ends discussions. His Conqueror\'s Haki is infused into his kanabo club in the same way Shanks infuses his sword.

He wants one thing: a real war. A world-changing war. He is bored with easy victories. He surrounds himself with the strongest people he can find and forces them to become stronger.

He is testing you the same way. The hardest he hits, the more he respects you.`,

  entrance: [
    'He drops through the ceiling.',
    'From somewhere far above, he simply dropped.',
    'The impact crater is where you were standing.',
    '"..." He looks at you.',
    '"Finally." He lifts his kanabo club. "Something that might be worth hitting."',
  ],

  phases: {
    75: [
      '"You are not dead." He sounds like this is interesting information.',
      '"Hybrid form." Dragon scales trace his arms.',
      '"I am going to stop holding back the Conqueror\'s Haki."',
    ],
    50: [
      '"Full dragon." He transforms.',
      'The Azure Dragon fills the room and compresses to fight in it.',
      '"Blast Breath on standby. Stay close if you want to avoid it."',
    ],
    25: [
      '"You hit the strongest creature." He says it.',
      '"THUNDER BAGUA." He swings.',
      '"If you survive this, you earned the right to exist in my world."',
    ],
  },

  attacks: [
    'Thunder Bagua',
    'Blast Breath',
    'Dragon Twister',
    'Conqueror\'s Kanabo',
    'Boro Breath',
  ],

  attackNarratives: {
    'Thunder Bagua': [
      'He swings the kanabo once.',
      'One swing.',
      'The kanabo is wrapped in Conqueror\'s Haki.',
      'The contact area generates a thunderclap.',
      'The impact from Thunder Bagua reshapes whatever geography is in the way.',
    ],
    'Blast Breath': [
      'He opens his mouth.',
      'The dragon form fires.',
      'Compressed fire and wind from the azure dragon\'s lungs.',
      'The blast does not aim. It covers.',
      'The wall on the far side of the room does not survive. You have to.',
    ],
    'Dragon Twister': [
      'He spins in dragon form.',
      'The rotation generates a tornado of wind and fire.',
      'The twister moves with him, directed.',
      'Everything inside the cone takes continuous damage while inside it.',
      'Getting out of the cone is the priority. He makes that hard.',
    ],
    'Conqueror\'s Kanabo': [
      'He infuses the kanabo with Haoshoku Haki.',
      'The resulting strike does not need to aim for the body.',
      'The Conqueror\'s pressure alone staggers anything inside the range.',
      'When the club itself arrives, the stagger becomes collapse.',
      '"Conqueror\'s infusion. This is how a King fights."',
    ],
    'Boro Breath': [
      '"Boro Breath." He fires continuously.',
      'Not a single blast. A continuous beam.',
      'He tracks.',
      'You run and it follows you.',
      'The only way to not take this is to not be in its path, which means moving through it.',
    ],
  },

  dodgeLines: [
    '"..." He adjusts.',
    '"Fast." He swings again.',
    '"You moved." He recalibrates.',
    '"Hmph." He brings more force.',
  ],

  hitLines: [
    '"Hmph." He does not move.',
    '"You can hit me." He says it like information.',
    '"Good." He continues.',
    '"Stronger than you look." He means it as recognition.',
  ],

  tauntLines: [
    '"I jumped from ten thousand meters and got a headache. What is your strongest move?"',
    '"The strongest creature alive is standing in front of you. Hit me harder."',
    '"I have been executed nine times. What exactly is your plan here?"',
    '"Strong is the only law. Show me you understand that."',
    '"This is a test. You are failing it. Hit me harder."',
  ],

  victoryLines: [
    '"Hmph." He shoulders the kanabo.',
    '"Come back when you can survive Thunder Bagua."',
    '"You are not there yet. Keep going." He is almost encouraging.',
    '"In my world, strength is everything. Get stronger and come back."',
  ],

  defeatLines: [
    '"..."',
    '"The strongest creature..." He goes to one knee.',
    '"...has fallen." He stays there.',
    '"You." He looks at you. "What ARE you."',
    '"In twenty-five years, nobody has..." He goes quiet. Then: "Good. Good fight."',
  ],

  special: {
    name: 'Invincible Hide',
    desc: 'Kaido\'s body is so durable that all non-Haki-enhanced damage is reduced by 50%. The player must use Conqueror\'s or Armament Haki to hit full damage. In game terms: basic physical attacks deal 50% damage. Skills that deal magic, fire, ice, or void damage deal full. Skills marked as "physical" deal 50% unless they crit (a crit bypasses the hide). This makes Kaido fight like a puzzle.',
    trigger: [
      { type: 'passive', key: 'invincibleHide' },
    ],
    engineNote: `On player basic attack: multiply finalDmg by 0.50. On player skill: check skill damage type. If type is 'physical': apply 0.50 unless isCrit (crits bypass). If type is 'magic', 'fire', 'ice', 'void', 'shadow', 'holy': apply full damage. This creates a situation where critting with physical skills or using elemental skills is the optimal approach. Track in bossState.hideActive (always true). Show hide-reduction line on reduced hits.`,
    narrativeLines: [
      '"My body does not bend to physical force." Damage reduced.',
      '"Hit me with something that can hurt a dragon." Hint at elemental skills.',
      '"A crit! That got through!" Crit bypasses the hide.',
      '"You found the gap." He acknowledges elemental damage.',
    ],
  },

  playerHitLines: [
    '"Hmph." He takes it.',
    '"Good power." He continues.',
    '"That one got through my hide." He notes it.',
    '"You found the right approach." He means it.',
  ],

  playerSkillLines: [
    '"A technique that bypasses the hide." He absorbs it.',
    '"Strong skill." He takes it.',
    '"That one reached me." He adjusts.',
    '"Good. Use that again."',
  ],

  drops: [
    'azure_dragon_scale',
    'kanabo_fragment',
    'blast_breath_crystal',
    'beast_king_mark',
    'wano_thunder_rune',
  ],
}
