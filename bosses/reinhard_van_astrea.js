/**
 * Reinhard van Astrea - The Sword Saint
 * Grade: SSS+ | Floor: 96
 * Re:Zero
 */

export const reinhard_van_astrea = {
  id: 'reinhard_van_astrea',
  name: 'Reinhard van Astrea',
  floor: 96,
  grade: 'SSS+',
  emoji: '🗡️',
  image: null,
  hp: 140000,
  maxHp: 140000,
  atk: 5000,
  def: 9999,
  exp: 68000,
  gold: 46000,
  type: 'divine',
  weakTo: [],
  resistTo: ['physical', 'magic', 'fire', 'ice', 'shadow', 'holy', 'poison', 'void', 'time'],

  personality: 'polite-regretful-invincible',
  voice: 'Warm and apologetic, the voice of someone who is genuinely sorry for how one-sided this is.',

  lore: `He holds every Divine Protection there is to hold. The Sword Saint blessing is the most famous but it is one among hundreds: fire resistance, water resistance, gravity resistance, cold resistance, mental resistance, resistance to any attack anyone near him has ever seen. If someone tries something against him, he gains resistance to it in the moment.

He cannot die by sword. He cannot be harmed by elements he has experienced. He regenerates. He receives future blessings retroactively, meaning if someone invents a new way to hurt him, the Protection arrives before the hurt does.

He is the strongest human alive and he knows it and he hates it. He wishes someone could beat him. He has never found anyone who could. He fights with regret and does not hold back because holding back would be its own form of disrespect.

He hopes you are the one who changes things. He does not expect it. He hopes.`,

  entrance: [
    '"I have been looking forward to this." He bows.',
    '"Not because I expect an easy victory. Because I expect a real fight." He means this.',
    '"Reinhard van Astrea. Knight of Lugunica. Sword Saint."',
    '"I am going to apologize in advance for the Divine Protections." He draws his sword.',
    '"Please show me everything. I need to see if you can reach me."',
  ],

  phases: {
    75: [
      '"You are landing hits." He sounds genuinely surprised and pleased.',
      '"The Divine Protections are adapting to your techniques in real time."',
      '"Please keep going. This is the most interesting fight I have had."',
    ],
    50: [
      '"Half." He exhales. "I have not been at half before."',
      '"I am going to stop restraining my sword arm." His grip changes.',
      '"I am sorry. I mean that. This is about to escalate significantly."',
    ],
    25: [
      '"You reached twenty-five percent." He goes quiet.',
      '"Nobody has done this." He looks at you differently.',
      '"I am going to use everything I have. Please survive it. I would like a rematch."',
    ],
  },

  attacks: [
    'Sword Saint Slash',
    'Dragon\'s Roar: Vollachia',
    'Holy Smite',
    'Protection Surge',
    'Swordstyle: Reid',
  ],

  attackNarratives: {
    'Sword Saint Slash': [
      'He draws once.',
      'One clean horizontal cut.',
      'The technique itself carries no flourish.',
      'Its power is purely in the precision and force behind a man with infinite physical blessings.',
      'The cut creates a shockwave through the room and he sheathes before the sound arrives.',
    ],
    'Dragon\'s Roar: Vollachia': [
      'He invokes the Dragon\'s name.',
      'Lightning falls from inside the dungeon roof.',
      'This should not be possible without open sky.',
      'The blessings make it possible.',
      'Multiple bolts, each targeted, fill the space you have to move through.',
    ],
    'Holy Smite': [
      'Holy divine energy concentrates in his blade.',
      'He brings it down and the impact radiates outward.',
      'The holy energy is not discriminate. It impacts everything in range.',
      'Your shadow-type resistances mean nothing against a Sword Saint\'s holy blessing.',
      '"Holy Smite. One of several divine blessings active right now." He counts.',
    ],
    'Protection Surge': [
      'He used a technique you just tried against him.',
      '"Protection acquired." He counters with the same energy type.',
      'Whatever damage type you most recently dealt, he returns it amplified.',
      'The Divine Protection of Resonance has kicked in.',
      '"Every technique you use: I gain protection and a counter-blessing for it." He apologizes again.',
    ],
    'Swordstyle: Reid': [
      '"Swordstyle of the First Sword Saint." He adopts the stance.',
      '"I inherited this from the bloodline."',
      'The style is older than the kingdom.',
      'It involves three strikes that arrive as one, separated by microseconds that feel like eternities.',
      'All three land before you register the first.',
    ],
  },

  dodgeLines: [
    '"You dodged. That was remarkable." He means it.',
    '"Fast enough to avoid a Sword Saint\'s strike. You should be proud of that."',
    '"Impressive evasion. You are genuinely fast."',
    '"You moved in time. How." He is genuinely curious.',
  ],

  hitLines: [
    '"You hit me." He stares at the impact point.',
    '"You actually... hit me." He sounds like he is hearing music.',
    '"A blow that reached the Sword Saint." He touches it.',
    '"How." He says it with open wonder.',
  ],

  tauntLines: [
    '"I am not trying to defeat you quickly. I want to see everything you can do."',
    '"The Divine Protections adapt in real time. What worked once may not work again."',
    '"I genuinely hope you find the gap. I have been looking for it myself."',
    '"Please do not hold back. I need to know if this is possible."',
    '"Every technique you try: I gain resistance and a counter. You need something I have never seen."',
  ],

  victoryLines: [
    '"You came closer than anyone I have fought." He bows.',
    '"I am sorry it ended this way. You are exceptional."',
    '"Train. Please. I want a rematch when you are ready."',
    '"Come back. I will be waiting." He means every word.',
  ],

  defeatLines: [
    'He looks at his hands.',
    'He has never done this before. Looked at his hands after a loss.',
    '"You broke through the Divine Protections." He says it quietly.',
    '"The Sword Saint can be defeated." He says it like confirming something vital.',
    '"Thank you." He says it and sits down. "Thank you for this."',
  ],

  special: {
    name: 'Divine Protection Adaptation',
    desc: 'The first time any damage type is used against Reinhard (fire, ice, shadow, holy, physical, magic, etc.), he gains 50% resistance to that type permanently. Second use of same type: 75% resistance. He can never be fully immune through this (caps at 75%). This forces the player to vary damage sources constantly.',
    trigger: [
      { type: 'on_incoming_damage_type', key: 'divineProtection', stackable: true },
    ],
    engineNote: `Track bossState.protections = {} (damageType -> resistance level). On each player attack: determine damageType (from skill.element or 'physical' for basic). If protections[type] is undefined: set to 0.50, apply: finalDmg = Math.floor(finalDmg * 0.50), show first-resistance line. If protections[type] === 0.50: set to 0.75, apply 0.25x multiplier total, show second-resistance line. Never goes higher. Show protection announcement each time a new type is encountered.`,
    narrativeLines: [
      '"Divine Protection acquired." That damage type is now reduced.',
      '"Protection reinforced." 75% resistance now.',
      '"I have never encountered that damage type before." First time resistance applies.',
      '"You need to vary your approach. I adapt to what I experience."',
    ],
  },

  playerHitLines: [
    '"You hit me." Wonder in his voice.',
    '"A real strike. How."',
    '"You broke through." He is awed.',
    '"Strong." He says it like a prayer.',
  ],

  playerSkillLines: [
    '"A technique I have not seen." He braces.',
    '"New skill: Protection acquisition begins."',
    '"Strong output." The Protection activates.',
    '"I have gained resistance to that. Use something else."',
  ],

  drops: [
    'divine_protection_shard',
    'sword_saint_legacy_fragment',
    'dragon_blessing_crystal',
    'vollachia_thunder_rune',
    'reid_bloodline_piece',
  ],
}
