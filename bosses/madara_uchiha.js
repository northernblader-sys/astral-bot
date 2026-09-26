/**
 * Madara Uchiha - The Ghost of the Uchiha
 * Grade: SS+ | Floor: 80
 * Naruto
 */

export const madara_uchiha = {
  id: 'madara_uchiha',
  name: 'Madara Uchiha',
  floor: 80,
  grade: 'SS+',
  emoji: '👁️',
  image: null,
  hp: 55000,
  maxHp: 55000,
  atk: 2800,
  def: 1500,
  exp: 28000,
  gold: 19000,
  type: 'shadow',
  weakTo: [],
  resistTo: ['physical', 'shadow', 'fire', 'magic'],

  personality: 'proud-dominating-theatrical',
  voice: 'Measured gravitas. Every line delivered as if it were a historical record being dictated.',

  lore: `He was the strongest Uchiha who ever lived before he died and came back and became the first Uchiha to master the Rinnegan. He did all of this while being dead for decades. His plan was a century in the making.

The Eternal Mangekyo Sharingan in both eyes gives him perfect vision of the battlefield, complete genjutsu mastery, and the Susanoo that covers his entire body in armored spiritual energy. The Rinnegan adds six paths of power: control over gravity, summoning through dimensions, absorption of chakra, resurrection.

He fought an army and barely felt it. The army lost. He is not fighting armies anymore. He is fighting you. One person. That makes him more dangerous, not less, because you now have his full attention.

He has waited his entire life for someone worth facing. That is both the greatest compliment he can offer and a threat.`,

  entrance: [
    'He drops from nowhere into the center of the room.',
    'The landing does not shake the floor. His presence does.',
    '"So." He opens his eyes. Three tomoe in both irises.',
    '"You have actually made it this far." He says it without inflection.',
    '"Show me whether that was earned or luck." He raises his hand and Susanoo begins to form.',
  ],

  phases: {
    75: [
      '"Sharingan." Both eyes shift. The tomoe multiply.',
      '"I see every movement before you make it." He becomes very still.',
      '"Show me something I have not seen before."',
    ],
    50: [
      '"Rinnegan." The eyes shift again. Six paths awaken.',
      '"Now you face the Ghost of the Uchiha at full power."',
      '"Perfect Susanoo activates."',
    ],
    25: [
      '"Infinite Tsukuyomi would end this." He considers.',
      '"But I will not use that here. You have earned a real death."',
      '"Come. I will end this properly."',
    ],
  },

  attacks: [
    'Susanoo Blade Strike',
    'Planetary Devastation',
    'Tengai Shinsei',
    'Limbo Shadow Clone',
    'Uchiha Flame Control',
  ],

  attackNarratives: {
    'Susanoo Blade Strike': [
      'The purple skeleton of Susanoo extends one massive arm.',
      'The blade it holds is made of chakra condensed to the edge of a single atom.',
      'It comes down and the entire floor splits.',
      'You are in the crater it makes and the edges are on fire.',
      '"The Totsuka blade does not miss twice."',
    ],
    'Planetary Devastation': [
      'He raises one hand to the ceiling.',
      'Gravitational pull reverses beneath you.',
      'Debris, stone, and your own footing lift off the ground.',
      'He compresses it all into a sphere and the sphere wants to include you.',
      'You fight the gravity while everything else already gave in.',
    ],
    'Tengai Shinsei': [
      'He looks up.',
      'Meteors. From somewhere above the dungeon. Somehow.',
      'Two of them. Each the size of a building.',
      'The first impact is the warning. The second is the point.',
      'The shockwave from both fills every corner of the room.',
    ],
    'Limbo Shadow Clone': [
      'He plants clones in a dimension you cannot see.',
      'The Limbo clones are invisible. They are also real.',
      'Your attacks pass through where you think he is.',
      'The hits you receive come from a source you cannot locate.',
      '"Limbo. You cannot perceive it. You cannot stop it."',
    ],
    'Uchiha Flame Control': [
      'He breathes fire chakra through his hands in controlled streams.',
      'Not wild. Not random. Shaped.',
      'The fire forms into cutting arcs that carve through the room.',
      'Each arc seeks the body heat signature of the target.',
      'You dodge one and two more were waiting for that specific dodge.',
    ],
  },

  dodgeLines: [
    '"The Sharingan sees through that."',
    '"Evasion noted. Next time I account for it."',
    '"You moved faster than expected. Good."',
    '"The Rinnegan tracks. You cannot outrun tracking."',
  ],

  hitLines: [
    '"Hmm." A single sound.',
    '"You broke through Susanoo\'s outer layer. That has not happened often."',
    '"Good strike. Worthy of an Uchiha enemy."',
    '"That one reached me." He straightens. "Do not expect it to happen again."',
  ],

  tauntLines: [
    '"I fought the nine-tailed fox at ten years old. Put your power in context."',
    '"The Sharingan has memorized your entire fighting style. You have no surprises left."',
    '"I did not come back from the dead to lose to someone like you." He means it.',
    '"You fight well for someone who is not an Uchiha."',
    '"Susanoo will not fall. I built it from willpower alone."',
  ],

  victoryLines: [
    '"A worthy opponent." He deactivates Susanoo.',
    '"You have earned acknowledgment. That is rare from me."',
    '"Come back stronger. The Ghost of the Uchiha remembers every fight."',
    '"You are strong. Simply not strong enough. Yet."',
  ],

  defeatLines: [
    '"Impossible." He says it without theater.',
    '"The Rinnegan should have..." He stops.',
    '"You broke through everything." He sits down slowly.',
    '"This world is more interesting than I planned for." He closes his eyes.',
    '"The Ghost of the Uchiha is impressed." He says it like he is surprised.',
  ],

  special: {
    name: 'Sharingan Analysis',
    desc: 'After the player uses any attack or skill 3 times in the fight (not 3 in a row, just 3 total uses of the same action), Madara\'s Sharingan fully analyzes it. From that point, that specific attack or skill deals 30% less damage. Regular attacks can also be analyzed (after 3 basic attacks in total, basic attack damage is reduced by 20%).',
    trigger: [
      { type: 'on_action_count', key: 'sharinganAnalysis', threshold: 3 },
    ],
    engineNote: `Track bossState.actionCounts = { attack: 0, [skillId]: 0 }. Each time player attacks: increment actionCounts.attack. Each skill use: increment actionCounts[skillId]. When any count reaches 3: mark bossState.analyzed[key] = true, apply multiplier (0.70 for skills, 0.80 for basic attacks) in damage calculation, show analysis line. Multipliers stack with other reductions (like Infinity or defense). Show one-time announcement per analyzed action.`,
    narrativeLines: [
      '"Sharingan analysis complete. That technique is now open to me."',
      '"I see through your attack pattern." He adjusts his stance.',
      '"Your basic attack timing is memorized."',
      '"The Sharingan sees everything. Eventually."',
    ],
  },

  playerHitLines: [
    '"You broke through Susanoo." He sounds like he is taking notes.',
    '"Strong output. Good."',
    '"A real hit. The Sharingan files it."',
    '"You have real power. I acknowledge that."',
  ],

  playerSkillLines: [
    '"A technique. Sharingan begins analysis."',
    '"Use it again. I want to see the full pattern."',
    '"Good technique. Give me one more use and it is mine."',
    '"Strong skill. It is being catalogued."',
  ],

  drops: [
    'eternal_mangekyo_shard',
    'rinnegan_splinter',
    'susanoo_crystal',
    'uchiha_crest_fragment',
    'limbo_echo',
  ],
}
