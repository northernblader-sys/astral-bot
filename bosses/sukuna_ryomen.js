/**
 * Ryomen Sukuna - King of Curses
 * Grade: SSS | Floor: 88
 * Jujutsu Kaisen
 */

export const sukuna_ryomen = {
  id: 'sukuna_ryomen',
  name: 'Ryomen Sukuna',
  floor: 88,
  grade: 'SSS',
  emoji: '👁️',
  image: null,
  hp: 85000,
  maxHp: 85000,
  atk: 4000,
  def: 2000,
  exp: 45000,
  gold: 30000,
  type: 'shadow',
  weakTo: [],
  resistTo: ['physical', 'shadow', 'magic', 'fire', 'ice'],

  personality: 'contemptuous-entertained-sadistic',
  voice: 'Calm, aristocratic cruelty. He narrates your suffering like a critic reviewing a mediocre play.',

  lore: `He was human once. A jujutsu sorcerer so powerful that even the highest-ranked executioners could not kill him. They tried. He killed them all and ate their fingers. He died and came back as twenty separate cursed objects, a split soul distributed across twenty indestructible fingers.

When consumed by a host, he rides in the corner of their consciousness and decides when to take over. He has four arms and four eyes in his true form. His cursed energy output is so vast it poisons the ground where he walks.

Dismantle and Cleave are his signature cuts. Dismantle is indiscriminate slashing. Cleave adapts automatically to its target, calibrating exactly the damage needed to cut through whatever stands in front of him. He consumed Mahoraga and added its wheel to his arsenal.

He is entertained by you. Not impressed. Entertained. The difference matters.`,

  entrance: [
    'His presence arrives before his body does.',
    'The cursed energy in the room spikes and the air thickens.',
    'He steps forward from somewhere dark and surveys you with four eyes.',
    '"Finally." He sounds like you kept him waiting.',
    '"Something worth killing. Show me what you have got, weakling."',
  ],

  phases: {
    75: [
      '"You are not completely boring. Surprising."',
      'He crosses two of his four arms and evaluates.',
      '"Cleave. Let me show you how it adapts to you specifically."',
    ],
    50: [
      '"Malevolent Shrine." He says it and the domain begins to form.',
      'The cursed energy in the room hits a new ceiling.',
      '"Your body is the most interesting thing about you. Dismantle will fix that."',
    ],
    25: [
      '"Now you have my attention." He sounds different. Focused.',
      '"You want to survive against the King of Curses?" He tilts his head.',
      '"Then earn it." He moves.',
    ],
  },

  attacks: [
    'Dismantle',
    'Cleave',
    'Malevolent Shrine',
    'Flame Arrow: Agito',
    'Cursed Regeneration Counter',
  ],

  attackNarratives: {
    'Dismantle': [
      'An invisible blade cuts the space you occupy.',
      'Dismantle does not aim. It does not need to.',
      'The slash is indiscriminate and the room takes the overflow.',
      'Stone walls crack. The floor splits.',
      'You take the edge of it and the edge is considerable.',
    ],
    'Cleave': [
      'He raises two fingers.',
      'Cleave calculates you. Your defense, your HP, your resistance.',
      'It calibrates.',
      'The resulting cut is exactly as powerful as it needs to be to hurt you significantly.',
      '"Cleave knows what you are made of. That is why it is so efficient."',
    ],
    'Malevolent Shrine': [
      '"Malevolent Shrine."',
      'The domain does not trap you. It expands outward.',
      'Inside its radius, Dismantle and Cleave fire automatically.',
      'The air inside the shrine is made of cursed energy and every inch of it is hostile.',
      'You run through it and take damage on every step.',
    ],
    'Flame Arrow: Agito': [
      'He opens his palm.',
      'A bolt of condensed fire and cursed energy launches from it.',
      'Agito tracks. It adjusts mid-flight.',
      'You dodge left and it turns left.',
      'Contact detonates it across your guard.',
    ],
    'Cursed Regeneration Counter': [
      'You land a solid hit.',
      'He watches the wound close in three seconds.',
      '"That was good." He regenerates completely. "Again."',
      'The counter he throws in return carries the frustration you just caused.',
      'The King of Curses does not stay hurt.',
    ],
  },

  dodgeLines: [
    '"Lucky." He says it and means it as an insult.',
    '"You moved. Do it again. I am curious how long."',
    '"Evasion. Boring." He says it flatly.',
    '"Move again. I am recalibrating Cleave for your movement pattern."',
  ],

  hitLines: [
    '"Hm." He looks at the damage.',
    '"You hit the King of Curses. Note how little that changes."',
    '"Good output." He starts to regenerate. "Do it again before I finish healing."',
    '"Decent. Not enough. Try to mean it more."',
  ],

  tauntLines: [
    '"Is this the best this floor produces? Disappointing."',
    '"You fight like you think surviving is the goal. It is not. Impressing me is the goal."',
    '"Hurt me. I want to know if you can." He sounds bored.',
    '"You are not completely worthless. That is a compliment from me. Take it."',
    '"Weaker than Gojo. Better than the last one. That is where you rank."',
  ],

  victoryLines: [
    '"Adequate." He is already leaving.',
    '"You gave me something to think about. That is enough."',
    '"Better than average. Still not interesting enough to spare." He walks out.',
    '"Come back when you are stronger. I want to see if you grow into something worth killing properly."',
  ],

  defeatLines: [
    'He goes quiet.',
    'The King of Curses does not acknowledge defeat gracefully.',
    '"The body... cannot keep up." He says it like an engineering problem.',
    '"A genuine surprise." He sits. "I have not been surprised in a very long time."',
    '"Well." He looks at you. "You earned this." He means it as high praise.',
  ],

  domainLines: [
    '"Malevolent Shrine." The domain opens without theater.',
    'The shrine expands and fills the room with automatic slashing cursed energy.',
    'Every step costs you HP. Every second inside costs you something.',
  ],

  domainStrainLines: [
    '"Still standing. Good." He sounds like he means it.',
    '"The shrine is expensive. But so are you." He eyes you.',
  ],

  domainBreakoutLine: '"You broke out of the Shrine." A pause. "You are real." He says it like a verdict.',

  special: {
    name: 'Cursed Regeneration',
    desc: 'Sukuna regenerates 3% of his max HP at the end of every turn. This cannot be fully countered but can be suppressed for 1 turn if the player deals damage exceeding 8% of his max HP in a single turn (the regeneration is overwhelmed by wound scale). Players must pace their burst damage strategically.',
    trigger: [
      { type: 'end_of_turn', key: 'cursedRegen' },
      { type: 'on_player_hit', key: 'regenSuppression', threshold: 0.08 },
    ],
    engineNote: `At end of each turn: if not bossState.regenSuppressed, heal enemy.hp by Math.floor(enemy.maxHp * 0.03), capped at maxHp. Track bossState.regenSuppressed (boolean). If player deals damage >= Math.floor(enemy.maxHp * 0.08) in a single hit: set bossState.regenSuppressed = true for 1 turn, show suppression line. Reset to false at next regen check. Show regen line each time it fires.`,
    narrativeLines: [
      'The cursed energy seals his wounds.',
      'His body repairs itself without his input.',
      '"You hit hard enough to slow the regeneration." A beat. "Do it again."',
      'The wound fades. He is whole again.',
    ],
  },

  playerHitLines: [
    '"Good hit. Regeneration clock starts now."',
    '"You actually meant that one."',
    '"Strong. Hit harder."',
    '"That one counts." He waits for the next.',
  ],

  playerSkillLines: [
    '"A real technique. Interesting."',
    '"Decent output. Where did you learn that?"',
    '"That skill has weight. You trained well."',
    '"Strong. Now use it at the right moment."',
  ],

  drops: [
    'sukuna_finger_shard',
    'cleave_residue',
    'malevolent_shrine_dust',
    'four_eyes_sigil',
    'king_of_curses_mark',
  ],
}
