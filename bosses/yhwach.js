/**
 * Yhwach - The Almighty, Father of the Quincy
 * Grade: SSS | Floor: 93
 * Bleach
 */

export const yhwach = {
  id: 'yhwach',
  name: 'Yhwach',
  floor: 93,
  grade: 'SSS',
  emoji: '👁️',
  image: null,
  hp: 100000,
  maxHp: 100000,
  atk: 4500,
  def: 3500,
  exp: 55000,
  gold: 37000,
  type: 'holy',
  weakTo: ['void'],
  resistTo: ['physical', 'magic', 'fire', 'ice', 'shadow', 'holy', 'time'],

  personality: 'absolute-prophetic-godlike',
  voice: 'Calm and declaratory. He does not make threats. He announces outcomes.',

  lore: `He was born without eyes or ears or a mouth. Without a soul, they said. He distributed fragments of his soul to others and they gained power and he gained their power back when they died. He built an empire on that economy.

The Almighty activates when he opens his eyes. The Almighty sees all possible futures simultaneously. Every attack you make exists in his vision before you make it. He watches the future unfold and selects which one happens. He can see through time and rewrite it. He absorbed the Soul King, the linchpin of all existence.

He does not fight. He edits. Your attack misses because he has already selected the future where it misses. Your advantage disappears because he selects the future where you never had it.

You cannot kill a man who chooses his own outcome.`,

  entrance: [
    'He does not enter. He is simply there, seated, as if he has been waiting since before this floor existed.',
    '"I have already seen this fight." He opens his eyes.',
    '"I know every outcome."',
    '"You will try. You will try very hard." He stands. "I have selected the futures I prefer."',
    '"Come. Let us enact them."',
  ],

  phases: {
    75: [
      '"The Almighty: first stage active." His eyes open fully.',
      '"I now see all possible futures." He says it calmly.',
      '"The ones where you land significant hits are... few."',
    ],
    50: [
      '"Soul King absorption: complete." His power density changes.',
      '"I am not the strongest individual. I am the strongest outcome."',
      '"The future you want does not exist."',
    ],
    25: [
      '"Every remaining future belongs to me." He is very still.',
      '"There is one where you win." He looks at you. "I am removing it."',
      '"Almighty: full activation."',
    ],
  },

  attacks: [
    'Future Selection',
    'Blut Vene Anhaben',
    'Sklaverei',
    'Reishi Lance',
    'Galvanize: Soul Pulse',
  ],

  attackNarratives: {
    'Future Selection': [
      'He raises one hand.',
      'The future where your dodge connects un-selects itself.',
      'The future where his attack misses does the same.',
      'What remains is one outcome: the one where you take the full hit.',
      '"I did not dodge. I selected the future where I did not need to."',
    ],
    'Blut Vene Anhaben': [
      'He extends his defenses outward.',
      'The blood-vein technique forms a field around him.',
      'Attacks that enter the field diminish as if the air itself rejects them.',
      'Your strike reaches him at sixty percent of its original force.',
      '"Blut Vene. Quincy blood defense. It predates your techniques."',
    ],
    'Sklaverei': [
      'He reaches into the spiritual pressure of the room.',
      'He pulls.',
      'The ambient energy, the reishi in the air, in the walls, in you, moves toward him.',
      'Your MP drains. Your buffs compress.',
      '"Everything returns to the Father eventually."',
    ],
    'Reishi Lance': [
      'He gathers reishi from the atmosphere into a spear.',
      'The lance is made of compressed spirit particles and focused through the Almighty.',
      'It travels toward the future-position he selected for you.',
      'Not where you are. Where you will be.',
      'The lance arrives at the correct location before you do.',
    ],
    'Galvanize: Soul Pulse': [
      'He releases a pulse of his own soul outward.',
      'The pulse carries the weight of the Soul King\'s absorbed existence.',
      'Every soul in range feels it as a physical force.',
      'Your HP drops. Your sense of self narrows.',
      '"The Soul King sustains all. I am the Soul King now."',
    ],
  },

  dodgeLines: [
    '"I did not select a future where that landed." He watches you miss.',
    '"Future modification: complete."',
    '"That outcome was already removed." He says it without inflection.',
    '"The future you chose does not exist here."',
  ],

  hitLines: [
    '"You found a future I did not select." He blinks.',
    '"Unexpected. Genuinely unexpected."',
    '"You exist outside my Almighty\'s predicted range." He recalibrates.',
    '"A hit. That is... noteworthy." He sounds like he is genuinely filing something.',
  ],

  tauntLines: [
    '"You cannot win. I have already seen every outcome."',
    '"Your victory condition does not exist in any future I have not already removed."',
    '"The Almighty does not simply predict. It selects. You cannot fight selection."',
    '"I absorbed the linchpin of existence. Calibrate what that means."',
    '"Every breath you take is a future I am permitting."',
  ],

  victoryLines: [
    '"As foreseen." He closes his eyes.',
    '"This outcome was the most probable. You came close to another."',
    '"Sleep. You fought well within the constraints of fate."',
    '"Your future continues. Diminished but present. That is more than most receive."',
  ],

  defeatLines: [
    'He stares at his hand.',
    '"A future I did not see." His voice is different. Smaller.',
    '"The Almighty was... incomplete." He sits.',
    '"There is something beyond future selection." He looks at you. "You found it."',
    '"A miracle." He says it and he means it as the most precise possible word.',
  ],

  special: {
    name: 'The Almighty: Future Edit',
    desc: 'Every 4 turns, Yhwach edits a future. He randomly selects one of three effects: (1) nullifies the player\'s next attack to 0 damage, (2) his own next attack bypasses all defense (deals raw damage), or (3) restores 8% of his max HP. The player sees a warning line: "The Almighty shifts." The turn before the effect activates. They cannot prevent it but can prepare (defend for effect 2, heal prep for effect 3).',
    trigger: [
      { type: 'turn_interval', value: 4, key: 'almightyEdit' },
    ],
    engineNote: `Track bossState.almightyEdit (default null) and bossState.almightyWarning (bool). Every 4th turn: set almightyWarning = true, randomly set almightyEdit to 1, 2, or 3, show warning. On next player action: if almightyEdit === 1: nullify player attack to 0. On next enemy attack: if almightyEdit === 2: bypass all defense (use rawDmg instead of finalDmg). Or if almightyEdit === 3: on turn end heal enemy Math.floor(enemy.maxHp * 0.08). After any effect fires: reset almightyEdit to null and almightyWarning to false.`,
    narrativeLines: [
      '"The Almighty shifts." Future selection in progress.',
      '"The future where your attack lands has been removed." Nullified.',
      '"A future without your defense." He bypasses it.',
      '"This future includes my restoration." He heals.',
    ],
  },

  playerHitLines: [
    '"You found a gap in the Almighty." He notes it.',
    '"Unexpected outcome." He files it.',
    '"You struck the Father of all Quincy." A pause.',
    '"That future was not predicted. Rare." He respects it.',
  ],

  playerSkillLines: [
    '"A technique that crosses temporal prediction." He watches.',
    '"Strong skill. The Almighty is adjusting."',
    '"Your technique reached a future I had not selected." Rare.',
    '"Strong output. Noted and adjusted for."',
  ],

  drops: [
    'almighty_eye_shard',
    'soul_king_fragment',
    'schrift_rune',
    'quincy_reishi_crystal',
    'wandenreich_seal',
  ],
}
