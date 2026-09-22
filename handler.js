import { logger, config } from './config.js'
import { gifSourceToVideo } from './lib/converter.js'
import { normalizeMessageContent } from '@whiskeysockets/baileys'
import { dispatch, suggestCommand, getRegistry } from './lib/plugin-manager.js'
import { incrementCommandCount } from './lib/server-stats.js'
import { getPlayer, savePlayer, updatePlayer, refreshPlayerFromCluster } from './lib/player-repo.js'
import { wakeIfDue } from './lib/sleep-engine.js'
import { applyHungerTick, isCollapsed, collapseMessage } from './lib/hunger-engine.js'
import { applyEndEventTick, END_SLEEP_MSG } from './lib/end-event.js'
import { formatTimeLeft } from './lib/time-format.js'
import { getGroupSettings, isGroupOrBotOwner, isGroupOrBotOwnerOrMod } from './lib/group-settings.js'
import { isOwnerJid } from './lib/group-helpers.js'
import { getBan, unbanUser, banExpired } from './lib/ban-repo.js'
import { isMod } from './lib/mod-repo.js'
import { isNightMode, shouldNotifyNight, nightNotice } from './lib/night-mode.js'
import { getJailRecord, releasePlayer } from './lib/jail-repo.js'
import { hasAwaitingScreenshot, handlePendingScreenshot } from './lib/pending-purchase.js'
import { hasOpenUnbanAppeal, handleUnbanFormImage } from './lib/unban-appeal.js'
import { hasPendingStoryChoice, handleStoryChoiceReply } from './plugins/story.js'
import { extractButtonReplyId } from './lib/interactive-buttons.js'
import { isPremiumActive } from './lib/premium.js'
import { resolveOverflowNotice, inventoryOverflow } from './lib/inventory-limits.js'
import { storageCap } from './lib/housing-engine.js'
import { getActiveSpawn } from './lib/card-spawn-state.js'
import { awardPetCommandSolars } from './lib/pet-bond.js'
import { touchDungeonActivity } from './lib/dungeon-slots.js'
import { petMap, allItems } from './lib/game-data.js'
import { isLiveBossFight } from './lib/boss-engine.js'
import { BOSS_TURN_TIMEOUT_MS, resolveBossTimeoutLoss } from './lib/combat-handlers.js'
import { runModerationScans, handleRevocation } from './lib/moderation-scan.js'
import { runAfkScan } from './lib/afk-scan.js'

// Commands still reachable in a locked DM even though the sender isn't the
// owner — buying Premium/gems/Monds and checking status must work for everyone,
// not just people the owner has already DM'd first. The Mond commands and
// `.character` are here so the whole buy-a-character-with-Monds flow works in a
// DM: `.monds buy` for the currency (the plugin is DM-only by design anyway),
// `.character buy` to spend it. Story Mode is a DM-only feature by design (see
// plugins/story.js), so it needs the same exemption, as does the unban appeal
// (plugins/unban-me.js) — a banned user has nowhere else to start one.
const DM_ALLOWED_COMMANDS = new Set(['premium', 'vip', 'topup', 'gems', 'buygems', 'code', 'mycode', 'linkcode', 'connectcode', 'season', 'seasons', 'seasoninfo', 'gm', 'gameshop', 'unban-me', 'unbanme', 'appeal', 'monds', 'mond', 'buymonds', 'mondshop', 'character', 'characters', 'char'])

// Commands that survive EVERY lockout gate below (ban, jail, inn sleep,
// mid-battle). `unban` so an admin/owner near a banned user can always reverse
// a ban, and the `.unban-me` appeal trio (name + aliases, see
// plugins/unban-me.js) so the person themselves has a way back in — a ban that
// blocks its own appeal route leaves the user with nothing but silence, and
// "you were banned while asleep at the inn" must not become a dead end either.
const LOCKOUT_EXEMPT_COMMANDS = new Set(['unban', 'unban-me', 'unbanme', 'appeal'])

// How often the "your bag is over the limit" notice may repeat on a player's own
// commands while their 48h grace runs. Long enough not to be spam, short enough
// that nobody can claim they were never told before items moved.
const OVERFLOW_WARN_COOLDOWN_MS = 6 * 60 * 60_000

// ── Utility commands: never gated by your character's body ─────────────────
// The three body-state lockouts — sleeping at the inn, collapsing from hunger,
// and the End's deep sleep — all model your CHARACTER being unable to act. None
// of them has any business stopping you using the bot AS A BOT: `.song` pulls a
// track off YouTube, `.sticker` converts an image, `.dload` fetches a video,
// `.menu` prints a list, `.gcsettings` configures a group. Your character is not
// involved in any of that, so "you're asleep" / "you're starving" is a nonsense
// answer to it — and for `.song`, which people use constantly, it turned a
// music bot into one that refuses to play music until you eat.
//
// Keyed off the plugin's own `category`, so a newly added utility or group
// command inherits the right answer without anyone remembering this file exists:
//
//   utility   moderation toggles, group config, .song, downloaders, diagnostics
//   media     .dload / .manga / .manhwa readers
//   group     the group directory (submit/join/leave/gclist/...)
//   admin     owner and mod tooling — a starving owner must still be able to ban
//
// Everything else stays gated. Categories like town/combat/economy/inventory ARE
// your character acting in the world, which is exactly what these lockouts are
// for.
const NON_RPG_CATEGORIES = new Set(['utility', 'media', 'group', 'admin'])

// The handful of bot-plumbing commands that declare no category at all, so the
// category test above can't reach them. Account linking in particular must work
// while asleep: it's how you attach a Discord/Telegram account in the first place.
const NON_RPG_COMMANDS = new Set([
  'discord-link', 'telegram-link', 'whatsapp-link', 'pfp', 'cleanup',
])

/**
 * True when `cmd` is a bot utility rather than an action your character takes,
 * and so must survive the inn-sleep, hunger-collapse and End-sleep lockouts.
 * Exported so the gate can be tested against the real plugin registry.
 */
export function isNonRpgCommand(cmd, platform = 'whatsapp') {
  if (LOCKOUT_EXEMPT_COMMANDS.has(cmd)) return true
  if (NON_RPG_COMMANDS.has(cmd)) return true
  const category = getRegistry(platform).get(cmd)?.category
  return !!category && NON_RPG_CATEGORIES.has(category)
}

// ── Hunger collapse gate ───────────────────────────────────────────────
// A player who starves to 0 stamina is COLLAPSED (lib/hunger-engine.js
// isCollapsed): too weak to act. Starvation no longer kills or costs stats —
// collapsing is the whole penalty — so the lockout has to be real, but it must
// never be a softlock, and it must never stop someone using the bot AS a bot.
//
// This was an ALLOWLIST of ~30 command names, which meant the other ~180
// commands were all refused: .song, stickers, cards, group admin, banners,
// spins, trading — none of which have anything to do with your character's
// body. Starving should stop you EXERTING yourself, not stop you talking. So
// it is a blocklist now, and the default answer is "yes, that still works".
//
// The primary key is the plugin's own `category`, so a newly added combat or
// dungeon plugin inherits the right answer without anyone having to remember
// this file exists. COLLAPSE_BLOCKED_COMMANDS then names the individually
// strenuous commands that live inside an otherwise-harmless category (you
// cannot swing a pickaxe on an empty stomach; you can still browse the shop).
//
// Not gated: battle commands. If a player collapses mid-fight the battle gate
// below already governs which commands work, and locking them out there would
// trap them in a battle they can't finish, flee, or eat their way out of.
const COLLAPSE_BLOCKED_CATEGORIES = new Set([
  'combat',    // swinging a weapon, summoning, ultimates
  'dungeon',   // entering a dungeon (travel is exempted below)
  'pvp',       // duels and tournaments (pvpstats/scout exempted below)
  'party',     // party combat
])

// Strenuous commands sitting in a category that is otherwise fine to allow.
const COLLAPSE_BLOCKED_COMMANDS = new Set([
  'mine', 'craft', 'roam',        // town, but physical labour
  'fish', 'farm',                 // housing, but physical labour
  'work', 'farmhand', 'rob',      // economy, but physical labour
])

