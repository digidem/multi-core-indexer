// @ts-check
const { IndexStream } = require('../lib/core-index-stream')
const { test, only } = require('tap')
const { once } = require('events')
const ram = require('random-access-memory')
const { create, replicate, eventFlush } = require('./helpers')

test('Indexes all items already in a core', async (t) => {
  const core = await create()
  const blocks = []
  for (let i = 0; i < 10; i++) {
    blocks.push(Buffer.from(`block${i}`))
  }
  const expected = blocksToExpected(blocks, core.key)
  await core.append(blocks)
  /** @type {any[]} */
  const entries = []
  const stream = new IndexStream(core, ram(), { highWaterMark: 6 * 4 })
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'indexed')
  t.same(entries, expected)
})

test('Indexes items appended after initial index', async (t) => {
  const core = await create()
  const blocks = []
  for (let i = 0; i < 10; i++) {
    blocks.push(Buffer.from(`block${i}`))
  }
  /** @type {any[]} */
  const entries = []
  const stream = new IndexStream(core, ram(), { highWaterMark: 6 * 4 })
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'indexed')
  t.same(entries, [], 'no entries before append')
  const expected = blocksToExpected(blocks, core.key)
  await core.append(blocks)
  await once(stream, 'indexed')
  t.same(entries, expected)
})

test('Readable stream from sparse hypercore', async (t) => {
  const a = await create()
  const blocks = []
  for (let i = 0; i < 100; i++) {
    blocks.push(Buffer.from(`block${i.toString().padStart(3, '0')}`))
  }
  await a.append(blocks)
  const b = await create(a.key)

  replicate(a, b, t)

  const range = b.download({ start: 5, end: 20 })
  await range.downloaded()

  const stream = new IndexStream(b, ram(), { highWaterMark: 8 * 4 })
  /** @type {string[]} */
  const entries = []
  stream.on('data', (entry) => entries.push(entry.block))
  await once(stream, 'indexed')

  t.same(entries, blocks.slice(5, 20))
  const range2 = b.download({ start: 50, end: 60 })
  await Promise.all([range2.downloaded(), once(stream, 'indexed')])

  t.same(
    entries.sort(),
    [...blocks.slice(5, 20), ...blocks.slice(50, 60)].sort()
  )
})

/**
 *
 * @param {Buffer[]} blocks
 * @param {Buffer} key
 * @returns
 */
function blocksToExpected(blocks, key) {
  return blocks.map((block, i) => ({
    key,
    block,
    index: i,
  }))
}
