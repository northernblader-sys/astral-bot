/**
 * Julius Novachrono - The Wizard King
 * Grade: SS | Floor: 74
 * Black Clover
 */

export const julius_novachrono = {
  id: 'julius_novachrono',
  name: 'Julius Novachrono',
  floor: 74,
  grade: 'SS',
  emoji: '⏳',
  image: null,
  hp: 28000,
  maxHp: 28000,
  atk: 1600,
  def: 700,
  exp: 18000,
  gold: 12000,
  type: 'time',
  weakTo: [],
  resistTo: ['physical', 'magic', 'fire', 'ice'],

  personality: 'enthusiastic-wise-temporal',
  voice: 'Warm and delighted, like someone who genuinely loves magic and has never stopped finding it wonderful.',

  lore: `He became the Wizard King by outworking every other candidate by a factor that should not have been possible. His Time Magic lets him do things that should not be possible. He stores time stolen from the magical attacks that hit him, then uses that stored time to slow opponents, speed himself, or reverse the aging of wounds.

Chrono Stasis is the core technique: he freezes time for everything in a radius around him. Full freeze. Absolute. If you are inside that radius, you cannot move, attack, or evade until the freeze ends.

He died once, came back as a child because the stored time remaining in his body was limited. He ran the Kingdom as a child. He made it work.

He is not fighting you to harm you. He is fighting you because the magic you carry is genuinely interesting and he wants to see all of it.`,

  entrance: [
    '"Oh my! What fascinating magic!" He appears next to you already.',
    '"I could feel it from several floors down. You have something really interesting!"',
    '"Julius Novachrono, Wizard King of the Clover Kingdom." He bows.',
    '"I would love to have a conversation about your magic after this." He pauses.',
    '"But first: fight me." The warmth in his voice does not dim. "I need to see all of it."',
  ],

  phases: {
    75: [
      '"Oh excellent! You are holding back!"',
      '"Time Capture: stored. I have been collecting this entire time."',
      '"Let me show you what time magic looks like when I mean it."',
    ],
    50: [
      '"Chrono Stasis." He says it and the room slows.',
      '"You are moving through syrup now. My apologies. Not really."',
      '"This is my favorite technique. I never get tired of the look on people\'s faces."',
    ],
    25: [
      '"Time Reversal." He reaches inward.',
      '"I stored enough from your attacks to restore a significant amount." He heals.',
      '"Thank you for providing that, incidentally."',
    ],
  },

  attacks: [
    'Chrono Stasis',
    'Time Arrow',
    'Accelerated Strike',
    'Temporal Aging',
    'Wizard King Barrage',
  ],

  attackNarratives: {
    'Chrono Stasis': [
      '"Chrono Stasis." He exhales.',
      'The air solidifies. Not cold. Just stopped.',
      'For three heartbeats, your body does not belong to you.',
      'You are frozen mid-motion and he takes the time to reposition.',
      '"Time resumes." He is behind you.',
    ],
    'Time Arrow': [
      'He forms an arrow of compressed time-magic.',
      'The arrow does not fly at speed. It arrives at the moment it touches you.',
      'Not fast. Simply already there upon release.',
      'The impact carries the weight of all the time compressed into it.',
      '"Time Arrow. One of my favorites for long range." He watches it hit.',
    ],
    'Accelerated Strike': [
      'He borrows time.',
      'Two seconds from the ambient magic around him.',
      'He uses those two seconds to move at a rate that converts into approximately twenty.',
      'He is next to you before you register his departure from his previous position.',
      '"Accelerated movement. Using stored time." He taps his watch. "Efficient."',
    ],
    'Temporal Aging': [
      'He places one hand near you.',
      'Time accelerates locally.',
      'Your wounds age, your active buffs expire, your MP ticks down faster.',
      'The localized time acceleration compresses a few turns of natural entropy into one.',
      '"Aging your condition, not your body. More useful."',
    ],
    'Wizard King Barrage': [
      '"Shall I show you everything?" He spreads his hands.',
      'Every time technique fires in rapid sequence.',
      'Slowing, accelerating, arrowing, stasiswaves.',
      'Each one alone would be manageable. Together they compose.',
      '"The Wizard King did not earn that title from one technique."',
    ],
  },

  dodgeLines: [
    '"Oh! You moved! Fantastic!"',
    '"Fast! I love fast!"',
    '"You evaded a time arrow! Do you know how few people do that?!"',
    '"Good speed! Very good!"',
  ],

  hitLines: [
    '"Ouch! And excellent!"',
    '"You hit me! Wonderful power!"',
    '"Strong!" He is delighted.',
    '"Real force! I am storing the impact magic right now!"',
  ],

  tauntLines: [
    '"Do not hold back! I want to see ALL of your magic!"',
    '"Time magic can slow you or freeze you or age you. I am deciding which."',
    '"I am absorbing the time from everything you hit me with. Keep going!"',
    '"I am the Wizard King because no one in a generation could match my time magic. Fight accordingly."',
    '"Wonderful! More! I want to see everything!"',
  ],

  victoryLines: [
    '"What a fight! That was wonderful!" He claps.',
    '"You have remarkable magic. I hope you develop it further."',
    '"Recover. I want to talk about your technique later."',
    '"The Wizard King is satisfied." He bows.',
  ],

  defeatLines: [
    '"Oh my." He blinks.',
    '"Time... ran out." He says it like a pun and immediately feels bad.',
    '"You are truly exceptional." He sits.',
    '"I would like to recruit you. When you are ready." He means this completely.',
    '"What a wonderful day." He looks at the ceiling. "Losing to someone this strong."',
  ],

  special: {
    name: 'Time Capture',
    desc: 'Every hit that lands on Julius stores "time units." After 4 stored hits, he triggers Time Reversal: restores HP equal to 12% of max HP. The player can "waste" stored time by dealing damage in quick succession before the threshold (3 hits before the 4th stores) - the 4th hit spends all stored time but does not trigger healing if dealt within the same turn as hits 2 and 3.',
    trigger: [
      { type: 'on_player_hit', key: 'timeCapture', threshold: 4, stackable: true },
    ],
    engineNote: `Track bossState.timeUnits (default 0). Each time player hits: increment timeUnits. When timeUnits >= 4: heal enemy.hp by Math.floor(enemy.maxHp * 0.12), reset timeUnits to 0, show reversal line. Track bossState.hitsThisTurn. On turn start: reset hitsThisTurn to 0. Each hit: increment hitsThisTurn. If hitsThisTurn >= 3 and the 4th hit comes: treat as flush only if all 4 happened within same turn (set timeUnits to 0 without healing, show "time spent too fast to capture" line).`,
    narrativeLines: [
      '"Time stored!" He adds it to his reserves.',
      '"Time Reversal! Thank you for the contribution."',
      '"Four units. Reversal fires." He heals.',
      '"Time dispersed too quickly to capture." The rapid hits drained it.',
    ],
  },

  playerHitLines: [
    '"Oh! Good hit! Stored!"',
    '"Excellent power! Thank you!"',
    '"Real force! Fascinating!"',
    '"Strong! You are everything I hoped!"',
  ],

  playerSkillLines: [
    '"A skill! Wonderful! More please!"',
    '"Strong technique! I am analyzing the magic type!"',
    '"Oh that is interesting! Show me again!"',
    '"Excellent! What a fascinating approach!"',
  ],

  drops: [
    'wizard_king_grimoire_shard',
    'chrono_stasis_crystal',
    'time_arrow_fragment',
    'stored_time_rune',
    'temporal_crown_piece',
  ],
}
