// @ts-check
const { Readable } = require('streamx')
const Bitfield = require('../lib/bitfield')

const kReadPromise = Symbol('readPromise')
const kOpenPromise = Symbol('openPromise')
const kDestroyPromise = Symbol('destroyPromise')
const kHandleAppend = Symbol('handleAppend')
const kHandleDownload = Symbol('handleDownload')
const kSetIndexState = Symbol('setIndexState')

/** @typedef {'idle' | 'indexing'} IndexState */
/**
 * @typedef {import('streamx').ReadableEvents<any> & {'index-state': (state: IndexState) => void}} IndexStreamEvents
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
 * @extends {Readable<any, any, any, true, false, IndexStreamEvents>}
 */
class IndexStream extends Readable {
  /** @type {Bitfield} */
  #bitfield
  #core
  #storage
  #index = 0
  #queuedRead = false
  /** @type {'idle' | 'linear' | 'downloads'} */
  #readState = 'idle'
  /** @type {IndexState} */
  #indexState = 'idle'
  /** @type {Set<number>} */
  #downloaded = new Set()

  /**
   * @param {import('hypercore')} core
   * @param {import('random-access-storage')} storage
   * @param {object} [opts]
   */
  constructor(core, storage, opts = {}) {
    super()
    this.#core = core
    this.#storage = storage
    this[kHandleAppend] = this[kHandleAppend].bind(this)
    this[kHandleDownload] = this[kHandleDownload].bind(this)
  }

  get state() {
    return this.#indexState
  }

  /** @param {any} cb */
  _open(cb) {
    this[kOpenPromise]().then(cb, cb)
  }

  /** @param {any} cb */
  _read(cb) {
    this[kReadPromise]().then(cb, cb)
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
    this.#core.on('append', this[kHandleAppend])
    this.#core.on('download', this[kHandleDownload])
  }

  async [kReadPromise]() {
    if (this.#index < this.#core.length || this.#downloaded.size > 0) {
      this[kSetIndexState]('indexing')
    }
    this.#readState = 'linear'
    let readBufferAvailable = true
    while (readBufferAvailable && this.#index < this.#core.length) {
      const seq = this.#index++
      const isIndexed = this.#bitfield.get(seq)
      if (isIndexed) continue
      const value = await this.#core.get(seq, { wait: false })
      if (value === null) continue
      this.#bitfield.set(seq, true)
      readBufferAvailable = this.push(value)
    }
    // Still space in the read buffer? Process any downloaded blocks
    if (readBufferAvailable) {
      this.#readState = 'downloads'
      for (const seq of this.#downloaded.values()) {
        this.#downloaded.delete(seq)
        const isIndexed = this.#bitfield.get(seq)
        if (isIndexed) continue
        const value = await this.#core.get(seq, { wait: false })
        if (value === null) continue
        this.#bitfield.set(seq, true)
        readBufferAvailable = this.push(value)
        if (!readBufferAvailable) break
      }
    }
    this.#readState = 'idle'
    const queuedRead = this.#queuedRead
    this.#queuedRead = false
    // If another read was queued while we were reading (because of an append or
    // a download), and there is still space in the read buffer, then continue
    // reading data
    if (queuedRead && readBufferAvailable) {
      await this[kReadPromise]()
    }
    // If there is nothing left to index (until more data is downloaded or
    // appended) then set index state to idle
    if (this.#index >= this.#core.length && this.#downloaded.size === 0) {
      // Set set on next tick, because this stream will still be emitting read
      // events for this index loop in the current tick
      process.nextTick(() => this[kSetIndexState]('idle'))
    }
  }

  /**
   * @param {IndexState} state
   */
  [kSetIndexState](state) {
    if (state === this.#indexState) return
    this.#indexState = state
    this.emit('index-state', state)
  }

  [kHandleAppend]() {
    if (this.#readState === 'idle') {
      // If readState is idle, then we need to trigger another read
      this[kReadPromise]().catch((err) => this.destroy(err))
    } else if (this.#readState === 'downloads') {
      // If we are currently reading downloads, queue up another read to process
      // up to core.length again
      this.#queuedRead = true
    } else if (this.#readState === 'linear') {
      // If we are currently reading up to core.length, then we don't need to do
      // anything, since the read loop will handle it.
    }
  }

  /**
   * @param {number} index
   */
  [kHandleDownload](index) {
    this.#downloaded.add(index)
    if (this.#readState === 'idle') {
      // If readState is idle, then we need to trigger another read
      this[kReadPromise]().catch((err) => this.destroy(err))
    }
    // Otherwise, the new value in the #downloaded set will be picked up by the
    // read loop if the read buffer is not full, so no need to do anything
  }
}

exports.IndexStream = IndexStream
