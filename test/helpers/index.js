// @ts-check

const Hypercore = require('hypercore')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BLOCK_LENGTH = Buffer.from('block000000').byteLength

/** @typedef {import('../../lib/types').Entry<'binary'>} Entry */
/** @typedef {import('node:events').EventEmitter} EventEmitter */

module.exports = {
  create,
  createTempDir,
  trackCore,
  closeCreatedCores,
  replicate,
  generateFixture,
  generateFixtures,
  createMultiple,
  throttledDrain,
  throttledIdle,
  sortEntries,
  uniqueEntries,
  logEntries,
  blocksToExpected,
}

/** @type {string[]} */
const tempDirs = []

// Hypercore 11 requires real disk storage (RocksDB), so tests create
// temporary directories which are cleaned up when the test process exits.
process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
})

/**
 * Create a temporary directory for core or index storage, removed on process
 * exit.
 *
 * @returns {string}
 */
function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-core-indexer-'))
  tempDirs.push(dir)
  return dir
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

/** @type {Hypercore[]} */
const createdCores = []

/**
 * Track a core so that it is closed by closeCreatedCores()
 *
 * @template {Hypercore} T
 * @param {T} core
 * @returns {T}
 */
function trackCore(core) {
  createdCores.push(core)
  return core
}

/**
 * Close all cores created via create() or trackCore(). Call this from a
 * test.afterEach() hook: cores are backed by RocksDB storage, so leaving them
 * open between tests leaks native resources and slows later tests.
 */
async function closeCreatedCores() {
  const closing = createdCores.splice(0, createdCores.length)
  await Promise.all(closing.map((core) => core.close().catch(noop)))
}

function noop() {}

/** @param {any} args */
async function create(...args) {
  const core = trackCore(new Hypercore(createTempDir(), ...args))
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

// How long a stream must remain drained/idle before we consider it done.
// Needs to comfortably cover the latency of disk (RocksDB) reads and writes,
// which can leave the stream drained for longer than this between events.
const QUIET_WINDOW_MS = 100

/**
 * The index stream can become momentarily drained between reads and
 * appends/downloads of new data. This throttle drained will resolve only when
 * the stream has remained drained for > QUIET_WINDOW_MS
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
      }, QUIET_WINDOW_MS)
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
 * Dedupe entries by core key + index. Delivery is at-least-once, so
 * assertions on entries delivered across an unclean close should compare
 * unique entries, allowing duplicates.
 *
 * @param {Entry[]} entries
 * @returns {Entry[]}
 */
function uniqueEntries(entries) {
  /** @type {Map<string, Entry>} */
  const byId = new Map()
  for (const entry of entries) {
    byId.set(entry.key.toString('hex') + ':' + entry.index, entry)
  }
  return [...byId.values()]
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
