/**
 * Kaguya Otsutsuki - The Progenitor, Mother of Chakra
 * Grade: SSS | Floor: 84
 * Naruto
 */

export const kaguya_otsutsuki = {
  id: 'kaguya_otsutsuki',
  name: 'Kaguya Otsutsuki',
  floor: 84,
  grade: 'SSS',
  emoji: '🌙',
  image: null,
  hp: 72000,
  maxHp: 72000,
  atk: 3500,
  def: 2200,
  exp: 38000,
  gold: 26000,
  type: 'divine',
  weakTo: [],
  resistTo: ['physical', 'magic', 'fire', 'ice', 'shadow', 'void'],

  personality: 'ancient-silent-absolute',
  voice: 'Barely speaks. When she does, each word is a law older than civilization.',

  lore: `She was the first human to eat from the God Tree and gain chakra, before chakra existed. She became a god and then something beyond gods. Her children were born with her power diluted through generations. Everything that came after her was downstream of her.

The All-Killing Ash Bones reduce any living tissue they touch to dust. Not burning. Not cutting. Structural disintegration. She can shift the dimension of the battle on a whim: to a lava dimension, a gravity dimension, an ice dimension, a sand dimension. The rules of combat change with the terrain.

She does not view this as a fight. She views this as reclamation. Everything with chakra belongs to her. You are overdue for collection.

Her third eye opens when she decides you are worth responding to.`,

  entrance: [
    'She does not enter. The dimension shifts to accommodate her.',
    'She floats into the room on wings of pure chakra, hair spreading outward like a white void.',
    'Her third eye, sealed on her forehead, opens halfway.',
    'She looks at you the way something ancient looks at something brief.',
    '"You have chakra." She says it like an accusation. "That belongs to me."',
  ],

  phases: {
    75: [
      '"Dimension shift." She says it quietly.',
      'The room becomes lava. The floor glows orange. The ceiling is fire.',
      '"Survive this. Perhaps I will find you interesting."',
    ],
    50: [
      '"You adapt." She sounds faintly surprised.',
      'The dimension shifts again: crushing gravity.',
      '"All-Killing Ash Bones. No more patience."',
    ],
    25: [
      '"Rinne-Sharingan." Her third eye opens fully.',
      '"Infinite Tsukuyomi would be merciful." She decides against mercy.',
      '"You have earned my full attention. You will not enjoy it."',
    ],
  },

  attacks: [
    'All-Killing Ash Bones',
    'Dimension Shift',
    'Yomotsu Hirasaka Portal Strike',
    'Infinite Chakra Pressure',
    'Rinne-Sharingan Gaze',
  ],

  attackNarratives: {
    'All-Killing Ash Bones': [
      'A bone protrudes from her palm.',
      'She launches it without hurry.',
      'The projectile dissolves stone where it passes.',
      'Contact with living tissue causes the same immediate disintegration.',
      'You dodge and the wall behind you reduces to powder in a perfect line.',
    ],
    'Dimension Shift': [
      '"Yomotsu Hirasaka." She opens a rift.',
      'The room becomes something else.',
      'Lava, or crushing gravity, or blizzard ice.',
      'The environment itself deals damage while she watches you adjust.',
      '"This is not a dungeon. This is my domain." She means it completely.',
    ],
    'Yomotsu Hirasaka Portal Strike': [
      'A black portal opens behind you.',
      'She steps out of it in front of you simultaneously.',
      'Distance does not apply to a being who created dimensional travel.',
      'The strike comes from inside your guard because she entered inside your guard.',
      '"Portals. Everywhere. Always." She returns through the same portal.',
    ],
    'Infinite Chakra Pressure': [
      'She releases an ambient wave of pure primordial chakra.',
      'The force is not targeted. It does not need to be.',
      'Every cell in your body that contains any trace of chakra feels it.',
      'The pressure is the weight of the original source of all power pushing you down.',
      'You stay upright through pure stubbornness.',
    ],
    'Rinne-Sharingan Gaze': [
      'The third eye opens fully.',
      'The Rinne-Sharingan sees through every defense, barrier, and evasion.',
      'It does not attack with light. It attacks with recognition.',
      'Being fully seen by the primordial eye of the goddess who owns your chakra is physically painful.',
      'Your HP drops and your MP leaks from the exposure.',
    ],
  },

  dodgeLines: [
    '"You moved." She says it without inflection.',
    '"Chakra waste." She notes the expenditure.',
    '"Futile. But noted."',
    'She watches your evasion with mild curiosity.',
  ],

  hitLines: [
    '"You struck the source of all chakra." She blinks.',
    '"This has not happened before." Not a statement of surprise. Just data.',
    '"You have real power." She recalibrates.',
    '"Your chakra is strong. It will return to me eventually."',
  ],

  tauntLines: [
    '"All chakra belongs to the God Tree. You are simply borrowing what is mine."',
    '"You cannot kill the progenitor. You can only delay the inevitable."',
    '"Chakra was not given to you. It was inherited without permission."',
    '"I created the entire system you are using against me. Think about that."',
    '"Every jutsu. Every skill. Every technique. All of it comes from me."',
  ],

  victoryLines: [
    '"Reclaimed." She closes her third eye.',
    '"Return when you have grown. I will collect then."',
    '"Your chakra fought well. It will serve the God Tree better now."',
    '"Inevitable." She departs through a portal.',
  ],

  defeatLines: [
    '"The... progenitor." She touches her own face.',
    '"Falls." She says the word like testing whether it has meaning.',
    '"You carry power that should not exist." She settles to the ground.',
    '"Whoever gave you this... was more generous than I ever was." She closes all her eyes.',
    'The room returns to normal dimensions. Slowly.',
  ],

  special: {
    name: 'Dimensional Terror',
    desc: 'Every 5 turns, Kaguya shifts the battlefield dimension. Each dimension adds a passive damage-over-time effect: Lava (burn 4% max HP per turn), Gravity (player DEF reduced by 30%), Ice (player skill MP costs doubled). The dimension rotates (Lava-Gravity-Ice-Lava...). Returning player to normal happens only when Kaguya is defeated.',
    trigger: [
      { type: 'turn_interval', value: 5, key: 'dimensionShift' },
    ],
    engineNote: `Track bossState.dimension (index 0,1,2 cycling). On shift: bossState.dimension = (bossState.dimension + 1) % 3. Apply passive effect: 0=Lava (add burn activeEffect to player), 1=Gravity (track as bossState.gravityDebuff flag, multiply player def by 0.70 in damage calc), 2=Ice (double mpCost for skills, track as bossState.iceDebuff). Remove previous dimension effect when shifting. Show dimension change narrative. On fight end: clear all dimension effects.`,
    narrativeLines: [
      '"Dimension shift." The room becomes lava.',
      '"Gravity dimension." The air becomes crushing.',
      '"Ice dimension." Movement slows, chakra costs rise.',
      '"This is my world now. Your rules do not apply here."',
    ],
  },

  playerHitLines: [
    '"You struck me." She says it without anger.',
    '"Real power." She acknowledges it.',
    '"Your chakra output is... significant." The word costs her.',
    '"That reached the progenitor." She recalibrates.',
  ],

  playerSkillLines: [
    '"Using my gifts against me." She sounds faintly amused.',
    '"All chakra techniques originate with me. You know this."',
    '"A strong use of inherited power."',
    '"The God Tree taught your ancestors this. Indirectly."',
  ],

  drops: [
    'ash_bone_fragment',
    'god_tree_shard',
    'rinne_sharingan_sliver',
    'primordial_chakra_crystal',
    'yomotsu_portal_dust',
  ],
}
