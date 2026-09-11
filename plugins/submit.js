/**
 * submit.js — group-add request pipeline + basic group-membership admin.
 *
 * Player-facing:
 *   .submit <group invite link>   — DM or group. Sends the link to the mod
 *                                   GC for review, replies with a short id
 *                                   (e.g. S001) and tells them to wait.
 *                                   Requires a group of 70+ members (checked
 *                                   live via the invite link before it's
 *                                   ever forwarded). The submitter is DMed
 *                                   the moment a mod decides either way —
 *                                   accepted or rejected, with the reason if
 *                                   one was given.
 *   .gcstatus <id>                 — DM or group. Anyone can check where a
 *                                    submission id currently stands.
 *
 * Owner/mod-facing (run from the mod GC or anywhere — these act on a
 * submission id, not on "the current group"):
 *   .join <link or submission id>  — bot joins that group. Bare submission
 *                                    id (e.g. "S001") looks up and accepts
 *                                    a pending .submit; a raw link joins
 *                                    directly without needing a prior
 *                                    submission.
 *   .reject <submission id> [reason] — declines a pending submission, tells
 *                                       the submitter why.
 *   .gcqueue [pending|accepted|rejected] — the full submission queue with
 *                                    mini ids, defaulting to everything;
 *                                    pass a status to filter to just that
 *                                    bucket.
 *   .gclist                         — every group the bot is currently in.
 *
 * Owner/mod-facing (run INSIDE the group being acted on):
 *   .leave                          — bot leaves the current group.
 *
 * Owner-only (run INSIDE the group you want requests routed to):
 *   .modgc                          — sets/replaces the mod GC. Whatever
 *                                     group was set before stops receiving
 *                                     submissions; this one starts.
 *
 * See lib/mod-gc.js for the two small JSON stores this plugin reads/writes
 * (the mod-GC pointer and the full submission history).
 */
import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'
import {
  getModGc, setModGc,
  getAllSubmissions, addPendingSubmission, findSubmission, decideSubmission, nextSubmissionId,
  parseInviteCode,
} from '../lib/mod-gc.js'

const MIN_MEMBERS = 70

const STATUS_EMOJI = { pending: '⏳', accepted: '✅', rejected: '❌' }

const TERMS = (
  `📋 *Submission terms:*\n` +
  `  • Group must have *${MIN_MEMBERS}+ members* to qualify.\n` +
  `  • Only *dungeon* can be enabled in your group — Pokémon and card ` +
  `spawns are *never* enabled outside the official group.\n` +
  `  • Join the official group if you want spawns.\n` +
  `  • Want a spawn-enabled group of your own instead? That costs ` +
  `☀️10,000 Solars/week to maintain — miss a week and spawns simply ` +
  `stop in your group until it's renewed.`
)

export default {
  name:           'submit',
  aliases:        [],
  category:       'group',
  requiresPlayer: false,
  platforms:      ['whatsapp'], // group invite links / join / leave — Baileys-only
  description:    'Submit a group for the bot to join; mod/owner group-add pipeline',

  async run(ctx) {
    const { args, reply } = ctx
    const p = config.prefix

    if (args.length === 0) {
      return reply(
        `📨 *SUBMIT A GROUP*\n` +
        `Usage: *${p}submit <group invite link>*\n` +
        `Check status: *${p}gcstatus <id>*\n\n${TERMS}`,
      )
    }

    return handleSubmit(ctx)
  },
}

// ── .submit <link> ────────────────────────────────────────────────────────

