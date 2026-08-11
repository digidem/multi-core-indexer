// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import ram from 'random-access-memory'
import Hypercore from 'hypercore'
import RandomAccessFile from 'random-access-file'
import MultiCoreIndexer from '../index.js'
import { BatchError, IndexerClosed } from 'multi-core-indexer/error.js'
import {
  create,
  createTempDir,
  trackCore,
  closeCreatedCores,
  replicate,
  generateFixtures,
  createMultiple,
  sortEntries,
  uniqueEntries,
} from './helpers/index.js'
import { testKeypairs, expectedStorageNames } from './fixtures.js'
import { pDefer } from '../lib/utils.js'

/** @typedef {import('../lib/types.js').Entry<'binary'>} Entry */

// Cores are backed by RocksDB storage: close them after each test so native
// resources don't accumulate across tests
test.afterEach(() => closeCreatedCores())

test('Indexer waits for core to be ready before idling', async (t) => {
  const delayingCoreReady = pDefer()
  t.after(() => delayingCoreReady.resolve({}))

  const core = trackCore(
    new Hypercore(createTempDir(), {
      preload: () => delayingCoreReady.promise,
    }),
  )
  assert(!isCoreReady(core), 'test setup: core is not ready at the start')

  const indexer = new MultiCoreIndexer([core], {
    batch: async () => {
      assert.fail('This should never be called')
    },
    storage: createTempDir(),
  })
  t.after(() => indexer.close())

  assert(!isCoreReady(core), 'test setup: core is still not ready')
  assert.equal(indexer.state.current, 'indexing')

  await delay(1)

  assert(!isCoreReady(core), 'test setup: core is still not ready')
  assert.equal(indexer.state.current, 'indexing')

  delayingCoreReady.resolve({})

  await indexer.idle()
  assert.equal(indexer.state.current, 'idle')
})

test('Indexes all items already in a core', async () => {
  const cores = await createMultiple(5)
  const expected = await generateFixtures(cores, 100)
  /** @type {Entry[]} */
  const entries = []
  const storageDir = createTempDir()
  /** @type {import('random-access-file')[]} */
  const storages = []
  /** @param {string} name */
  function createStorage(name) {
    const storage = new RandomAccessFile(name, { directory: storageDir })
    storages.push(storage)
    return storage
  }
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    maxBatch: 50,
    storage: createStorage,
  })
  await indexer.idle()
  assert.deepEqual(sortEntries(entries), sortEntries(expected))
  await indexer.close()
  assert.ok(
    storages.every((storage) => storage.closed),
    'all storages are closed',
  )
})

test('Indexes all items already in a core (some empty cores)', async () => {
  const cores = await createMultiple(5)
  const expected = await generateFixtures(cores.slice(0, 3), 100)
  /** @type {Entry[]} */
  const entries = []

  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    maxBatch: 50,
    storage: createTempDir(),
  })
  await indexer.idle()
  assert.deepEqual(sortEntries(entries), sortEntries(expected))
  await indexer.close()
})

test('Multiple .idle() awaits', async () => {
  const cores = await createMultiple(5)
  const expected = await generateFixtures(cores, 100)
  /** @type {Entry[]} */
  const entries = []
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    maxBatch: 50,
    storage: createTempDir(),
  })
  await Promise.all([indexer.idle(), indexer.idle(), indexer.idle()])
  assert.deepEqual(sortEntries(entries), sortEntries(expected))
  await indexer.close()
})

test('Indexes items appended after initial index', async () => {
  const cores = await createMultiple(5)
  /** @type {Entry[]} */
  const entries = []
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    maxBatch: 50,
    storage: createTempDir(),
  })
  const expected = await generateFixtures(cores, 100)
  await indexer.idle()
  assert.deepEqual(sortEntries(entries), sortEntries(expected))
  await indexer.close()
})

test('State transitions', async () => {
  const indexer = new MultiCoreIndexer([], {
    batch: async () => {},
    storage: createTempDir(),
  })
  assert.equal(indexer.state.current, 'idle', 'starts in idle state')
  await indexer.idle()
  const core = await create()
  indexer.addCore(core)
  assert.equal(indexer.state.current, 'indexing', 'indexing after core added')
  await indexer.idle()
  assert.equal(indexer.state.current, 'idle', 'returns to an idle state')
  const closePromise = indexer.close()
  assert.equal(
    indexer.state.current,
    'closing',
    'moves to a "closing" state immediately after calling close',
  )
  await closePromise
  assert.equal(
    indexer.state.current,
    'closed',
    'moves to a "closed" state after closing',
  )
})

