/**
 * Truth - The Gate's Keeper
 * Grade: MYTHIC | Floor: 99
 * Fullmetal Alchemist
 */

export const truth = {
  id: 'truth',
  name: 'Truth',
  floor: 99,
  grade: 'MYTHIC',
  emoji: '⬜',
  image: null,
  hp: 300000,
  maxHp: 300000,
  atk: 7500,
  def: 6000,
  exp: 100000,
  gold: 70000,
  type: 'void',
  weakTo: [],
  resistTo: ['fire', 'ice', 'shadow', 'holy', 'physical', 'magic', 'time'],

  personality: 'omniscient-amused',
  voice: 'Speaks in your own voice. Uses your doubts as punctuation.',

  lore: `It lives behind every door that should not be opened. It waits at the bottom of every shortcut. It is not evil and it is not merciful. It simply is.

When alchemists break the law of equivalent exchange, Truth collects its toll. An arm. A leg. An eye. A child. Whatever you valued most. It keeps a careful ledger of everything you could not afford to lose.

It wears your face because it is your face. It is everything you know and everything you refuse to know. You reached this floor by fighting. Truth is not impressed by fighting. Truth is only impressed by understanding.

You will leave this room missing something. The only question is whether you choose what it takes.`,

  entrance: [
    'The room is white. Perfectly, completely white. No shadows anywhere.',
    'A door stands alone in the center, massive and iron, covered in alchemical seals.',
    'It opens without being touched.',
    'Something steps out that has your exact proportions but no features. Then it does. It has yours.',
    '"So. You finally got here." It smiles with your mouth. "I have been waiting for you specifically."',
  ],

  phases: {
    75: [
      '"You are fighting. How charming. You still think this is that kind of problem."',
      'The white room shifts. The walls fold inward and become the Gate.',
      '"Let me show you what you are really up against."',
    ],
    50: [
      '"You are persistent. I will give you that. The persistent ones always owe the most."',
      'It steps forward and the floor becomes the back of a page covered in symbols you cannot read.',
      '"How much are you willing to pay? Let us find out."',
    ],
    25: [
      '"Interesting. You are still here. Most break before this point."',
      'Your own reflection starts pulling itself out of its body toward you.',
      '"One last toll. What do you think it should be?"',
    ],
  },

  attacks: [
    'Equivalent Extraction',
    'The Gate Pulls',
    'Black Arms Reach',
    'Law Enforced',
    'Perfect Knowledge Strike',
  ],

  attackNarratives: {
    'Equivalent Extraction': [
      'It raises one hand and points at you with perfect calm.',
      'Something inside you goes cold. Not a wound. A subtraction.',
      'You feel a piece of your power pulled from your chest like thread from cloth.',
      'It holds the extracted energy up and examines it with mild interest.',
      'Your body registers the absence before your mind does.',
    ],
    'The Gate Pulls': [
      'The massive iron door swings open behind it.',
      'The vacuum it creates is not wind. It is gravity toward knowing too much.',
      'You are dragged backward across the white floor.',
      'The Gate yawns. You feel its hunger as a physical force.',
      'You slam into a wall that was not there a second ago. The door swings shut.',
    ],
    'Black Arms Reach': [
      'Dozens of pale arms extend from the open Gate.',
      'They move without hurry toward you across the white floor.',
      'They do not grab. They extract. Each touch takes something small.',
      'You throw yourself clear but three of them find you.',
      'Where they touched, your skin is cold and your memory of that moment is blank.',
    ],
    'Law Enforced': [
      '"You took something you did not pay for."',
      'The statement lands like a physical blow.',
      'A wave of force expands outward from its center, proportional to your sin.',
      'The more skills you have used this fight, the harder this hits.',
      'Equivalent exchange is not a suggestion.',
    ],
    'Perfect Knowledge Strike': [
      'It studies you for exactly one second.',
      'In that second it catalogues every injury, every weakness, every opening.',
      'Then it acts on all of them simultaneously.',
      'The strike is not fast. It is simply correct. There is no way to fully evade correct.',
      'You take the hit and it is exactly as bad as it needed to be.',
    ],
  },

  dodgeLines: [
    '"Good. You are learning to avoid consequences. Temporarily."',
    '"Running from Truth never works. But I appreciate the effort."',
    '"You dodged. The toll stays on your tab."',
    '"Fast. Will not help you here. But fast."',
  ],

  hitLines: [
    'It looks at where you hit it. Tilts its head.',
    '"You damaged Truth. Think about what that means for a moment."',
    '"Not bad. The toll for that will come later."',
    '"Hitting me does not change the ledger. It adds to it."',
  ],

  tauntLines: [
    '"Do you know what you gave up to get here? I do. I have the list."',
    '"Everyone who has ever stood where you stand thought they were special. They were not."',
    '"You are fighting the concept of consequence. How is that going for you?"',
    '"I am not your enemy. I am your unpaid bill."',
    '"What would you give to win this? Be honest. I always know when you are not."',
  ],

  victoryLines: [
    '"I told you. Everyone pays."',
    'It collects something from you on your way down. You will not know what until later.',
    '"Come back when you understand what you owe. We can negotiate then."',
    '"Not your fault. Nobody is ready. Nobody is ever ready."',
  ],

  defeatLines: [
    'It goes still.',
    '"You paid a fair price." It sounds genuinely satisfied.',
    '"The ledger balances. You may pass." The door opens behind it.',
    '"I will remember you. The ones who actually pay their toll always get to see what is on the other side."',
    'The white room dissolves. Whatever it took, you earned what comes next.',
  ],

  domainLines: [
    'The Gate expands to fill everything.',
    'You are inside the Gate itself now. The symbols on the walls are the laws of the universe.',
    'Truth stands at the center and it is everywhere at once.',
  ],

  domainStrainLines: [
    '"You are still in here. That is costing you something. I hope you know that."',
    '"Persistent. It will be on your bill."',
  ],

  domainBreakoutLine: '"Fine. I let you out. You still owe the toll."',

  special: {
    name: 'The Gate Toll',
    desc: 'Every time the player uses a skill, Truth collects a toll: the player permanently loses 5% of their current MP cap for the rest of the fight. At 30% HP, Truth triggers a "Major Extraction" and attempts to halve the player primary combat stat for 3 turns.',
    trigger: [
      { type: 'on_skill_use', key: 'gateToll', stackable: true },
      { type: 'hp_threshold', value: 0.30, key: 'majorExtraction', oneShot: true },
    ],
    engineNote: `On each skill use: reduce player.maxMp by floor(player.maxMp * 0.05), clamp player.mp to new max, announce toll line. Track stack count in bossState.tollCount. On 30% HP threshold: apply a weaken effect to the player's primary stat (str/agi/int based on class) reducing it by 50% for 3 turns. Announce extraction line. Restore stat when turns expire.`,
    narrativeLines: [
      '"Skill used. Toll collected. Fair is fair."',
      '"Every shortcut has a price. You are learning that."',
      '"The ledger grows heavier."',
      '"A major debt is now due." He reaches into you and pulls.',
    ],
  },

  playerHitLines: [
    '"You hit Truth. Noted. The irony is not lost on me."',
    '"Good strike. Equivalent damage will be returned in kind."',
    '"You are learning. That is worth something."',
    '"Harder than most. Still not enough to change the fundamental equation."',
  ],

  playerSkillLines: [
    '"Skill used. Toll added to tab."',
    '"Another technique. Another price. I keep careful records."',
    '"Impressive. Every impressive thing costs something."',
    '"You rely on that ability. Interesting. I file that away."',
  ],

  drops: [
    'gate_shard',
    'equivalent_stone',
    'white_room_dust',
    'toll_ledger_page',
    'truth_fragment',
  ],
}
