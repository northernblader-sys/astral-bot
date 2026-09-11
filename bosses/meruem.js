/**
 * Meruem - King of the Chimera Ants
 * Grade: SSS | Floor: 91
 * Hunter x Hunter
 */

export const meruem = {
  id: 'meruem',
  name: 'Meruem',
  floor: 91,
  grade: 'SSS',
  emoji: '🦂',
  image: null,
  hp: 92000,
  maxHp: 92000,
  atk: 4200,
  def: 2800,
  exp: 50000,
  gold: 34000,
  type: 'shadow',
  weakTo: ['holy'],
  resistTo: ['physical', 'magic', 'shadow', 'poison', 'fire'],

  personality: 'contemptuous-calculating-evolving',
  voice: 'Surgical and cold. Uses words like tools, not ornaments.',

  lore: `He was born knowing everything he needed to know. His purpose was to lead the Chimera Ants in conquering humanity. He dismissed the assignment within an hour because he found it beneath him. He wanted more interesting problems.

He found them in board games. He played Go, Gungi, and Chess against the world champions, defeated them all, and absorbed their Nen in the process. Aura Synthesis means every strong opponent he devours makes him permanently stronger. In combat he grows. In victory he grows. There is no interaction with Meruem that does not benefit Meruem.

His body can survive the En Passant, the Miniature Rose bomb, a military-grade biological weapon. He survived it once. He came back radioactive and twice as powerful as before.

He is the apex predator. You are a problem he intends to solve efficiently.`,

  entrance: [
    'He does not enter. He arrives. As if he was always going to be here and time simply caught up.',
    '"You." He evaluates you in one glance.',
    '"Your power level is noted." He folds his hands. "You are worth a small amount of my time."',
    '"Do not waste it." He says this without raising his voice.',
    '"Begin."',
  ],

  phases: {
    75: [
      '"You are better than I calculated." He adjusts.',
      '"Aura Synthesis is processing your technique."',
      '"I will not underestimate you again. That will not help you."',
    ],
    50: [
      '"Your half has been taken." He says this flatly.',
      '"The version of me that began this fight no longer exists."',
      '"What stands before you now has incorporated your best outputs."',
    ],
    25: [
      '"Royal Guard." He reaches inward.',
      '"I am accessing the absorbed Nen of every opponent who came before you."',
      '"Every one of them made me stronger. So have you."',
    ],
  },

  attacks: [
    'Royal Tail Strike',
    'Nen Absorption Pulse',
    'Photon Barrage',
    'Aura Detonation',
    'Scorpion Execution',
  ],

  attackNarratives: {
    'Royal Tail Strike': [
      'The scorpion tail extends faster than vision.',
      'It does not swing. It calculates the shortest path to your body and takes it.',
      'The tip carries concentrated Nen that penetrates defense at point of contact.',
      'You take it in the side and the Nen disperses through your ribcage.',
      '"Efficient." He notes the result and adjusts the next vector.',
    ],
    'Nen Absorption Pulse': [
      'He releases a wave of Nen from his center.',
      'The wave does not deal impact damage.',
      'It pulls at your Nen, your MP, your stored energy.',
      'You feel the drain as if something reached through your skin.',
      '"Absorbed." He grows slightly and you have slightly less.',
    ],
    'Photon Barrage': [
      'He extends both hands and condensed Nen forms in his palms.',
      'The barrage launches in rapid sequence, not bursts, continuous.',
      'Each shot is precisely aimed at the gap your previous dodge created.',
      'He is not shooting where you are. He is shooting where his model of you will be.',
      'Three out of five land.',
    ],
    'Aura Detonation': [
      'He condenses Nen to a single point on his body.',
      'Then releases it.',
      'The explosion is not random. The force is directed outward in a cone.',
      'Everything inside the cone takes the full output of a Chimera Ant King\'s aura.',
      'The dungeon wall behind you does not survive.',
    ],
    'Scorpion Execution': [
      'He closes the distance in one step.',
      'His tail and both hands act simultaneously.',
      'The tail pinions. The hands strike.',
      'The combination is designed to be survived if you are exceptional and fatal otherwise.',
      'You survive. Barely.',
    ],
  },

  dodgeLines: [
    '"Evasion. Factored."',
    '"You moved. Recalculating."',
    '"Good reaction time. Above the projected range."',
    '"Unexpected." He notes it and does not repeat the same approach.',
  ],

  hitLines: [
    '"Output is higher than estimated." He recalculates.',
    '"Damage accepted. Aura Synthesis is processing."',
    '"You hit me." A pause. "I am now stronger than I was before you hit me."',
    '"Good power. Absorbed."',
  ],

  tauntLines: [
    '"You are fighting the King of all Chimera Ants. Calibrate your expectations accordingly."',
    '"Each hit you land improves me. Consider what that means for your strategy."',
    '"I have solved more complex problems before breakfast."',
    '"The gap between us is not power. It is the fact that my power grows and yours does not."',
    '"You are performing above average. That is noted. It is not enough."',
  ],

  victoryLines: [
    '"Solved." He turns away.',
    '"You were more interesting than most. That is all."',
    '"Aura Synthesis complete. I carry your best technique now."',
    '"There was no winning this. You increased my strength by fighting me. Do not feel bad about that."',
  ],

  defeatLines: [
    'He goes still.',
    '"Miscalculation." He says it once.',
    'He does not flail. He does not rage. He sits down.',
    '"I did not account for this possibility." He sounds genuinely analytical about his own death.',
    '"You are... stronger than any opponent I have encountered." A pause. "Well done." He means it.',
  ],

  special: {
    name: 'Aura Synthesis',
    desc: 'Meruem absorbs power from player attacks. Every 3 hits the player lands (cumulatively), Meruem\'s ATK permanently increases by 4%. This caps at +60%. Additionally, any time Meruem would die from a single hit that exceeds 30% of his max HP, he instead survives at 1 HP once per fight (reflecting the Miniature Rose survival).',
    trigger: [
      { type: 'on_player_hit', key: 'auraSynthesis', threshold: 3, stackable: true },
      { type: 'on_lethal_hit', key: 'rosesurvival', threshold: 0.30, oneShot: true },
    ],
    engineNote: `Track bossState.hitCount (total player hits). Every time hitCount reaches a multiple of 3: increase enemy.atk by Math.floor(enemy.baseAtk * 0.04), show synthesis line. Cap total bonus at 60% of baseAtk. For rose survival: if a single hit would reduce enemy.hp from above 1 to below 1, and damage > enemy.maxHp * 0.30, and !bossState.roseSurvivalUsed: set enemy.hp = 1, bossState.roseSurvivalUsed = true, show survival line. Boss continues from 1 HP.`,
    narrativeLines: [
      'Aura Synthesis processes your technique.',
      '"Absorbed. I am now slightly more than I was."',
      '"The Rose bomb nearly killed me once. Nearly." He stands at 1 HP.',
      '"I survived that. I survive this too."',
    ],
  },

  playerHitLines: [
    '"Hit registered. Added to Aura Synthesis."',
    '"You hit the King of Chimera Ants. Noted."',
    '"Strong output. Absorbed."',
    '"That one was real power. I have catalogued it."',
  ],

  playerSkillLines: [
    '"A technique with structure. Processing."',
    '"Strong skill. Aura Synthesis begins."',
    '"Your technique has been analyzed."',
    '"Good output. I will use that against the next challenger."',
  ],

  drops: [
    'chimera_ant_king_core',
    'aura_synthesis_residue',
    'royal_nen_shard',
    'scorpion_tail_fragment',
    'king_rose_dust',
  ],
}