test('Calling idle() when already idle still resolves', async () => {
  const cores = await createMultiple(5)
  const expected = await generateFixtures(cores, 10)
  /** @type {Entry[]} */
  const entries = []
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: createTempDir(),
  })
  await indexer.idle()
  assert.deepEqual(sortEntries(entries), sortEntries(expected))
  await indexer.idle()
  assert.deepEqual(sortEntries(entries), sortEntries(expected))
  await indexer.close()
})
test('Indexes cores added with addCore method', async () => {
  const cores = await createMultiple(5)
  /** @type {Entry[]} */
  const entries = []
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    maxBatch: 50,
    storage: createTempDir(),
  })
  const initialExpected = await generateFixtures(cores, 100)
  await indexer.idle()
  assert.deepEqual(sortEntries(entries), sortEntries(initialExpected))
  const newCores = await createMultiple(5)
  for (const core of newCores) {
    indexer.addCore(core)
  }
  const expected = await generateFixtures([...cores, ...newCores], 100)
  await indexer.idle()
  assert.deepEqual(
    sortEntries(entries),
    sortEntries([...initialExpected, ...expected]),
  )
  await indexer.close()
})

test('index sparse hypercores', async () => {
  const coreCount = 5
  const localCores = await createMultiple(coreCount)
  /** @type {Entry[]} */
  const expected = []
  /** @type {Entry[]} */
  const expected2 = []
  const remoteCores = Array(coreCount)
  for (const [i, core] of localCores.entries()) {
    const fixture = await generateFixtures([core], 100)
    expected.push.apply(expected, fixture.slice(5, 20))
    expected2.push.apply(expected2, fixture.slice(50, 60))
    remoteCores[i] = await create(core.key)
    replicate(core, remoteCores[i])
  }

  for (const core of remoteCores) {
    await core.download({ start: 5, end: 20 }).downloaded()
  }
  /** @type {Entry[]} */
  const entries = []
  const indexer = new MultiCoreIndexer(remoteCores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: createTempDir(),
  })
  await indexer.idle()

  assert.deepEqual(sortEntries(entries), sortEntries(expected))

  for (const core of remoteCores) {
    await core.download({ start: 50, end: 60 }).downloaded()
  }
  await indexer.idle()

  assert.deepEqual(
    sortEntries(entries),
    sortEntries([...expected, ...expected2]),
  )
  await indexer.close()
})

test('Appends from a replicated core are indexed', async () => {
  const coreCount = 5
  const localCores = await createMultiple(coreCount)
  const expected1 = await generateFixtures(localCores, 50)

  const remoteCores = Array(coreCount)
  for (const [i, core] of localCores.entries()) {
    const remote = (remoteCores[i] = await create(core.key))
    replicate(core, remoteCores[i])
    await remote.update({ wait: true })
    await remote.download({ start: 0, end: remote.length }).downloaded()
  }
  /** @type {Entry[]} */
  const entries = []
  const indexer = new MultiCoreIndexer(remoteCores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: createTempDir(),
  })
  await indexer.idle()
  assert.deepEqual(sortEntries(entries), sortEntries(expected1))

  const expected2 = await generateFixtures(localCores, 50)
  for (const [i, remote] of remoteCores.entries()) {
    await remote.download({ start: 50, end: localCores[i].length }).downloaded()
  }
  await indexer.idle()

  assert.deepEqual(
    sortEntries(entries),
    sortEntries([...expected1, ...expected2]),
  )
  await indexer.close()
})

test('Maintains index state (memory storage)', async () => {
  const cores = await createMultiple(5)
  const expected1 = await generateFixtures(cores, 1000)
  const createRAM = ram.reusable()

  /** @type {Entry[]} */
  const entries1 = []
  const indexer1 = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries1.push(...data)
    },
    storage: createRAM,
  })
  await indexer1.idle()
  assert.deepEqual(sortEntries(entries1), sortEntries(expected1))
  await indexer1.close()

  const expected2 = await generateFixtures(cores, 1000)
  /** @type {Entry[]} */
  const entries2 = []
  const indexer2 = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries2.push(...data)
    },
    storage: createRAM,
  })
  await indexer2.idle()
  assert.deepEqual(sortEntries(entries2), sortEntries(expected2))
  await indexer2.close()
})

