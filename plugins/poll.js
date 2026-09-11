/**
 * poll.js — .poll <question> | <option> | <option> ... / .vote <#> / .pollresults
 *
 * A text poll, not a native WhatsApp poll message. Native polls exist in
 * Baileys but their votes arrive as separate encrypted vote-update events
 * that have to be decrypted and reconciled against the poll message — a
 * whole subsystem. A numbered list plus `.vote 2` gives the same outcome and
 * works identically on every client.
 *
 * One active poll per group; a new .poll replaces the previous one.
 */
import { getPoll, setPoll, castVote, closePoll } from '../lib/moderation-state.js'
import { isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'
import { NOT_GROUP } from '../lib/group-helpers.js'
import { config } from '../config.js'

const MAX_OPTIONS = 10
const MIN_OPTIONS = 2

function renderPoll(poll, { final = false } = {}) {
  const p = config.prefix
  const total = Object.keys(poll.votes).length
  const tally = poll.options.map((_, i) =>
    Object.values(poll.votes).filter(v => v === i).length)
  const top = Math.max(...tally, 0)

  const lines = poll.options.map((opt, i) => {
    const n = tally[i]
    const pct = total ? Math.round((n / total) * 100) : 0
    const filled = Math.round(pct / 10)
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)
    const crown = final && n === top && n > 0 ? ' 👑' : ''
    return `*${i + 1}.* ${opt}${crown}\n     ${bar} ${pct}% _(${n})_`
  })

  return (
    `${final ? '🏁 *POLL CLOSED*' : '📊 *POLL*'}\n─────────────────────\n` +
    `*${poll.question}*\n\n` +
    lines.join('\n') +
    `\n\n👥 *${total}* vote${total === 1 ? '' : 's'}` +
    (final ? '' : `\n\n_Vote with *${p}vote <number>* — e.g. ${p}vote 1_`)
  )
}

export default {
  name:        'poll',
  aliases:     ['vote', 'pollresults', 'endpoll'],
  category:    'utility',
  description: 'Run a group poll (.poll Question | Option A | Option B)',
  subcommands: [
    { cmd: '<q> | <a> | <b>', desc: 'start a poll (replaces any running one)' },
    { cmd: 'vote <#>',        desc: 'cast your vote' },
    { cmd: 'pollresults',     desc: 'show the current tally' },
    { cmd: 'endpoll',         desc: 'admin only — close the poll' },
  ],

  async run(ctx) {
    const { args, reply, sender, from, isGroup, body } = ctx
    const p = config.prefix
    if (!isGroup) return reply(NOT_GROUP)

    // ── .vote <#> ─────────────────────────────────────────────────────────
    if (ctx.cmd === 'vote') {
      const poll = await getPoll(sender)
      if (!poll || poll.closed) return reply(`❌ No poll is running. Start one with *${p}poll Question | A | B*`)

      const choice = parseInt(args[0], 10)
      if (!Number.isFinite(choice) || choice < 1 || choice > poll.options.length) {
        return reply(`❌ Pick a number from *1* to *${poll.options.length}*.\n\n${renderPoll(poll)}`)
      }

      const changed = poll.votes[from] != null
      const ok = await castVote(sender, from, choice - 1)
      if (!ok) return reply(`❌ Couldn't record that vote — the poll may have just closed.`)

      return reply(
        `✅ ${changed ? 'Vote changed to' : 'Voted for'} *${choice}. ${poll.options[choice - 1]}*.\n` +
        `_${p}pollresults to see the tally._`,
      )
    }

    // ── .pollresults ──────────────────────────────────────────────────────
    if (ctx.cmd === 'pollresults') {
      const poll = await getPoll(sender)
      if (!poll) return reply(`❌ No poll has been run here yet.`)
      return reply(renderPoll(poll, { final: poll.closed }))
    }

    // ── .endpoll ──────────────────────────────────────────────────────────
    if (ctx.cmd === 'endpoll') {
      const poll = await getPoll(sender)
      if (!poll || poll.closed) return reply(`❌ No poll is running.`)
      // Either an admin, or whoever started it.
      if (poll.by !== from && !(await isGroupOrBotOwnerOrMod(ctx))) {
        return reply(`❌ Only a group admin or the person who started the poll can close it.`)
      }
      const closed = await closePoll(sender)
      return reply(renderPoll(closed, { final: true }))
    }

    // ── .poll <question> | <a> | <b> ──────────────────────────────────────
    // Parsed off `body` rather than `args`, so options keep their spacing.
    const raw = body.slice(config.prefix.length).replace(/^\S+\s*/, '')
    const parts = raw.split('|').map(s => s.trim()).filter(Boolean)

    if (parts.length < MIN_OPTIONS + 1) {
      const running = await getPoll(sender)
      return reply(
        `❌ *Usage:* ${p}poll Question | Option A | Option B\n` +
        `_Up to ${MAX_OPTIONS} options, separated by |_\n\n` +
        (running && !running.closed ? `A poll is already running:\n\n${renderPoll(running)}` : ''),
      )
    }

    const [question, ...options] = parts
    if (options.length > MAX_OPTIONS) {
      return reply(`❌ Too many options — *${MAX_OPTIONS}* is the maximum.`)
    }

    const poll = {
      question: question.slice(0, 300),
      options:  options.map(o => o.slice(0, 100)),
      votes:    {},
      by:       from,
      at:       Date.now(),
      closed:   false,
    }
    await setPoll(sender, poll)

    return reply(renderPoll(poll))
  },
}
