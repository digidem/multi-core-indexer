// @ts-check
const MultiCoreIndexer = require('../')
const nanobench = require('nanobench')
const assert = require('assert')
const ram = require('random-access-memory')
const {
  generateFixtures,
  createMultiple,
  throttledIdle,
} = require('../test/helpers')

/** @typedef {import('../lib/types').Entry<'binary'>} Entry */

nanobench('Index 20 cores of 1000 blocks (10 times)', async (b) => {
  const cores = await createMultiple(20)
  const expected = await generateFixtures(cores, 1000)

  b.start()
  for (let i = 0; i < 10; i++) {
    let count = 0
    const indexer = new MultiCoreIndexer(cores, {
      batch: async (data) => {
        count += data.length
        await new Promise((res) => setTimeout(res, 10))
      },
      maxBatch: 500,
      storage: () => new ram(),
    })
    await throttledIdle(indexer)
    assert(count === expected.length)
  }
  b.end()
})
