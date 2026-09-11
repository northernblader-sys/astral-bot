/**
 * Zeno, the Omni-King
 * Grade: OMNI | Floor: 100
 * Dragon Ball Super
 */

export const zeno = {
  id: 'zeno',
  name: 'Zeno, the Omni-King',
  floor: 100,
  grade: 'OMNI',
  emoji: '👑',
  image: null,
  hp: 500000,
  maxHp: 500000,
  atk: 10000,
  def: 9999,
  exp: 120000,
  gold: 80000,
  type: 'divine',
  weakTo: [],
  resistTo: ['fire', 'ice', 'shadow', 'holy', 'void', 'time', 'physical'],

  personality: 'childlike-absolute',
  voice: 'Speaks like a delighted child who cannot conceive of something not dying when he wants it to.',

  lore: `Before the gods feared their gods, there was Zeno. He does not rule the multiverse. He simply decides whether it continues.

He has no technique, no form, no strategy. He raised his hand once and erased six universes because he was bored. He has never thrown a punch. He has never needed to. The concept of resistance does not reach him.

He sits at the highest throne because nothing in existence is above him. When he smiles, the gods go quiet. When he stops smiling, everything ends.

He thinks you are interesting. That is the only reason you are still here.`,

  entrance: [
    'The air goes perfectly still.',
    'No wind. No sound. The dungeon itself holds its breath.',
    'A small figure appears in the center of the room, hovering without effort.',
    'He tilts his head and blinks at you with enormous eyes.',
    '"Ohhh! A fighter! Fun, fun, fun!" He claps his tiny hands. The walls crack.',
  ],

  phases: {
    75: [
      'He squints at you, suddenly very focused.',
      '"You are still here. That is new."',
      'The floor beneath your feet flickers. For one terrible moment, it does not exist.',
    ],
    50: [
      '"Ehhhh. Getting a little boring."',
      'He raises one finger. The ceiling vanishes into white light.',
      'Every instinct you have screams at you to run. There is nowhere to run.',
    ],
    25: [
      'He stops clapping.',
      'The temperature of the room drops to nothing.',
      '"I think... I will erase this part now." He points directly at you.',
    ],
  },

  attacks: [
    'Erase Touch',
    'Omnipresent Pressure',
    'Void Clap',
    'Reality Blink',
    'Omni Beam',
  ],

  attackNarratives: {
    'Erase Touch': [
      'He reaches out one small hand toward you.',
      'Where his fingertip points, the air simply stops existing.',
      'The beam is not fire or force. It is deletion.',
      'You throw yourself aside and feel the edge of it graze your soul.',
      'Where it passed, the floor is gone. Not broken. Gone.',
    ],
    'Omnipresent Pressure': [
      'His aura expands outward without warning.',
      'It is not heat. It is not force. It is the weight of absolute authority.',
      'Your knees bend. Your lungs compress. The world tells you to kneel.',
      'Every cell in your body registers the same message: stop.',
      'You push through it. He watches with mild surprise.',
    ],
    'Void Clap': [
      'He brings his hands together.',
      'The sound arrives before the motion does.',
      'A shockwave of pure nothingness expands in every direction.',
      'It does not destroy. It unmakes. There is a difference, and you feel it.',
      'The edges of the room blur. You slam into the far wall.',
    ],
    'Reality Blink': [
      'He blinks. That is all.',
      'When his eyes open, you are somewhere else in the room.',
      'Not thrown. Not launched. Simply rearranged.',
      'He tilts his head. "You moved! That was fast." He means the blink.',
      'Your body takes the transition damage from existing in two places at once.',
    ],
    'Omni Beam': [
      'He opens his mouth, still smiling.',
      'A beam of pure white light pours out, wide as the corridor.',
      'It has no color at the center. Color has not been permitted here.',
      'The beam does not roar. It hums. Like silence made louder.',
      'You dive and the edge clips you. Half the dungeon wall is missing.',
    ],
  },

  dodgeLines: [
    '"Woah! You moved! Do it again!"',
    'He claps for you. It is the most terrifying applause you have ever heard.',
    '"Faster than the last one! Fun, fun!"',
    'He watches your dodge with genuine delight. That does not make it less dangerous.',
  ],

  hitLines: [
    'He looks down at where your attack landed and blinks slowly.',
    '"Oh. That tickled a little."',
    'He touches the spot you hit and seems genuinely puzzled.',
    '"You hit me! Nobody does that." He does not sound angry. That is worse.',
  ],

  tauntLines: [
    '"Are you tired already? That is okay. I can wait."',
    '"The last one cried. Will you cry?"',
    '"I like you. I hope I do not have to erase you." He tilts his head. "Much."',
    '"Fight harder! I want to see more!"',
    '"Should I be trying? I forget sometimes."',
  ],

  victoryLines: [
    '"Aww. It is over already." He pouts.',
    'He floats above your crumpled body and waves.',
    '"You were fun. Most are not fun." He begins to leave.',
    '"Next time fight more! Okay? Promise?"',
  ],

  defeatLines: [
    'He stares at you for a long time.',
    '"You... won?" He says it like a child discovering a new word.',
    '"Interesting." He does not sound angry. He sounds fascinated.',
    '"I will remember you. Nobody else has done that." He disappears.',
    'The dungeon reassembles itself. Slowly. Like it was embarrassed.',
  ],

  domainLines: [
    'He raises both hands and the universe inside the room becomes his.',
    'Every law of physics politely excuses itself.',
    'You are in his space now. There is no floor. There is no ceiling. There is only his decision.',
  ],

  domainStrainLines: [
    '"Hmm. Staying in here a long time..."',
    '"Getting a little tired of this place too." He frowns slightly.',
  ],

  domainBreakoutLine: 'He lets the domain drop on his own. He was getting bored.',

  special: {
    name: 'Erase Decree',
    desc: 'At 50% HP, Zeno points at the player and erases one random stat (str, agi, int, def, or lck) to 0 for 3 turns. At 25% HP, he also silences the player, preventing skill use for 2 turns.',
    trigger: [
      { type: 'hp_threshold', value: 0.50, key: 'erasedStat', oneShot: true },
      { type: 'hp_threshold', value: 0.25, key: 'skillSilence', oneShot: true },
    ],
    engineNote: `On first trigger (50%): pick a random stat from ['str','agi','int','def','lck'], store in bossState.erasedStat and bossState.erasedStatTurns = 3. Apply a weaken effect that zeroes that stat. Announce which stat was erased. On second trigger (25%): set bossState.silenced = true, bossState.silencedTurns = 2. Block skill use and show the silence line. Decrement both counters at end of each player turn and restore when they reach 0.`,
    narrativeLines: [
      '"That part of you is boring. I am removing it."',
      'He points one finger and a piece of you dims.',
      '"You cannot do that anymore. I decided." He smiles.',
      '"Skills? No. I do not want to see that right now."',
    ],
  },

  playerHitLines: [
    '"Oh! You hit me! You actually hit me!"',
    'He looks genuinely delighted. That is the wrong reaction.',
    '"More! Do more!" He seems to be having the time of his eternal life.',
    '"You are strong! I can see why you got here."',
  ],

  playerSkillLines: [
    '"Ohhhhh what was that?? Do it again!"',
    '"Pretty lights!" He watches your technique with wide eyes.',
    '"That was a good one. I will give you that one."',
    '"Amazing! You learned something real!"',
  ],

  drops: [
    'omni_crystal_shard',
    'royal_decree_rune',
    'void_touched_gem',
    'erased_sigil',
    'universal_crown_fragment',
  ],
}
