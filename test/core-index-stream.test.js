// @ts-check
const { IndexStream } = require('../lib/core-index-stream')
const { test, only } = require('tap')
const { once } = require('events')
const { promisify } = require('util')
const ram = require('random-access-memory')
const { create, replicate, eventFlush } = require('./helpers')

const BLOCK_LENGTH = Buffer.from('block000000').byteLength

test('Indexes all items already in a core', async (t) => {
  const a = await create()
  const blocks = generateFixture(0, 10)
  const expected = blocksToExpected(blocks, a.key)
  await a.append(blocks)
  /** @type {any[]} */
  const entries = []
  const stream = new IndexStream(a, ram(), { highWaterMark: BLOCK_LENGTH * 4 })
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'indexed')
  t.same(entries, expected)
})

test('Indexes items appended after initial index', async (t) => {
  const a = await create()
  const blocks = generateFixture(0, 10)
  /** @type {any[]} */
  const entries = []
  const stream = new IndexStream(a, ram(), { highWaterMark: BLOCK_LENGTH * 4 })
  stream.on('data', (entry) => entries.push(entry))
  await once(stream, 'indexed')
  t.same(entries, [], 'no entries before append')
  const expected = blocksToExpected(blocks, a.key)
  await a.append(blocks)
  await once(stream, 'indexed')
  t.same(entries, expected)
})

test('Readable stream from sparse hypercore', async (t) => {
  const a = await create()
  const blocks = generateFixture(0, 100)
  await a.append(blocks)
  const b = await create(a.key)

  replicate(a, b, t)

  const range = b.download({ start: 5, end: 20 })
  await range.downloaded()

  const stream = new IndexStream(b, ram(), { highWaterMark: BLOCK_LENGTH * 4 })
  /** @type {string[]} */
  const entries = []
  stream.on('data', (entry) => entries.push(entry.block))
  await once(stream, 'indexed')

  t.same(entries, blocks.slice(5, 20))
  const range2 = b.download({ start: 50, end: 60 })
  await Promise.all([range2.downloaded(), once(stream, 'indexed')])

  t.same(
    entries.sort(),
    [...blocks.slice(5, 20), ...blocks.slice(50, 60)].sort()
  )
})

test('Appends from a replicated core are indexed', async (t) => {
  const a = await create()
  const blocks1 = generateFixture(0, 50)
  await a.append(blocks1)
  const b = await create(a.key)

  replicate(a, b, t)
  await b.update()
  const range1 = b.download({ start: 0, end: b.length })
  await range1.downloaded()

  const stream = new IndexStream(b, ram(), { highWaterMark: BLOCK_LENGTH * 4 })
  /** @type {string[]} */
  const entries = []
  stream.on('data', (entry) => entries.push(entry.block))
  await once(stream, 'indexed')

  t.same(entries, blocks1)
  const range2 = b.download({ start: 50, end: -1 })
  const blocks2 = generateFixture(50, 100)
  await a.append(blocks2)
  await once(stream, 'indexed')
  range2.destroy()

  t.same(entries.sort(), [...blocks1, ...blocks2].sort())
})

only('Maintains index state', async (t) => {
  const a = await create()
  /** @type {any[]} */
  const entries = []
  const storage = ram()
  const stream1 = new IndexStream(a, storage, {
    highWaterMark: BLOCK_LENGTH * 4,
  })
  stream1.on('data', (entry) => entries.push(entry.block))

  const blocks = generateFixture(0, 1000)
  await a.append(blocks.slice(0, 500))
  await once(stream1, 'indexed')
  t.same(entries.sort(), blocks.slice(0, 500).sort())
  stream1.destroy()
  await once(stream1, 'close')
  await a.append(blocks.slice(500, 1000))
  const stream2 = new IndexStream(a, storage)
  stream2.on('data', (entry) => entries.push(entry.block))
  await once(stream2, 'indexed')
  t.same(entries.sort(), blocks.sort())
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

/**
 *
 * @param {number} start
 * @param {number} end
 * @returns {Buffer[]}
 */
function generateFixture(start, end) {
  const blocks = []
  for (let i = start; i < end; i++) {
    blocks.push(
      Buffer.from(
        `block${i.toString().padStart(BLOCK_LENGTH - 'block'.length, '0')}`
      )
    )
  }
  return blocks
}