test('Maintains index state (file storage)', async () => {
  const { temporaryDirectoryTask } = await import('tempy')
  await temporaryDirectoryTask(async (dir) => {
    const cores = await createMultiple(5)
    const expected1 = await generateFixtures(cores, 1000)

    /** @type {Entry[]} */
    const entries1 = []
    const indexer1 = new MultiCoreIndexer(cores, {
      batch: async (data) => {
        entries1.push(...data)
      },
      storage: dir,
    })
    await indexer1.idle()
    assert.deepEqual(sortEntries(entries1), sortEntries(expected1))
    await indexer1.close()

    const expected2 = await generateFixtures(cores, 1000)
    /** @type {Entry[]} */
    const entries2 = []
    const indexer2 = new MultiCoreIndexer(cores, {
      batch: async (data) => {
        entries2.push(...data)
      },
      storage: dir,
    })
    await indexer2.idle()
    assert.deepEqual(sortEntries(entries2), sortEntries(expected2))
    await indexer2.close()
  })
})

test('Entries are re-indexed if index storage reset', async () => {
  const cores = await createMultiple(5)
  const expected = await generateFixtures(cores, 1000)

  /** @type {Entry[]} */
  const entries1 = []
  const indexer1 = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries1.push(...data)
    },
    storage: createTempDir(),
  })
  await indexer1.idle()
  assert.deepEqual(sortEntries(entries1), sortEntries(expected))
  await indexer1.close()

  /** @type {Entry[]} */
  const entries2 = []
  const indexer2 = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries2.push(...data)
    },
    storage: createTempDir(),
  })
  await indexer2.idle()
  assert.deepEqual(sortEntries(entries2), sortEntries(expected))
  await indexer2.close()
})

test('Entries are re-indexed if index storage unlinked', async () => {
  const cores = await createMultiple(5)

  const storageDir = createTempDir()

  const indexer1 = new MultiCoreIndexer(cores, {
    batch: async () => {},
    storage: storageDir,
  })
  const expected = await generateFixtures(cores, 3)
  await indexer1.idle()
  await indexer1.close()
  await indexer1.unlink()

  /** @type {Entry[]} */
  const entries = []
  const indexer2 = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: storageDir,
  })
  await indexer2.idle()

  assert.deepEqual(sortEntries(entries), sortEntries(expected))

  await indexer2.close()
})

test('Entries can be explicitly reindexed with a startup option', async (t) => {
  const cores = await createMultiple(3)
  const [core1, core2, core3] = cores
  const expectedIn1And2 = new Set(await generateFixtures([core1, core2], 3))
  const expectedIn3 = new Set(await generateFixtures([core3], 3))
  const allExpected = new Set([...expectedIn1And2, ...expectedIn3])

  const storage = createTempDir()

  /** @type {Set<Entry>} */ const entriesBeforeReindex = new Set()
  const indexer1 = new MultiCoreIndexer(cores, {
    batch: async (entries) => {
      for (const entry of entries) entriesBeforeReindex.add(entry)
    },
    storage,
  })
  await indexer1.idle()
  await indexer1.close()
  assert.deepEqual(
    entriesBeforeReindex,
    allExpected,
    'test setup: entries are indexed once',
  )

  /** @type {Set<Entry>} */ const entriesAfterReindex = new Set()
  const indexer2 = new MultiCoreIndexer([core1, core2], {
    batch: async (entries) => {
      for (const entry of entries) entriesAfterReindex.add(entry)
    },
    storage,
    reindex: true,
  })
  t.after(() => indexer2.close())

  await indexer2.idle()
  assert.deepEqual(entriesAfterReindex, expectedIn1And2)

  indexer2.addCore(core3)
  await indexer2.idle()
  assert.deepEqual(entriesAfterReindex, allExpected)
})

test('Entries are batched to batchMax when indexing is slower than Hypercore reads', async () => {
  const cores = await createMultiple(5)
  await generateFixtures(cores, 500)

  for (const batchSize of [50, 100, 500]) {
    /** @type {number[]} */
    const batchSizes = []
    const indexer = new MultiCoreIndexer(cores, {
      batch: async (data) => {
        batchSizes.push(data.length)
        // Scale the batch duration with batch size so that reads from disk
        // storage can always fill the stream buffer while a batch is
        // processed, keeping indexing slower than reads
        await new Promise((res) => setTimeout(res, batchSize))
      },
      maxBatch: batchSize,
      storage: createTempDir(),
    })
    await indexer.idle()
    // The first batch (before the stream buffer fills) and the final batch
    // are expected to be smaller than maxBatch
    assert.ok(
      batchSizes.filter((size) => size < batchSize).length <= 2,
      `Most batches are ${batchSize}`,
    )
    await indexer.close()
  }
})

