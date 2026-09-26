/**
 * character.js — Free Fire-style characters.
 *
 * Each character (data/characters.json) has exactly one named ability. Equip
 * one at a time, the same one-at-a-time pattern as plugins/pet.js's active pet
 * and plugins/equipbeast.js's active beast.
 *
 * HOW THEY ARE OBTAINED. Two routes, and which one applies is data, not code:
 *   - season content (`seasonId`) is routed to `.season spin` / `.season shop`
 *     / the battle pass, and nothing else can touch it. Monds cannot buy it.
 *   - everything else (`exclusive` one-of-one, or `spinOnly`) has BOTH a spin
 *     and a price: gems buy attempts in the per-character *-spin plugin, or
 *     🪙5 Monds buy the character outright here. See lib/monds.js for why the
 *     currency split matters and mondPriceFor() for the per-character override.
 *
 * BOTH of those routes answer to the owner freeze in lib/spin-locks.js
 * (`.lockspin <name>` / `.unlockspin <name>`): a frozen character can be neither
 * pulled nor bought, and the buy path refuses before any Mond is charged. The
 * price route used to ignore the freeze, which made `.lockspin` a lock on one of
 * two doors — see shopLockGate().
 *
 * A one-of-one is still a one-of-one. Buying it with Monds moves the bot-wide
 * lock (claimExclusiveSpinForPlayer) to the buyer, so the purchase wins the race
 * rather than bypassing it, and every later buyer is refused at any price.
 *
 * Gems cannot buy a character. `gemPrice` is still in data/characters.json but
 * nothing reads it any more — the old gem-buy branch is gone from handleBuy().
 *
 * The bot owner can also hand one over directly with `.givecharacter <name>
 * [@user]` (plugins/givecharacter.js → giveCharacter in plugins/admin.js), which
 * bypasses all of the above and, for a one-of-one, moves the bot-wide claim too.
 * `.character info` names whoever holds a character, granted or not.
 *
 * Abilities ARE battle-wired now, in lib/character-abilities.js and the combat
 * plugins that call into it. `statBonuses` is applied and reversed here through
 * applyEquipmentBonus() on equip/unequip.
 *
 * Usage:
 *   <prefix>character                  browse all characters, ownership state
 *   <prefix>character info <name>      full detail view for one character
 *   <prefix>character buy <name>       buy a character outright with Monds
 *   <prefix>character equip <name>     set your active character
 *   <prefix>character unequip          clear your active character
 */
import { config } from '../config.js'
import { characterStars } from '../lib/rarity.js'
import { updatePlayer } from '../lib/player-repo.js'
import { fraktur } from '../lib/format.js'
import { characters, characterMap } from '../lib/game-data.js'
import { applyEquipmentBonus } from '../lib/combat-engine.js'
import { syncEmptyVesselFlag, hasYatoTrueForm, ALEXA_AWE_TURNS } from '../lib/character-abilities.js'
import { sendImage, sendGif } from '../lib/image.js'
import { getExclusiveSpinWinner, claimExclusiveSpinForPlayer } from '../lib/season-engine.js'
import { getPlayer } from '../lib/player-repo.js'
import { MOND, fmtMonds, getMonds, roundMonds, isMondBuyable, mondPriceFor } from '../lib/monds.js'
import { isSpinLocked, shopLockGate } from '../lib/spin-locks.js'

function findCharacter(query) {
  const q = (query ?? '').toLowerCase().trim()
  if (!q) return null
  if (characterMap[q]) return characterMap[q]
  return characters.find(c => c.name.toLowerCase() === q)
    ?? characters.find(c => c.name.toLowerCase().includes(q))
    ?? null
}

/**
 * Detects whether a character's art is an animated GIF (Tyla & Alya's Twin
 * Bond reveal and Anastasia's Hypnosis clock — see data/characters.json) so
 * callers route through sendGif() instead of sendImage(). sendImage's static
 * { image: { url } } message shape renders a .gif URL as a single still
 * frame with no animation; sendGif uses each platform's real
 * animated-media mechanism (WhatsApp: video+gifPlayback, Discord: raw
 * .gif attachment, Telegram: sendAnimation).
 */
