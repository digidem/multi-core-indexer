// @ts-check
const { Readable } = require('streamx')
const { once } = require('events')
const log = require('debug')('core-index-stream')
const Bitfield = require('../lib/bitfield')

const kReadPromise = Symbol('readPromise')
const kOpenPromise = Symbol('openPromise')
const kDestroyPromise = Symbol('destroyPromise')
const kHandleAppend = Symbol('handleAppend')
const kHandleDownload = Symbol('handleDownload')
const kPushEntry = Symbol('pushEntry')
const kEmitState = Symbol('emitState')

// How long to wait for additional data before emitting the 'indexed' state
const INDEXED_WAIT = 200

/** @typedef {{ remaining: number }} IndexState */
/**
 * @typedef {object} Events
 * @property {(state: IndexState) => void} index-state - emitted when the index state changes
 * @property {() => void} indexed - emitted when all pending data has been indexed
 */
/**
 * @typedef {import('streamx').ReadableEvents<any> & Events} IndexStreamEvents
 */
/** @typedef {'binary' | 'utf-8' | 'json'} ValueEncoding */
/**
 * @template {ValueEncoding} [T='binary']
 * @typedef {{ index: number, key: Buffer, block: (T extends 'binary' ? Buffer : T extends 'utf-8' ? string : any) }} Entry
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
 * @extends {Readable<Entry<T>, Entry<T>, Entry<T>, true, false, IndexStreamEvents>}
 */
class IndexStream extends Readable {
  /** @type {Bitfield} */
  #bitfield
  #core
  #storage
  #index = 0
  /** @type {Set<number>} */
  #downloaded = new Set()
  #pending = pDefer()
  #readBufferAvailable = true
  /** @type {ReturnType<typeof setTimeout>} */
  #timeoutId
  #destroying = false

  /**
   * @param {import('hypercore')<T>} core
   * @param {import('random-access-storage')} storage
   * @param {{ highWaterMark?: number }} [opts]
   */
  constructor(core, storage, opts = {}) {
    super({
      highWaterMark: opts.highWaterMark,
      byteLength: (entry) => entry.block.length,
    })
    this.#core = core
    this.#storage = storage
    this[kHandleAppend] = this[kHandleAppend].bind(this)
    this[kHandleDownload] = this[kHandleDownload].bind(this)
  }

  get remaining() {
    return this.#core.length - this.#index + this.#downloaded.size
  }

  /** @param {any} cb */
  _open(cb) {
    this[kOpenPromise]().then(cb, cb)
  }

  /** @param {any} cb */
  _read(cb) {
    this[kReadPromise]().then(cb, cb)
  }

  _predestroy() {
    this.#destroying = true
    this.#pending.resolve()
  }

  /** @param {any} cb */
  _destroy(cb) {
    this[kDestroyPromise]().then(cb, cb)
  }

  async [kDestroyPromise]() {
    this.#core.removeListener('append', this[kHandleAppend])
    this.#core.removeListener('download', this[kHandleDownload])
    await this.#bitfield.flush()
  }

  async [kOpenPromise]() {
    this.#bitfield = await Bitfield.open(this.#storage)
    await this.#core.update()
    this[kEmitState]()
    this.#core.on('append', this[kHandleAppend])
    this.#core.on('download', this[kHandleDownload])
  }

  async [kReadPromise]() {
    log('read', {
      index: this.#index,
      length: this.#core.length,
      downloaded: this.#downloaded.size,
    })
    if (this.remaining === 0) {
      this.#timeoutId = setTimeout(() => this.emit('indexed'), INDEXED_WAIT)
      // If nothing is left to index, wait for new data
      await (this.#pending = pDefer())
    }
    let didPush = false
    this.#readBufferAvailable = true
    while (this.#readBufferAvailable && this.#index < this.#core.length) {
      const index = this.#index++
      didPush = (await this[kPushEntry](index)) || didPush
    }
    // Still space in the read buffer? Process any downloaded blocks
    if (this.#readBufferAvailable) {
      for (const index of this.#downloaded.values()) {
        this.#downloaded.delete(index)
        didPush = (await this[kPushEntry](index)) || didPush
        if (!this.#readBufferAvailable) break
      }
    }
    log('readEnd', {
      index: this.#index,
      length: this.#core.length,
      downloaded: this.#downloaded.size,
    })
    if (!didPush && !this.#destroying) {
      // If nothing was pushed, queue up another read
      await this[kReadPromise]()
    }
    await this.#bitfield.flush()
    this[kEmitState]()
  }

  /**
   * Return true if the entry was pushed to the read buffer, false if it was skipped
   *
   * @param {number} index
   * @returns {Promise<boolean>}
   */
  async [kPushEntry](index) {
    const isIndexed = this.#bitfield.get(index)
    if (isIndexed) {
      log(`skipped ${index} (already indexed)`)
      return false
    }
    const block = await this.#core.get(index, { wait: false })
    if (block === null) {
      log(`skipped ${index} (not downloaded)`)
      return false
    }
    this.#bitfield.set(index, true)
    const entry = { key: this.#core.key, block, index }
    this.#readBufferAvailable = this.push(entry)
    log(`push ${index} (buffer free: ${this.#readBufferAvailable})`)
    return true
  }

  [kEmitState]() {
    this.emit('index-state', { remaining: this.remaining })
  }

  async [kHandleAppend]() {
    log('append')
    clearTimeout(this.#timeoutId)
    this.#pending.resolve()
  }

  /**
   * @param {number} index
   */
  async [kHandleDownload](index) {
    log('download', index)
    clearTimeout(this.#timeoutId)
    this.#downloaded.add(index)
    this.#pending.resolve()
  }
}

exports.IndexStream = IndexStream

/** @typedef {Promise<void> & { resolve: () => void, reject: (err: Error) => void }} DeferredPromise */

function pDefer() {
  let resolve, reject
  /** @type {any} */
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  // Yuck, I'm overloading the promise with additional methods. But it makes the
  // code where it is used more concise :shrug:
  promise.resolve = resolve
  promise.reject = reject

  return /** @type {DeferredPromise} */ (promise)
}
