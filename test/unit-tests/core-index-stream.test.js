// @ts-check
const { CoreIndexStream } = require('../../lib/core-index-stream')
const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('events')
const ram = require('random-access-memory')
const {
  create,
  createTempDir,
  trackCore,
  closeCreatedCores,
  replicate,
  generateFixture,
  throttledDrain,
} = require('../helpers')
const Hypercore = require('hypercore')

// Cores are backed by RocksDB storage: close them after each test so native
// resources don't accumulate across tests
test.afterEach(() => closeCreatedCores())

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
  const a = trackCore(new Hypercore(createTempDir()))
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
  const core = trackCore(new Hypercore(createTempDir()))
  const stream = new CoreIndexStream(core, createStorage, false)
  await stream.unlink()
  assert.equal(storageCreated, true, 'storage was created')
})

test('Indexes all items already in a core', async () => {
  const a = await create()
  const blocks = generateFixture(0, 10)
  const expected = blocksToExpected(blocks, a.key)
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
  const expected = blocksToExpected(blocks, a.key)
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
  const expected = blocksToExpected(blocks, a.key)
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

  // Download in separate waves, draining in between, so that the stream goes
  // through multiple indexing -> drained cycles
  for (const [start, end] of [
    [0, 30],
    [30, 60],
    [60, 100],
  ]) {
    const range = b.download({ start, end })
    await Promise.all([range.downloaded(), throttledDrain(stream)])
  }

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

test('Core closed while reads are pending: blocks are skipped without error', async (t) => {
  const a = await create()
  await a.append(generateFixture(0, 10))
  /** @type {Promise<void> | undefined} */
  let closePromise
  const originalGet = a.get.bind(a)
  // Trigger close from inside the first read: core.close() sets `closing`
  // synchronously, so the read below rejects the same way as an in-flight
  // read of a core that is closed while indexing
  // @ts-ignore - patching for the test
  a.get = (index, opts) => {
    closePromise ??= a.close()
    return originalGet(index, opts)
  }
  const stream = new CoreIndexStream(a, () => new ram(), false)
  t.after(() => stream.destroy())
  /** @type {Error[]} */
  const errors = []
  stream.on('error', (err) => errors.push(err))
  stream.on('data', () => assert.fail('no entries should be pushed'))
  await once(stream, 'drained')
  assert.equal(errors.length, 0, 'read rejections from the close are skipped')
  assert.equal(stream.remaining, 0)
  await closePromise
})

test('A core read failure not caused by closing destroys the stream', async (t) => {
  const a = await create()
  await a.append(generateFixture(0, 10))
  const readError = Object.assign(new Error('EIO: i/o error, read'), {
    code: 'EIO',
  })
  const originalGet = a.get.bind(a)
  // Simulate a storage-level read failure for a single block. The real
  // storage layer (RocksDB) is native code whose failures cannot be injected
  // from a test, but its failure mode at this boundary is a rejected get()
  // on a core that is not closing
  // @ts-ignore - patching for the test
  a.get = (index, opts) =>
    index === 3 ? Promise.reject(readError) : originalGet(index, opts)
  const stream = new CoreIndexStream(a, () => new ram(), false)
  t.after(() => stream.destroy())
  stream.resume()
  const [err] = await once(stream, 'error')
  assert.equal(err, readError, 'the stream is destroyed with the read error')
})

test('Downloads queued while the consumer is stalled are all indexed (more than one read batch)', async (t) => {
  const blockCount = 200 // > READ_BATCH_SIZE (32) so batching in the download path is exercised
  const a = await create()
  const blocks = generateFixture(0, blockCount)
  await a.append(blocks)
  const b = await create(a.key)

  replicate(a, b)

  const stream = new CoreIndexStream(b, () => new ram(), false)
  t.after(() => stream.destroy())
  /** @type {Map<number, number>} */
  const seen = new Map()
  stream.on('data', (entry) => {
    seen.set(entry.index, (seen.get(entry.index) || 0) + 1)
    stream.setIndexed(entry.index)
  })
  // Nothing is downloaded yet, so the stream starts drained
  await throttledDrain(stream)
  stream.pause()

  // Queue up download events for every block while the consumer is stalled
  await b.download({ start: 0, end: blockCount }).downloaded()

  stream.resume()
  await throttledDrain(stream)

  assert.equal(seen.size, blockCount, 'every downloaded block is indexed')
  assert.ok(
    [...seen.values()].every((count) => count === 1),
    'no block is indexed more than once'
  )
})

test('Cleared blocks are skipped without stalling the stream', async (t) => {
  const blockCount = 200 // > READ_BATCH_SIZE (32) so whole batches can be all-null
  const a = await create()
  const blocks = generateFixture(0, blockCount)
  await a.append(blocks)
  await a.clear(0, 100)

  const stream = new CoreIndexStream(a, () => new ram(), false)
  t.after(() => stream.destroy())
  /** @type {number[]} */
  const indexes = []
  stream.on('data', (entry) => {
    indexes.push(entry.index)
    stream.setIndexed(entry.index)
  })
  await throttledDrain(stream)

  assert.deepEqual(
    indexes,
    blocks.map((_, i) => i).filter((i) => i >= 100),
    'only blocks that still exist are indexed, in order'
  )
  assert.equal(stream.remaining, 0)
})