// Wins over both lists above. Two kinds of thing live here: the route OUT of
// the collapse, and anti-softlock escape hatches.
//
// `travel` is the important one. It is category `dungeon` and so would be
// blocked, but the way out of a collapse is food or a bed, and both are in
// Astral Town — a player who collapsed anywhere else would have no way to
// reach either. The END deep-sleep gate below exempts travel for the same
// reason. Entering a dungeon (`dungeon`/`enter`) stays blocked: you can drag
// yourself back to town, you just can't go hunting.
const COLLAPSE_ALWAYS_ALLOWED = new Set([
  // the way out
  'eat', 'feed', 'consume',
  'cook', 'cookbook', 'recipes', 'recipe', 'cookshop',
  'shop', 'buy', 'gm', 'gameshop',
  'inn', 'rest', 'sleep', 'wake',
  'heal', 'use',
  // drag yourself somewhere that has food or a bed
  'travel',
  // read-only reference
  'profile', 'inventory', 'inv', 'stats', 'stat', 'balance', 'bal', 'wallet',
  'menu', 'help', 'ping', 'hunger', 'pvpstats', 'scout',
  'combat', 'battle',                                       // combat command reference
  'gambits', 'variations', 'openings', 'gambit', 'lines', 'book',  // the duel-line book
  'dragon', 'mydragon',                                     // read-only, only ever replies
  // loadout, not exertion — `.equip` is allowed, so its beast equivalent is too
  'equipbeast', 'setbeast', 'activebeast',
  // remedial, not offensive
  'curetear',
  // escape hatch — a broken battleState must never be unfixable
  'cb', 'clearbattle', 'resetbattle', 'unstuck',
])

/**
 * True when a collapsed (0-stamina, starving) player may not run `cmd`.
 * Default is ALLOW: anything that isn't recognisably strenuous still works.
 * Exported so the gate can be tested against the real plugin registry.
 */
export function isCollapseBlocked(cmd) {
  if (COLLAPSE_ALWAYS_ALLOWED.has(cmd)) return false
  if (isNonRpgCommand(cmd)) return false
  if (COLLAPSE_BLOCKED_COMMANDS.has(cmd)) return true
  // 'whatsapp' explicitly: this file only ever runs on WhatsApp, and in combined
  // mode (main-all.js) the registry's default platform is whatever the process
  // booted as, which is not necessarily this one.
  const category = getRegistry('whatsapp').get(cmd)?.category
  return !!category && COLLAPSE_BLOCKED_CATEGORIES.has(category)
}

// ── Music-only group gate ──────────────────────────────────────────────
// `.music on` (plugins/musicmode.js) turns a group into a music-listening
// room: for regular members, ONLY the music command (.song/.mp3) and the
// group-directory commands (category 'group': submit/join/leave/gclist/...)
// run — everything else is refused. Group admins/mods bypass (checked at the
// call site so the async admin lookup is only paid on a would-be block), and
// the bot owner never reaches the gate at all (isOwnerJid short-circuits it).
// Keyed off the plugin's own category so a new group command is covered here
// without editing this list. LOCKOUT_EXEMPT_COMMANDS (ban appeals) always pass.
const MUSIC_MODE_ALLOWED_COMMANDS = new Set([
  'music',        // the toggle itself — an admin must always be able to run `.music off`
  'song', 'mp3',  // the YouTube-audio downloader (plugins/music.js)
])
export function isMusicModeAllowed(cmd) {
  if (MUSIC_MODE_ALLOWED_COMMANDS.has(cmd)) return true
  if (LOCKOUT_EXEMPT_COMMANDS.has(cmd)) return true
  return getRegistry('whatsapp').get(cmd)?.category === 'group'
}

// ── The End: deep-sleep gate ───────────────────────────────────────────
// During the Blue Band event (lib/end-event.js) a weak, unbanded player is
// dragged into the End's deep sleep and locked out of almost everything — the
// same shape as the hunger collapse gate above. Everything on this list is the
// self-rescue path or read-only reference, so a sleeper always has a route
// back onto their feet:
//   • shop/buy — beg the old woman in Astral Town for a Blue Band
//   • answer   — answer her riddle ("no")
//   • equip    — put the band on for good once you hold one
//   • travel/enter — a WRONG answer bars her door until you leave town and
//     return, so movement MUST stay reachable or the sleeper softlocks with no
//     way to re-ask (this is the "go to a dungeon and back" mechanic itself)
// Battle commands are deliberately absent: like collapse, an inBattle player is
// exempt from the gate entirely (below) so the aura can never trap someone
// mid-fight with no way to finish or flee.
const END_SLEEP_ALLOWED_COMMANDS = new Set([
  // the way out — get a Blue Band and put it on
  'shop', 'buy', 'gm', 'gameshop',
  'answer',
  'equip', 'unequip',
  // self-rescue movement (see note above)
  'travel', 'enter',
  // read-only reference / status
  'profile', 'stats', 'stat', 'inventory', 'inv', 'balance', 'bal', 'wallet',
  'event', 'menu', 'help', 'ping',
  // escape hatch — a broken battleState must never be unfixable
  'cb', 'clearbattle', 'resetbattle', 'unstuck',
])

