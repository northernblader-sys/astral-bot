/**
 * wisdom.js - Echidna's Book of Wisdom: the world's memory, read aloud.
 *
 * Her default ability per data/characters.json. Purely informational, works
 * in and out of battle, and never touches a wallet or an HP bar - the safest
 * shape a readout can have:
 *
 *   PvE battle  -> reads the enemy: HP, attack, defense, the wealth it
 *                  carries, and every status on it.
 *   PvP duel    -> reads the opponent: HP, class, equipped character, their
 *                  statuses - and, because she is the Witch of Greed, exactly
 *                  how much they are carrying in coin and gems.
 *   Out of fight-> reads the holder's own page: level, wallet, equipped
 *                  character, the child of the sanctuary if there is one,
 *                  and one line of what the Gospel says about today.
 *
 * Requires Echidna equipped. No charge, no cost - the book is always open
 * for her, and through her.
 *
 * Usage: <prefix>wisdom
 */
import { config } from '../config.js'
import { getPlayer } from '../lib/player-repo.js'
import { hpBar } from '../lib/combat-engine.js'
import { hasEchidna, ECHIDNA_CHARACTER_ID } from '../lib/character-abilities.js'
import { characterMap } from '../lib/game-data.js'
import { fmtGems } from '../lib/format.js'
import { describeChild, childName } from '../lib/echidna-child.js'

const RULE = '─────────────'

const OPENERS = [
  'The Tome of Wisdom opens of its own accord. Pages turn like weather.',
  'She does not look anything up. The book already knows she wants this page.',
  "The world's memory parts politely. It has no choice; she has read it before.",
]

const FORTUNES = [
  '"You will come into money soon. I have already decided it is partly mine."',
  '"A door you ignored will open. Walk through it with your pockets ready."',
  '"Someone is thinking of you fondly. Their wallet is thinking of you too."',
  '"The next thing you lose, you will lose on purpose. Interesting."',
  '"Rain where you stand, gold where you are going. Keep walking."',
  '"You will be offered something free today. Nothing is free. Take it anyway."',
]

function pick(arr, seed) {
  return arr[Math.abs(Number(seed) || 0) % arr.length]
}

function statusList(entity) {
  const fx = (entity?.activeEffects ?? []).filter(e => (e.remaining ?? 0) > 0)
  if (!fx.length) return '_none - clean page_'
  return fx.map(e => `\`${e.type}${e.stat ? `(${e.stat})` : ''} ×${e.remaining}\``).join(' · ')
}

export default {
  name: 'wisdom',
  aliases: ['bookofwisdom', 'tome', 'tomeofwisdom', 'read'], // 'book' itself belongs to gambits.js
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}wisdom: Echidna reads the Book of Wisdom - the enemy's whole page in battle, your own page out of it`,

  async run(ctx) {
    const player = ctx.player
    if (!player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)
    if (!hasEchidna(player)) {
      return ctx.reply(
        `📖 *The book stays shut.*\n${RULE}\n` +
        `_The Book of Wisdom belongs to *Echidna, the Witch of Greed* - equip her first (*${config.prefix}character equip ${ECHIDNA_CHARACTER_ID}*)._`,
      )
    }

    const opener = pick(OPENERS, (player.name?.length ?? 0) + Date.now() % 7)
    const bs = player.battleState

    // ── In a duel: the opponent's page, wallet included ────────────────────
    if (bs?.type === 'pvp' && bs?.opponentJid) {
      const opp = getPlayer(ctx.db, bs.opponentJid)
      if (!opp) return ctx.reply(`📖 _The page comes back blank - your opponent is gone._`)
      const oppChar = opp.equippedCharacter ? characterMap[opp.equippedCharacter] : null
      const lines = [
        `📖✨ *BOOK OF WISDOM* ✨📖`,
        RULE,
        `_${opener}_`,
        ``,
        `👤 *${opp.name}*`,
        `❤️ ${hpBar(opp.hp, opp.maxHp)}  (${Math.max(0, Math.floor(opp.hp ?? 0))}/${opp.maxHp})`,
        `⚔️ Class: *${opp.class ?? 'unknown'}*  ·  Lv *${opp.level ?? 1}*`,
        oppChar ? `🎭 Companion: *${oppChar.name}*` : `🎭 Companion: _none on the page_`,
        `🌀 Statuses: ${statusList(opp)}`,
        ``,
        `🪙 Carrying: *☀️${Math.floor(opp.wallet?.solars ?? 0)} Solars*  ·  💎${fmtGems(opp.wallet?.gems ?? 0)} Gems`,
        ``,
        `_🍵 "...and now you know exactly how much they are worth. You are welcome." _`,
      ]
      return ctx.reply(lines.join('\n'))
    }

    // ── In a PvE fight: the enemy's page ────────────────────────────────────
    if (player.inBattle && bs?.enemy) {
      const e = bs.enemy
      const lines = [
        `📖✨ *BOOK OF WISDOM* ✨📖`,
        RULE,
        `_${opener}_`,
        ``,
        `${e.emoji ?? '👾'} *${e.name}*`,
        `❤️ ${hpBar(e.hp, e.maxHp)}  (${Math.max(0, Math.floor(e.hp ?? 0))}/${Math.floor(e.maxHp ?? 0)})`,
        typeof e.atk === 'number' ? `⚔️ ATK *${Math.floor(e.atk)}*  ·  🛡️ DEF *${Math.floor(e.def ?? 0)}*` : `⚔️ _Its numbers refuse to sit still._`,
        `🪙 Carries: *☀️${Math.floor(e.solars ?? e.rewards?.solars ?? 0)} Solars*`,
        `🌀 Statuses: ${statusList(e)}`,
        ``,
        `_🍵 "Everything it owns is already written down. Shall we correct the ownership?" - open the Gospel with *${config.prefix}greed*._`,
      ]
      return ctx.reply(lines.join('\n'))
    }

    // ── Out of battle: the holder's own page ────────────────────────────────
    const child = describeChild(player.echidnaChild)
    const lines = [
      `📖✨ *BOOK OF WISDOM* ✨📖`,
      RULE,
      `_${opener}_`,
      ``,
      `👤 *${player.name}* - Lv *${player.level ?? 1}* (${player.xp ?? 0} XP)`,
      `🪙 Purse: *☀️${Math.floor(player.wallet?.solars ?? 0)} Solars*  ·  💎${fmtGems(player.wallet?.gems ?? 0)} Gems`,
      `🎭 Companion: *${player.equippedCharacter ? (characterMap[player.equippedCharacter]?.name ?? player.equippedCharacter) : 'none'}*`,
      child ? `${child.emoji} Child of the sanctuary: *${child.name}* - ${child.stage}${child.stage === 'grown' ? ' (steals beside her in battle)' : ''}` : ``,
      ``,
      `🔮 _${pick(FORTUNES, Math.floor(Date.now() / 60000) + (player.level ?? 1))}_`,
    ]
    return ctx.reply(lines.filter(Boolean).join('\n'))
  },
}
