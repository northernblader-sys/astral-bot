/**
 * Sasuke Uchiha - The Last Uchiha
 * Grade: SS | Floor: 72
 * Naruto
 */

export const sasuke_uchiha = {
  id: 'sasuke_uchiha',
  name: 'Sasuke Uchiha',
  floor: 72,
  grade: 'SS',
  emoji: '⚡',
  image: null,
  hp: 22000,
  maxHp: 22000,
  atk: 1450,
  def: 520,
  exp: 16000,
  gold: 11000,
  type: 'shadow',
  weakTo: [],
  resistTo: ['fire', 'shadow', 'magic'],

  personality: 'cold-driven-proud',
  voice: 'Minimal. Each word is a decision. He does not speak to fill silence.',

  lore: `He is the last Uchiha who matters. He trained in hate, graduated to purpose, survived every version of loss that the world offered, and came out of it with a Rinnegan, a perfect Susanoo, and a slightly warmer disposition than the one he started with.

His Rinnegan lets him swap places with anything in his field of vision. His Chidori threads through any defense. His Amaterasu produces black flame that does not stop burning once ignited. His Susanoo is fast enough to intercept attacks that were already moving.

He fights with economy. No wasted movement. No wasted chakra. He reads the battlefield in real time and acts on the optimal answer without hesitation.

He is not the strongest person in the world. He is the person most prepared to fight whoever the strongest person in the world is.`,

  entrance: [
    'He leans against the far wall with his arm crossed, waiting.',
    '"You took longer than I expected." He straightens.',
    '"Rinnegan." His left eye opens. The tomoe circle the rings.',
    '"This fight ends quickly or it ends with everything I have. Your call."',
    'He grips the collar of his cloak and drops into his stance.',
  ],

  phases: {
    75: [
      '"Sharingan analysis complete." His right eye activates.',
      '"I know your attack pattern. That makes this easier."',
      '"Amaterasu on standby."',
    ],
    50: [
      '"Susanoo." The ribcage forms around him.',
      '"Full armor version. I have not needed this in a while."',
      '"You made me bring it out. That is... acknowledged."',
    ],
    25: [
      '"Everything." He exhales.',
      '"Indra\'s Arrow is ready." He charges.',
      '"This is where the gap closes or it does not."',
    ],
  },

  attacks: [
    'Chidori',
    'Amaterasu',
    'Rinnegan Swap',
    'Susanoo Blade',
    'Indra\'s Arrow',
  ],

  attackNarratives: {
    'Chidori': [
      'Lightning gathers in his hand with that sound: a thousand birds.',
      'He runs at you and the movement is deliberate and targeted.',
      'The Chidori penetrates defense by vibrating at the resonant frequency of matter.',
      'Contact. The lightning disperses through whatever it hits.',
      'He withdraws his hand and watches the result.',
    ],
    'Amaterasu': [
      'His right eye bleeds black flame.',
      'The flame appears where he is looking.',
      'It does not burn with heat. It burns with inevitability.',
      'Amaterasu cannot be put out. It burns until he deactivates it or there is nothing left.',
      'You run from where his gaze falls and the fire keeps burning behind you.',
    ],
    'Rinnegan Swap': [
      'He swaps positions with something in the room.',
      'Not with you. With something behind you.',
      'The resulting position puts him inside your guard.',
      'You turn around and he is where you were not expecting.',
      '"Rinnegan spatial technique. You should plan for it."',
    ],
    'Susanoo Blade': [
      'The Susanoo extends one arm.',
      'The ethereal blade it holds is as long as the corridor.',
      'One horizontal swing clears the room.',
      'You hit the floor below the swing and the blade passes above you.',
      'The shockwave from it still knocks you sideways.',
    ],
    'Indra\'s Arrow': [
      '"Indra\'s Arrow." He begins charging all remaining Susanoo chakra.',
      'The arrow forms and it is made of compressed lightning on the scale of a spear.',
      'He draws it back with a Susanoo arm.',
      'He releases.',
      'The arrow carries every remaining unit of Sasuke\'s chakra. Wherever it goes, the fight changes.',
    ],
  },

  dodgeLines: [
    '"Sharingan tracks you."',
    '"Good evasion. Rinnegan is recalculating."',
    '"You moved. I account for that now."',
    '"Fast." One word.',
  ],

  hitLines: [
    '"You got through Susanoo." He notes it.',
    '"Good hit." He says nothing more.',
    '"Stronger than I estimated."',
    '"Real output." He adjusts.',
  ],

  tauntLines: [
    '"I have fought stronger than you. I did not lose those fights."',
    '"Your technique is readable. Give me something I cannot predict."',
    '"Rinnegan and Sharingan simultaneously. You cannot hide from both."',
    '"Stronger. I need to see what you are hiding."',
    '"The last Uchiha does not lose to this."',
  ],

  victoryLines: [
    '"Train more." He leaves.',
    '"You were close. Not close enough."',
    '"Come back." It might be an invitation.',
    '"You fought well. That matters." He actually means this.',
  ],

  defeatLines: [
    'He goes to one knee.',
    '"You beat the last Uchiha." He says it without self-pity.',
    '"This is a result I did not plan for." He sounds analytical.',
    '"Good fight." He stands up slowly. "Good fight."',
    '"I need to get stronger." He is already thinking about the training.',
  ],

  special: {
    name: 'Amaterasu Mark',
    desc: 'If the player misses an attack (evasion or miss roll), Sasuke marks them with Amaterasu. The mark deals burn damage for 3 turns (3% max HP per turn). A second miss re-applies and resets the duration. Defending on the turn you are marked ends the burn early (you smother it).',
    trigger: [
      { type: 'on_player_miss', key: 'amaterasuMark' },
      { type: 'on_player_defend', key: 'amaterasuSmother' },
    ],
    engineNote: `Track bossState.amaterasuActive (bool). On player miss: if not amaterasuActive, apply burn activeEffect to player (3% maxHp per turn, 3 turns, sourceId: 'amaterasu'), set bossState.amaterasuActive = true, show mark line. If amaterasuActive: refresh burn duration to 3. On player defend: remove any 'amaterasu' sourceId burns from player.activeEffects, set amaterasuActive = false, show smothered line.`,
    narrativeLines: [
      '"Amaterasu." The black flame marks you.',
      'The black flame does not stop burning on its own.',
      '"You smothered it. Good thinking."',
      'The mark re-ignites where you missed.',
    ],
  },

  playerHitLines: [
    '"Good hit." He is already adjusting.',
    '"That reached me." He notes it.',
    '"Strong." He absorbs it.',
    '"You broke through Susanoo." He respects that.',
  ],

  playerSkillLines: [
    '"A technique. Sharingan is analyzing."',
    '"Use it again. I want the full pattern."',
    '"Good output." He watches it arrive.',
    '"Strong skill. Third use will be anticipated."',
  ],

  drops: [
    'chidori_lightning_shard',
    'amaterasu_cinder',
    'rinnegan_sliver',
    'susanoo_crystal_fragment',
    'uchiha_hawk_feather',
  ],
}
