/**
 * Eren Yeager - The Founding Titan
 * Grade: SSS | Floor: 85
 * Attack on Titan
 */

export const eren_founding = {
  id: 'eren_founding',
  name: 'Eren Yeager (Founding Titan)',
  floor: 85,
  grade: 'SSS',
  emoji: '🦴',
  image: null,
  hp: 76000,
  maxHp: 76000,
  atk: 3600,
  def: 2800,
  exp: 41000,
  gold: 27000,
  type: 'shadow',
  weakTo: ['holy'],
  resistTo: ['physical', 'magic', 'fire', 'shadow'],

  personality: 'resigned-relentless-broken',
  voice: 'Flat and exhausted. He has seen every moment of what happens next and does it anyway.',

  lore: `He saw the future at the age of nine when he kissed his mother\'s hand and the paths opened. He has been living in a predetermined arc ever since. He chose the Rumbling because every other outcome he saw was worse for his people.

The Founding Titan form is enormous, skeletal, a ribcage half the size of a city. Inside it, Eren\'s consciousness persists as the controller. He can command all Titans. He can harden. He can summon Colossal Titans from inside the walls and set them walking.

He does not enjoy this. He chose this. There is a difference he has stopped explaining to people because the conversation is always the same.

He sees you in the paths. He knows you are here. He is still doing what the future requires.`,

  entrance: [
    'The ground shakes before he arrives.',
    'The Founding Titan\'s skeletal form tears through the dungeon wall.',
    '"You are in the paths." His voice comes from inside the ribcage.',
    '"I have seen this moment." He says it without accusation.',
    '"I do not want to fight you. I am going to anyway." He moves.',
  ],

  phases: {
    75: [
      '"Rumbling." He activates the march.',
      '"The Colossal Titans inside are waking." Steam fills the room.',
      '"I told myself I would not use this today. I lied to myself." He sounds tired.',
    ],
    50: [
      '"Hardening active." Crystals form along his skeletal frame.',
      '"I have seen this phase. I know what you are about to try." He adjusts for it.',
      '"Do it anyway. It is what the future requires."',
    ],
    25: [
      '"The final memories from the future." He goes quiet.',
      '"You win or you do not. Either way the paths continue."',
      '"Come. End this or do not. I have already accepted both."',
    ],
  },

  attacks: [
    'Colossal Stomp',
    'Hardening Spike',
    'Founder\'s Roar',
    'Path Memory Strike',
    'Rumbling Wave',
  ],

  attackNarratives: {
    'Colossal Stomp': [
      'The Founding Titan raises one massive foot.',
      'The foot contains the mass of a building.',
      'He brings it down.',
      'The shockwave from the impact clears everything within the blast radius.',
      'You are inside the blast radius.',
    ],
    'Hardening Spike': [
      'Crystal protrusions extend from his skeletal form in your direction.',
      'They do not fire. They grow.',
      'The rate of growth is faster than stepping backward covers.',
      'Crystal finds you and the impact is both puncture and explosion.',
      '"Hardening. One of the first powers I received." He sounds distant.',
    ],
    'Founder\'s Roar': [
      'He opens the ribcage.',
      'The roar that comes out carries the Founding Titan\'s command authority.',
      'It is not sound. It is an order directed at every Titan-adjacent thing in range.',
      'Your body, if it carries any trace of Titan power, feels the compulsion.',
      'Even without it, the sheer volume of the founder\'s voice is damage.',
    ],
    'Path Memory Strike': [
      'He reaches through the paths.',
      '"I have seen this attack before. I know where you move."',
      'He strikes the location you move to, not the location you left.',
      'You dodge and arrive at his fist.',
      '"The paths show me everything. Including this."',
    ],
    'Rumbling Wave': [
      'He turns.',
      'The march of Colossal Titans behind him sends a steam shockwave forward.',
      'The wave carries the heat and force of a hundred city-sized footsteps.',
      'You cannot outrun the front edge of the Rumbling.',
      'You survive it. In the path he has seen, you survive it.',
    ],
  },

  dodgeLines: [
    '"The paths showed me that dodge. I adjusted."',
    '"You moved. I saw you move before you moved." He adjusts.',
    '"Good evasion. It will not be enough in the long run."',
    '"Fast." He notes it.',
  ],

  hitLines: [
    '"You hit the Founding Titan." He takes it.',
    '"Good output." The ribcage absorbs some of it.',
    '"Real power." He acknowledges.',
    '"You are stronger than the paths showed." He recalibrates.',
  ],

  tauntLines: [
    '"I have already seen this fight. I do not enjoy seeing it."',
    '"You cannot surprise me. The paths show every moment."',
    '"Fight harder. The future requires it."',
    '"I am not your enemy. I am the thing your enemy would have become if left unchecked."',
    '"Keep going. I have seen the end. What you do between now and then still matters."',
  ],

  victoryLines: [
    '"As the paths showed." He stops.',
    '"You fought well." He withdraws slowly.',
    '"This outcome was one of the ones I saw. Not the worst." He means it.',
    '"Survive. Whatever comes next. Keep surviving." He goes quiet.',
  ],

  defeatLines: [
    '"Not... the future I saw." He stills.',
    '"You existed outside the paths." He sounds confused.',
    '"Or I... chose wrong." He considers this for a long time.',
    '"Maybe there was another way." He says it quietly. "Maybe."',
    'The Founding Titan form collapses. What is left is just a person.',
  ],

  special: {
    name: 'Path Foresight',
    desc: 'Eren has seen 2 of the player\'s upcoming moves through the paths. For the first 2 times the player uses a basic attack in the fight, Eren automatically dodges it completely (0 damage). After those 2 dodges are spent, he fights normally. Using a skill instead of a basic attack bypasses this foresight.',
    trigger: [
      { type: 'on_basic_attack', key: 'pathForesight', maxUses: 2 },
    ],
    engineNote: `Track bossState.pathDodgesLeft (default 2). On player basic attack (not skill): if pathDodgesLeft > 0, set finalDmg = 0, decrement pathDodgesLeft, show foresight dodge line. Skills bypass this completely. Show remaining dodges each time one is spent. When 0, basic attacks apply normally. Players who open with skills instead of basic attacks get full damage from the start.`,
    narrativeLines: [
      '"I saw this attack in the paths." He steps aside.',
      '"The paths showed your basic attack pattern." Dodged.',
      '"You used a skill. I did not see that." He takes it.',
      '"Path foresight spent." He fights without that advantage now.',
    ],
  },

  playerHitLines: [
    '"Good hit." The ribcage fractures slightly.',
    '"That one reached me." He adjusts.',
    '"Real power." He takes it.',
    '"You hit the Founding Titan." He acknowledges it.',
  ],

  playerSkillLines: [
    '"A technique I did not see in the paths." He takes it.',
    '"Good skill. That one surprised me."',
    '"Strong output." He adjusts.',
    '"Your technique bypassed foresight. Smart."',
  ],

  drops: [
    'founding_titan_bone',
    'path_memory_crystal',
    'rumbling_echo_stone',
    'hardening_fragment',
    'yeager_mark',
  ],
}
