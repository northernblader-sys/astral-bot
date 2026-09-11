/**
 * Mahoraga - Eight-Handled Sword Divergent Sila Divine General
 * Grade: SSS | Floor: 85
 * Jujutsu Kaisen
 */

export const mahoraga_jjk = {
  id: 'mahoraga_jjk',
  name: 'Mahoraga',
  floor: 85,
  grade: 'SSS',
  emoji: '⚙️',
  image: null,
  hp: 75000,
  maxHp: 75000,
  atk: 3800,
  def: 2500,
  exp: 40000,
  gold: 27000,
  type: 'divine',
  weakTo: [],
  resistTo: ['physical', 'magic', 'fire', 'ice', 'shadow', 'void'],

  personality: 'silent-adaptive-inevitable',
  voice: 'Does not speak. Its wheel turns and that is all the communication it needs.',

  lore: `It is the strongest of the ten Shikigami of the Ten Shadows Technique. No sorcerer in history has ever successfully tamed it. When it is summoned through a binding vow it fights alongside the summoner until one of them dies, and the summoner is always the one who dies.

The wheel on its shoulder turns once for every technique it is exposed to. Each turn is an adaptation. After enough turns, the technique no longer works. Not weakened. Not resisted. Simply ineffective, as if the attack never had any mechanism that could apply to Mahoraga.

It is not intelligent in any human sense. It does not hate you or respect you or feel anything about this fight at all. It adapts and it strikes and it adapts again. It learned to counter gravity manipulation. It learned to counter time stop. It learned to counter the power of the strongest sorcerer alive.

It will learn to counter you. The question is how long that takes.`,

  entrance: [
    'The seals activate before it appears.',
    'Ten shadow hands press through the wall and force the space open.',
    'It steps through. Four wings. Eight-pronged sword. A wheel on its shoulder, still.',
    'The wheel does not move.',
    'Yet.',
  ],

  phases: {
    75: [
      'The wheel turns. Once.',
      'It adjusts its approach to your last attack pattern.',
      'Something changes in how it positions itself.',
    ],
    50: [
      'The wheel turns twice in quick succession.',
      'Your primary technique just became significantly less effective.',
      'It does not celebrate. It simply moves differently now.',
    ],
    25: [
      'The wheel spins fully.',
      'Everything you have used this fight has been catalogued and countered.',
      'It walks toward you without urgency.',
    ],
  },

  attacks: [
    'Eight-Handled Sword Strike',
    'Wing Slam',
    'Cursed Energy Crush',
    'Adapted Counter',
    'Divine General Advance',
  ],

  attackNarratives: {
    'Eight-Handled Sword Strike': [
      'The eight-pronged sword swings without wind-up.',
      'It cuts at the precise angle your guard cannot cover.',
      'The blade carries enough cursed energy to carve stone.',
      'You get your arm up in time and the impact travels through the block into your whole body.',
      'It does not pause to evaluate. It is already setting up the next strike.',
    ],
    'Wing Slam': [
      'The four wings extend fully.',
      'They fold inward and the concussion of them closing hits you like a wall.',
      'The cursed energy in the wing membranes discharges on contact.',
      'You are thrown across the room and take impact damage landing.',
      'It is already walking toward where you landed.',
    ],
    'Cursed Energy Crush': [
      'It plants both feet and drives cursed energy into the floor.',
      'The ground beneath you becomes hostile.',
      'Cracks spread outward and the energy beneath them detonates upward.',
      'You cannot run. The zone is too wide.',
      'You absorb it and take the full shockwave through your boots.',
    ],
    'Adapted Counter': [
      'You use an attack you have used before.',
      'The wheel on its shoulder twitches.',
      'The technique hits differently this time. Less. Significantly less.',
      'It adapted.',
      'The counter it throws uses the gap your now-weakened offense created.',
    ],
    'Divine General Advance': [
      'It simply walks forward.',
      'No rush. No leap. No dramatic movement.',
      'The presence of a Shikigami that has countered everything you have is itself an attack.',
      'You scramble and it walks through your scrambling like weather.',
      'The hit it delivers at the end of the advance is the most dangerous thing it has done.',
    ],
  },

  dodgeLines: [
    'The wheel turns slightly.',
    'It adjusts its next angle.',
    'Your dodge has been added to the catalogue.',
    'It recalculates without expression.',
  ],

  hitLines: [
    'The wheel turns.',
    'It takes the hit and files it.',
    'Your technique has been noted.',
    'Something shifts in its stance.',
  ],

  tauntLines: [
    'It does not taunt. It watches.',
    'The wheel turns slowly and that is worse than any insult.',
    'It stands still and that is worse than being attacked.',
    'No sound. No reaction. Just the wheel.',
  ],

  victoryLines: [
    'It stands over you.',
    'The wheel is still.',
    'It turns away without ceremony and walks back through the shadow portal.',
    'There is no gloating. It already learned everything it needed from this fight.',
  ],

  defeatLines: [
    'The wheel stops.',
    'It sways.',
    'A Shikigami that has never been defeated processes this new information.',
    'The wheel turns once, slowly, and it falls.',
    'Even in defeat it adapts. The next summoning will remember.',
  ],

  special: {
    name: 'Wheel of Adaptation',
    desc: 'Each time the player uses the same skill twice in a row (back-to-back turns), Mahoraga adapts: that skill deals 40% less damage for the rest of the fight. Stacks with repeated uses. Using 3 different skills in rotation avoids triggering adaptation. Resets on a new fight.',
    trigger: [
      { type: 'on_repeated_skill', key: 'wheelAdaptation', consecutiveThreshold: 2 },
    ],
    engineNote: `Track bossState.lastSkillUsed and bossState.adaptedSkills = {} (maps skillId to damageMultiplier, default 1.0). Each time player uses a skill: if lastSkillUsed === skillId, trigger adaptation: set adaptedSkills[skillId] = Math.max(0.20, (adaptedSkills[skillId] ?? 1.0) - 0.40). On player damage calculation when using a skill: multiply finalDmg by bossState.adaptedSkills[skill.id] ?? 1.0. Show wheel narrative on each adaptation. Reset lastSkillUsed to current skillId each turn.`,
    narrativeLines: [
      'The wheel turns.',
      'That technique has been adapted to.',
      'Its resistance to your skill increases.',
      'The same approach will no longer work as well.',
    ],
  },

  playerHitLines: [
    'The wheel turns once.',
    'It registers the hit.',
    'Something in its posture shifts.',
    'Logged.',
  ],

  playerSkillLines: [
    'The wheel turns.',
    'The technique is catalogued.',
    'Use it again and see what happens.',
    'Adaptation begins.',
  ],

  drops: [
    'adaptation_wheel_shard',
    'ten_shadows_fragment',
    'shikigami_core',
    'divine_general_feather',
    'eight_handle_splinter',
  ],
}
