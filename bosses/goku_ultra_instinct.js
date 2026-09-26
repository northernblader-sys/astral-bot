/**
 * Goku - Ultra Instinct Mastered
 * Grade: SSS | Floor: 90
 * Dragon Ball Super
 */

export const goku_ultra_instinct = {
  id: 'goku_ultra_instinct',
  name: 'Goku (Ultra Instinct)',
  floor: 90,
  grade: 'SSS',
  emoji: '⚡',
  image: null,
  hp: 90000,
  maxHp: 90000,
  atk: 3800,
  def: 2200,
  exp: 48000,
  gold: 32000,
  type: 'divine',
  weakTo: [],
  resistTo: ['physical', 'magic', 'fire', 'ice'],

  personality: 'battle-joyful-instinctive',
  voice: 'Direct and earnest, speaks through action more than words, every line carries the joy of a real fight.',

  lore: `He broke his own limits so many times the limits stopped growing back. Every Saiyan transformation was a ceiling he walked through and forgot about. Ultra Instinct was different. The gods themselves struggled with Ultra Instinct. He mastered it in the middle of a fight.

In Ultra Instinct, his body moves without thought. Attacks are evaded before he registers them. Counters are thrown before he decides to throw them. The mind gets out of the way and pure trained instinct takes over.

Mastered Ultra Instinct gives him silver hair and a silver aura and a calmness that does not look like Goku at all until he smiles. Then it is completely him.

He showed up to this floor because he heard there was someone worth fighting. That information was correct. His power level is currently ridiculous.`,

  entrance: [
    'Silver light fills the corridor before he arrives.',
    'He walks through it casually, hands in his pockets.',
    '"You are the one." He looks you over with calm, silver eyes.',
    '"I can tell just by standing near you. You are actually strong."',
    'He drops into a stance that is barely a stance at all. "All right. Let\'s go."',
  ],

  phases: {
    75: [
      '"You are landing hits. I did not think you would land hits."',
      'The silver aura brightens.',
      '"I am going to stop holding back on the movement. Keep up."',
    ],
    50: [
      '"This is a real fight." He grins for the first time.',
      'The calm breaks slightly and the raw Saiyan joy underneath it surfaces.',
      '"You actually made me feel it! Come on!"',
    ],
    25: [
      '"Okay. This is everything. All of it."',
      'The silver aura goes white at the edges.',
      '"Mastered. Final form. Thank you for making me use it." He means every word.',
    ],
  },

  attacks: [
    'Ultra Instinct Dodge Counter',
    'Kamehameha',
    'Godly Pressure Step',
    'Silver Flash',
    'True Ultra Instinct Combo',
  ],

  attackNarratives: {
    'Ultra Instinct Dodge Counter': [
      'Your attack lands on empty air.',
      'He was not there. He was already behind you.',
      'The counter arrives before you process the miss.',
      'His fist lands in your ribs with the casual precision of breathing.',
      'He does not gloat. His body simply moves to the next position.',
    ],
    'Kamehameha': [
      '"Kame... Hame..."',
      'Blue-white energy collects between his palms.',
      '"HA!" The beam is not an attack so much as a relocation of the problem you represent.',
      'It pushes through everything and the sound of it arrives late, after the damage.',
      'He holds it steady and the wall behind you no longer exists.',
    ],
    'Godly Pressure Step': [
      'He takes one step.',
      'That step generates a shockwave that crosses the room before his foot lands.',
      'You are already adjusting for it when the real follow-up arrives.',
      'The pressure of his aura alone staggers your guard.',
      'He moves through the pressure like it is not there, because for him it is not.',
    ],
    'Silver Flash': [
      'He disappears.',
      'Not teleportation. Just speed that exceeds what your eyes can track.',
      'The silver trail he leaves tells you where he was half a second ago.',
      'His strike lands and then you see the trail end next to you.',
      '"That one I had to think about. You were moving."',
    ],
    'True Ultra Instinct Combo': [
      'Both fists, both feet, elbows, knees, head.',
      'Every surface of his body becomes a weapon in a continuous chain.',
      'Ultra Instinct means each strike feeds into the next without a gap.',
      'Your guard is not protection. It is just more surface to hit.',
      'He finishes the combination with a flat open-palm strike to your chest that moves the floor.',
    ],
  },

  dodgeLines: [
    '"Good! You moved!" He sounds thrilled.',
    '"Fast! You are actually fast!"',
    '"Yes! That is the kind of fighter I came here for!"',
    'He repositions, impressed.',
  ],

  hitLines: [
    '"You landed one." He rubs the spot, grinning.',
    '"Nice! You actually got through!"',
    '"Good hit. Your power is real."',
    '"That one I did not see coming. Strong!"',
  ],

  tauntLines: [
    '"Come on! Stop holding back!"',
    '"Is that everything? I hope that is not everything!"',
    '"Push past your limit! I want to see what you\'ve got!"',
    '"You can do more than that! I can feel it!"',
    '"Fight me like you mean it!"',
  ],

  victoryLines: [
    '"You are strong. Really strong." He offers a hand.',
    '"That was a good fight. One of the best."',
    '"Train more and come back. I want to fight you again when you are ready."',
    '"You gave me everything. That is all anyone can ask." He smiles.',
  ],

  defeatLines: [
    'He sits on the floor, panting.',
    '"You beat Ultra Instinct." He stares at his hands.',
    '"I need to get stronger." He does not sound broken. He sounds energized.',
    '"This is great! A real loss! Now I have something to chase!" He laughs.',
    '"Come find me when I have trained. Round two." He disappears in silver light.',
  ],

  special: {
    name: 'Autonomous Evasion',
    desc: 'For the first 8 turns, Goku has a 40% chance to automatically dodge any attack completely (0 damage) because his body moves before he thinks. This chance increases to 60% at 50% HP. The evasion chance goes to 0% if the player defends three consecutive turns (his instinct adapts but over-adjusts to defense).',
    trigger: [
      { type: 'passive', key: 'autonomousEvasion' },
      { type: 'hp_threshold', value: 0.50, key: 'evasionUpgrade', oneShot: true },
    ],
    engineNote: `On each player attack turn: roll Math.random() against bossState.evasionChance (default 0.40). If roll succeeds: set finalDmg = 0, print evasion narrative, increment bossState.evadeCount. Track bossState.consecutiveDefends. On player defend: increment consecutiveDefends. At 3: set evasionChance to 0 and show "instinct over-adjusted" line. On 50% HP: if evasionChance > 0, set evasionChance = 0.60. On player attack: reset consecutiveDefends to 0.`,
    narrativeLines: [
      'His body moves before your attack lands.',
      'He did not think about dodging. He just did.',
      '"I did not even decide to move. Weird."',
      '"Your defensive pattern confused my instinct. Interesting trick."',
    ],
  },

  playerHitLines: [
    '"Yes! That is what I am talking about!"',
    '"Strong hit! Keep going!"',
    '"You got through my instinct. That takes real power."',
    '"Nice one! Real fighter!"',
  ],

  playerSkillLines: [
    '"A technique! Let me see it!"',
    '"That is a strong move! Try it again!"',
    '"Good power output! Come on!"',
    '"Nice skill. Show me more."',
  ],

  drops: [
    'ultra_instinct_fragment',
    'saiyan_god_ki_crystal',
    'kamehameha_residue',
    'silver_aura_shard',
    'battle_joy_rune',
  ],
}
