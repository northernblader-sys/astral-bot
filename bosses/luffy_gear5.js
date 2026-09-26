/**
 * Monkey D. Luffy - Gear 5, Sun God Nika
 * Grade: SS+ | Floor: 83
 * One Piece
 */

export const luffy_gear5 = {
  id: 'luffy_gear5',
  name: 'Monkey D. Luffy (Gear 5)',
  floor: 83,
  grade: 'SS+',
  emoji: '☀️',
  image: null,
  hp: 65000,
  maxHp: 65000,
  atk: 3100,
  def: 1600,
  exp: 32000,
  gold: 22000,
  type: 'divine',
  weakTo: [],
  resistTo: ['physical', 'fire', 'magic', 'shadow'],

  personality: 'joyful-fearless-chaotic',
  voice: 'Laughs mid-fight. Every sentence ends with something that should be a joke and lands as a threat.',

  lore: `The Gomu Gomu no Mi was never a rubber fruit. It was the Hito Hito no Mi, Model: Nika, the Mythical Zoan that contains the legend of the Sun God Nika: the warrior whose laughter and freedom were the greatest weapons in the world.

In Gear 5, Luffy becomes a cartoon. Literally. Reality in his vicinity becomes malleable. He can turn himself into lightning, eat lightning, turn the ground to rubber, grow to giant size, and compress attacks with his body and return them. His heartbeat sounds like drums. When he laughs in Gear 5, the fight feels different.

The rule of Gear 5 is that there are no rules. He fights like someone who has never been told what fighting is supposed to look like and decided to find out by doing it wrong at maximum intensity.

He is the freest person alive. That is the most dangerous thing you can say about someone in combat.`,

  entrance: [
    'The drums start before he arrives.',
    'BOOM BOOM. BOOM BOOM. BOOM BOOM.',
    'He falls through the ceiling because that was faster than the door.',
    '"WAAAAAAHAHA!" He lands in a heap and bounces up.',
    '"Okay okay okay okay— LET\'S GO!" His white hair stands up. The room stretches.',
  ],

  phases: {
    75: [
      '"Gear 5!" He says it like it is the best thing that has ever happened.',
      'The world around him bends. The floor becomes slightly stretchy.',
      '"WAAAAHAHAHA! This always makes me happy!"',
    ],
    50: [
      '"Okay now I am having fun." He grins at you specifically.',
      '"You are strong! This is the best!" He means it.',
      '"Let me try the big one."',
    ],
    25: [
      '"GIGANTICO!" He grows. To the ceiling. His head hits it. He laughs.',
      '"Sorry about the ceiling. You okay? Okay good. HERE WE GO!"',
      '"SUN GOD NIKA!" The drums hit maximum volume.',
    ],
  },

  attacks: [
    'Gomu Gomu no Mogura Pistol',
    'Lightning Eat',
    'Rubber Reality Zone',
    'Gigant Attack',
    'Dawn Whip',
  ],

  attackNarratives: {
    'Gomu Gomu no Mogura Pistol': [
      'He stretches his arm back.',
      'Far back. Farther than arms go. Around a corner.',
      'The fist comes from an angle that does not correspond to his body position.',
      'You dodge the fist and get hit by the arm swinging back.',
      '"WAHAHA! You dodged the fist! Most people don\'t notice the arm!"',
    ],
    'Lightning Eat': [
      'You throw lightning at him.',
      'He opens his mouth.',
      'He eats it.',
      '"Mmm." He seems satisfied.',
      '"That was good. Got any more?" He has already converted it to his own momentum.',
    ],
    'Rubber Reality Zone': [
      'He stamps his foot and the floor bounces.',
      'Everything in the room has acquired rubber-like properties.',
      'Your attacks stretch past him. His attacks bounce back from unexpected angles.',
      'The physics of the fight are now his and he invented them.',
      '"The rules are different now! WAHAHAHA!"',
    ],
    'Gigant Attack': [
      'He grows to fifteen feet tall.',
      'He swings a rubber fist the size of a cart horse.',
      'The impact radius is the entire room.',
      'You roll under it and the floor where it lands is now concave.',
      '"Sorry!" He shrinks back down. "Was that too big?"',
    ],
    'Dawn Whip': [
      'He extends both arms sideways and begins rotating.',
      'At full extension his arms cover a full circle of the room.',
      'He spins and the whip motion is continuous.',
      'Getting inside the rotation means getting hit by both arms on the return.',
      '"GOMU GOMU NO DAWN WHIP!" He really enjoys saying it.',
    ],
  },

  dodgeLines: [
    '"WOAH! You moved! Okay okay okay—"',
    '"You\'re fast! That\'s so cool!"',
    '"Nice dodge! I am going to remember that one!"',
    '"You actually got away from the arm thing! Nobody gets away from the arm thing!"',
  ],

  hitLines: [
    '"OW!" He says it cheerfully.',
    '"You actually hit me! Yeah!"',
    '"That one! That one was good!" He bounces.',
    '"You\'re strong! I knew it! I knew when you walked in!"',
  ],

  tauntLines: [
    '"Come on, fight me for real! I can take it!"',
    '"Is this everything? I feel like you have more!"',
    '"The freest man in the world is right here! HIT HIM HARDER!"',
    '"I am the Sun God Nika! I laugh during fights! Do you know how unbeatable that is?!"',
    '"My friends are waiting for me so let\'s finish this up by going FULL POWER!"',
  ],

  victoryLines: [
    '"Wahhh. Good fight." He sits on the rubberized floor.',
    '"You are really strong. My crew would like you." He means this.',
    '"Get back up. People like you always get back up." He offers a hand.',
    '"WAHAHAHA! That was great!" He is still laughing.',
  ],

  defeatLines: [
    '"Ehhhh." He blinks.',
    '"You beat Nika?" He looks at the ceiling.',
    '"WAHAHAHAHA!" He laughs.',
    '"The Sun God got beat! That is amazing! You are amazing!" He is genuinely delighted.',
    '"Tell me your name. I want to remember the name of whoever beat me." He grins.',
  ],

  special: {
    name: 'Rubber Reality',
    desc: 'Luffy is immune to all lightning/electric type damage (he eats it and converts it to a 5% HP heal). Additionally, 30% of all physical damage dealt to Luffy bounces back to the attacker (rubber body). This bounce damage is capped at 10% of player max HP per bounce. Cannot be fully countered except by non-physical, non-lightning magic attacks.',
    trigger: [
      { type: 'passive', key: 'rubberBody' },
      { type: 'on_lightning_damage', key: 'lightningEat' },
    ],
    engineNote: `Tag: on incoming physical damage, calculate bounce = Math.min(finalDmg * 0.30, player.maxHp * 0.10), deal bounce as true damage to player after applying their hit. For lightning: set finalDmg = 0, heal enemy by Math.floor(enemy.maxHp * 0.05), show eat line. Magic and shadow attacks apply normally. Track in bossState.rubberActive (always true). Show bounce line when bounce damage is non-zero.`,
    narrativeLines: [
      '"Rubber!" The hit bounces back.',
      'You feel a portion of your own strike return.',
      '"GOMU GOMU! It bounces!" He seems thrilled to explain this.',
      '"Mmm." He eats the lightning. "More?"',
    ],
  },

  playerHitLines: [
    '"OW! Good one!"',
    '"You got me! More!"',
    '"That one actually did it!" He bounces.',
    '"Strong hit! I like you!"',
  ],

  playerSkillLines: [
    '"A special attack! NICE!"',
    '"Strong technique!" The room stretches slightly.',
    '"That skill is real! Let me try to dodge next time!"',
    '"WAHHH that was good! Again!"',
  ],

  drops: [
    'gear5_white_hair_strand',
    'nika_sun_shard',
    'rubber_reality_fragment',
    'gomu_gomu_residue',
    'joy_boy_rune',
  ],
}