test('Batches smaller than maxBatch when indexing is faster than hypercore reads', async () => {
  const cores = await createMultiple(5)
  await generateFixtures(cores, 500)
  const batchSize = 1000
  /** @type {number[]} */
  const batchSizes = []
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      batchSizes.push(data.length)
    },
    maxBatch: batchSize,
    storage: createTempDir(),
  })
  await indexer.idle()
  assert.ok(
    batchSizes.every((size) => size < batchSize),
    `All batches are smaller than maxBatch`,
  )
  await indexer.close()
})

test('sync state / progress', async () => {
  // The rate is a moving average, and with cores on real disk storage a
  // single slow disk read/write can briefly push it 20-25% off the true
  // rate, so allow a wider variation than the typical <5%
  const expectedVariation = 0.35
  const numberOfCores = 5
  const entriesPerCore = 1000
  const cores = await createMultiple(numberOfCores)
  await generateFixtures(cores, entriesPerCore)
  /** @type {import('../').IndexState[]} */
  const stateEvents = []
  const start = Date.now()
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      // Simulate a batch function whose duration changes linearly with batch size
      await new Promise((res) => setTimeout(res, data.length))
    },
    storage: createTempDir(),
  })
  indexer.on('index-state', (state) => stateEvents.push(state))
  await indexer.idle()
  const actualRate =
    (numberOfCores * entriesPerCore * 1000) / (Date.now() - start)
  assert.ok(stateEvents.length > 10, 'At least 10 index-state events')
  assert.deepEqual(stateEvents[0], {
    entriesPerSecond: 0,
    remaining: numberOfCores * entriesPerCore,
    current: 'indexing',
  })
  // Ends with idle and 0 remaining
  assert.equal(stateEvents[stateEvents.length - 1].current, 'idle')
  assert.equal(stateEvents[stateEvents.length - 1].remaining, 0)
  // Ignore first two events, as they are not representative of the actual rate
  const deviations = stateEvents.slice(2).map((state) => {
    return Math.abs(state.entriesPerSecond - actualRate) / actualRate
  })
  assert.ok(
    deviations.every((deviation) => deviation <= expectedVariation),
    `state.entriesPerSecond is within ${
      expectedVariation * 100
    }% of actual rate`,
  )
  // The wide bound above is for one-off disk stalls; the typical deviation
  // must be much smaller, so that a systematic error in the rate estimate
  // cannot hide inside the wide bound
  const medianDeviation = deviations.sort((a, b) => a - b)[
    Math.floor(deviations.length / 2)
  ]
  assert.ok(
    medianDeviation <= 0.15,
    `median deviation of state.entriesPerSecond is within 15% of actual rate (got ${Math.round(
      medianDeviation * 100,
    )}%)`,
  )

  await indexer.close()
})

test('state getter', async () => {
  const cores = await createMultiple(2)
  const entries = []
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: createTempDir(),
  })
  assert.deepEqual(indexer.state.current, 'indexing')
  await indexer.idle()
  await generateFixtures(cores, 100)
  assert.deepEqual(indexer.state.current, 'indexing')
  await indexer.idle()
  assert.deepEqual(indexer.state.current, 'idle')
  assert.deepEqual(entries.length, 200)
  await indexer.close()
})

test('empty cores, no indexing event before idle', async () => {
  const cores = await createMultiple(2)
  const indexer = new MultiCoreIndexer(cores, {
    batch: async () => {},
    storage: createTempDir(),
  })
  indexer.on('index-state', (state) => {
    if (state.current === 'indexing') assert.fail()
  })
  indexer.on('indexing', assert.fail)
  assert.deepEqual(indexer.state.current, 'indexing')
  await indexer.close()
})

test('state.remaining does not update until after batch function resolves', async () => {
  const cores = await createMultiple(1)
  const entries = []
  await generateFixtures(cores, 1)
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      const state = indexer.state
      assert.deepEqual(
        state.remaining,
        1,
        'remaining should not decrease until after batch() resolves',
      )
      entries.push(...data)
    },
    storage: createTempDir(),
  })
  await indexer.idle()
  assert.deepEqual(indexer.state.current, 'idle')
  assert.deepEqual(entries.length, 1)
  await indexer.close()
})

