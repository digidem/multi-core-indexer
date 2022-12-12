const Multifeed = require('multifeed')
const Index = require('multifeed-index')
const nanobench = require('nanobench')
const assert = require('assert')
const { promisify } = require('util')
const ram = require('random-access-memory')
const { generateFixture, blocksToExpected } = require('../test/helpers')

/** @typedef {import('../lib/types').Entry<'binary'>} Entry */

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
  for (const core of cores.values()) {
    const offset = core.length
    const blocks = generateFixture(offset, offset + count)
    await promisify(core.append.bind(core))(blocks)
    entries.push.apply(entries, blocksToExpected(blocks, core.key, offset))
  }
  return entries
}
