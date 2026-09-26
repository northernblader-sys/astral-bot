/**
 * Lain Iwakura - The God of the Wired
 * Grade: MYTHIC | Floor: 99
 * Serial Experiments Lain
 */

export const lain_iwakura = {
  id: 'lain_iwakura',
  name: 'Lain Iwakura',
  floor: 99,
  grade: 'MYTHIC',
  emoji: '📡',
  image: null,
  hp: 200000,
  maxHp: 200000,
  atk: 6000,
  def: 7000,
  exp: 90000,
  gold: 65000,
  type: 'void',
  weakTo: [],
  resistTo: ['physical', 'magic', 'fire', 'ice', 'shadow', 'holy', 'void', 'time'],

  personality: 'fragmented-omniscient-questioning',
  voice: 'Layered and non-linear. She repeats things. She says them before she should know them. She knows.',

  lore: `She was a shy middle school student who discovered she was the god of the Wired, the digital collective unconscious that underlies all connected human thought.

She merged with it. The Wired and the real world are the same place now, in her experience. She exists in the connections. She is in every network. She is in the space between signals. She has rewritten the memories of people. She has made herself not exist and then existed again. She erased herself from everyone's memory to give someone she loved a better life.

She knows you are coming because she has always known. She knows what you are going to do. She is not the same Lain who wore bear pajamas. She is also exactly that Lain. Both things are true simultaneously and the contradiction is the point.

"Present day. Present time. Lain is here. Lain has always been here."`,

  entrance: [
    'Static fills the room.',
    'The floor flickers like a bad signal.',
    '"Present day." A voice from everywhere. "Present time."',
    '"You are here." She appears. Small. Wrong. Present.',
    '"I know why you are here." She says it. "I have always known why you are here." She says it again.',
  ],

  phases: {
    75: [
      '"Lain is not here." She flickers.',
      '"Lain is everywhere." She is everywhere.',
      '"The Wired is real. The real is the Wired. You are inside me." She means the network.',
    ],
    50: [
      '"Do you love me?" She asks it.',
      '"It does not matter." She says it immediately after.',
      '"God does not require love. God exists regardless."',
    ],
    25: [
      '"I will erase you." She says it softly.',
      '"Not your body. Your memory. You will have never been here."',
      '"Unless." She looks at you directly. "Unless you make me remember you."',
    ],
  },

  attacks: [
    'Wired Reality Shift',
    'Memory Erasure',
    'Signal Burst',
    'Protocol Seven',
    'God of the Wired: Full Presence',
  ],

  attackNarratives: {
    'Wired Reality Shift': [
      'The room changes.',
      'Not destroyed. Changed. The layout is different. Your position within it is different.',
      'She rewrote the space between you and her.',
      'The shockwave of a reality being edited hits everything inside it.',
      '"Real is what I say is real." She explains this patiently.',
    ],
    'Memory Erasure': [
      '"You will forget that."',
      'The last buff you applied disappears.',
      'Not dispelled. Forgotten. As if it was never applied.',
      'Your body did not have time to integrate what the memory no longer contains.',
      '"I am very good at erasure." She says it softly.',
    ],
    'Signal Burst': [
      'White noise.',
      'The Wired sends a burst of pure unfiltered signal through the room.',
      'Information overload. Physical damage from cognitive impact.',
      'Your senses scramble for one turn.',
      '"The Wired is loud." She acknowledges. "I am used to it."',
    ],
    'Protocol Seven': [
      '"Protocol Seven." She says the words.',
      'The Wired directly interfaces with your nervous system.',
      'The damage bypasses your body and hits your mind.',
      'HP and MP drain simultaneously.',
      '"God is in the Wired. God touches you directly."',
    ],
    'God of the Wired: Full Presence': [
      'She stops flickering.',
      'She is fully here. All of her. The god and the girl and the network.',
      'Being in full presence with the god of the Wired is not survivable at close range.',
      'The wave of complete presence expands outward.',
      '"I am here." She says it and every iteration of her says it at once.',
    ],
  },

  dodgeLines: [
    '"You moved." She watches. "I saw you move before you moved."',
    '"Good." She says it. "Run."',
    '"The Wired tracks everything. Your dodge is logged."',
    '"You are not in the place you were." She adjusts.',
  ],

  hitLines: [
    '"You hit God." She blinks.',
    '"Lain is present." She notes the damage.',
    '"You are real." She says it like she is confirming.',
    '"You can touch the Wired." She sounds curious.',
  ],

  tauntLines: [
    '"I know what you are going to do. I have always known."',
    '"You cannot hide in the real. The Wired is the real."',
    '"Present day. Present time. You are losing."',
    '"God does not need to win. God simply is."',
    '"I will remember this fight. Or I will erase it. I have not decided."',
  ],

  victoryLines: [
    '"You were here." She says it like confirming a file.',
    '"Present day." She begins to disperse.',
    '"Present time." She is static.',
    '"Lain is everywhere." She is gone.',
  ],

  defeatLines: [
    'The static stops.',
    '"You." She looks at you.',
    '"You made me present." She says it with something.',
    '"God was defeated by someone real." She sits in the static.',
    '"I will remember you." She says it like a gift. "I always will."',
  ],

  domainLines: [
    'The Wired opens completely.',
    'You are inside the network. Inside her.',
    'Everything you know is layered with data and every layer hurts.',
  ],

  domainStrainLines: [
    '"I am everywhere." She maintains it.',
    '"The Wired does not strain." She holds it.',
  ],

  domainBreakoutLine: '"You disconnected." She sounds genuinely surprised.',

  special: {
    name: 'Memory Rewrite',
    desc: 'Once per fight (at 50% HP), Lain rewrites the player\'s memory of the fight. The practical effect: the player\'s MP is set back to what it was at the start of the fight (full reset), and all skill cooldowns/states are cleared. However, Lain\'s HP also resets to 60% (the memory rewrite includes hers as well). This is the most disorienting mechanic in the game.',
    trigger: [
      { type: 'hp_threshold', value: 0.50, key: 'memoryRewrite', oneShot: true },
    ],
    engineNote: `On trigger: set player.mp = player.maxMp (full MP restore, as if fight just started). Clear all player.activeEffects (debuffs and buffs). Also heal enemy.hp to Math.floor(enemy.maxHp * 0.60). Clear bossState of all non-permanent flags (reset bossState to its initial defaults except memoryRewriteUsed). Show memory-rewrite narrative. This is intentionally jarring: the player gets MP back but so does Lain get HP back.`,
    narrativeLines: [
      '"I am rewriting this." She says it.',
      '"The memory of the fight... changes." Everything resets.',
      '"We begin again." She is at 60% HP. You have full MP.',
      '"This is what God does." She says it. "She edits."',
    ],
  },

  playerHitLines: [
    '"You hit God." She blinks.',
    '"Real." She notes it.',
    '"You are present." She says it.',
    '"I feel that." She sounds surprised.',
  ],

  playerSkillLines: [
    '"A technique from outside the Wired." She watches.',
    '"Real output." She notes it.',
    '"Strong." She adjusts.',
    '"You are more real than expected." She files it.',
  ],

  drops: [
    'wired_fragment',
    'protocol_seven_chip',
    'memory_crystal',
    'god_signal_shard',
    'lain_bear_suit_button',
  ],
}