function isAnimatedArt(character) {
  return /\.gif(\?|$)/i.test(character?.image ?? '')
}

/**
 * Renders a character's *display* name/ability heading in whatever script
 * their `fontStyle` field asks for (data/characters.json). Only Anastasia
 * sets one today ("fraktur"), which is why this is a data field rather than
 * an id check — the next character who wants a distinct script needs one
 * JSON line, not an edit here.
 *
 * Deliberately applied to headings ONLY, never to the prose description or
 * ability flavor: those run several lines and Fraktur is much slower to read
 * at that length. Also never applied to a value used for LOOKUP —
 * findCharacter() matches against the plain `c.name`, so styling the stored
 * name would break `.character equip demon lord anastasia`.
 */
function styled(character, text) {
  return character?.fontStyle === 'fraktur' ? fraktur(text) : text
}

async function sendCharacterArt(ctx, character, caption) {
  return isAnimatedArt(character)
    ? sendGif(ctx, character.image, caption)
    : sendImage(ctx, character.image, caption)
}

/**
 * The art to show for a character, which for exactly one character depends on
 * who is looking: an ascended Yato owner sees his true form instead of the boy
 * (data/characters.json → yato.trueForm.image).
 *
 * Returns a SHALLOW CLONE rather than mutating, because `character` here is the
 * live object out of characterMap — writing `image` onto it would swap the art
 * for every player in the bot, permanently, until restart.
 *
 * Falls back to the normal portrait while trueForm.image is empty, so this
 * never sends a blank card.
 */
function artFor(character, player) {
  const trueImage = character?.trueForm?.image
  if (character?.id === 'yato' && trueImage && hasYatoTrueForm(player)) {
    return { ...character, image: trueImage }
  }
  return character
}

/**
 * Which spin command obtains a given one-of-one exclusive. A table rather
 * than an inline ternary because the same mapping is needed in three places
 * (overview line, info status line, buy refusal) and the chained-ternary
 * version had to be edited in all three every time an exclusive was added —
 * exactly the kind of drift that leaves one call site pointing at nothing.
 * Returns null for an exclusive with no spin command, which every call site
 * already falls back on by pointing at `.character info <id>`.
 */
const SPIN_ROUTES = {
  miyashi:   'miya-spin',
  nisha:     'ni-spin',
  yoriichi:  'yo-spin',
  tyla_alya: 'tyla-alya-spin',
  anastasia: 'anastasia-spin',
  circe:     'circe-spin',
  megumi:    'megumi-spin',
  xiao:      'xiao-spin',
  minna:     'minna-spin',
  shunya:    'shunya-spin',
  ariel:     'ariel-spin',
  yato:      'yato-spin',
  gojo:      'gojo-spin',
  aizen:     'aizen-spin',
  alexa:     'alexa-spin',
  gogeta:    'gogeta-spin',
  naruto:    'naruto-spin',
  witch_of_envy: 'envy-spin',
  echidna: 'echidna-spin',
  orihime: 'orihime-spin',
  scarlett: 'scarlett-spin',
  ronova: 'ronova-spin',
  sword_maiden: 'sword-spin',
}

function spinRouteFor(characterId, pr) {
  const cmd = SPIN_ROUTES[characterId]
  return cmd ? `${pr}${cmd}` : null
}

/**
 * True when a character is obtained from a spin. Two different data flags both
 * mean that, and they are NOT the same thing:
 *
 *   exclusive   one-of-one bot-wide, locked to a single holder forever (see
 *               getExclusiveSpinWinner in lib/season-engine.js). The lock is
 *               what makes it one-of-one, not the spin: buying it with Monds
 *               takes the lock too, so there is still only ever one holder.
 *   spinOnly    not one-of-one. Yato and Gojo: no global lock and no fame wall,
 *               so every player who clears the dead zone gets their own copy.
 *
 * This used to mean "cannot be bought at any price" and gated the gem-buy line.
 * It no longer does: both flags are Mond-buyable now (isMondBuyable in
 * lib/monds.js). What it still marks is that a SPIN route exists, which is why
 * the one caller left uses it to decide whether to offer one. Only `exclusive`
 * gets the "claimed by X" treatment.
 */
