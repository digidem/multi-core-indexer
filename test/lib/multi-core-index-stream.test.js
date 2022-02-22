const { CoreIndexStream } = require('../../lib/core-index-stream')
const { MultiCoreIndexStream } = require('../../lib/multi-core-index-stream')
const { test, only } = require('tap')
const { once } = require('events')
const ram = require('random-access-memory')
const { create, replicate, generateFixture } = require('../helpers')

test('Indexes all items already in a core', async (t) => {
  const cores = await createMultiple(5)
  const expected = []
  const indexStreams = []
  for (const [i, core] of cores.entries()) {
    const blocks = generateFixture(0, 100)
    await core.append(blocks)
    expected.push.apply(expected, blocksToExpected(blocks, core.key))
    indexStreams.push(new CoreIndexStream(core, ram()))
  }
  const entries = []
  const stream = new MultiCoreIndexStream(indexStreams, { highWaterMark: 10 })
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'indexed')
  t.same(entries.sort(), expected.sort())
  stream.destroy()
  await once(stream, 'close')
  t.pass('Stream destroyed and closed')
})

test('Indexes items appended after initial index', async (t) => {
  const cores = await createMultiple(5)
  const expected = []
  const indexStreams = cores.map((core) => new CoreIndexStream(core, ram()))
  const entries = []
  const stream = new MultiCoreIndexStream(indexStreams, { highWaterMark: 10 })
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'indexed')
  t.same(entries, [], 'no entries before append')
  for (const [i, core] of cores.entries()) {
    const blocks = generateFixture(0, 100)
    await core.append(blocks)
    expected.push.apply(expected, blocksToExpected(blocks, core.key))
  }
  await once(stream, 'indexed')
  t.same(sortEntries(entries), sortEntries(expected))
  stream.destroy()
  await once(stream, 'close')
  t.pass('Stream destroyed and closed')
})

test('index sparse hypercores', async (t) => {
  const coreCount = 5
  const localCores = await createMultiple(coreCount)
  const expected = []
  const expected2 = []
  const indexStreams = []
  const remoteCores = Array(coreCount)
  for (const [i, core] of localCores.entries()) {
    const blocks = generateFixture(0, 100)
    await core.append(blocks)
    expected.push.apply(
      expected,
      blocksToExpected(blocks, core.key).slice(5, 20)
    )
    expected2.push.apply(
      expected2,
      blocksToExpected(blocks, core.key).slice(50, 60)
    )
    remoteCores[i] = await create(core.key)
    replicate(core, remoteCores[i], t)
  }

  for (const core of remoteCores) {
    const range = core.download({ start: 5, end: 20 })
    await range.downloaded()
    indexStreams.push(new CoreIndexStream(core, ram()))
  }
  const entries = []
  const stream = new MultiCoreIndexStream(indexStreams, { highWaterMark: 10 })
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'indexed')

  t.same(sortEntries(entries), sortEntries(expected))

  await Promise.all([
    once(stream, 'indexed'),
    ...remoteCores.map((core) =>
      core.download({ start: 50, end: 60 }).downloaded()
    ),
  ])

  t.same(sortEntries(entries), sortEntries([...expected, ...expected2]))
})

test('Appends from a replicated core are indexed', async (t) => {
  const coreCount = 5
  const localCores = await createMultiple(coreCount)
  const expected = []
  const indexStreams = []
  const remoteCores = Array(coreCount)
  for (const [i, core] of localCores.entries()) {
    const blocks = generateFixture(0, 50)
    await core.append(blocks)
    expected.push.apply(expected, blocksToExpected(blocks, core.key))
    const remote = (remoteCores[i] = await create(core.key))
    replicate(core, remoteCores[i], t)
    await remote.update()
    const range = remote.download({ start: 0, end: remote.length })
    await range.downloaded()
    indexStreams.push(new CoreIndexStream(core, ram()))
  }
  const entries = []
  const stream = new MultiCoreIndexStream(indexStreams, { highWaterMark: 10 })
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'indexed')

  t.same(sortEntries(entries), sortEntries(expected))

  for (const [i, remote] of remoteCores.entries()) {
    const range = remote.download({ start: 50, end: -1 })
    const blocks = generateFixture(50, 100)
    await localCores[i].append(blocks)
    expected.push.apply(
      expected,
      blocksToExpected(blocks, localCores[i].key, 50)
    )
  }
  await once(stream, 'indexed')

  t.same(sortEntries(entries), sortEntries(expected))
})

test('Maintains index state', async (t) => {
  const cores = await createMultiple(5)
  const storages = []
  const expected = []
  const entries = []

  for (const core of cores) {
    await core.append(generateFixture(0, 1000))
    const storage = ram()
    storages.push(storage)
    const indexStream = new CoreIndexStream(core, storage)
    indexStream.resume()
    await once(indexStream, 'indexed')
    indexStream.destroy()
  }

  const indexStreams = cores.map(
    (core, i) => new CoreIndexStream(core, storages[i])
  )
  const stream = new MultiCoreIndexStream(indexStreams, { highWaterMark: 10 })
  stream.on('data', (entry) => entries.push(entry))

  for (const core of cores) {
    const blocks = generateFixture(1000, 2000)
    await core.append(blocks)
    expected.push.apply(expected, blocksToExpected(blocks, core.key, 1000))
  }

  await once(stream, 'indexed')
  t.same(sortEntries(entries), sortEntries(expected))
})

/**
 *
 * @param {Buffer[]} blocks
 * @param {Buffer} key
 * @returns
 */
function blocksToExpected(blocks, key, offset = 0) {
  return blocks.map((block, i) => ({
    key,
    block,
    index: i + offset,
  }))
}

/**
 * @param {number} n
 * @returns {Promise<import('hypercore')[]>}
 */
async function createMultiple(n) {
  const cores = []
  for (let i = 0; i < n; i++) {
    cores.push(await create())
  }
  return cores
}

function sort(a, b) {
  const aKey = a.key.toString('hex') + a.block.toString()
  const bKey = b.key.toString('hex') + b.block.toString()
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
}

function sortEntries(e) {
  return e.sort(sort)
}

function logEntries(e) {
  console.log(
    sortEntries(e).map((e) => ({
      key: e.key.toString('hex'),
      block: e.block.toString(),
      index: e.index,
    }))
  )
}
