// @ts-check
const { CoreIndexStream } = require('../../lib/core-index-stream')
const { test } = require('tap')
const { once } = require('events')
const ram = require('random-access-memory')
const {
  create,
  replicate,
  generateFixture,
  throttledDrain,
} = require('../helpers')
const Hypercore = require('hypercore')

test('stream.core', async (t) => {
  const a = await create()
  const stream = new CoreIndexStream(a, () => new ram())
  t.same(stream.core, a)
})

test('destroy before open', async (t) => {
  let storageCreated = false
  function createStorage() {
    storageCreated = true
    return new ram()
  }
  const a = new Hypercore(() => new ram())
  const stream = new CoreIndexStream(a, createStorage)
  stream.destroy()
  await once(stream, 'close')
  t.equal(storageCreated, false, 'storage never created')
})

test('Indexes all items already in a core', async (t) => {
  const a = await create()
  const blocks = generateFixture(0, 10)
  const expected = blocksToExpected(blocks, a.key)
  await a.append(blocks)
  /** @type {any[]} */
  const entries = []
  const stream = new CoreIndexStream(a, () => new ram())
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'drained')
  t.same(entries, expected)
})

test("Empty core emits 'drained' event", async (t) => {
  const a = await create()
  const stream = new CoreIndexStream(a, () => new ram())
  stream.resume()
  stream.on('indexing', t.fail)
  await once(stream, 'drained')
  t.pass('Stream drained')
})

test('.remaining property is accurate', async (t) => {
  const totalBlocks = 100
  const a = await create()
  const blocks = generateFixture(0, totalBlocks)
  const expected = blocksToExpected(blocks, a.key)
  await a.append(blocks)
  /** @type {any[]} */
  const entries = []
  const stream = new CoreIndexStream(a, () => new ram())
  t.equal(stream.remaining, totalBlocks)
  stream.on('data', (entry) => {
    entries.push(entry)
    stream.setIndexed(entry.index)
    t.equal(stream.remaining + entries.length, totalBlocks)
  })
  await once(stream, 'drained')
  t.equal(stream.remaining, 0)
  t.same(entries, expected)
})

test('Indexes items appended after initial index', async (t) => {
  const a = await create()
  const blocks = generateFixture(0, 10)
  /** @type {any[]} */
  const entries = []
  const stream = new CoreIndexStream(a, () => new ram())
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'drained')
  t.same(entries, [], 'no entries before append')
  const expected = blocksToExpected(blocks, a.key)
  await a.append(blocks)
  await once(stream, 'drained')
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

  const stream = new CoreIndexStream(b, () => new ram())
  /** @type {Buffer[]} */
  const entries = []
  stream.on('data', (entry) => entries.push(entry.block))
  await throttledDrain(stream)

  t.same(entries, blocks.slice(5, 20))
  const range2 = b.download({ start: 50, end: 60 })
  await Promise.all([range2.downloaded(), throttledDrain(stream)])

  t.same(
    entries.sort(),
    [...blocks.slice(5, 20), ...blocks.slice(50, 60)].sort()
  )
})

test("'indexing' and 'drained' events are paired", async (t) => {
  const a = await create()
  const blocks = generateFixture(0, 100)
  await a.append(blocks)
  const b = await create(a.key)

  replicate(a, b, t)

  const stream = new CoreIndexStream(b, () => new ram())
  let indexingEvents = 0
  let idleEvents = 0
  stream.on('indexing', () => {
    t.equal(indexingEvents, idleEvents)
    indexingEvents++
  })
  stream.on('drained', () => {
    idleEvents++
    t.equal(indexingEvents, idleEvents)
  })
  stream.resume()

  const range = b.download({ start: 0, end: a.length })
  await Promise.all([range.downloaded(), throttledDrain(stream)])

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
  await b.update({ wait: true })
  const range1 = b.download({ start: 0, end: b.length })
  await range1.downloaded()

  const stream = new CoreIndexStream(b, () => new ram())
  /** @type {Buffer[]} */
  const entries = []
  stream.on('data', (entry) => entries.push(entry.block))
  await throttledDrain(stream)

  t.same(entries, blocks1)
  const range2 = b.download({ start: 50, end: -1 })
  const blocks2 = generateFixture(50, 100)
  await a.append(blocks2)
  await throttledDrain(stream)
  range2.destroy()

  t.same(entries.sort(), [...blocks1, ...blocks2].sort())
})

test('Maintains index state', async (t) => {
  const a = await create()
  /** @type {any[]} */
  const entries = []
  const storage = ram.reusable()
  const stream1 = new CoreIndexStream(a, storage)
  stream1.on('data', (entry) => {
    entries.push(entry.block)
    stream1.setIndexed(entry.index)
  })

  const blocks = generateFixture(0, 1000)
  await a.append(blocks.slice(0, 500))
  await throttledDrain(stream1)
  t.same(entries.sort(), blocks.slice(0, 500).sort())
  stream1.destroy()
  await once(stream1, 'close')
  await a.append(blocks.slice(500, 1000))
  const stream2 = new CoreIndexStream(a, storage)
  stream2.on('data', (entry) => {
    entries.push(entry.block)
    stream2.setIndexed(entry.index)
  })
  await throttledDrain(stream2)
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