test('Closing before batch complete should resume on next start', async () => {
  const cores = await createMultiple(5)
  const expected = await generateFixtures(cores, 1000)
  const storageDir = createTempDir()

  /** @type {Entry[]} */
  const entries = []
  const indexer1 = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: storageDir,
  })
  // Wait until indexing is half-done, then close the indexer.
  await /** @type {Promise<void>} */ (
    new Promise((res) => {
      indexer1.on('index-state', onIndexState)
      function onIndexState(state) {
        if (state.remaining > 2500) return
        indexer1.off('index-state', onIndexState)
        res()
      }
    })
  )
  await indexer1.close()
  assert.ok(
    indexer1.state.remaining <= 2500,
    'Stopped with half of the entries indexed',
  )

  const indexer2 = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: storageDir,
  })
  await indexer2.idle()
  assert.deepEqual(
    sortEntries(uniqueEntries(entries)),
    sortEntries(expected),
    'every entry is indexed at least once (delivery is at-least-once, so a batch in flight at close may be re-delivered)',
  )
  await indexer2.close()
})

test('double-closing is a no-op', async (t) => {
  const indexer = new MultiCoreIndexer([], {
    batch: async () => {},
    storage: createTempDir(),
  })
  const closePromise = indexer.close()
  t.after(() => closePromise)

  assert.equal(indexer.close(), closePromise, 'returns the same promise')
  await assert.doesNotReject(() => indexer.close())
})

test('closing causes many methods to fail', async (t) => {
  {
    const indexer = new MultiCoreIndexer([], {
      batch: async () => {},
      storage: createTempDir(),
    })
    const closePromise = indexer.close()
    t.after(() => closePromise)
    const core = await create()
    assert.throws(() => indexer.addCore(core), { code: 'INDEXER_CLOSED' })
  }

  {
    const indexer = new MultiCoreIndexer([], {
      batch: async () => {},
      storage: createTempDir(),
    })
    const closePromise = indexer.close()
    t.after(() => closePromise)
    await assert.rejects(() => indexer.idle(), { code: 'INDEXER_CLOSED' })
  }
})

test('closing resolves existing idle promises', async () => {
  const indexer = new MultiCoreIndexer([], {
    batch: async () => {},
    storage: createTempDir(),
  })

  const core = await create()
  indexer.addCore(core)

  const idlePromises = [indexer.idle(), indexer.idle(), indexer.idle()]

  await indexer.close()

  await assert.doesNotReject(() => Promise.all(idlePromises))
})

test('unlinking requires the indexer to be closed', async () => {
  const indexer = new MultiCoreIndexer([], {
    batch: async () => {},
    storage: createTempDir(),
  })

  await indexer.idle()
  await assert.rejects(
    () => indexer.unlink(),
    { code: 'INDEXER_NOT_CLOSED' },
    'rejects when idle',
  )

  const core = await create()
  indexer.addCore(core)
  await assert.rejects(
    () => indexer.unlink(),
    { code: 'INDEXER_NOT_CLOSED' },
    'rejects when indexing',
  )

  const closePromise = indexer.close()
  await assert.rejects(
    () => indexer.unlink(),
    { code: 'INDEXER_NOT_CLOSED' },
    'rejects when closing',
  )

  await closePromise
  await assert.doesNotReject(() => indexer.unlink())
})

// This checks that storage names do not change between versions, which would be a breaking change
test('Consistent storage folders', async () => {
  const storageNames = []
  const cores = []
  for (const keyPair of testKeypairs.slice(0, 5)) {
    // compat: true creates cores whose key is the raw public key, as in
    // hypercore 10, so that these fixture storage names stay stable
    cores.push(await create({ keyPair, compat: true }))
  }
  function createStorage(name) {
    storageNames.push(name)
    return new ram()
  }
  const indexer = new MultiCoreIndexer(cores, {
    batch: async () => {},
    storage: createStorage,
  })
  for (const keyPair of testKeypairs.slice(5)) {
    indexer.addCore(await create({ keyPair, compat: true }))
  }
  await indexer.idle()
  assert.deepEqual(storageNames.sort(), expectedStorageNames)
})

