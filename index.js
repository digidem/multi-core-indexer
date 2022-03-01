// @ts-check
const { Writable } = require('streamx')
const { TypedEmitter } = require('tiny-typed-emitter')
const { once } = require('events')
const raf = require('random-access-file')
const log = require('debug')('multi-core-indexer')
const { CoreIndexStream } = require('./lib/core-index-stream')
const { MultiCoreIndexStream } = require('./lib/multi-core-index-stream')
const { defaultByteLength } = require('./lib/utils')

const DEFAULT_BATCH_SIZE = 16384
// The indexing rate (in entries per second) is calculated as an exponential
// moving average. A factor > 1 will put more weight on previous values.
const MOVING_AVG_FACTOR = 3
const kHandleEntries = Symbol('handleEntries')
const kEmitState = Symbol('emitState')
const kHandleIndexing = Symbol('handleIndexing')

/** @typedef {string | ((name: string) => import('random-access-storage'))} StorageParam */
/** @typedef {import('./lib/types').ValueEncoding} ValueEncoding */
/**
 * @template {ValueEncoding} [T='binary']
 * @typedef {import('./lib/types').Entry<T>} Entry
 */

/**
 * @template {ValueEncoding} [T='binary']
 * @extends {TypedEmitter<import('./lib/types').IndexEvents>}
 */
class MultiCoreIndexer extends TypedEmitter {
  #indexStream
  #writeStream
  #batch
  /** @type {import('./lib/types').IndexStateCurrent} */
  #state = 'idle'
  #lastRemaining = -1
  #rateMeasurementStart = Date.now()
  #rate = 0

  /**
   *
   * @param {import('hypercore')<T>[]} cores
   * @param {object} opts
   * @param {(entries: Entry<T>[]) => Promise<void>} opts.batch
   * @param {StorageParam} opts.storage
   * @param {number} [opts.maxBatch=16384]
   * @param {(data: Entry<T>) => number} [opts.byteLength]
   */
  constructor(
    cores,
    {
      batch,
      maxBatch = DEFAULT_BATCH_SIZE,
      byteLength = defaultByteLength,
      storage,
    }
  ) {
    super()
    const createStorage = MultiCoreIndexer.defaultStorage(storage)
    const coreIndexStreams = cores.map((core) => {
      const storage = createStorage(core.key.toString('hex'))
      return new CoreIndexStream(core, storage)
    })
    this.#indexStream = new MultiCoreIndexStream(coreIndexStreams)
    this.#batch = batch
    this.#writeStream = /** @type {Writable<Entry<T>>} */ (
      new Writable({
        writev: (entries, cb) => {
          this[kHandleEntries](entries).then(() => cb(), cb)
        },
      })
    )
    this.#indexStream.pipe(this.#writeStream)
    this[kHandleIndexing] = this[kHandleIndexing].bind(this)
    // This is needed because the source streams can start indexing before this
    // stream starts reading data. This ensures that the indexing state is
    // emitted when the source cores first append / download data
    this.#indexStream.on('indexing', this[kHandleIndexing])
  }

  async close() {
    this.#indexStream.off('indexing', this[kHandleIndexing])
    this.#writeStream.destroy()
    this.#indexStream.destroy()
    return Promise.all([
      once(this.#indexStream, 'close'),
      once(this.#writeStream, 'close'),
    ])
  }

  /** @param {Entry<T>[]} entries */
  async [kHandleEntries](entries) {
    log('HANDLE ENTRIES', entries.length)
    this[kEmitState](entries.length)
    if (!entries.length) return // not sure this is necessary, but better safe than sorry
    await this.#batch(entries)
    const batchTime = Date.now() - this.#rateMeasurementStart
    // Current rate entries per second
    const rate = entries.length / (batchTime / 1000)
    // Moving average rate - use current rate if this is the first measurement
    this.#rate =
      rate + this.#rate > 0 ? (this.#rate - rate) / MOVING_AVG_FACTOR : 0
    // Set this at the end of batch rather than start so the timing also
    // includes the reads from the index streams
    this.#rateMeasurementStart = Date.now()
    this[kEmitState]()
  }

  [kHandleIndexing]() {
    if (this.#state === 'indexing') return
    this[kEmitState]()
  }

  [kEmitState](processing = 0) {
    const remaining = this.#indexStream.remaining + processing
    if (remaining === this.#lastRemaining) return
    this.#lastRemaining = remaining
    const prevState = this.#state
    this.#state = remaining === 0 ? 'idle' : 'indexing'
    if (this.#state === 'indexing' && prevState === 'idle') {
      this.emit('indexing')
      this.#rateMeasurementStart = Date.now()
    }
    if (this.#state === 'idle' && prevState === 'indexing') {
      this.emit('idle')
    }
    this.emit('index-state', {
      current: this.#state,
      remaining,
      entriesPerSecond: this.#rate,
    })
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
      return raf(name, { directory })
    }
  }
}

module.exports = MultiCoreIndexer
