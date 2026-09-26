/**
 * jobs.js — a steady, low-risk way to earn Solars outside of dungeons.
 *
 * Commands:
 *   .jobs                 — list available jobs
 *   .job apply <name>     — apply for a job (must meet level requirement)
 *   .job resign           — quit your current job (resets job level progress)
 *   .work                 — do a shift at your job (30 min cooldown)
 *
 * Design notes:
 *  - Payouts are intentionally small (5–20 Solars per shift). Given the
 *    game's economy, 400 Solars is already a meaningful sum — jobs are meant
 *    to be a slow, reliable trickle, not a way to skip dungeon grinding.
 *  - Job level (1–10) increases pay by +8% per level and unlocks a small
 *    stat bonus every 3 levels, so sticking with one job long-term pays off.
 *  - Shifts can roll a small mini-event (see JOBS[...].events / rollJobEvent)
 *    that scales pay up/down or grants a bonus crafting material — most
 *    shifts roll no event at all, this is texture, not the main payout.
 *  - No external data file required — jobs are defined inline below so this
 *    plugin drops straight into /plugins with zero other changes needed.
 */
import { config } from '../config.js'
import { sendImage } from '../lib/image.js'
import { updatePlayer } from '../lib/player-repo.js'
import { hasInventoryRoom } from '../lib/inventory-limits.js'
import { allItems } from '../lib/game-data.js'

const itemMap = Object.fromEntries(allItems.map((i) => [i.id, i]))

const WORK_COOLDOWN_MS = 30 * 60 * 1000 // 30 minutes
const JOB_SHIFTS_PER_LEVEL = 8          // shifts needed to level up the job
const MAX_JOB_LEVEL = 10

// ── Job definitions ─────────────────────────────────────────────────────
// `events` — optional per-job mini-events layered on top of the base pay
// roll. Rolled once per shift (see rollJobEvent below): each entry has a
// relative `weight` (no weight given = falls back to the implicit
// "nothing special happens" outcome, which always exists so the total
// pool never forces an event to fire), a `line` appended under the shift
// narrative, and an effect — `payMult` scales the shift's earnings,
// `bonusItem` adds a small material drop tied into the existing mining
// materials so a job shift occasionally feeds the crafting economy too,
// not just Solars.
const JOBS = {
  farmhand: {
    name: 'Farmhand', emoji: '🌾', levelReq: 1,
    basePay: [5, 9], statBonus: 'def', bonusAmt: 1,
    desc: 'Tend crops and livestock on the outskirts of Astral Town.',
    narratives: [
      'You spend the shift hauling feed and mending fences.',
      'A long day in the fields, but the harvest was good.',
      'You help herd a stubborn flock back into the pen.',
    ],
    events: [
      { weight: 10, payMult: 1.5, line: '🐄 A prize cow won the county fair thanks to your care — the farmer tips you extra!' },
      { weight: 10, bonusItem: 'leather_scrap', bonusQty: 2, line: '🧵 You salvage some leftover leather scrap while mending the pens.' },
      { weight: 6,  payMult: 0.6, line: '🌧️ A sudden storm cuts the shift short.' },
    ],
  },
  fisher: {
    name: 'Fisher', emoji: '🎣', levelReq: 1,
    basePay: [5, 10], statBonus: 'lck', bonusAmt: 1,
    desc: 'Cast lines off the old pier and sell the catch at market.',
    narratives: [
      'You reel in a decent haul as the sun sets over the pier.',
      'The fish weren\'t biting much, but you make do.',
      'A lucky cast nets you a few extra coins at the fish market.',
    ],
    events: [
      { weight: 10, payMult: 1.6, line: '🐟 You hook a massive catch that the whole market comes to see!' },
      { weight: 8,  bonusItem: 'leather_scrap', bonusQty: 1, line: '🎣 You salvage a scrap of old net leather while untangling your line.' },
      { weight: 6,  payMult: 0.6, line: '⛈️ Rough water keeps the boats docked most of the shift.' },
    ],
  },
  courier: {
    name: 'Courier', emoji: '📦', levelReq: 3,
    basePay: [8, 13], statBonus: 'agi', bonusAmt: 1,
    desc: 'Run deliveries between Astral Town and nearby outposts.',
    narratives: [
      'You sprint the delivery route and make it back before dark.',
      'A tense moment dodging wild dogs, but the package arrives intact.',
      'You take the shortcut through the old road — shaves ten minutes off.',
    ],
    events: [
      { weight: 10, payMult: 1.5, line: '⚡ You beat every delivery deadline — the guild pays a speed bonus!' },
      { weight: 8,  bonusItem: 'wood_plank', bonusQty: 2, line: '🪵 A grateful client hands you some spare lumber from their cart.' },
      { weight: 6,  payMult: 0.6, line: '🐕 A pack of wild dogs forces a long detour, eating into the shift.' },
    ],
  },
  miner: {
    name: 'Miner', emoji: '⛏️', levelReq: 5,
    basePay: [10, 16], statBonus: 'str', bonusAmt: 1,
    desc: 'Chip away at the eastern quarry for ore and loose gems.',
    narratives: [
      'You break through a promising vein and fill your cart.',
      'Hard, dusty work, but the foreman pays on time.',
      'You find a small pocket of ore the last shift missed.',
    ],
    events: [
      { weight: 10, bonusItem: 'iron_ore', bonusQty: 3, line: '⛏️ You strike a rich vein and haul out extra iron ore!' },
      { weight: 8,  payMult: 1.5, line: '💰 The foreman pays a bonus for a record-breaking cart.' },
      { weight: 6,  payMult: 0.6, line: '🪨 A minor cave-in costs you most of the shift clearing rubble.' },
    ],
  },
  scribe: {
    name: 'Scribe', emoji: '📜', levelReq: 8,
    basePay: [12, 18], statBonus: 'int', bonusAmt: 1,
    desc: 'Copy guild ledgers and old tomes for the Astral Archive.',
    narratives: [
      'You finish transcribing a stack of guild ledgers.',
      'A tricky passage in an old tome takes most of the shift to decode.',
      'The archivist compliments your neat handwriting — and pays extra.',
    ],
    events: [
      { weight: 10, payMult: 1.6, line: '📖 You decode a rare passage the archivist has needed for years — generously rewarded!' },
      { weight: 6,  payMult: 0.6, line: '🖋️ A spilled inkwell ruins an afternoon\'s work; you have to redo it.' },
    ],
  },
  merchant: {
    name: 'Merchant', emoji: '🪙', levelReq: 12,
    basePay: [14, 20], statBonus: 'all', bonusAmt: 1,
    desc: 'Work a stall in the market row, trading goods for a cut of profit.',
    narratives: [
      'A steady stream of customers keeps your stall busy all shift.',
      'You strike a good bargain reselling surplus goods.',
      'Slow foot traffic today, but a regular buys you out anyway.',
    ],
    events: [
      { weight: 10, payMult: 1.7, line: '🤝 You strike a deal with a traveling caravan — huge profit margins today!' },
      { weight: 6,  payMult: 0.6, line: '🧾 A miscounted ledger means you eat the loss on a bad trade.' },
    ],
  },
}