// ── Battle command gate ────────────────────────────────────────────────
// While a player is mid-battle (player.inBattle === true), only the actual
// battle actions plus a small set of "still need to work" utility commands
// are allowed — everything else (mine, craft, travel, another .enter, etc.)
// is rejected with a reminder instead of silently running or corrupting
// battle state. Buying from the shop is explicitly allowed mid-battle
// (e.g. grabbing a potion) per design.
const BATTLE_ALLOWED_COMMANDS = new Set([
  // core battle actions
  'attack', 'atk', 'a',
  'skill', 'sk', 's', 'sp',
  'defend', 'def', 'd', 'block',
  'flee', 'run', 'escape',
  'useability', 'ua', 'useab',
  // Swarm-fight actions (plugins/al.js, ar.js, ml.js, mr.js, dodge.js). These
  // ARE battle actions: each spends the turn and answers the incoming volley in
  // a swarm fight (battleState.mode === 'swarm'), and a swarm fight sets
  // player.inBattle — so without this line the gate rejected them on every
  // dungeon floor 1-99, the exact place they exist to be used. Same recurring
  // bug the character abilities below each hit. cmd is the raw typed token
  // (handler.js lowercases but does NOT resolve aliases), so every alias is listed.
  // `.al`/`.ar` are the directional basic attacks that replaced the old plain
  // swarm `.a`; a plain `.a` now just reprints the controls and spends no turn.
  'al', 'attackleft', 'ar', 'attackright',
  'ml', 'moveleft', 'mr', 'moveright', 'dodge', 'dg',
  // Wither's once-per-battle move (plugins/cinderverdict.js) — a real battle
  // action, so it has to clear this gate like attack/skill/useability do.
  'cinderverdict', 'cinder', 'cv', 'verdict',
  // Circe's Wild Card (plugins/wildcard.js) — her in-battle combat move (three
  // draws per fight), same shape as cinderverdict above: a real battle action
  // that must clear this gate, or `.wildcard`/`.wc`/`.circe`/`.wild` gets
  // rejected here in a dungeon before ever reaching the plugin. PvP battles
  // don't set player.inBattle, which is exactly why she worked in duels but
  // not dungeons until this line existed.
  'wildcard', 'wc', 'circe', 'wild',
  // The dragon's once-per-battle finisher (plugins/ultimate.js), granted by
  // Nisha's exclusive spin — same shape as cinderverdict above: a real PvP
  // battle action that must clear the gate or `.ultimate` gets rejected here
  // before ever reaching plugins/pvp.js's pvpUltimate().
  'ultimate', 'dragonultimate', 'dragon-ultimate',
  // Megumi's Domain Expansion, Chimera Shadow Garden (plugins/domain-expansion.js)
  // — same shape as cinderverdict/wildcard/ultimate above: a real battle
  // action that must clear this gate, or `.domain-expansion` gets rejected
  // here in a dungeon or boss fight before ever reaching the plugin. Duels
  // don't set player.inBattle, which is why it worked in PvP but nowhere else.
  // `.mahoraga` is the read-only Wheel status card, allowed for the same
  // reason `.profile` is.
  'domain-expansion', 'domain', 'de', 'domainexpansion', 'chimera',
  'mahoraga', 'wheel', 'divinegeneral',
  // Xiao's Thief's Eye (plugins/thiefseye.js) — same shape as
  // cinderverdict/wildcard/domain above: a once-per-battle action that spends
  // the turn and can end the fight, so it must clear this gate or `.thiefseye`
  // gets rejected here in a dungeon or boss fight before ever reaching the
  // plugin. Bosses are the main thing she steals FROM, so leaving it off this
  // list would have made her ability unreachable in the fights it exists for —
  // the identical bug domain-expansion and finalform each had, and for the
  // identical reason: duels don't set player.inBattle, so it would have looked
  // like it worked.
  'thiefseye', 'thiefs-eye', 'steal', 'te', 'mimic',
  'hollowexchange', 'hollow-exchange', 'hollow', 'exchange', 'hx',
  // Gojo's two actives (plugins/purple.js, plugins/domain.js) — the same bug
  // this block has now had five times, and the worst instance of it: BOTH of
  // these plugins refuse a duel outright and are PvE-only, and PvE is the only
  // thing that sets player.inBattle. So unlike Circe and Megumi, they didn't
  // "appear to work in duels" — they were unreachable everywhere, in every
  // monster fight, dungeon and boss fight, from the moment they were written.
  // `.hp` is the short form for Hollow Purple; `.domain`/`.de` are already
  // above for Megumi and route to whichever domain the player has equipped.
  'hollowpurple', 'purple', 'hollow-purple', 'hp',
  'unlimitedvoid', 'unlimited-void', 'void', 'domain-expansion-gojo',
  // Yato's true form (plugins/unwritten.js). Same PvE-only shape as Gojo's two
  // above, so leaving it off here would make it unreachable in every fight it
  // exists for. Unlike Live Blast it has no once-per-battle latch and is meant
  // to be used turn after turn, which makes the gate the ONLY thing standing
  // between it and the player.
  'unwritten', 'unwrite', 'erase', 'uw',
  // Mei's Final Form (plugins/finalform.js) — the transformation is explicitly
  // an in-battle action: it can only be triggered once her HP has dropped below
  // 70% *during a fight*, it spends the turn (processStatusTurn) and it can end
  // the fight (resolvePlayerHpZero). Without this line the gate rejected it in
  // every monster fight, dungeon and boss fight — the identical bug as
  // domain-expansion above, and for the identical reason: it appeared to work
  // because duels don't set player.inBattle.
  'finalform', 'ff', 'transform',
  // Naruto's Baryon Mode summon (plugins/kurama.js) — his once-per-battle Nine
  // Tails finisher. Same recurring shape as every character active above: a real
  // battle action that spends the turn and can end the fight, so it must clear
  // this gate or `.kurama` gets rejected here in a dungeon, swarm floor or boss
  // fight before ever reaching the plugin. Duels don't set player.inBattle, which
  // is why it worked in PvP but nowhere else. Every alias is listed (cmd is the
  // raw typed token, no alias resolution).
  'kurama', 'baryon', 'kuramamode', 'ninetails', 'bijuu', 'krm',
  // Red Rose's Puppet Strings (plugins/puppetry.js) — her once-per-battle turn
  // that turns the enemy's own attack against it and tangles it. The identical
  // latent bug the actives above each hit: it was never on this list, so `.puppet`
  // was rejected mid-fight in every dungeon, swarm floor and boss fight, the only
  // places it exists for. Every alias is listed.
  'puppet', 'puppetry', 'puppetstrings', 'puppet-strings', 'strings', 'marionette',
  // Reverie's Time Stop (plugins/timestop.js) — her once-per-battle freeze that
  // stops the enemy for three of its own moves. Same list requirement as every
  // active above: unlisted means silently rejected mid-PvE. Every alias is listed
  // (Montana needs no entry — she is automatic and has no active command).
  'tms', 'timestop', 'time-stop', 'stoptime', 'reverie-tms',
  // Aizen's two actives (plugins/kurohitsugi.js, plugins/hogyoku.js) — the
  // same recurring shape as the character actives above: each is a real
  // once-per-battle battle action, and PvE (dungeon/boss/swarm) plus duels are
  // exactly the fights they exist for. Every alias is listed because cmd is
  // the raw token (no alias resolution).
  'kurohitsugi', 'kuro', 'blackcoffin', 'black-coffin', 'coffin', 'hado90',
  'hougyoku', 'hogyoku', 'transcend', 'transcendence', 'the-one-above-all',
  // Echidna's two actives (plugins/greed.js, plugins/wisdom.js) — the same
  // recurring shape as every character active above, and it made BOTH of her
  // battle commands dead on arrival in PvE. `.greed` is her once-per-battle
  // tithe: it spends the turn, resolves through the same battleState path as
  // puppetry/wildcard, and tangles the enemy's next turn. `.wisdom` is her
  // in-battle readout (plugins/wisdom.js's whole PvE branch reads
  // battleState.enemy), so it is only ever useful mid-fight. Neither token was
  // on this list, so the gate rejected them in every dungeon, swarm floor and
  // boss fight before the plugin ran. Duels don't set player.inBattle and
  // pvp.js routes `.greed` through its own 'greedtithe' action, which is why
  // she appeared to work in PvP and nowhere else. Every alias is listed
  // because cmd is the raw typed token (no alias resolution).
  // NB: the `.echidna` hub command is deliberately NOT here. Its subcommands
  // are `.echidna ritual` / `child` / `name`, none of which is a battle action,
  // and running the rite mid-fight would mutate house/child state while a
  // battleState is live. `.echidna <message>` is Gemini chat, same as out of
  // battle. She is fought WITH, not managed DURING.
  'greed', 'tithe', 'greedgrab', 'gospel', 'gospelofgreed', 'witchs-grasp', 'stealgreed',
  'wisdom', 'bookofwisdom', 'tome', 'tomeofwisdom', 'read',
  // Willow's in-battle advisory (plugins/willow.js). It hard-requires
  // `player.inBattle && battleState.enemy` and does nothing else, so leaving it
  // off this list didn't merely restrict it — it made the command unreachable in
  // the only situation it exists for. Read-only (it reports matchup advice and
  // costs no turn), so it belongs with `.profile` below rather than with the
  // real battle actions above.
  'willow', 'advise', 'advisor',
  // PvP dispatch command itself — without this, `.pvp attack`/`.pvp defend`
  // etc. get rejected at this gate before ever reaching plugins/pvp.js,
  // even though attack.js's own PvP redirect tells the player to use it.
  'pvp', 'duel',
  // Dungeon-party co-op combat (plugins/party.js as `.dparty`, plus the
  // plugins/pattack.js one-word shortcuts). Party members are flagged
  // inBattle during a party fight, so these must clear the gate or a member
  // couldn't even attack the shared boss.
  'dparty', 'dungeonparty', 'dp', 'coop',
  'pattack', 'pa', 'pdefend', 'pd', 'pflee', 'pcv', 'pcinder',
  // The rest of the plugins/pattack.js one-word shortcuts — the party forms of
  // the character actives. Same gate, same reason as the line above: they were
  // missing here, so a party member's `.pk`/`.php`/`.puv` was rejected before it
  // could touch the shared boss. Kept in lockstep with pattack.js's alias list.
  'pk', 'pkurama', 'php', 'phollowpurple', 'puv', 'pvoid', 'punlimitedvoid',
  // Premium-only ability actives (plugins/freezeup.js, heatwave.js, nighteyes.js,
  // daylight.js — gifted with a monthly Premium, see data/premium-abilities.json).
  // Same recurring shape as the character actives above: each is a real once-per-battle
  // battle action, and PvE (dungeon/boss/swarm) is the only thing that sets
  // player.inBattle, so without this line they'd be unreachable in exactly the fights
  // they exist for. Every alias is listed because cmd is the raw token (no alias resolution).
  // NB: 'night' (plugins/night.js) and 'dl' (plugins/downloader.js) are other
  // commands' tokens, so they're deliberately NOT here — whitelisting them would
  // let those unrelated commands run mid-battle. The ability aliases dodge both.
  'freezeup', 'freeze', 'fu',
  'heatwave', 'heat', 'hw',
  'nighteyes', 'ne',
  'daylight', 'day', 'sunrise',
  // needed utility/reference while fighting
  'shop',
  'gm', 'gameshop',
  'profile',
  'inventory',
  'skillslot', 'skillslots', 'slots',
  'stats', 'stat', 'train',
  'menu',
  'ping',
  // emergency escape hatch — must always pass the gate, otherwise a broken
  // battleState traps the player with no way to reach the one command that
  // fixes it. See plugins/cb.js.
  'cb', 'clearbattle', 'resetbattle', 'unstuck',
])

// ── Boss-fight lockdown ─────────────────────────────────────────────────────
// Inside a LIVE tower-master boss fight (isLiveBossFight), these otherwise
// battle-legal commands are refused: no shopping for potions mid-boss, no `.cb`
// escaping a boss you are losing (it force-clears battle state for free), and no
// re-speccing your loadout. A boss is fight-or-fall. `.cb` is still allowed
// against a CORRUPTED boss state (isLiveBossFight is false there), so a genuinely
// broken fight is never an unbreakable softlock.
const BOSS_FIGHT_BLOCKED_COMMANDS = new Set([
  'shop', 'gm', 'gameshop',
  'cb', 'clearbattle', 'resetbattle', 'unstuck',
  'train', 'skillslot', 'skillslots', 'slots',
])