function isSpinOnly(c) {
  return c?.exclusive === true || c?.spinOnly === true
}

/**
 * Everyone who holds a character right now, newest-registered last, as
 * { names, count, youOwn }. Derived by scanning ownedCharacters rather than kept
 * as its own record, so it cannot drift away from actual ownership the way a
 * separate ledger would: `.admin givecharacter`, the spin plugins and the season
 * shop all write the same one array, and this reads it.
 *
 * Cheap enough to do on demand (one array `includes` per registered player) and
 * it only runs for `.character info`, never in a battle path.
 */
function ownersOf(db, characterId, viewerJid) {
  const users = db?.data?.users ?? {}
  const names = []
  let count = 0
  let youOwn = false
  for (const [jid, pl] of Object.entries(users)) {
    if (!(pl?.ownedCharacters ?? []).includes(characterId)) continue
    count++
    if (jid === viewerJid) { youOwn = true; continue }
    names.push(pl.name ?? 'someone')
  }
  return { names, count, youOwn }
}

/**
 * The "claimed by" line for a character card. Names the holders, because the
 * only way to find out used to be asking in the group, and a granted character
 * had no visible owner at all unless it happened to be a one-of-one.
 *
 * Caps at four names so a widely-owned character cannot push the ability text
 * off a phone screen.
 *
 * Stays quiet when the status line at the bottom of the card is already going to
 * say the same thing: a one-of-one whose bot-wide lock is set renders as
 * "🔒 One-of-one, already claimed by X" down there, and printing both read as a
 * stutter. The line still appears for a one-of-one that somebody owns while the
 * lock sits empty, because that is the case where the status line would
 * otherwise advertise it as unclaimed and still up for grabs.
 */
function claimedLine(db, character, viewerJid) {
  if (character.exclusive && getExclusiveSpinWinner(db, character.id)) return ''
  const { names, count, youOwn } = ownersOf(db, character.id, viewerJid)
  if (!count) return ''
  const shown = names.slice(0, 4)
  const more = names.length - shown.length
  const parts = []
  if (youOwn) parts.push('*you*')
  if (shown.length) parts.push(shown.map(n => `*${n}*`).join(', '))
  const tail = more > 0 ? ` _+${more} more_` : ''
  const label = character.exclusive || count === 1 ? 'Claimed by' : `Claimed by ${count} players:`
  return `👥 *${label}* ${parts.join(', ')}${tail}\n\n`
}

