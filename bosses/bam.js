/**
 * Bam - The Reversing Tide
 * Grade: SSS+ | Floor: 100 (Astral Tower master)
 * Original boss. Fourth of the five tower masters, second-strongest overall.
 *
 * PEAK ABILITY (Reverse Flow):
 *   Bam turns force back on its owner. On a telegraphed turn he goes still and
 *   opens himself; the next damaging blow you land is almost entirely absorbed,
 *   stored, and returned to you magnified on his following strike. The lesson
 *   is restraint: do not pour your biggest hit into the opening he shows you.
 *   Below 30% he ignites once, surging his attack and burning you a little
 *   every turn. Stronger than Celestia: his mechanic punishes greed on offence
 *   AND adds a hard enrage timer, so both caution and pace are tested at once.
 */

export const bam = {
  id: 'bam',
  name: 'Bam',
  floor: 100,
  grade: 'SSS+',
  emoji: '🌊',
  image: 'https://i.ibb.co/gG7v9Ks/Bam-Male-form.jpg',

  statOverride: { hp: 68000, def: 2000, atk: 4200 },
  hp: 68000,
  maxHp: 68000,
  atk: 4200,
  def: 2000,
  exp: 62000,
  gold: 46000,
  type: 'water',
  weakTo: [],
  resistTo: [],

  personality: 'quiet-patient-immense',
  voice: 'Slow and low, saying little. Every word lands like the pause before a wave draws back. He does not threaten. He simply is the tide.',

  lore: `The Astral Tower rises past the reach of ordinary strength, and its master learned long ago that strength is the easiest thing to turn against a person.

Bam does not meet force with force. He receives it. He lets a blow pour into him, holds it the way a shoreline holds a wave, and gives it back grown heavier than it came. Climbers who reach his floor are strong, the strongest the towers produce, and their strength is exactly the weapon he uses to break them.

He takes no pleasure in it. He simply understands, more deeply than anyone below him, that a tide cannot be beaten by pushing harder against it. It can only be beaten by a climber who knows when not to push at all. Corner him, and the still water finally breaks, and then even his restraint burns away.`,

  entrance: [
    'He is sitting when you arrive, perfectly still, and the stillness is louder than any roar would be.',
    '"You climbed the Astral Tower. That takes strength. More strength than most ever hold."',
    'He rises slowly, the way a tide draws back before it returns. "I am Bam. This floor is mine."',
    '"You will want to hit me with everything you have. Everyone does. That is the mistake."',
    '"Give me your force and I will give it back heavier. Or hold it, and learn the tide. Come. Show me which climber you are."',
  ],

  phases: {
    75: [
      '"Strong." He says it plainly, absorbing the shock of your blow. "But you are still pushing against the tide."',
      '"The harder you push, the more I have to return. You will feel that soon."',
    ],
    50: [
      '"You are learning to hold back." The water around him stills. "Good. That is the only thing that has ever worked on me."',
      '"But learning is not the same as knowing. Not yet."',
    ],
    25: [
      'The stillness cracks. Something under the calm water begins to glow and rise.',
      '"You have pushed me to the shallows. So be it." His voice heats. "The tide has held long enough. Now it burns."',
    ],
  },

  attacks: [
    'Undertow',
    'Returning Wave',
    'Still Water',
    'Rising Tide',
    'Breakwater',
  ],

  attackNarratives: {
    'Undertow': [
      'The floor seems to pull at your feet, dragging your balance out from under you.',
      'The blow lands as you are still trying to stand.',
      '"The tide takes the footing first."',
    ],
    'Returning Wave': [
      'Whatever force you last gave him, he lets it crest and break over you.',
      'It is your own power, come home heavier.',
      '"You gave me this. I am only returning it."',
    ],
    'Still Water': [
      'He does not seem to move at all, and yet the strike is already landing.',
      'The calmest water hides the strongest pull.',
      '"Stillness is not weakness. Remember that."',
    ],
    'Rising Tide': [
      'The water climbs around you, slow and inevitable, and then closes.',
      'There was time to move. There is never quite enough.',
      '"It rises whether you are ready or not."',
    ],
    'Breakwater': [
      'He meets your advance like a seawall meeting a storm, and the storm loses.',
      'The recoil of it throws you back the way you came.',
      '"Force breaks on what does not move."',
    ],
  },

  dodgeLines: [
    '"You read the pull and stepped clear of it. Few do."',
    '"The tide missed you. That is not nothing."',
    '"You are starting to move with the water instead of against it."',
    '"Good footing. The undertow could not find it."',
  ],

  hitLines: [
    '"You struck when I was not open. Wise. I could not return that one."',
    '"That reached me clean. You chose the moment well."',
    '"A measured blow. You are learning not to overcommit."',
    '"Yes. That is how you strike a tide. A little at a time."',
  ],

  tauntLines: [
    '"Hit me harder. Please. The harder you hit, the more I have to give back."',
    '"You want to unload everything into the opening. I am counting on it."',
    '"Force is a loan up here. I always collect it with interest."',
    '"The tide does not tire. Can you say the same, standing there swinging?"',
    '"Push against me and drown in your own strength. It is the oldest lesson of this floor."',
  ],

  victoryLines: [
    '"You gave me everything, and I gave it back." The water settles around him. "That was always going to end this way."',
    '"You never learned to hold your hand. Strength was your only answer, and I turn strength."',
    '"Rest. Come back when you know when not to push. The tide will be here."',
    '"There was no shame in it. You were strong. You were simply strong in the one way I defeat."',
  ],

  defeatLines: [
    'The tide goes still one last time, and does not rise again. Bam lowers his head, spent.',
    '"You held back when I opened, and struck when I could not answer. You learned the tide." His voice is quiet, and burnt out. "Truly."',
    '"Even the ignition could not save the shallows. You paced it perfectly."',
    '"Go up. Only Esteria remains above me, and she is not a tide you can turn. Be ready for her." He steps aside.',
  ],

  special: {
    name: 'Reverse Flow',
    desc: 'On a telegraphed turn Bam opens himself and absorbs the next damaging blow you land, taking only a fraction and storing the rest to return magnified on his next strike. The counter is restraint: do not commit your biggest hit into his opening. Below 30% health he ignites once, surging his attack and burning you each turn. Stronger than Celestia: he punishes greedy offence and adds a hard enrage, testing caution and pace together.',
    engineNote: `Case 'bam'. TURN_START: on a set cadence (~every 3rd turn) if not reverseArmed and no stored flow, set reverseArmed=true, narrativeLines[0]. ENEMY_TAKE_DAMAGE: if reverseArmed and damage>0, storedFlow=floor(damage*1.5), result.damage=floor(damage*0.2), reverseArmed=false, narrativeLines[1]. ENEMY_DEAL_DAMAGE: if storedFlow>0, result.damage=(result.damage||0)+storedFlow, storedFlow=0, narrativeLines[2]. Ignition: on ENEMY_TAKE_DAMAGE or TURN_START when enemy.hp<=30% and !ignited, set ignited=true, enemy.atk=floor(enemy.atk*1.35), narrativeLines[3]. While ignited on TURN_START set result.playerTrueDamage=floor(player.maxHp*0.04), narrativeLines[4].`,
    narrativeLines: [
      'Bam goes utterly still and opens his guard. The tide is drawing back, waiting to receive whatever you give it.',
      '"Given." Your blow pours into him and is swallowed almost whole, held somewhere beneath the calm.',
      '"Returned." Bam gives your own force back to you, crested and grown heavier than it left your hand.',
      'The still water cracks and ignites. Something molten rises through Bam, and the air begins to burn.',
      'The burning tide sears you where you stand.',
    ],
  },

  playerHitLines: [
    '"Struck clean, when I had nothing stored to return. Well judged."',
    '"You waited out my opening. That blow I simply had to take."',
    '"You are not feeding the tide anymore. That is how it is done."',
    '"A patient hit. Those are the ones I cannot give back."',
  ],

  playerSkillLines: [
    '"A technique, spent when I was not braced to turn it. Clever."',
    '"You timed that art past my opening. I could not reverse it."',
    '"Skill and restraint together. That is the pairing that beats a tide."',
    '"Well chosen. You did not pour it into the wave."',
  ],

  drops: [
    'bam_reversed_current_shard',
    'tide_core',
    'ignition_ember',
    'absorbed_force_crystal',
    'still_water_stone',
  ],
}