test('Works with non-ready cores', async () => {
  /** @type {Hypercore[]} */
  const cores = []
  for (let i = 0; i < 5; i++) {
    cores.push(trackCore(new Hypercore(createTempDir())))
  }
  const indexer = new MultiCoreIndexer(cores, {
    batch: async () => {},
    storage: createTempDir(),
  })
  assert.equal(indexer.state.current, 'indexing')
  await indexer.idle()
  await indexer.close()
})

test('Indexes all items already in a core - cores not ready', async () => {
  /** @type {Hypercore[]} */
  const cores = []
  /** @type {string[]} */
  const coreDirs = []
  for (let i = 0; i < 5; i++) {
    const dir = createTempDir()
    coreDirs.push(dir)
    cores.push(trackCore(new Hypercore(dir)))
  }
  const expected = await generateFixtures(cores, 100)
  await Promise.all(cores.map((core) => core.close()))
  for (let i = 0; i < 5; i++) {
    cores[i] = trackCore(new Hypercore(coreDirs[i]))
  }
  /** @type {Entry[]} */
  const entries = []
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: createTempDir(),
  })
  await indexer.idle()
  assert.deepEqual(sortEntries(entries), sortEntries(expected))
  await indexer.close()
})

/**
 * @param {Readonly<Hypercore>} core
 * @returns {boolean}
 */
function isCoreReady(core) {
  return core.writable
}

test('Batch callback rejection emits error and indexer still closes', async () => {
  const cores = await createMultiple(2)
  await generateFixtures(cores, 100)
  const batchError = new Error('batch failed')
  const indexer = new MultiCoreIndexer(cores, {
    batch: async () => {
      throw batchError
    },
    storage: createTempDir(),
  })
  /** @type {Error[]} */
  const errors = []
  indexer.on('error', (error) => errors.push(error))
  const idlePromise = indexer.idle()
  const [err] = await once(indexer, 'error')
  assert.equal(
    err.code,
    'BATCH_ERROR',
    "emitted as a BATCH_ERROR 'error' event",
  )
  assert.equal(err.cause, batchError, 'the batch error is the cause')
  assert.ok(
    err instanceof BatchError,
    "instanceof works with the 'multi-core-indexer/error.js' export",
  )
  assert.throws(
    () => indexer.addCore(cores[0]),
    IndexerClosed,
    'addCore() throws an IndexerClosed after the error',
  )
  await assert.rejects(
    () => idlePromise,
    { code: 'BATCH_ERROR' },
    'pending idle() rejects with the batch error',
  )
  await assert.rejects(
    () => indexer.idle(),
    /Cannot await idle/,
    'idle() called after the error rejects',
  )
  assert.throws(
    () => indexer.addCore(cores[0]),
    /Cannot add core/,
    'addCore() called after the error throws',
  )
  const closePromise = indexer.close()
  assert.equal(
    indexer.close(),
    closePromise,
    'close() after the error returns the same promise',
  )
  await assert.doesNotReject(() => closePromise, 'close() still resolves')
  assert.equal(indexer.state.current, 'closed')
  assert.equal(errors.length, 1, "'error' is emitted only once")
})

test('Batch error followed by close() during teardown is still emitted', async () => {
  const cores = await createMultiple(2)
  await generateFixtures(cores, 100)
  const batchError = new Error('batch failed')
  /** @type {() => void} */
  let onBatchRejected = () => {}
  const batchRejected = new Promise((res) => {
    onBatchRejected = /** @type {() => void} */ (res)
  })
  const indexer = new MultiCoreIndexer(cores, {
    batch: async () => {
      queueMicrotask(onBatchRejected)
      throw batchError
    },
    storage: createTempDir(),
  })
  /** @type {Error[]} */
  const errors = []
  indexer.on('error', (error) => errors.push(error))
  await batchRejected
  // Land inside the window where the pipeline is tearing down from the error
  // but the pipe callback has not yet delivered it
  await new Promise((res) => setImmediate(res))
  assert.throws(
    () => indexer.addCore(cores[0]),
    /Cannot add core/,
    'addCore() throws while the pipeline is dying',
  )
  await indexer.close()
  assert.equal(errors.length, 1, 'error preceding close() is still emitted')
  assert.equal(errors[0].code, 'BATCH_ERROR')
  assert.equal(errors[0].cause, batchError)
})

