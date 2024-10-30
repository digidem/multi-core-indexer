// @ts-check
const { CoreIndexStream } = require('../../lib/core-index-stream')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('events')
const ram = require('random-access-memory')
const {
  create,
  replicate,
  generateFixture,
  throttledDrain,
} = require('../helpers')
const Hypercore = require('hypercore')

test('stream.core', async () => {
  const a = await create()
  const stream = new CoreIndexStream(a, () => new ram(), false)
  assert.deepEqual(stream.core, a)
})

test('destroy before open', async () => {
  let storageCreated = false
  function createStorage() {
    storageCreated = true
    return new ram()
  }
  const a = new Hypercore(() => new ram())
  const stream = new CoreIndexStream(a, createStorage, false)
  stream.destroy()
  await once(stream, 'close')
  assert.equal(storageCreated, false, 'storage never created')
})

test('unlink before open', async () => {
  let storageCreated = false
  function createStorage() {
    storageCreated = true
    return new ram()
  }
  const core = new Hypercore(() => new ram())
  const stream = new CoreIndexStream(core, createStorage, false)
  await stream.unlink()
  assert.equal(storageCreated, true, 'storage was created')
})

test('Indexes all items already in a core', async () => {
  const a = await create()
  const blocks = generateFixture(0, 10)
  const expected = blocksToExpected(blocks, a.discoveryKey)
  await a.append(blocks)
  /** @type {any[]} */
  const entries = []
  const stream = new CoreIndexStream(a, () => new ram(), false)
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'drained')
  assert.deepEqual(entries, expected)
})

test('Re-indexing all items in a core', async () => {
  const core = await create()
  const blocks = generateFixture(0, 10)
  const expected = blocksToExpected(blocks, core.key)
  await core.append(blocks)

  const storage = ram.reusable()

  const stream1 = new CoreIndexStream(core, storage, false)
  stream1.on('data', (entry) => {
    stream1.setIndexed(entry.index)
  })
  await once(stream1, 'drained')
  await stream1.destroy()

  /** @type {any[]} */
  const entries = []
  const stream2 = new CoreIndexStream(core, storage, true)
  stream2.on('data', (entry) => {
    entries.push(entry)
  })
  await once(stream2, 'drained')

  assert.deepEqual(entries, expected)
})

test("Empty core emits 'drained' event", async () => {
  const a = await create()
  const stream = new CoreIndexStream(a, () => new ram(), false)
  stream.resume()
  stream.on('indexing', assert.fail)
  await once(stream, 'drained')
})

test('.remaining property is accurate', async () => {
  const totalBlocks = 100
  const a = await create()
  const blocks = generateFixture(0, totalBlocks)
  const expected = blocksToExpected(blocks, a.discoveryKey)
  await a.append(blocks)
  /** @type {any[]} */
  const entries = []
  const stream = new CoreIndexStream(a, () => new ram(), false)
  assert.equal(stream.remaining, totalBlocks)
  stream.on('data', (entry) => {
    entries.push(entry)
    stream.setIndexed(entry.index)
    assert.equal(stream.remaining + entries.length, totalBlocks)
  })
  await once(stream, 'drained')
  assert.equal(stream.remaining, 0)
  assert.deepEqual(entries, expected)
})

test('Indexes items appended after initial index', async () => {
  const a = await create()
  const blocks = generateFixture(0, 10)
  /** @type {any[]} */
  const entries = []
  const stream = new CoreIndexStream(a, () => new ram(), false)
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'drained')
  assert.deepEqual(entries, [], 'no entries before append')
  const expected = blocksToExpected(blocks, a.discoveryKey)
  await a.append(blocks)
  await once(stream, 'drained')
  assert.deepEqual(entries, expected)
})

test('Readable stream from sparse hypercore', async () => {
  const a = await create()
  const blocks = generateFixture(0, 100)
  await a.append(blocks)
  const b = await create(a.key)

  replicate(a, b)

  const range = b.download({ start: 5, end: 20 })
  await range.downloaded()

  const stream = new CoreIndexStream(b, () => new ram(), false)
  /** @type {Buffer[]} */
  const entries = []
  stream.on('data', (entry) => entries.push(entry.block))
  await throttledDrain(stream)

  assert.deepEqual(entries, blocks.slice(5, 20))
  const range2 = b.download({ start: 50, end: 60 })
  await Promise.all([range2.downloaded(), throttledDrain(stream)])

  assert.deepEqual(
    entries.sort(),
    [...blocks.slice(5, 20), ...blocks.slice(50, 60)].sort()
  )
})

test("'indexing' and 'drained' events are paired", async () => {
  const a = await create()
  const blocks = generateFixture(0, 100)
  await a.append(blocks)
  const b = await create(a.key)

  replicate(a, b)

  const stream = new CoreIndexStream(b, () => new ram(), false)
  let indexingEvents = 0
  let idleEvents = 0
  stream.on('indexing', () => {
    assert.equal(indexingEvents, idleEvents)
    indexingEvents++
  })
  stream.on('drained', () => {
    idleEvents++
    assert.equal(indexingEvents, idleEvents)
  })
  stream.resume()

  const range = b.download({ start: 0, end: a.length })
  await Promise.all([range.downloaded(), throttledDrain(stream)])

  assert.equal(indexingEvents, idleEvents)
  // This is just to check that we're actually testing something
  assert.ok(indexingEvents > 2)
})

test('Appends from a replicated core are indexed', async () => {
  const a = await create()
  const blocks1 = generateFixture(0, 50)
  await a.append(blocks1)
  const b = await create(a.key)

  replicate(a, b)
  await b.update({ wait: true })
  const range1 = b.download({ start: 0, end: b.length })
  await range1.downloaded()

  const stream = new CoreIndexStream(b, () => new ram(), false)
  /** @type {Buffer[]} */
  const entries = []
  stream.on('data', (entry) => entries.push(entry.block))
  await throttledDrain(stream)

  assert.deepEqual(entries, blocks1)
  const range2 = b.download({ start: 50, end: -1 })
  const blocks2 = generateFixture(50, 100)
  await a.append(blocks2)
  await throttledDrain(stream)
  range2.destroy()

  assert.deepEqual(entries.sort(), [...blocks1, ...blocks2].sort())
})

test('Maintains index state', async () => {
  const a = await create()
  /** @type {any[]} */
  const entries = []
  const storage = ram.reusable()
  const stream1 = new CoreIndexStream(a, storage, false)
  stream1.on('data', (entry) => {
    entries.push(entry.block)
    stream1.setIndexed(entry.index)
  })

  const blocks = generateFixture(0, 1000)
  await a.append(blocks.slice(0, 500))
  await throttledDrain(stream1)
  assert.deepEqual(entries.sort(), blocks.slice(0, 500).sort())
  stream1.destroy()
  await once(stream1, 'close')
  await a.append(blocks.slice(500, 1000))
  const stream2 = new CoreIndexStream(a, storage, false)
  stream2.on('data', (entry) => {
    entries.push(entry.block)
    stream2.setIndexed(entry.index)
  })
  await throttledDrain(stream2)
  assert.deepEqual(entries.sort(), blocks.sort())
})

/**
 *
 * @param {Buffer[]} blocks
 * @param {Buffer} discoveryKey
 * @returns {import('../../').Entry[]}
 */
function blocksToExpected(blocks, discoveryKey) {
  return blocks.map((block, i) => ({
    discoveryId: discoveryKey.toString('hex'),
    block,
    index: i,
  }))
}
