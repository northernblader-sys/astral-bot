/**
 * Syclila - The Mirrorkeeper
 * Grade: SS | Floor: 100 (Entry Tower master)
 * Original boss. Weakest of the five tower masters.
 *
 * PEAK ABILITY — Mirror Veil:
 *   She raises a silvered pane on a timed cadence. While it hangs, your next
 *   blow is caught by the glass and returned to you, and she takes none of it.
 *   The counter is to DEFEND on the turn she raises it: the frame shatters
 *   instead of your body, and she stands exposed so your next strike bites
 *   for half again. The reflect is small and the tell is loud, which is why
 *   she is the gentlest of the masters to read.
 */

export const syclila = {
  id: 'syclila',
  name: 'Syclila',
  floor: 100,
  grade: 'SS',
  emoji: '🪞',
  image: 'https://i.ibb.co/HfPCXCck/Syclila.jpg',

  // statOverride pins her off the floor curve so the five masters form a clean
  // ascending ladder (see the other four). She is the floor of that ladder.
  statOverride: { hp: 18000, def: 700, atk: 2200 },
  hp: 18000,
  maxHp: 18000,
  atk: 2200,
  def: 700,
  exp: 16000,
  gold: 11000,
  type: 'holy',
  weakTo: [],
  resistTo: [],

  personality: 'serene-precise-testing',
  voice: 'Calm, unhurried, faintly amused. She speaks the way still water reflects, giving back exactly what is shown to it.',

  lore: `She keeps the first mirror, the one set at the top of the Entry Tower so that every climber must meet themselves before they are allowed any higher.

Syclila does not hate the people who come to her floor. She simply shows them what they brought. A climber who swings wildly is cut by their own wildness. A climber who waits, who reads, who answers the glass instead of the reflection, passes clean.

There is no trick to her that patience does not solve. That is the whole lesson of the first mirror, and she has taught it a thousand times without once raising her voice.`,

  entrance: [
    '"So. Another face at my glass." She does not rise. She was already standing.',
    '"I am Syclila. I keep the mirror at the top of this tower."',
    '"You have climbed a hundred floors to reach me. Good. That is enough to have learned something."',
    'She lifts a pane of silvered glass and sets it turning slowly at her side.',
    '"Now we find out what. Come, and meet yourself."',
  ],

  phases: {
    75: [
      '"You hit hard. I felt that." She tilts the glass a degree. "But hard is not the question here."',
      '"The question is whether you can tell when to hold your hand."',
    ],
    50: [
      '"Halfway. And you are starting to watch the mirror instead of me." A small nod. "Good."',
      '"Most never learn that in time. You might."',
    ],
    25: [
      '"You have read me almost to the end." The glass hums, thin and clear.',
      '"One last time, then. Answer the mirror, not the fear. Show me you understood."',
    ],
  },

  attacks: [
    'Silvered Cut',
    'Reflecting Palm',
    'Pane Sweep',
    'Quiet Riposte',
    'Turning Glass',
  ],

  attackNarratives: {
    'Silvered Cut': [
      'She draws one edge of the glass across the air.',
      'The cut arrives a moment before you see her move.',
      '"A clean line. Nothing wasted."',
    ],
    'Reflecting Palm': [
      'She sets her palm flat against the pane and pushes.',
      'The force comes through the glass instead of around it.',
      '"What you give, the mirror keeps a little of."',
    ],
    'Pane Sweep': [
      'The turning glass sweeps a wide, unhurried arc.',
      'It is slow enough to see and fast enough to matter.',
      '"You had time to move. Did you use it?"',
    ],
    'Quiet Riposte': [
      'She waits for your weight to commit, then answers it.',
      'The counter lands exactly where you left yourself open.',
      '"You told me where you would be. I only listened."',
    ],
    'Turning Glass': [
      'The pane spins full circle, catching the light in a ring.',
      'Every angle of it passes through you once.',
      '"Round, and round. Steady now."',
    ],
  },

  dodgeLines: [
    '"There. You waited. That is the whole art."',
    '"You saw the glass turn and you stepped. Good eyes."',
    '"A patient dodge. I like that better than a fast one."',
    '"You are learning to read me. It suits you."',
  ],

  hitLines: [
    '"Yes. That one was thought through."',
    '"You struck when the glass was down. Correct."',
    '"Clean. You are not swinging at your own reflection anymore."',
    '"Better. Much better."',
  ],

  tauntLines: [
    '"Swing harder if you like. The mirror only gives it back."',
    '"You are fighting the reflection, not me. Look closer."',
    '"Every wild blow you throw, you will feel again. Choose them."',
    '"Patience is not slowness. Learn the difference here, or not at all."',
    '"I have all the time the tower will give. Do you?"',
  ],

  victoryLines: [
    '"You met yourself and flinched." She lowers the glass. "It happens to almost everyone."',
    '"Rest at the mirror. Come back when you can hold your hand as well as your sword."',
    '"Not this time. The first floor keeps you a little longer."',
    '"There is no shame in it. Only a lesson you have not finished."',
  ],

  defeatLines: [
    '"Ah." She looks at the crack running through her glass, unsurprised. "You answered the mirror."',
    '"You held your hand when it mattered and struck when it counted. That is passing."',
    '"Go up, then. You have earned the floors above me."',
    'She steps aside from the stair. "The tower is yours to climb. You already know how."',
  ],

  special: {
    name: 'Mirror Veil',
    desc: 'On a set cadence Syclila raises a silvered pane. While it hangs, the next damaging blow you land is caught and returned to you and she takes none of it. Defending on the turn she raises it shatters the frame harmlessly and leaves her exposed, so your next hit deals 50% more. A gentle, loud, fully readable mechanic: the floor of the five masters.',
    engineNote: `Case 'syclila'. TURN_START: every 4th boss turn set bossState.mirrorRaised=true and emit narrativeLines[0] (the tell). ENEMY_TAKE_DAMAGE: if mirrorRaised and damage>0, set damage 0, reflectDamage = floor(damage*0.40), clear mirrorRaised, narrativeLines[1]. If bossState.exposed and damage>0, multiply damage by 1.5, clear exposed, narrativeLines[3]. PLAYER_DEFEND: if mirrorRaised, clear it, set exposed=true, narrativeLines[2].`,
    narrativeLines: [
      '"Mirror up." A pane of silvered glass swings between you. Strike it and it strikes back.',
      '"The glass keeps what you gave." Your blow lands on the mirror and comes straight back at you.',
      '"You struck the frame, not me." The mirror cracks across, and for a breath she stands unguarded.',
      '"You found the crack." The flaw runs deep, and your next blow bites through it half again as hard.',
    ],
  },

  playerHitLines: [
    '"Timed well. The glass was down."',
    '"You read the cadence. That is the trick of it."',
    '"A patient hit. Those are the ones that land."',
    '"You are not fighting your reflection anymore. Good."',
  ],

  playerSkillLines: [
    '"A technique, and a well chosen moment for it."',
    '"You saved that for when the mirror was down. Wise."',
    '"The glass cannot catch what it did not see coming."',
    '"Clever. You waited for the opening and then spent it."',
  ],

  drops: [
    'syclila_mirror_shard',
    'silvered_glass_fragment',
    'reflection_dust',
    'mirrorkeeper_veil_scrap',
    'twinned_gaze_stone',
  ],
}
