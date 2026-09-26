/**
 * Meliodas - The Dragon's Sin of Wrath
 * Grade: SS+ | Floor: 79
 * The Seven Deadly Sins
 */

export const meliodas = {
  id: 'meliodas',
  name: 'Meliodas',
  floor: 79,
  grade: 'SS+',
  emoji: '🐉',
  image: null,
  hp: 52000,
  maxHp: 52000,
  atk: 2700,
  def: 1400,
  exp: 26000,
  gold: 18000,
  type: 'shadow',
  weakTo: ['holy'],
  resistTo: ['physical', 'magic', 'fire', 'shadow'],

  personality: 'cheerful-savage-ancient',
  voice: 'Casual to the point of offense, like someone who has been the most dangerous thing in every room for ten thousand years and given up pretending otherwise.',

  lore: `He is the eldest son of the Demon King. He abandoned that inheritance ten thousand years ago for a goddess, died for it repeatedly, and came back each time. The curse that binds him prevents his permanent death: every time he dies, he loses more of his emotions to the Demon King's realm.

Full Counter is his signature ability: he reflects any magic attack back at its source at twice the power. He cannot initiate attacks with Full Counter. He can only wait and return. This requires patience he has in abundance.

Assault Mode is what he looks like without his limiter. He is not a nice person in Assault Mode. He is a Demon King's son running on ten thousand years of bottled wrath.

He is one of the most ancient beings alive. He looks like a teenager. The contrast is intentional and it stopped being funny to him several centuries ago.`,

  entrance: [
    '"Oh. A real one." He grins.',
    '"Been a while since I had to actually think during a fight."',
    'He vaults a piece of rubble and lands directly in front of you.',
    '"I am going to warn you: I have Full Counter active at all times. So." He shrugs.',
    '"Hit me with something if you want to lose your own technique. Otherwise we do this the physical way."',
  ],

  phases: {
    75: [
      '"Okay. Limiter off. Just a little." His power output changes.',
      '"I am going to stop holding back on the physical side."',
      '"Full Counter stays active. Just more of everything else."',
    ],
    50: [
      '"Assault Mode." The casual demeanor drops away.',
      'What replaces it is ten thousand years of accumulated fury with no outlet.',
      '"This is what I actually am." He means it.',
    ],
    25: [
      '"Trillion Dark." He begins charging.',
      '"I am going to end this. I have things to get back to." He looks sad for one second.',
      '"Rhitta is waiting. So this is the last exchange."',
    ],
  },

  attacks: [
    'Full Counter',
    'Lostvayne Duplicate',
    'Hellblaze',
    'Assault Strike',
    'Trillion Dark',
  ],

  attackNarratives: {
    'Full Counter': [
      'You launch your attack.',
      'It returns at twice the velocity and twice the force.',
      '"Full Counter. I reflect magic. Good try though."',
      'The damage you dealt becomes the damage you received, doubled.',
      '"That one never gets old." He sounds like he has been saying this for centuries. He has.',
    ],
    'Lostvayne Duplicate': [
      'He draws the broken sword Lostvayne.',
      'Copies of himself appear around the room.',
      'The copies fight independently at partial power.',
      'You cannot tell which one is real until you commit to an attack.',
      '"Lostvayne creates copies of me. The real me is the one Full Counter fires from."',
    ],
    'Hellblaze': [
      'Black flames erupt from his hands.',
      'Hellblaze is not normal fire: it nullifies regeneration on contact.',
      'The fire finds you and the burns do not heal during the fight.',
      '"Hellblaze. Demon flame. Regeneration inhibitor." He says it like a menu item.',
      '"They hurt worse later when you realize the healing is not happening."',
    ],
    'Assault Strike': [
      'In Assault Mode, he moves differently.',
      'The cheerful energy is gone. Only the motion remains.',
      'He hits with the accumulated mass of ten thousand years of suppressed violence.',
      'The strike carries none of the charm. All of the power.',
      '"This is what I keep restrained." He pulls back afterward.',
    ],
    'Trillion Dark': [
      '"Trillion Dark." He says the name once.',
      'Black energy concentrates at a single point.',
      'The release is not a beam or a shockwave.',
      'It is a decision: everything in a set radius takes the full output.',
      '"My strongest." He says it quietly. "I usually do not use it."',
    ],
  },

  dodgeLines: [
    '"Fast! Good!"',
    '"You moved before Full Counter could matter." He sounds pleased.',
    '"Nice evasion." He repositions.',
    '"You dodge well. Physical attacks are harder to Counter."',
  ],

  hitLines: [
    '"Ow. For real, ow." He rubs the spot.',
    '"You hit me hard." He is slightly more serious now.',
    '"Good hit. More."',
    '"Solid." He takes it and comes back.',
  ],

  tauntLines: [
    '"Use magic and it comes back at you. Use physical and you are on my terms. Pick your poison."',
    '"I have died more times than you have had fights. That sentence means something."',
    '"Assault Mode makes me much less fun to be around. Just so you know."',
    '"I was the captain of the Ten Commandments before I switched sides. Context."',
    '"Come on. I want to see if you figured out Full Counter\'s limitation."',
  ],

  victoryLines: [
    '"Good fight." He is already walking away.',
    '"You almost figured it out." He waves without turning.',
    '"Train and come back. I will be here." He is probably at the bar already.',
    '"Real fight. Appreciated it." He means this.',
  ],

  defeatLines: [
    '"Huh." He blinks.',
    '"You figured it out." He sounds genuinely surprised.',
    '"The limitation of Full Counter is that it requires input." He says it like confirming an answer.',
    '"Good." He sits. "Good fight."',
    '"Elizabeth is going to laugh when I tell her." He sounds fond.',
  ],

  special: {
    name: 'Full Counter',
    desc: 'If the player uses a skill (magic-type attack), Full Counter fires: the player takes their own skill\'s damage at 2x (applied before Meliodas takes any damage, and Meliodas takes 0 damage from that skill). Basic attacks bypass Full Counter and deal normal damage. This teaches the player to mix strategies.',
    trigger: [
      { type: 'on_skill_attack', key: 'fullCounter' },
    ],
    engineNote: `On player skill use that would deal damage: intercept before damage application. Deal Math.floor(finalDmg * 2.0) as true damage to player (bypassing player DEF). Set enemy finalDmg = 0 (Meliodas takes none). Show counter narrative. Basic attacks (non-skill) apply normally: deal full finalDmg to Meliodas. This creates a risk/reward mechanic where skills are dangerous but basic attacks are safe.`,
    narrativeLines: [
      '"Full Counter." The skill returns doubled.',
      '"Magic attack returned at two times force."',
      'Your own technique hits harder coming back.',
      '"Physical attacks work. Magic does not." He grins.',
    ],
  },

  playerHitLines: [
    '"Good hit!" He bounces back.',
    '"Physical attacks. Smart." He adjusts.',
    '"You found the gap. Nice."',
    '"Real power." He takes it.',
  ],

  playerSkillLines: [
    '"Full Counter ready." He waits for the skill to arrive.',
    '"Magic incoming. Ready to return."',
    '"That one is coming back double."',
    '"Skill used. Full Counter fires."',
  ],

  drops: [
    'lostvayne_fragment',
    'hellblaze_ember',
    'full_counter_rune',
    'dragon_sin_crest',
    'demon_king_splinter',
  ],
}