async function handleSubmit(ctx) {
  const { args, reply, sock, from } = ctx
  const p = config.prefix

  const link = args[0]
  const code = parseInviteCode(link)
  if (!code) {
    return reply(`❌ That doesn't look like a WhatsApp group invite link.\nExpected something like *https://chat.whatsapp.com/AbCdEfGh*.`)
  }

  const modGc = await getModGc()
  if (!modGc) {
    return reply(`⚠️ No mod GC is configured yet — this bot's admin needs to run *${p}modgc* first. Try again later.`)
  }

  // Preview the invite to check member count before forwarding anything —
  // no point sending a mod a group that fails the 70-member floor outright.
  let preview
  try {
    preview = await sock.groupGetInviteInfo(code)
  } catch (err) {
    return reply(`❌ Couldn't read that invite link — it may be expired or invalid. (${err.message})`)
  }

  const memberCount = preview.size ?? preview.participants?.length ?? 0
  if (memberCount < MIN_MEMBERS) {
    return reply(
      `❌ *${preview.subject ?? 'That group'}* has ${memberCount} members — ` +
      `needs *${MIN_MEMBERS}+* to be submitted.`,
    )
  }

  const id = await nextSubmissionId()
  const submitterName = ctx.player?.name ?? 'Unknown'
  await addPendingSubmission({
    id,
    submittedBy:   from,
    submitterName,
    link,
    inviteCode:    code,
    groupName:     preview.subject ?? '(unnamed)',
    memberCount,
    submittedAt:   Date.now(),
  })

  await sock.sendMessage(modGc, {
    text:
      `📨 *New group submission* — *${id}*\n` +
      `👥 Group: *${preview.subject ?? '(unnamed)'}* (${memberCount} members)\n` +
      `🙋 Submitted by: *${submitterName}*\n` +
      `🔗 ${link}\n\n` +
      `Approve: *${config.prefix}join ${id}*\n` +
      `Reject:  *${config.prefix}reject ${id}*`,
  }).catch(() => {})

  return reply(
    `✅ Submitted *${preview.subject ?? 'group'}* (${memberCount} members)!\n` +
    `🆔 Your submission id is *${id}* — hang tight, a mod will review it.\n` +
    `Check anytime with *${p}gcstatus ${id}*.\n\n${TERMS}`,
  )
}

// ── .gcstatus <id> — anyone can check a submission's current status ─────

export async function handleGcStatus(ctx) {
  const { args, reply } = ctx
  const id = args[0]
  if (!id) return reply(`Usage: *${config.prefix}gcstatus <submission id>*`)

  const s = await findSubmission(id)
  if (!s) return reply(`❌ No submission found with id *"${id}"*.`)

  const lines = [`${STATUS_EMOJI[s.status]} *${s.id}* — *${s.groupName}* (${s.memberCount} members)`,
    `Status: *${s.status.toUpperCase()}*`]
  if (s.status === 'rejected' && s.reason) lines.push(`Reason: ${s.reason}`)
  return reply(lines.join('\n'))
}

// ── .join <link | submission id> ────────────────────────────────────────

export async function handleJoin(ctx) {
  const { args, reply, sock } = ctx
  if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(`❌ Owner/mod only.`)

  const target = args[0]
  if (!target) return reply(`Usage: *${config.prefix}join <invite link or submission id>*`)

  let code, submission = null
  if (/^chat\.whatsapp\.com\//i.test(target) || target.includes('chat.whatsapp.com')) {
    code = parseInviteCode(target)
  } else {
    const found = await findSubmission(target)
    if (!found) return reply(`❌ No submission *"${target}"* — and that's not a valid invite link either.`)
    if (found.status !== 'pending') {
      return reply(`⚠️ Submission *${found.id}* was already *${found.status}* — nothing to do.`)
    }
    code = found.inviteCode
    submission = found
  }
  if (!code) return reply(`❌ Couldn't parse an invite code from that.`)

  try {
    await sock.groupAcceptInvite(code)
  } catch (err) {
    return reply(`❌ Couldn't join that group — ${err.message}`)
  }

  if (submission) {
    await decideSubmission(submission.id, 'accepted')
    await sock.sendMessage(submission.submittedBy, {
      text: `🎉 Your group submission *${submission.id}* (${submission.groupName}) was *accepted*! The bot has joined.\n\n${TERMS}`,
    }).catch(() => {})
  }

  return reply(`✅ Joined${submission ? ` — *${submission.groupName}* (submission ${submission.id})` : ''}.`)
}

// ── .reject <submission id> [reason] ────────────────────────────────────

