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
    version: '3.8.1',
    codename: 'The Wall Answers Back',
    date: '2026-09-18',
    notes: [
      'Bosses now answer the strongest accounts. If you have vastly outgrown a floor, its master meets you with the health to outlast a three hit blitz, a little more armor, and a harder swing, all tuned so the fight lands on a real run of hits instead of ending in two or three. If you are still climbing on curve, every boss fights exactly as it always did: this only ever wakes up for a player who was already steamrolling it, and it never touches anyone who is not.',
      'Swarm monsters got the same treatment. For an overpowered climber the pack now survives long enough to close in from every side and hit hard from each of them at once, so a floor full of enemies is a real threat again instead of falling in a single swing. On curve players see the same swarm they always did.',
      'Reverie has new art, and the two sisters finally have their story. They were born human, both of them. One was offered the role of a god and said yes, and that is Reverie. The other set out to be an adventurer instead, and that is Montana.',
    ],
  },
  {
    version: '3.8.0',
    codename: 'The Stopped Clock',
    date: '2026-09-18',
    notes: [
      'Two sisters join the roster, and neither one is ever for sale. Reverie holds time itself. Once she is equipped, any fight, dungeon, boss or duel lets you stop the clock with .tms: the enemy freezes where it stands and loses its next three moves while you act alone in the stillness, once per battle and no MP. Spin for her with gems.',
      'Montana is Reverie\'s opposite number, and she needs no command at all. Equip her and she fights on her own. She hits exactly as hard as you do, and the instant a freeze, a burn, a stun or any hold at all lands on you she tears you straight back out of it before it can settle. Spin for her with solars.',
      'The sisters answer each other. If anyone stops time on a fighter who has Montana at their side, she moves faster than the frozen moment, shrugs off the stop entirely, and strikes the one who dared it right back. Neither sister can be bought at any price: they come from the spin and nowhere else.',
    ],
  },
  {
    version: '3.7.0',
    codename: 'Close Quarters',
    date: '2026-09-17',
    notes: [
      'Swarm dungeon fights are directional now. The pack closes on you from your left, your right, and right on top of you, and a plain attack no longer swings at all. Read the field and strike the side they are on: .al hits the monster on your left, .ar hits the one on your right.',
      'A monster that gets right on top of you cannot be caught by a side swing. Step off its lane with .ml or .mr to line it up, then strike. Swing into an empty side and you cut only air and still lose the turn, so where you stand and which way you swing both matter now.',
      'Fixed a run of battle commands that were being blocked mid-fight: Naruto\'s Nine Tails summon (.kurama), Red Rose\'s Puppet Strings (.puppet), and the party versions of the Nine Tails and Gojo moves all work inside dungeons, swarm floors and boss fights again.',
      'Ordinary monster fights read with more life now. A plain dungeon fight used to print the same few lines every turn, and it now draws its hits, misses, crits, absorbs and the monster\'s counter from a wide pool of lines, so no two turns read quite the same. Boss fights and their scripted words are unchanged.',
      'The season dungeon remembers how far you climbed. It used to send you back to Floor 1 every time you entered even though your real progress was higher, and it now resumes from the deepest floor you have actually cleared, so a season run picks up where you left off.',
      'The Study in your home now pays out the Experience it promises. Its bonus was being counted everywhere it was displayed but never added to a kill, and every home Experience bonus, the Study and the Library both, now lands on the Experience you earn from a fight.',
      'You can lend solars to each other on a written contract now. Draw one up with .loan offer, naming the amount, how many days they get, and the interest, and nothing moves until they accept it. The moment they do, the solars are theirs and the clock starts, and they pay it back whenever they like with .loan repay. If a loan runs past its due date the debt does not just vanish: the lender can collect it straight out of the borrower\'s wallet with .loan collect, again and again until it is cleared, so a loan is a promise the borrower is held to. Check what you owe and what is owed to you with .loan.',
    ],
  },
  {
    version: '3.6.0',
    codename: 'Baryon Mode',
    date: '2026-09-16',
    notes: [
      'A new fighter joins the roster: Naruto Uzumaki in his Baryon Mode. He is built for speed and raw hitting power, one of the fastest and hardest strikers you can field. Spin for him with gems, or buy him outright for 5 monds.',
      'Once he is equipped, any fight lets you call the Nine Tails to your side with a single command. The summon lands one overwhelming strike and tears away a slice of whatever it hits, health that no armour can save. It costs Naruto some of his own health to hold the fusion, so it can never be spammed, and it can be used once per battle with no MP.',
      'Kurama fights alongside you everywhere it matters: solo dungeon runs, the floor 100 masters, party dungeons and duels. Naruto has his own words for each of them.',
    ],
  },
  {
    version: '3.5.4',
    codename: 'Last Stand',
    date: '2026-09-16',
    notes: [
      'Boss fights are now do or die. While you face one of the floor 100 masters you cannot open a shop, you cannot clear your battle to slip away for free, and you cannot swap your skill slots or train. Only your battle moves work. Win it or fall.',
      'No one can get stuck on a boss any more. If you leave your turn sitting for 5 minutes the master strikes you down and the fight is lost, so an unanswered boss can never trap you.',
      'Losing to a boss now sets your climb back 10 floors on top of the usual fall. Your saved progress in that tower drops by ten, so a defeat at the summit costs you real ground.',
    ],
  },
  {
    version: '3.5.3',
    codename: 'Fresh Climb',
    date: '2026-09-15',
    notes: [
      'The dungeons bite back. Monsters on every floor are a little tougher now, taking an extra hit to bring down and hitting a touch harder, so a floor is a real fight again and not a single tap. Bosses are unchanged.',
      'Dungeon progress has been reset for everyone. Your floors and conquered towers are cleared, and every tower past the first is locked again until you conquer the one before it, the same climb as your first time through. Your level, gear, characters, solars and everything else are untouched. Time to climb again.',
    ],
  },
  {
    version: '3.5.2',
    codename: 'Center Stage',
    date: '2026-09-15',
    notes: [
      'Boss fights now play out like a scene. When you face one of the floor 100 masters, their words and their moves arrive one line at a time, the way their entrance already does, and each turn closes on a small card carrying both health bars and your menu instead of the usual battle picture. The whole of their attack is shown now, not just its opening line. Win or fall, and the master speaks their full closing piece, one line at a time, before the rewards or the death notice. Ordinary monster fights, swarms and duels look exactly as they did before.',
    ],
  },
  {
    version: '3.5.1',
    codename: 'Fair Play',
    date: '2026-09-14',
    notes: [
      'A fix for duels. Final Form was only ever built for fights against monsters, so in a duel it now bows out cleanly instead of misfiring. Mei can no longer slip a free heal and power up into a duel through it, and nothing changes for dungeons, bosses and swarms, where it works exactly as before.',
    ],
  },
  {
    version: '3.5.0',
    codename: 'Signatures',
    date: '2026-09-14',
    notes: [
      'Season Packs arrive: gem bought loadouts you carry into any fight. Each pack is an armor set named for its theme, some with a matching weapon, a title beside your name, and one signature power that is live only while the pack is worn. The Space Sifter phases clean out of hits, the Red Monster hits harder the closer it is to death, the Dark Monarch drains life from every blow it lands, the Knights of the Sicilian answer a hit with a counter, the Gemstone sets anyone who strikes it alight in blue fire, Arlnord the Divine slips almost everything thrown at it, and the Totem Pack scours you clean and refills your mana the instant a death save relic drags you back. Browse them with .pack, then buy or switch with .pack buy and .pack equip. Prices run from 50 to 150 gems.',
      'The weekly Premium plan now comes with a spin at one of five one of a kind abilities, and each one can only ever be won once in the whole game. Freeze Touch, Heat Blaze, Night Eyes, Daylight Ring and Jack of All Trades all punish whoever strikes you, and four of them also carry a once a battle move you can call in any fight, dungeon or duel, with .freezeup, .heatwave, .nighteyes and .daylight. The weekly plan is now 2,500 naira.',
    ],
  },
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
