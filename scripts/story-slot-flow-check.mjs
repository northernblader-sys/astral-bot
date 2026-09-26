/**
 * Drives plugins/story.js end to end with a fake socket, so the group-visible
 * text of the whole Story Mode flow can be read in one place.
 * Run: RUNTIME_DATA_DIR=/tmp/astral-runtime node scripts/story-slot-flow-check.mjs
 */
// Collapse the narrative pacing so a 90-beat chapter doesn't take 7 minutes.
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, 0)

const story = (await import('../plugins/story.js')).default
const { getStorySlot, listStorySlots } = await import('../lib/moderation-state.js')

const GROUP = '120363000000000000@g.us'
const OWNER = '2347062301848@s.whatsapp.net'
const OTHER = '234000000102@s.whatsapp.net'
const users = {
  [OWNER]: { id: OWNER, name: 'Owner', storyProgress: null, premium: { active: false } },
  [OTHER]: { id: OTHER, name: 'Reader', storyProgress: null, premium: { active: false } },
}
const db = { data: { users } }

const log = []
function makeCtx(from, args, cmd = 'story') {
  const replies = []
  return {
    db, from, args, cmd, isGroup: true, platform: 'whatsapp',
    player: users[from], sender: GROUP, msg: { key: { id: 'X' } },
    reply: async (t) => { replies.push(String(t)); log.push(`   [reply] ${String(t)}`) },
    logger: { warn: (...a) => console.log('   [warn]', ...a) },
    sock: {
      sendMessage: async (to, payload) => {
        const text = payload?.text ?? payload?.caption ?? '[image]'
        log.push(`   [send${payload?.mentions?.length ? ' +mentions' : ''}] ${text}`)
        return { key: { id: 'Y' } }
      },
    },
    replies,
  }
}

async function step(label, from, args, cmd = 'story') {
  log.length = 0
  console.log(`\n━━━ ${label}  →  .${cmd} ${args.join(' ')}`)
  const ctx = makeCtx(from, args, cmd)
  await story.run(ctx)
  for (const line of log) console.log(line)
  const slots = await listStorySlots()
  console.log(`   [state] storySlots = ${JSON.stringify(slots)}`)
}

await step('1. volumes list (works before Story Mode is on)', OWNER, [])
await step('2. enter while Story Mode is OFF', OWNER, ['enter', 'beyond the astral'])
await step('3. slot check while OFF', OWNER, ['slot'])
await step('4. owner turns it ON', OWNER, ['on'])
await step('5. enter a volume (intro + slot claim)', OWNER, ['enter', 'beyond the astral'])
await step('6. slot check while held', OTHER, ['slot'])
await step('7. second player tries to start', OTHER, ['start'])
await step('8. owner starts the chapter', OWNER, ['start'])
await step('9. admin frees the slot', OWNER, ['clear'])
await step('10. slot check after clear', OTHER, ['slot'])
await step('11. owner takes it again', OWNER, ['start'])
await step('12. Story Mode OFF drops the holder', OWNER, ['off'])
await step('13. slot check after off', OTHER, ['slot'])
