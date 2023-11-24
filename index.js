// @ts-check
const { Writable } = require('streamx')
const { TypedEmitter } = require('tiny-typed-emitter')
const { once } = require('events')
const raf = require('random-access-file')
const { discoveryKey } = require('hypercore-crypto')
// const log = require('debug')('multi-core-indexer')
const { CoreIndexStream } = require('./lib/core-index-stream')
const { MultiCoreIndexStream } = require('./lib/multi-core-index-stream')
const { promisify } = require('util')
const { pDefer } = require('./lib/utils.js')

const DEFAULT_BATCH_SIZE = 100
// The indexing rate (in entries per second) is calculated as an exponential
// moving average. A factor > 1 will put more weight on previous values.
const MOVING_AVG_FACTOR = 5
const kHandleEntries = Symbol('handleEntries')
const kEmitState = Symbol('emitState')
const kGetState = Symbol('getState')

/** @typedef {string | ((name: string) => import('random-access-storage'))} StorageParam */
/** @typedef {import('./lib/types').ValueEncoding} ValueEncoding */
/** @typedef {import('./lib/types').IndexState} IndexState */
/** @typedef {import('./lib/types').IndexEvents} IndexEvents */
/**
 * @template {ValueEncoding} [T='binary']
 * @typedef {import('./lib/types').Entry<T>} Entry
 */

/**
 * @template {ValueEncoding} [T='binary']
 * @extends {TypedEmitter<IndexEvents>}
 */
class MultiCoreIndexer extends TypedEmitter {
  #indexStream
  #writeStream
  #batch
  /** @type {import('./lib/types').IndexStateCurrent} */
  #state = 'indexing'
  #lastRemaining = -1
  #rateMeasurementStart = Date.now()
  #rate = 0
  #createStorage
  /** @type {IndexState | undefined} */
  #prevEmittedState
  /** @type {Set<import('random-access-storage')>} */
  #storages = new Set()
  #emitStateBound
  /** @type {import('./lib/utils.js').DeferredPromise | undefined} */
  #pendingIdle

  /**
   *
   * @param {import('hypercore')<T, Buffer | string>[]} cores
   * @param {object} opts
   * @param {(entries: Entry<T>[]) => Promise<void>} opts.batch
   * @param {StorageParam} opts.storage
   * @param {number} [opts.maxBatch=100]
   */
  constructor(cores, { batch, maxBatch = DEFAULT_BATCH_SIZE, storage }) {
    super()
    this.#createStorage = MultiCoreIndexer.defaultStorage(storage)
    const coreIndexStreams = cores.map((core) => {
      const storage = this.#createStorage(getStorageName(core))
      this.#storages.add(storage)
      return new CoreIndexStream(core, storage)
    })
    this.#indexStream = new MultiCoreIndexStream(coreIndexStreams, {
      highWaterMark: maxBatch,
    })
    this.#batch = batch
    this.#writeStream = /** @type {Writable<Entry<T>>} */ (
      new Writable({
        writev: (entries, cb) => {
          // @ts-ignore - I don't know why TS does not like this
          this[kHandleEntries](entries).then(() => cb(), cb)
        },
        highWaterMark: maxBatch,
        byteLength: () => 1,
      })
    )
    this.#indexStream.pipe(this.#writeStream)
    this.#emitStateBound = this[kEmitState].bind(this)
    // This is needed because the source streams can start indexing before this
    // stream starts reading data. This ensures that the indexing state is
    // emitted when the source cores first append / download data
    this.#indexStream.on('indexing', this.#emitStateBound)
    // This is needed for source streams that start empty, so that we know that
    // the initial state of indexing has changed to idle
    this.#indexStream.on('drained', this.#emitStateBound)
  }

  /**
   * @type {IndexState}
   */
  get state() {
    return this[kGetState]()
  }

  /**
   * Add a core to be indexed
   * @param {import('hypercore')<T, Buffer | string>} core
   */
  addCore(core) {
    const storage = this.#createStorage(getStorageName(core))
    this.#storages.add(storage)
    const coreIndexStream = new CoreIndexStream(core, storage)
    this.#indexStream.addStream(coreIndexStream)
  }

  /**
   * Resolves when indexing state is 'idle'
   */
  async idle() {
    if (this[kGetState]().current === 'idle') return
    if (!this.#pendingIdle) {
      this.#pendingIdle = pDefer()
    }
    return this.#pendingIdle.promise
  }

  async close() {
    this.#indexStream.off('indexing', this.#emitStateBound)
    this.#indexStream.off('drained', this.#emitStateBound)
    this.#writeStream.destroy()
    this.#indexStream.destroy()
    await Promise.all([
      once(this.#indexStream, 'close'),
      once(this.#writeStream, 'close'),
    ])
    const storageClosePromises = []
    for (const storage of this.#storages) {
      const promisifiedClose = promisify(storage.close.bind(storage))
      storageClosePromises.push(promisifiedClose())
    }
    this.#storages.clear()
    await Promise.all(storageClosePromises)
  }

  /** @param {Entry<T>[]} entries */
  async [kHandleEntries](entries) {
    this[kEmitState]()
    /* istanbul ignore if - not sure this is necessary, but better safe than sorry */
    if (!entries.length) return
    await this.#batch(entries)
    for (const { key, index } of entries) {
      this.#indexStream.setIndexed(key.toString('hex'), index)
    }
    const batchTime = Date.now() - this.#rateMeasurementStart
    // Current rate entries per second
    const rate = entries.length / (batchTime / 1000)
    // Moving average rate - use current rate if this is the first measurement
    this.#rate =
      rate + (this.#rate > 0 ? (this.#rate - rate) / MOVING_AVG_FACTOR : 0)
    // Set this at the end of batch rather than start so the timing also
    // includes the reads from the index streams
    this.#rateMeasurementStart = Date.now()
    this[kEmitState]()
  }

  [kEmitState]() {
    const state = this[kGetState]()
    if (state.current !== this.#prevEmittedState?.current) {
      this.emit(state.current)
    }
    // Only emit if remaining has changed (which infers that state.current has changed)
    if (state.remaining !== this.#prevEmittedState?.remaining) {
      this.emit('index-state', state)
    }
    this.#prevEmittedState = state
  }

  [kGetState]() {
    const remaining = this.#indexStream.remaining
    const drained = this.#indexStream.drained
    const prevState = this.#state
    this.#state = remaining === 0 && drained ? 'idle' : 'indexing'
    if (this.#state === 'idle' && this.#pendingIdle) {
      this.#pendingIdle.resolve()
      this.#pendingIdle = undefined
    }
    if (this.#state === 'indexing' && prevState === 'idle') {
      this.#rateMeasurementStart = Date.now()
    }
    return {
      current: this.#state,
      remaining,
      entriesPerSecond: this.#rate,
    }
  }

  /**
   *
   * @param {StorageParam} storage
   * @returns {(name: string) => import('random-access-storage')}
   */
  static defaultStorage(storage) {
    if (typeof storage !== 'string') return storage
    const directory = storage
    return function createFile(name) {
      return new raf(name, { directory })
    }
  }
}

module.exports = MultiCoreIndexer

/** @param {{ key: Buffer }} core */
function getStorageName(core) {
  const id = discoveryKey(core.key).toString('hex')
  return [id.slice(0, 2), id.slice(2, 4), id].join('/')
}