/**
 * Roll a job's mini-event for this shift. Returns null (no event — the
 * common case) or { payMult?, bonusItem?, bonusQty?, line }. An implicit
 * "no event" weight is added so the specific events above only fire a
 * fraction of the time — NO_EVENT_WEIGHT relative to each job's own
 * weights, so shifts still feel eventful without an event every time.
 */
const NO_EVENT_WEIGHT = 74

function rollJobEvent(job) {
  const events = job.events ?? []
  if (!events.length) return null
  const total = events.reduce((s, e) => s + e.weight, 0) + NO_EVENT_WEIGHT
  let roll = Math.random() * total
  for (const e of events) {
    roll -= e.weight
    if (roll <= 0) return e
  }
  return null // landed in the NO_EVENT_WEIGHT slice
}

function randRange([lo, hi]) {
  return Math.floor(Math.random() * (hi - lo + 1)) + lo
}

function payAtLevel(job, jobLevel) {
  const [lo, hi] = job.basePay
  const mult = 1 + (jobLevel - 1) * 0.08 // +8% per job level
  return { lo: Math.round(lo * mult), hi: Math.round(hi * mult) }
}

function statCapFor(player) {
  if (player.isKami) return 2000
  if (player.evolved) return 1000
  if (player.level >= 100) return 1000
  if (player.level >= 50) return 500
  return 300
}

// ── .jobs — list ─────────────────────────────────────────────────────────
function listJobs(ctx) {
  const p = config.prefix
  const player = ctx.player

  let msg = `┌─────────────────────┐\n`
  msg += `│   💼 *JOB BOARD*   │\n`
  msg += `└─────────────────────┘\n\n`

  for (const [id, job] of Object.entries(JOBS)) {
    const canApply = player.level >= job.levelReq
    const isYours  = player.job === id
    const { lo, hi } = payAtLevel(job, player.job === id ? (player.jobLevel || 1) : 1)
    const statusIcon = isYours ? '⭐ *YOUR JOB*' : canApply ? '🟢 open' : `🔒 Lv.${job.levelReq}+`

    msg += `${job.emoji} *${job.name}* — ${statusIcon}\n`
    msg += `   ☀️ ${lo}-${hi} solars/shift · +${job.statBonus === 'all' ? 'ALL' : job.statBonus.toUpperCase()}\n`
    msg += `   _${job.desc}_\n\n`
  }

  msg += `━━━━━━━━━━━━━━━━━━━━━\n`
  if (player.job) {
    const myJob = JOBS[player.job]
    msg += `📋 Current: *${myJob?.emoji} ${myJob?.name}* (Lv.${player.jobLevel || 1}/${MAX_JOB_LEVEL})\n\n`
  }
  msg += `*${p}job apply <name>* — apply for a job\n`
  msg += `*${p}work* — do a shift _(30 min cooldown)_\n`
  msg += `*${p}job resign* — quit your job`

  return ctx.reply(msg)
}

