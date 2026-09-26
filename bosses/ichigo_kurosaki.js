/**
 * Ichigo Kurosaki - True Shinigami/Quincy/Hollow Hybrid
 * Grade: SS+ | Floor: 76
 * Bleach
 */

export const ichigo_kurosaki = {
  id: 'ichigo_kurosaki',
  name: 'Ichigo Kurosaki',
  floor: 76,
  grade: 'SS+',
  emoji: '🌙',
  image: null,
  hp: 46000,
  maxHp: 46000,
  atk: 2300,
  def: 1000,
  exp: 23000,
  gold: 16000,
  type: 'shadow',
  weakTo: [],
  resistTo: ['physical', 'shadow', 'magic'],

  personality: 'fierce-protective-hybrid',
  voice: 'Blunt and direct. No flair, no ceremony, just intent.',

  lore: `He is four things at once and none of them completely: Shinigami, Hollow, Fullbringer, Quincy. Each bloodline adds a layer. The combination is unstable and powerful in the way that controlled explosions are powerful.

His Zanpakuto has two forms now, both wielded simultaneously. The final Getsuga Tensho made him human temporarily by releasing his name into the sword. He came back stronger. He always comes back stronger.

When he goes into his true Bankai, Tensa Zangetsu compresses all his power into a smaller, faster form. Less volume. More density. More speed. The Hollow mask gives him a second wind when things get dangerous.

He does not have a plan. He has a direction: forward. He has protected everyone he loves through every enemy the world has sent. You are the next one.`,

  entrance: [
    '"So you are the one holding this floor." He rolls his neck.',
    '"I have a bad habit of walking into things way over my head." He grins.',
    '"Good news is I also have a bad habit of winning anyway."',
    'Tensa Zangetsu appears in his hand. The compressed Bankai hums.',
    '"Come on. Let\'s go."',
  ],

  phases: {
    75: [
      '"Bankai." He says it without theater.',
      'The compressed power of Tensa Zangetsu fills the space between you.',
      '"Speed just went up. Keep up."',
    ],
    50: [
      'The Hollow mask fractures onto his face.',
      '"Second wind." His reiatsu spikes.',
      '"You are pushing me. Good. I needed that."',
    ],
    25: [
      '"Final Getsuga Tensho is off the table." He exhales.',
      '"So this is just me." He raises his sword.',
      '"That has always been enough."',
    ],
  },

  attacks: [
    'Getsuga Tensho',
    'Tensa Zangetsu Slash',
    'Hollow Cero',
    'Quincy Cross Burst',
    'Final Bankai Surge',
  ],

  attackNarratives: {
    'Getsuga Tensho': [
      '"Getsuga..." He swings.',
      '"TENSHO!" The crescent of black-red reiatsu launches off the blade.',
      'It carves through the room in a wide arc.',
      'The floor splits where it passes.',
      'You dodge the center and take the edge. The edge is substantial.',
    ],
    'Tensa Zangetsu Slash': [
      'He is next to you before you hear him move.',
      'Bankai-speed means speed beyond conventional tracking.',
      'The slash is single and exact and carries the full density of compressed Bankai.',
      'You get your guard up at the last moment.',
      'The hit comes through the guard anyway. Most of it.',
    ],
    'Hollow Cero': [
      'The mask forms over his face.',
      'A red cero charges at the tip of his blade.',
      '"CERO." He releases it.',
      'The beam is not as controlled as a trained Hollow\'s would be. Rawer. Wider.',
      'The width is the problem. You cannot completely dodge wide.',
    ],
    'Quincy Cross Burst': [
      'The Quincy blood surfaces.',
      'Reishi gather around his free hand in the form of arrows and lances.',
      'He does not aim carefully. He launches all of it.',
      'The spread covers every evasion angle.',
      '"Didn\'t know I could do that. Useful."',
    ],
    'Final Bankai Surge': [
      'He pulls everything into one movement.',
      'All four bloodlines. All of it. One strike.',
      'The resulting output is disorganized and total.',
      'It lands and it is less like being hit by a weapon and more like being inside an explosion.',
      '"That was everything." He pants. "Was that enough?"',
    ],
  },

  dodgeLines: [
    '"Fast." He recalibrates.',
    '"Good move." He adjusts.',
    '"You moved before I thought you would." He notes it.',
    '"Nice evasion." He comes again.',
  ],

  hitLines: [
    '"Ow." He does not stop.',
    '"Good hit." He swings back.',
    '"That one got through." He keeps going.',
    '"Strong." He does not back up.',
  ],

  tauntLines: [
    '"Stop holding back. I can tell you are."',
    '"Give me everything you have. I need to know if I am enough."',
    '"I have fought arrancar, captains, and a god-king. Whatever you are, I have fought worse."',
    '"I do not lose. I have been near losing a lot. I do not lose."',
    '"You are going to have to do better than that to finish this."',
  ],

  victoryLines: [
    '"You gave me a real fight. That matters."',
    '"Train. Come back. I want to see what you become."',
    '"Get up. That is the first step." He offers a hand.',
    '"Good fight." He means it.',
  ],

  defeatLines: [
    '"You beat me." He blinks.',
    '"Huh." He sits on the floor.',
    '"Okay." He looks at his sword. "I need to get stronger."',
    '"You deserve that win." He says it without resentment. "You really do."',
    '"Go." He waves you on. "Don\'t wait for me." He starts thinking about training.',
  ],

  special: {
    name: 'Hollow Resurgence',
    desc: 'Once per fight, when Ichigo would drop to 25% HP or below for the first time, the Hollow mask fully activates. His ATK increases by 40% and he regenerates 15% of max HP instantly. The resurgence lasts 4 turns. After those turns, the mask breaks and his ATK returns to normal.',
    trigger: [
      { type: 'hp_threshold', value: 0.25, key: 'hollowResurgence', oneShot: true },
    ],
    engineNote: `When enemy.hp drops to <= enemy.maxHp * 0.25 for the first time and !bossState.hollowTriggered: set bossState.hollowTriggered = true, heal enemy.hp by Math.floor(enemy.maxHp * 0.15), bossState.hollowAtkBonus = Math.floor(enemy.atk * 0.40), enemy.atk += bossState.hollowAtkBonus, bossState.hollowTurns = 4. Each turn while hollowTurns > 0: decrement hollowTurns. When 0: enemy.atk -= bossState.hollowAtkBonus, show mask-break line.`,
    narrativeLines: [
      'The Hollow mask fractures into place.',
      '"Second wind." He says it quietly.',
      'His reiatsu doubles.',
      'The mask cracks and falls. The resurgence ends.',
    ],
  },

  playerHitLines: [
    '"Good hit. Keep going."',
    '"You are actually strong." He sounds pleased.',
    '"That one landed clean." He keeps fighting.',
    '"Strong." He takes it and swings back.',
  ],

  playerSkillLines: [
    '"A real technique." He watches.',
    '"Strong skill." He adjusts.',
    '"That had weight." He acknowledges it.',
    '"Good output. More."',
  ],

  drops: [
    'tensa_zangetsu_fragment',
    'hollow_mask_shard',
    'getsuga_residue',
    'quincy_cross_piece',
    'hybrid_soul_crystal',
  ],
}
