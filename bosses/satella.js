/**
 * Satella - The Witch of Envy
 * Grade: SSS+ | Floor: 97
 * Re:Zero
 */

export const satella = {
  id: 'satella',
  name: 'Satella',
  floor: 97,
  grade: 'SSS+',
  emoji: '💜',
  image: null,
  hp: 155000,
  maxHp: 155000,
  atk: 5200,
  def: 3800,
  exp: 71000,
  gold: 47000,
  type: 'shadow',
  weakTo: [],
  resistTo: ['physical', 'magic', 'fire', 'ice', 'shadow', 'void', 'time'],

  personality: 'loving-consuming-broken',
  voice: 'Tender and absolute. She says "I love you" the way gravity says pull.',

  lore: `She was half-elf once. She ate the Witch Factor of Envy and what was left of her is the Witch of Envy, one of the most powerful beings in history, consuming and being consumed by envy in equal measure.

The shadow hands that extend from her are the same hands that Betelgeuse channeled through Sloth. They reach for everything near her and pull. They do not discriminate. Every shadow is her hand. Every darkness is her reach.

She loves Subaru. She loves him so completely that the love has become indistinguishable from possession. She is sealed. She reaches through the seal in moments of crisis. When the seal breaks, she does not speak except to say she loves him, and the hands come for everyone around him.

She does not know you. But envy is not about knowing.`,

  entrance: [
    'The shadows in the room gather.',
    'Shadows from the walls, the ceiling, the floor: all of them reaching toward a center point.',
    'She forms from them.',
    '"I love you." She says it to the room.',
    '"I love you." She says it again, and the hands begin to reach.',
  ],

  phases: {
    75: [
      '"I love you." She says it and the shadows multiply.',
      'The hands reach further.',
      '"Everything near me belongs to me." She is not threatening. She is explaining.',
    ],
    50: [
      '"You are still here." She sounds surprised.',
      '"I love you." The hands accelerate.',
      '"Why are you still here." She is not asking. She is absorbing.',
    ],
    25: [
      '"I love you." She says it and the room fills with shadow.',
      '"Everything." She reaches.',
      '"Everyone who is near me is mine." The final seal begins to break.',
    ],
  },

  attacks: [
    'Shadow Hands Reach',
    'Envy Crush',
    'Darkness Devour',
    'Love\'s Possession',
    'Witch Factor Release',
  ],

  attackNarratives: {
    'Shadow Hands Reach': [
      'Hands emerge from every shadow.',
      'They do not punch. They grab.',
      'They pull toward her and the grip is the weight of absolute envy.',
      'You tear yourself free and lose HP in the process.',
      '"I love you." She says it as they reach again.',
    ],
    'Envy Crush': [
      'She clenches one hand.',
      'The shadows around you compress inward.',
      'Not hands. The shadow itself. The darkness made density.',
      'The crush hits your entire body from every side simultaneously.',
      '"You should stay." She says it.',
    ],
    'Darkness Devour': [
      'The floor becomes shadow.',
      'You sink.',
      'The shadow consumes the lower half of your position.',
      'Your movement speed halves for one turn as you pull yourself out.',
      '"Stay." She repeats.',
    ],
    'Love\'s Possession': [
      '"I love you." She extends both arms.',
      'The wave of Witch Factor spreads outward.',
      'Contact does not just deal damage.',
      'It applies the Witch\'s Miasma: your scent changes and enemies react differently afterward.',
      'For this fight: it applies a two-turn confusion that randomizes your inputs.',
    ],
    'Witch Factor Release': [
      'The Witch of Envy stops holding the seal.',
      'Envy pours out of her as raw destructive force.',
      'The entire room fills with shadow hands reaching from every surface.',
      'The only safe spot is directly in front of her.',
      'Everything else is hands.',
    ],
  },

  dodgeLines: [
    '"I love you." She reaches again.',
    '"Where are you going." She does not ask it as a question.',
    '"Come back." The hands follow.',
    '"You moved." She sends more hands.',
  ],

  hitLines: [
    '"You are still here." She takes it.',
    '"I love you." She continues.',
    '"You hit me." She does not retreat.',
    '"Stay." She says it and reaches.',
  ],

  tauntLines: [
    '"I love you." She says it to you.',
    '"Everything near me is mine. You are near me."',
    '"I do not want to hurt you. That is not how it works." She reaches anyway.',
    '"Stay." She says it like a demand and a plea simultaneously.',
    '"I love you. I love you. I love you." She says it and the shadows respond.',
  ],

  victoryLines: [
    '"Stay." She reaches for you one more time.',
    '"I love you." The shadow hands settle.',
    '"You should not have left." She watches.',
    '"I will find you again." She says it with absolute certainty.',
  ],

  defeatLines: [
    'The shadows recede.',
    'She is there beneath them. The half-elf beneath the Witch.',
    '"You." She looks at you. Not the room. You.',
    '"You broke through." Her voice is different for one moment.',
    '"You are real." She sounds almost clear. Then the seal closes again.',
  ],

  domainLines: [
    'Every shadow in every direction is a hand.',
    'There is nowhere to stand that is not her reach.',
    '"Everything is mine here." She says it calmly.',
  ],

  domainStrainLines: [
    '"I love you." The hands slow slightly.',
    '"I am here." She is everywhere.',
  ],

  domainBreakoutLine: 'The shadows pull back. She watches you from them.',

  special: {
    name: 'Unseen Hands',
    desc: 'At the start of each of Satella\'s attack turns, she summons one shadow hand. These stack (max 4). Each active hand adds +15% damage to her base attack. Players can destroy a hand by dealing a burst of 10% or more of her max HP in a single hit (the hand is consumed absorbing the hit). Hands reset on a new fight.',
    trigger: [
      { type: 'start_of_enemy_turn', key: 'summonHand' },
      { type: 'on_player_burst', key: 'destroyHand', threshold: 0.10 },
    ],
    engineNote: `Track bossState.shadowHands (default 0, max 4). At start of enemy attack phase: if shadowHands < 4, increment shadowHands, show summon line. Multiply enemy.atk by (1 + shadowHands * 0.15). On player hit where damage >= enemy.maxHp * 0.10: decrement shadowHands by 1, show destroy line, recompute ATK multiplier. Show hand count in combat messages.`,
    narrativeLines: [
      'A shadow hand emerges from the dark.',
      '"Another hand." She watches it reach.',
      'Your burst hit destroys one shadow hand.',
      '"You broke one." She summons another.',
    ],
  },

  playerHitLines: [
    '"You hit me." She continues reaching.',
    '"Real power." She does not stop.',
    '"Strong." She reaches again.',
    '"You are real." She says it quietly.',
  ],

  playerSkillLines: [
    '"A technique." She watches.',
    '"Strong skill." The shadows respond.',
    '"Real power." She notes it.',
    '"You are something real." She sounds clearer for a moment.',
  ],

  drops: [
    'witch_factor_fragment',
    'envy_shadow_crystal',
    'unseen_hand_shard',
    'half_elf_memory_rune',
    'sealed_witch_mark',
  ],
}
