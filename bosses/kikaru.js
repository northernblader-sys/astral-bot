/**
 * Kikaru - The Afterimage
 * Grade: SS+ | Floor: 100 (Gambit's Dungeon master)
 * Original boss. Second of the five tower masters.
 *
 * PEAK ABILITY (Afterimage Tempo):
 *   Kikaru builds speed every turn he is left to move. Past a threshold his
 *   afterimages start eating your basic attacks outright, and if he reaches
 *   full tempo he strikes twice in one motion. The counter is disruption:
 *   a skill or a critical hit shatters his rhythm and drops his tempo to
 *   nothing, so a climber who never breaks his flow gets run over, and one
 *   who interrupts him on beat keeps him honest. Stronger than Syclila: his
 *   pressure builds on its own and demands active answers, not just patience.
 */

export const kikaru = {
  id: 'kikaru',
  name: 'Kikaru',
  floor: 100,
  grade: 'SS+',
  emoji: '💨',
  image: 'https://i.ibb.co/7dLybKLW/Kikaru.jpg',

  statOverride: { hp: 30000, def: 1100, atk: 3000 },
  hp: 30000,
  maxHp: 30000,
  atk: 3000,
  def: 1100,
  exp: 24000,
  gold: 17000,
  type: 'wind',
  weakTo: [],
  resistTo: [],

  personality: 'arrogant-restless-showman',
  voice: 'Fast, clipped, delighted with his own speed. He talks the way he fights, never letting a beat sit still.',

  lore: `Gambit's Dungeon rewards the reckless and buries the slow, so of course its master is the fastest thing in it.

Kikaru does not block, does not brace, does not wait. He moves, and where he was becomes an afterimage a half-second behind him, and by the time your blade finds it he is already somewhere it cannot follow. Climbers who reach his floor tend to be gamblers themselves, and they try to out-speed him. None have.

The only ones who trouble him are the ones who refuse to play his tempo. Break his rhythm and the afterimages fall apart, and for a moment there is only one Kikaru, and he is as mortal as anyone. He will never admit how much he hates that moment.`,

  entrance: [
    'You do not see him arrive. You see three of him, and then one, and the other two catch up a breath later.',
    '"Fast enough to make it here. Not fast enough to see me. That is most people."',
    '"Kikaru. Master of this floor, if you want the title. I never use it."',
    'He rolls his shoulders, and for a second there are two of him doing it.',
    '"Here is the only rule that matters up here. Keep up, or become a smear on my afterimage. Go."',
  ],

  phases: {
    75: [
      '"Oh, you are quick." Three of him circle and become one. "Quick is fun. Quick I can play with."',
      '"Try to keep the beat. It only gets faster from here."',
    ],
    50: [
      '"Half? Already?" He clicks his tongue, annoyed and thrilled at once. "You keep breaking my rhythm. Rude."',
      '"Fine. Fine. Let me actually move."',
    ],
    25: [
      'The afterimages stop trailing and start leading, a dozen Kikarus a step ahead of the real one.',
      '"No more warmup. If you cannot break my tempo now, this is where you become the smear."',
    ],
  },

  attacks: [
    'Blur Step',
    'Split Rush',
    'Tempo Strike',
    'Afterimage Barrage',
    'Cut and Gone',
  ],

  attackNarratives: {
    'Blur Step': [
      'He steps once and arrives from three directions.',
      'Only one of them is carrying the real blow.',
      '"Guess. You have half a second."',
    ],
    'Split Rush': [
      'Two afterimages peel off and rush your flanks.',
      'The real Kikaru comes straight up the middle while you watch the copies.',
      '"You looked the wrong way. People always do."',
    ],
    'Tempo Strike': [
      'He falls into a rhythm you can almost hear, and hits on the beat.',
      'Each strike lands exactly where the last one taught you not to expect.',
      '"Da, da, da. Catchy, is it not?"',
    ],
    'Afterimage Barrage': [
      'Every afterimage he has left strikes at once.',
      'Most are ghosts. Enough are not.',
      '"Sort out which is which. Quickly."',
    ],
    'Cut and Gone': [
      'A single clean cut, and he is already back where he started.',
      'You feel the wound before you register the motion.',
      '"Already gone. Do keep up."',
    ],
  },

  dodgeLines: [
    '"Ha! You read the afterimage. Not bad."',
    '"You stepped where I actually was. Lucky, or clever?"',
    '"Fast hands. Faster eyes. I approve."',
    '"You are not chasing the copies anymore. Annoying of you."',
  ],

  hitLines: [
    '"Tch. You broke the beat and cut the real one."',
    '"That landed on me. The actual me. When did you learn that?"',
    '"You interrupted my rhythm. I felt that one."',
    '"Fine, fine, that was a good hit. Do not get used to it."',
  ],

  tauntLines: [
    '"Swing at the afterimage all you like. It swings back and I do not."',
    '"You are keeping my tempo for me. Thank you. It makes this so easy."',
    '"Slow. So slow. I have hit you four times since you decided to move."',
    '"Every turn you let me flow, I get faster. You do the math. Quickly, now."',
    '"Break my rhythm or become part of the blur. Those are the options."',
  ],

  victoryLines: [
    '"And gone." His voice comes from three places at once. "You never did find the real me."',
    '"You kept my tempo the whole way. That is why you lost. You have to break it."',
    '"Come back when you can interrupt a man mid-beat. Then we will really play."',
    '"Do not feel bad. Almost no one keeps up. That is rather the point of me."',
  ],

  defeatLines: [
    'The afterimages scatter and do not reform. For once there is only one Kikaru, breathing hard.',
    '"You kept breaking my rhythm. Right when it mattered. Every time." He almost smiles.',
    '"One of me. You cut down to one of me. Nobody does that."',
    '"Go on up. You earned the pass, rhythm-breaker. I hate that you earned it."',
  ],

  special: {
    name: 'Afterimage Tempo',
    desc: 'Kikaru gains a tempo stack every turn. At 3+ his afterimages begin dodging your basic attacks outright (chance scales with tempo, capped near half). At 5 he strikes twice in one motion for heavy bonus damage. Any skill, or a critical basic hit, shatters his rhythm and resets tempo to 0. Stronger than Syclila: the pressure snowballs on its own and forces active disruption rather than patience.',
    engineNote: `Case 'kikaru'. TURN_START: bossState.tempo=(tempo||0)+1; if tempo>=3 emit narrativeLines[0] (building). PLAYER_BASIC_ATTACK: if tempo>=3 roll dodgeChance=min(0.5, tempo*0.10); on success set damage 0, narrativeLines[1]. PLAYER_SKILL_ATTACK: set tempo=0, narrativeLines[2]. PLAYER_HIT_ENEMY: if context crit, set tempo=0, narrativeLines[2]. ENEMY_DEAL_DAMAGE: if tempo>=5, damage=floor(damage*1.7), tempo=0, narrativeLines[3] (spends the flurry).`,
    narrativeLines: [
      'Afterimages begin trailing a half-beat behind every step Kikaru takes. His tempo is climbing.',
      '"Missed. That was never me." Your blade passes clean through an afterimage and he is already gone.',
      'Your strike lands on the beat between beats. His rhythm shatters and the afterimages collapse to one.',
      '"Full speed." Too fast to follow, Kikaru strikes twice in the space of one motion.',
    ],
  },

  playerHitLines: [
    '"You cut the real one. Again. How."',
    '"On the offbeat. That is the only place I am solid."',
    '"You keep interrupting me right when I get going. Infuriating."',
    '"That one counted. The afterimages did not save me."',
  ],

  playerSkillLines: [
    '"A technique cuts through the blur. Of course it does."',
    '"You broke my rhythm with that. My tempo, gone. Rude and effective."',
    '"Skills do not chase copies. They find the real me. I hate skills."',
    '"There it is. You spent a technique to reset me. Smart."',
  ],

  drops: [
    'kikaru_afterimage_wisp',
    'tempo_shard',
    'blurred_step_fragment',
    'momentum_crystal',
    'quickened_pulse_stone',
  ],
}