test('Closing a core while indexing: indexer idles, resumes after reopen', async () => {
  const coreDir = createTempDir()
  const storageDir = createTempDir()
  const core = trackCore(new Hypercore(coreDir))
  await core.ready()
  const expected = await generateFixtures([core], 1000)

  /** @type {Entry[]} */
  const entries1 = []
  const indexer1 = new MultiCoreIndexer([core], {
    batch: async (data) => {
      entries1.push(...data)
      // Slow batches so the core is closed while indexing is in progress
      await delay(10)
    },
    storage: storageDir,
  })
  await once(indexer1, 'index-state')
  await core.close()
  // The closed core has nothing more that can be indexed, so the indexer
  // must reach idle (rather than hang) even though not everything is indexed
  await indexer1.idle()
  assert.ok(
    entries1.length < expected.length,
    'test setup: core closed before indexing completed',
  )
  await indexer1.close()

  // A new indexer for the re-opened core picks up where indexing stopped
  const reopened = trackCore(new Hypercore(coreDir))
  /** @type {Entry[]} */
  const entries2 = []
  const indexer2 = new MultiCoreIndexer([reopened], {
    batch: async (data) => {
      entries2.push(...data)
    },
    storage: storageDir,
  })
  await indexer2.idle()
  await indexer2.close()
  assert.deepEqual(
    sortEntries(uniqueEntries([...entries1, ...entries2])),
    sortEntries(expected),
    'every entry is indexed at least once across both indexers',
  )
})

test('Closing a core after indexing completes: idle() still resolves', async () => {
  const core = trackCore(new Hypercore(createTempDir()))
  await core.ready()
  await generateFixtures([core], 10)
  const indexer = new MultiCoreIndexer([core], {
    batch: async () => {},
    storage: createTempDir(),
  })
  await indexer.idle()
  // core.close() drops core.length to 0 synchronously, before the indexer
  // observes the close: `remaining` must not go negative or flip the state
  // back to 'indexing' in that window
  const coreClosePromise = core.close()
  assert.equal(indexer.state.remaining, 0, 'remaining stays 0 during close')
  assert.equal(indexer.state.current, 'idle', 'state stays idle during close')
  await indexer.idle()
  await coreClosePromise
  await indexer.idle()
  assert.equal(indexer.state.remaining, 0)
  await indexer.close()
})

test('Index storage write failure (disk full) is emitted as an error', async () => {
  const cores = await createMultiple(1)
  await generateFixtures(cores, 10)
  // Shaped like the error an fs write callback delivers on a full disk,
  // which is how index-storage failures typically show up on mobile
  const storageError = Object.assign(
    new Error('ENOSPC: no space left on device, write'),
    { code: 'ENOSPC' },
  )
  let failWrites = false
  const indexer = new MultiCoreIndexer(cores, {
    batch: async () => {},
    storage: () => {
      const storage = new ram()
      const originalWrite = storage._write.bind(storage)
      // @ts-ignore - patching the internal write method to fail on demand
      storage._write = (req) => {
        if (failWrites) {
          process.nextTick(() => req.callback(storageError))
        } else {
          originalWrite(req)
        }
      }
      return storage
    },
  })
  await indexer.idle()
  failWrites = true
  /** @type {Error[]} */
  const errors = []
  indexer.on('error', (error) => errors.push(error))
  const errorPromise = once(indexer, 'error')
  await generateFixtures(cores, 10)
  // The failing writes surface on the next flush of index state. Whether the
  // flush after this batch has anything to write depends on timing, so
  // trigger another read cycle if the indexer managed to reach idle
  const raced = await Promise.race([
    errorPromise.then(() => 'error'),
    indexer.idle().then(
      () => 'idle',
      () => 'error',
    ),
  ])
  if (raced === 'idle') await generateFixtures(cores, 10)
  const [err] = await errorPromise
  assert.equal(err.code, 'STORAGE_ERROR', 'emitted as a STORAGE_ERROR')
  assert.equal(err.cause, storageError, 'the storage error is the cause')
  assert.equal(
    /** @type {Error & { code: string }} */ (err.cause).code,
    'ENOSPC',
    'the underlying code is preserved, so consumers can classify disk-full errors',
  )
  await assert.doesNotReject(() => indexer.close(), 'close() still resolves')
  assert.equal(indexer.state.current, 'closed')
  assert.equal(errors.length, 1, "'error' is emitted only once")
})

