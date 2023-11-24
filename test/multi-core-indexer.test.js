// @ts-check
const MultiCoreIndexer = require('../')
const { test } = require('tap')
const { once } = require('events')
const ram = require('random-access-memory')
const {
  create,
  replicate,
  generateFixtures,
  createMultiple,
  sortEntries,
} = require('./helpers')
const { testKeypairs, expectedStorageNames } = require('./fixtures.js')

/** @typedef {import('../lib/types').Entry<'binary'>} Entry */

test('Indexes all items already in a core', async (t) => {
  const cores = await createMultiple(5)
  const expected = await generateFixtures(cores, 100)
  /** @type {Entry[]} */
  const entries = []
  /** @type {ram[]} */
  const storages = []
  function createStorage() {
    const storage = new ram()
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
  t.same(sortEntries(entries), sortEntries(expected))
  await indexer.close()
  t.ok(
    storages.every((storage) => storage.closed),
    'all storages are closed'
  )
})

test('Multiple .idle() awaits', async (t) => {
  const cores = await createMultiple(5)
  const expected = await generateFixtures(cores, 100)
  /** @type {Entry[]} */
  const entries = []
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    maxBatch: 50,
    storage: () => new ram(),
  })
  await Promise.all([indexer.idle(), indexer.idle(), indexer.idle()])
  t.same(sortEntries(entries), sortEntries(expected))
  await indexer.close()
})

test('Indexes items appended after initial index', async (t) => {
  const cores = await createMultiple(5)
  /** @type {Entry[]} */
  const entries = []
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    maxBatch: 50,
    storage: () => new ram(),
  })
  const expected = await generateFixtures(cores, 100)
  await indexer.idle()
  t.same(sortEntries(entries), sortEntries(expected))
  await indexer.close()
  t.pass('Indexer closed')
})

test('Indexes cores added with addCore method', async (t) => {
  const cores = await createMultiple(5)
  /** @type {Entry[]} */
  const entries = []
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    maxBatch: 50,
    storage: () => new ram(),
  })
  const initialExpected = await generateFixtures(cores, 100)
  await indexer.idle()
  t.same(sortEntries(entries), sortEntries(initialExpected))
  const newCores = await createMultiple(5)
  for (const core of newCores) {
    indexer.addCore(core)
  }
  const expected = await generateFixtures([...cores, ...newCores], 100)
  await indexer.idle()
  t.same(sortEntries(entries), sortEntries([...initialExpected, ...expected]))
  await indexer.close()
  t.pass('Indexer closed')
})

test('index sparse hypercores', async (t) => {
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
    replicate(core, remoteCores[i], t)
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
    storage: () => new ram(),
  })
  await indexer.idle()

  t.same(sortEntries(entries), sortEntries(expected))

  for (const core of remoteCores) {
    await core.download({ start: 50, end: 60 }).downloaded()
  }
  await indexer.idle()

  t.same(sortEntries(entries), sortEntries([...expected, ...expected2]))
  await indexer.close()
  t.pass('Indexer closed')
})

test('Appends from a replicated core are indexed', async (t) => {
  const coreCount = 5
  const localCores = await createMultiple(coreCount)
  const expected1 = await generateFixtures(localCores, 50)

  const remoteCores = Array(coreCount)
  for (const [i, core] of localCores.entries()) {
    const remote = (remoteCores[i] = await create(core.key))
    replicate(core, remoteCores[i], t)
    await remote.update({ wait: true })
    await remote.download({ start: 0, end: remote.length }).downloaded()
  }
  /** @type {Entry[]} */
  const entries = []
  const indexer = new MultiCoreIndexer(remoteCores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: () => new ram(),
  })
  await indexer.idle()
  t.same(sortEntries(entries), sortEntries(expected1))

  const expected2 = await generateFixtures(localCores, 50)
  for (const [i, remote] of remoteCores.entries()) {
    await remote.download({ start: 50, end: localCores[i].length }).downloaded()
  }
  await indexer.idle()

  t.same(sortEntries(entries), sortEntries([...expected1, ...expected2]))
  await indexer.close()
  t.pass('Indexer closed')
})

test('Maintains index state (memory storage)', async (t) => {
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
  await once(indexer1, 'idle')
  t.same(sortEntries(entries1), sortEntries(expected1))
  await indexer1.close()
  t.pass('Indexer closed')

  const expected2 = await generateFixtures(cores, 1000)
  /** @type {Entry[]} */
  const entries2 = []
  const indexer2 = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries2.push(...data)
    },
    storage: createRAM,
  })
  await once(indexer2, 'idle')
  t.same(sortEntries(entries2), sortEntries(expected2))
  await indexer2.close()
  t.pass('Indexer closed')
})

test('Maintains index state (file storage)', async (t) => {
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
    await once(indexer1, 'idle')
    t.same(sortEntries(entries1), sortEntries(expected1))
    await indexer1.close()
    t.pass('Indexer closed')

    const expected2 = await generateFixtures(cores, 1000)
    /** @type {Entry[]} */
    const entries2 = []
    const indexer2 = new MultiCoreIndexer(cores, {
      batch: async (data) => {
        entries2.push(...data)
      },
      storage: dir,
    })
    await once(indexer2, 'idle')
    t.same(sortEntries(entries2), sortEntries(expected2))
    await indexer2.close()
    t.pass('Indexer closed')
  })
})

