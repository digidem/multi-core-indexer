// @ts-check

const Hypercore = require('hypercore')
const ram = require('random-access-memory')

const BLOCK_LENGTH = Buffer.from('block000000').byteLength

/** @typedef {import('../../lib/types').Entry<'binary'>} Entry */
/** @typedef {import('node:events').EventEmitter} EventEmitter */

module.exports = {
  create,
  replicate,
  generateFixture,
  generateFixtures,
  createMultiple,
  throttledDrain,
  throttledIdle,
  sortEntries,
  logEntries,
  blocksToExpected,
}

/**
 *
 * @param {Hypercore} a
 * @param {Hypercore} b
 * @returns
 */
function replicate(a, b) {
  const s1 = a.replicate(true, { keepAlive: false })
  const s2 = b.replicate(false, { keepAlive: false })
  s1.on('error', (err) =>
    console.log(`replication stream error (initiator): ${err}`)
  )
  s2.on('error', (err) =>
    console.log(`replication stream error (responder): ${err}`)
  )
  s1.pipe(s2).pipe(s1)
  return [s1, s2]
}

/** @param {any} args */
async function create(...args) {
  const core = new Hypercore(ram, ...args)
  await core.ready()
  return core
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

/**
 *
 * @param {Hypercore[]} cores
 * @param {number} count
 * @returns {Promise<Entry[]>}
 */
async function generateFixtures(cores, count) {
  /** @type {Entry[]} */
  const entries = []
  for (const core of cores) {
    const offset = core.length
    const blocks = generateFixture(offset, offset + count)
    await core.append(blocks)
    entries.push.apply(entries, blocksToExpected(blocks, core.key, offset))
  }
  return entries
}

/**
 * The index stream can become momentarily drained between reads and
 * appends/downloads of new data. This throttle drained will resolve only when
 * the stream has remained drained for > 10ms
 * @param {EventEmitter} emitter
 * @returns {Promise<void>}
 */
function throttledDrain(emitter) {
  return throttledStreamEvent(emitter, 'drained')
}

function throttledIdle(emitter) {
  return throttledStreamEvent(emitter, 'idle')
}

/**
 * @param {EventEmitter} emitter
 * @param {string} eventName
 * @returns {Promise<void>}
 */
function throttledStreamEvent(emitter, eventName) {
  return new Promise((resolve) => {
    /** @type {ReturnType<setTimeout>} */
    let timeoutId

    function onEvent() {
      clearTimeout(timeoutId)
      timeoutId = setTimeout(() => {
        emitter.off(eventName, onEvent)
        emitter.off('indexing', onIndexing)
        resolve()
      }, 10)
    }

    emitter.on(eventName, onEvent)
    emitter.on('indexing', onIndexing)
    function onIndexing() {
      clearTimeout(timeoutId)
    }
  })
}

/**
 *
 * @param {Entry} a
 * @param {Entry} b
 * @returns number
 */
function sort(a, b) {
  const aKey = a.key.toString('hex') + a.block.toString()
  const bKey = b.key.toString('hex') + b.block.toString()
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
}

/** @param {Entry[]} e */
function sortEntries(e) {
  return e.sort(sort)
}

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

/** @param {Entry[]} e */
function logEntries(e) {
  console.log(
    sortEntries(e).map((e) => ({
      key: e.key.toString('hex'),
      block: e.block.toString(),
      index: e.index,
    }))
  )
}
