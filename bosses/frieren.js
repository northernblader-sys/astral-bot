/**
 * Frieren - The Elf Mage Who Walks Slowly
 * Grade: SS | Floor: 73
 * Frieren: Beyond Journey's End
 */

export const frieren = {
  id: 'frieren',
  name: 'Frieren',
  floor: 73,
  grade: 'SS',
  emoji: '🧝',
  image: null,
  hp: 25000,
  maxHp: 25000,
  atk: 1550,
  def: 650,
  exp: 17000,
  gold: 11000,
  type: 'magic',
  weakTo: [],
  resistTo: ['physical', 'magic', 'fire', 'ice', 'shadow', 'poison'],

  personality: 'detached-precise-ancient',
  voice: 'Flat and slightly bored, the voice of someone who has been very good at something for longer than most civilizations have existed.',

  lore: `She is over a thousand years old. She attended the defeat of the Demon King. She watched the hero she traveled with grow old and die. Time moves differently when you are an elf, and she has spent most of hers collecting spells.

Zoltraak is her signature attack: a penetrating magic beam that passes through conventional barriers. What makes it frightening is not the power but the insight behind it. Frieren analyzes every spell she encounters. She understands the mechanism. Once she understands, she can replicate it, improve it, or counter it specifically.

The demons fear her not because she is the strongest but because she is the most knowledgeable. A mage who has analyzed every spell for a thousand years does not lose to technique.

She is mildly annoyed to be here. She had flowers to collect.`,

  entrance: [
    'She walks into the room at a pace that suggests she has nowhere urgent to be.',
    'She looks at you. She looks at the ceiling.',
    '"This is a dungeon." She says it as an observation.',
    '"I came through because there was a rumor of a rare magical herb on the lower floors."',
    'She raises one hand. "I will fight you so you move out of the way."',
  ],

  phases: {
    75: [
      '"Your technique is interesting." She squints slightly. "I have analyzed it."',
      '"Uber Zoltraak." The standard beam becomes something else.',
      '"The improved version. I developed it after studying the original for eighty years."',
    ],
    50: [
      '"You are making me use the older spells." She reaches for her grimoire.',
      '"One thousand years of collected magic." She opens a page.',
      '"I will not use all of it. But more than I planned."',
    ],
    25: [
      '"You are genuinely strong." The boredom leaves her voice.',
      '"I am going to be precise now." She focuses.',
      '"No wasted magic. Everything targeted. This ends quickly."',
    ],
  },

  attacks: [
    'Zoltraak',
    'Uber Zoltraak',
    'Soul Magic: Vision',
    'Spell Analysis Counter',
    'Collected Magic Barrage',
  ],

  attackNarratives: {
    'Zoltraak': [
      'She raises one finger.',
      '"Zoltraak." The penetrating beam launches.',
      'It does not bounce. It does not curve.',
      'It passes through conventional barriers as if they have different addresses.',
      'You dodge and it still finds an angle.',
    ],
    'Uber Zoltraak': [
      '"Uber Zoltraak." She says it without inflection.',
      'The beam is the same mechanism, analyzed and optimized over eighty years of refinement.',
      'The penetration is deeper. The damage higher. The angle of approach is mathematically selected.',
      'Your evasion window is smaller.',
      '"The improved version. It took time." She says this as mild explanation.',
    ],
    'Soul Magic: Vision': [
      'She pulls from her grimoire.',
      '"Soul magic. I do not use this often."',
      'The spell does not deal conventional damage.',
      'It deals psychological damage: your perception of your own HP readout drops.',
      'Not real damage. Fear damage. But fear damage is real damage.',
    ],
    'Spell Analysis Counter': [
      'You use a technique.',
      'She analyzes it in real time.',
      'She uses it back at you in the same turn, modified.',
      '"I analyzed that. Here is a more efficient version." She fires it.',
      'The version she sends back is optimized. It hurts more.',
    ],
    'Collected Magic Barrage': [
      'She opens her grimoire to a random page.',
      'She casts whatever is there.',
      'Ice. Fire. Lightning. Binding. Gravity.',
      'She has collected spells for a thousand years and the page is always different.',
      '"I catalogued this one from a demon mage in the 400s." She closes the grimoire.',
    ],
  },

  dodgeLines: [
    '"You moved before the beam arrived." She notes the timing.',
    '"Good evasion." She adjusts the angle.',
    '"Fast." She recalibrates.',
    '"You dodged Zoltraak. That requires real skill." She sounds like she means it.',
  ],

  hitLines: [
    '"Hmm." She takes the hit without much reaction.',
    '"Strong output." She notes it.',
    '"You hit me." She files it away.',
    '"Real power." She adjusts her approach slightly.',
  ],

  tauntLines: [
    '"I have been studying magic for longer than your civilization has had a name."',
    '"I will analyze whatever you do and improve it. That is simply what I do."',
    '"I was at the defeat of the Demon King. Calibrate your expectations."',
    '"If you have a technique I have not seen, I will be briefly interested. Otherwise."',
    '"I was going to collect herbs afterward. Please do not take too long."',
  ],

  victoryLines: [
    '"Well." She turns to go.',
    '"You have strong magic." She does not say more than that.',
    '"The herb patch is probably still there." She leaves.',
    '"Come find me if you get stronger. I would be willing to analyze your technique properly."',
  ],

  defeatLines: [
    '"Oh." She sits.',
    '"I did not analyze that last technique fast enough." She sounds slightly surprised.',
    '"An elf being beaten by a technique she could not analyze in time." She is taking notes.',
    '"Interesting." She pulls out a small journal.',
    '"I will be back when I have studied this." She writes something. "Decades, perhaps."',
  ],

  special: {
    name: 'Spell Analysis',
    desc: 'After the player uses any skill twice (total over the fight), Frieren analyzes it. On her next attack turn (within 2 turns of the analysis), she returns a copied version of that skill at 1.2x effectiveness as her attack (instead of a normal attack). She can only copy the last skill analyzed. A different skill resets her analysis.',
    trigger: [
      { type: 'on_skill_use', key: 'spellAnalysis', threshold: 2 },
    ],
    engineNote: `Track bossState.skillUseCounts = {} (skillId -> count). Each skill use: increment count. When any count >= 2 and !== bossState.analyzedSkillId: set bossState.analyzedSkillId = skillId, bossState.analysisReady = true, show analysis line. Within 2 turns of analysisReady: on enemy attack phase (50% chance per turn): replace normal attack with copied skill at 1.2x the player's skill formula output (using enemy.atk as the base), show copy line. After firing: clear analysisReady. Reset if player uses a new skill (new skillId with count >= 2).`,
    narrativeLines: [
      '"I have analyzed that technique." She takes a note.',
      '"Here is a more efficient version." She casts the copied skill.',
      '"Spell analysis complete. Returning at scale."',
      '"One thousand years of analysis. Your technique is now mine."',
    ],
  },

  playerHitLines: [
    '"Real output." She notes it.',
    '"Strong hit." She adjusts her stance slightly.',
    '"You hit me." She files it.',
    '"Good power." She continues.',
  ],

  playerSkillLines: [
    '"A technique worth analyzing." She starts immediately.',
    '"Good skill. Analysis begins."',
    '"Interesting mechanism." She watches it.',
    '"I will need two uses to fully understand this." She is patient.',
  ],

  drops: [
    'thousand_year_grimoire_shard',
    'zoltraak_crystal',
    'elf_flower_rune',
    'spell_analysis_stone',
    'frieren_herb_vial',
  ],
}