test('Entries are re-indexed if index storage reset', async (t) => {
  const cores = await createMultiple(5)
  const expected = await generateFixtures(cores, 1000)

  /** @type {Entry[]} */
  const entries1 = []
  const indexer1 = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries1.push(...data)
    },
    storage: () => new ram(),
  })
  await indexer1.idle()
  t.same(sortEntries(entries1), sortEntries(expected))
  await indexer1.close()
  t.pass('Indexer closed')

  /** @type {Entry[]} */
  const entries2 = []
  const indexer2 = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries2.push(...data)
    },
    storage: () => new ram(),
  })
  await indexer2.idle()
  t.same(sortEntries(entries2), sortEntries(expected))
  await indexer2.close()
  t.pass('Indexer closed')
})

test('Entries are batched to batchMax when indexing is slower than Hypercore reads', async (t) => {
  const cores = await createMultiple(5)
  await generateFixtures(cores, 500)

  for (const batchSize of [50, 100, 500]) {
    /** @type {number[]} */
    const batchSizes = []
    const indexer = new MultiCoreIndexer(cores, {
      batch: async (data) => {
        batchSizes.push(data.length)
        await new Promise((res) => setTimeout(res, 50))
      },
      maxBatch: batchSize,
      storage: () => new ram(),
    })
    await indexer.idle()
    t.ok(
      batchSizes.filter((size) => size < batchSize).length <= 2,
      `Most batches are ${batchSize}`
    )
    await indexer.close()
  }
})

test('Batches smaller than maxBatch when indexing is faster than hypercore reads', async (t) => {
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
    storage: () => new ram(),
  })
  await indexer.idle()
  t.ok(
    batchSizes.every((size) => size < batchSize),
    `All batches are smaller than maxBatch`
  )
  await indexer.close()
})

test('sync state / progress', async (t) => {
  const expectedVariation = 0.2
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
    storage: () => new ram(),
  })
  indexer.on('index-state', (state) => stateEvents.push(state))
  await indexer.idle()
  const actualRate =
    (numberOfCores * entriesPerCore * 1000) / (Date.now() - start)
  t.ok(stateEvents.length > 10, 'At least 10 index-state events')
  t.same(stateEvents[0], {
    entriesPerSecond: 0,
    remaining: numberOfCores * entriesPerCore,
    current: 'indexing',
  })
  // Ends with idle and 0 remaining
  t.equal(stateEvents[stateEvents.length - 1].current, 'idle')
  t.equal(stateEvents[stateEvents.length - 1].remaining, 0)
  t.ok(
    // Ignore first two events, as they are not representative of the actual rate
    stateEvents.slice(2).every((state) => {
      return (
        Math.abs(state.entriesPerSecond - actualRate) / actualRate <=
        expectedVariation
      )
    }),
    `state.entriesPerSecond is within ${
      expectedVariation * 100
    }% of actual rate`
  )

  await indexer.close()
  t.pass('Indexer closed')
})

test('state getter', async (t) => {
  const cores = await createMultiple(2)
  const entries = []
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: () => new ram(),
  })
  t.same(indexer.state.current, 'indexing')
  await indexer.idle()
  await generateFixtures(cores, 100)
  t.same(indexer.state.current, 'indexing')
  await indexer.idle()
  t.same(indexer.state.current, 'idle')
  t.same(entries.length, 200)
  await indexer.close()
  t.pass('Indexer closed')
})

test('empty cores, no indexing event before idle', async (t) => {
  const cores = await createMultiple(2)
  const indexer = new MultiCoreIndexer(cores, {
    batch: async () => {},
    storage: () => new ram(),
  })
  indexer.on('index-state', (state) => {
    if (state.current === 'indexing') t.fail()
  })
  indexer.on('indexing', t.fail)
  t.same(indexer.state.current, 'indexing')
  await indexer.close()
  t.pass('Indexer closed')
})

test('state.remaining does not update until after batch function resolves', async (t) => {
  const cores = await createMultiple(1)
  const entries = []
  await generateFixtures(cores, 1)
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      const state = indexer.state
      t.same(
        state.remaining,
        1,
        'remaining should not decrease until after batch() resolves'
      )
      entries.push(...data)
    },
    storage: () => new ram(),
  })
  await indexer.idle()
  t.same(indexer.state.current, 'idle')
  t.same(entries.length, 1)
  await indexer.close()
  t.pass('Indexer closed')
})

test('Closing before batch complete should resume on next start', async (t) => {
  const cores = await createMultiple(5)
  const expected = await generateFixtures(cores, 1000)
  const createRAM = ram.reusable()

  /** @type {Entry[]} */
  const entries = []
  const indexer1 = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: createRAM,
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
  t.ok(
    indexer1.state.remaining <= 2500,
    'Stopped with half of the entries indexed'
  )
  t.pass('Indexer closed')

  const indexer2 = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: createRAM,
  })
  await once(indexer2, 'idle')
  t.equal(entries.length, expected.length)
  // t.same(sortEntries(entries), sortEntries(expected))
  await indexer2.close()
  t.pass('Indexer closed')
})

// This checks that storage names do not change between versions, which would be a breaking change
test('Consistent storage folders', async (t) => {
  const storageNames = []
  const cores = []
  for (const keyPair of testKeypairs.slice(0, 5)) {
    cores.push(await create({ keyPair }))
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
    indexer.addCore(await create({ keyPair }))
  }
  t.same(storageNames.sort(), expectedStorageNames)
})
