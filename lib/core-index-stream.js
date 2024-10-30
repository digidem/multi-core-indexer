// @ts-check
const { Readable } = require('streamx')
const Bitfield = require('./bitfield')
const { pDefer } = require('./utils')
const { promisify } = require('node:util')

/** @typedef {import('./types').ValueEncoding} ValueEncoding */
/** @typedef {import('./types').JSONValue} JSONValue */
/**
 * @template {ValueEncoding} [T='binary']
 * @typedef {import('./types').Entry<T>} Entry
 */
/**
 * Create a ReadableStream for a Hypercore that will:
 *
 * 1. Only index downloaded blocks (it will not request blocks from peers)
 * 2. Remain open (e.g. live) awaiting new data
 * 3. Index any new blocks as they are downloaded
 * 4. Index any new blocks as they are appended
 * 5. Store index state and continue indexing from the previous state
 *
 * @template {ValueEncoding} [T='binary']
 * @extends {Readable<Entry<T>, Entry<T>, Entry<T>, true, false, import('./types').IndexStreamEvents<Entry<T>>>}
 */
class CoreIndexStream extends Readable {
  #handleAppendBound
  #handleDownloadBound
  /** @type {Bitfield | undefined} */
  #indexedBitfield
  /** @type {Bitfield | undefined} */
  #inProgressBitfield
  #inProgress = 0
  #core
  /** @type {import('random-access-storage') | undefined} */
  #storage
  #createStorage
  #index = 0
  /** @type {Set<number>} */
  #downloaded = new Set()
  #pending = pDefer()
  #readBufferAvailable = true
  #destroying = false
  #drained = false

  /**
   * @param {import('hypercore')<T, any>} core
   * @param {(name: string) => import('random-access-storage')} createStorage
   * @param {boolean} reindex
   */
  constructor(core, createStorage, reindex) {
    super({
      // Treat as object stream, count each object as size `1` so that the
      // `remaining` property can use the stream buffer to calculate how many
      // items are left to index
      highWaterMark: 16,
      byteLength: () => 1,
    })
    this.#core = core
    this.#handleAppendBound = this.#handleAppend.bind(this)
    this.#handleDownloadBound = this.#handleDownload.bind(this)
    this.#createStorage = async () => {
      await this.#core.ready()

      const { discoveryKey } = this.#core
      /* c8 ignore next: just to keep TS happy - after core.ready() this is set */
      if (!discoveryKey) throw new Error('Missing discovery key')
      const storageName = getStorageName(discoveryKey)

      if (reindex) await unlinkStorage(createStorage(storageName))

      return createStorage(storageName)
    }
  }

  get remaining() {
    return (
      this.#core.length - this.#index + this.#downloaded.size + this.#inProgress
    )
  }

  get drained() {
    return this.#drained
  }

  get core() {
    return this.#core
  }

  /** @param {any} cb */
  _open(cb) {
    this.#open().then(cb, cb)
  }

  /** @param {any} cb */
  _read(cb) {
    this.#read().then(cb, cb)
  }

  _predestroy() {
    this.#destroying = true
    this.#pending.resolve()
  }

  /** @param {any} cb */
  _destroy(cb) {
    this.#destroy().then(cb, cb)
  }

  /**
   * Set a block as indexed, removes it from "inProgress"
   *
   * @param {number} index
   */
  setIndexed(index) {
    this.#inProgress--
    this.#indexedBitfield?.set(index, true)
    this.#inProgressBitfield?.set(index, false)
  }

  async unlink() {
    this.#storage ??= await this.#createStorage()
    await unlinkStorage(this.#storage)
  }

  async #destroy() {
    this.#core.removeListener('append', this.#handleAppendBound)
    this.#core.removeListener('download', this.#handleDownloadBound)
    await this.#indexedBitfield?.flush()
    if (this.#storage) await closeStorage(this.#storage)
  }

  async #open() {
    await this.#core.ready()
    await this.#core.update({ wait: true })
    this.#storage ??= await this.#createStorage()
    this.#indexedBitfield = await Bitfield.open(this.#storage)
    this.#inProgressBitfield = await new Bitfield()
    this.#core.on('append', this.#handleAppendBound)
    this.#core.on('download', this.#handleDownloadBound)
  }

  async #read() {
    if (this.#index >= this.#core.length && this.#downloaded.size === 0) {
      this.#drained = true
      this.emit('drained')
      // If nothing is left to index, wait for new data
      await (this.#pending = pDefer()).promise
    }
    this.#drained = false
    this.emit('indexing')
    let didPush = false
    this.#readBufferAvailable = true
    while (this.#readBufferAvailable && this.#index < this.#core.length) {
      didPush = (await this.#pushEntry(this.#index)) || didPush
      // Don't increment this until after the async push above
      this.#index++
    }
    // Still space in the read buffer? Process any downloaded blocks
    if (this.#readBufferAvailable) {
      for (const index of this.#downloaded) {
        this.#downloaded.delete(index)
        didPush =
          (await this.#pushEntry(index)) ||
          /* c8 ignore next - TODO: Test when hypercore-next supports a core.clear() method */
          didPush
        // This is for back-pressure, for which there is not a good test yet.
        // The faster streamx state machine in https://github.com/mafintosh/streamx/pull/77
        // caused this stream's read buffer to never fill with the current tests,
        // so that this line is currently uncovered by tests.
        // TODO: Add a test similar to 'Appends from a replicated core are indexed' in core-index-stream.test.js
        // but pipe to a slow stream, to test back-pressure, which should result in coverage of this line.
        /* c8 ignore next */
        if (!this.#readBufferAvailable) break
      }
    }
    if (!didPush && !this.#destroying) {
      // If nothing was pushed, queue up another read
      await this.#read()
    }
    await this.#indexedBitfield?.flush()
  }

  /**
   * Return true if the entry was pushed to the read buffer, false if it was skipped
   *
   * @param {number} index
   * @returns {Promise<boolean>}
   */
  async #pushEntry(index) {
    const isProcessed =
      this.#indexedBitfield?.get(index) || this.#inProgressBitfield?.get(index)
    if (isProcessed) return false
    const block = await this.#core.get(index, { wait: false })
    if (block === null) return false
    this.#inProgressBitfield?.set(index, true)
    this.#inProgress++
    /* c8 ignore next: this should always be set at this point */
    if (!this.#core.key) throw new Error('Missing core key')
    const entry = { key: this.#core.key, block, index }
    this.#readBufferAvailable = this.push(entry)
    return true
  }

  async #handleAppend() {
    this.#pending.resolve()
  }

  /**
   * @param {number} index
   */
  async #handleDownload(index) {
    this.#downloaded.add(index)
    this.#pending.resolve()
  }
}

exports.CoreIndexStream = CoreIndexStream

/** @param {Buffer} discoveryKey */
function getStorageName(discoveryKey) {
  const id = discoveryKey.toString('hex')
  return [id.slice(0, 2), id.slice(2, 4), id].join('/')
}

/** @param {import('random-access-storage')} storage*/
function closeStorage(storage) {
  return promisify(storage.close.bind(storage))()
}

/** @param {import('random-access-storage')} storage */
function unlinkStorage(storage) {
  return promisify(storage.unlink.bind(storage))()
}
