import assert from 'node:assert/strict'
import test from 'node:test'
import { createInboundScheduler, inboundMessageKey } from '../lib/inbound-scheduler.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function fakeMessage({ remoteJid = '123@g.us', participant = 'user@s.whatsapp.net', id = 'id' } = {}) {
  return { key: { remoteJid, participant, id } }
}

test('different senders are not blocked by a slow sender', async () => {
  const started = []
  const scheduler = createInboundScheduler({
    concurrency: 2,
    handle: async ({ id, delay = 0 }) => {
      started.push(id)
      await wait(delay)
      return id
    },
  })

  const slow = scheduler.enqueue({ id: 'slow', delay: 80 }, 'slow')
  // Let the slow task occupy one worker before enqueueing the fast task.
  await wait(5)
  const fast = scheduler.enqueue({ id: 'fast' }, 'fast')

  assert.equal(await fast, 'fast')
  assert.deepEqual(started.slice(0, 2), ['slow', 'fast'])
  assert.equal(await slow, 'slow')
  scheduler.close()
})

test('messages from one sender remain FIFO', async () => {
  const order = []
  const scheduler = createInboundScheduler({
    concurrency: 4,
    handle: async ({ id, delay = 0 }) => {
      order.push(`start:${id}`)
      await wait(delay)
      order.push(`end:${id}`)
      return id
    },
  })

  const first = scheduler.enqueue({ id: 'first', delay: 30 }, 'same-sender')
  const second = scheduler.enqueue({ id: 'second' }, 'same-sender')

  assert.equal(await first, 'first')
  assert.equal(await second, 'second')
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second'])
  scheduler.close()
})

test('a handler failure does not wedge the sender lane', async () => {
  const seen = []
  const scheduler = createInboundScheduler({
    handle: async ({ id }) => {
      seen.push(id)
      if (id === 'bad') throw new Error('boom')
      return id
    },
  })

  assert.equal(await scheduler.enqueue({ id: 'bad' }, 'sender'), undefined)
  assert.equal(await scheduler.enqueue({ id: 'good' }, 'sender'), 'good')
  assert.deepEqual(seen, ['bad', 'good'])
  assert.equal(scheduler.stats.failed, 1)
  scheduler.close()
})

test('closing drops queued work but lets the running task finish', async () => {
  let release
  const blocker = new Promise(resolve => { release = resolve })
  const scheduler = createInboundScheduler({
    concurrency: 1,
    handle: async ({ id }) => {
      if (id === 'running') await blocker
      return id
    },
  })

  const running = scheduler.enqueue({ id: 'running' }, 'one')
  await wait(5)
  const queued = scheduler.enqueue({ id: 'queued' }, 'two')
  scheduler.close('test')
  assert.equal(await queued, false)
  release()
  assert.equal(await running, 'running')
  assert.equal(scheduler.closed, true)
})

test('Baileys LID/phone attributes share a sender lane', () => {
  const first = inboundMessageKey(fakeMessage({ participant: '12345@lid', id: 'a' }))
  const second = inboundMessageKey({ key: { remoteJid: 'other@g.us', participantPn: '2348012345678', id: 'b' } })
  const dm = inboundMessageKey({ key: { remoteJid: '2348012345678@s.whatsapp.net', senderPn: '2348012345678', id: 'c' } })

  assert.equal(first, 'sender:12345@lid')
  assert.equal(second, 'phone:2348012345678')
  assert.equal(dm, second)
})
