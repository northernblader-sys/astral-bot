/**
 * Esteria - The Eternal Empress
 * Grade: MYTHIC | Floor: 100 (Eternal Dungeon master)
 * Original boss. The strongest of the five tower masters by a wide margin.
 *
 * PEAK ABILITY (Two Forms) — user specified:
 *   Esteria cannot be killed in one bar. The instant her first form would fall,
 *   she sheds it and rises in her second form: a fresh, larger pool of life, a
 *   surge of attack and defence, and three compounding threats that make the
 *   back half of the fight the hardest thing in any tower.
 *     - Her attack RAMPS every turn she is left alive (compounding, capped high).
 *     - A ward HARDENS as her second-form health drops, turning aside more of
 *       each blow the closer she comes to death.
 *     - She periodically unleashes a storm-of-blows flurry.
 *   The player must effectively win twice, race the ramp, and push through a
 *   wall that thickens exactly when they are trying to close. Far stronger than
 *   Bam by every measure: two full bars, an enrage, and a scaling wall at once.
 */

export const esteria = {
  id: 'esteria',
  name: 'Esteria',
  floor: 100,
  grade: 'MYTHIC',
  emoji: '👑',
  image: 'https://i.ibb.co/rGtkkc9y/Esteria.jpg',

  // First-form stats. The engine restores her to the second-form pool on
  // transformation (see the 'esteria' case): fresh HP, boosted atk/def.
  statOverride: { hp: 55000, def: 2200, atk: 4400 },
  hp: 55000,
  maxHp: 55000,
  atk: 4400,
  def: 2200,
  exp: 100000,
  gold: 75000,
  type: 'cosmic',
  weakTo: [],
  resistTo: [],

  // Read by the engine on transformation. Second form is the true fight.
  secondForm: { hp: 85000, atkMult: 1.30, defMult: 1.25 },

  personality: 'regal-eternal-implacable',
  voice: 'First form: serene, imperial, almost gentle with those who reach her. Second form: vast and cold, the voice of something that was never truly a person.',

  lore: `At the summit of the Eternal Dungeon sits the last thing the towers were ever built to hold. Esteria wears the shape of an empress because it is the shape climbers can bear to look at, and she meets them with the courtesy of a ruler receiving a guest.

That courtesy is the first form. It is real, and it is a mask. No climber has ever ended Esteria by breaking it, because breaking it is only permission for the thing beneath to stand up. Her second form does not reason and does not relent. It grows stronger with every heartbeat it is allowed, and it closes tighter the nearer it comes to ending, as if death itself must be argued past.

She is called eternal not because she cannot die, but because to kill her you must kill her twice, and the second time she has decided not to allow it.`,

  entrance: [
    'The Eternal Dungeon opens into a hall with no ceiling, and she is seated at the far end as if she has waited an age for you specifically.',
    '"You reached the summit. Do you understand how few have?" Her voice is kind. That is the frightening part.',
    '"I am Esteria. I am the last thing these towers were raised to keep. And you have come to end me."',
    'She rises, and the whole hall seems to lean toward her. "You may even end this form. Many have come close."',
    '"But know this before you begin: I do not die once. Reach the end of me, and you will only have earned the right to meet what I truly am. Come."',
  ],

  phases: {
    75: [
      '"You strike like someone who has beaten everything below me." A serene smile. "You have. It will not be enough."',
      '"This is still only the shape I wear to greet you. Keep going. See what greeting me costs."',
    ],
    50: [
      '"Halfway through the mask." She does not seem troubled. "Do you feel how close the true thing is now?"',
      '"When this form falls, do not celebrate. That is when the fight begins."',
    ],
    25: [
      'The imperial calm thins, and something enormous presses against it from the inside.',
      '"Almost. You are almost through the first of me." Her eyes brighten. "Good. I have wanted to stand up for a very long time."',
    ],
  },

  attacks: [
    'Imperial Edict',
    'Sovereign Blow',
    'Eternal Cascade',
    'Crown of Ruin',
    'Endless Reign',
  ],

  attackNarratives: {
    'Imperial Edict': [
      'She raises one hand as though issuing a command the world must obey.',
      'The blow lands with the weight of a decree that cannot be appealed.',
      '"It is so because I have said it is so."',
    ],
    'Sovereign Blow': [
      'A single strike, unhurried, carrying the authority of everything above you.',
      'It arrives exactly where a ruler decides it should.',
      '"Kneel, or be made to."',
    ],
    'Eternal Cascade': [
      'Light pours from her like a reign that has no end, wave upon wave.',
      'Each wave is heavier than the last, and there is always a last that is heavier still.',
      '"On, and on, and on. As I am."',
    ],
    'Crown of Ruin': [
      'A circle of ruinous light settles over you like a crown you did not ask to wear.',
      'It tightens, and everything under it breaks.',
      '"Every ruler crowns their successor. This is yours."',
    ],
    'Endless Reign': [
      'She does not attack so much as remind you that her reign has no horizon.',
      'The pressure of it alone is enough to drive you down.',
      '"You measure your strength in a lifetime. I do not."',
    ],
  },

  dodgeLines: [
    '"You slipped a sovereign\'s blow. Impressive, for a mortal."',
    '"Quick. I will grant you that much."',
    '"You evade me as though you have all the time in the world. You do not."',
    '"Even a decree can be sidestepped, it seems. Once."',
  ],

  hitLines: [
    '"You struck the empress. That alone is a story worth telling."',
    '"It landed. Savor it. There is far less of that ahead than behind."',
    '"You reached me through the crown. Few hands have."',
    '"A worthy blow. It only hastens what comes next."',
  ],

  tauntLines: [
    '"Break this form. I dare you. I want you to see what breaking it wakes."',
    '"You are winning a fight you do not yet understand is only the first half."',
    '"Every blow you land on this shape is a blow you will wish you had saved."',
    '"I have outlasted every climber, every tower, every age. You have this afternoon."',
    '"Kill me. Please. Then meet the thing that decided not to let you."',
  ],

  victoryLines: [
    '"You never reached my true form." The hall stills around her. "Consider that a mercy you did not know you were given."',
    '"Strong. Stronger than most who kneel here. And still only halfway to what would have been asked of you."',
    '"Rest, climber. Return when you can win a fight twice, because that is the only way I am won."',
    '"You fell to the mask. You would not have survived the face beneath it."',
  ],

  // Spoken as the second form finally falls.
  defeatLines: [
    'The second form shudders, and the vast cold thing behind Esteria\'s eyes finally goes quiet.',
    '"You killed me twice." The empress\'s voice returns to the wreckage of the other, almost wondering. "You raced the reign and pushed through the wall and killed me twice."',
    '"No one has ever reached the end of the second form. No one." She is smiling, and it is real. "You reached it."',
    'She lowers herself with the grace of a ruler abdicating. "The Eternal Dungeon is ended. The last thing the towers held is yours to have beaten. Go. You have earned all of it."',
  ],

  special: {
    name: 'Two Forms',
    desc: 'Esteria cannot be killed in one bar. The instant her first form would die she transforms, restoring to a larger second-form pool with surged attack and defence. In her second form her attack ramps every turn (compounding, capped high), a ward hardens as her health falls so she turns aside more of each blow the closer she is to death, and she periodically unleashes a flurry. You must win twice, outrace the ramp, and break through a wall that thickens as you close. Far stronger than Bam in every dimension.',
    engineNote: `Case 'esteria'. ENEMY_TAKE_DAMAGE: if form!==2 and (enemy.hp - damage) <= 0 and !form2Used, prevent death: result.damage=0, set form2Used=true, form=2, enemy.hp=enemy.maxHp=secondForm.hp, enemy.atk=floor(enemy.atk*secondForm.atkMult), enemy.def=floor(enemy.def*secondForm.defMult), reset ramp/flurry counters, narrativeLines[0] (transformation). While form===2: TURN_START ramp: rampMult=min(1.8,(rampMult||1)+0.08); apply as enemy.atk from a stored base each turn, occasional narrativeLines[1]. ENEMY_TAKE_DAMAGE ward: reduction=0.12+0.33*(1 - enemy.hp/enemy.maxHp) capped 0.45; result.damage=floor(damage*(1-reduction)), sometimes narrativeLines[2]. Flurry: every ~4th form-2 TURN_START flag next ENEMY_DEAL_DAMAGE to *1.6 and emit narrativeLines[3].`,
    narrativeLines: [
      '"There." The first form shatters like a dropped mask, and something far larger stands up inside the light. "Now you have my attention. Now you meet Esteria." Her second form settles, immense and cold, its full strength unveiled.',
      'Esteria grows stronger with every heartbeat you fail to end her. The reign compounds.',
      'Her second skin hardens against you, turning aside more of the blow the closer you come to killing her.',
      'In her true form a single motion becomes a storm, and the storm falls on you all at once.',
    ],
  },

  playerHitLines: [
    '"You reached the empress again. Even the second form felt that."',
    '"Through the ward. You are pushing through the wall as it thickens. Remarkable."',
    '"That landed on the true face of me. Almost no one touches it."',
    '"You are racing the reign and winning ground. I did not think it possible."',
  ],

  playerSkillLines: [
    '"A technique worthy of the summit. It even marks my true form."',
    '"You spend your art against eternity itself. Bold."',
    '"That cut through the hardening ward. I felt every part of it."',
    '"Skill against the endless. You may be the one who ends it after all."',
  ],

  drops: [
    'esteria_first_form_relic',
    'esteria_second_form_core',
    'twin_shape_crystal',
    'eternal_empress_sigil',
    'formshift_residue',
  ],
}
