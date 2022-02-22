// @ts-check
const { Writable } = require('streamx')
const { TypedEmitter } = require('tiny-typed-emitter')
const { once } = require('events')
const raf = require('random-access-file')
const { CoreIndexStream } = require('./lib/core-index-stream')
const { MultiCoreIndexStream } = require('./lib/multi-core-index-stream')
const { defaultByteLength } = require('./lib/utils')

const DEFAULT_BATCH_SIZE = 16384

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
    const coreIndexStreams = cores.map(
      (core) =>
        new CoreIndexStream(core, createStorage(core.key.toString('hex')))
    )
    this.#indexStream = new MultiCoreIndexStream(coreIndexStreams)
    this.#writeStream = /** @type {Writable<Entry<T>>} */ (
      new Writable({
        writev: (entries, cb) => batch(entries).then(() => cb(), cb),
        highWaterMark: maxBatch,
        byteLength,
      })
    )
    this.#indexStream.on('index-state', (state) =>
      this.emit('index-state', state)
    )
    this.#indexStream.on('indexed', () => this.emit('indexed'))
    this.#indexStream.pipe(this.#writeStream)
  }

  async destroy() {
    this.#writeStream.destroy()
    this.#indexStream.destroy()
    return Promise.all([
      once(this.#indexStream, 'close'),
      once(this.#writeStream, 'close'),
    ])
  }

  /**
   *
   * @param {StorageParam} storage
   * @returns {(name: string) => import('random-access-storage')}
   */
  static defaultStorage(storage, opts = {}) {
    if (typeof storage !== 'string') return storage
    const directory = storage
    return function createFile(name) {
      return raf(name, { directory })
    }
  }
}

exports = module.exports = MultiCoreIndexer
