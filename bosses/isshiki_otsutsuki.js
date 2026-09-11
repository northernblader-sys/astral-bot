/**
 * Isshiki Otsutsuki - The Ominous God
 * Grade: SSS | Floor: 86
 * Naruto / Boruto
 */

export const isshiki_otsutsuki = {
  id: 'isshiki_otsutsuki',
  name: 'Isshiki Otsutsuki',
  floor: 86,
  grade: 'SSS',
  emoji: '🔴',
  image: null,
  hp: 78000,
  maxHp: 78000,
  atk: 3700,
  def: 3000,
  exp: 42000,
  gold: 28000,
  type: 'divine',
  weakTo: ['void'],
  resistTo: ['physical', 'magic', 'fire', 'ice', 'shadow'],

  personality: 'cold-efficient-alien',
  voice: 'Economical. No wasted words. Every sentence is a decision.',

  lore: `He came to Earth to plant a God Tree and harvest humanity. His partner betrayed him and left him for dead. He survived by shrinking himself to microscopic size and hiding inside a crow for fifteen years. He is patient the way a weapon is patient.

Sukunahikona allows him to shrink any non-living object to microscopic scale instantly. Daikokuten stores those objects in a pocket dimension and retrieves them at will, instantly enlarging them. He can make your attack disappear mid-flight. He can retrieve a collapsed building at full size inside your guard.

In combat he does not block. He makes the incoming attack a different size. He does not dodge. He removes the space between your attack and nothing.

His actual life force, separate from his vessel, can only be killed if used completely. He cannot be defeated by conventional attrition. You have to make him spend everything.`,

  entrance: [
    'He steps out of a black Karma mark in the wall.',
    'No announcement. No pause for effect.',
    '"You have thirty seconds before this becomes pointless for you." He means it.',
    'He examines you with one red eye.',
    '"Come." He raises both hands.',
  ],

  phases: {
    75: [
      '"Sukunahikona." He begins shrinking the room.',
      '"I will shrink your cover. Then your options. Then you."',
      '"There is no defense against something that no longer has size."',
    ],
    50: [
      '"Daikokuten retrieves." He pulls something massive from the pocket dimension.',
      '"You are not the only thing I have been storing."',
      '"The attack I put away earlier is ready now."',
    ],
    25: [
      '"I have a finite amount of life left." He says it like reviewing a balance sheet.',
      '"I will spend all of it on you." This is the most personal statement he makes.',
      '"Come closer. I will end this efficiently."',
    ],
  },

  attacks: [
    'Sukunahikona Shrink',
    'Daikokuten Retrieval',
    'Karma Amplification Strike',
    'Black Cube Barrage',
    'Life Force Burn',
  ],

  attackNarratives: {
    'Sukunahikona Shrink': [
      'He points at your shield, your weapon, the ground beneath your feet.',
      'They shrink. Not weaken. Shrink to microscopic scale.',
      'Your defense physically disappears.',
      'He does not rush. He watches you realize what happened.',
      '"Sukunahikona applies to non-living matter. Your gear qualifies."',
    ],
    'Daikokuten Retrieval': [
      'He retrieves something from the pocket dimension.',
      'It expands to full size instantly inside your personal space.',
      'A boulder. A spike. A compressed wall of chakra.',
      'There is no warning. It is simply there at full size at full velocity.',
      '"Daikokuten storage has no retrieval lag. None."',
    ],
    'Karma Amplification Strike': [
      'The Karma mark on his forehead activates.',
      'His physical strike carries the amplified output of an Otsutsuki.',
      'He closes the distance faster than the mark should allow.',
      'The hit arrives and carries the weight of a god\'s full payload.',
      '"Karma is not a seal. It is a vessel. And I am the most dangerous thing it has carried."',
    ],
    'Black Cube Barrage': [
      'Dozens of black cubes appear around you.',
      'He shrinks them, retrieves them enlarged, shrinks them again.',
      'The pattern is irregular to prevent prediction.',
      'Three cubes expand to full size on contact with your body.',
      '"No pattern to learn. That is intentional."',
    ],
    'Life Force Burn': [
      'He ignites his own remaining life span.',
      'The output of an Otsutsuki spending mortality is catastrophic.',
      'The energy wave does not target. It fills the room.',
      'Everything in the room takes it.',
      '"I have approximately four hours of life left. I will use them now."',
    ],
  },

  dodgeLines: [
    '"You moved. Recalculating trajectory."',
    '"Evasion observed. Shrinking your next landing zone."',
    '"Good reaction. It will not help with the next one."',
    '"You are fast for something with mass." He adjusts.',
  ],

  hitLines: [
    '"Damage registered." He does not react physically.',
    '"You hit an Otsutsuki." He says it without inflection. "This is noted."',
    '"Good output." He files it.',
    '"More than projected." He adjusts his threat assessment.',
  ],

  tauntLines: [
    '"You have a fixed power level. Mine is being actively spent. Think about which runs out first."',
    '"I can make your attack not exist. How do you plan to fight that?"',
    '"Otsutsuki do not lose to things with finite lifespans."',
    '"Your techniques are based on chakra I brought to this planet. Irony acknowledged."',
    '"The life I am spending to fight you has infinite chakra behind it. Yours does not."',
  ],

  victoryLines: [
    '"Inefficient." He closes his eye.',
    '"You lasted longer than the projection. Minor error in my calculations."',
    '"Recover. There is no point in your death here."',
    '"Spend less time on technique and more on power scaling." He departs.',
  ],

  defeatLines: [
    '"Life force: critical." He checks his own body.',
    '"You forced me to spend everything." He sounds almost approving.',
    '"An Otsutsuki spent by a mortal." He considers this.',
    '"The planet... produced something interesting." He says it like a report.',
    '"Acceptable result." He disappears into ash.',
  ],

  special: {
    name: 'Sukunahikona Defense',
    desc: 'Three times per fight, Isshiki can shrink an incoming attack to zero: the next player attack that would deal more than 10% of his max HP is automatically nullified to 0 damage. He announces "Sukunahikona" the turn before each nullification (giving the player one turn to use a lower-damage option to waste the counter or plan around it).',
    trigger: [
      { type: 'on_incoming_damage', key: 'sukunahikonaCounter', threshold: 0.10, maxUses: 3 },
    ],
    engineNote: `Track bossState.sukunahikonaCharges (default 3) and bossState.sukunahikonaWarning (bool). At end of player's turn: if sukunahikonaCharges > 0, set sukunahikonaWarning = true, show warning line. On next player attack: if sukunahikonaWarning && finalDmg > enemy.maxHp * 0.10: set finalDmg = 0, decrement sukunahikonaCharges, set sukunahikonaWarning = false, show nullification line. If player uses a low-damage attack (below threshold), do not consume the charge, reset warning for next turn.`,
    narrativeLines: [
      '"Sukunahikona." Your attack vanishes mid-flight.',
      '"That technique has been reduced to microscopic scale."',
      '"Sukunahikona ready." The warning. One turn.',
      '"Charges remaining: " + remaining. He counts them out.',
    ],
  },

  playerHitLines: [
    '"Damage accepted. Noted."',
    '"You struck an Otsutsuki." He files it.',
    '"Strong output." He adjusts stance.',
    '"Real power. Acknowledged."',
  ],

  playerSkillLines: [
    '"A technique with real payload." He watches it arrive.',
    '"Strong skill. Worth countering."',
    '"Your technique reached me. That is unusual."',
    '"Good output. I will factor it in."',
  ],

  drops: [
    'sukunahikona_fragment',
    'daikokuten_cube',
    'otsutsuki_karma_shard',
    'life_force_residue',
    'isshiki_black_rod',
  ],
}