// ── .job apply <name> ────────────────────────────────────────────────────
async function applyJob(ctx) {
  const p = config.prefix
  const search = ctx.args?.slice(1).join(' ')?.toLowerCase()
  if (!search) return ctx.reply(`❓ Usage: *${p}job apply <job name>*\nExample: *${p}job apply fisher*`)

  const entry = Object.entries(JOBS).find(([id, j]) =>
    j.name.toLowerCase().includes(search) || id.includes(search),
  )
  if (!entry) return ctx.reply(`❌ No job matching *"${search}"*.\nUse *${p}jobs* to see the full list.`)

  const [jobId, job] = entry

  await updatePlayer(ctx.db, ctx.from, async player => {
    if (player.level < job.levelReq) {
      await ctx.reply(`❌ *${job.emoji} ${job.name}* requires *Level ${job.levelReq}*.\nYou're Level ${player.level} — keep grinding!`)
      return player
    }
    if (player.job === jobId) {
      await ctx.reply(`⚠️ You're already working as a *${job.emoji} ${job.name}*!`)
      return player
    }

    const prevJob = player.job ? JOBS[player.job]?.name : null
    player.job = jobId
    player.jobLevel = 1
    player.jobShifts = 0

    const { lo, hi } = payAtLevel(job, 1)
    let msg = `┌─────────────────────┐\n│  ${job.emoji} *JOB ACCEPTED*  │\n└─────────────────────┘\n\n`
    if (prevJob) msg += `_(Resigned from ${prevJob})_\n\n`
    msg += `📋 *${job.name}*\n_${job.desc}_\n\n`
    msg += `☀️ Pay: *${lo}-${hi} solars* per shift\n`
    msg += `📊 Perk: *+${job.statBonus === 'all' ? 'ALL stats' : job.statBonus.toUpperCase()}* every 3 job levels\n`
    msg += `⏱️ Cooldown: *30 minutes* between shifts\n\n`
    msg += `_Use *${p}work* to start your first shift!_`
    await ctx.reply(msg)
    return player
  })
}

// ── .job resign ──────────────────────────────────────────────────────────
async function resignJob(ctx) {
  const p = config.prefix
  await updatePlayer(ctx.db, ctx.from, async player => {
    if (!player.job) {
      await ctx.reply(`❌ You don't have a job to resign from.`)
      return player
    }
    const job = JOBS[player.job]
    const jobName = job ? `${job.emoji} ${job.name}` : player.job
    player.job = null
    player.jobLevel = 0
    player.jobShifts = 0
    await ctx.reply(
      `📤 *Resigned from ${jobName}.*\n\n` +
      `_Job level progress has been reset._\n\n` +
      `_Use *${p}job apply* anytime to start a new job._`,
    )
    return player
  })
}

