import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { loadPlugins, dispatch } from '../lib/plugin-manager.js'
import { withBattleCinematic } from '../lib/battle-presentation.js'

test('real dispatcher freezes both players before mutations, permits other duels and admin recovery', async () => {
  const tempRoot = join(process.cwd(), 'tmp')
  await mkdir(tempRoot, { recursive: true })
  const dir = await mkdtemp(join(tempRoot, 'cinematic-dispatch-'))
  try {
    await writeFile(join(dir, 'action.js'), `export default { name: 'scene-test-action', category: 'combat', run: ctx => { ctx.mutations.push(ctx.from) } }`)
    await writeFile(join(dir, 'admin.js'), `export default { name: 'scene-test-admin', category: 'admin', run: ctx => { ctx.mutations.push('recovery') } }`)
    await loadPlugins(relative(process.cwd(), dir))
    const db = {}, mutations = [], actor = { db, from: 'a', player: { battleState: { opponentJid: 'b' } }, mutations }
    const opponent = { ...actor, from: 'b', player: { battleState: { opponentJid: 'a' } } }
    const stranger = { ...actor, from: 'c', player: { battleState: { opponentJid: 'd' } } }
    await withBattleCinematic(actor, async () => {
      assert.equal(await dispatch('scene-test-action', actor), true)
      assert.equal(await dispatch('scene-test-action', opponent), true)
      assert.deepEqual(mutations, [])
      await dispatch('scene-test-action', stranger)
      await dispatch('scene-test-admin', actor)
      assert.deepEqual(mutations, ['c', 'recovery'])
    })
    await dispatch('scene-test-action', opponent)
    assert.deepEqual(mutations, ['c', 'recovery', 'b'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
