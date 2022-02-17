// @ts-check
const { IndexStream } = require('../lib/core-index-stream')
const { test } = require('tap')
const ram = require('random-access-memory')
const { create, replicate, eventFlush } = require('./helpers')

test('Readable stream from sparse hypercore', async (t) => {
  const a = await create()
  await a.append(['a', 'b', 'c', 'd', 'e'])
  const b = await create(a.key)

  replicate(a, b, t)

  const range = b.download({ start: 3, end: 5 })
  await range.downloaded()

  const stream = new IndexStream(b, ram())
  /** @type {string[]} */
  const chunks = []
  stream.on('data', (chunk) => chunks.push(chunk.toString()))

  await once(stream, 'index-state', 'idle')

  t.same(chunks, ['d', 'e'])
  const range2 = b.download({ blocks: [1] })
  await Promise.all([range2.downloaded(), once(stream, 'index-state', 'idle')])

  t.same(chunks, ['d', 'e', 'b'])
})

/**
 * Like events.once, but awaits a return value from an event
 *
 * @param {import('events').EventEmitter} emitter
 * @param {string} event
 * @param {any} value
 * @returns {Promise<void>}
 */
async function once(emitter, event, value) {
  return new Promise((resolve) => {
    emitter.on(event, function eventHandler(val) {
      if (val === value) {
        emitter.off(event, eventHandler)
        resolve()
      }
    })
  })
}
