const { CoreIndexStream } = require('../../lib/core-index-stream')
const { MultiCoreIndexStream } = require('../../lib/multi-core-index-stream')
const { test } = require('tap')
const { once } = require('events')
const ram = require('random-access-memory')
const { Writable } = require('streamx')
const {
  create,
  replicate,
  createMultiple,
  generateFixtures,
  throttledIdle,
  sortEntries,
} = require('../helpers')

test('Indexes all items already in a core', async (t) => {
  const cores = await createMultiple(5)
  const expected = await generateFixtures(cores, 1000)
  const indexStreams = cores.map((core) => new CoreIndexStream(core, new ram()))
  const entries = []
  const stream = new MultiCoreIndexStream(indexStreams)
  const ws = new Writable({
    writev: (data, cb) => {
      entries.push(...data)
      cb()
    },
  })
  stream.pipe(ws)
  await throttledIdle(stream)
  t.same(sortEntries(entries), sortEntries(expected))
  t.not(entries.length, 0, 'has entries')
  stream.destroy()
  // Need the noop catch here because once() will reject if the source emits an
  // error event while waiting, and the destroy() bubbles up an error in the
  // writestream
  await once(ws, 'close').catch(() => {})
  t.pass('Stream destroyed and closed')
})

test('Adding index streams after initialization', async (t) => {
  const cores = await createMultiple(3)
  const expected = await generateFixtures(cores, 100)
  const indexStreams = cores.map((core) => new CoreIndexStream(core, new ram()))
  const entries = []
  const stream = new MultiCoreIndexStream(indexStreams.slice(0, 2))
  stream.addStream(indexStreams[2])
  // Check re-adding a stream that is already being indexed is a no-op
  stream.addStream(indexStreams[1])
  const ws = new Writable({
    writev: (data, cb) => {
      entries.push(...data)
      cb()
    },
  })
  stream.pipe(ws)
  await throttledIdle(stream)
  t.same(sortEntries(entries), sortEntries(expected))
  t.not(entries.length, 0, 'has entries')
  stream.destroy()
  // Need the noop catch here because once() will reject if the source emits an
  // error event while waiting, and the destroy() bubbles up an error in the
  // writestream
  await once(ws, 'close').catch(() => {})
  t.pass('Stream destroyed and closed')
})

test('.remaining is as expected', async (t) => {
  const coreCount = 5
  const blockCount = 100
  const cores = await createMultiple(coreCount)
  const expected = await generateFixtures(cores, blockCount)
  const indexStreams = cores.map((core) => new CoreIndexStream(core, new ram()))
  const entries = []
  const stream = new MultiCoreIndexStream(indexStreams, { highWaterMark: 10 })
  const ws = new Writable({
    writev: (data, cb) => {
      entries.push(...data)
      t.equal(
        stream.remaining,
        coreCount * blockCount - entries.length,
        'got expected .remaining'
      )
      cb()
    },
  })
  stream.pipe(ws)
  await throttledIdle(stream)
  t.same(sortEntries(entries), sortEntries(expected))
  t.not(entries.length, 0, 'has entries')
  stream.destroy()
  // Need the noop catch here because once() will reject if the source emits an
  // error event while waiting, and the destroy() bubbles up an error in the
  // writestream
  await once(ws, 'close').catch(() => {})
  t.pass('Stream destroyed and closed')
})

test('Indexes items appended after initial index', async (t) => {
  const cores = await createMultiple(5)
  const indexStreams = cores.map((core) => new CoreIndexStream(core, new ram()))
  const entries = []
  const stream = new MultiCoreIndexStream(indexStreams, { highWaterMark: 10 })
  stream.on('data', (entry) => entries.push(entry))
  await throttledIdle(stream)
  t.same(entries, [], 'no entries before append')
  const expected = await generateFixtures(cores, 100)
  await throttledIdle(stream)
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
    const fixture = await generateFixtures([core], 100)
    expected.push.apply(expected, fixture.slice(5, 20))
    expected2.push.apply(expected2, fixture.slice(50, 60))
    remoteCores[i] = await create(core.key)
    replicate(core, remoteCores[i], t)
  }

  for (const core of remoteCores) {
    const range = core.download({ start: 5, end: 20 })
    await range.downloaded()
    indexStreams.push(new CoreIndexStream(core, new ram()))
  }
  const entries = []
  const stream = new MultiCoreIndexStream(indexStreams, { highWaterMark: 10 })
  stream.on('data', (entry) => entries.push(entry))
  await throttledIdle(stream)

  t.same(sortEntries(entries), sortEntries(expected))

  await Promise.all([
    throttledIdle(stream),
    ...remoteCores.map((core) =>
      core.download({ start: 50, end: 60 }).downloaded()
    ),
  ])

  t.same(sortEntries(entries), sortEntries([...expected, ...expected2]))
})

test('Appends from a replicated core are indexed', async (t) => {
  const coreCount = 5
  const localCores = await createMultiple(coreCount)
  const expected1 = await generateFixtures(localCores, 50)
  const indexStreams = []
  const remoteCores = Array(coreCount)
  for (const [i, core] of localCores.entries()) {
    const remote = (remoteCores[i] = await create(core.key))
    replicate(core, remoteCores[i], t)
    await remote.update()
    const range = remote.download({ start: 0, end: remote.length })
    await range.downloaded()
    indexStreams.push(new CoreIndexStream(core, new ram()))
  }
  const entries = []
  const stream = new MultiCoreIndexStream(indexStreams, { highWaterMark: 10 })
  stream.on('data', (entry) => entries.push(entry))
  await throttledIdle(stream)

  t.same(sortEntries(entries), sortEntries(expected1))

  const expected2 = await generateFixtures(localCores, 50)
  for (const remote of remoteCores.values()) {
    remote.download({ start: 0, end: remote.length })
  }
  await throttledIdle(stream)

  t.same(sortEntries(entries), sortEntries([...expected1, ...expected2]))
})

test('Maintains index state', async (t) => {
  const cores = await createMultiple(5)
  const storages = []
  await generateFixtures(cores, 1000)
  const entries = []

  for (const core of cores) {
    const storage = new ram()
    storages.push(storage)
    const indexStream = new CoreIndexStream(core, storage)
    indexStream.resume()
    await throttledIdle(indexStream)
    indexStream.destroy()
  }

  const indexStreams = cores.map(
    (core, i) => new CoreIndexStream(core, storages[i])
  )
  const stream = new MultiCoreIndexStream(indexStreams)
  stream.on('data', (entry) => entries.push(entry))

  const expectedPromise = generateFixtures(cores, 1000)
  await throttledIdle(stream)
  const expected = await expectedPromise
  t.same(sortEntries(entries), sortEntries(expected))
})