// Battle-legal commands that do NOT consume a boss turn, so taking one must not
// reset the 5-minute turn clock — otherwise a player could stall their turn
// forever by spamming `.profile`. Pure read-only status only.
const BOSS_TURN_TIMER_EXEMPT = new Set([
  'profile', 'inventory', 'stats', 'stat', 'menu', 'ping', 'willow', 'advise', 'advisor',
])

// Link detection lives in lib/group-helpers.js (containsLink) and is applied by
// the antilink rule in lib/moderation-scan.js. Nothing in this file needs it.

// Reaction emoji auto-applied to every valid command message, fired right
// before the command is processed (not after) — just a "seen it, working on
// it" acknowledgement. Picked per-instance from botName (see makeHandler's
// param below): the Sun number reacts with ☀️, the Moon number with 🌙, and
// anything else (Discord/Telegram never call this, but just in case) falls
// back to the old crossed-swords default.
const AUTO_REACT_EMOJI_DEFAULT = '⚔️'
function autoReactEmojiFor(botName) {
  const n = (botName ?? '').toLowerCase()
  if (n.includes('sun'))  return '☀️'
  if (n.includes('moon')) return '🌙'
  return AUTO_REACT_EMOJI_DEFAULT
}

/**
 * LOCKDOWN MODE — while true, only the configured owner (via DM, not a
 * group) can run any command. Everyone else is silently ignored.
 * Currently OFF — the bot now responds to everyone / all groups.
 */
const OWNER_ONLY_MODE = false

// isOwnerJid now imported from lib/group-helpers.js (single source of truth —
// this used to be redefined separately in handler.js, group-settings.js, and
// validate.js, which is exactly how validate.js drifted out of sync and
// stopped recognizing the LID-based owner check).

/**
 * Extracts the sender's real phone number (bare digits, E.164 without the +)
 * from a WhatsApp message, or null if it can't be known.
 *
 * WhatsApp puts the number in a DIFFERENT attribute depending on where the
 * message came from, and Baileys surfaces both on `msg.key`
 * (see Utils/decode-wa-message.js, which reads them off the stanza attrs):
 *
 *   DM    → `key.senderPn`       (from `sender_pn`)
 *   GROUP → `key.participantPn`  (from `participant_pn`)
 *
 * Reading only senderPn is why this used to stamp almost nobody: virtually all
 * traffic is group traffic, where senderPn is absent and participantPn is the
 * only copy of the number. A LID-addressed sender's `from` is a `@lid` id whose
 * digits are the LID, NOT the phone, so with both attrs missed there is no
 * number anywhere and the account stays unfindable by phone forever.
 *
 * When neither attr is present, a plain `@s.whatsapp.net` `from` already
 * carries the number in its own digits.
 *
 * The 8-15 length window matches lib/otp-store.js's normalizePhone(), so a
 * number stamped here is comparable to one the website normalizes at login.
 */
function senderPhone(ctx) {
  const digits = j => String(j ?? '').split('@')[0].split(':')[0].replace(/\D+/g, '')
  const ok = d => d.length >= 8 && d.length <= 15

  for (const candidate of [ctx.msg?.key?.senderPn, ctx.msg?.key?.participantPn]) {
    const d = digits(candidate)
    if (ok(d)) return d
  }
  if (String(ctx.from ?? '').endsWith('@s.whatsapp.net')) {
    const d = digits(ctx.from)
    if (ok(d)) return d
  }
  return null
}

/**
 * Middleware: looks up ctx.from in the player store and attaches the result
 * to ctx.player (null if not registered). Also wires ctx.save() so plugins
 * can persist mutations without touching the db directly.
 */
async function resolvePlayer(ctx) {
  // Cluster read-half: make the acting player current from Mongo before we take
  // ctx.player, so a command served on THIS number reflects what another number
  // just committed (and a player who registered elsewhere becomes visible here).
  // No-op on single-VPS; best-effort so a Mongo hiccup never breaks the handler.
  await refreshPlayerFromCluster(ctx.db, ctx.from)
  ctx.player = getPlayer(ctx.db, ctx.from)
  ctx.save = () => savePlayer(ctx.db, ctx.player)

  // One-time, best-effort: record the player's real phone number so the
  // website's OTP login can find THIS character by number instead of minting
  // a duplicate. LID-keyed accounts (see config.ownerLid) carry no phone in
  // their id at all, so without this stamp the site can't connect them — the
  // exact bug behind "logging in on the site made a new account". Only fills
  // when it's missing, so it's a no-op on every subsequent message and never
  // overwrites a number a site login already recorded.
  if (ctx.player && !ctx.player.phone) {
    const phone = senderPhone(ctx)
    if (phone) {
      await updatePlayer(ctx.db, ctx.from, p => { if (!p.phone) p.phone = phone })
        .catch(() => {})
    }
  }
}

/**
 * Returns a Baileys `messages.upsert` handler bound to `sock`.
 *
 * Responsibility: raw Baileys event → normalised ctx → plugin dispatch.
 * No command logic lives here.
 */