export async function handleReject(ctx) {
  const { args, reply, sock } = ctx
  if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(`❌ Owner/mod only.`)

  const id = args[0]
  if (!id) return reply(`Usage: *${config.prefix}reject <submission id> [reason]*`)

  const existing = await findSubmission(id)
  if (!existing) return reply(`❌ No submission *"${id}"*.`)
  if (existing.status !== 'pending') {
    return reply(`⚠️ Submission *${id}* was already *${existing.status}* — nothing to do.`)
  }

  const reason = args.slice(1).join(' ') || null
  const submission = await decideSubmission(id, 'rejected', reason)

  await sock.sendMessage(submission.submittedBy, {
    text:
      `❌ Your group submission *${submission.id}* (${submission.groupName}) was *rejected*` +
      `${reason ? `: ${reason}` : '.'}`,
  }).catch(() => {})

  return reply(`✅ Rejected submission *${id}* (${submission.groupName}).`)
}

// ── .gcqueue [pending|accepted|rejected] — full submission history ─────

export async function handleGcQueue(ctx) {
  const { args, reply } = ctx
  if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(`❌ Owner/mod only.`)

  const filter = (args[0] ?? '').toLowerCase()
  const validFilters = ['pending', 'accepted', 'rejected']
  if (filter && !validFilters.includes(filter)) {
    return reply(`Usage: *${config.prefix}gcqueue [pending|accepted|rejected]* _(no filter shows everything)_`)
  }

  const all = await getAllSubmissions()
  const list = filter ? all.filter(s => s.status === filter) : all
  if (list.length === 0) {
    return reply(filter ? `📭 No *${filter}* submissions.` : `📭 No submissions yet.`)
  }

  const lines = list
    .sort((a, b) => b.submittedAt - a.submittedAt)
    .map(s => `${STATUS_EMOJI[s.status]} *${s.id}* — ${s.groupName} (${s.memberCount}) · by ${s.submitterName} · *${s.status}*`)

  const counts = validFilters.map(f => `${STATUS_EMOJI[f]} ${f}: ${all.filter(s => s.status === f).length}`).join(' · ')

  return reply(
    `📋 *SUBMISSION QUEUE*${filter ? ` — ${filter}` : ''}\n${counts}\n\n${lines.join('\n')}`,
  )
}

// ── .leave — run inside the group to leave ──────────────────────────────

export async function handleLeave(ctx) {
  const { reply, sock, sender, isGroup } = ctx
  if (!isGroup) return reply(`❌ Run this inside the group you want the bot to leave.`)
  if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(`❌ Owner/mod only.`)

  await reply(`👋 Leaving this group.`).catch(() => {})
  try {
    await sock.groupLeave(sender)
  } catch (err) {
    return reply(`❌ Couldn't leave — ${err.message}`)
  }
}

// ── .gclist — every group the bot is currently in ───────────────────────

export async function handleGcList(ctx) {
  const { reply, sock } = ctx
  if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(`❌ Owner/mod only.`)

  let groups
  try {
    groups = await sock.groupFetchAllParticipating()
  } catch (err) {
    return reply(`❌ Couldn't fetch group list — ${err.message}`)
  }

  const entries = Object.values(groups)
  if (entries.length === 0) return reply(`📭 Bot isn't in any groups.`)

  const lines = entries
    .sort((a, b) => (b.participants?.length ?? 0) - (a.participants?.length ?? 0))
    .map((g, i) => `${i + 1}. *${g.subject ?? '(unnamed)'}* — ${g.participants?.length ?? 0} members`)

  return reply(`📋 *In ${entries.length} group${entries.length === 1 ? '' : 's'}:*\n\n${lines.join('\n')}`)
}

// ── .modgc — owner-only, run inside the group to route submissions to ──

export async function handleModGc(ctx) {
  const { reply, sender, isGroup } = ctx
  if (!isGroup) return reply(`❌ Run *${config.prefix}modgc* inside the group you want submissions sent to.`)
  if (!isOwnerJid(ctx.from)) return reply(`❌ Owner only.`)

  await setModGc(sender)
  return reply(`✅ This group is now the mod GC — *.submit* requests will be sent here from now on.`)
}
