/**
 * Shanks - The Red-Haired Emperor
 * Grade: SS+ | Floor: 76
 * One Piece
 */

export const shanks = {
  id: 'shanks',
  name: 'Shanks',
  floor: 76,
  grade: 'SS+',
  emoji: '⚔️',
  image: null,
  hp: 47000,
  maxHp: 47000,
  atk: 2350,
  def: 1200,
  exp: 24000,
  gold: 17000,
  type: 'divine',
  weakTo: [],
  resistTo: ['physical', 'magic', 'shadow'],

  personality: 'relaxed-absolute-decisive',
  voice: 'Easy and warm, right up until the moment it needs to be final.',

  lore: `He was Roger\'s cabin boy. He watched the King of Pirates execute himself with a smile and it changed him. He became a Yonko through sheer force of presence. His crew showed up at a battle once and both sides stopped fighting because nobody wanted to fight Shanks.

His Haoshoku Haki, Conqueror\'s Haki, is so refined he can infuse it directly into his sword strikes. The sword itself becomes charged with the power of a king. When it cuts, it is not just a cut.

He gave away his arm for a child\'s dream. He has never once indicated he regrets it.

He is not going to explain why he is on this floor or what he wants from this fight. He will just fight, and when it is over, he will pour you a drink if you are still standing.`,

  entrance: [
    '"So you are the one." He stands with his sake bottle.',
    'He sets the bottle down carefully.',
    '"One-armed swordsman. Former cabin boy of the Pirate King." He draws his blade.',
    '"I have been watching you since you entered the dungeon." He probably has.',
    '"Let\'s see what you are made of." He smiles.',
  ],

  phases: {
    75: [
      '"You are better than you look." He grins.',
      '"Haoshoku Haki: active." The air changes.',
      '"I am going to stop being casual about this."',
    ],
    50: [
      '"Now you have my attention." He says it and means it.',
      '"Kamusari." He infuses Haki into the blade.',
      '"Roger\'s crew mastered this. I inherited it."',
    ],
    25: [
      '"Everything." He rolls his neck.',
      '"Conqueror\'s Haki infused into every strike from here." He steps forward.',
      '"This is what an Emperor of the Sea looks like at full power."',
    ],
  },

  attacks: [
    'Kamusari',
    'Conqueror\'s Pressure',
    'Red Force Slash',
    'Haki Blade Storm',
    'King\'s Declaration',
  ],

  attackNarratives: {
    'Kamusari': [
      '"Kamusari." He whispers it.',
      'The sword move is one cut.',
      'Conqueror\'s Haki fills the blade at the moment of contact.',
      'The cut does not just deal damage. It carries the intent of a king.',
      'Whatever it touches knows it has been struck by something that chose to be King.',
    ],
    'Conqueror\'s Pressure': [
      'He does not move.',
      'His Haki expands outward.',
      'Conqueror\'s Haki at this level is not a technique. It is reality pushing back.',
      'Weaker wills collapse. Your will holds, barely.',
      '"That is Haoshoku Haki. Most cannot even feel it. You felt it."',
    ],
    'Red Force Slash': [
      'One horizontal cut from one arm.',
      'The red Haki aura extends the blade\'s effective reach.',
      'The cut creates a visible scar in the air.',
      'The scar detonates a second later, after you thought the attack was over.',
      '"One arm. Still enough." He says it plainly.',
    ],
    'Haki Blade Storm': [
      'He closes the distance.',
      'Multiple cuts. Each one Haki-infused.',
      'The storm of cuts is not fast in the way Kirishimaru\'s speed is fast.',
      'It is fast in the way a decisive man makes decisions: no hesitation, no gaps.',
      'Each strike lands in the slot where your guard was not.',
    ],
    'King\'s Declaration': [
      'He raises his sword.',
      '"A king says here and means it." He brings it down.',
      'The impact creates a shockwave.',
      'Conqueror\'s Haki amplifies it to fill the room.',
      '"That is what happens when a real king means a thing."',
    ],
  },

  dodgeLines: [
    '"Good evasion." He notes it.',
    '"Fast." He adjusts.',
    '"You moved in time." He grins.',
    '"Quick. I like it."',
  ],

  hitLines: [
    '"You hit me." He takes it.',
    '"Good." He means it.',
    '"Strong." He continues.',
    '"Real power." He notes it.',
  ],

  tauntLines: [
    '"The Pirate King himself could not be stopped by normal power. I learned from him."',
    '"Conqueror\'s Haki separates those who want to be king and those who are."',
    '"Come. Give me something worth remembering."',
    '"One arm. Still an Emperor." He shrugs. "Figure out how."',
    '"Roger would have liked you." He says this mid-fight. It is the best thing he can say.',
  ],

  victoryLines: [
    '"Good fight." He picks up the sake bottle.',
    '"You have the makings of something real." He pours.',
    '"Drink with me when you recover." He means it.',
    '"Roger would have noticed you." He says it and means it.',
  ],

  defeatLines: [
    '"Ha." He sits.',
    '"An Emperor of the Sea." He looks at his one arm.',
    '"Down in one fight." He laughs.',
    '"Roger would have been delighted." He is laughing.',
    '"Good fight." He raises the sake bottle. "Drink with me."',
  ],

  special: {
    name: 'Conqueror\'s Haki Infusion',
    desc: 'For every 3 consecutive turns Shanks attacks without the player evading (player takes damage), his Haki builds. At 3 consecutive hits: all his attacks deal +25% for the next 2 turns. At 6 (if the streak continues): +50% for 2 turns. Any successful player evasion (or miss) resets the streak and the bonus.',
    trigger: [
      { type: 'on_consecutive_hits', key: 'hakiInfusion', threshold: 3, stackable: true },
    ],
    engineNote: `Track bossState.consecutiveHits (default 0) and bossState.hakiBonus (default 0). Each enemy attack that deals damage: increment consecutiveHits. At multiples of 3: if consecutiveHits == 3: set hakiBonus = 0.25, bossState.hakiBonusTurns = 2. If consecutiveHits == 6: set hakiBonus = 0.50, hakiBonusTurns = 2. Apply bonus: enemy.atk = enemy.baseAtk * (1 + hakiBonus). Decrement hakiBonusTurns each turn; when 0, reset hakiBonus to 0. On player evasion OR enemy miss: reset consecutiveHits to 0, reset hakiBonus to 0.`,
    narrativeLines: [
      '"Three consecutive. Haki building." His blade darkens.',
      '"Six consecutive. Full infusion." The sword is black.',
      '"Conqueror\'s Haki infused." His ATK increases.',
      '"You evaded. Haki reset." He begins building again.',
    ],
  },

  playerHitLines: [
    '"Good hit." He takes it without drama.',
    '"Strong." He grins.',
    '"Real power." He continues.',
    '"You hit an Emperor." He acknowledges it.',
  ],

  playerSkillLines: [
    '"A technique." He watches it arrive.',
    '"Good output." He adjusts.',
    '"Strong skill." He continues.',
    '"Real." He says it simply.',
  ],

  drops: [
    'kamusari_echo',
    'red_hair_flag_fragment',
    'conquerors_haki_shard',
    'roger_crew_mark',
    'sake_cup_rune',
  ],
}