export function makeHandler(sock, db, botName) {
  return async function handleMessage({ messages, type }) {
    // 'notify' is a genuinely new inbound message. 'append' is normally
    // history sync / own-message echo from other devices — BUT Baileys also
    // uses 'append' for some live one-on-one DMs depending on account/LID
    // addressing, so filtering it out here silently ate real incoming DMs:
    // no log line above debug, no reply, indistinguishable from the bot
    // being offline. We no longer drop by type. Instead we rely on the
    // existing `msg.key.fromMe` check below to skip echoes of our own
    // messages. Logged at debug, not info — like the per-command trail
    // below, this fires on ordinary traffic and is pure noise at
    // LOG_LEVEL=info; flip to debug to get it back when actually chasing
    // a delivery-shape issue.
    if (type !== 'notify') {
      logger.debug({ type, count: messages?.length ?? 0 }, 'Non-notify upsert (processing anyway)')
    }

    for (const msg of messages) {
      // Per-message guard. Without it, one throw anywhere below rejects the
      // whole handleMessage promise: Baileys has no error handling on this
      // event, so the rest of the batch is dropped and nothing is logged.
      // Every message now fails independently, loudly, and in isolation.
      try {
        await handleOne(msg)
      } catch (err) {
        logger.error({
          err: err.message,
          stack: err.stack,
          jid: msg?.key?.remoteJid,
        }, 'Unhandled error while processing message')
      }
    }

    async function handleOne(msg) {
      // Ignore empty or own messages
      if (!msg.message || msg.key.fromMe) return

      // Extract plain text from common message types.
      //
      // normalizeMessageContent() first: a group with DISAPPEARING MESSAGES on
      // delivers every message wrapped as ephemeralMessage.message.<real type>,
      // and view-once/edited messages nest the same way. Reading msg.message
      // directly found only the wrapper, so body was '' for ordinary text —
      // no command in such a group ever matched the prefix, and antispam saw
      // nothing to measure. Unwrapping is what makes the bot work there.
      const content = normalizeMessageContent(msg.message) ?? msg.message
      const buttonReplyId = extractButtonReplyId(content)
      const body =
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        buttonReplyId ||
        ''

      // Diagnostic: a button tap that extractButtonReplyId() couldn't parse
      // into an id logs the raw shape here instead of vanishing silently —
      // "the bot reacts (delivery receipt) but never runs the command" is
      // otherwise undebuggable, since nothing downstream of this line even
      // sees the message once body stays ''. Only fires for the specific
      // known reply-message keys, so it never fires on ordinary text/media.
      const looksLikeButtonReply =
        content?.interactiveResponseMessage || content?.buttonsResponseMessage || content?.listResponseMessage
      if (looksLikeButtonReply && !buttonReplyId) {
        logger.warn({ contentKeys: Object.keys(content ?? {}), raw: content }, 'Button tap received but id could not be extracted')
      }

      const sender = msg.key.remoteJid          // group or DM jid
      const isGroup = sender.endsWith('@g.us')
      const from = isGroup
        ? (msg.key.participant ?? sender)       // individual member in group
        : sender

      // Every inbound DM is logged with its RAW jid before any gate runs —
      // at debug, not info, same reasoning as the per-command trail further
      // down: one line per DM is noise in production and buries real
      // errors. Set LOG_LEVEL=debug when actually chasing "the bot doesn't
      // respond to anything in DM" — this proves whether the message
      // reached the handler at all, and exposes the addressing WhatsApp
      // actually used. If `sender` here ends in @lid rather than
      // @s.whatsapp.net, this account is on WhatsApp's LID addressing and
      // that is the thing to chase — player records keyed by phone jid
      // won't match, and sends may not route.
      if (!isGroup) {
        logger.debug({
          rawJid: sender,
          server: sender.replace(/^.*@/, '@'),
          senderPn: msg.key.senderPn ?? null,   // phone number, when LID is in use
          bodyPreview: body.slice(0, 40),
        }, 'DM received')
      }

      // ── Owner-only lockdown ──────────────────────────────────────────────
      // While OWNER_ONLY_MODE is on, silently drop everything except a DM
      // from the configured owner. No reply is sent to non-owners — this is
      // intentional so the bot doesn't reveal it's running/gated to anyone
      // probing it. Antilink is a bot behavior too, so it stays gated by
      // this exact same check rather than getting a bypass.
      if (OWNER_ONLY_MODE && !(!isGroup && isOwnerJid(from))) {
        return
      }

      // ── Antidelete: message-revoke events ───────────────────────────────
      // A deletion arrives as a protocolMessage, not as text, so it has to be
      // handled before anything that assumes `body` is meaningful. Consumes
      // the event either way — a revoke is never a command.
      if (msg.message?.protocolMessage) {
        await handleRevocation(sock, msg).catch(err =>
          logger.warn({ err: err.message, jid: sender }, 'Antidelete: revoke handling failed'))
        return
      }

      // ── Moderation scans ────────────────────────────────────────────────
      // antilink, grouplock, mute, antispam, antichannel, antistatus + the
      // antidelete capture. Runs before the prefix check because none of these
      // arrive as commands — they're ordinary messages. Returns true when it
      // consumed the message (deleted it / removed the sender), in which case
      // there is nothing left to dispatch.
      //
      // Antilink used to be a separate inline block right here, with its own
      // copy of the owner/admin checks. It now lives in the scan alongside the
      // other destructive rules — which fixed the admin exemption (the inline
      // copy compared `pt.id === from` only, so in any group whose addressing
      // mode differed from the incoming jid it kicked genuine admins), and got
      // it caption and disappearing-message coverage for free.
      //
      // Wrapped so a moderation failure can never stop a normal message from
      // being handled: a broken scan must degrade to "moderation is off", not
      // to "the bot stopped responding".
      try {
        if (await runModerationScans({ sock, db, msg, sender, from, body, isGroup })) return
      } catch (err) {
        logger.warn({ err: err.message, jid: sender }, 'Moderation scan failed')
      }

      // ── AFK ─────────────────────────────────────────────────────────────
      // Clears the sender's own AFK and answers for anyone they tagged.
      // Deliberately never consumes the message — an AFK player's command
      // still runs, and tagging someone away is still a normal message.
      // Fire-and-forget so a slow send can't delay the actual command.
      runAfkScan({ sock, msg, sender, from, body }).catch(err =>
        logger.warn({ err: err.message }, 'AFK scan failed'))

      // ── Pending-purchase screenshot bypass ────────────────────────────────
      // Must run before the "must start with a command prefix" bail-out
      // below — a payment screenshot has no prefix at all. DM-only: group
      // images are never treated as purchase confirmations. Shared by both
      // Premium and gem top-up flows (see lib/pending-purchase.js) so there
      // is exactly one image hook, not two competing ones.
      if (!isGroup && msg.message?.imageMessage) {
        const maybePlayer = getPlayer(db, from)
        if (hasAwaitingScreenshot(maybePlayer)) {
          const screenshotCtx = {
            sock, db, msg, sender, from, isGroup,
            reply: (text) => sock.sendMessage(sender, { text: String(text) }, { quoted: msg }),
          }
          await handlePendingScreenshot(screenshotCtx, maybePlayer).catch(err =>
            logger.warn({ err: err.message }, 'Screenshot handler failed'))
          return
        }
      }

      // ── Unban-appeal form bypass ──────────────────────────────────────────
      // Same reason this sits above the prefix check as the screenshot hook: a
      // photo of the filled-in unban form carries no command. DM-only, and only
      // while the sender actually has an appeal open (started with `.unban-me`,
      // see lib/unban-appeal.js), so an ordinary DM image is never mistaken for
      // a form. Reads the NORMALIZED content so a disappearing-messages or
      // view-once wrapper doesn't hide the image — Baileys' downloadMediaMessage
      // unwraps the same way, so the raw msg is still what gets downloaded.
      if (!isGroup && content.imageMessage && hasOpenUnbanAppeal(db, from)) {
        const appealCtx = {
          sock, db, msg, sender, from, isGroup,
          reply: (text) => sock.sendMessage(sender, { text: String(text) }, { quoted: msg }),
        }
        const consumed = await handleUnbanFormImage(appealCtx).catch(err => {
          logger.warn({ err: err.message, jid: from }, 'Unban appeal form handler failed')
          return false
        })
        if (consumed) return
      }

      // ── Story Mode choice-reply bypass ─────────────────────────────────────
      // Must also run before the prefix check — a choice reply is a bare "1",
      // "2", or "3" with no prefix. Group-only now that Story Mode itself is
      // group-only, same reasoning as the screenshot bypass above (just the
      // opposite chat type). Only fires when the player actually has a choice
      // beat pending AND currently holds THIS group's story slot
      // (hasPendingStoryChoice checks both — see plugins/story.js) — so a
      // stray "1"/"2" typed for any other reason, in any other group, or in
      // a group where Story Mode is off, is never misrouted into the story
      // engine or told "Story Mode is off" out of nowhere.
      if (isGroup && body && !body.startsWith(config.prefix)) {
        const maybePlayer = getPlayer(db, from)
        if (await hasPendingStoryChoice(maybePlayer, sender, from)) {
          const storyCtx = {
            sock, db, msg, sender, from, isGroup,
            reply: (text) => sock.sendMessage(sender, { text: String(text) }, { quoted: msg }),
          }
          const consumed = await handleStoryChoiceReply(storyCtx, maybePlayer, body).catch(err => {
            logger.warn({ err: err.message }, 'Story choice handler failed')
            return false
          })
          if (consumed) return
        }
      }

      // ── DM lock ─────────────────────────────────────────────────────────
      // DMs are closed to everyone except the bot owner and the
      // premium/vip/topup commands (status + buy flows must stay reachable
      // for anyone). This is a separate switch from OWNER_ONLY_MODE above —
      // that one is a global panic switch for the whole bot; this one only
      // narrows DMs, and only once a message has already passed the prefix
      // check further down (so it needs the parsed `cmd`, computed next).
      if (!isGroup && !isOwnerJid(from)) {
        const bodyAfterPrefix = body.startsWith(config.prefix) ? body.slice(config.prefix.length).trim() : ''
        const firstWord = bodyAfterPrefix.split(/\s+/)[0]?.toLowerCase()
        if (!DM_ALLOWED_COMMANDS.has(firstWord)) {
          // Logged, not swallowed. This send used to end in `.catch(() => {})`,
          // so if the "DMs are closed" notice itself failed to deliver the
          // outcome was total silence — indistinguishable from the bot being
          // offline or ignoring the person, and invisible in the logs.
          await sock.sendMessage(sender, {
            text: `🔒 DMs are closed. Use *${config.prefix}premium*, *${config.prefix}topup*, or *${config.prefix}season offer* here, or head to a group to play.`,
          }, { quoted: msg }).catch(err =>
            logger.warn({ err: err.message, jid: sender }, 'DM-closed notice failed to send'))
          return
        }
      }

      if (!body.startsWith(config.prefix)) return

      const [rawCmd, ...args] = body
        .slice(config.prefix.length)
        .trim()
        .split(/\s+/)
      const cmd = rawCmd.toLowerCase()

      // ── Night mode lockout ───────────────────────────────────────────────
      // `.night on` (plugins/night.js) closes the bot for the night. Everyone
      // except the bot owner and bot mods is refused here, at the same
      // chokepoint as ban/jail below, so no command anywhere can slip past it.
      // The notice is throttled per JID (lib/night-mode.js shouldNotifyNight)
      // — a busy group overnight would otherwise get one reply per command and
      // the bot would be louder asleep than awake. Blocked-and-already-notified
      // commands are dropped silently.
      if (isNightMode() && !isOwnerJid(from) && !isMod(db, from)) {
        // Ban appeals are exempt, exactly as they are from the ban and jail
        // lockouts below. Someone banned at 2am must still be able to file an
        // appeal for the mods to read in the morning — night mode is a
        // "come back later" notice, not a reason to close the only route out
        // of a punishment. See LOCKOUT_EXEMPT_COMMANDS.
        if (!LOCKOUT_EXEMPT_COMMANDS.has(cmd)) {
          if (shouldNotifyNight(from)) {
            await sock.sendMessage(sender, { text: nightNotice(config.prefix) }, { quoted: msg })
              .catch(() => {})
          }
          return
        }
      }

      // ── Ban lockout ──────────────────────────────────────────────────────
      // Banned accounts cannot run ANY command — including .register, so a
      // ban can't be dodged by wiping and re-registering. Checked by JID
      // (ctx.from), independent of the player record, so it also blocks
      // someone who was banned before ever registering. LOCKOUT_EXEMPT_COMMANDS
      // stays reachable: .unban so an admin/owner can always reverse it (the
      // unban plugin re-checks permissions itself, so a banned non-admin
      // typing it gets nowhere), and .unban-me so the banned person can start
      // an appeal — the notice below points them at it.
      const ban = getBan(db, from)
      if (ban && !LOCKOUT_EXEMPT_COMMANDS.has(cmd)) {
        if (banExpired(ban)) {
          // A timed ban (antispam auto-ban) whose time is up: clean up the
          // stale record and let the command through — exactly the shape of
          // the jail auto-release just below.
          await unbanUser(db, from)
          if (ban.auto) {
            sock.sendMessage(sender, {
              text: `✅ *Your spam timeout is over — you can use the bot again.* Keep it slower this time.`,
            }, { quoted: msg }).catch(() => {})
          }
        } else if (ban.expiresAt != null) {
          // Temporary ban still in force. No appeal-form CTA: it lifts itself
          // shortly, and only the owner or a mod can shorten it (plugins/unban.js).
          const minsLeft = Math.max(1, Math.ceil((ban.expiresAt - Date.now()) / 60000))
          await sock.sendMessage(sender, {
            text:
              `🚫 *You're timed out for spamming and can't use the bot.*\n\n` +
              `Time left: *${minsLeft} min*.` +
              (ban.reason ? `\nReason: _${ban.reason}_` : '') +
              `\n\n_It lifts on its own — only the bot owner or a mod can undo it sooner._`,
          }, { quoted: msg }).catch(() => {})
          return
        } else {
          const bannedAt = new Date(ban.bannedAt).toLocaleString()
          const byLabel  = ban.bannedBy ? `@${ban.bannedBy.replace(/@.*$/, '')}` : 'an admin'
          await sock.sendMessage(sender, {
            text:
              `🚫 *You are banned and cannot use this bot.*\n\n` +
              `Banned: *${bannedAt}*\n` +
              `By: ${byLabel}` +
              (ban.reason ? `\nReason: _${ban.reason}_` : '') +
              `\n\n📩 *Want it undone?* DM me *${config.prefix}unban-me* — ` +
              `I'll send you the unban form to fill in and send back, and the mod ` +
              `team reviews it from there.`,
            mentions: ban.bannedBy ? [ban.bannedBy] : [],
          }, { quoted: msg }).catch(() => {})
          return
        }
      }

      // ── Jail lockout ─────────────────────────────────────────────────────
      // Jail is a temporary full-lockout (same chokepoint as ban) — no commands
      // work while a sentence is active. Self-expires when releaseAt passes;
      // on the first command after expiry the record is cleaned up and a
      // release message is sent, then the command runs normally.
      // LOCKOUT_EXEMPT_COMMANDS pass through untouched, so someone who is both
      // jailed and banned can still file an appeal (their release just gets
      // announced on their next ordinary command instead).
      const jailRec = getJailRecord(db, from)
      if (jailRec && !LOCKOUT_EXEMPT_COMMANDS.has(cmd)) {
        if (Date.now() < jailRec.releaseAt) {
          const minsLeft = Math.ceil((jailRec.releaseAt - Date.now()) / 60000)
          await sock.sendMessage(sender, {
            text:
              `🔒 *You're locked up${jailRec.crime ? ` for ${jailRec.crime}` : ''}.*\n\n` +
              `Time left: *${minsLeft} min* on your sentence.\n` +
              `_Sit tight — you can't run commands from a cell._`,
          }, { quoted: msg }).catch(() => {})
          return
        } else {
          // Sentence served — clean up the record and let this command through
          await releasePlayer(db, from)
          sock.sendMessage(sender, {
            text:
              `🔓 *You've served your time and walked free.*\n\n` +
              `The cell door creaks open and morning light hits your face.\n` +
              `_Try not to make it a habit._`,
          }, { quoted: msg }).catch(() => {})
        }
      }

      // ── Auto-react ──────────────────────────────────────────────────────
      // React on the sender's own command message before any reply is sent,
      // regardless of which plugin (or none) ends up handling it — this is
      // just an acknowledgement that the bot saw a real command, not a
      // signal about success/failure. Fire-and-forget: a failed react
      // (message deleted, no reaction permission, etc.) should never block
      // or delay the actual command from running.
      sock.sendMessage(sender, {
        react: { text: autoReactEmojiFor(botName), key: msg.key },
      }).catch(() => {})

      /** ctx passed to every plugin */
      const ctx = {
        sock,
        db,
        // Every ctx must name its platform. The registry is SHARED across
        // WhatsApp/Discord/Telegram in combined mode, so this is what lets
        // .menu and dispatch() hide commands that belong to another platform.
        platform: 'whatsapp',
        botName,    // display name of THIS number's bot instance — see main.js
        msg,
        sender,     // jid of the chat (group or DM)
        from,       // jid of the actual sender
        isGroup,
        cmd,
        args,
        body,
        reply: (text) =>
          sock.sendMessage(sender, { text: String(text) }, { quoted: msg })
            .catch(err => {
              // Never swallow a failed reply. Plugins call ctx.reply() and
              // mostly don't await the result, so a rejection here surfaces
              // nowhere — the command runs, the state changes, and the user
              // just sees nothing come back. Rethrow after logging so the
              // per-message guard records it too.
              logger.error({ err: err.message, jid: sender, cmd }, 'ctx.reply failed to send')
              throw err
            }),
        replyImage: (image, caption = '') =>
          sock.sendMessage(
            sender,
            {
              image: Buffer.isBuffer(image) ? image : { url: image },
              caption: String(caption),
            },
            { quoted: msg },
          ),
        /**
         * replyGif — sends a TRUE autoplaying/looping GIF. WhatsApp has no
         * native animated-image message type; an animated GIF is sent as a
         * video message with gifPlayback: true (Baileys/WhatsApp's actual
         * mechanism for this — confirmed against Baileys' message-type
         * docs). Using replyImage's { image: { url } } shape for a .gif URL
         * instead sends it as a STATIC photo — first frame only, no
         * animation — which is the bug this method exists to avoid.
         * image can be a remote http(s) URL or a Buffer, same convention
         * as replyImage.
         */
        replyGif: async (image, caption = '') => {
          // A raw .gif can't be sent straight as a WhatsApp video — Baileys
          // needs a real MP4 container. So transcode gifs (a .gif URL, or a
          // raw-gif Buffer) to MP4 first, cached. A non-gif URL (e.g. a
          // pre-converted .mp4, the recommended way to host character art) is
          // already a real video — loop it directly. On transcode failure
          // (ffmpeg missing, fetch error), fall back to a static still frame
          // rather than a video WhatsApp silently drops.
          if (typeof image === 'string' && !/\.gif(\?|$)/i.test(image)) {
            return sock.sendMessage(
              sender,
              { video: { url: image }, gifPlayback: true, caption: String(caption) },
              { quoted: msg },
            )
          }
          try {
            const mp4 = await gifSourceToVideo(image)
            return await sock.sendMessage(
              sender,
              { video: mp4, gifPlayback: true, caption: String(caption) },
              { quoted: msg },
            )
          } catch {
            return sock.sendMessage(
              sender,
              { image: Buffer.isBuffer(image) ? image : { url: image }, caption: String(caption) },
              { quoted: msg },
            )
          }
        },
        /**
         * replyCard — sends a WhatsApp "external ad reply" link-preview card:
         * a thumbnail image, bold title, description line, and a source URL,
         * attached above the given text. This is the card style used by
         * other Tensura-style bots (e.g. their "Daily Rewards" / "Shop" cards
         * that link to their companion site) — WhatsApp renders whatever
         * title/body/thumbnail/url it's handed, it doesn't have to actually
         * scrape a live page.
         *
         * Usage:
         *   await ctx.replyCard({
         *     text: '🎉 You claimed your daily reward...',
         *     title: 'Astral Daily Rewards',
         *     body: 'Maintain your streak and claim exclusive rewards!',
         *     thumbnailUrl: 'https://example.com/banner.jpg', // or a local images/ filename
         *     sourceUrl: 'https://example.com/daily',          // optional, shown as the link line
         *   })
         *
         * thumbnailUrl accepts either a full http(s) URL or a filename inside
         * ./images/ (resolved via lib/image.js's resolveImageSource so this
         * matches replyImage's local-file convention). If thumbnailUrl is
         * omitted entirely, WhatsApp still renders the title/body/link line
         * without a picture.
         */
        replyCard: ({ text = '', title = '', body = '', thumbnailUrl, sourceUrl, largeThumbnail = true }) =>
          sock.sendMessage(
            sender,
            {
              text: String(text),
              contextInfo: {
                externalAdReply: {
                  title: String(title),
                  body: String(body),
                  ...(thumbnailUrl ? { thumbnailUrl: resolveCardThumbnail(thumbnailUrl) } : {}),
                  ...(sourceUrl ? { sourceUrl: String(sourceUrl) } : {}),
                  mediaType: 1,
                  renderLargerThumbnail: !!largeThumbnail,
                  showAdAttribution: false,
                },
              },
            },
            { quoted: msg },
          ),
      }

      await resolvePlayer(ctx)

      // ── Group command gates: premium-only, then music-only ─────────────
      // Two per-group toggles that restrict which commands NON-OWNERS may run.
      // Both are reply-only, never a kick. One settings read serves both. The
      // bot owner always passes regardless (isOwnerJid short-circuit).
      if (ctx.isGroup && !isOwnerJid(ctx.from)) {
        const groupSettings = await getGroupSettings(ctx.sender)

        // Premium-gated group — per-message removal of non-premium members is
        // handled separately by the periodic sweep in main.js.
        if (groupSettings.premiumOnly && !(ctx.player && isPremiumActive(ctx.player))) {
          await ctx.reply(
            `🔒 This group is *Premium-only*. Get Premium with *${config.prefix}premium buy <plan>* (DM me), then try again.`,
          ).catch(() => {})
          return
        }

        // Music-only group (.music on) — regular members get only .song and the
        // group commands; admins/mods bypass so they can moderate and lift it.
        // isGroupOrBotOwnerOrMod is only awaited when the command would other-
        // wise be blocked, keeping music/group commands on the cheap path.
        if (
          groupSettings.musicOnly &&
          !isMusicModeAllowed(cmd) &&
          !(await isGroupOrBotOwnerOrMod(ctx))
        ) {
          await ctx.reply(
            `🎵 This group is in *music-only mode*.\n` +
            `Right now only *${config.prefix}song* and group commands work here.\n` +
            `_An admin can lift it with *${config.prefix}music off*._`,
          ).catch(() => {})
          return
        }
      }

      // Inn sleep lockout — asleep players cannot run ANY command until
      // their sleep duration elapses. Waking is automatic: the first
      // message sent after sleepUntil has passed triggers the wake-up
      // (full stamina/HP/MP restore) and that message is otherwise
      // consumed just to trigger it — the player must send their real
      // command again once awake.
      //
      // The check-and-mutate happens inside updatePlayer's read→mutate→write
      // cycle (like every other stateful mutation in this bot) instead of
      // reading ctx.player once and saving it back later, which would race
      // against any other command touching the same player concurrently.
      //
      // LOCKOUT_EXEMPT_COMMANDS skip this entirely (they also skip the
      // auto-wake, which simply happens on the next ordinary command): being
      // asleep at the inn must not swallow a ban appeal or an admin's .unban.
      //
      // Utility commands skip it for the same reason and in the same way (see
      // isNonRpgCommand): your character being asleep is not a reason `.song`
      // can't fetch a track. The message above said "All commands are locked",
      // and it meant it — literally every one of the ~208 commands, including
      // the ones that never touch your character at all.
      if (ctx.player && !LOCKOUT_EXEMPT_COMMANDS.has(cmd) && !isNonRpgCommand(cmd)) {
        let stillAsleep = false
        let justWoke    = false
        let wakeAt      = null

        await updatePlayer(ctx.db, ctx.from, fresh => {
          if (fresh.sleepUntil == null) return fresh
          if (Date.now() < fresh.sleepUntil) {
            stillAsleep = true
            wakeAt = fresh.sleepUntil
            return fresh
          }
          justWoke = wakeIfDue(fresh)
          return fresh
        })

        ctx.player = getPlayer(ctx.db, ctx.from)

        if (stillAsleep) {
          await ctx.reply(
            `😴 *${ctx.player.name}* is fast asleep at the inn.\n` +
            `All commands are locked — you'll wake up in *${formatTimeLeft(wakeAt - Date.now())}*.`,
          ).catch(() => {})
          return
        }
        if (justWoke) {
          await ctx.reply(
            `☀️ *${ctx.player.name}* wakes up feeling fully rested!\n` +
            `❤️ HP ${ctx.player.maxHp}/${ctx.player.maxHp}  💧 MP ${ctx.player.maxMp}/${ctx.player.maxMp}  ` +
            `⚡ Stamina ${ctx.player.stamina?.current ?? '?'}/${ctx.player.stamina?.max ?? '?'}`,
          ).catch(() => {})
          return
        }
      }

      // ── Hunger tick ──────────────────────────────────────────────────────
      // Hunger drains by real elapsed time, applied lazily here on every
      // command — no background timer, the same "bake elapsed time on read"
      // trick the sleep block above and home crops use. Runs even mid-battle.
      // Starvation NEVER kills and never touches HP; it bleeds stamina, and a
      // player drained to 0 stamina COLLAPSES (gated just below). Silent unless
      // a throttled "you're starving" warning is due — a merely-hungry player
      // is never messaged. See lib/hunger-engine.js.
      //
      // Skipped wholesale on utility commands (isNonRpgCommand). Two reasons:
      // the "you're starving!" warning has no business interrupting `.song`, and
      // maybeWarn() BURNS its once-per-cooldown budget the moment it fires — so
      // merely suppressing the reply would silently eat the warning the player
      // was owed on their next real command. Skipping the tick instead is free:
      // it is purely lastTick-elapsed-time based and slices long gaps itself
      // (msToEmpty/starvingMs), so the next RPG command bakes an identical
      // result from the wider gap. Nothing decays slower, it just decays later.
      if (ctx.player && !isNonRpgCommand(cmd)) {
        let hungerDesc = {}
        await updatePlayer(ctx.db, ctx.from, fresh => {
          hungerDesc = applyHungerTick(fresh, Date.now())
          return fresh
        })
        ctx.player = getPlayer(ctx.db, ctx.from)

        if (hungerDesc.warn) {
          // A heads-up, not a lockout: warn, then let the command run (so
          // e.g. `.eat` still works on the very message that triggered the warning).
          await ctx.reply(hungerDesc.warnMessage).catch(() => {})
        }

        // Collapsed: too weak to act. Only the recovery/reference allowlist
        // runs — plus anything the player is mid-battle for.
        //
        // WHY inBattle IS EXEMPT (deliberate, not an oversight): the whole point
        // of this rework is that hunger must never cost a player progress. A
        // collapsed player who couldn't attack, defend or flee would sit in the
        // fight taking enemy hits until they hit 0 HP and died — to *combat*
        // death, which does dock stats. Starvation would still be taking their
        // stats, just laundered through the monster. Letting them keep playing
        // the fight out is the only version where "you lose stamina, not
        // progress" is actually true. They are already heavily punished: 0
        // stamina, and hunger effects apply to every swing they take.
        if (
          isCollapsed(ctx.player) &&
          !ctx.player.inBattle &&
          isCollapseBlocked(cmd) &&
          !LOCKOUT_EXEMPT_COMMANDS.has(cmd)
        ) {
          await ctx.reply(collapseMessage(ctx.player)).catch(() => {})
          return
        }
      }

      // ── The End: aura tick + deep-sleep gate ──────────────────────────────
      // The Blue Band event (lib/end-event.js). Like the hunger tick above, we
      // bake the effect on read: applyEndEventTick refreshes player.endWeakened
      // (the cached boolean getEffectiveStat multiplies every stat by) and
      // reports whether the aura has dragged this player into its deep sleep.
      // When the event is off — or the moment the End is killed server-wide —
      // the tick clears the flag on the next command with no special-casing
      // here, because every predicate keys off the single global event flag.
      //
      // The sleep lockout mirrors the hunger collapse gate exactly: a sleeping
      // player is frozen out of everything except END_SLEEP_ALLOWED_COMMANDS
      // (the self-rescue path), inBattle is exempt so the aura can't trap a
      // player mid-fight, and LOCKOUT_EXEMPT_COMMANDS (ban appeals) pass through.
      // So do utility commands — the End's aura is on your character, not on the
      // YouTube downloader.
      //
      // The tick itself still runs on every command, unlike the hunger tick
      // above: it refreshes the cached `endWeakened` flag that getEffectiveStat
      // multiplies by, it has no throttled warning to burn, and leaving that
      // flag stale would mean stats read wrong for whoever looks next.
      if (ctx.player) {
        let endAsleep = false
        await updatePlayer(ctx.db, ctx.from, fresh => {
          endAsleep = applyEndEventTick(ctx.db, fresh, Date.now()).asleep
          return fresh
        })
        ctx.player = getPlayer(ctx.db, ctx.from)

        if (
          endAsleep &&
          !ctx.player.inBattle &&
          !END_SLEEP_ALLOWED_COMMANDS.has(cmd) &&
          !LOCKOUT_EXEMPT_COMMANDS.has(cmd) &&
          !isNonRpgCommand(cmd)
        ) {
          await ctx.reply(END_SLEEP_MSG.replaceAll('{prefix}', config.prefix)).catch(() => {})
          return
        }
      }

      // ── Boss turn timeout (compare-on-read, mirrors the PvP stall timer) ──
      // A live boss fight where the player has let their turn sit past the
      // 5-minute limit is resolved as a loss on the spot, on whatever command
      // they finally send. This is also the ONLY exit from a boss fight now that
      // `.cb` is blocked mid-boss, so no one is ever stuck: go idle and the clock
      // ends it. No scheduler — like pvp.js the deadline is checked lazily on the
      // next read, so it survives restarts.
      if (ctx.player?.inBattle && isLiveBossFight(ctx.player)) {
        const bs   = ctx.player.battleState
        const last = bs.lastMoveAt ?? bs.startedAt ?? 0
        if (last && Date.now() - last > BOSS_TURN_TIMEOUT_MS) {
          await resolveBossTimeoutLoss(ctx)
          return
        }
      }

      // ── In-battle command gate ───────────────────────────────────────────
      // Mid-battle, only real battle actions (+ a small utility allowlist,
      // shop included so potions can be bought) are permitted. Everything
      // else — mine, craft, travel, another .enter, etc. — gets rejected
      // with a reminder instead of running against stale/conflicting state.
      // LOCKOUT_EXEMPT_COMMANDS pass too: a player banned mid-dungeon still
      // needs a route to appeal it.
      if (ctx.player?.inBattle && !BATTLE_ALLOWED_COMMANDS.has(cmd) && !LOCKOUT_EXEMPT_COMMANDS.has(cmd)) {
        await ctx.reply(
          `⚔️ You're mid-battle! Only battle commands work right now:\n` +
          `*${config.prefix}attack* · *${config.prefix}skill <name>* · *${config.prefix}defend* · *${config.prefix}flee*\n` +
          `_(${config.prefix}shop and ${config.prefix}profile also work if you need to check something.)_`,
        ).catch(() => {})
        return
      }

      // ── Boss-fight lockdown ──────────────────────────────────────────────
      // A live boss fight refuses shopping, the free `.cb` escape, and loadout
      // re-specs (see BOSS_FIGHT_BLOCKED_COMMANDS). Those are all in
      // BATTLE_ALLOWED_COMMANDS — legal in an ordinary fight — so they clear the
      // gate above and are caught here only when the enemy is a live boss.
      if (ctx.player?.inBattle && isLiveBossFight(ctx.player) && BOSS_FIGHT_BLOCKED_COMMANDS.has(cmd)) {
        await ctx.reply(
          `👑 *You are locked in a boss fight.*\n` +
          `No shops, no clearing out, no swapping your loadout. Defeat it or fall trying.\n\n` +
          `*${config.prefix}attack* · *${config.prefix}skill <name>* · *${config.prefix}defend*`,
        ).catch(() => {})
        return
      }

      // ── Bag overflow after a premium lapse ───────────────────────────────
      // Losing premium drops the bag cap from 50 to 30, which can leave a bag
      // stranded above its own limit: every hasInventoryRoom() check then fails,
      // so looting, crafting and buying are all dead until they get back under
      // it. lib/inventory-limits.js resolves that on a clock, and this is the
      // half the player actually sees.
      //
      // NEVER a lockout — it warns and falls through, exactly like the hunger
      // warning above, so the very command that triggers the notice (`.shop
      // sell`, `.home store`) still runs. Utility commands skip it: `.song` has
      // nothing to do with your bag.
      //
      // The handler stamps and sheds too, rather than leaving it all to the
      // 15-minute sweep in main.js: it means the 48h clock starts the moment
      // they play instead of up to 15 minutes later, and the receipt lands in
      // chat immediately. The helpers are pure, so both callers run identical
      // logic; whichever gets there first wins and the other sees 'clear'.
      // The pre-check reads ctx.player, which is already in hand, so the common
      // case (a bag under the cap, which is nearly every player on nearly every
      // command) costs one length comparison and never touches the write queue.
      if (
        ctx.player && !isNonRpgCommand(cmd) && !LOCKOUT_EXEMPT_COMMANDS.has(cmd) &&
        !isPremiumActive(ctx.player) &&
        (ctx.player.inventoryShed || ctx.player.inventoryGrace || inventoryOverflow(ctx.player).over > 0)
      ) {
        let notice = null
        await updatePlayer(ctx.db, ctx.from, fresh => {
          // One shared state machine (lib/inventory-limits.js) so the wording,
          // the ordering and the throttle are identical wherever it runs: it
          // delivers a receipt the sweep parked, stamps the grace on first
          // sight, repeats the warning at most every 6h, and sheds once the
          // deadline has passed.
          notice = resolveOverflowNotice(fresh, {
            allItems,
            storageCap: storageCap(fresh),
            prefix: config.prefix,
            cooldownMs: OVERFLOW_WARN_COOLDOWN_MS,
          }).notice
          return fresh
        })
        ctx.player = getPlayer(ctx.db, ctx.from)
        if (notice) await ctx.reply(notice).catch(() => {})
      }

      // debug, not info: one line per command is pure noise at LOG_LEVEL=info
      // and it buries the errors you actually need to see. Set LOG_LEVEL=debug
      // to get the per-command trail back.
      logger.debug({ cmd, from, isGroup }, 'Command dispatched')
      incrementCommandCount()
      const handled = await dispatch(cmd, ctx)

      // ── Pet per-command passive income ──────────────────────────────────
      // Pets with a `solarsPerCommand` rate (data/pets.json — Emberpaw) pay
      // out here, the one place every command funnels through. Runs only for
      // commands that actually matched a plugin, so a typo'd command doesn't
      // pay. Fractions accrue in player.petSolarDust and only whole Solars
      // reach the wallet — see awardPetCommandSolars() in lib/pet-bond.js.
      // Silent by design: a notification on every single command would be
      // unusable spam.
      if (handled && ctx.player) {
        if (ctx.isGroup && ctx.player.inDungeon) {
          touchDungeonActivity(ctx.sender, ctx.player, ctx.from)
        }
        await updatePlayer(ctx.db, ctx.from, fresh => {
          awardPetCommandSolars(fresh, petMap)
          // Boss turn clock: a turn-consuming action taken during a live boss
          // fight resets the 5-minute idle timer. Read-only status checks
          // (BOSS_TURN_TIMER_EXEMPT) do not, so a player can't stall their turn
          // indefinitely by spamming `.profile`. Piggybacks this one write that
          // every handled command already funnels through.
          if (!BOSS_TURN_TIMER_EXEMPT.has(cmd) && isLiveBossFight(fresh) && fresh.battleState) {
            fresh.battleState.lastMoveAt = Date.now()
          }
        }).catch(err => logger.warn({ err: err.message }, 'Pet command payout failed'))
      }

      if (!handled) {
        // debug, not info — a typo'd/unknown command is ordinary user
        // traffic, not something worth a line in production logs. Same
        // reasoning as 'Command dispatched' above.
        logger.debug({ cmd, from, isGroup }, 'No plugin matched command')
        const suggestion = suggestCommand(cmd, 'whatsapp')
        await ctx.reply(
          suggestion
            ? `❓ Unknown command *${config.prefix}${cmd}*. Did you mean *${config.prefix}${suggestion}*?`
            : `❓ Unknown command *${config.prefix}${cmd}*. Use *${config.prefix}menu* to see everything available.`,
        ).catch(() => {})
      }
    }
  }
}
