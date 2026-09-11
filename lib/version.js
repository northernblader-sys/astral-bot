/**
 * version.js — the bot's single version stamp and its release notes.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  BUMP THIS EVERY TIME THE BOT SHIPS. Add a new entry at the TOP of   │
 * │  CHANGELOG, never edit a released one. That is the whole ritual.     │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Which number moves:
 *   PATCH  3.0.0 → 3.0.1   fixes, balance passes, copy, tuning
 *   MINOR  3.0.1 → 3.1.0   a new command, character, page or system
 *   MAJOR  3.1.0 → 4.0.0   a new pillar, or anything that changes save shape
 *
 * `notes` is PLAYER-FACING: it renders verbatim in `.version`, so write it the
 * way a player reads it and keep the no-dash rule (commas, colons, periods).
 * Internal refactors that change nothing a player can see belong in a patch
 * bump with one honest line, or no entry at all.
 *
 * Everything before 3.0.0 predates this file and is deliberately not itemized.
 * The bot already had seasons, cards, the empire pillar, 200+ commands and the
 * website by then; inventing a retroactive history would only be a guess.
 */

/** Newest first. CHANGELOG[0] IS the current version. */
export const CHANGELOG = [
  {
    version: '3.4.0',
    codename: 'Puppet Strings',
    date: '2026-09-10',
    notes: [
      'A new spin character joins the roster: Red Rose, and her Puppet Strings. Once a battle, no mana, she takes the strings and the enemy turns its own weapon on itself, then hangs tangled and loses its next move. In a duel the strings catch their companion too. She never cuts all the way down, so it swings a fight, it does not end one on a single button. Spin for her with .red-rose-spin, equip her, then cut the strings in any fight, dungeon or duel, with .puppet.',
      'Signing in by your character name on the website works again, and replies come back faster across the board.',
    ],
  },
  {
    version: '3.3.4',
    codename: 'Failsafe',
    date: '2026-09-09',
    notes: [
      'More of the quiet multi line groundwork, this time the safe write path itself. When the same character is touched from two places at once, each change is checked in and retried so nothing you earned can be quietly overwritten. It stays switched off until the rest of the pieces land, so nothing changes in how you play today.',
    ],
  },
  {
    version: '3.3.3',
    codename: 'Groundwork',
    date: '2026-09-09',
    notes: [
      'More quiet groundwork under the hood, this time toward letting your character live safely across more than one line at once. Nothing changes in how you play today.',
    ],
  },
  {
    version: '3.3.2',
    codename: 'Clean Sweep',
    date: '2026-09-09',
    notes: [
      'A quiet housekeeping pass under the hood. Nothing changes in how you play, the bot just runs a little leaner behind the scenes.',
    ],
  },
  {
    version: '3.3.1',
    codename: 'Open Floors',
    date: '2026-09-09',
    notes: [
      'Every main dungeon now fights the way the Entry Tower does. Floors 1 to 99 of Gambit\'s Dungeon, Centurion\'s Dungeon, the Astral Tower and the Eternal Dungeon send a small pack at you from more than one side at once, answered with the same swarm moves, while the original master still holds floor 100 at the top of each climb.',
      'The borrowed faces that used to guard the middle floors are gone. From the bottom of a tower to just below its summit you face monsters now, and only the five masters wait at the very top.',
      'The old run layer is retired. There is no sealed kit to pack, no unbanked haul riding on your back, no stalker on your trail, and no bargain offered every few floors. Kills pay straight into your account the moment you make them, potions come from your normal bag, and clearing a floor heals you the same steady amount every time.',
    ],
  },
  {
    version: '3.3.0',
    codename: 'Wild Roads',
    date: '2026-09-08',
    notes: [
      'Pokemon can finally be fought on demand. Wade into the tall grass with .pokehunt to find a level scaled wild Pokemon and battle it turn by turn with .pstrike, and if you win you get a shot at catching it on the spot. No more waiting on a spawn code to ever see a battle.',
      'The Sinnoh League opens as a tower you climb. .poketower puts you against the eight Gym Leaders, then the Elite Four, then Champion Cynthia at the very summit, each master fielding a full team you face one after another while your main is healed between them. Clear a rung once for its reward and unlock the next. Reach the top and the crown is yours.',
      'A quest board arrives. .quest shows a daily set that rotates at midnight for everyone plus a milestone track you chip away at for good, and claiming pays out solars, gems, xp and more. Kills, floors, catches, duels and League wins all count toward it as you play.',
      'The End can be challenged again. Now that the world event has passed, the rift stays open on the map for anyone who wants to test themselves against the boss. It is a practice bout only, no spoils, and it never wakes the aura or the world again.',
      'Close calls in swarm dungeon fights read like near misses now. A dodge that barely lands, a strike that grazes you by a hair, all of it comes through in the moment instead of a flat damage line.',
    ],
  },
  {
    version: '3.2.0',
    codename: 'Tower Masters',
    date: '2026-09-07',
    notes: [
      'The top of every main tower is now held by an original master, not a borrowed face. Five new bosses take floor 100: Syclila in the Entry Tower, Kikaru in Gambit\'s Dungeon, Celestia in Centurion\'s Dungeon, Bam in the Astral Tower, and Esteria in the Eternal Dungeon.',
      'A master fight is no longer just another battle line. It opens on the master\'s own portrait and their own words, and the damage they deal comes wrapped in what they say as they strike, so the fight reads like a scene you live through instead of a status update.',
      'Each master carries one signature power you have to solve, not simply outlast. Syclila raises a mirror that turns your own strike back on you, Kikaru builds tempo until she blurs out of reach, Celestia weighs you on her scales and passes a verdict, Bam swallows your force and returns it with the tide, and each master higher up the towers hits harder than the last.',
      'Esteria does not fall when you empty her health. She rises again in a second form, colder and stronger, and only then is the climb truly finished.',
      'Every master leaves something behind. Twenty five new trophies drop from the five of them, rarer and worth more the deeper the tower they guard.',
    ],
  },
  {
    version: '3.1.1',
    codename: 'The Swarm',
    date: '2026-09-07',
    notes: [
      'Entry Tower fights are no longer one monster at a time. Its floors now send a small pack at you from more than one side at once, and you answer them with new moves.',
      'Monsters wind up before they strike, and you see the warning a full turn ahead. Cut the winder down, step out of its lane, or dodge before it lands. Stand still and the whole pack winds up on you at once.',
      'Two new steps, .ml and .mr, slide you one lane left or right. A monster already committed to its swing cannot re-aim, so a well timed step makes its blow whiff clean.',
      'The new .dodge reads the entire incoming volley. Time it right and you slip all of it, a beat too late and it only grazes you for a fraction of the hit.',
      'Every tenth floor is now held by an apprentice of the sword, a tougher champion flanked by escorts, on the way up to Asta at the top.',
      'The rest of the tower and every other dungeon play exactly as before. This is an Entry Tower change for now.',
    ],
  },
  {
    version: '3.1.0',
    codename: 'The Climb',
    date: '2026-09-05',
    notes: [
      'Every main dungeon is now 100 floors instead of 1000, with a champion waiting every 10 floors and that place\'s true master on floor 100. Nothing was thrown out, the ten champions each dungeon already had simply sit at their proper depth now, so the climb has an ending you can actually see and reach.',
      'Checkpoints moved to every 10 floors to match, so a run you lose costs you less ground.',
      'Regular monsters were rebalanced from the ground up, and this is the big one. They used to be measured against an imaginary character wearing nothing, which is why a properly equipped player could not be killed by anything smaller than a boss no matter how deep they went. Depth now genuinely means danger: near the surface a monster needs about a dozen hits to put you down, and at the bottom of a dungeon it needs a handful.',
      'Fights are much shorter in both directions. A monster used to take 14 to 37 attacks to grind down, which was slow rather than hard. One now costs 3 to 5 attacks, so a floor is a fight and not a chore.',
      'Elites are a real spike now instead of a 15% reskin, and they hit harder and hold on longer than the pack around them.',
      'Monsters keep their own character. Their numbers no longer set their power, they set their shape, so a creature built to hit hard hits harder and gives up bulk for it, and a creature built like a wall does the reverse.',
      'Kill rewards were re-anchored to the new pace. Winning fast still pays the most, but the window moved, so beating a monster in two turns is now the thing that earns full value.',
      'Armour on deep monsters is capped so it can no longer reach the point where your attacks stop meaning anything.',
    ],
  },
  {
    version: '3.0.2',
    codename: 'Fusion',
    date: '2026-09-05',
    notes: [
      'Signing in on the website finds the character you already play. Almost every account is keyed by an internal WhatsApp id that shares no digits with your phone number, so when the site could not look that id up it decided you were brand new and offered to make you a fresh character. It now remembers your number from your normal chat messages, so it can find you without asking WhatsApp anything.',
      'If your account genuinely cannot be confirmed at the moment you sign in, the site says so and stops. Before, it would offer to create a second character on top of your real one.',
    ],
  },
  {
    version: '3.0.1',
    codename: 'Fusion',
    date: '2026-09-05',
    notes: [
      'Group moderation no longer switches itself off when WhatsApp throttles the bot. Antilink, group lock and mute used to go quiet for minutes at a time without saying anything, and they hold now.',
      'The bot asks WhatsApp for group details far less often, which is what was getting it throttled in the first place.',
      'Fixed the backup doing a full round trip to the cloud on every single command instead of once at startup. Nothing changed about your data, it is just work the bot was repeating for no reason.',
    ],
  },
  {
    version: '3.0.0',
    codename: 'Fusion',
    date: '2026-09-04',
    notes: [
      'Gogeta is a true one of one. The first winner bot wide closes his banner for everyone else, and anyone who spins after that is refused before a single gem is charged.',
      'You can spin for him on the website now, on the season page, at the same odds and the same cost the chat command uses.',
      'Premium and gem prices on the website read in US dollars. Nothing changed about paying: the charge is still naira, and every card shows the naira amount you send.',
      'This command, so you can tell at a glance which build you are talking to.',
    ],
  },
]

export const BOT_VERSION = CHANGELOG[0].version
export const VERSION_CODENAME = CHANGELOG[0].codename
export const VERSION_DATE = CHANGELOG[0].date

/** '2026-09-04' → '4 Sep 2026'. Falls back to the raw string if unparseable. */
export function formatVersionDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** "v3.0.0 (Fusion)" for a log line or a one-line header. */
export function versionLabel() {
  return `v${BOT_VERSION}${VERSION_CODENAME ? ` (${VERSION_CODENAME})` : ''}`
}
