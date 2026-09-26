/**
 * Asta - The Anti-Magic Devil Host
 * Grade: SS | Floor: 65
 * Black Clover
 */

export const asta = {
  id: 'asta',
  name: 'Asta',
  floor: 65,
  grade: 'SS',
  emoji: '📖',
  image: null,
  hp: 13000,
  maxHp: 13000,
  atk: 1100,
  def: 380,
  exp: 10000,
  gold: 7000,
  type: 'shadow',
  weakTo: [],
  resistTo: ['physical', 'magic', 'fire', 'ice', 'holy', 'shadow'],

  personality: 'loud-relentless-sincere',
  voice: 'Loud, earnest, and slightly overwhelming. Says exactly what he means at twice the necessary volume.',

  lore: `He was born with no magic. Zero. Not low magic: none. In a world built on magic, this means nothing, and he built something from nothing because the alternative was giving up.

His Anti-Magic Devil Liebe grants him swords that negate all magic on contact. Demon Slayer cancels magic spells. Demon Dweller fires anti-magic slashes that dispel magical effects. Demon Destroyer nullifies cause-and-effect on whatever it cuts. Sword of the Witch Queen negates magic at the point of contact.

He physically cannot use magic. What he does instead is negate yours and then hit you until you stop.

He made it to this floor through a combination of anti-magic nullification, physical conditioning that borders on supernatural, and the absolute refusal to accept that any ceiling applied to him personally.`,

  entrance: [
    '"THIS IS IT! THIS IS THE FLOOR!" He arrives at a run.',
    '"I am going to be honest I did not think I would make it this far but here I am!"',
    '"My name is Asta! I am going to be the Wizard King!"',
    'He draws Demon Slayer. It does not glow. It does not hum. It erases.',
    '"OKAY! I AM READY! ARE YOU READY?! LET\'S GO!"',
  ],

  phases: {
    75: [
      '"OKAY! You are really strong! I like that!"',
      '"Black Asta: partial." Anti-magic coats his arm.',
      '"I am going to stop being careful about my body now!"',
    ],
    50: [
      '"Black Asta: full." Devil power runs through him.',
      '"Liebe! LET\'S DO IT!" He grows demon wings.',
      '"I know this is scary! I am a little scared too! But I am NOT STOPPING!"',
    ],
    25: [
      '"ZETTAI MAGIC ZONE!" Anti-magic explodes outward.',
      '"Everything in range: ALL MAGIC GONE! COME AT ME!"',
      '"This is the moment where I always find more power! HERE WE GO!"',
    ],
  },

  attacks: [
    'Demon Slayer Slash',
    'Demon Dweller Dispel',
    'Demon Destroyer: Causality Cut',
    'Anti-Magic Barrage',
    'Black Asta Charge',
  ],

  attackNarratives: {
    'Demon Slayer Slash': [
      'He swings the massive sword with both hands.',
      'The blade is too large for someone his size to be swinging this fast.',
      'He swings it this fast.',
      'The anti-magic edge cuts through any magical defense it touches.',
      '"Demon Slayer! Your barrier does NOT COUNT!"',
    ],
    'Demon Dweller Dispel': [
      'He swings Demon Dweller in an arc.',
      'The crescent of anti-magic flies off the blade.',
      'It hits your active buffs and they dissolve on contact.',
      'Fire resistance, strength enhancement, barrier: all of it gone.',
      '"Demon Dweller dispels enchantments! USEFUL!"',
    ],
    'Demon Destroyer: Causality Cut': [
      'He draws Demon Destroyer.',
      'The blade finds your last active effect and cuts through the cause of it.',
      'Not the effect. The cause. The origin.',
      'Regen effects stop mid-tick. Momentum disappears. Planned combinations fail.',
      '"Causality cut! Whatever made that happen, does NOT anymore!"',
    ],
    'Anti-Magic Barrage': [
      'He starts running.',
      'He does not stop running.',
      'He hits you with Demon Slayer in a continuous moving assault.',
      'Each hit dispels whatever magic defended against the last hit.',
      '"ANTI-MAGIC BARRAGE! NO MAGIC DEFENDS AGAINST THIS! NONE!"',
    ],
    'Black Asta Charge': [
      '"LIEBE! EVERYTHING!"',
      'Anti-magic coats every surface of his body.',
      'He throws himself at you shoulder-first.',
      'The impact zone nullifies everything in contact.',
      '"CHARGE! I CANNOT DO MAGIC SO I DO THIS INSTEAD!"',
    ],
  },

  dodgeLines: [
    '"WOAH! You are FAST!"',
    '"Nice dodge! Do it again!"',
    '"You moved! I respect that!"',
    '"FAST! Okay! Updating my plan!"',
  ],

  hitLines: [
    '"OW! YES! GOOD HIT!"',
    '"You hit me! That is a GREAT sign!"',
    '"Strong! I like opponents who are strong!"',
    '"GOOD POWER! Come on!"',
  ],

  tauntLines: [
    '"I cannot use magic and I am STILL ON THIS FLOOR! Let that sink in!"',
    '"Your magic does not work on my swords! USE SOMETHING ELSE!"',
    '"I am going to become the Wizard King without a single drop of magic! COME AT ME!"',
    '"You can do better than that! I need a REAL fight right now!"',
    '"I have been training my body since I was five! Muscles do not need mana!"',
  ],

  victoryLines: [
    '"GOOD FIGHT! Seriously! Really good!" He is out of breath.',
    '"You are strong! Train more! Come back! I want a rematch!"',
    '"You gave me a real fight and that means everything." He offers a fist bump.',
    '"REST! Then get back up! That is the whole job!"',
  ],

  defeatLines: [
    '"YOU... BEAT ME!" He looks shocked.',
    '"A REAL LOSS!" He catches his breath.',
    '"Okay. OKAY." He sits on the floor panting.',
    '"You are stronger than me right now." He points at you. "RIGHT NOW. That changes."',
    '"I AM GOING TO TRAIN UNTIL I CAN BEAT YOU! REMEMBER THAT!" He shouts it at the ceiling.',
  ],

  special: {
    name: 'Anti-Magic Nullification',
    desc: 'Asta is completely immune to magic-type skill damage. Skills dealing magic, fire, ice, holy, shadow, or void damage deal 0. Only physical-damage skills and basic attacks affect him. His swords also strip one random buff from the player each time they hit (Demon Dweller effect), max once per turn.',
    trigger: [
      { type: 'passive', key: 'antiMagicImmunity' },
      { type: 'on_deal_damage', key: 'demonDwellerDispel', maxOncePerTurn: true },
    ],
    engineNote: `On player skill use: check skill damage type. If type includes 'magic', 'fire', 'ice', 'holy', 'shadow', or 'void': set finalDmg = 0, show nullification line. Physical skills and basic attacks apply normally. On each enemy hit that deals damage: if player.activeEffects has any 'strengthen' or 'regen' type effect AND !bossState.dispelledThisTurn: remove one random such effect, set bossState.dispelledThisTurn = true, show dispel line. Reset dispelledThisTurn at turn start.`,
    narrativeLines: [
      '"ANTI-MAGIC! Your spell does NOTHING!"',
      '"Magic nullified! Swing harder without it!"',
      '"Demon Dweller dispels one of your buffs!" He announces it.',
      '"That effect is GONE! Deal with it!"',
    ],
  },

  playerHitLines: [
    '"OW! Physical hit! THOSE WORK!"',
    '"You figured it out! Hitting me WITHOUT magic!"',
    '"GOOD HIT! You are using the right approach!"',
    '"Strong physical attack! I respect that!"',
  ],

  playerSkillLines: [
    '"Magic skill? NULLIFIED! Try physical!"',
    '"Anti-magic says NO to that!"',
    '"Your technique hits the anti-magic field and stops. Try differently."',
    '"ANTI-MAGIC! That does not work here! Physical only!"',
  ],

  drops: [
    'demon_slayer_fragment',
    'anti_magic_shard',
    'black_clover_grimoire_page',
    'liebe_devil_core',
    'five_leaf_clover_dust',
  ],
}