// ── .work ────────────────────────────────────────────────────────────────
async function work(ctx) {
  const p = config.prefix

  await updatePlayer(ctx.db, ctx.from, async player => {
    if (player.inDungeon) { await ctx.reply(`⚠️ You can't work while in a dungeon!`); return player }
    if (player.inBattle)  { await ctx.reply(`⚠️ You can't work during a battle!`); return player }
    if (!player.job) {
      await ctx.reply(
        `💼 *You don't have a job yet.*\n\n` +
        `Use *${p}jobs* to browse openings\n` +
        `Use *${p}job apply <name>* to get hired.`,
      )
      return player
    }

    const job = JOBS[player.job]
    if (!job) {
      player.job = null
      await ctx.reply(`❌ That job no longer exists. Please pick a new one with *${p}jobs*.`)
      return player
    }

    const now = Date.now()
    const nextAvailable = player.lastWorkAt ? player.lastWorkAt + WORK_COOLDOWN_MS : 0
    if (now < nextAvailable) {
      const remainMs = nextAvailable - now
      const mins = Math.ceil(remainMs / 60000)
      await ctx.reply(
        `⏳ *Still tired from your last shift.*\n\n` +
        `Next shift available in: *${mins} min*\n\n` +
        `_Rest up, then get back to work!_ 💤`,
      )
      return player
    }

    const jobLevel = player.jobLevel || 1
    const { lo, hi } = payAtLevel(job, jobLevel)
    let goldEarned = randRange([lo, hi])

    // Mini-event — see rollJobEvent/JOBS[...].events. Most shifts roll no
    // event at all (NO_EVENT_WEIGHT dominates the pool); when one does
    // fire it either scales this shift's pay or grants a small bonus
    // material, so shifts have some texture beyond a flat payout range.
    const event = rollJobEvent(job)
    let bonusGranted = null
    if (event) {
      if (event.payMult) goldEarned = Math.max(1, Math.round(goldEarned * event.payMult))
      if (event.bonusItem && hasInventoryRoom(player, event.bonusQty ?? 1)) {
        const qty = event.bonusQty ?? 1
        player.inventory = [...(player.inventory ?? []), ...Array(qty).fill(event.bonusItem)]
        const itemName = itemMap[event.bonusItem]?.name ?? event.bonusItem
        bonusGranted = `${itemName} ×${qty}`
      }
    }

    player.lastWorkAt = now
    // Recorded so plugins/rob.js can base a robbery amount on the robber's
    // own last payout (never on the victim's balance — see rob.js header).
    player.lastWorkAmount = goldEarned

    const narrative = job.narratives[Math.floor(Math.random() * job.narratives.length)]

    // Stat perk every 3 job levels
    let statLine = ''
    if (jobLevel % 3 === 0) {
      const cap = statCapFor(player)
      if (job.statBonus === 'all') {
        let any = false
        for (const s of ['str', 'agi', 'int', 'def', 'lck']) {
          if (player.stats[s] < cap) { player.stats[s] = Math.min(cap, player.stats[s] + job.bonusAmt); any = true }
        }
        if (any) statLine = `\n📊 *ALL STATS +${job.bonusAmt}* _(job perk!)_`
      } else if (player.stats[job.statBonus] < cap) {
        player.stats[job.statBonus] = Math.min(cap, player.stats[job.statBonus] + job.bonusAmt)
        statLine = `\n📊 *${job.statBonus.toUpperCase()} +${job.bonusAmt}* _(job perk!)_`
      }
    }

    // Job level progress
    player.jobShifts = (player.jobShifts || 0) + 1
    let levelUpLine = ''
    if (player.jobShifts >= JOB_SHIFTS_PER_LEVEL && jobLevel < MAX_JOB_LEVEL) {
      player.jobLevel = jobLevel + 1
      player.jobShifts = 0
      const next = payAtLevel(job, player.jobLevel)
      levelUpLine = `\n\n🎊 *${job.name} Level Up! → Lv.${player.jobLevel}*\n☀️ Pay now *${next.lo}-${next.hi} solars/shift*!`
    }

    if (!player.wallet) player.wallet = {}
    player.wallet.solars = (player.wallet.solars ?? 0) + goldEarned

    let msg = `┌─────────────────────┐\n`
    msg += `│ ${job.emoji} *SHIFT COMPLETE* │\n`
    msg += `└─────────────────────┘\n\n`
    msg += `_${narrative}_\n`
    if (event) msg += `_${event.line}_\n`
    msg += `\n☀️ Earned: *+${goldEarned} solars*\n`
    if (bonusGranted) msg += `📦 Bonus find: *${bonusGranted}*\n`
    msg += `💰 Balance: *${player.wallet.solars.toLocaleString()} solars*\n`
    msg += `🔨 Job Lv: *${player.jobLevel || 1}/${MAX_JOB_LEVEL}* _(${player.jobShifts}/${JOB_SHIFTS_PER_LEVEL} shifts to next)_`
    msg += statLine
    msg += levelUpLine
    msg += `\n\n⏳ _Next shift available in 30 minutes_`

    await sendImage(ctx, 'work_card.jpg',
      `*Astral Jobs*\n${job.emoji} ${job.name} shift complete — +${goldEarned} solars\n\n${msg}`)
    return player
  })
}

// Exported so plugins/work.js can reuse it without duplicating job data.
export { work, JOBS }

// ── Plugin export ─────────────────────────────────────────────────────────
export default {
  name: 'jobs',
  aliases: ['job'],
  category: 'economy',
  requiresPlayer: true,
  description: 'View, apply for, and manage your job',

  async run(ctx) {
    const sub = ctx.args[0]?.toLowerCase()
    if (sub === 'apply') return applyJob(ctx)
    if (sub === 'resign' || sub === 'quit') return resignJob(ctx)
    return listJobs(ctx)
  },
}