function renderOverview(player, pr, db) {
  const owned = player.ownedCharacters ?? []
  const equippedId = player.equippedCharacter ?? null

  const lines = characters.map(c => {
    const isOwned = owned.includes(c.id)
    const isEquipped = equippedId === c.id
    // Ownership is checked first, because a freeze is not a revocation: someone
    // who already holds the character keeps using it while the door is shut.
    if (isEquipped) return `  ⭐ *${c.emoji} ${c.name}* ${characterStars(c.stars)} · _equipped_`
    if (isOwned)     return `  ✅ *${c.emoji} ${c.name}* ${characterStars(c.stars)} · _owned (${pr}character equip ${c.id})_`
    // An owner freeze outranks every route line below it, season rows included.
    // The point of the row is to tell a player how to obtain the character, and
    // while it is frozen the honest answer is "you can't" — quoting 🪙5 or
    // `.season spin` just sends them at a command that will refuse them.
    if (isSpinLocked(c.id)) {
      return `  🧊 *${c.emoji} ${c.name}* ${characterStars(c.stars)} · _frozen by the owner · not obtainable yet_`
    }
    if (c.seasonId) {
      const route = c.characterTier === 'major'
        ? `${pr}season spin`
        : c.characterTier === 'peak'
          ? `${pr}season shop buy ${c.id}`
          : `${pr}season pass claim 50`
      return `  🌞 *${c.emoji} ${c.name}* ${characterStars(c.stars)} · _Season 1 ${c.characterTier}; ${route}_`
    }
    // How many other players hold it, shown on the locked lines only. A granted
    // character used to look identical to one nobody had ever obtained, so there
    // was no way to tell "unobtainable" from "someone already has this".
    const held = ownersOf(db, c.id, null).count
    const heldTag = held > 0 ? ` · 👥${held}` : ''
    // Spin-obtained characters now have TWO ways in, and the line has to show
    // both: the spin (gems, attempts) and the Mond price (guaranteed). The old
    // copy here said "never for sale", which stopped being true the moment
    // Monds existed — see lib/monds.js. Claim status still reads the same
    // exclusiveSpinWinners lock the spin commands write to.
    const mondPrice = mondPriceFor(c)
    if (mondPrice !== null) {
      const spinRoute = spinRouteFor(c.id, pr) ?? `${pr}character info ${c.id}`
      if (c.exclusive) {
        const winnerId = getExclusiveSpinWinner(db, c.id)
        if (winnerId) {
          const winner = getPlayer(db, winnerId)
          return `  🔒 *${c.emoji} ${c.name}* ${characterStars(c.stars)} · _claimed by ${winner?.name ?? 'another player'}_`
        }
        return `  🔒 *${c.emoji} ${c.name}* ${characterStars(c.stars)} · ⚡_one-of-one_ · ${MOND}${mondPrice} _or ${spinRoute}_`
      }
      return `  🔒 *${c.emoji} ${c.name}* ${characterStars(c.stars)} · ${MOND}${mondPrice} _or ${spinRoute}_${heldTag}`
    }
    return `  🔒 *${c.emoji} ${c.name}* ${characterStars(c.stars)} · _no way in yet_${heldTag}`
  })

  return (
    `👤 *Characters* _(${owned.length}/${characters.length} owned)_\n\n` +
    `${lines.join('\n')}\n\n` +
    `_Details: *${pr}character info <name>*_\n` +
    `_Buy outright: *${pr}character buy <name>*, paid in ${MOND} Monds only (*${pr}monds*)_\n` +
    `_Equip: *${pr}character equip <name>* · Unequip: *${pr}character unequip*_`
  )
}

