// @ts-check
const MultiCoreIndexer = require('../')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const ram = require('random-access-memory')
const {
  create,
  replicate,
  generateFixtures,
  createMultiple,
  sortEntries,
} = require('./helpers')
const { testKeypairs, expectedStorageNames } = require('./fixtures.js')
const Hypercore = require('hypercore')

/** @typedef {import('../lib/types').Entry<'binary'>} Entry */

test('Indexes all items already in a core', async () => {
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
  assert.deepEqual(sortEntries(entries), sortEntries(expected))
  await indexer.close()
  assert.ok(
    storages.every((storage) => storage.closed),
    'all storages are closed'
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
    storage: () => new ram(),
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
    storage: () => new ram(),
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
    storage: () => new ram(),
  })
  const expected = await generateFixtures(cores, 100)
  await indexer.idle()
  assert.deepEqual(sortEntries(entries), sortEntries(expected))
  await indexer.close()
})

test('State transitions', async () => {
  const indexer = new MultiCoreIndexer([], {
    batch: async () => {},
    storage: () => new ram(),
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
    'moves to a "closing" state immediately after calling close'
  )
  await closePromise
  assert.equal(
    indexer.state.current,
    'closed',
    'moves to a "closed" state after closing'
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
    storage: () => new ram(),
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
    storage: () => new ram(),
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
    sortEntries([...initialExpected, ...expected])
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
    storage: () => new ram(),
  })
  await indexer.idle()

  assert.deepEqual(sortEntries(entries), sortEntries(expected))

  for (const core of remoteCores) {
    await core.download({ start: 50, end: 60 }).downloaded()
  }
  await indexer.idle()

  assert.deepEqual(
    sortEntries(entries),
    sortEntries([...expected, ...expected2])
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
    storage: () => new ram(),
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
    sortEntries([...expected1, ...expected2])
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
    storage: () => new ram(),
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
    storage: () => new ram(),
  })
  await indexer2.idle()
  assert.deepEqual(sortEntries(entries2), sortEntries(expected))
  await indexer2.close()
})

test('Entries are re-indexed if index storage unlinked', async () => {
  const cores = await createMultiple(5)

  const createRAM = ram.reusable()

  const indexer1 = new MultiCoreIndexer(cores, {
    batch: async () => {},
    storage: createRAM,
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
    storage: createRAM,
  })
  await indexer2.idle()

  assert.deepEqual(sortEntries(entries), sortEntries(expected))

  await indexer2.close()
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
        await new Promise((res) => setTimeout(res, 50))
      },
      maxBatch: batchSize,
      storage: () => new ram(),
    })
    await indexer.idle()
    assert.ok(
      batchSizes.filter((size) => size < batchSize).length <= 2,
      `Most batches are ${batchSize}`
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
    storage: () => new ram(),
  })
  await indexer.idle()
  assert.ok(
    batchSizes.every((size) => size < batchSize),
    `All batches are smaller than maxBatch`
  )
  await indexer.close()
})

test('sync state / progress', async () => {
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
  assert.ok(stateEvents.length > 10, 'At least 10 index-state events')
  assert.deepEqual(stateEvents[0], {
    entriesPerSecond: 0,
    remaining: numberOfCores * entriesPerCore,
    current: 'indexing',
  })
  // Ends with idle and 0 remaining
  assert.equal(stateEvents[stateEvents.length - 1].current, 'idle')
  assert.equal(stateEvents[stateEvents.length - 1].remaining, 0)
  assert.ok(
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
})

test('state getter', async () => {
  const cores = await createMultiple(2)
  const entries = []
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: () => new ram(),
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
    storage: () => new ram(),
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
        'remaining should not decrease until after batch() resolves'
      )
      entries.push(...data)
    },
    storage: () => new ram(),
  })
  await indexer.idle()
  assert.deepEqual(indexer.state.current, 'idle')
  assert.deepEqual(entries.length, 1)
  await indexer.close()
})

test('Closing before batch complete should resume on next start', async () => {
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
  assert.ok(
    indexer1.state.remaining <= 2500,
    'Stopped with half of the entries indexed'
  )

  const indexer2 = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: createRAM,
  })
  await indexer2.idle()
  assert.equal(entries.length, expected.length)
  // t.same(sortEntries(entries), sortEntries(expected))
  await indexer2.close()
})

test('double-closing is a no-op', async (t) => {
  const indexer = new MultiCoreIndexer([], {
    batch: async () => {},
    storage: () => new ram(),
  })
  const closePromise = indexer.close()
  t.after(() => closePromise)

  await assert.doesNotReject(() => indexer.close())
})

test('closing causes many methods to fail', async (t) => {
  {
    const indexer = new MultiCoreIndexer([], {
      batch: async () => {},
      storage: () => new ram(),
    })
    const closePromise = indexer.close()
    t.after(() => closePromise)
    const core = await create()
    assert.throws(() => indexer.addCore(core))
  }

  {
    const indexer = new MultiCoreIndexer([], {
      batch: async () => {},
      storage: () => new ram(),
    })
    const closePromise = indexer.close()
    t.after(() => closePromise)
    await assert.rejects(() => indexer.idle())
  }
})

test('closing resolves existing idle promises', async () => {
  const indexer = new MultiCoreIndexer([], {
    batch: async () => {},
    storage: () => new ram(),
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
    storage: () => new ram(),
  })

  await indexer.idle()
  await assert.rejects(() => indexer.unlink(), 'rejects when idle')

  const core = await create()
  indexer.addCore(core)
  await assert.rejects(() => indexer.unlink(), 'rejects when indexing')

  const closePromise = indexer.close()
  await assert.rejects(() => indexer.unlink(), 'rejects when closing')

  await closePromise
  await assert.doesNotReject(() => indexer.unlink())
})

// This checks that storage names do not change between versions, which would be a breaking change
test('Consistent storage folders', async () => {
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
  await indexer.idle()
  assert.deepEqual(storageNames.sort(), expectedStorageNames)
})

test('Works with non-ready cores', async () => {
  /** @type {Hypercore[]} */
  const cores = []
  for (let i = 0; i < 5; i++) {
    cores.push(new Hypercore(() => new ram()))
  }
  const indexer = new MultiCoreIndexer(cores, {
    batch: async () => {},
    storage: () => new ram(),
  })
  assert.equal(indexer.state.current, 'indexing')
  await indexer.idle()
  await indexer.close()
})

test('Indexes all items already in a core - cores not ready', async () => {
  /** @type {Hypercore[]} */
  const cores = []
  /** @type {Array<ReturnType<(typeof ram)['reusable']>>} */
  const storages = []
  for (let i = 0; i < 5; i++) {
    const storage = ram.reusable()
    storages.push(storage)
    cores.push(new Hypercore(storage))
  }
  const expected = await generateFixtures(cores, 100)
  await Promise.all(cores.map((core) => core.close()))
  for (let i = 0; i < 5; i++) {
    cores[i] = new Hypercore(storages[i])
  }
  /** @type {Entry[]} */
  const entries = []
  const indexer = new MultiCoreIndexer(cores, {
    batch: async (data) => {
      entries.push(...data)
    },
    storage: () => new ram(),
  })
  await indexer.idle()
  assert.deepEqual(sortEntries(entries), sortEntries(expected))
  await indexer.close()
})
