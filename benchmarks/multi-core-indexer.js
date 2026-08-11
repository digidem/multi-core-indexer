// @ts-check
import nanobench from 'nanobench'
import assert from 'node:assert'
import MultiCoreIndexer from '../index.js'
import {
  generateFixtures,
  createMultiple,
  createTempDir,
  closeCreatedCores,
  throttledIdle,
} from '../test/helpers/index.js'

/** @typedef {import('../lib/types.js').Entry<'binary'>} Entry */

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
      storage: createTempDir(),
    })
    await throttledIdle(indexer)
    assert(count === expected.length)
    await indexer.close()
  }
  b.end()
  await closeCreatedCores()
})
