/**
 * Drives the story CHOICE path: answers choice beats until the detour option
 * comes up (ch1 raw beat 76, option "stay_home"), then checks that handing the
 * slot back is announced to the group.
 * Run: RUNTIME_DATA_DIR=/tmp/astral-runtime3 node scripts/story-choice-flow-check.mjs
 */
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, 0)

const storyMod = await import('../plugins/story.js')
const story = storyMod.default
const { getPlayer, updatePlayer } = await import('../lib/player-repo.js')
const { listStorySlots } = await import('../lib/moderation-state.js')
const { getVolume, getChapter, getResolvedBeats, clearDetourLock, startDetourLock } =
  await import('../lib/story-engine.js')

const GROUP = '120363000000000000@g.us'
const OWNER = '2347062301848@s.whatsapp.net'
const users = {
  [OWNER]: {
    id: OWNER, name: 'Owner', storyProgress: null, premium: { active: false },
    wallet: { solars: 0, gems: 0 }, xp: 0, level: 1, stats: { str: 10, agi: 10, int: 10, def: 10, lck: 5 },
    classId: 'warrior', raceId: 'human', maxHp: 100, hp: 100, maxMp: 20, mp: 20,
    inventory: [], ownedCharacters: [], storyFlags: [],
  },
}
const db = { data: { users } }

function makeCtx(from, args = [], cmd = 'story') {
  const sent = []
  return {
    db, from, args, cmd, isGroup: true, platform: 'whatsapp',
    player: getPlayer(db, from), sender: GROUP, msg: { key: { id: 'X' } },
    reply: async (t) => { sent.push(String(t)) },
    logger: { warn: () => {} },
    sock: { sendMessage: async (to, p) => { sent.push(p?.text ?? p?.caption ?? '[image]'); return { key: {} } } },
    sent,
  }
}

const show = async (label, sent) => {
  console.log(`\n━━━ ${label}`)
  for (const s of sent) console.log(`   [send] ${s}`)
  console.log(`   [state] slots = ${JSON.stringify(await listStorySlots())}`)
}

/** The beat the player is sitting on, resolved exactly the way the plugin does. */
function currentBeat(from, volumeId) {
  const player = getPlayer(db, from)
  const progress = player.storyProgress?.volumes?.[volumeId]
  if (!progress) return null
  const volume = getVolume(volumeId)
  const chapter = getChapter(volume, progress.currentChapter)
  const beats = getResolvedBeats(volume, player, volumeId, chapter)
  return { beat: beats[progress.currentBeat], index: progress.currentBeat, chapter }
}

const VOLUME = 'beyond-the-astral'
await story.run(makeCtx(OWNER, ['on']))
const enter = makeCtx(OWNER, ['enter', 'beyond the astral'])
await story.run(enter)
await show('enter (intro + claim)', enter.sent.filter(s => /slot|Chapter/i.test(s)))

// Walk choice by choice. Answer "1" normally, and "2" on the detour choice so
// the detour branch actually fires.
for (let i = 0; i < 14; i++) {
  await story.run(makeCtx(OWNER, ['start']))
  const cur = currentBeat(OWNER, VOLUME)
  if (!cur?.beat || cur.beat.type !== 'choice') { console.log('\n(no pending choice — stopping)'); break }
  const detourIdx = (cur.beat.options ?? []).findIndex(o => o.detour)
  const answer = detourIdx >= 0 ? String(detourIdx + 1) : '1'

  const ctx = makeCtx(OWNER, [], 'story')
  const consumed = await storyMod.handleStoryChoiceReply(ctx, getPlayer(db, OWNER), answer)
  const tookDetour = ctx.sent.some(s => /story start\* again in/.test(s))
  await show(`answer "${answer}"${detourIdx >= 0 ? ' (DETOUR option)' : ''} consumed=${consumed}`, ctx.sent.slice(-6))
  if (tookDetour) break
}

// The detour lock the plugin just set — show that .story start now refuses and
// what it says, since that is the message the player actually reads next.
const lock = makeCtx(OWNER, ['start'])
await story.run(lock)
await show('.story start while the detour lock is running', lock.sent)
