// Requires the `noise-protocol` override in package.json: 3.0.2 changed
// `dh.js` to export a factory, which breaks simple-hypercore-protocol below.
import Multifeed from 'multifeed'
import Index from 'multifeed-index'
import nanobench from 'nanobench'
import assert from 'node:assert'
import { promisify } from 'node:util'
import ram from 'random-access-memory'
import { generateFixture, blocksToExpected } from '../test/helpers/index.js'

/** @typedef {import('../lib/types.js').Entry<'binary'>} Entry */

nanobench('Index 20 cores of 1000 blocks (10 times)', async (b) => {
  const storages = new Map()

  function createStorage(key) {
    const storage = storages.get(key) || new ram()
    storages.set(key, storage)
    return storage
  }

  // Setup cores with fixtures
  const multi = new Multifeed(createStorage, { valueEncoding: 'binary' })
  const cores = await createCores(multi, 20)
  const expected = await generateFixtures(cores, 1000)

  b.start()
  for (let i = 0; i < 10; i++) {
    let count = 0
    const index = new Index({
      batch: (nodes, next) => {
        count += nodes.length
        setTimeout(next, 10)
      },
      log: multi,
      maxBatch: 500,
    })
    await new Promise((res) => {
      index.on('state-update', function onState(state) {
        if (
          state.context.totalBlocks === state.context.indexedBlocks &&
          state.context.totalBlocks > 0 &&
          state.state === 'idle'
        ) {
          index.removeListener('state-update', onState)
          res()
        }
      })
    })
    assert(count === expected.length)
  }
  b.end()
})

async function createCores(multi, count) {
  const cores = []
  for (let i = 0; i < count; i++) {
    const core = await promisify(multi.writer.bind(multi))()
    cores.push(core)
  }
  return cores
}

async function generateFixtures(cores, count) {
  /** @type {Entry[]} */
  const entries = []
  for (const core of cores) {
    const offset = core.length
    const blocks = generateFixture(offset, offset + count)
    await promisify(core.append.bind(core))(blocks)
    entries.push.apply(entries, blocksToExpected(blocks, core.key, offset))
  }
  return entries
}
