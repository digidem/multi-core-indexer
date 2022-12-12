// @ts-check
const { CoreIndexStream } = require('../../lib/core-index-stream')
const { test } = require('tap')
const { once } = require('events')
const ram = require('random-access-memory')
const {
  create,
  replicate,
  generateFixture,
  throttledIdle,
} = require('../helpers')

test('hypercore key', async (t) => {
  const a = await create()
  const stream = new CoreIndexStream(a, new ram())
  t.same(stream.key, a.key)
})

test('Indexes all items already in a core', async (t) => {
  const a = await create()
  const blocks = generateFixture(0, 10)
  const expected = blocksToExpected(blocks, a.key)
  await a.append(blocks)
  /** @type {any[]} */
  const entries = []
  const stream = new CoreIndexStream(a, new ram())
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'idle')
  t.same(entries, expected)
})

test('.remaining property is accurate', async (t) => {
  const totalBlocks = 100
  const a = await create()
  const blocks = generateFixture(0, totalBlocks)
  const expected = blocksToExpected(blocks, a.key)
  await a.append(blocks)
  /** @type {any[]} */
  const entries = []
  const stream = new CoreIndexStream(a, new ram())
  t.equal(stream.remaining, totalBlocks)
  stream.on('data', (entry) => {
    entries.push(entry)
    t.equal(stream.remaining + entries.length, totalBlocks)
  })
  await once(stream, 'idle')
  t.equal(stream.remaining, 0)
  t.same(entries, expected)
})

test('Indexes items appended after initial index', async (t) => {
  const a = await create()
  const blocks = generateFixture(0, 10)
  /** @type {any[]} */
  const entries = []
  const stream = new CoreIndexStream(a, new ram())
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'idle')
  t.same(entries, [], 'no entries before append')
  const expected = blocksToExpected(blocks, a.key)
  await a.append(blocks)
  await once(stream, 'idle')
  t.same(entries, expected)
})

test('Readable stream from sparse hypercore', async (t) => {
  const a = await create()
  const blocks = generateFixture(0, 100)
  await a.append(blocks)
  const b = await create(a.key)

  replicate(a, b, t)

  const range = b.download({ start: 5, end: 20 })
  await range.downloaded()

  const stream = new CoreIndexStream(b, new ram())
  /** @type {Buffer[]} */
  const entries = []
  stream.on('data', (entry) => entries.push(entry.block))
  await throttledIdle(stream)

  t.same(entries, blocks.slice(5, 20))
  const range2 = b.download({ start: 50, end: 60 })
  await Promise.all([range2.downloaded(), throttledIdle(stream)])

  t.same(
    entries.sort(),
    [...blocks.slice(5, 20), ...blocks.slice(50, 60)].sort()
  )
})

test("'indexing' and 'idle' events are paired", async (t) => {
  const a = await create()
  const blocks = generateFixture(0, 100)
  await a.append(blocks)
  const b = await create(a.key)

  replicate(a, b, t)

  const stream = new CoreIndexStream(b, new ram())
  let indexingEvents = 0
  let idleEvents = 0
  stream.on('indexing', () => {
    t.equal(indexingEvents, idleEvents)
    indexingEvents++
  })
  stream.on('idle', () => {
    idleEvents++
    t.equal(indexingEvents, idleEvents)
  })
  stream.resume()

  const range = b.download({ start: 0, end: a.length })
  await Promise.all([range.downloaded(), throttledIdle(stream)])

  t.equal(indexingEvents, idleEvents)
  // This is just to check that we're actually testing something
  t.ok(indexingEvents > 2)
})

test('Appends from a replicated core are indexed', async (t) => {
  const a = await create()
  const blocks1 = generateFixture(0, 50)
  await a.append(blocks1)
  const b = await create(a.key)

  replicate(a, b, t)
  await b.update()
  const range1 = b.download({ start: 0, end: b.length })
  await range1.downloaded()

  const stream = new CoreIndexStream(b, new ram())
  /** @type {Buffer[]} */
  const entries = []
  stream.on('data', (entry) => entries.push(entry.block))
  await throttledIdle(stream)

  t.same(entries, blocks1)
  const range2 = b.download({ start: 50, end: -1 })
  const blocks2 = generateFixture(50, 100)
  await a.append(blocks2)
  await throttledIdle(stream)
  range2.destroy()

  t.same(entries.sort(), [...blocks1, ...blocks2].sort())
})

test('Maintains index state', async (t) => {
  const a = await create()
  /** @type {any[]} */
  const entries = []
  const storage = new ram()
  const stream1 = new CoreIndexStream(a, storage)
  stream1.on('data', (entry) => entries.push(entry.block))

  const blocks = generateFixture(0, 1000)
  await a.append(blocks.slice(0, 500))
  await throttledIdle(stream1)
  t.same(entries.sort(), blocks.slice(0, 500).sort())
  stream1.destroy()
  await once(stream1, 'close')
  await a.append(blocks.slice(500, 1000))
  const stream2 = new CoreIndexStream(a, storage)
  stream2.on('data', (entry) => entries.push(entry.block))
  await throttledIdle(stream2)
  t.same(entries.sort(), blocks.sort())
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
