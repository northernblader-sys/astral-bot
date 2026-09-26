/**
 * Giorno Giovanna - Gold Experience Requiem
 * Grade: SSS+ | Floor: 97
 * JoJo's Bizarre Adventure
 */

export const giorno_ger = {
  id: 'giorno_ger',
  name: 'Giorno Giovanna (Gold Experience Requiem)',
  floor: 97,
  grade: 'SSS+',
  emoji: '🌿',
  image: null,
  hp: 160000,
  maxHp: 160000,
  atk: 5000,
  def: 5000,
  exp: 72000,
  gold: 48000,
  type: 'void',
  weakTo: [],
  resistTo: ['fire', 'ice', 'shadow', 'holy', 'physical', 'magic', 'time', 'void'],

  personality: 'cold-absolute-polite',
  voice: 'Measured and final. He does not threaten. He informs.',

  lore: `He was the illegitimate son of the most dangerous man in the world and he turned that inheritance into something else entirely. His dream was to become a Gang Star and reform the criminal underworld. He achieved it at seventeen.

Gold Experience Requiem is what happens when a Stand born of life itself evolves to its peak. It does not simply power up. It changes the rules. Any attack, any action, any will directed at Giorno is reset to zero before it reaches completion. You cannot kill him. The killing never happens. Your intention to harm him reverts to nothing before it manifests.

He is quiet about it. He does not gloat. He simply observes that your attack did not work and offers you the chance to understand why before he ends things.

This is not a fight you can win by conventional means. Understand that first and you will last longer.`,

  entrance: [
    'He stands in the center of the room with his hands folded in front of him.',
    'Gold experience shimmers around him, turning the dungeon floor to grass for one brief moment.',
    '"I know why you are here." His voice is calm. Not unkind.',
    '"I will not stop you from trying. That would be disrespectful."',
    '"But I should tell you what Gold Experience Requiem does before we begin."',
  ],

  phases: {
    75: [
      '"You are more persistent than most. I respect that."',
      'The golden aura tightens around him.',
      '"Gold Experience Requiem is now fully active. What happens next is inevitable."',
    ],
    50: [
      '"Your attacks are real. They are simply never completed."',
      'He tilts his head slightly, as if calculating something.',
      '"Any will to harm me returns to zero. That is not a boast. That is a description."',
    ],
    25: [
      '"I see. You intend to win." He is not mocking this.',
      '"That intention... also returns to zero." He raises one hand.',
      '"Gold Experience Requiem."',
    ],
  },

  attacks: [
    'Requiem Reset',
    'Life Proliferation',
    'Golden Barrage',
    'Return to Zero',
    'Infinite Death Loop',
  ],

  attackNarratives: {
    'Requiem Reset': [
      'Your last action un-happens.',
      'Not reversed. Not undone. Simply never having occurred.',
      'The energy you spent on it returns to you but the result does not.',
      'Giorno watches this without satisfaction.',
      '"That attack was reset. Try something else."',
    ],
    'Life Proliferation': [
      'He touches the floor.',
      'Life erupts from the contact point: vines, roots, sharp flowering growth.',
      'The dungeon itself becomes hostile.',
      'Thorns from nowhere find you and the biological damage is exact and merciless.',
      '"Life can be a weapon. It did not choose to be. Neither did I."',
    ],
    'Golden Barrage': [
      'Gold Experience moves in a flash.',
      'The barrage is not fast. It is continuous. There is no gap between strikes.',
      'Each punch lands at the precise location your body tried to move to.',
      'The Stand knows where you are going before your muscles decide.',
      'You take every hit. There is no not taking every hit.',
    ],
    'Return to Zero': [
      '"Return to zero."',
      'Your current buff, your current momentum, your current advantage.',
      'All of it hits a wall that is not a wall.',
      'It is a null point. A reset state. Beginning.',
      'Whatever edge you had is gone. You are at zero.',
    ],
    'Infinite Death Loop': [
      'He touches you once.',
      'You die.',
      'You experience death completely.',
      'Then you return to the moment before you died, intact.',
      'You will keep dying and returning until Gold Experience Requiem decides otherwise. This is not metaphor.',
    ],
  },

  dodgeLines: [
    '"The dodge was reset before it completed." He explains this factually.',
    '"You moved. Gold Experience Requiem moved with you."',
    '"Evasion is valid in theory."',
    'He watches you dodge something that already did not matter.',
  ],

  hitLines: [
    '"Your attack landed." He acknowledges it.',
    '"It did damage. That is real." He sounds like he is confirming data.',
    '"Good power. It will not be enough but it is real power."',
    '"You hit me. That requires an honest response." He attacks.',
  ],

  tauntLines: [
    '"I am not insulting you by telling you this is futile. I am informing you."',
    '"You cannot win this fight. I say that without pleasure."',
    '"Your will to defeat me will return to zero. That is not a judgment. It is the truth."',
    '"Keep fighting. I will not stop you. But understand what you are fighting against."',
    '"Gold Experience Requiem has one purpose. You are currently experiencing it."',
  ],

  victoryLines: [
    '"It is over." He exhales once.',
    '"You fought with everything. I acknowledge that."',
    '"There was no path to victory against Requiem. There never is."',
    '"Rest." He turns away.',
  ],

  defeatLines: [
    'He looks at his own hands.',
    '"Gold Experience Requiem was surpassed." He says it slowly.',
    '"That should not be possible." He pauses. "And yet."',
    '"My dream was to change the criminal underworld. Perhaps this is what change feels like."',
    '"I have no objection to this result." He sits down where he stands.',
  ],

  domainLines: [
    'Gold Experience Requiem expands to fill every dimension of the room.',
    'Everything here exists at his sufferance.',
    'Your actions reach completion only because he permits them to.',
  ],

  domainStrainLines: [
    '"Requiem maintained." He breathes once, carefully.',
    '"The domain is stable. Your situation is not."',
  ],

  domainBreakoutLine: '"You broke through. That was real." He sounds like he means it.',

  special: {
    name: 'Return to Zero',
    desc: 'Once every 5 turns, Giorno resets one of the following (randomly): player current HP is set back to what it was at the start of that turn (heal undone), player MP returns to start-of-turn value (MP gains undone), or one active buff on the player is nullified for 2 turns. Cannot be blocked or avoided.',
    trigger: [
      { type: 'turn_interval', value: 5, key: 'returnToZero' },
    ],
    engineNote: `Track bossState.rtzCooldown (decrement each turn, trigger at 0, reset to 5). On trigger: randomly pick one of three options. 1) Store player.hp at start of turn in bossState.hpSnapshot; on trigger restore it (preventing any healing that turn). 2) Restore player.mp to start-of-turn snapshot. 3) Find a random active buff in player.activeEffects of type 'strengthen' or 'regen' and remove it. Show narrative line. This fires even if player defended.`,
    narrativeLines: [
      '"Return to zero." Simple as breathing.',
      '"That progress did not complete." He watches it unwind.',
      '"Whatever you gained that turn no longer occurred."',
      '"Gold Experience Requiem has spoken."',
    ],
  },

  playerHitLines: [
    '"Your attack landed. That is real."',
    '"Good power. Acknowledged."',
    '"That one completed. Noted."',
    '"You hit me." A pause. "That is significant."',
  ],

  playerSkillLines: [
    '"A technique that completed. I acknowledge it."',
    '"That skill worked. Gold Experience Requiem permitted it."',
    '"Effective. Real output."',
    '"Your technique is genuine. So is my response."',
  ],

  drops: [
    'requiem_arrow_shard',
    'gold_experience_petal',
    'zero_point_crystal',
    'ger_stand_dust',
    'giorno_brooch',
  ],
}
