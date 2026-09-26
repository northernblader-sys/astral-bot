/**
 * Naruto Uzumaki - Baryon Mode
 * Grade: SS+ | Floor: 82
 * Naruto / Boruto
 */

export const naruto_baryon = {
  id: 'naruto_baryon',
  name: 'Naruto Uzumaki (Baryon Mode)',
  floor: 82,
  grade: 'SS+',
  emoji: '🦊',
  image: null,
  hp: 60000,
  maxHp: 60000,
  atk: 3200,
  def: 1800,
  exp: 30000,
  gold: 21000,
  type: 'divine',
  weakTo: [],
  resistTo: ['physical', 'magic', 'shadow'],

  personality: 'desperate-fierce-burning',
  voice: 'Raw and urgent, every word said like it might be the last.',

  lore: `Baryon Mode is not a power-up. It is a nuclear reaction. Naruto and Kurama\'s chakra fuse at the atomic level, burning their life force as fuel. Every second in Baryon Mode costs them years. Every attack thrown costs months. There is a clock running and it does not stop.

In exchange for that cost, Naruto gains speed and strength that makes everything before look like warm-up exercises. More importantly: anything he touches has its own lifespan shortened. His strikes drain years from the enemy. His near-misses shorten the air they breathe through.

He knows what this costs. Kurama knew and did not tell him until the mode was active. Naruto fought through that knowledge and kept going, because that is the only thing Naruto Uzumaki has ever known how to do.

He is burning. Every punch is a year gone. He is going to keep punching.`,

  entrance: [
    'He arrives already moving, no time to waste.',
    'The orange-red aura around him is dim and hot, like an ember, not a fire.',
    '"Baryon Mode is running." He says it flat, not boastful.',
    '"Every second costs me. So let\'s make it count."',
    'He drops into his stance. "Come on. I do not have all day. Literally."',
  ],

  phases: {
    75: [
      '"Draining faster now." He checks his hands.',
      '"Good. You are making me spend it on something real."',
      '"Kurama would want me to end this fast. So that is the plan."',
    ],
    50: [
      '"Half the time gone." He exhales.',
      '"All right. Full output. No holding back anything."',
      '"Sorry. This is going to be bad."',
    ],
    25: [
      '"Almost nothing left." He goes quiet.',
      '"One more push." His aura flares one final time.',
      '"For Kurama." He means it completely.',
    ],
  },

  attacks: [
    'Baryon Rasengan',
    'Lifespan Drain Touch',
    'Nuclear Combo',
    'Bijuu Shockwave',
    'Rasenshuriken: Baryon',
  ],

  attackNarratives: {
    'Baryon Rasengan': [
      'He forms the Rasengan and it burns amber instead of blue.',
      'The rotation generates heat that chars the stone around his hand.',
      'He drives it forward and the contact point detonates.',
      'The Baryon Rasengan does not just deal damage, it drains the enemy.',
      'You take the hit and feel something diminish that was not HP.',
    ],
    'Lifespan Drain Touch': [
      'He reaches for your arm.',
      'Contact. One second of it.',
      'The Baryon effect drains lifespan from everything it touches.',
      'Your speed and reactions dull slightly. Your body is slightly older.',
      '"Sorry." He says it and means it. "It does not discriminate."',
    ],
    'Nuclear Combo': [
      'He closes the distance in a single step.',
      'Fists, knees, elbows, all burning amber.',
      'Every contact point drains something.',
      'The combination does not have a gap for you to use.',
      'He finishes and steps back panting, the cost visible on his face.',
    ],
    'Bijuu Shockwave': [
      'He channels residual Kurama energy into a shockwave.',
      'The fox spirit behind the mode roars.',
      'The pressure wave knocks everything backward.',
      'You hit the wall and the air between you and him is on fire.',
      '"Kurama\'s last gift." He says it quietly.',
    ],
    'Rasenshuriken: Baryon': [
      'He forms a Rasenshuriken and it is immediately wrong.',
      'Wrong because it is amber. Wrong because it vibrates at a frequency that hurts just to look at.',
      'He launches it and the rotation generates a drain field on contact.',
      'The shuriken hits and disperses nuclear-style energy through your defense.',
      'The after-damage ticks on you for one turn.',
    ],
  },

  dodgeLines: [
    '"Good dodge. Cost me a second to recalculate."',
    '"You moved. Smart."',
    '"Fast. Really fast." He sounds like he respects it.',
    '"Evade all you want. My time is running down either way."',
  ],

  hitLines: [
    '"Ow." He does not flinch but he does feel it.',
    '"Good hit. Keep going."',
    '"Solid." He absorbs it and answers immediately.',
    '"You are strong. This is a good fight." He means both.',
  ],

  tauntLines: [
    '"I am burning my life to fight you. Appreciate that."',
    '"Every second I am in Baryon Mode costs me years. You better be worth it."',
    '"Kurama told me not to tell you about the cost. I am telling you anyway. Fight me right."',
    '"This mode makes everything I touch lose lifespan. Including the dungeon floor. Keep that in mind."',
    '"I am running out of time. That makes me more dangerous, not less."',
  ],

  victoryLines: [
    '"You fought well." He sits down heavily.',
    '"Worth it." He says it quietly.',
    '"Come back when I have recovered. Round two sounds good."',
    '"You made me spend a lot of years on this." He manages a tired smile.',
  ],

  defeatLines: [
    'He drops to one knee.',
    '"You... beat Baryon Mode." He looks at his hands.',
    '"Good fight." He says it and means it completely.',
    '"Go be great with it." He sits down fully. The amber aura fades.',
    'The mode ends. Whatever was left of it goes with the fight.',
  ],

  special: {
    name: 'Lifespan Drain',
    desc: 'Every time Naruto lands a hit (basic attack or skill), the player\'s stats are temporarily drained: -3% ATK and -3% DEF per hit, stacking, lasting until the end of the fight. This represents the Baryon drain effect. Max stack: -30% on each. Additionally, Naruto\'s own max HP decreases by 2% each turn (life is burning), making long fights cost him.',
    trigger: [
      { type: 'on_deal_damage', key: 'lifespanDrain', stackable: true },
      { type: 'end_of_turn', key: 'baryonBurn' },
    ],
    engineNote: `Track bossState.drainStacks (default 0). Each time enemy deals damage: increment drainStacks (cap at 10). Multiply player.stats.str and player.stats.def by (1 - Math.min(drainStacks * 0.03, 0.30)). Store original stats in bossState.originalStr/Def at fight start. Each turn: enemy.maxHp = Math.max(1000, enemy.maxHp * 0.98); enemy.hp = Math.min(enemy.hp, enemy.maxHp). Show burning line. This makes long fights actually disadvantage Naruto mechanically.`,
    narrativeLines: [
      'The Baryon drain touches you. Something fades.',
      'Your body is slightly older now.',
      '"Baryon drains everything it touches." He does not apologize this time.',
      'The amber aura dims. The cost is visible. He keeps going.',
    ],
  },

  playerHitLines: [
    '"Good hit! More!"',
    '"That one landed clean." He absorbs it.',
    '"Strong. Keep the pressure."',
    '"You are actually making me work." He sounds grateful for it.',
  ],

  playerSkillLines: [
    '"A real technique. Good."',
    '"Strong skill. Noted."',
    '"That works. Keep going."',
    '"Nice form. You trained hard."',
  ],

  drops: [
    'baryon_ember_shard',
    'kurama_chakra_crystal',
    'nine_tails_remnant',
    'lifespan_stone',
    'burning_rasengan_core',
  ],
}