test('Core read failure is emitted as an indexer error', async () => {
  const cores = await createMultiple(1)
  await generateFixtures(cores, 10)
  const readError = Object.assign(new Error('EIO: i/o error, read'), {
    code: 'EIO',
  })
  const core = cores[0]
  const originalGet = core.get.bind(core)
  // Simulate a storage-level read failure for a single block (see the
  // equivalent core-index-stream unit test for why get() is patched)
  // @ts-ignore - patching for the test
  core.get = (index, opts) =>
    index === 5 ? Promise.reject(readError) : originalGet(index, opts)
  const indexer = new MultiCoreIndexer(cores, {
    batch: async () => {},
    storage: createTempDir(),
  })
  const [err] = await once(indexer, 'error')
  assert.equal(err.code, 'HYPERCORE_ERROR', 'emitted as a HYPERCORE_ERROR')
  assert.equal(err.cause, readError, 'the read error is the cause')
  await assert.doesNotReject(() => indexer.close(), 'close() still resolves')
  assert.equal(indexer.state.current, 'closed')
})

test('Entries in an unfinished batch when closing are re-delivered on restart', async () => {
  const coreDir = createTempDir()
  const storageDir = createTempDir()
  const core = trackCore(new Hypercore(coreDir))
  await core.ready()
  const expected = await generateFixtures([core], 100)

  /** @type {Entry[]} */
  const entries1 = []
  const batchStarted = pDefer()
  const batchGate = pDefer()
  let firstBatch = true
  const indexer1 = new MultiCoreIndexer([core], {
    batch: async (data) => {
      entries1.push(...data)
      if (firstBatch) {
        firstBatch = false
        batchStarted.resolve()
        // Hold the first batch in flight until close() has been called
        await batchGate.promise
      }
    },
    storage: storageDir,
  })
  await batchStarted.promise
  const closePromise = indexer1.close()
  batchGate.resolve()
  await closePromise
  assert.ok(entries1.length > 0, 'test setup: a batch was in flight at close')
  // RocksDB locks the storage directory, so close before re-opening
  await core.close()

  const reopened = trackCore(new Hypercore(coreDir))
  /** @type {Entry[]} */
  const entries2 = []
  const indexer2 = new MultiCoreIndexer([reopened], {
    batch: async (data) => {
      entries2.push(...data)
    },
    storage: storageDir,
  })
  await indexer2.idle()
  await indexer2.close()
  const all = [...entries1, ...entries2]
  assert.deepEqual(
    sortEntries(uniqueEntries(all)),
    sortEntries(expected),
    'every entry is delivered at least once across restarts',
  )
  assert.ok(
    all.length >= expected.length,
    'entries from the unfinished batch may be re-delivered (at-least-once)',
  )
})

test("Without an 'error' listener the error is uncaught, but close() still resolves", async () => {
  // Runs in a child process: with no 'error' listener the error is
  // (intentionally) thrown as an uncaught exception, which would fail this
  // test process. The child traps it like a crash-reporting app would, then
  // checks that close() still resolves.
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const indexerUrl = pathToFileURL(path.join(packageRoot, 'index.js')).href
  const script = `
    import MultiCoreIndexer from ${JSON.stringify(indexerUrl)}
    import Hypercore from 'hypercore'
    import { mkdtempSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    process.on('uncaughtException', (err) => {
      console.log('uncaught:' + err.code + ':' + err.cause?.message)
    })
    async function main() {
      const core = new Hypercore(mkdtempSync(join(tmpdir(), 'mci-core-')))
      await core.ready()
      await core.append(['a', 'b', 'c'])
      const indexer = new MultiCoreIndexer([core], {
        batch: async () => {
          throw new Error('batch failed')
        },
        storage: mkdtempSync(join(tmpdir(), 'mci-index-')),
      })
      const timeout = setTimeout(() => {
        console.log('close-hung')
        process.exit(1)
      }, 8000)
      // The indexer closes itself when the error fires
      while (indexer.state.current === 'indexing' || indexer.state.current === 'idle') {
        await new Promise((res) => setTimeout(res, 10))
      }
      await indexer.close()
      clearTimeout(timeout)
      console.log('close-resolved')
      await core.close()
      process.exit(0)
    }
    main()
  `
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 20_000,
    },
  )
  assert.match(
    result.stdout,
    /uncaught:BATCH_ERROR:batch failed/,
    'the batch error is thrown as an uncaught exception',
  )
  assert.match(result.stdout, /close-resolved/, 'close() still resolves')
})