function renderInfo(character, player, pr, db, viewerJid) {
  const owned = (player.ownedCharacters ?? []).includes(character.id)
  const equipped = player.equippedCharacter === character.id
  const winnerId = character.exclusive ? getExclusiveSpinWinner(db, character.id) : null
  const winner = winnerId ? getPlayer(db, winnerId) : null
  const spinRoute = spinRouteFor(character.id, pr)
  const route = spinRoute ?? `${pr}character info ${character.id}`
  const mondPrice = mondPriceFor(character)
  // Season route, so a season character's card stops reading "no way in yet"
  // while the overview list is pointing at a perfectly good route for it.
  const seasonRoute = !character.seasonId ? null
    : character.characterTier === 'major' ? `${pr}season spin`
    : character.characterTier === 'peak' ? `${pr}season shop buy ${character.id}`
    : `${pr}season pass claim 50`
  const status = equipped
    ? '⭐ _Equipped_'
    : owned
      ? `✅ _Owned. Equip with *${pr}character equip ${character.id}*_`
      : isSpinLocked(character.id)
        ? `🧊 _Frozen by the owner. The spin banner and the ${MOND} price are both closed, so ${character.name} cannot be obtained right now — by anyone, at any price._\n⏳ _Nothing to spend in the meantime; it will go live soon._`
        : winnerId
          ? `🔒 _One-of-one, already claimed by *${winner?.name ?? 'another player'}*. Not for sale at any price._`
          : seasonRoute
            ? `🌞 _Not owned. Season 1 ${character.characterTier}: obtain via *${seasonRoute}*. Monds cannot buy season content._`
            : mondPrice !== null
              ? (character.exclusive ? `⚡ _One-of-one, bot-wide. The first buyer takes it for good._\n` : '') +
                `${MOND} _Buy outright for ${MOND}*${mondPrice}*: *${pr}character buy ${character.id}*_\n` +
                `🎡 _Or spin for it with gems: *${route}*_\n` +
                `_Monds are the only currency a character can be bought with. Get them with *${pr}monds*._`
              : `🔒 _Not owned, and there is no way in yet._`

  const STAT_LABEL = { str: 'STR', agi: 'AGI', int: 'INT', def: 'DEF', lck: 'LCK', maxHp: 'Max HP', maxMp: 'Max MP' }
  const bonusLine = Object.entries(character.statBonuses ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${STAT_LABEL[k] ?? k.toUpperCase()}`)
    .join(' · ')

  // Yato's ascension is the one thing in the roster that REPLACES an ability
  // rather than adding to one, so his card has two states. Once
  // player.yatoAscended is set, Live Blast is gone for good and the card must
  // stop advertising it (see awakenYatoTrueForm() in lib/character-abilities.js).
  // Everyone else, and every un-ascended Yato owner, renders exactly as before.
  const ascended = character.id === 'yato' && character.trueForm && hasYatoTrueForm(player)
  const shownAbility = ascended ? character.trueForm : character.ability

  const caption =
    `${character.emoji} *${styled(character, character.name)}*\n${characterStars(character.stars)}\n_${character.description}_\n\n` +
    (ascended ? `⛩️ *TRUE FORM* _(permanent)_\n` : '') +
    `✨ *Ability: ${styled(character, shownAbility.name)}*\n_${shownAbility.flavor}_\n\n` +
    (bonusLine ? `📊 *While equipped:* ${bonusLine}\n\n` : '') +
    claimedLine(db, character, viewerJid) +
    (character.id === 'wither' ? `⚔️ *Command:* *${pr}cinderverdict* _(once per battle, no MP)_\n\n` : '') +
    (character.id === 'megumi' ? `⚔️ *Commands:* *${pr}domain-expansion* _(Chimera Shadow Garden, once per battle, no MP)_ · *${pr}mahoraga* _(the Divine General's Wheel)_\n\n` : '') +
    (character.id === 'xiao' ? `⚔️ *Command:* *${pr}thiefseye* _(once per battle, no MP. Steals the enemy's last named move and denies it for the rest of the fight)_\n\n` : '') +
    (character.id === 'minna' ? `⚔️ *Command:* *${pr}hollowexchange* _(once per battle, no MP. Trades HP percentages with the enemy, castable only at 40% health or lower, and never takes anyone below 40%)_\n\n` : '') +
    (character.id === 'yato' && !ascended ? `⚔️ *Command:* *${pr}live-blast* _(once per battle, no MP. Go live inside a dungeon with *${pr}stream start* first: the damage is your live viewer count, so 0 viewers is 0 damage)_\n\n` : '') +
    (ascended ? `⚔️ *Command:* *${pr}unwritten* _(every turn, no MP, no stream. Erases a tenth of the enemy's maximum HP for good, and stops at the last tenth: that part has to be killed the ordinary way)_\n🚫 *${pr}live-blast* is retired and cannot be used again.\n\n` : '') +
    (character.id === 'gojo' ? `⚔️ *Passive:* *Infinity* blunts every incoming hit and nullifies small ones, no command needed.\n⚔️ *Commands:* *${pr}hollowpurple* _(Blue and Red into Hollow Purple, once per battle, no MP)_ · *${pr}domainexpansion* _(opens Unlimited Void and locks the enemy down, once per battle, no MP. *${pr}unlimitedvoid* does the same thing)_\n\n` : '') +
    (character.id === 'aizen' ? `⚔️ *Passive:* *Kyōka Suigetsu* _(no command)_\nBlows aimed at him land on phantoms. Every one that misses teaches him another of the enemy's five senses — sight, hearing, touch, smell, taste — and at *5/5* the hypnosis is *complete*: every blow for the rest of the fight lands on nothing.\n⚔️ *Commands:* *${pr}kurohitsugi* _(Hadō #90, once per battle, no MP. A coffin of distorted time that bypasses DEF, never misses, and crushes hardest the closer to death the enemy already is)_ · *${pr}hougyoku* _(once per battle, no MP. Reforges his body, completes the hypnosis on the spot, and every stat surges for the rest of the battle)_\nWorks in dungeon runs, boss fights and duels. Wager duels carry no character powers.\n\n` : '') +
    (character.id === 'alexa' ? `⚔️ *Passive:* *Lovestruck* _(no command, any level)_\nThe enemy is weighed against you when the fight opens:\n  💗 it outclasses you: its hits lose *20%*\n  💞 you outclass it: its hits lose *70%*\n  💘 it was never close: its hits deal *nothing*\nIn duels, your rival's own character also stops working for their first *${ALEXA_AWE_TURNS}* turns.\nWorks on every monster, boss and character. Only *The End* is immune, and poison, burn and bleed still hurt you.\n\n` : '') +
    (character.id === 'orihime' ? `⚔️ *Passive:* *Shun Shun Rikka* _(no command)_\nHeals you every turn, rejects the first poison, burn or bleed each battle, and mends you after every win. Works in dungeons, boss fights, party fights and duels (halved in duels).\n\n` : '') +
    (character.id === 'naruto' ? `⚔️ *Command:* *${pr}kurama* _(once per battle, no MP. Summon the Nine Tails for one overwhelming strike. Baryon Mode burns a slice of Naruto's own health to hold the fusion, and whatever it hits has its lifespan torn away on top of the blow. Works in dungeons, boss fights and duels. In a party fight use *${pr}pk*)_\n\n` : '') +
    (character.id === 'witch_of_envy' ? `⚔️ *Passive:* *Wonders of You* _(no command, any level)_\nShe stands beside you and does not mind at first. The longer a fight drags on, the less patient she grows:\n  🖤 past *7* of your turns: she halves the enemy's current HP and warns them once\n  🖤 they stand down and defend for *3* turns: she looks away and the fight goes on\n  🖤 they refuse: she takes her final form, drains you to *1* HP, and a forsaken spell simply ends the battle in your favour\nHer curse lingers past a duel, taking *5%* of a beaten rival's total HP that never heals back. Works on every monster and boss. Only *The End* and *The Last Prayer* are immune.\n\n` : '') +
    status

  return caption
}

/**
 * `.character buy <name>` — the Mond path.
 *
 * Monds (lib/monds.js) are the only currency that can buy a character. Gems
 * cannot, and the gemPrice branch that used to live here is gone: gems buy
 * spin ATTEMPTS in the per-character *-spin.js plugins, and that difference is
 * the entire product. A gem holder rolls against a dead zone; a Mond holder
 * pays 5 and walks out with the character.
 *
 * A one-of-one exclusive stays one-of-one. Monds are a way to WIN the race for
 * an unclaimed one, not a way around the lock: the bot-wide claim moves to the
 * buyer, and every later buyer is refused no matter how many Monds they hold.
 *
 * The owner freeze is a different lock and it applies here too. `.lockspin
 * <name>` closes the Mond shop along with the banner (shopLockGate below), which
 * is the whole point of a freeze: the owner uses it to hold a character back for
 * a staged reveal, and a purchase route that ignored it would spoil the reveal
 * the moment the first player with 5 Monds typed `.character buy`. Checking it
 * FIRST, ahead of the season routing and the one-of-one claim, also means a
 * frozen character reads as frozen rather than as a routing problem or a price
 * problem, and nothing is spent on the way to that answer.
 *
 * Season characters are refused and routed, same as before. Monds deliberately
 * cannot skip a battle pass.
 */
async function handleBuy(ctx, character) {
  const pr = config.prefix
  // First line on purpose: a frozen character must be refused before the season
  // routing, the price lookup and the one-of-one claim, so the refusal is free.
  if (shopLockGate(ctx, character.id)) return
  if (character.seasonId) {
    const route = character.characterTier === 'major'
      ? `${pr}season spin`
      : character.characterTier === 'peak'
        ? `${pr}season shop buy ${character.id}`
        : `${pr}season pass claim 50`
    return ctx.reply(`🌞 *${character.name}* is Season content.\nUse *${route}* to obtain this character.`)
  }

  const price = mondPriceFor(character)
  if (price === null) {
    return ctx.reply(`🔒 *${character.name}* has no way in yet. Nothing has been spent.`)
  }

  // Read before the mutator so a refusal can name the holder. The authoritative
  // check is claimExclusiveSpinForPlayer() inside the mutator below, which is
  // the only thing that can settle two buyers racing for the same one-of-one.
  if (character.exclusive) {
    const heldBy = getExclusiveSpinWinner(ctx.db, character.id)
    if (heldBy && heldBy !== ctx.from) {
      const holder = getPlayer(ctx.db, heldBy)
      return ctx.reply(
        `🔒 *${character.name}* is a one-of-one exclusive, already claimed by *${holder?.name ?? 'another player'}*.\n` +
        `_Only one player can ever own this character, at any price._`,
      )
    }
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    player.ownedCharacters = player.ownedCharacters ?? []
    if (player.ownedCharacters.includes(character.id)) {
      outcome = { reason: 'owned' }
      return
    }

    player.wallet = player.wallet ?? {}
    const monds = getMonds(player)
    if (monds < price) {
      outcome = { reason: 'monds', monds }
      return
    }

    // Claim before charging. claimExclusiveSpinForPlayer() only mutates when it
    // wins, so a buyer who lost the race by milliseconds pays nothing.
    if (character.exclusive && !claimExclusiveSpinForPlayer(ctx.db, character.id, ctx.from)) {
      const heldBy = getExclusiveSpinWinner(ctx.db, character.id)
      outcome = { reason: 'claimed', claimedBy: getPlayer(ctx.db, heldBy)?.name ?? 'another player' }
      return
    }

    player.wallet.monds = roundMonds(monds - price)
    player.ownedCharacters.push(character.id)
    outcome = { reason: 'ok', remaining: player.wallet.monds }
  })

  if (outcome.reason === 'owned') {
    return ctx.reply(`✅ You already own *${character.name}*. Equip with *${pr}character equip ${character.id}*.`)
  }
  if (outcome.reason === 'claimed') {
    return ctx.reply(
      `🔒 *${character.name}* was claimed by *${outcome.claimedBy}* a moment before you.\n` +
      `_One-of-one, so that is final. Nothing has been spent._`,
    )
  }
  if (outcome.reason === 'monds') {
    const short = price - outcome.monds
    return ctx.reply(
      `${MOND} *Not enough Monds.*\n` +
      `*${character.name}* costs ${MOND}*${price}*. You hold ${MOND}*${fmtMonds(outcome.monds)}*, ` +
      `so you are ${MOND}*${fmtMonds(short)}* short.\n\n` +
      `_Monds are the only currency that buys a character. Get some with *${pr}monds*._\n` +
      `_Or spin for this one instead: ${spinRouteFor(character.id, pr) ?? `${pr}character info ${character.id}`}_`,
    )
  }

  const claimNote = character.exclusive
    ? `\n⚡ _One-of-one. It is locked to you bot-wide now, and nobody else can ever buy or spin it._`
    : ''
  return ctx.reply(
    `🛒 *Purchase complete!*\n━━━━━━━━━━━━━━━━━━━━\n` +
    `${character.emoji} *${character.name}* ${characterStars(character.stars)} is yours.\n` +
    `✨ *${character.ability?.name ?? 'Ability'}*\n\n` +
    `💰 Paid: ${MOND}*${price}*  ·  Left: ${MOND}*${fmtMonds(outcome.remaining)}*${claimNote}\n\n` +
    `_Equip with *${pr}character equip ${character.id}*._`,
  )
}

async function handleEquip(ctx, character) {
  const pr = config.prefix
  let outcome = null

  await updatePlayer(ctx.db, ctx.from, player => {
    const owned = player.ownedCharacters ?? []
    if (!owned.includes(character.id)) { outcome = { reason: 'not_owned' }; return }
    if (player.equippedCharacter === character.id) { outcome = { reason: 'already' }; return }

    // Swap stat bonuses the same way plugins/pet.js swaps an active pet:
    // strip the outgoing character's bonuses, then add the incoming one's.
    // Characters without a statBonuses block are a no-op here.
    const oldDef = player.equippedCharacter ? characterMap[player.equippedCharacter] : null
    if (oldDef?.statBonuses) applyEquipmentBonus(player, oldDef, -1)
    if (character.statBonuses) applyEquipmentBonus(player, character, +1)

    player.equippedCharacter = character.id
    syncEmptyVesselFlag(player) // Shunya ⇒ statusImmune; equipping anyone else clears it
    outcome = { reason: 'ok' }
  })

  if (outcome.reason === 'not_owned') {
    // A frozen character gets the freeze, not a shop window: this reply used to
    // hand out *both* routes it can no longer use, which reads as the bot
    // lying. No charge is implied here, so it is the plain notice rather than
    // shopLockGate()'s "nothing was charged" refusal.
    if (isSpinLocked(character.id)) {
      return ctx.reply(
        `🧊 *${character.name} is frozen.* You don't own it, and there is no way to get it right now — ` +
        `the spin banner and the ${MOND} price are both closed until the owner unlocks it.`,
      )
    }
    // Route-aware, and there are now two routes for most of the roster: the
    // Mond buy (guaranteed) and the character's own spin (gems, attempts).
    // Season characters have neither and fall through to the info card.
    const mondPrice = mondPriceFor(character)
    const spinRoute = isSpinOnly(character) ? spinRouteFor(character.id, pr) : null
    if (mondPrice !== null) {
      return ctx.reply(
        `❌ You don't own *${character.name}*.\n` +
        `${MOND} _Buy it outright for ${MOND}*${mondPrice}*: *${pr}character buy ${character.id}*_` +
        (spinRoute ? `\n🎡 _Or spin for it with gems: *${spinRoute}*_` : ''),
      )
    }
    return ctx.reply(`❌ You don't own *${character.name}*. See *${pr}character info ${character.id}*.`)
  }
  if (outcome.reason === 'already') {
    return ctx.reply(`⚠️ *${character.name}* is already equipped.`)
  }
  // Ascension never changes on equip, so reading the flag off ctx.player is safe
  // here even though the mutator above has already run. Without this, re-equipping
  // an ascended Yato would announce Live Blast, a move he can no longer use.
  const shown = (character.id === 'yato' && character.trueForm && hasYatoTrueForm(ctx.player))
    ? character.trueForm
    : character.ability
  const caption =
    `✅ *${character.emoji} ${character.name}* equipped!\n\n` +
    `✨ *Ability: ${shown.name}*\n_${shown.flavor}_`
  return sendCharacterArt(ctx, artFor(character, ctx.player), caption)
}

async function handleUnequip(ctx, player) {
  if (!player.equippedCharacter) return ctx.reply(`❌ You don't have an equipped character.`)

  const oldDef = characterMap[player.equippedCharacter]
  await updatePlayer(ctx.db, ctx.from, p => {
    const def = p.equippedCharacter ? characterMap[p.equippedCharacter] : null
    if (def?.statBonuses) applyEquipmentBonus(p, def, -1)
    p.equippedCharacter = null
    syncEmptyVesselFlag(p) // clears statusImmune when Shunya is removed
  })
  return ctx.reply(`✅ *${oldDef?.name ?? 'Character'}* is no longer equipped.`)
}

export default {
  name: 'character',
  aliases: ['characters', 'char'],
  category: 'account',
  requiresPlayer: true,
  description: `${config.prefix}character · browse, equip, and read up on characters`,

  async run(ctx) {
    const { player, args, db } = ctx
    const pr = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    if (sub === 'info') {
      const query = args.slice(1).join(' ')
      const character = findCharacter(query)
      if (!character) return ctx.reply(`❌ *"${query}"* isn't a character. See *${pr}character* for the list.`)
      return sendCharacterArt(ctx, artFor(character, player), renderInfo(character, player, pr, ctx.db, ctx.from))
    }

    if (sub === 'buy') {
      const query = args.slice(1).join(' ')
      const character = findCharacter(query)
      if (!character) return ctx.reply(`❌ *"${query}"* isn't a character. See *${pr}character* for the list.`)
      return handleBuy(ctx, character)
    }

    if (sub === 'equip') {
      const query = args.slice(1).join(' ')
      const character = findCharacter(query)
      if (!character) return ctx.reply(`❌ *"${query}"* isn't a character. See *${pr}character* for the list.`)
      return handleEquip(ctx, character)
    }

    if (sub === 'unequip') {
      return handleUnequip(ctx, player)
    }

    return ctx.reply(renderOverview(player, pr, ctx.db))
  },
}
